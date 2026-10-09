# AI cascade and quota setup

All listing extraction, demand extraction, Bright Data classification and extraction use the same route order: Groq Qwen 3.8 27B → Gemini 3.5 Flash-Lite → Gemini 3.1 Flash-Lite → Gemini 3.8 Flash → Gemini 3.7 Flash → Gemini 3.6 Flash → Gemini 3.5 Flash → Cloudflare Llama 3.1 8B FP8. Natural-language search uses the same Gemini routes and quota counters, including voice input. OpenAI is not used.

The Google models above have a **standard API free tier** on the [official pricing page](https://ai.google.dev/gemini-api/docs/pricing). Free-tier eligibility is not a guarantee that a particular API project has access or that a paid project will be charged zero. Do not enable billing for this project if zero spend is a hard requirement.

## Limits

The router counts requests and estimated tokens **separately for each provider/model pair** and reserves a slot before each request. It skips an exhausted route, tries the next one, and respects provider cooldowns. A daily-quota 429 cools Gemini until Pacific midnight and Cloudflare until UTC midnight; other models continue. When every route is temporarily limited, it waits up to about one minute for the earliest slot; it will not wait a full day. These counters are shared within one Node process, **not across separate scraper/CLI processes or machines**. Do not run multiple AI-heavy jobs concurrently against the same keys without an external quota coordinator.

Google [does not publish a single universal free-tier RPM/TPM/RPD table](https://ai.google.dev/gemini-api/docs/rate-limits): actual limits vary by project and model. The built-in Gemini settings below come from this project's AI Studio snapshot supplied on 2026-10-06. In each `used / limit` dashboard cell, the **denominator** is the configured ceiling; the numerator is transient usage, not a limit. TPM is input tokens only. Google quotas are per project, not per API key; RPD resets at midnight Pacific time, which the router follows.

| Gemini model | RPM | Input TPM | RPD |
| --- | ---: | ---: | ---: |
| 3.5 Flash-Lite | 15 | 250,000 | 500 |
| 3.1 Flash-Lite | 15 | 250,000 | 500 |
| 3.8 Flash | 5 | 250,000 | 20 |
| 3.7 Flash | 5 | 250,000 | 20 |
| 3.6 Flash | 5 | 250,000 | 20 |
| 3.5 Flash | 5 | 250,000 | 20 |

Requests made in AI Studio or by another process are not included in this process's local counter. Google still enforces the project quota; on a 429 the affected model cools down while other models continue. Recheck the dashboard after a tier change.

Override limits in `.env` with one JSON object if the project tier changes. Keys are `provider:model`; supported fields are `rpm`, `rpd`, `tpm` (combined), `inputTpm`, `tpd`, `outputTpm`, `maxOutputTokens`, `dailyNeurons`, `inputNeuronsPerMillion`, and `outputNeuronsPerMillion`. Missing fields retain the built-in setting. Example:

```dotenv
AI_MODEL_LIMITS_JSON={"gemini:gemini-3.5-flash-lite":{"rpm":10,"rpd":400,"inputTpm":200000},"groq:qwen/qwen3.8-27b":{"outputTpm":900}}
```

Groq Qwen's published free limits are [30 RPM, 1,000 RPD, 8,000 TPM and 200,000 TPD](https://console.groq.com/docs/rate-limits); output-per-minute may differ by account, so the built-in 1,000 is a cautious ceiling. Cloudflare's free allowance is [10,000 neurons/day](https://developers.cloudflare.com/workers-ai/platform/pricing/). The router estimates FP8 neuron usage from Cloudflare's published model conversion rates and stops at 9,500 neurons/day for headroom; actual usage can differ, and an API error 3036 also disables that route. Check the account dashboard for actual consumption.

No live API calls run during unit tests. `npm run gemini:audit` queries Google's model catalog if you want to verify that the configured IDs are visible to the current key.
