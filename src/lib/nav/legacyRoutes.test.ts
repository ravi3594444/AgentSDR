import { describe, expect, test } from "bun:test";
import { LEGACY_REDIRECTS, resolveLegacyRoute, withQuery } from "./legacyRoutes";

describe("old links open the page that replaced them, ids and filters kept", () => {
  test("Action required and its views open the Inbox", () => {
    expect(resolveLegacyRoute("/crm/actions")).toBe("/inbox?view=needs_you");
    expect(resolveLegacyRoute("/crm/actions?view=actions&category=interested&group=reply")).toBe("/inbox?view=needs_you&category=interested&group=reply");
    expect(resolveLegacyRoute("/crm/actions?view=needs_you&channel=email")).toBe("/inbox?view=needs_you&channel=email");
    expect(resolveLegacyRoute("/crm/actions?view=replies&channel=whatsapp")).toBe("/inbox?view=all&channel=whatsapp");
    expect(resolveLegacyRoute("/crm/actions?record=1b2c&view=replies")).toBe("/inbox?record=1b2c&view=all");
  });

  test("Activity's Replies tab opens All conversations with its channel; its work list opens Requests", () => {
    expect(resolveLegacyRoute("/activity?view=replies&channel=linkedin")).toBe("/inbox?view=all&channel=linkedin");
    expect(resolveLegacyRoute("/activity")).toBe("/assistant/requests");
    expect(resolveLegacyRoute("/activity?view=work")).toBe("/assistant/requests?view=work");
  });

  test("Analytics opens Reports with its view, range and time zone", () => {
    expect(resolveLegacyRoute("/analytics")).toBe("/assistant/reports");
    expect(resolveLegacyRoute("/analytics?view=whatsapp&range=30d&tz=Asia%2FKolkata")).toBe("/assistant/reports?view=whatsapp&range=30d&tz=Asia%2FKolkata");
  });

  test("the pipeline board opens inside Leads", () => {
    expect(resolveLegacyRoute("/crm/pipeline")).toBe("/leads?view=board");
    expect(resolveLegacyRoute("/crm/pipeline?stage=waiting&channel=email")).toBe("/leads?stage=waiting&channel=email&view=board");
  });

  test("section overviews and single-page sections keep their query too", () => {
    expect(resolveLegacyRoute("/crm?range=7d")).toBe("/assistant/reports?range=7d");
    expect(resolveLegacyRoute("/calling?range=30d")).toBe("/assistant/reports?range=30d&view=whatsapp");
    expect(resolveLegacyRoute("/linkedin")).toBe("/assistant/reports?view=linkedin");
    expect(resolveLegacyRoute("/instagram?chat=abc123")).toBe("/instagram/messages?chat=abc123");
    expect(resolveLegacyRoute("/linkedin/leads?q=ana")).toBe("/leads?q=ana");
  });

  test("pages that kept their address are not redirected", () => {
    for (const path of ["/inbox", "/leads", "/assistant", "/assistant/requests", "/assistant/reports", "/assistant/results", "/crm/records/abc", "/crm/sequences", "/calling/campaigns", "/linkedin/campaigns", "/instagram/messages"]) {
      expect(resolveLegacyRoute(path)).toBeNull();
    }
  });

  test("a has-condition rule sits above the plain rule for the same path", () => {
    LEGACY_REDIRECTS.forEach((rule, index) => {
      if (!rule.has) return;
      const plain = LEGACY_REDIRECTS.findIndex((other) => other.source === rule.source && !other.has);
      expect(plain === -1 || plain > index).toBe(true);
    });
    expect(LEGACY_REDIRECTS.every((rule) => rule.permanent === false)).toBe(true);
  });
});

test("withQuery appends a page redirect's query, repeated keys included", () => {
  expect(withQuery("/calling/campaigns/x", {})).toBe("/calling/campaigns/x");
  expect(withQuery("/calling/campaigns/x", { tab: "leads", undef: undefined })).toBe("/calling/campaigns/x?tab=leads");
  expect(withQuery("/leads?view=board", new URLSearchParams("channel=email&channel=whatsapp"))).toBe("/leads?view=board&channel=email&channel=whatsapp");
  expect(withQuery("/a", { ids: ["1", "2"] })).toBe("/a?ids=1&ids=2");
});
