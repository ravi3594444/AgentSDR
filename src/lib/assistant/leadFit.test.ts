import { describe, expect, test } from "bun:test";
import { applyRequestRules, funnelLine, leadSortingSystemPrompt, linkedinProfileFacts, personFit, requestSubject, requiresNoWebsite, typedByOwner, verdictOf, websiteState, websiteStatusFact, type SortVerdict } from "./leadFit";

// Pilot finding L02: how the research runs (budget, time, sources, no
// outreach, where to save) is not a requirement a lead can fail.
describe("requestSubject: what the leads are judged against", () => {
  const PILOT = "Research only. Find 3 dental clinics in Pune, India. Use free sources only with a $0 source budget, and finish within 5 minutes. Save a lead list. Do not contact anyone. No outreach. No messages. No campaigns.";

  test("the pilot prompt keeps its kind, place and count and nothing about how to run", () => {
    expect(requestSubject(PILOT)).toBe("Find 3 dental clinics in Pune, India.");
  });

  test("budgets, time limits, source choice and delivery go; a plain request is unchanged", () => {
    expect(requestSubject("Find 20 gyms in Mumbai, spend up to $2 and finish within 2 hours")).toBe("Find 20 gyms in Mumbai");
    expect(requestSubject("find gyms in Mumbai on Facebook, spend up to $1")).toBe("find gyms in Mumbai on Facebook");
    expect(requestSubject("Find 50 real estate agents in Austin and send me their emails. Free sources only.")).toBe("Find 50 real estate agents in Austin.");
    expect(requestSubject("Find 25 real estate agencies in Pune without a website")).toBe("Find 25 real estate agencies in Pune without a website");
    expect(requestSubject("find 10 dentists in Pune")).toBe("find 10 dentists in Pune");
    expect(requestSubject("Find real estate agents in Chicago and do outreach on whatsapp")).toBe("Find real estate agents in Chicago");
  });

  test("factual requirements stay: no website, a channel they have, a condition in its own sentence", () => {
    expect(requestSubject("Find cafes in Pune that have Instagram. Do not contact anyone.")).toBe("Find cafes in Pune that have Instagram.");
    expect(requestSubject("Find dentists in Pune. They must have no website. Message them on WhatsApp.")).toBe("Find dentists in Pune. They must have no website.");
    expect(requestSubject("Find clinics in Pune open 24 hours with a low-cost plan")).toBe("Find clinics in Pune open 24 hours with a low-cost plan");
    expect(requiresNoWebsite(requestSubject("Find 25 real estate agencies in Pune without a website, research only"))).toBe(true);
  });

  test("when every clause is about how to run, the request is left as it is", () => {
    expect(requestSubject("Research only. Spend $0.")).toBe("Research only. Spend $0.");
    expect(requestSubject("")).toBe("");
  });
});

describe("the sorter's rules (what sortLeads tells the model)", () => {
  test("say that how the research runs is not a requirement, and that approach is about the message, not permission", () => {
    const prompt = leadSortingSystemPrompt([]);
    expect(prompt).toContain("requestFit: whether the lead is what the OWNER'S REQUEST asks for");
    expect(prompt).toMatch(/Instructions about how the research runs[^\n]*are NOT requirements[^\n]*never (?:change|affect) requestFit or approach/i);
    expect(prompt).toMatch(/approach[^\n]*the message[^\n]*if (?:it|the lead) (?:were|was) contacted/i);
    expect(prompt).toMatch(/asks for no contact[^\n]*changes nothing about (?:its )?fit/i);
    expect(leadSortingSystemPrompt(["Dental clinics"])).toContain("Reuse these names when they fit: 'Dental clinics'.");
  });
});

const sort = (over: Partial<SortVerdict> = {}): SortVerdict => ({ approach: "standard", reason: "A real estate agency in Pune.", requestFit: "fits", noWebsiteRequired: false, ...over });

describe("a sorter's verdict", () => {
  test("only a lead that fits the request is a match", () => {
    expect(verdictOf(sort())).toBe("match");
    expect(verdictOf(sort({ requestFit: "unconfirmed" }))).toBe("unconfirmed");
    expect(verdictOf(sort({ requestFit: "does_not_fit" }))).toBe("no_match");
    expect(verdictOf(sort({ approach: "skip" }))).toBe("no_match");
  });

  test("a person found on several lists: a no-match anywhere wins, then a match", () => {
    expect(personFit(["match", "no_match"])).toBe("no_match");
    expect(personFit(["unconfirmed", "match", null])).toBe("match");
    expect(personFit([null, "unconfirmed"])).toBe("unconfirmed");
    expect(personFit([null])).toBe("pending");
  });
});

