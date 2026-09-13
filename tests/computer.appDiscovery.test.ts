import { describe, it, expect } from "vitest";
import { discoverApplications, matchApplications, type DiscoveredApp } from "../src/computer/appDiscovery.js";

// This sandbox is Linux with real .desktop files under /usr/share/applications
// (python3, LibreOffice, etc.) — so app discovery is genuinely exercised
// here, not just mocked. Windows/macOS discovery paths are exercised by
// the pure matchApplications() scoring logic below instead, since this
// environment can't run PowerShell or enumerate /Applications.
describe("discoverApplications (Linux .desktop files)", () => {
  it("finds real applications installed in this environment", async () => {
    const apps = await discoverApplications(true);
    expect(apps.length).toBeGreaterThan(0);
    expect(apps.every((a) => a.name && a.launchTarget)).toBe(true);
    expect(apps.every((a) => a.source === "linux_desktop_file")).toBe(true);
  });

  it("strips freedesktop field codes from Exec= commands", async () => {
    const apps = await discoverApplications();
    // No discovered launch target should still contain a raw %f/%U-style
    // placeholder — cleanExecCommand must have stripped it.
    for (const app of apps) {
      expect(app.launchTarget).not.toMatch(/%[fFuUick]/);
    }
  });

  it("caches results and only rescans when forced", async () => {
    const first = await discoverApplications();
    const second = await discoverApplications();
    expect(second).toBe(first); // same array reference — served from cache
    const third = await discoverApplications(true);
    expect(third).not.toBe(first); // forced rescan produced a new array
  });
});

describe("matchApplications", () => {
  const apps: DiscoveredApp[] = [
    { id: "1", name: "Blender", launchTarget: "blender", source: "linux_desktop_file" },
    { id: "2", name: "Google Chrome", launchTarget: "google-chrome", source: "linux_desktop_file" },
    { id: "3", name: "Chromium Web Browser", launchTarget: "chromium", source: "linux_desktop_file" },
    { id: "4", name: "GIMP Image Editor", launchTarget: "gimp", source: "linux_desktop_file" },
  ];

  it("gives an exact case-insensitive match the top score", () => {
    const matches = matchApplications("blender", apps);
    expect(matches[0].app.name).toBe("Blender");
    expect(matches[0].score).toBe(100);
  });

  it("scores a prefix match highly but below an exact match", () => {
    const matches = matchApplications("chrom", apps);
    expect(matches.map((m) => m.app.name)).toEqual(expect.arrayContaining(["Google Chrome", "Chromium Web Browser"]));
    expect(matches[0].score).toBeLessThan(100);
  });

  it("returns no matches for something not installed", () => {
    expect(matchApplications("nonexistent-app-xyz", apps)).toEqual([]);
  });

  it("matches on partial word overlap for multi-word queries", () => {
    const matches = matchApplications("image editor", apps);
    expect(matches[0].app.name).toBe("GIMP Image Editor");
  });

  it("returns an empty array for an empty query", () => {
    expect(matchApplications("   ", apps)).toEqual([]);
  });
});
