import { AiRouter, resetAiRouterLimits } from '../src/modules/ai/router';
import { GEMINI_PROJECT_LIMITS } from '../src/modules/ai/cascade';
import { nextPacificMidnight } from '../src/modules/ai/quota-clock';
import { ProviderError, type AiProvider, type AiRunMetric } from '../src/modules/ai/types';

function provider(name: string, calls: string[], fail = false): AiProvider {
  return {
    name,
    isAvailable: () => true,
    async generateJson<T>({ model }: { model?: string }) {
      calls.push(`${name}:${model}`);
      const metric: AiRunMetric = {
        provider: name, model: model ?? '', startedAt: new Date().toISOString(),
        latencyMs: 1, success: !fail, schemaValid: !fail, inputTokens: 2, outputTokens: 2,
      };
      if (fail) throw new ProviderError('429 quota', metric, 86_400_000);
      return { data: { ok: true } as T, metric };
    },
  };
}

describe('AI cascade quota isolation', () => {
  beforeEach(() => resetAiRouterLimits());
  afterEach(() => jest.restoreAllMocks());

  test('Gemini RPD resumes at Pacific midnight instead of waiting a rolling 24 hours', async () => {
    let now = Date.parse('2026-10-07T06:59:00Z'); // Oct 6, 23:59 PDT
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    expect(nextPacificMidnight(now)).toBe(Date.parse('2026-10-07T07:00:00Z'));
    const calls: string[] = [];
    const router = new AiRouter({ routes: [
      { provider: provider('gemini', calls), model: 'lite', limits: { rpd: 1 } },
    ] });
    await router.generateJson({ systemPrompt: 'a', userPrompt: 'b' });
    now = Date.parse('2026-10-07T07:01:00Z');
    await router.generateJson({ systemPrompt: 'a', userPrompt: 'b' });
    expect(calls).toEqual(['gemini:lite', 'gemini:lite']);
  });

  test('uses the supplied AI Studio limits for each Gemini model', () => {
    for (const model of ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'] as const) {
      expect(GEMINI_PROJECT_LIMITS[model]).toMatchObject({ rpm: 15, inputTpm: 250_000, rpd: 500 });
    }
    for (const model of ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash'] as const) {
      expect(GEMINI_PROJECT_LIMITS[model]).toMatchObject({ rpm: 5, inputTpm: 250_000, rpd: 20 });
    }
  });

  test('Gemini input TPM does not charge reserved output tokens', async () => {
    const calls: string[] = [];
    const router = new AiRouter({ routes: [
      { provider: provider('gemini', calls), model: 'lite', limits: { inputTpm: 2, maxOutputTokens: 100 } },
      { provider: provider('cloudflare', calls), model: 'llama' },
    ] });
    const result = await router.generateJson({ systemPrompt: 'a', userPrompt: 'b' });
    expect(result.model).toBe('lite');
  });

  test('one model reaching RPD does not block another model from the same provider', async () => {
    const calls: string[] = [];
    const gemini = provider('gemini', calls);
    const router = new AiRouter({ routes: [
      { provider: gemini, model: 'lite', limits: { rpd: 1, maxOutputTokens: 10 } },
      { provider: gemini, model: 'flash', limits: { rpd: 2, maxOutputTokens: 10 } },
    ] });
    await router.generateJson({ systemPrompt: 'a', userPrompt: 'b' });
    const second = await router.generateJson({ systemPrompt: 'a', userPrompt: 'b' });
    expect(second.model).toBe('flash');
    expect(calls).toEqual(['gemini:lite', 'gemini:flash']);
  });

  test('provider 429 cools only its model and falls through', async () => {
    const calls: string[] = [];
    const router = new AiRouter({ routes: [
      { provider: provider('groq', calls, true), model: 'qwen' },
      { provider: provider('gemini', calls), model: 'lite' },
    ] });
    await router.generateJson({ systemPrompt: 'a', userPrompt: 'b' });
    await router.generateJson({ systemPrompt: 'a', userPrompt: 'b' });
    expect(calls).toEqual(['groq:qwen', 'gemini:lite', 'gemini:lite']);
  });

  test('concurrent calls reserve RPM before awaiting the provider', async () => {
    const calls: string[] = [];
    const first = provider('gemini', calls);
    const second = provider('cloudflare', calls);
    const router = new AiRouter({ routes: [
      { provider: first, model: 'lite', limits: { rpm: 1 } },
      { provider: second, model: 'llama' },
    ] });
    const results = await Promise.all([
      router.generateJson({ systemPrompt: 'a', userPrompt: 'b' }),
      router.generateJson({ systemPrompt: 'a', userPrompt: 'b' }),
    ]);
    expect(results.map((result) => result.model)).toEqual(['lite', 'llama']);
  });

  test('Cloudflare neuron ceiling is tracked separately from Gemini requests', async () => {
    const calls: string[] = [];
    const router = new AiRouter({ routes: [
      { provider: provider('cloudflare', calls), model: 'llama', limits: {
        dailyNeurons: 12, inputNeuronsPerMillion: 1_000_000,
        outputNeuronsPerMillion: 1_000_000, maxOutputTokens: 10,
      } },
      { provider: provider('gemini', calls), model: 'lite' },
    ] });
    await router.generateJson({ systemPrompt: 'a', userPrompt: 'b' });
    const second = await router.generateJson({ systemPrompt: 'a', userPrompt: 'b' });
    expect(second.model).toBe('lite');
    expect(calls).toEqual(['cloudflare:llama', 'gemini:lite']);
  });
});
