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
// UNVERIFIED AGAINST THE LIVE API: this is written to Google's documented
// Live API message shapes (`setup` → `setupComplete`, then `realtimeInput`
// media chunks), but this environment has no Gemini API key and no
// outbound access to that endpoint, so it has never completed a real
// session. Treat it as reviewed, standards-based code — not as a verified
// integration. Everything *around* it (negotiation, pacing, coalescing,
// fallback to the still-image transport) is fully unit-tested with a fake
// sink and does not depend on this class working.
//
// Note on rate: the Live API does not advertise an accepted frame rate in
// its setup response, so `serverAcceptedFps` is left unset and the
// negotiated rate comes from the model's declared ceiling
// (GEMINI_REALTIME_VISUAL_FPS). If a future API surface does advertise
// one, pass it to negotiateRealtimeVisual() and it wins downward.
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
    this.socket!.send(
      JSON.stringify({
        realtimeInput: {
          mediaChunks: [{ mimeType: sample.frame.mimeType, data: sample.frame.base64 }],
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
