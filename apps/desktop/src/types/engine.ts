/**
 * TypeScript mirrors of the engine contracts. Source of truth:
 * engine/zhu_engine/questions/types.py, api/serialize.py, session.py, settings.py,
 * providers/registry.py, stt/models.py.
 */

export type AudioSource = "microphone" | "system" | "manual" | "unknown";

export type QuestionState =
  | "IDLE"
  | "SPEECH_DETECTED"
  | "CANDIDATE"
  | "QUESTION_IN_PROGRESS"
  | "AWAITING_COMPLETION"
  | "COMPLETE"
  | "REVISED"
  | "DISCARDED"
  | "MANUALLY_EDITED";

export type QuestionKind =
  | "DIRECT"
  | "IMPERATIVE"
  | "CODING_TASK"
  | "SCENARIO"
  | "MULTI_PART"
  | "INDIRECT"
  | "BEHAVIORAL"
  | "MATH"
  | "INCOMPLETE";

export type QuestionCategory =
  | "JAVA"
  | "SPRING_BOOT"
  | "JAVASCRIPT"
  | "TYPESCRIPT"
  | "REACT"
  | "NODEJS"
  | "PYTHON"
  | "CSHARP"
  | "CPP"
  | "SQL"
  | "DATABASE"
  | "DATA_STRUCTURES"
  | "ALGORITHMS"
  | "SYSTEM_DESIGN"
  | "MICROSERVICES"
  | "DEVOPS"
  | "CLOUD"
  | "MATH"
  | "BEHAVIORAL"
  | "GENERAL";

export interface Confidence {
  transcription: number | null;
  classification: number | null;
  boundary: number | null;
  context_resolution: number | null;
  normalization: number | null;
  calibrated: boolean;
}

export interface Span {
  start: number;
  end: number;
  reason: string;
}

export interface Substitution {
  original: string;
  replacement: string;
  rule: string;
  confidence: number;
}

export interface EditRecord {
  at_ms: number;
  before: string;
  after: string;
  editor: string;
}

export interface Question {
  question_id: string;
  session_id: string;
  state: QuestionState;
  revision: number;
  raw_text: string;
  formatted_text: string;
  resolved_text: string | null;
  kind: QuestionKind;
  category: QuestionCategory;
  source_segment_ids: string[];
  started_at_ms: number;
  ended_at_ms: number | null;
  source: AudioSource;
  speaker: string;
  confidence: Confidence;
  subquestions: string[];
  scenario: string | null;
  uncertain_spans: Span[];
  substitutions: Substitution[];
  math_latex: string | null;
  needs_review: boolean;
  review_reasons: string[];
  parent_question_id: string | null;
  repeat_of: string | null;
  saved: boolean;
  edit_history: EditRecord[];
  display_text: string;
}

export interface QuestionRevisionRow {
  revision: number;
  state: QuestionState;
  formatted_text: string;
  resolved_text: string | null;
  editor: string;
  created_at: number;
}

export interface WordInfo {
  text: string;
  start_ms: number;
  end_ms: number;
  probability: number | null;
}

/** transcript.partial / transcript.final payload */
export interface TranscriptSegmentEvent {
  segment_id: string;
  revision: number;
  text: string;
  start_ms: number;
  end_ms: number;
  is_final: boolean;
  source: AudioSource;
  speaker: string;
  confidence: number | null;
  words: WordInfo[];
  language: string | null;
  source_label: string;
  meta?: { rtf: number | null; latency_ms: number | null; no_speech_prob: number };
}

/** GET /sessions/{id}/transcript row (and transcript.corrected payload) */
export interface TranscriptRow {
  id: number;
  session_id: string;
  segment_id: string;
  revision: number;
  source: AudioSource;
  speaker: string;
  text: string;
  corrected_text: string | null;
  start_ms: number;
  end_ms: number;
  is_final: boolean;
  confidence: number | null;
  language: string | null;
  words: WordInfo[];
  created_at: number;
}

export interface Session {
  id: string;
  name: string;
  status: "active" | "ended";
  started_at: number;
  ended_at: number | null;
  last_activity_at: number;
  notes: string;
  question_count: number;
  screenshot_count: number;
  segment_count: number;
}

export type ListeningState = "idle" | "loading_model" | "listening" | "paused" | "error";

export interface SourceStatus {
  state: "starting" | "capturing" | "reconnecting" | "stopped";
  device: string | null;
  label: string;
  message: string | null;
}

export interface ListeningStatus {
  state: ListeningState;
  message: string | null;
  session_id: string | null;
  elapsed_ms: number;
  sources: Record<string, SourceStatus>;
  model: string | null;
  device: "cuda" | "directml" | "cpu" | null;
  compute_type: string | null;
  selection_reason: string | null;
  stats: { jobs: number; dropped_partials: number; last_rtf: number | null; last_latency_ms: number | null; load_ms: number | null } | null;
  question_state: Record<string, QuestionState>;
}

