import { describe, expect, test } from "bun:test";
import { defaultFeatureState } from "@/lib/features/catalog";
import { SETTINGS_NAV, visibleSettingsNav } from "@/components/settings/settingsNav";
import { activeHref, NAV_SECTIONS, paletteItems, visibleNavSections } from "./navConfig";

const instagramOn = { ...defaultFeatureState(), instagram: true };

function hrefs(sections: ReturnType<typeof visibleNavSections>): string[] {
  return sections.flatMap((section) => section.entries.flatMap((entry) => (entry.kind === "group" ? entry.children.map((child) => child.href) : [entry.href])));
}

describe("navigation tied to optional features", () => {
  test("with Instagram off, or not known yet, the sidebar is exactly the navigation without it", () => {
    const withoutFeatures = NAV_SECTIONS
      .map((section) => ({ ...section, entries: section.entries.filter((entry) => !entry.feature) }))
      .filter((section) => section.entries.length > 0);
    expect(visibleNavSections(null)).toEqual(withoutFeatures);
    expect(visibleNavSections(defaultFeatureState())).toEqual(withoutFeatures);
    expect(hrefs(visibleNavSections(null))).not.toContain("/instagram/messages");
  });

  test("with Instagram on, the sidebar has Instagram → Messages", () => {
    const group = visibleNavSections(instagramOn).flatMap((section) => section.entries).find((entry) => entry.kind === "group" && entry.id === "instagram");
    expect(group?.kind === "group" && group.children.map((child) => child.href)).toEqual(["/instagram/messages"]);
  });

  test("the settings rail shows the Instagram row only while the feature is on", () => {
    const rows = (features: Parameters<typeof visibleSettingsNav>[0]) => visibleSettingsNav(features).flatMap((group) => group.items.map((item) => item.href));
    expect(rows(null)).not.toContain("/settings/instagram-accounts");
    expect(rows(defaultFeatureState())).toEqual(SETTINGS_NAV.flatMap((group) => group.items.filter((item) => !item.feature).map((item) => item.href)));
    expect(rows(instagramOn)).toContain("/settings/instagram-accounts");
  });

  test("the ⌘K palette follows the same rule", () => {
    const off = paletteItems(null).map((item) => item.href);
    expect(off).not.toContain("/instagram/messages");
    expect(off).not.toContain("/settings/instagram-accounts");
    expect(paletteItems()).toEqual(paletteItems(defaultFeatureState()));
    const on = paletteItems(instagramOn).map((item) => item.href);
    expect(on).toContain("/instagram/messages");
    expect(on).toContain("/settings/instagram-accounts");
  });
});

test("reporting bookmarks share Overview, while lead records and contacts keep their workspace", () => {
  expect(activeHref("/analytics")).toBe("/assistant/results");
  expect(activeHref("/assistant/results")).toBe("/assistant/results");
  expect(activeHref("/leads")).toBe("/crm/pipeline");
  expect(activeHref("/crm/records/example")).toBe("/crm/pipeline");
  expect(activeHref("/crm/actions")).toBe("/crm/actions");
});

test("Activity is reachable from every page, with the new-replies badge, whatever features are on", () => {
  for (const features of [null, instagramOn]) {
    const entries = visibleNavSections(features).flatMap((section) => section.entries);
    const activity = entries.flatMap((entry) => (entry.kind === "group" ? [] : [entry])).find((entry) => entry.href === "/activity");
    expect(activity?.badge).toBe("newReplies");
  }
  expect(activeHref("/activity")).toBe("/activity");
  expect(paletteItems().map((item) => item.href)).toContain("/activity");
});
