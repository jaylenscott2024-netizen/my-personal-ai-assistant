import type {
  AIProvider,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  ModelCapabilities,
  ProviderHealth,
} from "../types.js";

// A deterministic, fully local provider with no network calls. It exists so
// the agent orchestrator, tests, and local development work with zero
// external credentials — and so CI never depends on a real model provider
// being reachable. It is never presented to a user as a real AI provider;
// callers can see `id === "mock"` and the UI should label it accordingly.
//
// Behavior: if the latest user message contains `TOOL_CALL:<name>:<jsonArgs>`
// it requests that tool call. Otherwise it echoes back a canned
// acknowledgement referencing the last user message, so tests can assert on
// deterministic output.
export class MockProvider implements AIProvider {
  readonly id = "mock";
  readonly displayName = "Local Mock Provider (offline/dev)";

  isConfigured(): boolean {
    return true;
  }

  getCapabilities(): ModelCapabilities {
    return {
      text: true,
      vision: false,
      audio: false,
      streaming: true,
      toolCalling: true,
      structuredOutput: false,
      reasoning: false,
      longContext: false,
      contextWindowTokens: 32_000,
    };
  }

  listModels() {
    return [{ id: "mock-1", capabilities: this.getCapabilities() }];
  }

  async checkHealth(): Promise<ProviderHealth> {
    return { provider: this.id, configured: true, healthy: true, checkedAt: new Date().toISOString() };
  }

  private buildResponse(req: ChatRequest): ChatResponse {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const text = lastUser?.content ?? "";
    const match = /TOOL_CALL:(\w+):(\{.*\})/.exec(text);
    // Only request the tool call once: if the conversation already moved
    // past the user's message (a tool result exists after it), the "model"
    // has already seen the observation and should give its final answer
    // rather than re-issuing the same call forever.
    const alreadyObserved = req.messages[req.messages.length - 1]?.role === "tool";

    if (match && !alreadyObserved) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(match[2]);
      } catch {
        args = {};
      }
      return {
        content: "",
        toolCalls: [{ id: `mock-call-${Date.now()}`, name: match[1], arguments: args }],
        finishReason: "tool_calls",
        usage: { promptTokens: text.length, completionTokens: 0 },
        model: req.model,
        provider: this.id,
      };
    }

    const lastToolResult = [...req.messages].reverse().find((m) => m.role === "tool");
    const reply = lastToolResult
      ? `Observed tool result: ${lastToolResult.content}. Task complete.`
      : `Acknowledged: ${text.slice(0, 200)}`;

    return {
      content: reply,
      toolCalls: [],
      finishReason: "stop",
      usage: { promptTokens: text.length, completionTokens: reply.length },
      model: req.model,
      provider: this.id,
    };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    return this.buildResponse(req);
  }

  async *chatStream(req: ChatRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
    const response = this.buildResponse(req);
    if (response.content) {
      for (const word of response.content.split(" ")) {
        yield { type: "text_delta", delta: word + " " };
      }
    }
    yield { type: "usage", usage: response.usage };
    yield { type: "done", response };
  }
}
