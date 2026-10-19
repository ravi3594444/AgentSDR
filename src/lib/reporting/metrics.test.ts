import { describe, expect, test } from "bun:test";

import {
  assemblePeriodMetrics,
  dayStart,
  daysWindow,
  leadSourceKey,
  leadSourceLabel,
  localDate,
  METRICS,
  presetDays,
  presetWindow,
  replyRate,
  shiftDate,
  summarizeLeadSources,
  type MetricRow,
} from "./metrics";

const iso = (date: Date | null) => date?.toISOString() ?? null;

describe("the business's calendar", () => {
  test("a local day starts at local midnight, as an instant", () => {
    expect(dayStart("2026-10-19", "Asia/Kolkata").toISOString()).toBe("2026-10-18T18:30:00.000Z");
    expect(dayStart("2026-10-19", "UTC").toISOString()).toBe("2026-10-19T00:00:00.000Z");
  });

  test("the day it is depends on the zone, not on UTC", () => {
    // 20:00 UTC on the 18th is already the 19th in Kolkata (UTC+5:30).
    expect(localDate("Asia/Kolkata", new Date("2026-10-18T20:00:00Z"))).toBe("2026-10-19");
    expect(localDate("UTC", new Date("2026-10-18T20:00:00Z"))).toBe("2026-10-18");
  });

  test("shifting a date crosses months and years", () => {
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDate("2025-12-31", 1)).toBe("2026-01-01");
  });

  test("a range of days is [first day 00:00, the day after the last 00:00)", () => {
    const window = daysWindow({ from: "2026-10-13", to: "2026-10-19" }, "Asia/Kolkata");
    expect(iso(window.from)).toBe("2026-10-12T18:30:00.000Z");
    expect(iso(window.to)).toBe("2026-10-19T18:30:00.000Z");
    expect(window.timeZone).toBe("Asia/Kolkata");
  });

  test("across a daylight-saving change a day is 23 or 25 hours, still midnight to midnight", () => {
    // London leaves summer time on 25 October 2026.
    const window = daysWindow({ from: "2026-10-25", to: "2026-10-25" }, "Europe/London");
    expect(iso(window.from)).toBe("2026-10-24T23:00:00.000Z");
    expect(iso(window.to)).toBe("2026-10-26T00:00:00.000Z");
  });
});

describe("shared presets", () => {
  test("map to inclusive local days", () => {
    expect(presetDays("today", "2026-10-19")).toEqual({ from: "2026-10-19", to: "2026-10-19" });
    expect(presetDays("yesterday", "2026-10-19")).toEqual({ from: "2026-10-18", to: "2026-10-18" });
    expect(presetDays("last_7_days", "2026-10-19")).toEqual({ from: "2026-10-13", to: "2026-10-19" });
    expect(presetDays("last_30_days", "2026-10-19")).toEqual({ from: "2026-09-20", to: "2026-10-19" });
  });

  test("near midnight UTC an Asia/Kolkata business is already on its next day", () => {
    // 23:50 UTC on the 18th is 05:20 on the 19th in Kolkata.
    const today = presetWindow("today", "Asia/Kolkata", new Date("2026-10-18T23:50:00Z"));
    expect(today.days).toEqual({ from: "2026-10-19", to: "2026-10-19" });
    expect(iso(today.from)).toBe("2026-10-18T18:30:00.000Z");
    expect(iso(today.to)).toBe("2026-10-19T18:30:00.000Z");
  });

  test("a minute before Kolkata's midnight it is still the 18th there", () => {
    // 18:29 UTC on the 18th is 23:59 on the 18th in Kolkata.
    const today = presetWindow("today", "Asia/Kolkata", new Date("2026-10-18T18:29:00Z"));
    expect(today.days).toEqual({ from: "2026-10-18", to: "2026-10-18" });
    expect(iso(today.from)).toBe("2026-10-17T18:30:00.000Z");
    expect(iso(today.to)).toBe("2026-10-18T18:30:00.000Z");
    const week = presetWindow("last_7_days", "Asia/Kolkata", new Date("2026-10-18T18:29:00Z"));
    expect(iso(week.from)).toBe("2026-10-11T18:30:00.000Z");
    expect(iso(week.to)).toBe("2026-10-18T18:30:00.000Z");
  });
});

