import { describe, it, expect, beforeAll } from "vitest";
import { registerUser } from "../src/auth/authService.js";
import { createConversation } from "../src/conversation/conversationService.js";
import { registerBuiltinTools } from "../src/tools/builtinIndex.js";
import { RealtimeVoiceSession, type RealtimeVoiceState } from "../src/voice/realtimeSession.js";
import { __registerVoiceProviderForTesting } from "../src/voice/voiceRegistry.js";
import type { SynthesisOptions, TranscribeOptions, TranscriptionResult, VoiceInfo, VoiceProvider } from "../src/voice/types.js";

beforeAll(() => {
  registerBuiltinTools();
});

// A fully deterministic, no-network voice provider double: STT always
// returns a fixed transcript, TTS streams a fixed number of small chunks
// with a tiny artificial delay so tests can observe "speaking" mid-stream
// and exercise interruption before it finishes.
class FakeVoiceProvider implements VoiceProvider {
  readonly id = "fake-voice";
  transcriptToReturn = "what time is it";
  chunkDelayMs = 5;
  chunksPerSentence = 4;
  synthesizeCalls: string[] = [];

  async isConfigured(): Promise<boolean> {
    return true;
  }

  async transcribe(_audio: Buffer, _mimeType: string, _opts?: TranscribeOptions): Promise<TranscriptionResult> {
    return { text: this.transcriptToReturn };
  }

  async synthesize(text: string): Promise<{ audio: Buffer; mimeType: string }> {
    this.synthesizeCalls.push(text);
    return { audio: Buffer.from("fake-audio"), mimeType: "audio/mpeg" };
  }

  async *synthesizeStream(text: string, opts?: SynthesisOptions): AsyncGenerator<Buffer, void, unknown> {
    this.synthesizeCalls.push(text);
    for (let i = 0; i < this.chunksPerSentence; i++) {
      if (opts?.signal?.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, this.chunkDelayMs));
      if (opts?.signal?.aborted) return;
      yield Buffer.from(`chunk-${i}`);
    }
  }

  async listVoices(): Promise<VoiceInfo[]> {
    return [];
  }
}

