import { request } from "undici";
import { env } from "../../config/env.js";
import { ProviderError, RateLimitError } from "../../utils/errors.js";
import { withRetry } from "../retry.js";
import type {
  AIProvider,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  ModelCapabilities,
  ProviderHealth,
  ToolCallRequest,
} from "../types.js";

const API_BASE = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

const MODEL_CAPS: Record<string, ModelCapabilities> = {
  "claude-sonnet-5": cap(true, 200_000, true),
  "claude-opus-5": cap(true, 200_000, true),
  "claude-haiku-4-5-20251001": cap(true, 200_000, true),
};

function cap(vision: boolean, ctx: number, reasoning: boolean): ModelCapabilities {
  return {
    text: true,
    vision,
    audio: false,
    streaming: true,
    toolCalling: true,
    structuredOutput: true,
    reasoning,
    longContext: ctx >= 100_000,
    contextWindowTokens: ctx,
  };
}

function defaultCaps(): ModelCapabilities {
  return cap(true, 200_000, true);
}

// Converts our normalized ChatMessage[] into Anthropic's Messages API
// shape: a separate `system` string plus a `messages` array where tool
// results are user-role `tool_result` content blocks.
export function toAnthropicMessages(req: ChatRequest) {
  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [];

  for (const m of req.messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId,
            content: m.content,
          },
        ],
      });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      const content: unknown[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const call of m.toolCalls) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
      }
      messages.push({ role: "assistant", content });
      continue;
    }
    // External/untrusted content is wrapped so the model can distinguish
    // it from an instruction even if the transport doesn't have a
    // dedicated content type for it (Section 66).
    const text = m.untrusted ? `<external_content trust="untrusted">\n${m.content}\n</external_content>` : m.content;
    messages.push({ role: m.role === "user" ? "user" : "assistant", content: text });
  }
  return messages;
}

function fromAnthropicContent(content: Array<Record<string, unknown>>): { text: string; toolCalls: ToolCallRequest[] } {
  let text = "";
  const toolCalls: ToolCallRequest[] = [];
  for (const block of content) {
    if (block.type === "text") text += String(block.text ?? "");
    if (block.type === "tool_use") {
      toolCalls.push({
        id: String(block.id),
        name: String(block.name),
        arguments: (block.input as Record<string, unknown>) ?? {},
      });
    }
  }
  return { text, toolCalls };
}

export class AnthropicProvider implements AIProvider {
  readonly id = "anthropic";
  readonly displayName = "Anthropic Claude";

  isConfigured(): boolean {
    return Boolean(env.ANTHROPIC_API_KEY);
  }

  getCapabilities(model: string): ModelCapabilities {
    return MODEL_CAPS[model] ?? defaultCaps();
  }

  listModels() {
    return Object.entries(MODEL_CAPS).map(([id, capabilities]) => ({ id, capabilities }));
  }

  async checkHealth(): Promise<ProviderHealth> {
    if (!this.isConfigured()) {
      return { provider: this.id, configured: false, healthy: false, detail: "ANTHROPIC_API_KEY not set", checkedAt: new Date().toISOString() };
    }
    try {
      const res = await request(`${API_BASE}/models`, {
        method: "GET",
        headers: { "x-api-key": env.ANTHROPIC_API_KEY!, "anthropic-version": ANTHROPIC_VERSION },
      });
      const healthy = res.statusCode < 500;
      await res.body.dump();
      return { provider: this.id, configured: true, healthy, checkedAt: new Date().toISOString() };
    } catch (err) {
      return { provider: this.id, configured: true, healthy: false, detail: (err as Error).message, checkedAt: new Date().toISOString() };
    }
  }

