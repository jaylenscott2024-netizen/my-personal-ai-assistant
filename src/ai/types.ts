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
   *  to the conversation history (in-memory for the current turn only). */
  images?: Array<{ mimeType: string; base64: string }>;
}

export interface ModelCapabilities {
  text: boolean;
  vision: boolean;
  audio: boolean;
  streaming: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
  reasoning: boolean;
  longContext: boolean;
  contextWindowTokens: number;
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
