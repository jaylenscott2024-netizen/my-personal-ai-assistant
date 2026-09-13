import { describe, it, expect } from "vitest";
import { riskLevelForPermissions } from "../src/security/permissions.js";
import {
  computerOpenApplicationTool,
  computerCloseApplicationTool,
  computerFocusWindowTool,
  computerListApplicationsTool,
  computerListWindowsTool,
  computerOpenFolderTool,
  computerScreenshotTool,
  computerTypeTool,
  computerClickTool,
  computerDoubleClickTool,
  computerScrollTool,
  computerDragTool,
  computerCreateFolderTool,
  computerMoveFileTool,
  computerCopyFileTool,
  computerDeleteFileTool,
  computerRunCommandTool,
} from "../src/tools/builtin/computerTools.js";

// Verifies the computer-control tools' declared permissions actually
// score at the risk tier the Jarvis spec itself specifies (Section 8):
// LOW = open app/focus window/list apps/read screen/open folder,
// MEDIUM = type/click/move files/create files,
// HIGH = delete files, and (a deliberately stricter) CRITICAL for
// arbitrary command execution — see security/permissions.ts for why.
describe("computer tool risk tiers match the spec's own categorization", () => {
  const low = [computerOpenApplicationTool, computerCloseApplicationTool, computerFocusWindowTool, computerListApplicationsTool, computerListWindowsTool, computerOpenFolderTool, computerScreenshotTool];
  const medium = [computerTypeTool, computerClickTool, computerDoubleClickTool, computerScrollTool, computerDragTool, computerCreateFolderTool, computerMoveFileTool, computerCopyFileTool];

  it.each(low)("$name is LOW risk and does not require approval", (tool) => {
    const risk = riskLevelForPermissions(tool.requiredPermissions);
    expect(risk).toBe("low");
    expect(tool.requiresApproval).toBe(false);
  });

  it.each(medium)("$name is MEDIUM risk and does not require approval by default", (tool) => {
    const risk = riskLevelForPermissions(tool.requiredPermissions);
    expect(risk).toBe("medium");
    expect(tool.requiresApproval).toBe(false);
  });

  it("computer_delete_file is HIGH risk and requires approval", () => {
    expect(riskLevelForPermissions(computerDeleteFileTool.requiredPermissions)).toBe("high");
    expect(computerDeleteFileTool.requiresApproval).toBe(true);
  });

  it("computer_run_command is the highest risk tier and always requires approval", () => {
    expect(riskLevelForPermissions(computerRunCommandTool.requiredPermissions)).toBe("critical");
    expect(computerRunCommandTool.requiresApproval).toBe(true);
  });
});
