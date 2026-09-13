import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";

function parseSseEvents(body: string): Array<{ event: string; data: unknown }> {
  return body
    .split("\n\n")
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const lines = chunk.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event: "))!;
      const dataLine = lines.find((l) => l.startsWith("data: "))!;
      return { event: eventLine.slice("event: ".length), data: JSON.parse(dataLine.slice("data: ".length)) };
    });
}

// Section 14: the streaming conversation endpoint must carry incremental
// deltas over the wire (not just return the same shape as the
// non-streaming endpoint with a different content-type), and must still
// enforce the same auth/ownership boundaries as everything else.
describe("POST /conversations/:id/messages/stream", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function registerAndLogin(email: string) {
    const res = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "a-strong-password" } });
    return JSON.parse(res.body) as { token: string };
  }

  it("streams incremental text deltas and a final done event", async () => {
    const { token } = await registerAndLogin(`sse-${Date.now()}@example.com`);
    const conv = await app.inject({
      method: "POST",
      url: "/conversations",
      headers: { authorization: `Bearer ${token}` },
      payload: { provider: "mock" },
    });
    const conversation = JSON.parse(conv.body) as { id: string };

    const res = await app.inject({
      method: "POST",
      url: `/conversations/${conversation.id}/messages/stream`,
      headers: { authorization: `Bearer ${token}` },
      payload: { message: "Tell me something interesting." },
    });

    expect(res.headers["content-type"]).toContain("text/event-stream");
    const events = parseSseEvents(res.body);

    expect(events[0].event).toBe("run");
    expect(events.some((e) => e.event === "delta")).toBe(true);
    expect(events[events.length - 1].event).toBe("done");
    expect((events[events.length - 1].data as { status: string }).status).toBe("completed");

    // The deltas, concatenated, should reconstruct the final answer.
    const reconstructed = events
      .filter((e) => e.event === "delta")
      .map((e) => (e.data as { delta: string }).delta)
      .join("");
    const finalMessage = (events[events.length - 1].data as { finalMessage: string }).finalMessage;
    expect(reconstructed.trim()).toBe(finalMessage.trim());
  });

  it("rejects an unauthenticated request", async () => {
    const res = await app.inject({ method: "POST", url: "/conversations/whatever/messages/stream", payload: { message: "hi" } });
    expect(res.statusCode).toBe(401);
  });

  it("does not let one user stream into another user's conversation", async () => {
    const a = await registerAndLogin(`sse-a-${Date.now()}@example.com`);
    const b = await registerAndLogin(`sse-b-${Date.now()}@example.com`);
    const conv = await app.inject({
      method: "POST",
      url: "/conversations",
      headers: { authorization: `Bearer ${a.token}` },
      payload: { provider: "mock" },
    });
    const conversation = JSON.parse(conv.body) as { id: string };

    const res = await app.inject({
      method: "POST",
      url: `/conversations/${conversation.id}/messages/stream`,
      headers: { authorization: `Bearer ${b.token}` },
      payload: { message: "hi" },
    });
    expect(res.statusCode).toBe(404);
  });
});
