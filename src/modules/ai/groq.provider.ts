/**
 * Groq AI provider for HomEasy.
 *
 * Uses Groq's OpenAI-compatible chat completions endpoint.
 * Default model: qwen/qwen3.8-27b (free tier: 30 RPM, 1,000 RPD, 200,000 TPD).
 */
import { env } from '../../config/env';
import { ProviderError, type AiProvider, type AiRunMetric } from './types';

const DEFAULT_MODEL = 'qwen/qwen3.8-27b';
const API_URL = 'https://api.groq.com/openai/v1/chat/completions';

function sanitizeJson(text: string): string {
  return text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
}
export class GroqProvider implements AiProvider {
  name = 'groq';
  private apiKey: string | undefined;

  constructor(apiKey = env.GROQ_API_KEY) {
    this.apiKey = apiKey;
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey);
  }

  async generateJson<T>(params: {
    systemPrompt: string;
    userPrompt: string;
    model?: string;
    temperature?: number;
    schema?: Record<string, unknown>;
    maxOutputTokens?: number;
  }): Promise<{ data: T; metric: AiRunMetric }> {
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const model = params.model ?? DEFAULT_MODEL;

    if (!this.apiKey) {
      throw new Error('Groq API key is not configured');
    }

    const res = await fetch(API_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(45_000),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: params.systemPrompt },
          { role: 'user', content: params.userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: params.temperature ?? 0.1,
        max_completion_tokens: params.maxOutputTokens ?? 1000,
      }),
    });

    const latencyMs = Math.round(performance.now() - start);
    const remainingRequests = res.headers.get('x-ratelimit-remaining-requests');
    const remainingTokens = res.headers.get('x-ratelimit-remaining-tokens');

    if (!res.ok) {
      const errorBody = await res.text();
      const metric: AiRunMetric = {
        provider: this.name,
        model,
        startedAt,
        latencyMs,
        success: false,
        schemaValid: false,
        failureReason: `HTTP ${res.status}: ${errorBody.slice(0, 200)}`,
      };
      const retryAfterSec = Number(res.headers.get('retry-after'));
      // Groq limits (TPM/ITPM/OTPM) are per-minute windows, so a 429 without retry-after still means "wait about a minute".
      const retryAfterMs = res.status === 429 ? (retryAfterSec > 0 ? retryAfterSec * 1000 : /per day|daily|RPD|TPD/i.test(errorBody) ? 86_400_000 : 60_000) : undefined;
      throw new ProviderError(`Groq HTTP ${res.status}`, metric, retryAfterMs);
    }

    const body = (await res.json()) as {
      choices?: [{ message?: { content?: string } }];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const raw = body.choices?.[0]?.message?.content ?? '';
    if (!raw) {
      const metric: AiRunMetric = {
        provider: this.name,
        model,
        startedAt,
        latencyMs,
        inputTokens: body.usage?.prompt_tokens,
        outputTokens: body.usage?.completion_tokens,
        success: false,
        schemaValid: false,
        failureReason: 'Empty response content',
      };
      throw new ProviderError('Groq empty response', metric);
    }

    let data: T;
    try {
      data = JSON.parse(sanitizeJson(raw)) as T;
    } catch (err) {
      const metric: AiRunMetric = {
        provider: this.name,
        model,
        startedAt,
        latencyMs,
        inputTokens: body.usage?.prompt_tokens,
        outputTokens: body.usage?.completion_tokens,
        success: false,
        schemaValid: false,
        failureReason: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
      };
      throw new ProviderError('Groq JSON parse failed', metric);
    }

    const metric: AiRunMetric = {
      provider: this.name,
      model,
      startedAt,
      latencyMs,
      inputTokens: body.usage?.prompt_tokens,
      outputTokens: body.usage?.completion_tokens,
      success: true,
      schemaValid: true,
    };

    // Non-fatal quota signal for the caller/router
    if (remainingRequests && Number(remainingRequests) < 5) {
      console.warn(`[GroqProvider] ⚠️ Only ${remainingRequests} requests remaining`);
    }
    if (remainingTokens && Number(remainingTokens) < 2000) {
      console.warn(`[GroqProvider] ⚠️ Only ${remainingTokens} tokens left in the current minute (TPM)`);
    }

    return { data, metric };
  }
}
