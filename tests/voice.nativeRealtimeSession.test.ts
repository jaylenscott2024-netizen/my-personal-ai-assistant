import { describe, it, expect, beforeAll } from "vitest";
import { registerUser } from "../src/auth/authService.js";
import { createConversation } from "../src/conversation/conversationService.js";
import { getHistory } from "../src/conversation/conversationService.js";
import { registerBuiltinTools } from "../src/tools/builtinIndex.js";
import { toolRegistry } from "../src/tools/registry.js";
import { z } from "zod";
import { NativeRealtimeSession, type NativeRealtimeState } from "../src/voice/realtime/nativeRealtimeSession.js";
import { __registerRealtimeAudioProviderForTesting } from "../src/voice/realtime/realtimeAudioRegistry.js";
import type {
  RealtimeAudioCapabilities,
  RealtimeAudioEvent,
  RealtimeAudioListener,
  RealtimeAudioProvider,
  RealtimeAudioSession,
  RealtimeAudioSessionOptions,
} from "../src/voice/realtime/realtimeAudioProvider.js";

beforeAll(() => {
  registerBuiltinTools();
  // A harmless, permission-free tool the model can "call" in tests without
  // touching any real permission tier — proves tool calls actually run
  // through executeToolCall rather than being faked locally.
  toolRegistry.register({
    name: "test_echo",
    description: "Echoes back what it is given.",
    inputSchema: z.object({ text: z.string() }),
    jsonSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    requiredPermissions: [],
    source: "builtin",
    execute: async (input: { text: string }) => ({ output: { echoed: input.text } }),
  } as never);
});

/** A fake realtime session the test drives directly — standing in for a
 *  real WebSocket to a provider, so barge-in/tool-call/transcript wiring
 *  can be proven without any network access. */
class FakeRealtimeSession implements RealtimeAudioSession {
  readonly providerId = "fake-realtime";
  isOpen = true;
  private listeners: RealtimeAudioListener[] = [];
  sentAudio: Buffer[] = [];
  interruptCalls = 0;
  toolResults: Array<{ callId: string; result: unknown }> = [];
  closed = false;

  sendAudio(pcm16: Buffer): void {
    this.sentAudio.push(pcm16);
  }
  commitInput(): void {}
  interrupt(): void {
    this.interruptCalls++;
  }
  submitToolResult(callId: string, result: unknown): void {
    this.toolResults.push({ callId, result });
  }
  subscribe(listener: RealtimeAudioListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  async close(): Promise<void> {
    this.closed = true;
    this.isOpen = false;
  }
  /** Test-only: simulate the provider emitting an event. */
  emit(event: RealtimeAudioEvent): void {
    for (const l of this.listeners) l(event);
  }
}

class FakeRealtimeProvider implements RealtimeAudioProvider {
  readonly id = "fake-realtime";
  nativeSpeechToSpeech = true;
  lastSession: FakeRealtimeSession | null = null;
  lastOptions: RealtimeAudioSessionOptions | null = null;

