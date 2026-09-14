import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { z } from "zod";
import { prisma } from "../database/client.js";
import { toolRegistry } from "../tools/registry.js";
import type { ToolDefinition } from "../tools/types.js";
import { ValidationError } from "../utils/errors.js";
import { childLogger } from "../config/logger.js";

const log = childLogger("plugins");

// Section 40: Plugin System. A plugin is a local ES module that default-
// exports metadata + an array of ToolDefinitions. This is intentionally a
// real dynamic-import mechanism (not a fake registry) but scoped to local
// files an operator explicitly points at — arbitrary remote plugin code
// execution is out of scope until a proper sandbox exists (Section 68/69).
const pluginModuleSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
});

// Which tool names came from which plugin, so disabling one plugin can
// unregister exactly its own tools rather than every plugin-sourced tool
// in the registry. ToolDefinition itself carries no plugin identity (the
// registry is deliberately source-agnostic — Section 15), so this
// association has to live here, at the one place that actually knows it.
const toolNamesByPlugin = new Map<string, string[]>();

// Vitest's vite-node transform intercepts every dynamic import() call in
// this project's own source and resolves the URL through its own SSR
// module loader instead of Node's real one. That loader treats a file://
// URL's *percent-encoded* pathname as a literal filesystem path without
// decoding it first — so a plugin under any directory containing a space
// (a completely ordinary Windows path, e.g. "C:\Users\name\My
// Documents\plugins\x.mjs", which pathToFileURL turns into
// ".../My%20Documents/...") fails with "does the file exist?" even
// though the file is exactly there. Confirmed empirically that both
// Node's real ESM loader and vite-node's loader accept a file:// URL
// with a literal, unencoded space embedded directly — so pathToFileURL
// is still used for correct encoding of everything else (drive letters,
// non-ASCII characters, and URL-structural characters like # and ?),
// and only the %20 sequences it produces are selectively un-encoded
// afterward. This is not a workaround specific to the test runner: it
// produces a URL string that both loaders resolve to the same file.
function toModuleUrl(resolvedPath: string): string {
  return pathToFileURL(resolvedPath).href.replace(/%20/g, " ");
}

export async function loadPlugin(absoluteOrRelativePath: string): Promise<{ name: string; toolsRegistered: number }> {
  // Accept either a plain filesystem path (the common case — an operator
  // pointing at a local .mjs file) or an already-formed file:// URL,
  // rather than assuming a bare path.resolve() is always correct: a
  // caller-supplied "file://..." string would otherwise be mangled into
  // a nonsense relative path (path.resolve() has no idea "file:" is a
  // URL scheme, not a path segment).
  const alreadyUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(absoluteOrRelativePath);
  const resolved = alreadyUrl ? fileURLToPath(absoluteOrRelativePath) : path.resolve(absoluteOrRelativePath);
  const moduleUrl = toModuleUrl(resolved);
  const imported = (await import(moduleUrl)) as { default?: unknown; tools?: ToolDefinition[] };

  const metadata = pluginModuleSchema.parse(imported.default ?? {});
  const tools = imported.tools ?? [];
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new ValidationError(`Plugin at "${absoluteOrRelativePath}" exported no tools.`);
  }

  // Reloading an existing plugin (e.g. after an update) must not leave
  // its previous tool set registered under names the new version no
  // longer exports.
  for (const staleName of toolNamesByPlugin.get(metadata.name) ?? []) {
    toolRegistry.unregister(staleName);
  }

  for (const tool of tools) {
    toolRegistry.register({ ...tool, source: "plugin" });
  }
  toolNamesByPlugin.set(
    metadata.name,
    tools.map((t) => t.name),
  );

  await prisma.plugin.upsert({
    where: { name: metadata.name },
    create: {
      name: metadata.name,
      version: metadata.version,
      description: metadata.description,
      capabilities: metadata.capabilities ? JSON.stringify(metadata.capabilities) : null,
      enabled: true,
    },
    update: { version: metadata.version, description: metadata.description, enabled: true },
  });

  log.info({ plugin: metadata.name, tools: tools.length }, "loaded plugin");
  return { name: metadata.name, toolsRegistered: tools.length };
}

export async function listPlugins() {
  return prisma.plugin.findMany();
}

export async function disablePlugin(name: string): Promise<void> {
  await prisma.plugin.update({ where: { name }, data: { enabled: false } });
  // Unregister only this plugin's own tools. The previous version of this
  // function unregistered every plugin-sourced tool in the registry
  // regardless of which plugin it belonged to — disabling one plugin
  // would silently break every other loaded plugin's tools too.
  for (const toolName of toolNamesByPlugin.get(name) ?? []) {
    toolRegistry.unregister(toolName);
  }
  toolNamesByPlugin.delete(name);
}
