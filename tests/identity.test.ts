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

  // Human-like conversational behavior (Phase 3): a strong default
  // character with no personality sliders, and explicit anti-patterns
  // (canned enthusiasm, forced filler, claiming to be human) ruled out
  // rather than left to chance.
  it("establishes a composed, direct conversational character by default", () => {
    const instructions = coreAssistantInstructions("Jarvis");
    expect(instructions).toMatch(/composed/i);
    expect(instructions).toMatch(/direct/i);
    expect(instructions).toMatch(/confident/i);
  });

  it("explicitly rules out canned acknowledgements and forced filler", () => {
    const instructions = coreAssistantInstructions("Jarvis");
    expect(instructions).toMatch(/great question/i); // named as an example to avoid
    expect(instructions).toMatch(/filler/i);
  });

  it("never instructs the assistant to claim it is human", () => {
    const instructions = coreAssistantInstructions("Jarvis");
    expect(instructions).toMatch(/not a human/i);
    expect(instructions).not.toMatch(/you are human/i);
  });

  it("does not introduce configurable personality sliders", () => {
    // The spec's own constraint: the default character must already feel
    // complete, not be assembled from user-tunable dials.
    const instructions = coreAssistantInstructions("Jarvis");
    expect(instructions.toLowerCase()).not.toContain("personality slider");
  });
});
