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

const API_BASE = "https://api.openai.com/v1";

const MODEL_CAPS: Record<string, ModelCapabilities> = {
  "gpt-4o": cap(true, 128_000),
  "gpt-4o-mini": cap(true, 128_000),
  "gpt-4-turbo": cap(true, 128_000),
};

function cap(vision: boolean, ctx: number): ModelCapabilities {
  return {
    text: true,
    vision,
    audio: false,
    streaming: true,
    toolCalling: true,
    structuredOutput: true,
    reasoning: false,
    longContext: ctx >= 100_000,
    contextWindowTokens: ctx,
  };
}

function defaultCaps(): ModelCapabilities {
  return cap(false, 128_000);
}

export function toOpenAIMessages(req: ChatRequest) {
  const messages: Array<Record<string, unknown>> = [];
  if (req.systemPrompt) messages.push({ role: "system", content: req.systemPrompt });

  for (const m of req.messages) {
    if (m.role === "system") {
      messages.push({ role: "system", content: m.content });
    } else if (m.role === "tool") {
      // OpenAI's chat.completions "tool" role message content must be a
      // plain string — image content parts are only valid on user/system
      // messages. So an image attached to a tool result (e.g. an on-demand
      // Eyes frame) rides in a synthetic follow-up user message instead of
      // being dropped or sent in a shape the API would reject.
      messages.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
      if (m.images?.length) {
        messages.push({
          role: "user",
          content: [
            { type: "text", text: "Image attached to the preceding tool result:" },
            ...m.images.map((img) => ({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.base64}` } })),
          ],
        });
      }
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      messages.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      });
    } else {
      const text = m.untrusted ? `<external_content trust="untrusted">\n${m.content}\n</external_content>` : m.content;
      if (m.images?.length) {
        messages.push({
          role: m.role,
          content: [{ type: "text", text }, ...m.images.map((img) => ({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.base64}` } }))],
        });
      } else {
        messages.push({ role: m.role, content: text });
      }
    }
  }
  return messages;
}

export class OpenAIProvider implements AIProvider {
  readonly id = "openai";
  readonly displayName = "OpenAI";

  isConfigured(): boolean {
    return Boolean(env.OPENAI_API_KEY);
  }

  getCapabilities(model: string): ModelCapabilities {
    return MODEL_CAPS[model] ?? defaultCaps();
  }

  listModels() {
    return Object.entries(MODEL_CAPS).map(([id, capabilities]) => ({ id, capabilities }));
  }

  async checkHealth(): Promise<ProviderHealth> {
    if (!this.isConfigured()) {
      return { provider: this.id, configured: false, healthy: false, detail: "OPENAI_API_KEY not set", checkedAt: new Date().toISOString() };
    }
    try {
      const res = await request(`${API_BASE}/models`, {
        method: "GET",
        headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
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
      messages: toOpenAIMessages(req),
      max_tokens: req.maxOutputTokens,
      temperature: req.temperature,
      stream,
      tools: req.tools?.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
      response_format: req.responseSchema
        ? { type: "json_schema", json_schema: { name: "response", schema: req.responseSchema, strict: true } }
        : undefined,
    };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (!this.isConfigured()) throw new ProviderError("OpenAI is not configured (missing OPENAI_API_KEY).", false);

    return withRetry(
      async () => {
        const res = await request(`${API_BASE}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
          body: JSON.stringify(this.buildBody(req, false)),
          signal: req.signal,
        });

        const body = (await res.body.json()) as Record<string, unknown>;

        if (res.statusCode === 429) throw new RateLimitError("OpenAI rate limit exceeded.");
        if (res.statusCode >= 400) {
          const message = (body?.error as Record<string, unknown>)?.message ?? JSON.stringify(body);
          throw new ProviderError(`OpenAI error (${res.statusCode}): ${message}`, res.statusCode >= 500);
        }

        const choice = (body.choices as Array<Record<string, unknown>>)?.[0];
        const message = (choice?.message ?? {}) as Record<string, unknown>;
        const toolCalls: ToolCallRequest[] = ((message.tool_calls as Array<Record<string, unknown>>) ?? []).map((tc) => {
          const fn = tc.function as Record<string, unknown>;
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(String(fn.arguments ?? "{}"));
          } catch {
            args = {};
          }
          return { id: String(tc.id), name: String(fn.name), arguments: args };
        });

        const usage = (body.usage as Record<string, number>) ?? {};
        const finishReason = String(choice?.finish_reason ?? "stop");

        return {
          content: String(message.content ?? ""),
          toolCalls,
          finishReason: finishReason === "tool_calls" ? "tool_calls" : finishReason === "length" ? "length" : "stop",
          usage: { promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0 },
          model: req.model,
          provider: this.id,
        } satisfies ChatResponse;
      },
      { signal: req.signal },
    );
  }

  async *chatStream(req: ChatRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
    if (!this.isConfigured()) {
      yield { type: "error", message: "OpenAI is not configured (missing OPENAI_API_KEY).", recoverable: false };
      return;
    }

    let res;
    try {
      res = await request(`${API_BASE}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify(this.buildBody(req, true)),
        signal: req.signal,
      });
    } catch (err) {
      yield { type: "error", message: (err as Error).message, recoverable: true };
      return;
    }

    if (res.statusCode >= 400) {
      const body = await res.body.text();
      yield { type: "error", message: `OpenAI error (${res.statusCode}): ${body}`, recoverable: res.statusCode >= 500 };
      return;
    }

    let fullText = "";
    const toolCallsByIndex = new Map<number, ToolCallRequest & { argsBuffer: string }>();
    let finishReason = "stop";
    let buffer = "";

    for await (const chunk of res.body) {
      buffer += Buffer.from(chunk).toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice("data: ".length).trim();
        if (!payload || payload === "[DONE]") continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }
        const choice = (event.choices as Array<Record<string, unknown>>)?.[0];
        if (!choice) continue;
        const delta = (choice.delta ?? {}) as Record<string, unknown>;
        if (choice.finish_reason) finishReason = String(choice.finish_reason);

        if (typeof delta.content === "string" && delta.content) {
          fullText += delta.content;
          yield { type: "text_delta", delta: delta.content };
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
            const idx = Number(tc.index ?? 0);
            const fn = (tc.function ?? {}) as Record<string, unknown>;
            const existing = toolCallsByIndex.get(idx) ?? { id: String(tc.id ?? idx), name: "", arguments: {}, argsBuffer: "" };
            if (fn.name) existing.name = String(fn.name);
            if (typeof fn.arguments === "string") existing.argsBuffer += fn.arguments;
            toolCallsByIndex.set(idx, existing);
            yield { type: "tool_call_delta", id: existing.id, name: fn.name ? String(fn.name) : undefined, argumentsDelta: typeof fn.arguments === "string" ? fn.arguments : undefined };
          }
        }
      }
    }

    const toolCalls: ToolCallRequest[] = [...toolCallsByIndex.values()].map((t) => {
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
      finishReason: finishReason === "tool_calls" ? "tool_calls" : finishReason === "length" ? "length" : "stop",
      usage: { promptTokens: 0, completionTokens: 0 },
      model: req.model,
      provider: this.id,
    };
    yield { type: "done", response };
  }
}
