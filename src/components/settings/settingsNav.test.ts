import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defaultFeatureState } from "@/lib/features/catalog";
import { withQuery } from "@/lib/nav/legacyRoutes";
import { itemPages, SETTINGS_HOME, SETTINGS_NAV, visibleSettingsNav } from "./settingsNav";

const APP = join(import.meta.dir, "../../app");
const everything = { ...defaultFeatureState(), instagram: true, inquiry_intake: true };
const pages = (nav: typeof SETTINGS_NAV) => nav.flatMap((group) => group.items.flatMap((item) => itemPages(item).map((page) => page.href)));

/** Every settings page before the regrouping (navigation rework N3), General aside. */
const OLD_PAGES = [
  "/settings/members", "/settings/teams",
  "/settings/email-accounts", "/settings/email-connection", "/settings/email-rules",
  "/settings/linkedin-accounts", "/settings/linkedin-connection", "/settings/linkedin-rules",
  "/settings/whatsapp-accounts", "/settings/whatsapp-connection", "/settings/whatsapp-rules",
  "/settings/instagram-accounts", "/settings/instagram-rules",
  "/settings/instructions", "/settings/knowledge", "/settings/ai",
  "/settings/lead-categories", "/settings/columns", "/settings/inquiries", "/settings/appearance",
];

describe("the settings rail", () => {
  test("five groups, in order", () => {
    expect(SETTINGS_NAV.map((group) => group.label)).toEqual(["Your business", "Connected accounts", "Sending & automation", "Research & budget", "Advanced"]);
    expect(SETTINGS_NAV.map((group) => group.items[0]?.href)).toEqual(["/settings/business", "/settings/email-accounts", "/settings/sending", "/settings/research", "/settings/advanced"]);
  });

  test("Settings opens Your business", () => {
    expect(SETTINGS_HOME).toBe("/settings/business");
    // /settings and /settings/organization redirect there with their query.
    expect(withQuery(SETTINGS_HOME, { tab: "x", ids: ["1", "2"] })).toBe("/settings/business?tab=x&ids=1&ids=2");
  });

  test("every old page is still listed, exactly once, and General is folded away", () => {
    const all = pages(SETTINGS_NAV);
    for (const href of OLD_PAGES) expect(all.filter((page) => page === href)).toEqual([href]);
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain("/settings/organization");
    expect(all.sort()).toEqual([...OLD_PAGES, "/settings/business", "/settings/sending", "/settings/research", "/settings/advanced"].sort());
  });

  test("each group holds what the plan put there", () => {
    const group = (label: string) => pages(SETTINGS_NAV.filter((g) => g.label === label));
    expect(group("Your business")).toEqual(["/settings/business", "/settings/members", "/settings/teams", "/settings/instructions", "/settings/knowledge"]);
    expect(group("Connected accounts")).toEqual([
      "/settings/email-accounts", "/settings/email-connection", "/settings/linkedin-accounts", "/settings/linkedin-connection",
      "/settings/whatsapp-accounts", "/settings/whatsapp-connection", "/settings/instagram-accounts", "/settings/ai",
    ]);
    expect(group("Sending & automation")).toEqual(["/settings/sending", "/settings/email-rules", "/settings/linkedin-rules", "/settings/whatsapp-rules", "/settings/instagram-rules"]);
    expect(group("Research & budget")).toEqual(["/settings/research"]);
    expect(group("Advanced")).toEqual(["/settings/advanced", "/settings/lead-categories", "/settings/columns", "/settings/inquiries", "/settings/appearance"]);
  });

  test("row labels are unique, so the phone strip and ⌘K never show two of the same", () => {
    const labels = SETTINGS_NAV.flatMap((group) => group.items.map((item) => item.label));
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("every listed page has its route and its pop-up twin", () => {
    for (const href of pages(SETTINGS_NAV)) {
      const name = href.replace("/settings/", "");
      expect(existsSync(join(APP, "settings", name, "page.tsx"))).toBe(true);
      expect(existsSync(join(APP, "@modal", "(.)settings", name, "page.tsx"))).toBe(true);
    }
  });
});

describe("rows behind an optional feature", () => {
  test("Instagram's two rows and Inquiries show only while their feature is on", () => {
    const shown = (features: Parameters<typeof visibleSettingsNav>[0]) => pages(visibleSettingsNav(features));
    for (const features of [null, defaultFeatureState()]) {
      expect(shown(features)).not.toContain("/settings/instagram-accounts");
      expect(shown(features)).not.toContain("/settings/instagram-rules");
      expect(shown(features)).not.toContain("/settings/inquiries");
    }
    expect(shown({ ...defaultFeatureState(), instagram: true })).toEqual(expect.arrayContaining(["/settings/instagram-accounts", "/settings/instagram-rules"]));
    expect(shown({ ...defaultFeatureState(), instagram: true })).not.toContain("/settings/inquiries");
    expect(shown(everything)).toEqual(pages(SETTINGS_NAV));
  });

  test("no group is left empty, and the groups keep their order", () => {
    expect(visibleSettingsNav(null).map((group) => group.label)).toEqual(SETTINGS_NAV.map((group) => group.label));
  });
});
