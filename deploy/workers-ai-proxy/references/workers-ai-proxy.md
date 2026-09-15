---
name: agent-harness-engineering
category: software-development
---

# Cloudflare Workers AI Proxy Deployment for agent-harness

This skill covers deploying agent-harness with a **Cloudflare Workers AI** provider via an OpenAI-compatible proxy Worker.

## When to use this pattern

When the user wants to use Cloudflare Workers AI (free tier includes thousands of requests/day for Llama 3, Gemma, etc.) as the LLM provider for agent-harness.

## Architecture

agent-harness server (OpenAI-compatible client):
- OPEN_BASE_URL=https://<worker>.workers.dev/v1
- OPEN_API_KEY=<cf-token>
- POST /v1/chat/completions (OpenAI format)

→ Cloudflare Worker (proxy, in deploy/workers-ai-proxy/)
  → translates OpenAI → Workers AI format
  → POST https://api.cloudflare.com/client/v4/accounts/<id>/ai/run/<model>

Workers AI: Llama 3.1/3.3/4, Gemma 4, Qwen 3, Whisper...

← translates Workers AI → OpenAI format
← response back to agent-harness

## Deployment Steps

### 1. Create the Worker project

```bash
mkdir deploy/workers-ai-proxy
cd deploy/workers-ai-proxy
npm init -y
npm install --save-dev wrangler
npm pkg set scripts.dev="wrangler dev"
npm pkg set scripts.deploy="wrangler deploy"
```

### 2. Configure wrangler.json

```json
{
  "name": "workers-ai-proxy",
  "main": "src/index.ts",
  "account_id": "<your-cloudflare-account-id>",
  "compatibility_date": "2024-09-01",
  "vars": {
    "CF_AI_ACCOUNT_ID": "<your-cloudflare-account-id>"
  }
}
```

Get your account ID via: `npx wrangler whoami`

### 3. Set the API token as a secret

Never hardcode the token in wrangler.json. Use:
```bash
npx wrangler secret put CF_AI_TOKEN
# Paste your cfut_... token
```

### 4. Configure agent-harness

```bash
OPEN_BASE_URL=https://<your-worker-subdomain>.workers.dev/v1
OPEN_API_KEY=cfut_your_token_here
OPEN_MODEL=llama-3-8b
node access/server/dist/server.js
```

## Key Implementation Details

### Model Map Maintenance

Workers AI models get deprecated frequently (e.g. @cf/meta/llama-3-8b-instruct was deprecated in May 2026). Always verify current models at: https://developers.cloudflare.com/workers-ai/models/

The MODEL_MAP in src/index.ts maps OpenAI-style names to Workers AI model IDs. When a model is deprecated:
1. Find the replacement from the official catalog
2. Update the MODEL_MAP entry
3. Update DEFAULT_WORKER_MODEL if the default is deprecated
4. Redeploy: npx wrangler deploy

### Auth Token Handling

The Worker supports two auth modes:
- CF_AI_TOKEN secret (preferred for production): overrides client-provided Bearer token
- Client Bearer token: proxies Authorization: Bearer <token> header from request

Code pattern:
```typescript
const clientAuth = request.headers.get('Authorization') || '';
const apiKey = env.CF_AI_TOKEN || clientAuth.replace(/^Bearer\s+/i, '');
```

### Streaming Translation

Workers AI SSE format → OpenAI SSE format:
- Workers AI sends: data: {"result":{"response":"chunk text"}}\n\n
- OpenAI expects: data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"delta":{"content":"chunk text"},"finish_reason":null}]}\n\n

Buffer management: accumulate chunks, split on \n, keep incomplete trailing line in buffer.

### Non-streaming Response

Workers AI returns: {"result":{"response":"full text"}}
OpenAI format: {"id":"chatcmpl-...","object":"chat.completion","choices":[{"message":{"role":"assistant","content":"full text"},"finish_reason":"stop"}],"usage":{...}}

### Tool Calls

Workers AI text generation models may not support native tool calling. The proxy:
1. Passes tools array to Workers AI (some models support it)
2. If tools come back in result.tools, translates to OpenAI format
3. As fallback, attempts JSON extraction from text output (best-effort)

### Whisper (Speech-to-Text)

Workers AI Whisper endpoint:
```
POST https://api.cloudflare.com/client/v4/accounts/<id>/ai/run/@cf/openai/whisper-v3
body: {"audio": "<base64_encoded_audio>"}
response: {"result": {"text": "..."}}
```

The proxy accepts OpenAI multipart/form-data (with file field), converts to base64, and returns {"text": "..."} in OpenAI format.

## Free Tier Quotas

Workers AI free tier provides per-model daily limits:
- Llama 3.1 8B: ~17,000 characters/day
- Gemma 4: ~7,000 characters/day
- Whisper: 10 minutes/day

See https://developers.cloudflare.com/workers-ai/ for current limits.

## Pitfall Log

### 1. Deprecated model IDs

Workers AI deprecates models frequently. If you get `410: Model has been deprecated`, check the official catalog and update MODEL_MAP. Always use @cf/meta/llama-3.1-8b-instruct-fp8 (NOT llama-3-8b-instruct which is deprecated).

### 2. Auth token not loaded in local dev

`wrangler dev` does NOT load secrets by default. To test with auth in local dev:
```bash
curl -H "Authorization: Bearer cfut_..." -X POST http://127.0.0.1:8787/v1/chat/completions \
  -d '{"model":"llama-3-8b","messages":[...]}'
```
Or use .dev.vars:
```bash
echo 'CF_AI_TOKEN=cfut_...' > .dev.vars
```

### 3. Wrangler JSON `rules` format

In Wrangler 4.x, `rules` array requires `globs` field for `type: "ESModule"`. Simplest fix: omit `rules` entirely (ESModule is the default).

### 4. Sandbox network restrictions

In restricted environments (like CI sandboxes), outbound HTTPS to *.workers.dev may be blocked. Test with `wrangler dev` on localhost instead — it can still reach Cloudflare's API endpoints.

## File Layout

```
deploy/workers-ai-proxy/
├── src/index.ts          # Worker code (OpenAI ↔ Workers AI translator)
├── wrangler.json         # Worker config (account_id, vars)
├── package.json          # dev: wrangler, deploy, typecheck
├── tsconfig.json         # TypeScript config
├── .gitignore            # node_modules/, .wrangler/
├── .dev.vars.example     # Template for local dev env vars
└── README.md             # Full documentation
```
