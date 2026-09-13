import { request } from "undici";
import { env } from "../../config/env.js";
import { ProviderError, RateLimitError } from "../../utils/errors.js";
import { withRetry } from "../retry.js";
import type {
  AIProvider,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  ModelCapabilities,
  ProviderHealth,
  ToolCallRequest,
  VisionCapabilities,
} from "../types.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

const MODEL_CAPS: Record<string, ModelCapabilities> = {
  "gemini-2.0-flash": cap(1_000_000, "gemini-2.0-flash"),
  "gemini-1.5-pro": cap(2_000_000, "gemini-1.5-pro"),
  "gemini-1.5-flash": cap(1_000_000, "gemini-1.5-flash"),
};

// Gemini is the one provider here whose visual input is NOT limited to
// still images: the standard generateContent endpoint takes video inline
// and via the Files API, and the Live (BidiGenerateContent) endpoint takes
// a genuine realtime visual stream — but only on the models that actually
// serve it. That last part is the trap this function exists to avoid:
// "Gemini" is not one capability set, so the Live transport is offered
// only for models whose id identifies them as Live models, and the real
// frame rate is negotiated at session setup rather than assumed here.
export function isGeminiLiveModel(model: string): boolean {
  return /(?:^|[-_.])live(?:[-_.]|$)/i.test(model) || /flash-exp/i.test(model);
}

function geminiVisionFor(model: string): VisionCapabilities {
  const standard: VisionCapabilities = {
    imageInput: true,
    videoInput: true,
    realtimeVision: false,
    realtimeAudio: false,
    temporalImageContext: true,
    videoUpload: true,
    // A declared ceiling, not a universal truth: Gemini's documented
    // default video sampling is 1 fps, and an operator whose model/tier
    // allows more raises GEMINI_VIDEO_FPS rather than editing code.
    maxVideoFps: env.GEMINI_VIDEO_FPS,
    maxImagesPerRequest: 16,
    preferredImageFormat: "image/png",
    preferredVideoFormat: "video/mp4",
  };

  if (!isGeminiLiveModel(model)) return standard;
  return {
    ...standard,
    realtimeVision: true,
    realtimeAudio: true,
    // Same reasoning: a configurable declared ceiling. The live session
    // negotiates the effective rate at setup and takes the lower of the
    // two (see eyes/transport/geminiRealtimeVisualTransport.ts).
    maxRealtimeVisualFps: env.GEMINI_REALTIME_VISUAL_FPS,
  };
}

function cap(ctx: number, model: string): ModelCapabilities {
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
    visionCapabilities: geminiVisionFor(model),
  };
}

function defaultCaps(model: string): ModelCapabilities {
  return cap(1_000_000, model);
}

// Gemini's generateContent API uses `contents` with roles "user"/"model"
// and represents tool results as `functionResponse` parts and tool
// requests as `functionCall` parts.
export function toGeminiContents(req: ChatRequest) {
  const contents: Array<Record<string, unknown>> = [];
  for (const m of req.messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      // Gemini allows additional parts (like inlineData) alongside a
      // functionResponse part in the same "user"-role content entry, so an
      // image attached to a tool result (e.g. an on-demand Eyes frame)
      // rides in the same turn rather than needing a synthetic message.
      const parts: unknown[] = [{ functionResponse: { name: m.toolCallId, response: { content: m.content } } }, ...visualPartsOf(m)];
      contents.push({ role: "user", parts });
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
    contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text }, ...visualPartsOf(m)] });
  }
  return contents;
}

// Gemini takes visual data as inlineData parts alongside text in the same
// turn. A realtime_stream payload deliberately contributes no inlineData:
// those frames already went over the live session, and re-embedding them
// here would send the same imagery twice.
function visualPartsOf(message: ChatMessage): unknown[] {
  const parts: unknown[] = [];
  const summary = message.visualContext?.temporalSummary;
  if (summary) parts.push({ text: summary });

  const images = message.visualContext?.images ?? message.images ?? [];
  for (const image of images) {
    const label = "label" in image ? image.label : undefined;
    if (label) parts.push({ text: label });
    parts.push({ inlineData: { mimeType: image.mimeType, data: image.base64 } });
  }
  return parts;
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
    return MODEL_CAPS[model] ?? defaultCaps(model);
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
