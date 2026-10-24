import { describe, expect, test } from "bun:test";
import { defaultFeatureState } from "@/lib/features/catalog";
import { SETTINGS_NAV, visibleSettingsNav } from "@/components/settings/settingsNav";
import { activeHref, NAV_FOOTER, NAV_SECTIONS, paletteItems, visibleNavSections } from "./navConfig";

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

  test("all channels share one Inbox destination, including when Instagram is enabled", () => {
    for (const features of [null, defaultFeatureState(), instagramOn]) {
      const links = hrefs(visibleNavSections(features));
      expect(links.filter((href) => href === "/inbox")).toEqual(["/inbox"]);
      for (const href of ["/outreach/inbox", "/linkedin/messages", "/calling/messages", "/instagram/messages"]) expect(links).not.toContain(href);
    }
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
    expect(on).not.toContain("/instagram/messages");
    expect(on).toContain("/settings/instagram-accounts");
  });
});

test("three destinations come first: Outreach, Inbox with the one Needs you badge, Leads", () => {
  const [main, advanced] = NAV_SECTIONS;
  expect(main?.label).toBeUndefined();
  expect(main?.entries.map((entry) => (entry.kind === "link" ? [entry.href, entry.label, entry.badge ?? null] : entry.id))).toEqual([
    ["/assistant", "Outreach", null],
    ["/inbox", "Inbox", "inbox"],
    ["/leads", "Leads", null],
  ]);
  expect(advanced?.label).toBe("Advanced");
  expect(advanced?.collapsible).toBe(true);
  expect(NAV_FOOTER.map((entry) => (entry.kind === "link" ? entry.label : entry.id))).toEqual(["Getting started", "Settings"]);
});

test("manual campaign tools stay under Advanced without duplicate inbox destinations", () => {
  const all = hrefs(visibleNavSections(instagramOn));
  for (const href of ["/outreach/campaigns", "/linkedin/campaigns", "/whatsapp/campaigns", "/crm/sequences", "/linkedin/connections", "/linkedin/jobs", "/linkedin/webhooks"]) {
    expect(all).toContain(href);
  }
  expect(new Set(all).size).toBe(all.length);
  // The board lives inside Leads now; the old duplicate entries are gone.
  expect(all).not.toContain("/crm/pipeline");
  expect(all).not.toContain("/crm/actions");
});

test("old and new paths light up the destination they now belong to", () => {
  expect(activeHref("/assistant")).toBe("/assistant");
  expect(activeHref("/assistant/results")).toBe("/assistant");
  expect(activeHref("/activity")).toBe("/assistant");
  expect(activeHref("/analytics")).toBe("/assistant");
  expect(activeHref("/inbox")).toBe("/inbox");
  expect(activeHref("/crm/actions")).toBe("/inbox");
  expect(activeHref("/leads")).toBe("/leads");
  expect(activeHref("/leads/companies")).toBe("/leads");
  expect(activeHref("/crm/pipeline")).toBe("/leads");
  expect(activeHref("/crm/records/example")).toBe("/leads");
  for (const path of ["/outreach/inbox", "/linkedin/messages", "/calling/messages", "/instagram/messages"]) expect(activeHref(path)).toBe("/inbox");
  expect(activeHref("/whatsapp/campaigns/abc")).toBe("/whatsapp/campaigns");
});

test("the palette reaches the views inside the destinations", () => {
  const items = paletteItems().map((item) => item.href);
  expect(items).toEqual(expect.arrayContaining(["/inbox?view=needs_you", "/inbox?view=all", "/leads?view=board", "/assistant"]));
});
