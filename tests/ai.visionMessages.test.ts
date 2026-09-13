import { describe, it, expect } from "vitest";
import { toAnthropicMessages } from "../src/ai/providers/anthropicProvider.js";
import { toOpenAIMessages } from "../src/ai/providers/openAIProvider.js";
import { toGeminiContents } from "../src/ai/providers/geminiProvider.js";
import type { ChatRequest } from "../src/ai/types.js";

// Section 25: ChatMessage.images is provider-neutral — each provider's own
// message-conversion function renders it into whatever vision content
// shape that API actually expects, and a message with no images keeps the
// exact same shape it always had (no accidental array-wrapping regression).
const image = { mimeType: "image/png", base64: "aGVsbG8=" };

describe("vision content conversion — Anthropic", () => {
  it("keeps a plain string tool_result when there is no image", () => {
    const request: ChatRequest = {
      model: "claude-sonnet-5",
      messages: [{ role: "tool", content: "ok", toolCallId: "call_1" }],
    };
    const [msg] = toAnthropicMessages(request) as Array<{ content: Array<{ content: unknown }> }>;
    expect(msg.content[0].content).toBe("ok");
  });

  it("attaches an image block alongside text in a tool_result when images are present", () => {
    const request: ChatRequest = {
      model: "claude-sonnet-5",
      messages: [{ role: "tool", content: "here is what I see", toolCallId: "call_1", images: [image] }],
    };
    const [msg] = toAnthropicMessages(request) as Array<{ content: Array<{ content: Array<Record<string, unknown>> }> }>;
    const blocks = msg.content[0].content;
    expect(blocks[0]).toEqual({ type: "text", text: "here is what I see" });
    expect(blocks[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } });
  });

  it("attaches an image block to a plain user message when images are present", () => {
    const request: ChatRequest = {
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "what's on screen?", images: [image] }],
    };
    const [msg] = toAnthropicMessages(request) as Array<{ content: Array<Record<string, unknown>> }>;
    expect(msg.content).toEqual([
      { type: "text", text: "what's on screen?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
    ]);
  });
});

describe("vision content conversion — OpenAI", () => {
  it("keeps a plain string tool message when there is no image", () => {
    const request: ChatRequest = {
      model: "gpt-4o",
      messages: [{ role: "tool", content: "ok", toolCallId: "call_1" }],
    };
    const messages = toOpenAIMessages(request);
    const toolMsg = messages.find((m) => m.role === "tool") as { content: unknown };
    expect(toolMsg.content).toBe("ok");
  });

  it("keeps the tool message content a string and appends a synthetic user message carrying the image", () => {
    const request: ChatRequest = {
      model: "gpt-4o",
      messages: [{ role: "tool", content: "here is what I see", toolCallId: "call_1", images: [image] }],
    };
    const messages = toOpenAIMessages(request);
    const toolMsg = messages.find((m) => m.role === "tool") as { content: unknown };
    expect(toolMsg.content).toBe("here is what I see"); // OpenAI's API rejects array content on "tool" messages

    const imageMsg = messages[messages.length - 1] as { role: string; content: Array<Record<string, unknown>> };
    expect(imageMsg.role).toBe("user");
    expect(imageMsg.content.some((part) => part.type === "image_url")).toBe(true);
    const imagePart = imageMsg.content.find((part) => part.type === "image_url") as { image_url: { url: string } };
    expect(imagePart.image_url.url).toBe("data:image/png;base64,aGVsbG8=");
  });

  it("renders images as content parts on a plain user message", () => {
    const request: ChatRequest = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "what's on screen?", images: [image] }],
    };
    const [msg] = toOpenAIMessages(request) as Array<{ content: Array<Record<string, unknown>> }>;
    expect(msg.content[0]).toEqual({ type: "text", text: "what's on screen?" });
    expect(msg.content[1]).toMatchObject({ type: "image_url" });
  });
});

describe("vision content conversion — Gemini", () => {
  it("keeps a single functionResponse part when there is no image", () => {
    const request: ChatRequest = {
      model: "gemini-2.0-flash",
      messages: [{ role: "tool", content: "ok", toolCallId: "call_1" }],
    };
    const [entry] = toGeminiContents(request) as Array<{ parts: unknown[] }>;
    expect(entry.parts.length).toBe(1);
  });

  it("appends an inlineData part alongside the functionResponse when images are present", () => {
    const request: ChatRequest = {
      model: "gemini-2.0-flash",
      messages: [{ role: "tool", content: "here is what I see", toolCallId: "call_1", images: [image] }],
    };
    const [entry] = toGeminiContents(request) as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    expect(entry.role).toBe("user");
    expect(entry.parts[0]).toHaveProperty("functionResponse");
    expect(entry.parts[1]).toEqual({ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } });
  });

  it("appends an inlineData part on a plain user message when images are present", () => {
    const request: ChatRequest = {
      model: "gemini-2.0-flash",
      messages: [{ role: "user", content: "what's on screen?", images: [image] }],
    };
    const [entry] = toGeminiContents(request) as Array<{ parts: Array<Record<string, unknown>> }>;
    expect(entry.parts[0]).toEqual({ text: "what's on screen?" });
    expect(entry.parts[1]).toEqual({ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } });
  });
});
