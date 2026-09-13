import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlugin, disablePlugin } from "../src/plugins/pluginManager.js";
import { toolRegistry } from "../src/tools/registry.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "plugins");

// Regression coverage for a real bug found in review: disablePlugin(name)
// unregistered EVERY plugin-sourced tool in the registry, not just the
// named plugin's own tools — because nothing tracked which tool came from
// which plugin. Disabling one plugin would silently break every other
// loaded plugin's tools too. These load real plugin modules (dynamic
// import against actual files, the same mechanism production uses) rather
// than mocking the registry.
describe("pluginManager — disabling one plugin does not affect another", () => {
  it("unregisters only the disabled plugin's own tools", async () => {
    await loadPlugin(path.join(fixturesDir, "pluginA.mjs"));
    await loadPlugin(path.join(fixturesDir, "pluginB.mjs"));

    expect(toolRegistry.has("plugin_a_tool")).toBe(true);
    expect(toolRegistry.has("plugin_b_tool")).toBe(true);

    await disablePlugin("plugin-a");

    expect(toolRegistry.has("plugin_a_tool")).toBe(false);
    // The actual bug: plugin B's tool used to disappear too.
    expect(toolRegistry.has("plugin_b_tool")).toBe(true);

    await disablePlugin("plugin-b");
    expect(toolRegistry.has("plugin_b_tool")).toBe(false);
  });

  it("cleans up a plugin's previous tool set when it is reloaded under a new version", async () => {
    await loadPlugin(path.join(fixturesDir, "pluginA.mjs"));
    expect(toolRegistry.has("plugin_a_tool")).toBe(true);

    // Same plugin name, second version, with a renamed tool.
    await loadPlugin(path.join(fixturesDir, "pluginA-v2.mjs"));

    expect(toolRegistry.has("plugin_a_tool_v2")).toBe(true);
    // The old tool name must not survive the reload as an orphan the
    // plugin manager no longer knows how to clean up.
    expect(toolRegistry.has("plugin_a_tool")).toBe(false);

    await disablePlugin("plugin-a");
    expect(toolRegistry.has("plugin_a_tool_v2")).toBe(false);
  });
});
