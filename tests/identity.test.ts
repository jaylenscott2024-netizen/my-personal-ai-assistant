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

  // Human-like conversational behavior: a consistent underlying character
  // whose EXPRESSION is dynamic and context-driven, not a fixed checklist
  // of scripted mannerisms or banned phrases to avoid.
  it("establishes a composed, direct conversational character by default", () => {
    const instructions = coreAssistantInstructions("Jarvis");
    expect(instructions).toMatch(/composed/i);
    expect(instructions).toMatch(/direct/i);
    expect(instructions).toMatch(/confident/i);
  });

  it("instructs the assistant to read context rather than follow a fixed script", () => {
    const instructions = coreAssistantInstructions("Jarvis");
    expect(instructions).toMatch(/adapt|context|situation|moment/i);
    // Explicitly not a rigid rule list — the identity is stable, the
    // expression of it is what varies.
    expect(instructions).not.toMatch(/personality slider/i);
  });

  it("refuses to suppress or force behavior merely by AI/human association", () => {
    // The core correction this identity text encodes: don't strip
    // something because it's "what AI does," don't add something because
    // it's "what humans do" — decide from the actual situation instead.
    const instructions = coreAssistantInstructions("Jarvis");
    expect(instructions).toMatch(/associate.*(ai|human)|stereotyp/i);
  });

  it("instructs the assistant to carry context forward and incorporate corrections", () => {
    const instructions = coreAssistantInstructions("Jarvis");
    expect(instructions).toMatch(/repeat/i);
    expect(instructions).toMatch(/correct/i);
  });

  it("never instructs the assistant to claim it is human", () => {
    const instructions = coreAssistantInstructions("Jarvis");
    expect(instructions).toMatch(/never claim to be human/i);
    expect(instructions).not.toMatch(/you are human/i);
  });

  it("does not introduce configurable personality sliders", () => {
    // The spec's own constraint: the default character must already feel
    // complete, not be assembled from user-tunable dials.
    const instructions = coreAssistantInstructions("Jarvis");
    expect(instructions.toLowerCase()).not.toContain("personality slider");
  });

  it("does not trade adaptation for substance", () => {
    const instructions = coreAssistantInstructions("Jarvis");
    expect(instructions).toMatch(/accura|thorough|capab/i);
  });
});
