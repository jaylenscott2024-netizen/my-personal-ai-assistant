import type { ChatMessage, ChatRequest, ChatVisualContext, ModelCapabilities, VisionTransportStrategy, VisualContextImage } from "../../ai/types.js";
import type { VisualContext } from "../visualContext.js";
import { relativeLabel } from "../visualContext.js";
import type { VisualSample } from "../visualStream.js";

// Section 6: the seam that keeps "how Jarvis sees" apart from "how this
// particular API accepts being shown things."
//
// THE EYES ENGINE MUST NOT KNOW HOW OPENAI, CLAUDE, OR GEMINI ACCEPT
// VISION. It produces one provider-neutral VisualContext. An adapter —
// selected by provider id, constrained by declared ModelCapabilities —
// turns that into a request shape its provider actually accepts. Adding a
// fourth provider (or a local vision model) means writing one adapter and
// one capability declaration, not touching perception at all.
export interface VisionTransportInput {
  visualContext: VisualContext;
  request: ChatRequest;
  capabilities: ModelCapabilities;
  /** Identifies the (user, provider, model) whose live visual session this
   *  turn belongs to. Only realtime-capable adapters use it; absent means
   *  "no realtime session may be opened for this call". */
  sessionKey?: string;
  signal?: AbortSignal;
}

export interface VisionTransportAdapter {
  readonly id: string;
  /** Whether this adapter can serve a model with these capabilities. */
  canHandle(capabilities: ModelCapabilities): boolean;
  /** Which transport it would actually use for them. */
  getStrategy(capabilities: ModelCapabilities): VisionTransportStrategy;
  /** Returns a NEW ChatRequest carrying the visual context in this
   *  provider's shape. Never mutates the input request. */
  sendVisualContext(input: VisionTransportInput): Promise<ChatRequest>;
}

/** Frames from the context, newest-relative labels attached, capped. */
export function toVisualContextImages(
  context: VisualContext,
  maxImages: number,
  now = context.requestedAtMs,
): VisualContextImage[] {
  const framed = context.samples.filter((sample): sample is VisualSample & { frame: NonNullable<VisualSample["frame"]> } => sample.frame !== null);
  // Keep the most recent `maxImages`, still chronologically ordered — a
  // sequence a model can reason across only works if it's in order.
  const selected = framed.slice(Math.max(0, framed.length - maxImages));
  return selected.map((sample) => ({
    mimeType: sample.frame.mimeType,
    base64: sample.frame.base64,
    label: `${relativeLabel(sample.atMs, now)} — ${sample.summary}`,
    capturedAtMs: sample.atMs,
  }));
}

// Attaches the built payload to the request's last user/tool message, or
// appends a fresh user message when there's nowhere natural to put it.
// Provider-neutral: each provider's own message converter decides how a
// ChatVisualContext is rendered on the wire.
export function attachVisualContext(request: ChatRequest, visualContext: ChatVisualContext): ChatRequest {
  const messages = [...request.messages];
  const lastIndex = messages.length - 1;
  const last = lastIndex >= 0 ? messages[lastIndex] : undefined;

  if (last && (last.role === "tool" || last.role === "user")) {
    messages[lastIndex] = { ...last, visualContext };
    return { ...request, messages };
  }

  const carrier: ChatMessage = {
    role: "user",
    content: visualContext.temporalSummary ?? "Current visual context from Jarvis Eyes.",
    untrusted: true,
    visualContext,
  };
  return { ...request, messages: [...messages, carrier] };
}
