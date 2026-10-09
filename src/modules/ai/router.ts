import { ProviderError, type AiRoute, type AiRouterConfig, type AiRouterResult, type AiRunMetric } from './types';
import { nextPacificMidnight, nextUtcMidnight, pacificDay, utcDay } from './quota-clock';

interface Attempt { at: number; inputTokens: number; outputTokens: number }
interface RouteState { attempts: Attempt[]; cooldownUntil: number }

// Shared by all router instances in one process. Quotas are per provider/model, not per router.
const routeStates = new Map<string, RouteState>();
const MINUTE = 60_000;
const DAY = 86_400_000;

function estimateTokens(value: string): number {
  // Deliberately conservative for mixed English/Khmer UTF-8 text.
  return Math.ceil(Buffer.byteLength(value, 'utf8') / 2);
}

function routeKey(route: AiRoute): string { return `${route.provider.name}:${route.model}`; }

function stateFor(key: string): RouteState {
  let state = routeStates.get(key);
  if (!state) { state = { attempts: [], cooldownUntil: 0 }; routeStates.set(key, state); }
  return state;
}

function availability(route: AiRoute, inputTokens: number, outputTokens: number, now: number): number {
  const state = stateFor(routeKey(route));
  state.attempts = state.attempts.filter((attempt) => attempt.at > now - 27 * 60 * MINUTE);
  const limits = route.limits ?? {};
  let readyAt = state.cooldownUntil;
  const minute = state.attempts.filter((attempt) => attempt.at > now - MINUTE);
  const rollingDay = state.attempts.filter((attempt) => attempt.at > now - DAY);
  const check = (attempts: Attempt[], limit: number | undefined, cost: number, amount: (a: Attempt) => number, window: number) => {
    if (!limit) return;
    if (cost > limit) { readyAt = Math.max(readyAt, now + DAY); return; }
    let used = attempts.reduce((sum, attempt) => sum + amount(attempt), 0);
    for (const attempt of attempts) {
      if (used + cost <= limit) break;
      readyAt = Math.max(readyAt, attempt.at + window);
      used -= amount(attempt);
    }
  };
  check(minute, limits.rpm, 1, () => 1, MINUTE);
  if (limits.rpd && route.provider.name === 'gemini') {
    const today = pacificDay(now);
    const usedToday = state.attempts.filter((attempt) => pacificDay(attempt.at) === today).length;
    if (usedToday + 1 > limits.rpd) readyAt = Math.max(readyAt, nextPacificMidnight(now));
  } else {
    check(rollingDay, limits.rpd, 1, () => 1, DAY);
  }
  check(minute, limits.tpm, inputTokens + outputTokens, (a) => a.inputTokens + a.outputTokens, MINUTE);
  check(minute, limits.inputTpm, inputTokens, (a) => a.inputTokens, MINUTE);
  check(rollingDay, limits.tpd, inputTokens + outputTokens, (a) => a.inputTokens + a.outputTokens, DAY);
  check(minute, limits.outputTpm, outputTokens, (a) => a.outputTokens, MINUTE);
  if (limits.dailyNeurons && limits.inputNeuronsPerMillion && limits.outputNeuronsPerMillion) {
    const neuronCost = (input: number, output: number) => Math.ceil(
      (input * limits.inputNeuronsPerMillion! + output * limits.outputNeuronsPerMillion!) / 1_000_000,
    );
    const today = utcDay(now);
    const usedToday = state.attempts.filter((attempt) => utcDay(attempt.at) === today)
      .reduce((sum, attempt) => sum + neuronCost(attempt.inputTokens, attempt.outputTokens), 0);
    if (usedToday + neuronCost(inputTokens, outputTokens) > limits.dailyNeurons) {
      readyAt = Math.max(readyAt, nextUtcMidnight(now));
    }
  }
  return readyAt;
}

export class AiRouter {
  private routes: AiRoute[];
  private onMetric?: (metric: AiRunMetric) => void;

  constructor(config: AiRouterConfig) {
    this.routes = (config.routes ?? config.providers?.map((provider) => ({ provider, model: '' })) ?? [])
      .filter((route) => route.provider.isAvailable());
    this.onMetric = config.onMetric;
  }

