import { describe, it, expect } from "vitest";
import { registerUser } from "../src/auth/authService.js";
import { hasPermission } from "../src/security/permissionService.js";
import { riskLevelForPermissions } from "../src/security/permissions.js";
import { memoryRememberTool } from "../src/tools/builtin/memoryTools.js";
import { retrieveRelevantMemory } from "../src/memory/memoryService.js";

async function makeUser() {
  const email = `mem-tool-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const result = await registerUser(email, "a-strong-password");
  return result.user.id;
}

describe("memory_remember tool", () => {
  it("is MEDIUM risk, requires no approval, and a member role holds it (write-tier, not read-only)", () => {
    expect(riskLevelForPermissions(memoryRememberTool.requiredPermissions)).toBe("medium");
    expect(memoryRememberTool.requiresApproval).toBe(false);
    // Owners/admins hold every permission; a plain member does not
    // automatically get write-tier permissions (security/permissionService.ts).
    expect(hasPermission("owner", "memory.write")).toBe(true);
    expect(hasPermission("member", "memory.write")).toBe(false);
  });

  it("actually persists what it's given, retrievable in a later call", async () => {
    const userId = await makeUser();
    const result = await memoryRememberTool.execute(
      { content: "Prefers concise answers with no preamble.", category: "preference", importance: 4 },
      { userId },
    );

    expect((result.output as { remembered: boolean }).remembered).toBe(true);
    const relevant = await retrieveRelevantMemory(userId, { query: "how should answers be formatted" });
    expect(relevant.some((m) => m.content.includes("concise"))).toBe(true);
  });

  it("replaces a prior memory under the same key when the user corrects it", async () => {
    const userId = await makeUser();
    await memoryRememberTool.execute({ content: "Timezone is PST.", category: "fact", key: "timezone" }, { userId });
    const corrected = await memoryRememberTool.execute({ content: "Timezone is actually EST.", category: "fact", key: "timezone" }, { userId });

    expect((corrected.output as { replacedExisting: boolean }).replacedExisting).toBe(true);
    const relevant = await retrieveRelevantMemory(userId, { query: "timezone" });
    const timezoneFacts = relevant.filter((m) => m.content.toLowerCase().includes("timezone"));
    expect(timezoneFacts).toHaveLength(1);
    expect(timezoneFacts[0].content).toContain("EST");
  });
});
