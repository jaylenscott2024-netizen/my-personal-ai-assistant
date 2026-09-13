import { describe, it, expect } from "vitest";
import { assembleSystemPrompt, coreAssistantInstructions } from "../src/context/instructions.js";
import { DEFAULT_USER_SETTINGS } from "../src/settings/userSettingsService.js";

// Section 12: configurable assistant identity, defaulting to "Jarvis" —
// never "Voltic"/"Vultic" anywhere user-facing.
describe("assistant identity", () => {
  it("defaults to Jarvis in user settings", () => {
    expect(DEFAULT_USER_SETTINGS.assistantName).toBe("Jarvis");
  });

  it("names the assistant in the system prompt by default", () => {
    const prompt = assembleSystemPrompt({});
    expect(prompt).toContain("You are Jarvis");
    expect(prompt.toLowerCase()).not.toContain("voltic");
    expect(prompt.toLowerCase()).not.toContain("vultic");
  });

  it("uses a custom configured name throughout the prompt", () => {
    const prompt = assembleSystemPrompt({ assistantName: "Friday" });
    expect(prompt).toContain("You are Friday");
    expect(prompt).toContain("or Friday itself");
  });

  it("frames the assistant as a capable personal agent, not a generic chatbot", () => {
    const instructions = coreAssistantInstructions("Jarvis");
    expect(instructions).toMatch(/personal AI assistant and digital agent/i);
    expect(instructions).toMatch(/computer/i);
    expect(instructions).toMatch(/browser/i);
  });
});
