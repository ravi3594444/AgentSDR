import { describe, expect, test } from "bun:test";
import { actionsProblem, inquiryRepliesRequested } from "./agent";
import { businessContext, looksLikeSenderName, priceDocuments, reusableSender } from "./businessContext";
import { inquiryFacts, inquirySignal, matchReasonForExisting, peopleSourceLabel } from "./existingLeads";
import { inquiryRunProblem } from "./inquiryRuns";
import { approvalProblem, makeRequestApproval } from "./requestApproval";
import { countProspects, derivedMatchReason, prospectStatus, qualifyProspect, UNKNOWN, type ProspectInput } from "./qualification";

function member(overrides: Partial<ProspectInput> = {}): ProspectInput {
  return {
    personId: "p1",
    name: "Smile Dental",
    status: "eligible",
    reason: null,
    channels: ["email"],
    source: "web_search",
    sourceUrl: "https://directory.example/dentists-pune",
    evidence: [{ kind: "email", value: "hello@smile.example", sourceUrl: "https://smile.example/contact", source: "the business's website · domain has mail servers (MX); mailbox not verified" }],
    facts: { businessName: "Smile Dental" },
    matchReason: "Found by web search for “dental clinics in Pune”: “Smile Dental — family dentistry in Baner”.",
    signals: [],
    createdAt: new Date("2026-10-16T08:00:00Z"),
    crm: null,
    ...overrides,
  };
}

describe("qualification", () => {
  test("a found lead is a potential match: its source, date, reason and route are shown, unknowns stay unknown", () => {
    const prospect = qualifyProspect(member());
    expect(prospect.status).toBe("potential_match");
    expect(prospect.statusLabel).toBe("Potential match");
    expect(prospect.source).toEqual({ label: "Web search", url: "https://directory.example/dentists-pune" });
    expect(prospect.foundAt).toBe("2026-10-16T08:00:00.000Z");
    expect(prospect.matchReason).toContain("dental clinics in Pune");
    expect(prospect.routes).toEqual([{ channel: "email", value: "hello@smile.example", sourceUrl: "https://smile.example/contact", note: "published email · the business's website · domain has mail servers (MX); mailbox not verified" }]);
    expect(prospect.location).toBe(UNKNOWN);
    expect(prospect.budget).toBe(UNKNOWN);
    expect(prospect.needEvidence).toEqual([]);
  });

  test("likes, follows and generic comments never establish intent", () => {
    const signals = [
      { kind: "engagement" as const, text: "😍🔥", sourceUrl: "https://www.instagram.com/p/abc/", source: "Instagram comment", at: null },
      { kind: "engagement" as const, text: "follow back", sourceUrl: "https://www.instagram.com/p/abc/", source: "Instagram comment", at: null },
    ];
    const prospect = qualifyProspect(member({ source: "web_search", signals }));
    expect(prospect.status).toBe("potential_match");
    expect(prospect.needEvidence).toEqual([]);
    expect(prospect.engagement).toHaveLength(2);
    // Even a need found in someone's comment leaves them a potential match: they did not write to the owner.
    expect(prospectStatus({ status: "eligible", source: "web_search", crm: null, signals: [{ kind: "need", text: "need a dentist in Baner, any recommendation?", sourceUrl: null, source: "Instagram comment", at: null }] })).toBe("potential_match");
  });

  test("only the person's own inquiry makes them Inquired, and only a classified reply makes them Interested", () => {
    const inquiry = [{ kind: "need" as const, text: "Do you service X-ray units?", sourceUrl: null, source: "website form", at: "2026-10-15T10:00:00.000Z" }];
    expect(qualifyProspect(member({ source: "inquiry:website_form", signals: inquiry })).status).toBe("inquired");
    // Their Instagram inquiry reaches the CRM as an inbound message: still "Inquired", not "Replied".
    expect(qualifyProspect(member({ source: "inquiry:instagram", signals: inquiry, crm: { categoryKey: null, lastInboundAt: new Date() } })).status).toBe("inquired");
    expect(qualifyProspect(member({ crm: { categoryKey: "not_interested", lastInboundAt: new Date() } })).status).toBe("replied");
    expect(qualifyProspect(member({ crm: { categoryKey: "interested", lastInboundAt: new Date() } })).status).toBe("interested");
    expect(qualifyProspect(member({ status: "excluded", reason: "no email or phone published" })).excludedReason).toBe("no email or phone published");
  });

  test("a location or budget is shown only when the source stated it", () => {
    expect(qualifyProspect(member({ facts: { city: "Pune" } })).location).toBe("Pune");
    expect(qualifyProspect(member({ facts: { budget: "₹50,000" } })).budget).toBe("₹50,000");
  });

  test("match reasons for older lists come from what was searched, never a guess", () => {
    expect(derivedMatchReason("google_maps", { what: "dental clinics", where: "Pune" }, { category: "Dentist" })).toBe("Listed on Google Maps for “dental clinics” in Pune, as “Dentist”.");
    expect(derivedMatchReason("google_maps", {}, {})).toBeNull();
    expect(derivedMatchReason("linkedin_search", { keywords: "clinic owner Pune" }, {})).toBe("Found by a LinkedIn search for “clinic owner Pune”.");
    expect(derivedMatchReason("existing", {}, {})).toBeNull();
    expect(qualifyProspect(member({ matchReason: null })).matchReason).toBe(UNKNOWN);
  });

  test("counts keep potential matches apart from interested people", () => {
    const counts = countProspects([
      qualifyProspect(member()),
      qualifyProspect(member({ crm: { categoryKey: "interested", lastInboundAt: new Date() } })),
      qualifyProspect(member({ source: "inquiry:instagram", signals: [{ kind: "need", text: "price for 3 chairs?", sourceUrl: null, source: "Instagram message", at: null }] })),
      qualifyProspect(member({ status: "excluded", reason: "x" })),
    ]);
    expect(counts).toEqual({ potential_match: 1, inquired: 1, replied: 0, interested: 1, excluded: 1, withNeedEvidence: 1 });
  });
});

