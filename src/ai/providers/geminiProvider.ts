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

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

const MODEL_CAPS: Record<string, ModelCapabilities> = {
  "gemini-2.0-flash": cap(1_000_000),
  "gemini-1.5-pro": cap(2_000_000),
  "gemini-1.5-flash": cap(1_000_000),
};

function cap(ctx: number): ModelCapabilities {
  return {
    text: true,
    vision: true,
    audio: true,
    streaming: true,
    toolCalling: true,
    structuredOutput: true,
    reasoning: false,
    longContext: true,
    contextWindowTokens: ctx,
  };
}

function defaultCaps(): ModelCapabilities {
  return cap(1_000_000);
}

// Gemini's generateContent API uses `contents` with roles "user"/"model"
// and represents tool results as `functionResponse` parts and tool
// requests as `functionCall` parts.
function toGeminiContents(req: ChatRequest) {
  const contents: Array<Record<string, unknown>> = [];
  for (const m of req.messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name: m.toolCallId, response: { content: m.content } } }],
      });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      const parts: unknown[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const call of m.toolCalls) {
        parts.push({ functionCall: { name: call.name, args: call.arguments } });
      }
      contents.push({ role: "model", parts });
      continue;
    }
    const text = m.untrusted ? `<external_content trust="untrusted">\n${m.content}\n</external_content>` : m.content;
    contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text }] });
  }
  return contents;
}

function stripJsonSchemaMeta(schema: Record<string, unknown>): Record<string, unknown> {
  // Gemini's function-declaration schema is a strict subset of JSON Schema
  // and rejects unknown keywords like $schema/additionalProperties.
  const { $schema, additionalProperties, ...rest } = schema as Record<string, unknown>;
  void $schema;
  void additionalProperties;
  if (rest.properties && typeof rest.properties === "object") {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest.properties as Record<string, unknown>)) {
      props[k] = typeof v === "object" && v !== null ? stripJsonSchemaMeta(v as Record<string, unknown>) : v;
    }
    rest.properties = props;
  }
  return rest;
}

export class GeminiProvider implements AIProvider {
  readonly id = "gemini";
  readonly displayName = "Google Gemini";

  isConfigured(): boolean {
    return Boolean(env.GEMINI_API_KEY);
  }

  getCapabilities(model: string): ModelCapabilities {
    return MODEL_CAPS[model] ?? defaultCaps();
  }

  listModels() {
    return Object.entries(MODEL_CAPS).map(([id, capabilities]) => ({ id, capabilities }));
  }

  async checkHealth(): Promise<ProviderHealth> {
    if (!this.isConfigured()) {
      return { provider: this.id, configured: false, healthy: false, detail: "GEMINI_API_KEY not set", checkedAt: new Date().toISOString() };
    }
    try {
      const res = await request(`${API_BASE}/models?key=${env.GEMINI_API_KEY}`, { method: "GET" });
      const healthy = res.statusCode < 500;
      await res.body.dump();
      return { provider: this.id, configured: true, healthy, checkedAt: new Date().toISOString() };
    } catch (err) {
      return { provider: this.id, configured: true, healthy: false, detail: (err as Error).message, checkedAt: new Date().toISOString() };
    }
  }

