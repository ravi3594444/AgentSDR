import { describe, expect, test } from "bun:test";
import { ASSISTANT_CHECKED, applyRequestRules, funnelLine, requestCheck, requestCheckLine, leadSortingSystemPrompt, linkedinProfileFacts, namesLead, personFit, requestSubject, requiresNoWebsite, typedByOwner, verdictOf, websiteState, websiteStatusFact, type SortVerdict } from "./leadFit";

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
    // "send me their emails" asks for leads with an email: a condition on the lead, so it stays.
    expect(requestSubject("Find 50 real estate agents in Austin and send me their emails. Free sources only.")).toBe("Find 50 real estate agents in Austin and send me their emails.");
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

  // Second round: a clause that says anything about the leads is never dropped.
  test("a condition on the leads stays, whatever control words it shares", () => {
    for (const text of [
      "Find gyms in Pune. They must be on Instagram.", "Find clinics in Pune, reachable by phone.", "Find clinics in Pune, with no email address on their site.",
      "Find clinics in Pune, ones with no contact page.", "Find marketing agencies in Pune, ones running Facebook campaigns.", "Find SaaS startups in Austin, ideally with $5M+ ARR.",
      "Find restaurants in Pune, ones that deliver within 30 minutes.", "Find dentists in Pune, the ones that spend on Google ads.", "Find clinics in Pune; keep them only if they have Instagram.",
      "Find cafes in Pune, active on Instagram", "Find founders in Pune, active on LinkedIn", "Find dentists in Pune and give me the ones with Instagram",
      "Find clinics in Pune, no email on their site", "Find 10 SaaS companies, series A or later, that spend on Google ads", "Find hotels in Goa, within 10 minutes of the beach",
      "Find clinics in Pune, rated 4.5 or more", "Find salons in Pune, open on Sundays",
    ]) expect(requestSubject(text)).toBe(text);
    expect(requestSubject("Find ecommerce brands in Mumbai, active on Instagram. No outreach.")).toBe("Find ecommerce brands in Mumbai, active on Instagram.");
  });

  test("a no-website requirement is never lost, in whatever clause it sits", () => {
    for (const text of [
      "Find 20 dentists in Pune and email me the ones without a website.", "Find 20 dentists in Pune, show me the ones with no website.",
      "Find dentists in Pune, send me those with no website only.", "Find 20 dentists in Pune, save a list of the ones with no website.",
      "Find dentists in Pune and show me only those with no website", "Research only. Find salons in Pune without a website. Spend $0.",
    ]) {
      expect(requiresNoWebsite(text)).toBe(true);
      expect(requiresNoWebsite(requestSubject(text))).toBe(true);
    }
    expect(requestSubject("Research only. Find salons in Pune without a website. Spend $0.")).toBe("Find salons in Pune without a website.");
  });

  test("pure instructions go: a time limit after the place, a source alone, a list to make, and the space after a comma stays", () => {
    expect(requestSubject("Find 3 dental clinics in Pune, 5 minutes max.")).toBe("Find 3 dental clinics in Pune.");
    expect(requestSubject("Find 3 dental clinics in Pune. Spend at most $2. Only Google Maps. Message them on WhatsApp.")).toBe("Find 3 dental clinics in Pune.");
    expect(requestSubject("Find 3 dental clinics in Pune, don't contact them, just list them.")).toBe("Find 3 dental clinics in Pune.");
    expect(requestSubject("Find clinics in Pune, 24 hours open, spend $1")).toBe("Find clinics in Pune, 24 hours open");
    expect(requestSubject("Find gyms in Pune, in 2 hours, and save them to a sheet.")).toBe("Find gyms in Pune.");
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

  test("say that the request outranks the saved target customers, and that a skip is not a misfit with the request", () => {
    const prompt = leadSortingSystemPrompt([]);
    expect(prompt).toMatch(/names a kind of lead or a place, that is whom the owner wants now: it replaces the target customers and locations saved in THE OWNER'S BUSINESS/);
    expect(prompt).toMatch(/never 'skip' or 'does_not_fit' because the saved target customers or locations differ/);
    expect(prompt).toMatch(/approach 'skip'[^\n]*different kind of business from the one THE OWNER'S REQUEST asks for/);
    expect(prompt).not.toMatch(/or it is a skip/);
    expect(prompt).toMatch(/'does_not_fit'[^\n]*closed for good/);
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

  test("with a request, relevance comes from requestFit alone: a skip only means no message", () => {
    expect(verdictOf(sort({ approach: "skip" }), { requestGiven: true })).toBe("match");
    expect(verdictOf(sort({ approach: "skip", requestFit: "unconfirmed" }), { requestGiven: true })).toBe("unconfirmed");
    expect(verdictOf(sort({ approach: "skip", requestFit: "does_not_fit" }), { requestGiven: true })).toBe("no_match");
    // The pilot's real-model miss: Pune clinics asked for, skipped because the saved target customers are salons.
    const skipped = sort({ approach: "skip", reason: "Dental clinic in Pune, but the owner's offer targets real estate agents and salons, not dental clinics." });
    expect(applyRequestRules("Find 3 dental clinics in Pune, India.", { businessName: "Lotus Dental Care", address: "Baner, Pune" }, skipped).fit).toBe("match");
    // With no request, the owner's business decides, as before.
    expect(applyRequestRules("", { businessName: "Lotus Dental Care" }, skipped).fit).toBe("no_match");
  });

  test("a lead that names no business or person is never a match", () => {
    const directory = { listedAs: "hi@star.in", directoryPage: "https://pune-guide.example/top-10-dentists-in-pune/", foundVia: "web search", searchQuery: "dental clinics Pune" };
    expect(namesLead(directory)).toBe(false);
    expect(applyRequestRules("Find 3 dental clinics in Pune, India.", directory, sort())).toEqual({ fit: "unconfirmed", reason: "Nothing found names a business or person (only hi@star.in, listed on a directory page), so it cannot count as a match." });
    // As saved: the directory contact's "business name" is the contact itself.
    const saved = { ...directory, businessName: "hi@star.in (listed on pune-guide.example)", sourcePage: "https://pune-guide.example/top-10-dentists-in-pune/" };
    expect(namesLead(saved)).toBe(false);
    expect(applyRequestRules("Find 3 dental clinics in Pune, India.", saved, sort()).fit).toBe("unconfirmed");
    expect(namesLead({ listedAs: "+919876543210", businessName: "+919876543210 (listed on pune-guide.example)" })).toBe(false);
    // Named leads, as each source writes them.
    const named: Record<string, string>[] = [
      { businessName: "Lotus Dental Care", address: "Baner, Pune" }, { name: "Priya Shah", title: "Founder" }, { company: "Acme Realty" },
      { businessName: "smiledental.in", website: "https://smiledental.in" }, { instagram: "@punesmiles" }, { instagramUsername: "punesmiles" },
      { platform: "Reddit", profile: "https://www.reddit.com/user/someone" }, { listingName: "Pune Smiles Dental" },
    ];
    for (const facts of named) expect(namesLead(facts)).toBe(true);
    expect(applyRequestRules("Find 3 dental clinics in Pune, India.", { businessName: "Lotus Dental Care" }, sort()).fit).toBe("match");
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
    const none = applyRequestRules(request, { businessName: "Shah Homes", websiteStatus: websiteStatusFact({ state: "none_listed" }) }, rule);
    expect(none.fit).toBe("match");
    expect(none.reason).toMatch(/No website is listed for it; that was not checked further/);
  });

  test("the rule applies only where the sorter says the request asks it of this lead", () => {
    // "real estate founders, and people who do not have a website": a founder with a website can still fit.
    const request = "real estate founders, and people who do not have a website";
    expect(applyRequestRules(request, { name: "Rohan K", websiteStatus: websiteStatusFact({ state: "read", url: "https://founder.test" }) }, sort()).fit).toBe("match");
    expect(applyRequestRules("real estate founders", { name: "Rohan K" }, sort({ noWebsiteRequired: true })).fit).toBe("match");
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

describe("when a request's leads are checked", () => {
  const row = (personId: string | null, fit: "match" | "unconfirmed" | "no_match" | null, fitReason: string | null = null) => ({ personId, fit, fitReason });

  test("saved contacts the judge left unconfirmed, or nobody judged, are not checked; the assistant's own verdicts are", () => {
    const check = requestCheck([
      row("a", "unconfirmed", "No website to judge from"),
      row("b", null),
      row("c", "unconfirmed", `${ASSISTANT_CHECKED}its site shows no booking or contact form; nothing about how they handle enquiries`),
      row("d", "match", `${ASSISTANT_CHECKED}takes bookings by phone only, which the offer automates`),
      row("e", "no_match", "a franchise head office"),
      // One person on two lists counts once.
      row("a", null),
      row(null, null),
    ]);
    expect(check).toEqual({ leads: 5, match: 1, noMatch: 1, unconfirmed: 2, pending: 1, unchecked: 2 });
    expect(requestCheckLine(check)).toBe("5 leads: 1 match, 1 not a match, 2 unconfirmed, 1 not judged (2 not checked yet)");
  });

  test("a request that saved nothing, or whose leads all have a verdict, has nothing left to check", () => {
    expect(requestCheck([]).unchecked).toBe(0);
    expect(requestCheck([row("a", "match"), row("b", "no_match")]).unchecked).toBe(0);
  });
});