describe("reply rate", () => {
  test("is replied people over contacted people, and not measured without contacts", () => {
    expect(replyRate(1, 4)).toBe(0.25);
    expect(replyRate(0, 0)).toBeNull();
    expect(replyRate(3, 0)).toBeNull();
  });
});

describe("assemblePeriodMetrics", () => {
  const rows: MetricRow[] = [
    // Sends: per channel and kind, per channel, and the total (people deduplicated in SQL).
    { section: "send", channel: "email", kind: "message", n: 3, people: 2, delivered: 0, read: 0 },
    { section: "send", channel: "email", kind: null, n: 3, people: 2, delivered: 0, read: 0 },
    { section: "send", channel: "whatsapp", kind: "message", n: 2, people: 2, delivered: 2, read: 1 },
    { section: "send", channel: "whatsapp", kind: null, n: 2, people: 2, delivered: 2, read: 1 },
    { section: "send", channel: "linkedin", kind: "invitation", n: 1, people: 1, delivered: 0, read: 0 },
    { section: "send", channel: "linkedin", kind: "message", n: 2, people: 1, delivered: 0, read: 0 },
    { section: "send", channel: "linkedin", kind: null, n: 3, people: 1, delivered: 0, read: 0 },
    { section: "send", channel: null, kind: null, n: 8, people: 4, delivered: 2, read: 1 },
    { section: "reply", channel: "email", kind: null, n: 2, people: 1, delivered: 0, read: 0 },
    { section: "reply", channel: "instagram", kind: null, n: 1, people: 1, delivered: 0, read: 0 },
    { section: "reply", channel: null, kind: null, n: 3, people: 2, delivered: 0, read: 0 },
    { section: "replied_after", channel: "email", kind: null, n: 1, people: 1, delivered: 0, read: 0 },
    { section: "replied_after", channel: null, kind: null, n: 1, people: 1, delivered: 0, read: 0 },
  ];
  const metrics = assemblePeriodMetrics(rows);

  test("sent counts provider-accepted sends per channel, LinkedIn invitations apart from messages", () => {
    expect(metrics.sent).toEqual({
      total: 8,
      byChannel: { email: 3, whatsapp: 2, linkedin: 3, instagram: 0 },
      linkedinInvitations: 1,
      linkedinMessages: 2,
    });
  });

  test("delivery and read receipts exist only where the channel reports them", () => {
    expect(metrics.delivered.byChannel).toEqual({ email: null, whatsapp: 2, linkedin: null, instagram: null });
    expect(metrics.read.byChannel).toEqual({ email: null, whatsapp: 1, linkedin: null, instagram: null });
    expect(metrics.delivered.total).toBe(2);
  });

  test("people are distinct per channel and across channels", () => {
    expect(metrics.peopleContacted).toEqual({ total: 4, byChannel: { email: 2, whatsapp: 2, linkedin: 1, instagram: 0 } });
    expect(metrics.replies).toEqual({ total: 3, byChannel: { email: 2, whatsapp: 0, linkedin: 0, instagram: 1 } });
    expect(metrics.peopleReplied).toEqual({ total: 2, byChannel: { email: 1, whatsapp: 0, linkedin: 0, instagram: 1 } });
  });

  test("reply rate uses contacted people who replied after their first send", () => {
    expect(metrics.contactedWhoReplied.total).toBe(1);
    expect(metrics.replyRate.total).toBe(0.25);
    expect(metrics.replyRate.byChannel).toEqual({ email: 0.5, whatsapp: 0, linkedin: 0, instagram: null });
  });

  test("no rows is zeros, and rates not measured", () => {
    const empty = assemblePeriodMetrics([]);
    expect(empty.sent.total).toBe(0);
    expect(empty.replyRate.total).toBeNull();
    expect(empty.delivered.byChannel.whatsapp).toBe(0);
    expect(empty.delivered.byChannel.email).toBeNull();
  });
});

