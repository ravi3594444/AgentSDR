import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attentionText, railLabel } from "./sidebarRail";

describe("railLabel: what the collapsed rail says for an entry", () => {
  test("an entry with nothing waiting is its label", () => {
    expect(railLabel("Inbox", 0)).toBe("Inbox");
    expect(railLabel("Inbox", null)).toBe("Inbox");
    expect(railLabel("Inbox", undefined)).toBe("Inbox");
  });

  test("an entry with something waiting says how much, as the expanded sidebar's count does", () => {
    expect(railLabel("Inbox", 3)).toBe("Inbox, 3 need attention");
    expect(railLabel("Settings", 1)).toBe("Settings, 1 needs attention");
    expect(railLabel("Inbox", 1500)).toBe("Inbox, 999+ need attention");
  });

  test("attentionText alone, for the dot that has no visible number", () => {
    expect(attentionText(2)).toBe("2 need attention");
    expect(attentionText(0)).toBe("");
  });
});

const sidebar = readFileSync(join(import.meta.dir, "..", "Sidebar.tsx"), "utf8");

describe("the desktop sidebar's collapse control (P06)", () => {
  test("Collapse and Expand show which way they go: fold and unfold icons, not one shared icon", () => {
    expect(sidebar).toContain("RiSidebarFoldLine");
    expect(sidebar).toContain("RiSidebarUnfoldLine");
    expect(sidebar).not.toContain("RiSideBarLine");
  });

  test("the rail's links and group buttons carry the attention count in their accessible name and tooltip", () => {
    expect(sidebar.match(/railLabel\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(sidebar).not.toMatch(/aria-label=\{link\.label\}/);
    expect(sidebar).not.toMatch(/aria-label=\{group\.label\}/);
  });

  test("the width animates only after the stored choice has been applied, not on every load", () => {
    expect(sidebar).toMatch(/animateWidth && "transition-\[width\]/);
    expect(sidebar).not.toMatch(/"border-r border-stroke-soft-200 transition-\[width\] duration-200 ease-out"/);
  });

  test("the choice is still kept in browser storage under the same key", () => {
    expect(sidebar).toContain('const COLLAPSED_KEY = "agentsdr-sidebar-collapsed"');
    expect(sidebar).toContain("writeStorage(COLLAPSED_KEY");
  });
});
