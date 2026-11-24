# Configuration Reference

Engine settings are validated by Pydantic (`engine/zhu_engine/settings.py`), stored in SQLite, and edited in **Settings**. `PUT /api/settings` takes a partial object, `{section: {field: value}}`. UI-only preferences (theme, window opacity, hotkeys, close-to-tray, the questions column's layout, the chat tabs) live in the front-end preference store.

## audio
| Field | Default | Meaning |
|---|---|---|
| `microphone_enabled` / `system_enabled` | `true` / `true` | What ZHU listens to: both, or one of them. **Start listening** asks each time and saves the answer here; the hotkey and the tray start with it (Settings → Listening → Listen to). At least one stays on: a change that turns both off is refused. A change while listening starts or stops that source at once |
| `microphone_device` / `system_device` | `null` (Windows default) | Stable device ID `microphone:<name>` / `system:<name>` |
| `noise_reduction` | `true` | Soft noise gate (not a spectral denoiser) |
| `source_labels` | Microphone / System audio | Labels shown in the transcript |
| `question_sources` | `["system","microphone"]` | Sources that feed question detection |

## vad
`start_threshold` 0.5 · `end_threshold` 0.35 · `min_speech_ms` 250 · `min_silence_ms` 550 · `max_segment_s` 25

## transcription
| Field | Default | Meaning |
|---|---|---|
| `model` | `large-v3-turbo` | Preferred model; falls back automatically (see AUDIO_PIPELINE.md). Whisper: `large-v3-turbo`, `large-v3`, `distil-large-v3`, `medium`, `small`, `base`. Parakeet: `parakeet-tdt-0.6b-v2` (English), `parakeet-tdt-0.6b-v3` (25 European languages) |
| `device` | `auto` | `auto` / `cuda` (= GPU required: CUDA for Whisper, DirectML for Parakeet) / `cpu` |
| `compute_type` | `auto` | Whisper: `auto` / `float16` / `int8_float16` / `int8`. Parakeet: `int8` keeps it on the CPU; anything else uses FP32 on the GPU when memory allows |
| `language` | `en` | `null` = auto-detect per segment. Ignored by Parakeet (v2 is English only; v3 detects the language itself); used to filter fallback models |
| `vram_budget_mb` | 4096 | Upper bound for ZHU's model on the GPU |
| `profile` | `balanced` | Whisper final-decode beam: accuracy 5, balanced 3, latency 1. Parakeet always decodes greedily |
| `partial_interval_ms` | 700 | How often provisional text is re-decoded |
| `vocabulary_hints` | `true` | Pass distinctive technical terms as Whisper hotwords (Parakeet has no biasing) |

## questions
`short_pause_ms` 800 · `base_pause_ms` 1400 · `extended_pause_ms` 3500 · `max_completion_timeout_ms` 9000 (see QUESTION_ENGINE.md §3)

## capture
`image_format` png (`png`/`jpeg`/`webp`) · `jpeg_quality` 92 · `default_monitor` 1

## privacy
`retention_days` `null` (keep until deleted) · `store_transcripts` `true`

## Providers (`PUT /api/providers/{id}/config`)
`api_key` (write-only → Credential Manager; an empty string removes it) · `enabled` · `model` · `base_url` · `images` · `effort` (Claude: low…max) · `use_fallbacks` (Claude) · `display_name` · `include_history`

Connect: `POST /api/providers/{id}/test` checks the key, stores the model list, and selects a model when none is set. Your own models: `POST /api/providers/custom` `{name, base_url, model?, api_key?, images?}` · `DELETE /api/providers/{id}` (ids `custom-<8 hex>` only). See PROVIDERS.md.

## App preferences (main window's local storage, key `zhu.prefs.v1`)
`theme` `dark` · `closeToTray` `true` · `hotkeys` · `showTranscript` `true` · `questionsCollapsed` `false` · `questionsSplit` `0.4` (the questions column's share of the width beside the chats, 0.2–0.6, at least 300 px; `homeSplit` of earlier versions is carried over) · `transcriptSplit` `0.34` (the transcript's share of the questions column) · `answerProvider` (the connected provider a new Custom chat starts with, until a model is picked there) · `chatProvider` / `chatModel` (the model the Custom chat answers with; `null`: the first free model) · `instructions` (how answers should sound) · `webChatTabs` · `webChatActive` · `webChatAutoQuestions` `true` · `webChatAutoScreenshots` `true` · `webChatTarget` `all` (`all`/`active`) · `windowOpacity` `1` (0.4 to 1; hidden ZHU starts at 0.8 and is not saved). Unknown or mistyped keys from older versions are ignored (`sidePanelScope`, the screenshots panel's old All / This session switch, and `webChatResume`, the old *Your resume in new chats* setting, among them).

## What the Settings screen controls
The app shows only: audio sources and devices, language, the speech model, storing transcripts, and the items above. Every other engine setting on this page (VAD thresholds, GPU device and precision, VRAM budget, performance profile, question timing, capture format, retention, technical vocabulary) keeps its default and can still be changed through `PUT /api/settings` or `PUT /api/vocabulary` for unusual setups.

## Environment variables (engine)
| Variable | Purpose |
|---|---|
| `ZHU_ENGINE_TOKEN` | Bearer token (set by the shell; required) |
| `ZHU_PARENT_PID` | Stand-alone engine only (`python -m zhu_engine`, tests): exit when this process exits. The app runs the engine inside its own process and does not use it |
| `ZHU_DATA_DIR` | Data directory override (default `%LOCALAPPDATA%\app.zhu.desktop\data`) |
| `ZHU_LOG_LEVEL` | `INFO` by default |
| `ZHU_ENGINE_CMD` | (Shell, development) command used to start the engine |
| `ZHU_WEBCHAT_DEBUG_PORT` | (Shell, **debug builds only**) DevTools port for the chat-tab profile, used by the test harness. Ignored by release builds |

## Default global hotkeys
| Action | Default |
|---|---|
| Start/pause listening | Ctrl+Shift+L |
| Capture the whole screen | Ctrl+Shift+A |
| Copy latest question | Ctrl+Shift+C |