  getCapabilities(): RealtimeAudioCapabilities {
    return {
      nativeSpeechToSpeech: this.nativeSpeechToSpeech,
      serverSideVad: true,
      interruptible: true,
      toolCalling: true,
      transcripts: true,
      inputSampleRate: 24_000,
      outputSampleRate: 24_000,
      expressiveControls: [],
    };
  }
  async isConfigured(): Promise<boolean> {
    return true;
  }
  async connect(options: RealtimeAudioSessionOptions): Promise<RealtimeAudioSession> {
    this.lastOptions = options;
    const session = new FakeRealtimeSession();
    this.lastSession = session;
    return session;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function makeUserAndConversation() {
  const email = `native-realtime-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { user } = await registerUser(email, "a-strong-password");
  const conversation = await createConversation(user.id, "native-realtime-test", "mock", "mock-1");
  return { userId: user.id, role: "owner" as const, conversationId: conversation.id };
}

describe("NativeRealtimeSession — refuses to fake native audio-to-audio", () => {
  it("throws rather than silently degrading when the provider lacks native speech-to-speech", async () => {
    const { userId, role, conversationId } = await makeUserAndConversation();
    const provider = new FakeRealtimeProvider();
    provider.nativeSpeechToSpeech = false;

    const session = new NativeRealtimeSession({
      userId,
      role,
      conversationId,
      provider,
      model: "fake-model",
      instructions: "You are Jarvis.",
      toolsEnabled: false,
      onAudioChunk: () => {},
      onInputTranscript: () => {},
      onOutputTranscript: () => {},
      onStateChange: () => {},
      onError: () => {},
    });

    await expect(session.connect()).rejects.toThrow(/does not support native speech-to-speech/i);
  });
});

describe("NativeRealtimeSession — audio path", () => {
  it("passes microphone audio straight through with no transcription step on this side", async () => {
    const { userId, role, conversationId } = await makeUserAndConversation();
    const provider = new FakeRealtimeProvider();
    const session = new NativeRealtimeSession({
      userId, role, conversationId, provider,
      model: "fake-model", instructions: "You are Jarvis.", toolsEnabled: false,
      onAudioChunk: () => {}, onInputTranscript: () => {}, onOutputTranscript: () => {},
      onStateChange: () => {}, onError: () => {},
    });
    await session.connect();

    const mic = Buffer.from([1, 2, 3, 4]);
    session.feedAudio(mic);

    expect(provider.lastSession!.sentAudio).toContainEqual(mic);
    await session.close();
  });

  it("delivers generated audio to the caller and reports the speaking state", async () => {
    const { userId, role, conversationId } = await makeUserAndConversation();
    const provider = new FakeRealtimeProvider();
    const states: NativeRealtimeState[] = [];
    const chunks: Buffer[] = [];
    const session = new NativeRealtimeSession({
      userId, role, conversationId, provider,
      model: "fake-model", instructions: "You are Jarvis.", toolsEnabled: false,
      onAudioChunk: (c) => chunks.push(c), onInputTranscript: () => {}, onOutputTranscript: () => {},
      onStateChange: (s) => states.push(s), onError: () => {},
    });
    await session.connect();

    provider.lastSession!.emit({ type: "session_ready" });
    provider.lastSession!.emit({ type: "audio_delta", audio: Buffer.from("hello") });

    expect(chunks).toHaveLength(1);
    expect(states).toContain("speaking");
    await session.close();
  });
});

describe("NativeRealtimeSession — barge-in", () => {
  it("interrupts the moment provider-side VAD reports speech, without waiting for a turn to end", async () => {
    const { userId, role, conversationId } = await makeUserAndConversation();
    const provider = new FakeRealtimeProvider();
    const states: NativeRealtimeState[] = [];
    const session = new NativeRealtimeSession({
      userId, role, conversationId, provider,
      model: "fake-model", instructions: "You are Jarvis.", toolsEnabled: false,
      onAudioChunk: () => {}, onInputTranscript: () => {}, onOutputTranscript: () => {},
      onStateChange: (s) => states.push(s), onError: () => {},
    });
    await session.connect();

    provider.lastSession!.emit({ type: "session_ready" });
    provider.lastSession!.emit({ type: "audio_delta", audio: Buffer.from("mid-sentence") });
    expect(session.getState()).toBe("speaking");

    provider.lastSession!.emit({ type: "speech_started" });

    expect(provider.lastSession!.interruptCalls).toBe(1); // told the provider to stop generating
    expect(session.getState()).toBe("listening"); // not queued — immediate
    await session.close();
  });
});

describe("NativeRealtimeSession — tool calls go through the real permission path", () => {
  it("executes a permitted tool call and returns its result to the model", async () => {
    const { userId, role, conversationId } = await makeUserAndConversation();
    const provider = new FakeRealtimeProvider();
    const session = new NativeRealtimeSession({
      userId, role, conversationId, provider,
      model: "fake-model", instructions: "You are Jarvis.", toolsEnabled: true,
      onAudioChunk: () => {}, onInputTranscript: () => {}, onOutputTranscript: () => {},
      onStateChange: () => {}, onError: () => {},
    });
    await session.connect();

    // toolsEnabled advertised every registered tool to the provider.
    expect(provider.lastOptions!.tools!.some((t) => t.name === "test_echo")).toBe(true);

    provider.lastSession!.emit({ type: "tool_call", callId: "call1", name: "test_echo", arguments: { text: "ping" } });
    await waitFor(() => provider.lastSession!.toolResults.length > 0); // tool execution is async

    expect(provider.lastSession!.toolResults).toHaveLength(1);
    expect(provider.lastSession!.toolResults[0].callId).toBe("call1");
    expect(JSON.parse(provider.lastSession!.toolResults[0].result as string)).toEqual({ echoed: "ping" });

    // Recorded on the conversation, same as the text agent path would.
    const history = await getHistory(conversationId);
    expect(history.some((m) => m.role === "tool")).toBe(true);
    await session.close();
  });

  it("refuses a tool call outright when the session was started with tools disabled", async () => {
    const { userId, role, conversationId } = await makeUserAndConversation();
    const provider = new FakeRealtimeProvider();
    const session = new NativeRealtimeSession({
      userId, role, conversationId, provider,
      model: "fake-model", instructions: "You are Jarvis.", toolsEnabled: false,
      onAudioChunk: () => {}, onInputTranscript: () => {}, onOutputTranscript: () => {},
      onStateChange: () => {}, onError: () => {},
    });
    await session.connect();

    expect(provider.lastOptions!.tools).toEqual([]);

    provider.lastSession!.emit({ type: "tool_call", callId: "call2", name: "test_echo", arguments: { text: "ping" } });
    await waitFor(() => provider.lastSession!.toolResults.length > 0);

    expect(provider.lastSession!.toolResults).toHaveLength(1);
    expect(provider.lastSession!.toolResults[0].result).toMatchObject({ error: expect.stringMatching(/disabled/i) });
    await session.close();
  });

  it("denies a tool call the role does not have permission for, same as the text agent path", async () => {
    const { conversationId } = await makeUserAndConversation();
    // A "member" role holds no write permissions by default (security/permissionService.ts).
    const memberEmail = `native-realtime-member-${Date.now()}@example.com`;
    const { user: member } = await registerUser(memberEmail, "a-strong-password");

    toolRegistry.register({
      name: "test_high_permission",
      description: "Requires a permission members don't have.",
      inputSchema: z.object({}),
      jsonSchema: { type: "object", properties: {} },
      requiredPermissions: ["filesystem.write"],
      source: "builtin",
      execute: async () => ({ output: { ok: true } }),
    } as never);

    const provider = new FakeRealtimeProvider();
    const session = new NativeRealtimeSession({
      userId: member.id, role: "member", conversationId, provider,
      model: "fake-model", instructions: "You are Jarvis.", toolsEnabled: true,
      onAudioChunk: () => {}, onInputTranscript: () => {}, onOutputTranscript: () => {},
      onStateChange: () => {}, onError: () => {},
    });
    await session.connect();

    provider.lastSession!.emit({ type: "tool_call", callId: "call3", name: "test_high_permission", arguments: {} });
    await waitFor(() => provider.lastSession!.toolResults.length > 0);

    expect(provider.lastSession!.toolResults).toHaveLength(1);
    const result = JSON.parse(provider.lastSession!.toolResults[0].result as string);
    expect(result.error).toMatch(/permission denied/i);
    await session.close();
  });
});

describe("NativeRealtimeSession — transcripts", () => {
  it("surfaces input and output transcripts without treating them as the audio path", async () => {
    const { userId, role, conversationId } = await makeUserAndConversation();
    const provider = new FakeRealtimeProvider();
    const inputTexts: string[] = [];
    const outputTexts: string[] = [];
    const session = new NativeRealtimeSession({
      userId, role, conversationId, provider,
      model: "fake-model", instructions: "You are Jarvis.", toolsEnabled: false,
      onAudioChunk: () => {}, onInputTranscript: (t) => inputTexts.push(t), onOutputTranscript: (t) => outputTexts.push(t),
      onStateChange: () => {}, onError: () => {},
    });
    await session.connect();

    provider.lastSession!.emit({ type: "input_transcript", text: "what's on my screen" });
    provider.lastSession!.emit({ type: "output_transcript_delta", text: "You have Notepad open." });

    expect(inputTexts).toEqual(["what's on my screen"]);
    expect(outputTexts).toEqual(["You have Notepad open."]);
    await session.close();
  });
});