  private buildBody(req: ChatRequest) {
    return {
      systemInstruction: req.systemPrompt ? { parts: [{ text: req.systemPrompt }] } : undefined,
      contents: toGeminiContents(req),
      generationConfig: {
        maxOutputTokens: req.maxOutputTokens,
        temperature: req.temperature,
        responseMimeType: req.responseSchema ? "application/json" : undefined,
        responseSchema: req.responseSchema ? stripJsonSchemaMeta(req.responseSchema) : undefined,
      },
      tools: req.tools?.length
        ? [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: stripJsonSchemaMeta(t.inputSchema) })) }]
        : undefined,
    };
  }

  private parseCandidate(body: Record<string, unknown>): { text: string; toolCalls: ToolCallRequest[]; finishReason: string } {
    const candidate = (body.candidates as Array<Record<string, unknown>>)?.[0];
    const parts = ((candidate?.content as Record<string, unknown>)?.parts as Array<Record<string, unknown>>) ?? [];
    let text = "";
    const toolCalls: ToolCallRequest[] = [];
    let idx = 0;
    for (const part of parts) {
      if (typeof part.text === "string") text += part.text;
      if (part.functionCall) {
        const fc = part.functionCall as Record<string, unknown>;
        toolCalls.push({ id: `${fc.name}-${idx++}`, name: String(fc.name), arguments: (fc.args as Record<string, unknown>) ?? {} });
      }
    }
    return { text, toolCalls, finishReason: String(candidate?.finishReason ?? "STOP") };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (!this.isConfigured()) throw new ProviderError("Gemini is not configured (missing GEMINI_API_KEY).", false);

    return withRetry(
      async () => {
        const res = await request(`${API_BASE}/models/${req.model}:generateContent?key=${env.GEMINI_API_KEY}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(this.buildBody(req)),
          signal: req.signal,
        });

        const body = (await res.body.json()) as Record<string, unknown>;

        if (res.statusCode === 429) throw new RateLimitError("Gemini rate limit exceeded.");
        if (res.statusCode >= 400) {
          const message = (body?.error as Record<string, unknown>)?.message ?? JSON.stringify(body);
          throw new ProviderError(`Gemini error (${res.statusCode}): ${message}`, res.statusCode >= 500);
        }

        const { text, toolCalls, finishReason } = this.parseCandidate(body);
        const usage = (body.usageMetadata as Record<string, number>) ?? {};

        return {
          content: text,
          toolCalls,
          finishReason: toolCalls.length ? "tool_calls" : finishReason === "MAX_TOKENS" ? "length" : "stop",
          usage: { promptTokens: usage.promptTokenCount ?? 0, completionTokens: usage.candidatesTokenCount ?? 0 },
          model: req.model,
          provider: this.id,
        } satisfies ChatResponse;
      },
      { signal: req.signal },
    );
  }

  async *chatStream(req: ChatRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
    if (!this.isConfigured()) {
      yield { type: "error", message: "Gemini is not configured (missing GEMINI_API_KEY).", recoverable: false };
      return;
    }

    let res;
    try {
      res = await request(`${API_BASE}/models/${req.model}:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(this.buildBody(req)),
        signal: req.signal,
      });
    } catch (err) {
      yield { type: "error", message: (err as Error).message, recoverable: true };
      return;
    }

    if (res.statusCode >= 400) {
      const body = await res.body.text();
      yield { type: "error", message: `Gemini error (${res.statusCode}): ${body}`, recoverable: res.statusCode >= 500 };
      return;
    }

    let fullText = "";
    const toolCalls: ToolCallRequest[] = [];
    let finishReason = "STOP";
    let usage = { promptTokens: 0, completionTokens: 0 };
    let buffer = "";
    let toolIdx = 0;

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
        const parsed = this.parseCandidate(event);
        if (parsed.text) {
          fullText += parsed.text;
          yield { type: "text_delta", delta: parsed.text };
        }
        for (const tc of parsed.toolCalls) {
          const withId = { ...tc, id: `${tc.name}-${toolIdx++}` };
          toolCalls.push(withId);
          yield { type: "tool_call_delta", id: withId.id, name: withId.name, argumentsDelta: JSON.stringify(withId.arguments) };
        }
        finishReason = parsed.finishReason;
        const u = event.usageMetadata as Record<string, number> | undefined;
        if (u) usage = { promptTokens: u.promptTokenCount ?? 0, completionTokens: u.candidatesTokenCount ?? 0 };
      }
    }

    const response: ChatResponse = {
      content: fullText,
      toolCalls,
      finishReason: toolCalls.length ? "tool_calls" : finishReason === "MAX_TOKENS" ? "length" : "stop",
      usage,
      model: req.model,
      provider: this.id,
    };
    yield { type: "usage", usage };
    yield { type: "done", response };
  }
}
