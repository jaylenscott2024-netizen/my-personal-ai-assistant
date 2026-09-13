// Section 6/7: normalized AI provider interface + capability model.
// Every provider (Anthropic, OpenAI, Gemini, future/local) implements this
// exact shape so the agent orchestrator contains zero provider-specific
// branching (Section 86: model/voice separation applies equally here).

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. */
  inputSchema: Record<string, unknown>;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Present when role === "assistant" and the model requested tool calls. */
  toolCalls?: ToolCallRequest[];
  /** Present when role === "tool": which call this message answers. */
  toolCallId?: string;
  /** Marks content that originated outside the trust boundary (web pages,
   *  emails, tool output). Providers that support content-part typing use
   *  this to keep it from being interpreted as an instruction
   *  (Section 66: prompt-injection defense). Providers that don't are
   *  still safe because context/promptAssembly.ts wraps it in explicit
   *  delimiters regardless. */
  untrusted?: boolean;
  /** Optional image attachments (e.g. an on-demand frame captured by the
   *  Eyes subsystem). Provider-neutral: each provider's message-conversion
   *  function renders these into whatever vision content shape that API
   *  expects. The orchestrator only sets this when the active model's
   *  ModelCapabilities.vision is true — a non-vision model never sees it,
   *  rather than receiving unusable base64-in-text noise. Never persisted
   *  to the conversation history (in-memory for the current turn only).
   *
   *  Still supported and still the simplest way to attach a one-off image;
   *  `visualContext` below is the richer form for temporal visual context
   *  and takes precedence when both are present. */
  images?: Array<{ mimeType: string; base64: string }>;
  /** Temporal visual context selected by a provider-specific transport
   *  adapter (src/eyes/transport/*). Same lifetime rules as `images`:
   *  in-memory for the current turn only, never persisted. */
  visualContext?: ChatVisualContext;
}

// How a given provider/model can physically receive visual information.
// This is deliberately richer than the single `vision: boolean` flag:
// "can take an image" and "can take a live video stream" are completely
// different transports, and assuming every vision-capable API supports
// the same one is exactly the mistake this model exists to prevent.
//
// These are *declarations of what the API actually supports* — never
// aspirational. A provider must not claim videoInput/realtimeVision for a
// model whose endpoint doesn't accept it; the transport adapters below
// choose a strategy strictly from what's declared here.
export interface VisionCapabilities {
  /** Still images as message content (base64/data URI parts). */
  imageInput: boolean;
  /** Video as inline request content in a normal generate call. */
  videoInput: boolean;
  /** A live, bidirectional session that accepts visual frames as they happen. */
  realtimeVision: boolean;
  /** That same live session also accepts/produces audio. */
  realtimeAudio: boolean;
  /** Handles several timestamped images in one request as a coherent
   *  sequence (a "what changed between these" question), rather than only
   *  reasoning about a single image. */
  temporalImageContext: boolean;
  /** Video via a separate upload/file API referenced by the request. */
  videoUpload: boolean;
  /** Frames per second the realtime transport will actually accept. This
   *  bounds the CLOUD transport only — the local Eyes engine's own
   *  perception rate is independent of it (see EYES.md). */
  maxRealtimeVisualFps?: number;
  maxVideoFps?: number;
  maxImagesPerRequest?: number;
  preferredImageFormat?: string;
  preferredVideoFormat?: string;
}

export interface ModelCapabilities {
  text: boolean;
  /** Coarse "can this model see at all" flag. Kept as the stable, simple
   *  check every existing call site already uses; `visionCapabilities`
   *  below describes *how* it can see. */
  vision: boolean;
  audio: boolean;
  streaming: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
  reasoning: boolean;
  longContext: boolean;
  contextWindowTokens: number;
  /** Optional: when absent, callers derive a conservative image-only (or
   *  no-vision) capability set from `vision` — see ai/visionCapabilities.ts. */
  visionCapabilities?: VisionCapabilities;
}

// How visual context is actually being carried to a given model this turn.
// Chosen by a provider-specific VisionTransportAdapter (src/eyes/transport/*)
// purely from the capabilities above.
export type VisionTransportStrategy =
  | "text_only" // structural/temporal summary only — no pixels (non-vision models)
  | "image_set" // one or more still images in the request
  | "temporal_image_set" // several timestamped keyframes presented as a sequence
  | "video_upload" // video handed over via the provider's video pathway
  | "realtime_stream"; // frames flow over a live session, out of band from this request

export interface VisualContextImage {
  mimeType: string;
  base64: string;
  /** Short human-readable marker, e.g. "-3.2s (before the change)". Lets a
   *  model reason about ordering without inventing its own. */
  label?: string;
  capturedAtMs?: number;
}

// The wire-level visual payload attached to one message. Generalizes the
// older `ChatMessage.images` field (which remains supported): it carries
// not just pixels but the temporal/attention context that makes a set of
// frames interpretable, plus which transport produced it.
export interface ChatVisualContext {
  strategy: VisionTransportStrategy;
  images: VisualContextImage[];
  /** Always-safe text description of the observed window of time. Sent
   *  even to models that can't take images at all. */
  temporalSummary?: string;
  sourceTimestampMs?: number;
  /** Set when `strategy === "realtime_stream"`: frames are flowing over a
   *  live session with this id rather than being embedded in the request. */
  realtimeSessionId?: string;
}

export interface ChatRequest {
  model: string;
  systemPrompt?: string;
  messages: ChatMessage[];
  tools?: ToolDescriptor[];
  maxOutputTokens?: number;
  temperature?: number;
  /** JSON Schema — when present, ask the provider for structured output. */
  responseSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ChatResponseUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCallRequest[];
  finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "cancelled" | "error";
  usage: ChatResponseUsage;
  model: string;
  provider: string;
}

export type ChatStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_delta"; id: string; name?: string; argumentsDelta?: string }
  | { type: "usage"; usage: ChatResponseUsage }
  | { type: "done"; response: ChatResponse }
  | { type: "error"; message: string; recoverable: boolean };

export interface ProviderHealth {
  provider: string;
  configured: boolean;
  healthy: boolean;
  detail?: string;
  checkedAt: string;
}

export interface AIProvider {
  readonly id: string;
  readonly displayName: string;

  isConfigured(): boolean;
  getCapabilities(model: string): ModelCapabilities;
  listModels(): Array<{ id: string; capabilities: ModelCapabilities }>;
  checkHealth(): Promise<ProviderHealth>;

  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream(request: ChatRequest): AsyncGenerator<ChatStreamEvent, void, unknown>;
}
