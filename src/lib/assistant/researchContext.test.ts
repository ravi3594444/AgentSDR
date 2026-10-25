import { describe, expect, test } from "bun:test";
import { defaultFeatureState } from "@/lib/features/catalog";
import { requestBlock, systemPromptV2 } from "./agentV2";
import { checkBrief } from "./brief";
import { researchOptionsText, requestFirstContext } from "./researchContext";

describe("the current request and its background", () => {
  test("a cost-discovery request precedes the saved sales offer on every step", () => {
    const request = "Find successful businesses and ask which services cost them the most money";
    const setup = 'BUSINESS PROFILE: {"offer":"AI automation and CRM","targetCustomers":"real estate and cleaning","locations":"Mumbai"}';
    const text = requestFirstContext({ request, setup, conversation: "OWNER: Tell me what they say", replanReason: "A source failed" });
    expect(text.startsWith(request)).toBe(true);
    expect(text.indexOf(request)).toBeLessThan(text.indexOf(setup));
    expect(text).toContain(setup);
    expect(text).toContain("background only");
    expect(text).toContain("OWNER: Tell me what they say");
    expect(text).toContain("A source failed");
  });

  test("provisional sectors, places and sources are separate from owner requirements", () => {
    const words = "Find established business owners and ask what costs them most";
    const checked = checkBrief({ goal: words, contact: true, approach: "Try retail founders in London through LinkedIn first" }, words, { leadTarget: 25, hours: 4 });
    if (!checked.ok) throw new Error(checked.error);
    const block = requestBlock({ ownerMessages: [words], brief: checked.brief, controls: checked.controls, status: "active" });
    expect(block).toContain(`Goal: ${words}`);
    expect(block).toContain("RESEARCH APPROACH (chosen by the assistant; provisional, not owner requirements): Try retail founders in London through LinkedIn first");
    expect(block).toContain("authoritative if the brief or approach differs");
  });

  test("the method does not turn every open request into a buyer search or impose source quotas", () => {
    const prompt = systemPromptV2({ features: defaultFeatureState(), catalog: "", autonomy: null });
    expect(prompt).not.toContain("find out who needs the offer most");
    expect(prompt).toContain("Use the offer to choose buyers only when this request asks you to find buyers for it");
    expect(prompt).toContain("No source is the default");
    expect(prompt).toContain("You need not run every provider or give sources equal quotas");
  });
});

describe("availability is not source priority", () => {
  const setup = {
    leadDiscovery: { available: true, reason: null },
    webDiscovery: { enabled: true, available: true, provider: "tinyfish", reason: null },
    webAccess: { tinyfish: true, searchProvider: "TinyFish", browserMinutesPerDay: 60 },
    channels: { linkedin: { available: true, reason: null } },
    features: { ...defaultFeatureState(), apify_discovery: true, brightdata: true, treg: true },
  };

  test("the same block includes Maps, web, browser, LinkedIn, social collectors and enrichment", () => {
    const text = researchOptionsText(setup);
    for (const source of ["Apify", "Bright Data", "Browser", "Google Maps", "LinkedIn", "Treg", "Web search", "Website and directory search"]) expect(text).toContain(source);
    expect(text).toContain("configuration does not confirm live provider health");
    const options = text.split("\n").slice(1);
    expect(options).toEqual([...options].sort());
    expect(text).not.toContain("Google Maps ready");
  });

  test("unavailable and disabled options stay explicit and do not invent a fallback preference", () => {
    const text = researchOptionsText({ ...setup, leadDiscovery: { available: false, reason: "scraper not configured" }, webDiscovery: { ...setup.webDiscovery, enabled: false }, channels: { linkedin: { available: false, reason: "no account connected" } }, features: defaultFeatureState() });
    expect(text).toContain("Google Maps built-in scraper: scraper not configured");
    expect(text).toContain("LinkedIn people search: no account connected");
    expect(text).toContain("Website and directory search: disabled");
    expect(text).toContain("Apify social searches: disabled");
    expect(text).toContain("Bright Data social research: disabled");
  });
});
