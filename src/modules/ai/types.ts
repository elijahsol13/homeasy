/**
 * HomEasy — AI provider abstraction for classification & extraction.
 *
 * Design goal: router is provider-agnostic. Implementations can be Groq, Gemini,
 * Cloudflare, local, etc. The router handles fallback, schema validation, and metrics.
 */

export interface AiRunMetric {
  provider: string;
  model: string;
  startedAt: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  success: boolean;
  fallbackUsed?: boolean;
  failureReason?: string;
  schemaValid: boolean;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public metric: AiRunMetric,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

export interface AiProvider {
  name: string;
  isAvailable(): boolean;
  generateJson<T>(params: {
    systemPrompt: string;
    userPrompt: string;
    model?: string;
    temperature?: number;
    schema?: Record<string, unknown>;
    maxOutputTokens?: number;
    media?: { data: string; mimeType: string };
  }): Promise<{ data: T; metric: AiRunMetric }>;
}

export interface AiModelLimits {
  rpm?: number;
  rpd?: number;
  tpm?: number;
  /** Gemini's TPM quota counts input tokens only; unlike Groq's combined TPM. */
  inputTpm?: number;
  tpd?: number;
  outputTpm?: number;
  maxOutputTokens?: number;
  dailyNeurons?: number;
  inputNeuronsPerMillion?: number;
  outputNeuronsPerMillion?: number;
}

export interface AiRoute {
  provider: AiProvider;
  model: string;
  limits?: AiModelLimits;
}

export interface AiRouterConfig {
  routes?: AiRoute[];
  /** Compatibility for callers that do not yet configure per-model routes. */
  providers?: AiProvider[];
  onMetric?: (metric: AiRunMetric) => void;
}

export interface AiRouterResult<T> {
  data: T;
  metrics: AiRunMetric[];
  providerName: string;
  model: string;
  /** Index of the winning provider in the router's configured order (0 = primary). */
  fallbackDepth: number;
}
