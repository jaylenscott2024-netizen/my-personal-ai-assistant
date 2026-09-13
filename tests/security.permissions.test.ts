import { describe, it, expect } from "vitest";
import { hasPermission, missingPermissions } from "../src/security/permissionService.js";
import { riskLevelForPermissions, accessLevelOf } from "../src/security/permissions.js";

describe("permissionService", () => {
  it("grants owner/admin every permission", () => {
    expect(hasPermission("owner", "shopify.write")).toBe(true);
    expect(hasPermission("admin", "phone.call")).toBe(true);
  });

  it("restricts member role to read-only access levels", () => {
    expect(hasPermission("member", "filesystem.read")).toBe(true);
    expect(hasPermission("member", "filesystem.write")).toBe(false);
    expect(hasPermission("member", "email.send")).toBe(false);
  });

  it("computes missing permissions", () => {
    expect(missingPermissions("member", ["filesystem.read", "filesystem.write"])).toEqual(["filesystem.write"]);
    expect(missingPermissions("owner", ["filesystem.write", "phone.call"])).toEqual([]);
  });
});

describe("risk scoring", () => {
  it("maps access levels correctly", () => {
    expect(accessLevelOf("filesystem.delete")).toBe("delete");
    expect(accessLevelOf("email.send")).toBe("send");
    expect(accessLevelOf("phone.call")).toBe("call");
    expect(accessLevelOf("shopify.read")).toBe("read");
  });

  it("escalates risk level for consequential permissions", () => {
    expect(riskLevelForPermissions(["shopify.read"])).toBe("low");
    expect(riskLevelForPermissions(["filesystem.write"])).toBe("medium");
    expect(riskLevelForPermissions(["email.send"])).toBe("high");
    expect(riskLevelForPermissions(["admin"])).toBe("critical");
  });
});