  private record(metric: AiRunMetric): void {
    try { this.onMetric?.(metric); } catch { /* Observability must not affect extraction. */ }
  }

  async generateJson<T>(params: {
    systemPrompt: string;
    userPrompt: string;
    validate?: (data: T) => boolean | string;
    model?: string;
    temperature?: number;
    schema?: Record<string, unknown>;
    maxOutputTokens?: number;
    media?: { data: string; mimeType: string };
    estimatedInputTokens?: number;
  }): Promise<AiRouterResult<T>> {
    if (!this.routes.length) throw new Error('No AI providers are available. Set GROQ_API_KEY, GEMINI_API_KEY, or CLOUDFLARE_API_KEY.');
    const metrics: AiRunMetric[] = [];
    let lastError: unknown = new Error('All configured AI model budgets are exhausted');
    const inputTokens = Math.max(estimateTokens(params.systemPrompt + params.userPrompt), params.estimatedInputTokens ?? 0);
    // Wait once for a short minute-window reset rather than dropping a whole batch.
    for (let pass = 0; pass < 2; pass++) {
      let nextReady = Infinity;
      for (const [routeIndex, route] of this.routes.entries()) {
        const model = params.model || route.model || undefined;
        const activeRoute = { ...route, model: model ?? '' };
        const maxOutputTokens = params.maxOutputTokens ?? route.limits?.maxOutputTokens ?? 1024;
        const now = Date.now();
        const readyAt = availability(activeRoute, inputTokens, maxOutputTokens, now);
        if (readyAt > now) { nextReady = Math.min(nextReady, readyAt); continue; }
        const state = stateFor(routeKey(activeRoute));
        const attempt: Attempt = { at: now, inputTokens, outputTokens: maxOutputTokens };
        state.attempts.push(attempt); // Reserve before await: concurrent calls cannot overshoot locally.
        try {
          const { data, metric } = await route.provider.generateJson<T>({ ...params, model, maxOutputTokens });
          attempt.inputTokens = metric.inputTokens ?? inputTokens;
          attempt.outputTokens = metric.outputTokens ?? maxOutputTokens;
          const validation = params.validate ? params.validate(data) : true;
          const finalMetric = {
            ...metric,
            schemaValid: validation === true,
            failureReason: validation === true
              ? metric.failureReason
              : typeof validation === 'string' ? validation : 'Schema/domain validation failed',
            fallbackUsed: routeIndex > 0,
          };
          metrics.push(finalMetric);
          this.record(finalMetric);
          if (validation === true) return { data, metrics, providerName: route.provider.name, model: metric.model, fallbackDepth: routeIndex };
          lastError = new Error(typeof validation === 'string' ? validation : 'Schema/domain validation failed');
          console.warn(`[AiRouter] ${routeKey(activeRoute)} invalid output; trying next model`);
        } catch (err) {
          lastError = err;
          if (err instanceof ProviderError) {
            attempt.inputTokens = err.metric.inputTokens ?? inputTokens;
            attempt.outputTokens = err.metric.outputTokens ?? maxOutputTokens;
            if (err.retryAfterMs) state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + err.retryAfterMs);
            const metric = { ...err.metric, fallbackUsed: routeIndex > 0 };
            metrics.push(metric);
            this.record(metric);
          } else {
            const metric: AiRunMetric = {
              provider: route.provider.name,
              model: model ?? activeRoute.model,
              startedAt: new Date(now).toISOString(),
              latencyMs: Date.now() - now,
              success: false,
              schemaValid: false,
              failureReason: err instanceof Error ? err.message : String(err),
              fallbackUsed: routeIndex > 0,
            };
            metrics.push(metric);
            this.record(metric);
          }
          console.warn(`[AiRouter] ${routeKey(activeRoute)} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const wait = nextReady - Date.now();
      if (pass === 0 && Number.isFinite(wait) && wait > 0 && wait <= MINUTE + 1000) {
        await new Promise((resolve) => setTimeout(resolve, wait + 10));
      } else break;
    }
    throw new Error(`All AI models failed or reached their configured limits. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
}

/** Test-only: avoid quota state leaking between isolated unit tests. */
export function resetAiRouterLimits(): void { routeStates.clear(); }
