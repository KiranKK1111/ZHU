# AI Models (provider integration)

## Built-in providers

| Provider | Free tier | Endpoint | Images | Model |
|---|---|---|---|---|
| Google Gemini | **Yes** | OpenAI-compatible `generativelanguage.googleapis.com/v1beta/openai` | ✓ | chosen on Connect (newest stable Flash) |
| Groq | **Yes** | `api.groq.com/openai/v1` | off by default | chosen on Connect (`gpt-oss-120b` family first) |
| OpenRouter | **Yes** (its `:free` models) | `openrouter.ai/api/v1` | off by default | chosen on Connect (`openrouter/free`, then a `:free` model) |
| Kilo Gateway | **Yes, no key needed** (its free models) | `ai-gateway.kilo.ai/api/v1` | off by default | chosen on Connect (`kilo-auto/free`, then a free model) |
| Pollinations | **Yes, no key needed** | `text.pollinations.ai/openai` | off by default | its one public model |
| SambaNova | **Yes** (while no payment method is linked) | `api.sambanova.ai/v1` | off by default | chosen on Connect |
| NVIDIA NIM | **Yes** (prototyping, developer account) | `integrate.api.nvidia.com/v1` | off by default | chosen on Connect |
| Z.ai (GLM) | **Yes** (the GLM-4 Flash models only) | `api.z.ai/api/paas/v4` | off by default | chosen on Connect (a free Flash model) |
| OpenAI | No | `api.openai.com/v1` | ✓ | chosen on Connect (newest `gpt-N`) |
| Claude (Anthropic) | No | official `anthropic` SDK (Messages API) | ✓ (≤ 20) | `claude-opus-5-5` |
| DeepSeek | No | `api.deepseek.com` | off by default | `deepseek-chat` |
| Grok (xAI) | No | `api.x.ai/v1` | ✓ | chosen on Connect |
| Local model | n/a | `http://localhost:11434/v1` (Ollama) by default; editable | off by default | the server's first model |

**Free tiers** were checked against the providers' own documentation on 2026-11-20: each of the eight can be called without a payment method. The limits are the providers' and change; Google also states that free-tier content may be used to improve its products, and Kilo Gateway and Pollinations say prompts to their free models may be logged. Kilo Gateway and Pollinations were also called without a key on that day; the other three new ones (SambaNova, NVIDIA NIM, Z.ai) were not, because no key was used in testing.

Considered and left out, from a list of 32 providers: Cerebras and Mistral (both now require billing before the API works), GitHub Models (retired in July 2026), Hugging Face, Together, DeepInfra, Nebius, Moonshot, MiniMax, Featherless (paid), Fireworks, Hyperbolic, Novita, AI21, Alibaba Qwen (one-time credits only), Vercel AI Gateway (free credit needs a payment method), Cloudflare Workers AI (free, but its address contains your account id and it has no model list endpoint), Cohere, Ollama Cloud, LLM7 and Bluesminds (free use could not be confirmed). Any OpenAI-compatible one of them can still be added as "another provider".

## Which models are free

When a provider is connected, the engine works out which of its chat models cost nothing (`registry.detect_free_models`) and stores them with the model list (`config.free_models`, `config.free_basis`). This runs for built-in providers and for providers the user adds.

| Basis | When | Free models |
|---|---|---|
| `listed` | The model list says so: a flag (`isFree`, `is_free`, a `free` tag), token prices that are all zero (`pricing.prompt`/`completion`, `pricing.input`/`output`, `metadata.pricing.input_tokens`/`output_tokens`, `input_token_price_per_m`…), or an id ending in `:free`, `-free` or `/free`. Also Z.ai, whose documentation names its free models | Those models |
| `free_tier` | A built-in provider whose free tier belongs to the account (Gemini, Groq, SambaNova, NVIDIA, Pollinations) | All its chat models |
| `local` | The address is on this computer or a private network | All its models |
| `unknown` | A remote provider whose list has no prices or markers | None; the UI says "Prices not published" |

A flag is believed before a price, and a price before an id. A negative price ("varies", used by routing models) counts as paid. Free models are listed first, and when only some models are free, Connect selects a free one, so connecting never selects a paid model by itself. The basis is a statement about the provider's list on the day of connecting; **Refresh** in the chat's model list reads the lists again.

**Paid APIs are separate from chat subscriptions.** ChatGPT Plus, Claude Pro, and similar plans do not include API access. To use those accounts, open the provider's website as a chat tab instead (the **+** on the tab strip; WEB_CHATS.md).