export interface Screenshot {
  id: string;
  session_id: string | null;
  file_name: string;
  width: number;
  height: number;
  format: "png" | "jpeg" | "webp";
  bytes: number;
  mode: "monitor" | "all" | "window";
  monitor: number | null;
  created_at: number;
  duplicate?: boolean;
}

export interface Monitor {
  index: number;
  left: number;
  top: number;
  width: number;
  height: number;
  primary: boolean;
}

export interface Capabilities {
  text: boolean;
  images: boolean;
  streaming: boolean;
  model_selection: boolean;
  conversation_history: boolean;
  max_images: number;
}

export interface ProviderConfig {
  enabled: boolean;
  model: string | null;
  base_url: string | null;
  images: boolean | null;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  use_fallbacks: boolean;
  display_name: string | null;
  include_history: boolean;
  known_models: string[];
  /** The known models that cost nothing to use. */
  free_models: string[];
  /** How the free models were decided; null before the first connection. */
  free_basis: FreeBasis | null;
  /** The known models that read images, when the provider's model list says which do; null when it does not say. */
  image_models?: string[] | null;
  /** For the same models, what each takes besides text ("image", "file", "audio", "video"); an empty list is a text-only model. */
  model_inputs?: Record<string, string[]> | null;
}

/**
 * - "listed": the provider's model list marks them (a zero price, or an id ending in ":free")
 * - "free_tier": the provider has a free tier for its models (its limits apply)
 * - "local": the models run on this computer or the user's own network
 * - "unknown": the list carries no prices, so nothing can be said
 */
export type FreeBasis = "listed" | "free_tier" | "local" | "unknown";

export type ProviderStatus = "ready" | "not_configured" | "needs_model" | "disabled";

/** An AI model provider: a built-in one, or an endpoint the user added. */
export interface ProviderInfo {
  id: string;
  name: string;
  vendor: string;
  default_base_url: string | null;
  default_model: string | null;
  default_images: boolean;
  /** Where the user creates an API key. */
  keys_url: string | null;
  notes: string;
  /** The provider offers API use without payment (limits are the provider's and can change). */
  free_tier: boolean;
  /** False for the user's own endpoints: local servers such as Ollama need no API key. */
  key_required: boolean;
  /** A model the user added (removable). */
  user_defined: boolean;
  status: ProviderStatus;
  status_message: string;
  has_api_key: boolean;
  api_key_hint: string | null;
  capabilities: Capabilities;
  config: ProviderConfig;
  /** The selected model id, or null until one is chosen. */
  model: string | null;
}

export interface ProviderErrorInfo {
  kind: string;
  message: string;
  retry_after_s: number | null;
  status: number | null;
}

export interface Interaction {
  id: string;
  session_id: string | null;
  provider_id: string;
  model: string | null;
  prompt: string;
  screenshot_ids: string[];
  response: string;
  status: "pending" | "streaming" | "completed" | "failed" | "cancelled";
  error: string | null;
  usage: Record<string, unknown> | null;
  started_at: number;
  completed_at: number | null;
}

export interface ProviderTestResult {
  /** The model selected after a successful connection (chosen automatically when none was set). */
  model?: string | null;
  ok: boolean;
  message: string;
  models: string[];
  /** How many chat models the provider lists (`models` holds at most the first 300, free ones first). */
  model_count?: number;
  free_models?: string[];
  free_basis?: FreeBasis | null;
  error?: ProviderErrorInfo;
}

/** A conversation in the built-in chat tab. */
export interface ChatConversation {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  message_count: number;
  /** The request writing an answer in this conversation right now, if any. */
  streaming_request_id?: string | null;
}

export interface ChatMessage {
  seq: number;
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  /** The provider and model that wrote an answer (null for the user's messages). */
  provider_id: string | null;
  model: string | null;
  status: "streaming" | "completed" | "failed" | "cancelled";
  error: ProviderErrorInfo | null;
  usage: Record<string, unknown> | null;
  /** Screenshots sent with a user's message. */
  screenshot_ids: string[];
  created_at: number;
  completed_at: number | null;
}

/** The user's résumé as the engine keeps it: the text of the uploaded file, not the file. */
export interface ResumeInfo {
  file_name: string;
  uploaded_at: number | null;
  /** While on, the text is given to the model with every question. */
  enabled: boolean;
  /** The file was longer than the engine keeps; the end was cut. */
  truncated: boolean;
  characters: number;
  words: number;
  text: string;
}

export interface ChatSendResult {
  request_id: string;
  conversation: ChatConversation;
  user_message: ChatMessage;
  assistant_message: ChatMessage;
}

