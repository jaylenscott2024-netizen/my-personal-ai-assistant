import { describe, it, expect } from "vitest";
import { browserPermissionFor } from "../src/tools/builtin/browserTool.js";

// Section 6: browser tool actions are only "read" risk unless they
// actually mutate page state or move data in/out of the browser.
describe("browserPermissionFor", () => {
  it("treats read-only/navigational actions as browser.read", () => {
    for (const action of ["open", "navigate", "back", "forward", "read_page", "find", "screenshot", "wait", "close"]) {
      expect(browserPermissionFor(action)).toBe("browser.read");
    }
  });

  it("escalates mutating/interactive actions to browser.interact", () => {
    for (const action of ["click", "type", "select", "download", "upload"]) {
      expect(browserPermissionFor(action)).toBe("browser.interact");
    }
  });
});
