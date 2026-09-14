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

// Regression coverage for a real Windows bug found in review: a plugin
// living under any directory containing a space (an entirely ordinary
// Windows path — "C:\Users\name\My Documents\plugins\x.mjs", or this
// project's own repo root if it's ever checked out somewhere like
// "C:\projects\ai assistant\") failed to load with a "does the file
// exist?" error. pathToFileURL() correctly percent-encodes the space
// (".../My%20Documents/...") — the file:// URL is spec-correct — but
// Vitest's own vite-node SSR loader resolves that URL by treating its
// still-encoded pathname as a literal filesystem path without decoding
// it first, so it looked for a file literally named "My%20Documents"
// and failed. loadPlugin() now selectively un-encodes just the %20
// sequences pathToFileURL() produces, which both vite-node's loader and
// Node's own real ESM loader resolve correctly. This fixture directory
// name is deliberately real (not simulated) so this exercises the exact
// dynamic-import path production code goes through.
describe("pluginManager — loading a plugin from a path containing a space", () => {
  it("loads correctly even though the directory name contains a space", async () => {
    const result = await loadPlugin(path.join(fixturesDir, "with a space", "pluginC.mjs"));
    expect(result.name).toBe("plugin-c");
    expect(toolRegistry.has("plugin_c_tool")).toBe(true);

    await disablePlugin("plugin-c");
    expect(toolRegistry.has("plugin_c_tool")).toBe(false);
  });
});