describe("lead sources", () => {
  test("are labelled source through provider", () => {
    expect(leadSourceLabel(leadSourceKey("google_maps", "scraper"))).toBe("Google Maps through the built-in scraper");
    expect(leadSourceLabel(leadSourceKey("google_maps", "apify"))).toBe("Google Maps through Apify");
    expect(leadSourceLabel(leadSourceKey("apify_instagram", null))).toBe("Instagram through Apify");
    expect(leadSourceLabel(leadSourceKey("web_search", "tinyfish"))).toBe("Website search through TinyFish");
    expect(leadSourceLabel(leadSourceKey("discovery:web-search", "tavily"))).toBe("Website search through Tavily");
    expect(leadSourceLabel(leadSourceKey("linkedin_search", null))).toBe("LinkedIn search through Unipile");
    expect(leadSourceLabel(leadSourceKey("list", null))).toBe("Your list");
    expect(leadSourceLabel(leadSourceKey("google_maps", null))).toBe("Google Maps");
    expect(leadSourceLabel(leadSourceKey("mystery_source", null))).toBe("Mystery source");
  });

  test("a person found by two sources counts once in the total and is listed under both", () => {
    const maps = leadSourceKey("google_maps", "scraper");
    const instagram = leadSourceKey("apify_instagram", "apify");
    const summary = summarizeLeadSources({
      combinations: [
        { sources: [maps], people: 3, contactable: 2 },
        { sources: [instagram], people: 1, contactable: 0 },
        { sources: [instagram, maps], people: 1, contactable: 1 },
      ],
      unsaved: [{ source: maps, count: 2 }],
      examples: [{ name: "Asha Salon", sources: [maps, instagram] }],
    });
    expect(summary.rows).toEqual([
      { key: maps, label: "Google Maps through the built-in scraper", found: 6, qualified: 4, contactable: 3, alsoFoundElsewhere: 1 },
      { key: instagram, label: "Instagram through Apify", found: 2, qualified: 2, contactable: 1, alsoFoundElsewhere: 1 },
    ]);
    expect(summary.total).toEqual({ found: 7, qualified: 5, contactable: 3 });
    expect(summary.multiSource).toEqual({
      people: 1,
      examples: [{ name: "Asha Salon", sources: ["Google Maps through the built-in scraper", "Instagram through Apify"] }],
    });
  });

  test("a source that saved nobody is still shown", () => {
    const summary = summarizeLeadSources({ combinations: [], unsaved: [{ source: "web_search:tinyfish", count: 4 }], examples: [] });
    expect(summary.rows).toEqual([{ key: "web_search:tinyfish", label: "Website search through TinyFish", found: 4, qualified: 0, contactable: 0, alsoFoundElsewhere: 0 }]);
    expect(summary.total).toEqual({ found: 4, qualified: 0, contactable: 0 });
  });

  test("nothing found is no sources", () => {
    expect(summarizeLeadSources({ combinations: [], unsaved: [], examples: [] })).toEqual({ rows: [], total: { found: 0, qualified: 0, contactable: 0 }, multiSource: { people: 0, examples: [] } });
  });
});

describe("definitions", () => {
  test("current counts are labelled as now, period figures as the period", () => {
    expect(METRICS.needsYouNow.kind).toBe("now");
    expect(METRICS.actionRequiredNow.kind).toBe("now");
    expect(METRICS.sent.kind).toBe("period");
    expect(METRICS.replyRate.kind).toBe("period");
  });

  test("a send is one the provider accepted, never an uncertain one", () => {
    expect(METRICS.sent.definition).toMatch(/accepted/);
    expect(METRICS.sent.definition).toMatch(/uncertain/);
  });
});