## Connect is one step

Settings → AI models → paste the key → **Connect** (`PUT /api/providers/{id}/config` with `api_key`, then `POST /api/providers/{id}/test`):

1. The key is stored in Windows Credential Manager.
2. The engine calls the provider's `GET /models`. A wrong key or address is reported here.
3. Non-chat models are dropped from the list (speech, embeddings, image and video generation, moderation, and so on; `registry.chat_models`). On OpenRouter, free models are listed first.
4. If no model is selected yet, one is chosen from that list (`registry.recommend_model`): the provider's preference patterns in order, stable ids before preview or dated ones, then the highest version. **No model id is hard-coded** for these providers, because ids are retired often (several ids current in mid-2026 were already deprecated when this was written). When nothing familiar is listed, no model is chosen and the user picks one from the dropdown.

The dropdown next to a connected provider changes the model at any time. "This model can read screenshots" switches image input on or off for the selected model; ZHU does not guess it.

## Your own models

**Add another provider** (Settings → AI models, or **Add or connect a provider** in the Custom chat's model list) takes a name, an address, and an optional key, for any OpenAI-compatible server (up to 20). After adding, ZHU reads the provider's model list, reports how many models it found and how many are free, and selects a free one when there is one. The address must be http(s) without embedded credentials; the form warns when it is unencrypted http to another machine. Without a key, no `Authorization` header is sent, which is what local servers expect. Removing the model also removes its key.

API: `POST /api/providers/custom {name, base_url, model?, api_key?, images?}` → provider info with an id `custom-<8 hex>`; `DELETE /api/providers/{id}` (your own models only).

Tested against a real local OpenAI-compatible HTTP server without a key: connect, automatic model choice, streamed answer, and a strict variant of the server that rejects unknown request fields (`tests/test_custom_providers.py`). **Not tested: the built-in cloud providers with real keys** (none were available). Their base URLs and behaviour come from their documentation.

## Asking

`POST /api/providers/{id}/submit {session_id, prompt, screenshot_ids, system?}`. `system` carries the user's "How answers should sound" text and is appended to the built-in system prompt. Answers stream over the WebSocket (`provider.delta`) and are stored as interactions of the session.

In the desktop app, answers come from the Custom chat, which has a route of its own (`POST /api/chats/{id}/messages`, CHAT.md); the app does not call `submit`. A detected question reaches the chat only as a draft in its message box (**Send to chat** on the question card, or automatically while listening), and is sent when you press Send.

## Adapter contract (`engine/zhu_engine/providers/base.py`)

```text
ProviderAdapter.initialize() · get_capabilities(model) · validate_configuration() · list_models()
               attach_images(request, images) · submit_prompt(request) -> request_id
               stream_response(request_id) -> async iterator[ProviderEvent(delta|completed|error)]
               cancel_request(request_id) · dispose()
```

* Capabilities are configured per provider (and model where it matters). Unsupported actions are disabled in the UI and rejected by the adapter with `ProviderError(kind="unsupported")`.
* Errors are normalized to `authentication | permission | rate_limited (retry_after_s) | invalid_request | not_found | unavailable | network | refused | cancelled | unsupported`. The UI shows the message and a Retry button, plus the `Retry-After` value when the provider sent one.
* The Claude adapter maps the SDK's typed exceptions (most specific first), and checks `stop_reason == "refusal"` before reporting success.
* Images are re-encoded on demand to fit provider limits (PNG when it fits within 5 MB, otherwise JPEG at decreasing quality, longest side ≤ 4096 px). The originals on disk are untouched.
* The last three completed exchanges with the same provider in the session are sent as context.
* Token usage is requested with `stream_options.include_usage`. A server that rejects the option (HTTP 400/422) gets the same request again without it, and the option is not sent to that server again.
* Deltas are batched to about 20 Hz before being published to the UI.

## Adding a provider

0. For an OpenAI-compatible endpoint, nothing needs to be added to the code: use **Add another model** in Settings.
1. To make it built-in, add a `ProviderDefinition` in `providers/registry.py` (id, name, base URL, images default, key page, `free_tier`, and `prefer` patterns for the automatic model choice).
2. If the provider is OpenAI-compatible, no new code is needed. Otherwise, implement a `ProviderAdapter` subclass and return it from `ProviderRegistry.adapter`.
3. Add tests with `httpx.MockTransport` (see `tests/test_components.py`).
