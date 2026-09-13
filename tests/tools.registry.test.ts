import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { toolRegistry } from "../src/tools/registry.js";
import type { ToolDefinition } from "../src/tools/types.js";

function makeTool(name: string): ToolDefinition {
  const schema = z.object({});
  return {
    name,
    description: "test tool",
    version: "1.0.0",
    inputSchema: schema,
    jsonSchema: { type: "object" },
    requiredPermissions: [],
    requiresApproval: false,
    source: "builtin",
    async execute() {
      return { output: { ok: true } };
    },
  };
}

describe("toolRegistry", () => {
  beforeEach(() => {
    for (const t of toolRegistry.list()) toolRegistry.unregister(t.name);
  });

  it("registers and retrieves a tool", () => {
    toolRegistry.register(makeTool("t1"));
    expect(toolRegistry.has("t1")).toBe(true);
    expect(toolRegistry.get("t1").name).toBe("t1");
  });

  it("throws for an unknown tool", () => {
    expect(() => toolRegistry.get("nonexistent")).toThrow(/unknown tool/i);
  });

  it("lists tools filtered by source", () => {
    toolRegistry.register(makeTool("builtin1"));
    toolRegistry.register({ ...makeTool("mcp1"), source: "mcp" });
    expect(toolRegistry.listBySource("mcp").map((t) => t.name)).toEqual(["mcp1"]);
    expect(toolRegistry.listBySource("builtin").map((t) => t.name)).toEqual(["builtin1"]);
  });

  it("produces model-facing descriptors without exposing internals", () => {
    toolRegistry.register(makeTool("t1"));
    const descriptors = toolRegistry.toDescriptors();
    expect(descriptors).toEqual([{ name: "t1", description: "test tool", inputSchema: { type: "object" } }]);
  });
});
