import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { env } from '../../config/env';
import { ProviderError, type AiProvider, type AiRunMetric } from './types';
import { nextPacificMidnight } from './quota-clock';

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

function sanitizeJson(value: string): string {
  return value.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
}

export class GeminiProvider implements AiProvider {
  name = 'gemini';
  private genAI: GoogleGenAI | null = null;

  constructor(private apiKey = env.GEMINI_API_KEY) {}

  isAvailable(): boolean { return Boolean(this.apiKey); }

  async generateJson<T>(params: {
    systemPrompt: string;
    userPrompt: string;
    model?: string;
    temperature?: number;
    schema?: Record<string, unknown>;
    maxOutputTokens?: number;
    media?: { data: string; mimeType: string };
  }): Promise<{ data: T; metric: AiRunMetric }> {
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const model = params.model ?? DEFAULT_MODEL;
    if (!this.apiKey) throw new Error('GEMINI_API_KEY is not configured');
    this.genAI ??= new GoogleGenAI({ apiKey: this.apiKey });
    const fail = (reason: string, retryAfterMs?: number, inputTokens?: number, outputTokens?: number): never => {
      throw new ProviderError('Gemini: ' + reason.slice(0, 120), {
        provider: this.name, model, startedAt,
        latencyMs: Math.round(performance.now() - start),
        inputTokens, outputTokens, success: false, schemaValid: false,
        failureReason: reason.slice(0, 200),
      }, retryAfterMs);
    };
    let response;
    try {
      response = await this.genAI.models.generateContent({
        model,
        contents: params.media
          ? [{ inlineData: params.media }, { text: params.userPrompt }]
          : params.userPrompt,
        config: {
          systemInstruction: params.systemPrompt,
          responseMimeType: 'application/json',
          temperature: params.temperature ?? 0.1,
          maxOutputTokens: params.maxOutputTokens ?? 2048,
          responseSchema: params.schema,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryMatch = message.match(/retry(?:Delay| in| after)[^\\d]*([\\d.]+)s/i);
      const daily = /requests.per.day|per.day|RPD|daily|free_tier_requests/i.test(message);
      const retryAfterMs = daily ? nextPacificMidnight(Date.now()) - Date.now()
        : retryMatch ? Math.ceil(Number(retryMatch[1]) * 1000)
        : /429|RESOURCE_EXHAUSTED|quota|503|overloaded/i.test(message) ? 60_000
        : /404|not found|not supported/i.test(message) ? 24 * 60 * 60_000 : undefined;
      return fail(message, retryAfterMs);
    }
    const raw = response.text;
    const inputTokens = response.usageMetadata?.promptTokenCount;
    const outputTokens = (response.usageMetadata?.candidatesTokenCount ?? 0)
      + (response.usageMetadata?.thoughtsTokenCount ?? 0);
    if (!raw) return fail('Empty response content', undefined, inputTokens, outputTokens);
    let data: T;
    try { data = JSON.parse(sanitizeJson(raw)) as T; }
    catch (err) { return fail('JSON parse error: ' + (err instanceof Error ? err.message : String(err)), undefined, inputTokens, outputTokens); }
    return {
      data,
      metric: {
        provider: this.name, model, startedAt,
        latencyMs: Math.round(performance.now() - start),
        inputTokens, outputTokens, success: true, schemaValid: true,
      },
    };
  }
}