async function makeUserAndConversation() {
  const email = `voice-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { user } = await registerUser(email, "a-strong-password");
  const conversation = await createConversation(user.id, "voice-test", "mock", "mock-1");
  return { userId: user.id, role: "owner" as const, conversationId: conversation.id };
}

function makeUtteranceOnset(): Buffer {
  // Just enough sustained energy to trip speech_start, with no trailing
  // silence yet — the utterance is still "open" after this.
  const quiet = new Int16Array(320 * 3).fill(50);
  const loud = new Int16Array(320 * 8).fill(3000);
  const combined = new Int16Array(quiet.length + loud.length);
  combined.set(quiet, 0);
  combined.set(loud, quiet.length);
  return Buffer.from(combined.buffer);
}

function makeTrailingSilence(): Buffer {
  return Buffer.from(new Int16Array(320 * 40).fill(50).buffer); // ~800ms > default 700ms silenceMsToEnd
}

function makeSyntheticUtterance(): Buffer {
  // 16kHz PCM16: a short burst of "loud" samples framed by silence, shaped
  // to reliably trip the default VAD thresholds in one process() call.
  return Buffer.concat([makeUtteranceOnset(), makeTrailingSilence()]);
}

describe("RealtimeVoiceSession", () => {
  it("carries a spoken utterance through STT -> agent -> streaming TTS audio out", async () => {
    const fakeVoice = new FakeVoiceProvider();
    fakeVoice.transcriptToReturn = "Tell me something interesting.";
    __registerVoiceProviderForTesting(fakeVoice);

    const { userId, role, conversationId } = await makeUserAndConversation();

    const states: RealtimeVoiceState[] = [];
    const audioChunks: Buffer[] = [];
    const transcripts: string[] = [];
    let assistantText = "";
    let doneResolve: () => void;
    const done = new Promise<void>((resolve) => (doneResolve = resolve));

    const session = new RealtimeVoiceSession({
      userId,
      role,
      conversationId,
      aiProviderId: "mock",
      aiModel: "mock-1",
      voiceProviderId: "fake-voice",
      sttProviderId: "fake-voice",
      onAudioChunk: (chunk) => audioChunks.push(chunk),
      onTranscript: (text) => transcripts.push(text),
      onAssistantText: (text) => {
        assistantText = text;
        doneResolve();
      },
      onStateChange: (state) => states.push(state),
      onError: (message) => {
        throw new Error(`Unexpected voice session error: ${message}`);
      },
    });

    session.feedAudio(makeSyntheticUtterance());
    await done;

    expect(transcripts).toEqual(["Tell me something interesting."]);
    expect(assistantText.length).toBeGreaterThan(0);
    expect(audioChunks.length).toBeGreaterThan(0);
    expect(states).toContain("listening");
    expect(states).toContain("thinking");
    expect(states).toContain("speaking");
    // Ends back in listening, ready for the next utterance.
    expect(states[states.length - 1]).toBe("listening");
  });

  it("does not call the agent at all for audio that transcribes to silence", async () => {
    const fakeVoice = new FakeVoiceProvider();
    fakeVoice.transcriptToReturn = "   "; // whitespace-only "transcript"
    __registerVoiceProviderForTesting(fakeVoice);

    const { userId, role, conversationId } = await makeUserAndConversation();
    let assistantCalled = false;

    const session = new RealtimeVoiceSession({
      userId,
      role,
      conversationId,
      aiProviderId: "mock",
      aiModel: "mock-1",
      voiceProviderId: "fake-voice",
      sttProviderId: "fake-voice",
      onAudioChunk: () => {},
      onTranscript: () => {},
      onAssistantText: () => {
        assistantCalled = true;
      },
      onStateChange: () => {},
      onError: (message) => {
        throw new Error(message);
      },
    });

    session.feedAudio(makeSyntheticUtterance());
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(assistantCalled).toBe(false);
    expect(session.getState()).toBe("listening");
  });

  it("barge-in: interrupting mid-speech stops further audio and returns to listening", async () => {
    const fakeVoice = new FakeVoiceProvider();
    fakeVoice.transcriptToReturn = "Tell me something interesting.";
    fakeVoice.chunkDelayMs = 20;
    fakeVoice.chunksPerSentence = 20; // long enough to reliably interrupt mid-stream
    __registerVoiceProviderForTesting(fakeVoice);

    const { userId, role, conversationId } = await makeUserAndConversation();
    const states: RealtimeVoiceState[] = [];
    const audioChunks: Buffer[] = [];

    const session = new RealtimeVoiceSession({
      userId,
      role,
      conversationId,
      aiProviderId: "mock",
      aiModel: "mock-1",
      voiceProviderId: "fake-voice",
      sttProviderId: "fake-voice",
      onAudioChunk: (chunk) => audioChunks.push(chunk),
      onTranscript: () => {},
      onAssistantText: () => {},
      onStateChange: (state) => states.push(state),
      onError: (message) => {
        throw new Error(message);
      },
    });

    session.feedAudio(makeSyntheticUtterance());

    // Wait until it's actually speaking, then interrupt mid-stream.
    while (session.getState() !== "speaking") {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const chunkCountAtInterrupt = audioChunks.length;
    session.interrupt("explicit");

    // Give any in-flight (should-be-aborted) chunk delivery a chance to
    // fire if the abort didn't actually take effect, to make this a real
    // negative assertion rather than a race that happens to pass.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(session.getState()).toBe("listening");
    // At most one more chunk could have been in flight at the exact
    // moment of interruption; it must not have kept streaming the full
    // 20 chunks.
    expect(audioChunks.length).toBeLessThan(chunkCountAtInterrupt + 2);
    expect(audioChunks.length).toBeLessThan(fakeVoice.chunksPerSentence);
  });

  it("automatically barges in when the user starts talking while Jarvis is speaking", async () => {
    const fakeVoice = new FakeVoiceProvider();
    fakeVoice.transcriptToReturn = "Tell me something interesting.";
    fakeVoice.chunkDelayMs = 20;
    fakeVoice.chunksPerSentence = 20;
    __registerVoiceProviderForTesting(fakeVoice);

    const { userId, role, conversationId } = await makeUserAndConversation();

    const session = new RealtimeVoiceSession({
      userId,
      role,
      conversationId,
      aiProviderId: "mock",
      aiModel: "mock-1",
      voiceProviderId: "fake-voice",
      sttProviderId: "fake-voice",
      onAudioChunk: () => {},
      onTranscript: () => {},
      onAssistantText: () => {},
      onStateChange: () => {},
      onError: (message) => {
        throw new Error(message);
      },
    });

    session.feedAudio(makeSyntheticUtterance());
    while (session.getState() !== "speaking") {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // Feed the *onset* of a fresh utterance while Jarvis is still talking
    // — not a complete one, so we can observe the immediate post-barge-in
    // state before the new utterance's own speech_end (correctly) moves
    // it on to transcribing/thinking.
    session.feedAudio(makeUtteranceOnset());

    expect(session.getState()).toBe("listening");
  });
});
