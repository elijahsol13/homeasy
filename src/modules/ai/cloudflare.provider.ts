/**
 * Cloudflare Workers AI provider for HomEasy.
 *
 * OpenAI-compatible endpoint (per Cloudflare docs, workers-ai/configuration/open-ai-compatibility):
 *   POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1/chat/completions
 * Free plan: 10,000 neurons/day; requests stop at the limit until the daily reset.
 */
import { env } from '../../config/env';
import { ProviderError, type AiProvider, type AiRunMetric } from './types';
import { nextUtcMidnight } from './quota-clock';

const DEFAULT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';

interface ChatBody {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  result?: ChatBody;
  success?: boolean;
  errors?: unknown[];
}

function sanitizeJson(text: string): string {
  return text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
}

export class CloudflareProvider implements AiProvider {
  name = 'cloudflare';

  constructor(
    private apiKey = env.CLOUDFLARE_API_KEY,
    private accountId = env.CLOUDFLARE_ACCOUNT_ID ?? env.CLOUDFLARE_ACC_ID,
  ) {}

  isAvailable(): boolean {
    return Boolean(this.apiKey && this.accountId);
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
    if (!this.apiKey || !this.accountId) throw new Error('Cloudflare API key or account ID is not configured');

    const fail = (reason: string, usage?: ChatBody['usage'], retryAfterMs?: number): never => {
      throw new ProviderError(
        `Cloudflare: ${reason.slice(0, 120)}`,
        {
          provider: this.name,
          model,
          startedAt,
          latencyMs: Math.round(performance.now() - start),
          inputTokens: usage?.prompt_tokens,
          outputTokens: usage?.completion_tokens,
          success: false,
          schemaValid: false,
          failureReason: reason.slice(0, 200),
        },
        retryAfterMs,
      );
    };

    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/v1/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(45_000),
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: params.systemPrompt },
          { role: 'user', content: params.userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: params.temperature ?? 0.1,
        max_tokens: params.maxOutputTokens ?? 2048,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      const dailyExhausted = /3036|daily allocation|10,?000 neurons/i.test(body);
      const retryAfter = Number(res.headers.get('retry-after'));
      return fail(`HTTP ${res.status}: ${body}`, undefined, res.status === 429
        ? dailyExhausted ? nextUtcMidnight(Date.now()) - Date.now() : retryAfter > 0 ? retryAfter * 1000 : 60_000
        : undefined);
    }

    const json = (await res.json()) as ChatBody;
    const body = json.result?.choices ? json.result : json;
    if (json.success === false || json.errors?.length) return fail(`API errors: ${JSON.stringify(json.errors)}`);

    const raw = body.choices?.[0]?.message?.content ?? '';
    if (!raw) return fail('Empty response content', body.usage);

    let data: T;
    try {
      data = JSON.parse(sanitizeJson(raw)) as T;
    } catch (err) {
      return fail(`JSON parse error: ${err instanceof Error ? err.message : String(err)}`, body.usage);
    }

    return {
      data,
      metric: {
        provider: this.name,
        model,
        startedAt,
        latencyMs: Math.round(performance.now() - start),
        inputTokens: body.usage?.prompt_tokens,
        outputTokens: body.usage?.completion_tokens,
        success: true,
        schemaValid: true,
      },
    };
  }
}
