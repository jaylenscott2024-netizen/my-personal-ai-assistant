import WebSocket from "ws";
import { env } from "../../config/env.js";
import { childLogger } from "../../config/logger.js";
import { NotConfiguredError, ProviderError } from "../../utils/errors.js";
import type { VisualSample } from "../visualStream.js";
import type { RealtimeVisualNegotiation, RealtimeVisualSink } from "./realtimeVisualTransport.js";

const log = childLogger("eyes.transport.geminiLive");

const LIVE_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const SETUP_TIMEOUT_MS = 10_000;

// Gemini Live (BidiGenerateContent) as a RealtimeVisualSink.
//
// UNVERIFIED AGAINST THE LIVE API: this environment has no Gemini API key
// and its egress proxy blocks ai.google.dev, so this has never completed
// a real session — a web search (not a live doc fetch, which was blocked)
// was used to re-check the message shapes below, so treat this as
// reviewed-against-secondary-sources, not confirmed against the primary
// reference. Everything *around* this class (negotiation, pacing,
// coalescing, fallback to the still-image transport) is fully unit-tested
// with a fake sink and does not depend on this class working.
//
// Message shapes, and confidence in each:
//  - Endpoint + `?key=` query auth, and the `setup` → `setupComplete`
//    handshake being mandatory before any other message: corroborated by
//    multiple independent sources, high confidence.
//  - `setup.model` as `models/<id>`: same, high confidence.
//  - A single video/image frame goes in `realtimeInput.video: {mimeType,
//    data}` — a dedicated typed field, NOT the older `realtimeInput.
//    mediaChunks` array this file previously (incorrectly) used for
//    frames. `mediaChunks` still appears in some audio examples; audio
//    is not this sink's concern, so it isn't touched here. Moderate-high
//    confidence — corroborated by two independent secondary sources, but
//    not the primary reference page (blocked).
//  - Video is documented as processed at a hard ceiling of 1 fps
//    regardless of what's sent faster than that — matches this codebase's
//    own default (`GEMINI_REALTIME_VISUAL_FPS=1`) with no change needed.
//  - API version segment (`v1beta` here vs. `v1alpha` seen in one older
//    example) and the exact `generationConfig.responseModalities` shape
//    are the lowest-confidence details in this file — left as-is rather
//    than "corrected" on ambiguous secondary evidence.
//
// Bottom line: this is a good-faith, partially re-verified best effort,
// not a confirmed integration. Validate against a real API key and the
// primary reference (https://ai.google.dev/api/live) before relying on it.
export class GeminiLiveVisualSink implements RealtimeVisualSink {
  readonly id = "gemini-live";
  private socket: WebSocket | null = null;
  private setupComplete = false;

  get isOpen(): boolean {
    return this.setupComplete && this.socket?.readyState === WebSocket.OPEN;
  }

  async open(negotiation: RealtimeVisualNegotiation): Promise<void> {
    if (!env.GEMINI_API_KEY) {
      throw new NotConfiguredError("Gemini Live visual streaming (GEMINI_API_KEY)");
    }

    const socket = new WebSocket(`${LIVE_ENDPOINT}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new ProviderError("Gemini Live session did not complete setup in time.", true));
      }, SETUP_TIMEOUT_MS);

      const finish = (err?: Error) => {
        clearTimeout(timer);
        socket.off("message", onMessage);
        socket.off("error", onError);
        if (err) reject(err);
        else resolve();
      };

      const onMessage = (raw: WebSocket.RawData) => {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        } catch {
          return; // non-JSON frame — ignore rather than tear down the session
        }
        if ("setupComplete" in parsed) {
          this.setupComplete = true;
          finish();
        }
      };

      const onError = (err: Error) => finish(err);

      socket.once("open", () => {
        socket.send(
          JSON.stringify({
            setup: {
              model: `models/${negotiation.model}`,
              generationConfig: { responseModalities: ["TEXT"] },
            },
          }),
        );
      });
      socket.on("message", onMessage);
      socket.on("error", onError);
    });

    socket.on("close", () => {
      this.setupComplete = false;
    });
    // Never log frame payloads — only that a message arrived.
    socket.on("error", (err) => log.warn({ err }, "Gemini Live socket error"));
  }

  async sendFrame(sample: VisualSample): Promise<void> {
    if (!this.isOpen || !sample.frame) return;
    // A single video/image frame is its own typed field, not an entry in
    // the generic `mediaChunks` array (that shape is documented for audio,
    // not confirmed for video — see the class-level note above).
    this.socket!.send(
      JSON.stringify({
        realtimeInput: {
          video: { mimeType: sample.frame.mimeType, data: sample.frame.base64 },
        },
      }),
    );
  }

  async close(): Promise<void> {
    this.setupComplete = false;
    this.socket?.close();
    this.socket = null;
  }
}

export function geminiLiveSinkFactory(): RealtimeVisualSink {
  return new GeminiLiveVisualSink();
}