describe("existing leads and inquiries", () => {
  test("an inquiry's own words are the evidence, quoted; an empty form proves nothing", () => {
    const at = new Date("2026-10-15T10:00:00Z");
    expect(inquirySignal({ source: "website_form", message: "  Do you deliver to Baner? ", pageUrl: "https://acme.example/contact", at })).toEqual([
      { kind: "need", text: "Do you deliver to Baner?", sourceUrl: "https://acme.example/contact", source: "website form", at: "2026-10-15T10:00:00.000Z" },
    ]);
    expect(inquirySignal({ source: "website_form", message: "   ", pageUrl: null, at })).toEqual([]);
    expect(inquiryFacts({ source: "instagram", message: "price?", pageUrl: null, at })).toEqual({ inquiredVia: "Instagram", inquiry: "price?" });
  });

  test("sources read as words and the reason says where a lead came from", () => {
    expect(peopleSourceLabel("discovery:google-maps")).toBe("Google Maps search");
    expect(peopleSourceLabel("intake:website-form")).toBe("your website form");
    expect(peopleSourceLabel("manual-people-import")).toBe("an uploaded list");
    expect(matchReasonForExisting({ createdAt: new Date("2026-09-01T00:00:00Z"), sourceLabel: "an uploaded list", search: "Pune" }))
      .toBe("Already in your leads since 2026-09-01 (from an uploaded list); matches “Pune”.");
  });
});

