# Workers AI OpenAI-Compatible Proxy

A Cloudflare Worker that proxies **OpenAI Chat Completions** requests to **Cloudflare Workers AI**, enabling agent-harness (which speaks the OpenAI protocol via `createOpenRouterLLM`) to use Workers AI models (Llama 3.1/3.3/4, Gemma 4, Qwen 3, Kimi, etc.) as LLM providers without any code changes.

## Architecture

```
agent-harness server (OpenAI-compatible client)
    ↓ OPEN_BASE_URL=https://workers-ai-proxy.<sub>.workers.dev/v1
    ↓ OPEN_API_KEY=<cf-token> (Bearer token, or CF_AI_TOKEN secret)
OpenAI Chat Completions request
    ↓
Cloudflare Worker (this proxy)
    ↓ translates OpenAI → Workers AI
Workers AI API (LLaMA-3, Gemma, Whisper, ...)
    ↓ translates Workers AI → OpenAI
OpenAI Chat Completions response (JSON + SSE streaming)
```

## Setup

### 1. Install Wrangler

```bash
cd deploy/workers-ai-proxy
npm install
```

### 2. Authenticate with Cloudflare

```bash
npx wrangler login
```

### 3. Configure secrets

Store your Cloudflare API token (with `AI:Edit` + `Workers Deploy` permissions) as a secret:

```bash
npx wrangler secret put CF_AI_TOKEN
# Paste: cfut_xxxx
```

You can also pass the token per-request via `Authorization: Bearer <token>` from agent-harness (when `CF_AI_TOKEN` secret is not set).

### 4. Deploy

```bash
npm run deploy
```

### 5. Configure agent-harness

Point agent-harness at the deployed Worker:

```bash
# In your .env or Docker environment
OPEN_BASE_URL=https://<your-worker-subdomain>.workers.dev/v1 \
OPEN_API_KEY=cfut_xxxxx \
OPEN_MODEL=llama-3-8b
```

## Endpoints

| OpenAI Path                     | Workers AI Target                              | Notes                                                    |
| ------------------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| `POST /v1/chat/completions`     | `POST /client/v4/accounts/{id}/ai/run/{model}` | Full OpenAI ↔ Workers AI translation, supports streaming |
| `GET /v1/models`                | —                                              | Returns available model list                             |
| `POST /v1/audio/transcriptions` | `POST .../ai/run/@cf/openai/whisper-v3`        | Whisper STT (audio as base64)                            |

## Supported Models

| OpenAI-style name   | Workers AI model                                     |
| ------------------- | ---------------------------------------------------- |
| `llama-3-8b`        | `@cf/meta/llama-3.1-8b-instruct-fp8`                 |
| `llama-3-70b`       | `@cf/meta/llama-3.3-70b-instruct-fp8-fast`           |
| `llama-4-scout`     | `@cf/meta/llama-4-scout-17b-16e-instruct`            |
| `gemma-7b`          | `@cf/google/gemma-4-26b-a4b-it`                      |
| `qwen-30b`          | `@cf/qwen/qwen3-30b-a3b-fp8`                         |
| `qwq-32b`           | `@cf/qwen/qwq-32b`                                   |
| `gpt-4o`            | Not available on Workers AI — use OpenRouter gateway |
| `gpt-4o-mini`       | Not available on Workers AI — use OpenRouter gateway |
| `mistral-small-3.1` | `@cf/mistral/mistral-small-3.1-24b-instruct`         |
| `kimi-k2.7-code`    | `@cf/moonshotai/kimi-k2.7-code`                      |
| `glm-4.7-flash`     | `@cf/zai-org/glm-4.7-flash`                          |

All models are current (non-deprecated) as of Cloudflare Workers AI catalog, September 2026. Reference: https://developers.cloudflare.com/workers-ai/models/

Add more models by extending `MODEL_MAP` in `src/index.ts`.

## Free Tier Quota

Workers AI's free tier includes per-model daily limits (thousands of requests for smaller models):

- **Llama 3.1 8B**: ~17,000 characters/day
- **Gemma 4**: ~7,000 characters/day
- **Whisper**: 10 minutes/day

See [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/) for current limits and paid upgrade options.

## Notes

- **Tool calls**: Supported on models that natively support tools. For models without native tool support, the proxy attempts best-effort JSON extraction from text output.
- **Streaming**: Full SSE streaming support — the Worker translates Workers AI's SSE format to OpenAI's `data: {...}` chunk format with proper `finish_reason` and `[DONE]` terminators.
- **Token usage**: Estimated when Workers AI doesn't return explicit usage stats (≈4 chars/token heuristic).
