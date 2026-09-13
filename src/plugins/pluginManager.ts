import path from "node:path";
import { pathToFileURL } from "node:url";
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

export async function loadPlugin(absoluteOrRelativePath: string): Promise<{ name: string; toolsRegistered: number }> {
  const resolved = path.resolve(absoluteOrRelativePath);
  const moduleUrl = pathToFileURL(resolved).href;
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