describe("business context: reuse before asking", () => {
  test("a price list document answers prices; the profile is not asked for them", () => {
    expect(priceDocuments([{ title: "Price list 2026", kind: "custom" }, { title: "About us", kind: "company" }, { title: "Rates", kind: "pricing" }])).toEqual(["Price list 2026", "Rates"]);
    const known = businessContext({ businessName: "Acme", offer: "chair servicing" }, { documents: [{ title: "Price list 2026", kind: "custom" }], senders: [], instructions: [] });
    expect(known.optional).toEqual([]);
    expect(known.summary).toContain("prices: in “Price list 2026”");
    const none = businessContext({ businessName: "Acme", offer: "chair servicing" }, { documents: [], senders: [], instructions: [] });
    expect(none.optional[0]).toContain("prices");
    // Prices the owner told the assistant are known too.
    const told = businessContext({ businessName: "Acme", offer: "chair servicing", prices: "Servicing ₹1,500 a chair" }, { documents: [], senders: [], instructions: [] });
    expect(told.optional).toEqual([]);
    expect(told.summary).toContain("prices: in the business profile");
  });

  test("an email address, a phone number or a handle never signs a message", () => {
    expect(looksLikeSenderName("Ravi Kumar")).toBe(true);
    expect(looksLikeSenderName("Acme Dental Care")).toBe(true);
    expect(looksLikeSenderName("ravi@acme.com")).toBe(false);
    expect(looksLikeSenderName("+91 98765 43210")).toBe(false);
    expect(looksLikeSenderName("sales2024team")).toBe(false);
    expect(reusableSender([{ name: "ravi@acme.com", source: "mailbox" }])).toBeNull();
    expect(reusableSender([{ name: "ravi@acme.com", source: "mailbox" }, { name: "Ravi Kumar", source: "LinkedIn" }])).toEqual({ name: "Ravi Kumar", source: "LinkedIn" });
    const single = businessContext({ businessName: "Acme", offer: "x" }, { documents: [], senders: [{ name: "+91 98765 43210", source: "WhatsApp" }], instructions: [] });
    expect(single.sender).toBeNull();
    expect(single.missingForOutreach).toContain("the name messages are signed with");
  });

  test("the sender name every account already uses is reused; disagreeing accounts are asked about", () => {
    expect(reusableSender([{ name: "Ravi Kumar", source: "mailbox" }, { name: "ravi kumar", source: "LinkedIn" }])).toEqual({ name: "Ravi Kumar", source: "mailbox" });
    expect(reusableSender([{ name: "Ravi Kumar", source: "mailbox" }, { name: "Sales Team", source: "WhatsApp" }])).toBeNull();
    const reused = businessContext({ businessName: "Acme", offer: "x" }, { documents: [], senders: [{ name: "Ravi Kumar", source: "mailbox" }], instructions: [] });
    expect(reused.missingForOutreach).toEqual([]);
    expect(reused.sender).toEqual({ name: "Ravi Kumar", source: "your mailbox account" });
    const ask = businessContext({ businessName: "Acme", offer: "x" }, { documents: [], senders: [{ name: "Ravi Kumar", source: "mailbox" }, { name: "Sales Team", source: "WhatsApp" }], instructions: [] });
    expect(ask.missingForOutreach[0]).toContain("ask which one");
    // The profile's own sender always wins.
    expect(businessContext({ businessName: "Acme", offer: "x", senderName: "Asha" }, { documents: [], senders: [{ name: "Ravi", source: "mailbox" }], instructions: [] }).sender?.name).toBe("Asha");
  });

  test("missing details point at saved documents before asking the owner", () => {
    const known = businessContext({}, { documents: [{ title: "Brochure", kind: "product" }], senders: [], instructions: ["Tone"] });
    expect(known.missingForDiscovery[0]).toContain("search_knowledge");
    expect(known.missingForOutreach.some((item) => item.includes("Brochure"))).toBe(true);
    expect(known.summary).toContain("reply instructions: “Tone”");
  });
});

