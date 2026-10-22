import { describe, expect, test } from "bun:test";
import { defaultFeatureState } from "@/lib/features/catalog";
import { transcriptText, type TranscriptMessage } from "./agent";
import { progressBlock, requestBlock, startedNotFinishedClaim, systemPromptV2, transcriptV2, withoutContactAfter } from "./agentV2";
import { EMPTY_FUNNEL } from "./leadFit";

const row = (role: TranscriptMessage["role"], content: string, tool: string | null = null): TranscriptMessage => ({ role, content, tool, toolInput: tool ? { url: "https://example.com" } : null, toolResult: tool ? { summary: content } : null, status: tool ? "ok" : null, attachments: [] });

describe("what the model reads", () => {
  test("the owner's request survives many page reads (v1 lost it after four)", () => {
    const page = (n: number) => row("tool", `Read https://site${n}.example/ — ${"page text ".repeat(500)}`, "read_webpage");
    const messages = [row("user", "Find 10 wedding photographers in Austin and email them"), row("assistant", "Searching the web."), ...Array.from({ length: 8 }, (_, index) => page(index + 1))];
    expect(transcriptText(messages)).not.toContain("Find 10 wedding photographers");
    const v2 = transcriptV2(messages);
    expect(v2).toContain("OWNER: Find 10 wedding photographers in Austin and email them");
    // The newest six pages whole, older ones cut.
    expect(v2.match(/… \(cut\)/g)?.length).toBe(2);
    expect(v2).toContain(page(8).content);
  });

  test("a long tool result keeps more than a screen: review_leads and Treg answers are not cut to a few lines", () => {
    const review = row("tool", `Leads: ${"lead line with its evidence ".repeat(200)}`, "review_leads");
    const text = transcriptV2([row("user", "review them"), review]);
    expect(text).toContain("lead line with its evidence ".repeat(150).trim());
  });

  test("with Apify on, Google Maps through Apify covers a region or a country", () => {
    const withApify = systemPromptV2({ features: { ...defaultFeatureState(), apify_discovery: true }, catalog: "", autonomy: null });
    expect(withApify).toContain("with provider 'apify', one Apify run covers a city, a region or a whole country");
    expect(withApify).toContain("hashtags you choose");
    expect(withApify).toContain("or with no place at all");
    expect(systemPromptV2({ features: defaultFeatureState(), catalog: "", autonomy: null })).not.toContain("with provider 'apify'");
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
    expect(block).toContain("BRIEF: none yet (set_brief writes what the owner asked");
  });

  test("progress lists the searches that ran so none is repeated", () => {
    const text = progressBlock({ funnel: { ...EMPTY_FUNNEL, found: 12, contactable: 9, qualified: 4 }, sources: [], searches: [{ tool: "discovery", what: "dentists New York", status: "succeeded", found: 12, contactable: 9 }], spentUsd: 0, spendCapUsd: 0, msLeft: 3_600_000, plans: [] });
    expect(text).toContain("12 found, 9 contactable; 4 match");
    expect(text).toContain("discovery “dentists New York” succeeded, 12 found, 9 contactable");
    expect(text).toContain("Free sources only");
    expect(text).not.toMatch(/\$\d/);
  });

  test("a running search shows what it found so far", () => {
    const text = progressBlock({ funnel: EMPTY_FUNNEL, sources: [], searches: [{ tool: "discovery", what: "cleaning companies Houston", status: "running", found: 50, contactable: null }], spentUsd: 0, spendCapUsd: 5, msLeft: 3_600_000, plans: [] });
    expect(text).toContain("discovery “cleaning companies Houston” running, 50 found");
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
    expect(prompt).toContain("set_brief when you take on a request");
    // Who goes in the plan is the model's choice, not only the judge's matches.
    expect(prompt).toContain("pass leads all");
    expect(prompt).not.toContain("Only leads marked match are contacted");
    expect(prompt).toContain("finish_request");
    expect(prompt).not.toContain("contactAfter");
    expect(prompt).not.toContain("AUTONOMOUS MODE");
    // The owner's place holds outside Autonomous mode too.
    expect(prompt).toContain("a neighbouring city, a suburb or the wider area is another place");
    expect(prompt).toContain("Never ask what the brief already settles");
    // The model chooses its tools (the browser too); none is reserved for one kind of request. The spend cap is the server's.
    expect(prompt).toContain("Choose the tools yourself: any tool in TOOLS");
    expect(prompt).toContain("the browser_* tools");
    // The same search is not run twice; a different query, place, platform or source is a new search.
    expect(prompt).not.toContain("even worded differently");
    expect(prompt).toContain("a narrower, broader or differently worded query");
    // Found contacts are leads too, and the web tools find leads, not only check them.
    expect(prompt).toContain("save the people and businesses a page publishes with add_contacts");
    expect(prompt).not.toContain("for a handful of named leads");
    expect(prompt).not.toContain("does not find these leads");
    expect(prompt).toContain("never ask to raise it");
    // An open niche or place is the model's research, not the profile's.
    expect(prompt).toContain("choosing them is your research");
    expect(prompt).toContain("When the owner names no place, the place is open");
    expect(prompt).not.toContain("usually means their target customers");
    const autonomous = systemPromptV2({ features: defaultFeatureState(), catalog: "", autonomy: { runsPerDay: 2, leadsPerDay: 50, searchesPerDay: 10 } });
    expect(autonomous).toContain("AUTONOMOUS MODE IS ON");
    expect(autonomous).toContain("Widen nothing the owner named");
  });
});

describe("the tools as v2 reads them", () => {
  test("every tool its features allow is offered (describe_audience too), described by what it does, not steered away from", async () => {
    const { toolCatalog } = await import("./tools.server");
    const catalog = toolCatalog({ ...defaultFeatureState(), research_agent_v2: true, brightdata: true, apify_discovery: true, web_discovery: true });
    expect(catalog).toContain("- describe_audience:");
    expect(catalog).not.toContain("stop when a few searches find nothing new");
    expect(catalog).not.toContain("other networks are not supported");
    expect(catalog).not.toContain("hashtags the owner named");
    expect(catalog).not.toContain("is used only when the owner asks for Apify");
    expect(catalog).toContain("urls (optional array of up to 50");
    expect(catalog).toContain("one browser per chat");
    // The price comes after what research_social_sources does.
    const social = catalog.split("\n").find((line) => line.startsWith("- research_social_sources:")) ?? "";
    expect(social.indexOf("Metered from the owner's Bright Data account")).toBeGreaterThan(social.indexOf("Every finding keeps its link"));
  });
});

describe("a quote is matched as read", () => {
  test("HTML entities, curly quotes and spacing do not hide it", async () => {
    const { quoteText } = await import("./agentV2.server");
    expect(quoteText("<h3>Priya Raman</h3><p>Co-founder &amp; CTO</p>")).toContain(quoteText("Co-founder & CTO"));
    expect(quoteText("We’re   in  Brickell")).toBe(quoteText("We're in Brickell"));
  });
});