export interface ModelSpec {
  name: string;
  repo: string;
  label: string;
  multilingual: boolean;
  download_mb: number;
  /** Whisper: FP16 VRAM estimate. Parakeet: FP32 DirectML VRAM estimate. */
  vram_fp16_mb: number;
  /** Whisper: INT8/FP16 VRAM estimate. Parakeet: 0 (INT8 runs on the CPU). */
  vram_int8_mb: number;
  notes: string;
  backend: "whisper" | "parakeet";
  /** Supported language codes; null means every Whisper language. */
  languages: string[] | null;
  cpu_ram_mb: number;
  /** Pinned Hugging Face commit, or null for the repository's main branch. */
  revision: string | null;
  /** Ready-to-display memory requirements, e.g. "Planning estimate 2.5 GB VRAM (FP16), 1.7 GB (INT8)". */
  memory_summary: string;
  installed: boolean;
}

export type DownloadState = "queued" | "downloading" | "verifying" | "completed" | "failed" | "cancelled";

export interface DownloadProgress {
  model: string;
  state: DownloadState;
  downloaded_bytes: number;
  total_bytes: number | null;
  message: string | null;
}

export interface GpuInfo {
  cuda_available: boolean;
  device_name: string | null;
  driver_version: string | null;
  vram_total_mb: number | null;
  vram_free_mb: number | null;
  vram_used_mb: number | null;
  engine_vram_mb: number | null;
  utilization_pct: number | null;
  temperature_c: number | null;
  compute_types: string[] | null;
  error: string | null;
}

export interface ModelsStatus {
  catalog: ModelSpec[];
  installed: string[];
  recommended: string;
  active_download: string | null;
  downloads: Record<string, DownloadProgress>;
  selected: string;
  gpu: GpuInfo;
  setup_required: boolean;
  /** Free host memory (RAM + page file); model loading needs it in addition to VRAM. */
  host_memory: { total_mb: number; available_mb: number; commit_limit_mb: number; commit_available_mb: number } | null;
  /** Set when loading the selected or recommended model is likely to fail for lack of host memory. */
  memory_warning: string | null;
}

export interface AudioDevice {
  id: string;
  name: string;
  kind: "microphone" | "system";
  index: number;
  channels: number;
  default_samplerate: number;
  is_default: boolean;
}

export interface EngineSettings {
  audio: {
    microphone_enabled: boolean;
    microphone_device: string | null;
    system_enabled: boolean;
    system_device: string | null;
    noise_reduction: boolean;
    source_labels: Record<string, string>;
    question_sources: ("microphone" | "system")[];
  };
  vad: {
    start_threshold: number;
    end_threshold: number;
    min_speech_ms: number;
    min_silence_ms: number;
    max_segment_s: number;
  };
  transcription: {
    model: string;
    device: "auto" | "cuda" | "cpu";
    compute_type: "auto" | "float16" | "int8_float16" | "int8";
    language: string | null;
    vram_budget_mb: number;
    profile: "accuracy" | "balanced" | "latency";
    partial_interval_ms: number;
    vocabulary_hints: boolean;
  };
  questions: {
    short_pause_ms: number;
    base_pause_ms: number;
    extended_pause_ms: number;
    max_completion_timeout_ms: number;
  };
  capture: {
    image_format: "png" | "jpeg" | "webp";
    jpeg_quality: number;
    default_monitor: number;
  };
  privacy: {
    retention_days: number | null;
    store_transcripts: boolean;
  };
}

export type SettingsPatch = { [K in keyof EngineSettings]?: Partial<EngineSettings[K]> };

export interface VocabularyTerm {
  canonical: string;
  aliases: string[];
  domains: string[];
  context: string[] | null;
  context_domains: string[];
  disabled: boolean;
}

export interface Diagnostics {
  engine_version: string;
  python: string;
  platform: string;
  frozen: boolean;
  ctranslate2: string;
  faster_whisper: string;
  onnxruntime: string;
  schema_version: number;
  data_dir: string;
  listening: ListeningStatus;
  gpu: GpuInfo;
  event_seq: number;
}

/* ------------------------------------------------------------ WebSocket */

export type EventType =
  | "transcript.partial"
  | "transcript.final"
  | "transcript.corrected"
  | "transcript.cleared"
  | "question.created"
  | "question.updated"
  | "question.completed"
  | "question.revised"
  | "question.discarded"
  | "question.error"
  | "listening.status"
  | "audio.level"
  | "speech.activity"
  | "gpu.stats"
  | "screenshot.created"
  | "screenshot.deleted"
  | "session.created"
  | "session.updated"
  | "session.deleted"
  | "provider.started"
  | "provider.delta"
  | "provider.completed"
  | "provider.error"
  | "provider.updated"
  | "model.download"
  | "settings.updated"
  | "engine.error"
  | "data.purged";

export interface Envelope<T = unknown> {
  seq: number;
  event_type: EventType | string;
  session_id: string | null;
  ts_ms: number;
  data: T;
}

export interface HelloAck {
  type: "hello.ack";
  instance: string;
  seq: number;
  gap: boolean;
  listening: ListeningStatus;
}
