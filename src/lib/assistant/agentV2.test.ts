import { describe, expect, test } from "bun:test";
import { defaultFeatureState } from "@/lib/features/catalog";
import { transcriptText, type TranscriptMessage } from "./agent";
import { progressBlock, requestBlock, startedNotFinishedClaim, systemPromptV2, transcriptV2, withoutContactAfter } from "./agentV2";
import { EMPTY_FUNNEL } from "./leadFit";

const row = (role: TranscriptMessage["role"], content: string, tool: string | null = null): TranscriptMessage => ({ role, content, tool, toolInput: tool ? { url: "https://example.com" } : null, toolResult: tool ? { summary: content } : null, status: tool ? "ok" : null, attachments: [] });

describe("what the model reads", () => {
  test("the owner's request survives many page reads (v1 lost it after four)", () => {
    const page = (n: number) => row("tool", `Read https://site${n}.example/ — ${"page text ".repeat(500)}`, "read_webpage");
    const messages = [row("user", "Find 10 wedding photographers in Austin and email them"), row("assistant", "Searching the web."), page(1), page(2), page(3), page(4), page(5), page(6)];
    expect(transcriptText(messages)).not.toContain("Find 10 wedding photographers");
    const v2 = transcriptV2(messages);
    expect(v2).toContain("OWNER: Find 10 wedding photographers in Austin and email them");
    // The newest three pages whole, older ones cut.
    expect(v2.match(/… \(cut\)/g)?.length).toBe(3);
  });

  test("over budget, old lines go before owner messages", () => {
    const messages = [row("user", "first request"), ...Array.from({ length: 40 }, (_, index) => row("event", `event ${index} ${"x".repeat(200)}`)), row("user", "latest message")];
    const text = transcriptV2(messages, 3_000);
    expect(text).toContain("OWNER: first request");
    expect(text).toContain("OWNER: latest message");
    expect(text).toContain("(earlier conversation omitted)");
  });

  test("the request block pins every owner message and asks for a brief until there is one", () => {
    const block = requestBlock({ ownerMessages: ["Find 10 hair salons on Instagram and DM them", "Miami."], brief: null, controls: null, status: null });
    expect(block).toContain("1. Find 10 hair salons on Instagram and DM them");
    expect(block).toContain("2. Miami.");
    expect(block).toContain("Call set_brief before the first search");
  });

  test("progress lists the searches that ran so none is repeated", () => {
    const text = progressBlock({ funnel: { ...EMPTY_FUNNEL, found: 12, contactable: 9, qualified: 4 }, sources: [], searches: [{ tool: "discovery", what: "dentists New York", status: "succeeded", found: 12, contactable: 9 }], spentUsd: 0, spendCapUsd: 0, msLeft: 3_600_000, plans: [] });
    expect(text).toContain("12 found, 9 contactable; 4 match");
    expect(text).toContain("discovery “dentists New York” succeeded, 12 found, 9 contactable");
    expect(text).toContain("free sources only");
  });
});

describe("the harness keeps only what protects", () => {
  test("search tools lose the automatic plan in v2", () => {
    expect(withoutContactAfter("what (kind), where (city), contactAfter (true only when …), channels (optional, with contactAfter: …)")).toBe("what (kind), where (city)");
    expect(withoutContactAfter("usernames (array); listName (optional); contactAfter (optional boolean)")).toBe("usernames (array); listName (optional)");
    expect(withoutContactAfter("keywords (…), maxResults (5-200)")).toBe("keywords (…), maxResults (5-200)");
  });

  test("a message sent with searches it only starts may not report their results", () => {
    const startsJobs = (tool: string) => tool === "find_leads";
    expect(startedNotFinishedClaim("I found 20 salons in Miami and will DM them.", [{ tool: "find_leads" }], startsJobs)).toContain("only start now");
    expect(startedNotFinishedClaim("Searching Google Maps for salons in Miami.", [{ tool: "find_leads" }], startsJobs)).toBeNull();
    expect(startedNotFinishedClaim("I found 20 salons.", [{ tool: "review_leads" }], startsJobs)).toBeNull();
  });

  test("the prompt teaches the method and the limits, not scenarios", () => {
    const prompt = systemPromptV2({ features: defaultFeatureState(), catalog: "- set_brief: …", autonomy: null });
    expect(prompt).toContain("set_brief before the first search");
    expect(prompt).toContain("finish_request");
    expect(prompt).not.toContain("contactAfter");
    expect(prompt).not.toContain("AUTONOMOUS MODE");
    // The owner's place holds outside Autonomous mode too.
    expect(prompt).toContain("a neighbouring city, a suburb or the wider area is another place");
    const autonomous = systemPromptV2({ features: defaultFeatureState(), catalog: "", autonomy: { runsPerDay: 2, leadsPerDay: 50, searchesPerDay: 10 } });
    expect(autonomous).toContain("AUTONOMOUS MODE IS ON");
    expect(autonomous).toContain("Widen nothing the owner named");
  });
});

describe("a quote is matched as read", () => {
  test("HTML entities, curly quotes and spacing do not hide it", async () => {
    const { quoteText } = await import("./agentV2.server");
    expect(quoteText("<h3>Priya Raman</h3><p>Co-founder &amp; CTO</p>")).toContain(quoteText("Co-founder & CTO"));
    expect(quoteText("We’re   in  Brickell")).toBe(quoteText("We're in Brickell"));
  });
});
