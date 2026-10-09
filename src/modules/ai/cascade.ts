import { CloudflareProvider } from './cloudflare.provider';
import { GeminiProvider } from './gemini.provider';
import { GroqProvider } from './groq.provider';
import { AiRouter } from './router';
import type { AiModelLimits, AiRoute, AiRunMetric } from './types';

/** Standard Gemini text models with a documented free tier (not free Batch/Flex). */
export const GEMINI_FREE_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
] as const;

// User-provided AI Studio project limits, 2026-10-06. The number BEFORE '/' in
// the dashboard is consumption; only the denominator belongs here.
// These can change with project tier and should be rechecked in AI Studio.
export const GEMINI_PROJECT_LIMITS: Record<(typeof GEMINI_FREE_MODELS)[number], AiModelLimits> = {
  'gemini-3.8-flash': { rpm: 5, inputTpm: 250_000, rpd: 20, maxOutputTokens: 2048 },
  'gemini-3.7-flash': { rpm: 5, inputTpm: 250_000, rpd: 20, maxOutputTokens: 2048 },
  'gemini-3.6-flash': { rpm: 5, inputTpm: 250_000, rpd: 20, maxOutputTokens: 2048 },
  'gemini-3.5-flash-lite': { rpm: 15, inputTpm: 250_000, rpd: 500, maxOutputTokens: 2048 },
  'gemini-3.5-flash': { rpm: 5, inputTpm: 250_000, rpd: 20, maxOutputTokens: 2048 },
  'gemini-3.1-flash-lite': { rpm: 15, inputTpm: 250_000, rpd: 500, maxOutputTokens: 2048 },
};

function overrides(): Record<string, AiModelLimits> {
  if (!process.env.AI_MODEL_LIMITS_JSON) return {};
  const parsed: unknown = JSON.parse(process.env.AI_MODEL_LIMITS_JSON);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AI_MODEL_LIMITS_JSON must be an object');
  const valid = ['rpm', 'rpd', 'tpm', 'inputTpm', 'tpd', 'outputTpm', 'maxOutputTokens', 'dailyNeurons', 'inputNeuronsPerMillion', 'outputNeuronsPerMillion'];
  for (const [route, limits] of Object.entries(parsed)) {
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw new Error(`Invalid limits for ${route}`);
    for (const [name, value] of Object.entries(limits)) {
      if (!valid.includes(name) || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw new Error(`Invalid AI_MODEL_LIMITS_JSON ${route}.${name}`);
      }
    }
  }
  return parsed as Record<string, AiModelLimits>;
}

export function createAiRouter(onMetric?: (metric: AiRunMetric) => void, geminiOnly = false): AiRouter {
  const groq = new GroqProvider();
  const gemini = new GeminiProvider();
  const cloudflare = new CloudflareProvider();
  const configured = overrides();
  const route = (provider: AiRoute['provider'], model: string, limits: AiModelLimits): AiRoute => ({
    provider, model, limits: { ...limits, ...configured[`${provider.name}:${model}`] },
  });
  return new AiRouter({
    routes: ([
      route(groq, 'qwen/qwen3.8-27b', { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200_000, outputTpm: 1000, maxOutputTokens: 1000 }),
      ...GEMINI_FREE_MODELS.map((model) => route(gemini, model, GEMINI_PROJECT_LIMITS[model])),
      route(cloudflare, '@cf/meta/llama-3.1-8b-instruct-fp8', {
        rpm: 60, maxOutputTokens: 2048, dailyNeurons: 9500,
        inputNeuronsPerMillion: 13_778, outputNeuronsPerMillion: 26_128,
      }),
    ] as AiRoute[]).filter((entry) => !geminiOnly || entry.provider.name === 'gemini'),
    onMetric,
  });
}
