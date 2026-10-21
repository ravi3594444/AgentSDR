import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defaultFeatureState } from "@/lib/features/catalog";
import { resolveLegacyRoute, withQuery } from "@/lib/nav/legacyRoutes";
import { itemPages, SETTINGS_HOME, SETTINGS_NAV, visibleSettingsNav } from "./settingsNav";

const APP = join(import.meta.dir, "../../app");
const everything = { ...defaultFeatureState(), instagram: true, inquiry_intake: true };
const pages = (nav: typeof SETTINGS_NAV) => nav.flatMap((group) => group.items.flatMap((item) => itemPages(item).map((page) => page.href)));

/** Every settings page before the regrouping (navigation rework N3), General and the per-channel sending rules aside. */
const OLD_PAGES = [
  "/settings/members", "/settings/teams",
  "/settings/email-accounts", "/settings/email-connection",
  "/settings/linkedin-accounts", "/settings/linkedin-connection",
  "/settings/whatsapp-accounts", "/settings/whatsapp-connection",
  "/settings/instagram-accounts",
  "/settings/instructions", "/settings/knowledge", "/settings/ai",
  "/settings/lead-categories", "/settings/columns", "/settings/inquiries", "/settings/appearance",
];

/** The per-channel pacing pages: their limits are automatic now, and each address opens the daily lead limit. */
const RETIRED_RULE_PAGES = ["email-rules", "linkedin-rules", "whatsapp-rules", "instagram-rules"];

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

  test("every old page is still listed, exactly once, and General and the per-channel rules are folded away", () => {
    const all = pages(SETTINGS_NAV);
    for (const href of OLD_PAGES) expect(all.filter((page) => page === href)).toEqual([href]);
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain("/settings/organization");
    for (const name of RETIRED_RULE_PAGES) expect(all).not.toContain(`/settings/${name}`);
    expect(all.sort()).toEqual([...OLD_PAGES, "/settings/business", "/settings/sending", "/settings/research", "/settings/advanced"].sort());
  });

  test("each group holds what the plan put there", () => {
    const group = (label: string) => pages(SETTINGS_NAV.filter((g) => g.label === label));
    expect(group("Your business")).toEqual(["/settings/business", "/settings/members", "/settings/teams", "/settings/instructions", "/settings/knowledge"]);
    expect(group("Connected accounts")).toEqual([
      "/settings/email-accounts", "/settings/email-connection", "/settings/linkedin-accounts", "/settings/linkedin-connection",
      "/settings/whatsapp-accounts", "/settings/whatsapp-connection", "/settings/instagram-accounts", "/settings/ai",
    ]);
    // The one visible sending input: everything else that paces sending is automatic.
    expect(group("Sending & automation")).toEqual(["/settings/sending"]);
    expect(SETTINGS_NAV.find((g) => g.label === "Sending & automation")!.items[0]!.label).toBe("Daily lead limit");
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

describe("the retired per-channel sending rules pages", () => {
  for (const name of RETIRED_RULE_PAGES) {
    test(`/settings/${name} opens the daily lead limit, keeping the query, as a page or a pop-up`, () => {
      expect(resolveLegacyRoute(`/settings/${name}`)).toBe("/settings/sending");
      expect(resolveLegacyRoute(`/settings/${name}?from=readiness&ids=1`)).toBe("/settings/sending?from=readiness&ids=1");
      // The redirect (next.config.ts) runs before routing, so no page or pop-up twin is left behind it.
      expect(existsSync(join(APP, "settings", name))).toBe(false);
      expect(existsSync(join(APP, "@modal", "(.)settings", name))).toBe(false);
    });
  }
});

describe("rows behind an optional feature", () => {
  test("Instagram's row and Inquiries show only while their feature is on", () => {
    const shown = (features: Parameters<typeof visibleSettingsNav>[0]) => pages(visibleSettingsNav(features));
    for (const features of [null, defaultFeatureState()]) {
      expect(shown(features)).not.toContain("/settings/instagram-accounts");
      expect(shown(features)).not.toContain("/settings/inquiries");
    }
    expect(shown({ ...defaultFeatureState(), instagram: true })).toEqual(expect.arrayContaining(["/settings/instagram-accounts"]));
    expect(shown({ ...defaultFeatureState(), instagram: true })).not.toContain("/settings/inquiries");
    expect(shown(everything)).toEqual(pages(SETTINGS_NAV));
  });

  test("no group is left empty, and the groups keep their order", () => {
    expect(visibleSettingsNav(null).map((group) => group.label)).toEqual(SETTINGS_NAV.map((group) => group.label));
  });
});