describe("a lead's website", () => {
  test("none listed, could not be checked and found are three outcomes", () => {
    const none = websiteStatusFact({ state: "none_listed" });
    const unchecked = websiteStatusFact({ state: "listed_unchecked", url: "https://a.test", why: "403 Forbidden" });
    const read = websiteStatusFact({ state: "read", url: "https://b.test" });
    expect(none).toBe("none listed on its Google Maps listing (not proof it has none)");
    expect(unchecked).toBe("listed (https://a.test) but could not be checked: 403 Forbidden");
    expect([websiteState(none), websiteState(unchecked), websiteState(read), websiteState(websiteStatusFact({ state: "domain_unchecked" })), websiteState(undefined)])
      .toEqual(["none_listed", "listed_unchecked", "read", "domain_unchecked", "unknown"]);
  });

  test("the owner's words that ask for leads without a website", () => {
    expect(requiresNoWebsite("start outreach find B2B business owners, real estate founders, etc., and people who do not have a website; outreach them")).toBe(true);
    expect(requiresNoWebsite("US real estate agencies with no website")).toBe(true);
    expect(requiresNoWebsite("salons without a website in Pune")).toBe(true);
    expect(requiresNoWebsite("find dentists and check their website")).toBe(false);
    expect(requiresNoWebsite("people who need a new website")).toBe(false);
  });

  test("for a no-website request, a website found is no match and an unchecked one is unconfirmed", () => {
    const request = "real estate agencies without a website";
    const rule = sort({ noWebsiteRequired: true });
    expect(applyRequestRules(request, { websiteStatus: websiteStatusFact({ state: "read", url: "https://agency.test" }) }, rule))
      .toEqual({ fit: "no_match", reason: "It has a website (https://agency.test), and you asked for ones without." });
    expect(applyRequestRules(request, { websiteStatus: websiteStatusFact({ state: "listed_unchecked", url: "https://x.test", why: "405" }) }, rule).fit).toBe("unconfirmed");
    expect(applyRequestRules(request, { websiteStatus: websiteStatusFact({ state: "domain_unchecked" }) }, rule).fit).toBe("unconfirmed");
    expect(applyRequestRules(request, {}, rule)).toEqual({ fit: "unconfirmed", reason: "Whether it has a website is not known. A real estate agency in Pune." });
    const none = applyRequestRules(request, { websiteStatus: websiteStatusFact({ state: "none_listed" }) }, rule);
    expect(none.fit).toBe("match");
    expect(none.reason).toMatch(/No website is listed for it; that was not checked further/);
  });

  test("the rule applies only where the sorter says the request asks it of this lead", () => {
    // "real estate founders, and people who do not have a website": a founder with a website can still fit.
    const request = "real estate founders, and people who do not have a website";
    expect(applyRequestRules(request, { websiteStatus: websiteStatusFact({ state: "read", url: "https://founder.test" }) }, sort()).fit).toBe("match");
    expect(applyRequestRules("real estate founders", {}, sort({ noWebsiteRequired: true })).fit).toBe("match");
  });
});

test("a LinkedIn profile's facts: headline, place and the words searched", () => {
  expect(linkedinProfileFacts({ headline: "Founder, Acme Realty", location: "Austin, Texas", companyName: "Acme Realty" }, "real estate founder Austin"))
    .toEqual({ foundVia: "LinkedIn people search", searchedFor: "real estate founder Austin", headline: "Founder, Acme Realty", location: "Austin, Texas", company: "Acme Realty" });
  expect(linkedinProfileFacts({ headline: null, location: null }, "founder").location).toBe("not shown on the search result");
});

test("the judging line", () => {
  expect(funnelLine({ contactable: 50, qualified: 3, notMatching: 40, unconfirmed: 7, pending: 0, noMatchReasons: [{ reason: "A software founder, not real estate.", count: 30 }] }))
    .toBe("3 of 50 contactable match your request (40 do not (A software founder, not real estate), 7 unconfirmed)");
  expect(funnelLine({ contactable: 4, qualified: 4, notMatching: 0, unconfirmed: 0, pending: 0, noMatchReasons: [] })).toBe("4 of 4 contactable match your request");
});

test("a contact the owner typed in the chat is theirs; one found on a page is not", () => {
  const owner = "Please message Priya at +91 98765 43210 and amit@shahhomes.in, and linkedin.com/in/rohan-k";
  expect(typedByOwner({ phone: "+919876543210" }, owner)).toBe(true);
  expect(typedByOwner({ email: "Amit@ShahHomes.in" }, owner)).toBe(true);
  expect(typedByOwner({ linkedinUrl: "https://www.linkedin.com/in/rohan-k/" }, owner)).toBe(true);
  expect(typedByOwner({ phone: "+919800000001", email: "someone@else.test" }, owner)).toBe(false);
  expect(typedByOwner({ phone: "+91 12" }, owner)).toBe(false);
});