describe("answering inquiries is asked for explicitly and scoped", () => {
  test("the owner's words, or a yes to the offer, count; other talk does not", () => {
    expect(inquiryRepliesRequested("Please answer my Instagram inquiries automatically")).toBe(true);
    expect(inquiryRepliesRequested("reply to new DMs for me")).toBe(true);
    expect(inquiryRepliesRequested("yes", "Shall I answer new Instagram inquiries for you?")).toBe(true);
    expect(inquiryRepliesRequested("How many inquiries did we get?")).toBe(false);
    expect(inquiryRepliesRequested("don't answer instagram messages")).toBe(false);
    const problem = actionsProblem([{ tool: "prepare_inquiry_replies", args: {} }], { smallTalk: false, profile: {}, ownerCorpus: "", outreachRequested: true, inquiryRepliesRequested: false });
    expect(problem).toContain("not asked for their inquiries to be answered");
    expect(actionsProblem([{ tool: "prepare_inquiry_replies", args: {} }], { smallTalk: false, profile: {}, ownerCorpus: "", outreachRequested: false, inquiryRepliesRequested: true })).toBeNull();
  });

  test("a web search that contacts people afterwards needs an outreach request like the other searches", () => {
    expect(actionsProblem([{ tool: "find_customers_on_web", args: { contactAfter: true } }], { smallTalk: false, profile: {}, ownerCorpus: "", outreachRequested: false })).toContain("not asked to contact");
    expect(actionsProblem([{ tool: "find_customers_on_web", args: {} }], { smallTalk: false, profile: {}, ownerCorpus: "", outreachRequested: false })).toBeNull();
  });

  test("an inquiry run needs both features and a connected account taking inquiries", () => {
    const on = { instagram: true, inquiry_intake: true };
    const account = { unipileAccountId: "a", username: "acme", status: "connected", inquiryIntake: true };
    expect(inquiryRunProblem({ features: { ...on, instagram: false }, accounts: [account] })).toContain("Instagram messages are off");
    expect(inquiryRunProblem({ features: { ...on, inquiry_intake: false }, accounts: [account] })).toContain("Inquiry intake is off");
    expect(inquiryRunProblem({ features: on, accounts: [] })).toContain("No Instagram account is connected");
    expect(inquiryRunProblem({ features: on, accounts: [{ ...account, inquiryIntake: false }] })).toContain("treats new messages as inquiries");
    expect(inquiryRunProblem({ features: on, accounts: [{ ...account, status: "credentials" }] })).toContain("No Instagram account is connected");
    expect(inquiryRunProblem({ features: on, accounts: [account] })).toBeNull();
  });
});

describe("one Start for a whole request", () => {
  const now = new Date("2026-10-16T10:00:00Z");
  const plan = (requestId: string | null, leads = 20, ownerRequest: string | null = "yes") => ({ requestId, ownerRequest, assignments: Array.from({ length: leads }, (_, index) => ({ personId: `p${index}`, channel: "email" as const })) });
  const approval = makeRequestApproval(plan("msg-1"), ["email", "whatsapp"], { autopilot: true, approvedBy: "u1", now })!;

  test("an approval is tied to the owner's message that asked, not its words", () => {
    expect(makeRequestApproval(plan(null), ["email"], { autopilot: true, approvedBy: "u1", now })).toBeNull();
    expect(approval.requestId).toBe("msg-1");
    expect(approval.maxLeadsPerPlan).toBe(100);
    expect(approval.expiresAt).toBe("2026-10-17T10:00:00.000Z");
  });

  test("it covers the same request's other plans within the approved channels and size", () => {
    expect(approvalProblem(approval, "running", { plan: plan("msg-1"), channels: ["email"] }, now)).toBeNull();
    expect(approvalProblem(approval, "starting", { plan: plan("msg-1"), channels: ["whatsapp"] }, now)).toBeNull();
  });

  test("two requests worded the same (two 'yes' answers) are never one request", () => {
    expect(approvalProblem(approval, "running", { plan: plan("msg-2", 20, "yes"), channels: ["email"] }, now)).toContain("another request");
    expect(approvalProblem(approval, "running", { plan: plan(null, 20, "yes"), channels: ["email"] }, now)).toContain("another request");
  });

  test("it never covers a new channel, a bigger plan, people already in a running plan, an inquiry run, or a paused, stopped or old approval", () => {
    expect(approvalProblem(approval, "running", { plan: plan("msg-1"), channels: ["linkedin"] }, now)).toContain("linkedin");
    expect(approvalProblem(approval, "running", { plan: plan("msg-1", 150), channels: ["email"] }, now)).toContain("150 leads");
    expect(approvalProblem(approval, "running", { plan: { ...plan("msg-1"), kind: "inquiries" as const }, channels: [] }, now)).toContain("inquiry run");
    expect(approvalProblem(approval, "paused", { plan: plan("msg-1"), channels: ["email"] }, now)).toContain("paused");
    expect(approvalProblem(approval, "stopped", { plan: plan("msg-1"), channels: ["email"] }, now)).toContain("stopped");
    expect(approvalProblem(approval, "running", { plan: plan("msg-1"), channels: ["email"] }, new Date("2026-10-17T10:00:01Z"))).toContain("more than a day old");
  });
});