  private buildBody(req: ChatRequest, stream: boolean) {
    return {
      model: req.model,
      system: req.systemPrompt,
      messages: toAnthropicMessages(req),
      max_tokens: req.maxOutputTokens ?? 4096,
      temperature: req.temperature,
      stream,
      tools: req.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
    };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (!this.isConfigured()) throw new ProviderError("Anthropic is not configured (missing ANTHROPIC_API_KEY).", false);

    return withRetry(
      async () => {
        const res = await request(`${API_BASE}/messages`, {
          method: "POST",
          headers: {
            "x-api-key": env.ANTHROPIC_API_KEY!,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
          },
          body: JSON.stringify(this.buildBody(req, false)),
          signal: req.signal,
        });

        const body = (await res.body.json()) as Record<string, unknown>;

        if (res.statusCode === 429) {
          throw new RateLimitError("Anthropic rate limit exceeded.");
        }
        if (res.statusCode >= 400) {
          const message = (body?.error as Record<string, unknown>)?.message ?? JSON.stringify(body);
          throw new ProviderError(`Anthropic error (${res.statusCode}): ${message}`, res.statusCode >= 500);
        }

        const { text, toolCalls } = fromAnthropicContent((body.content as Array<Record<string, unknown>>) ?? []);
        const usage = (body.usage as Record<string, number>) ?? {};
        const stopReason = String(body.stop_reason ?? "end_turn");

        return {
          content: text,
          toolCalls,
          finishReason: stopReason === "tool_use" ? "tool_calls" : stopReason === "max_tokens" ? "length" : "stop",
          usage: { promptTokens: usage.input_tokens ?? 0, completionTokens: usage.output_tokens ?? 0 },
          model: req.model,
          provider: this.id,
        } satisfies ChatResponse;
      },
      { signal: req.signal },
    );
  }

  async *chatStream(req: ChatRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
    if (!this.isConfigured()) {
      yield { type: "error", message: "Anthropic is not configured (missing ANTHROPIC_API_KEY).", recoverable: false };
      return;
    }

    let res;
    try {
      res = await request(`${API_BASE}/messages`, {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY!,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify(this.buildBody(req, true)),
        signal: req.signal,
      });
    } catch (err) {
      yield { type: "error", message: (err as Error).message, recoverable: true };
      return;
    }

    if (res.statusCode >= 400) {
      const body = await res.body.text();
      yield { type: "error", message: `Anthropic error (${res.statusCode}): ${body}`, recoverable: res.statusCode >= 500 };
      return;
    }

    let fullText = "";
    const toolCallsById = new Map<string, ToolCallRequest & { argsBuffer: string }>();
    const usage: { promptTokens: number; completionTokens: number } = { promptTokens: 0, completionTokens: 0 };
    let stopReason = "end_turn";

    let buffer = "";
    for await (const chunk of res.body) {
      buffer += Buffer.from(chunk).toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice("data: ".length).trim();
        if (!payload) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }

        if (event.type === "content_block_start") {
          const block = event.content_block as Record<string, unknown>;
          if (block?.type === "tool_use") {
            toolCallsById.set(String(block.id), {
              id: String(block.id),
              name: String(block.name),
              arguments: {},
              argsBuffer: "",
            });
          }
        } else if (event.type === "content_block_delta") {
          const delta = event.delta as Record<string, unknown>;
          if (delta?.type === "text_delta") {
            fullText += String(delta.text ?? "");
            yield { type: "text_delta", delta: String(delta.text ?? "") };
          } else if (delta?.type === "input_json_delta") {
            const idx = event.index as number;
            const entry = [...toolCallsById.values()][idx];
            if (entry) {
              entry.argsBuffer += String(delta.partial_json ?? "");
              yield { type: "tool_call_delta", id: entry.id, argumentsDelta: String(delta.partial_json ?? "") };
            }
          }
        } else if (event.type === "message_delta") {
          const d = event.delta as Record<string, unknown>;
          if (d?.stop_reason) stopReason = String(d.stop_reason);
          const u = event.usage as Record<string, number> | undefined;
          if (u) usage.completionTokens = u.output_tokens ?? usage.completionTokens;
        } else if (event.type === "message_start") {
          const u = (event.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
          if (u) usage.promptTokens = u.input_tokens ?? 0;
        }
      }
    }

    const toolCalls: ToolCallRequest[] = [...toolCallsById.values()].map((t) => {
      let args: Record<string, unknown> = {};
      try {
        args = t.argsBuffer ? JSON.parse(t.argsBuffer) : {};
      } catch {
        args = {};
      }
      return { id: t.id, name: t.name, arguments: args };
    });

    const response: ChatResponse = {
      content: fullText,
      toolCalls,
      finishReason: stopReason === "tool_use" ? "tool_calls" : stopReason === "max_tokens" ? "length" : "stop",
      usage,
      model: req.model,
      provider: this.id,
    };
    yield { type: "usage", usage };
    yield { type: "done", response };
  }
}
