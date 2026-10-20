import { describe, expect, test } from "bun:test";
import { availableTokens, ensureSignOff, groundSequences, leadClaimProblem, leadTextKey, MAX_GROUPS, perLeadSteps, personalMessageProblem, settleGroups, personalizationKey, personalLineProblem, sequenceClaimProblem, sequenceProblem, templateProblem, templateTokens } from "./messages";

const TOKENS = ["firstName", "company", "city", "category", "p_1a2b3c4d"];

describe("templates", () => {
  test("templateTokens reads {{tokens}}", () => {
    expect(templateTokens("Hi {{ firstName }}, {{company}} in {{city}}")).toEqual(["firstName", "company", "city"]);
  });

  test("unknown merge fields are refused, known ones case-insensitively accepted", () => {
    expect(templateProblem("Hi {{jobTitle}}", TOKENS)).toContain("{{jobTitle}}");
    expect(templateProblem("Hi {{FIRSTNAME}} at {{company}}", TOKENS)).toBeNull();
  });

  test("placeholders and claims of things not done are refused", () => {
    expect(templateProblem("Hi, I'm [Your Name] from Acme.", TOKENS)).toContain("placeholders");
    expect(templateProblem("I've attached our price list for you.", TOKENS)).toContain("already done");
  });
});

describe("sequenceProblem", () => {
  test("a valid email sequence passes", () => {
    expect(sequenceProblem("email", [
      { subject: "Quick question for {{company}}", body: "Hi {{firstName}},\n\n{{p_1a2b3c4d}}\n\nWould a short call help?", waitDays: 0 },
      { subject: "", body: "Following up on my note.", waitDays: 3 },
    ], TOKENS)).toBeNull();
  });

  test("channel rules: first email needs a subject, WhatsApp has none, LinkedIn note under 280", () => {
    expect(sequenceProblem("email", [{ subject: "", body: "Hello", waitDays: 0 }], TOKENS)).toBe("The first email needs a subject.");
    expect(sequenceProblem("whatsapp", [{ subject: "Hi", body: "Hello", waitDays: 0 }], TOKENS)).toContain("must not have a subject");
    expect(sequenceProblem("linkedin", [{ subject: null, body: "x".repeat(281), waitDays: 0 }], TOKENS)).toContain("280");
    expect(sequenceProblem("whatsapp", [], TOKENS)).toContain("1 to 2");
    expect(sequenceProblem("whatsapp", [{ subject: null, body: "x".repeat(601), waitDays: 0 }], TOKENS)).toContain("under 600");
  });
});

describe("personal lines", () => {
  test("empty is allowed; brackets, tokens, length and claims are not", () => {
    expect(personalLineProblem("")).toBeNull();
    expect(personalLineProblem("Saw your clinic opened a second branch in Baner.")).toBeNull();
    expect(personalLineProblem("Hi {{firstName}}")).toBe("no merge fields or brackets");
    expect(personalLineProblem("x".repeat(281))).toContain("280");
    expect(personalLineProblem("I've already sent you our brochure.")).toContain("do not claim");
  });

  test("personalizationKey is short and stable", () => {
    expect(personalizationKey("1a2b3c4d-5e6f-7a8b-9c0d-ef0123456789")).toBe("p_1a2b3c4d");
  });
});

describe("ensureSignOff", () => {
  const profile = { senderName: "Ravi Kumar", senderRole: "Founder", businessName: "Bright Path" };
  const step = (body: string) => ({ subject: null, body, waitDays: 0 });

  test("adds the sender to emails that lack it, keeps emails already signed", () => {
    const [unsigned, signed] = ensureSignOff("email", [step("Hi team,\n\nWould a call help?"), step("Following up.\n\nBest,\nRavi")], profile, false);
    expect(unsigned!.body).toBe("Hi team,\n\nWould a call help?\n\nRavi Kumar\nFounder, Bright Path");
    expect(signed!.body).toBe("Following up.\n\nBest,\nRavi");
  });

  test("leaves emails alone when the mailbox signature is appended, or the sender is unknown", () => {
    expect(ensureSignOff("email", [step("Hi")], profile, true)[0]!.body).toBe("Hi");
    expect(ensureSignOff("email", [step("Hi")], {}, false)[0]!.body).toBe("Hi");
  });

  test("the first WhatsApp message names the sender; follow-ups and LinkedIn are untouched", () => {
    const [first, second] = ensureSignOff("whatsapp", [step("Hi, quick question?"), step("Any thoughts?")], profile, false);
    expect(first!.body).toBe("Hi, quick question?\n\n– Ravi Kumar, Bright Path");
    expect(second!.body).toBe("Any thoughts?");
    expect(ensureSignOff("whatsapp", [step("Hi, this is Ravi from Bright Path.")], profile, false)[0]!.body).toBe("Hi, this is Ravi from Bright Path.");
    expect(ensureSignOff("linkedin", [step("Hi")], profile, false)[0]!.body).toBe("Hi");
  });
});

describe("availableTokens", () => {
  test("only fields every lead has may be used in the messages", () => {
    expect(availableTokens([{ company: "Lotus Dental", city: "Pune", category: "Dentist" }, { company: "Smile Spot", city: "Pune", category: "" }])).toEqual(["company", "city"]);
    expect(availableTokens([{ company: "Lotus Dental" }, {}])).toEqual([]);
    expect(availableTokens([])).toEqual([]);
  });
});

describe("sorting leads into kinds", () => {
  test("labels merge ignoring case; past the limit the smallest share Other", () => {
    expect(settleGroups(["Real estate agents", "real estate agents ", "Cleaning companies"])).toEqual([
      { label: "Real estate agents", members: [0, 1] },
      { label: "Cleaning companies", members: [2] },
    ]);
    const many = settleGroups(["A", "A", "A", "B", "B", "C", "D", "E"]);
    expect(many.length).toBe(MAX_GROUPS);
    expect(many.map((group) => group.label)).toEqual(["A", "B", "C", "Other"]);
    expect(many.find((group) => group.label === "Other")!.members).toEqual([6, 7]);
  });

  test("each campaign step points at the lead's own text, as many steps as the shortest group", () => {
    const email = [
      [{ subject: "Hello", body: "a", waitDays: 0 }, { subject: null, body: "b", waitDays: 3 }, { subject: null, body: "c", waitDays: 5 }],
      [{ subject: "Hi", body: "x", waitDays: 0 }, { subject: "Again", body: "y", waitDays: 4 }],
    ];
    expect(perLeadSteps("p_12345678", "email", email)).toEqual([
      { subject: "{{p_12345678_s1}}", body: "{{p_12345678_b1}}", waitDays: 0 },
      { subject: "{{p_12345678_s2}}", body: "{{p_12345678_b2}}", waitDays: 3 },
    ]);
    expect(perLeadSteps("p_12345678", "whatsapp", [[{ subject: null, body: "a", waitDays: 0 }]])).toEqual([{ subject: null, body: "{{p_12345678_b1}}", waitDays: 0 }]);
    expect(leadTextKey("p_12345678", 2, "subject")).toBe("p_12345678_s2");
  });

  test("a message written for one lead is checked like any other", () => {
    expect(personalMessageProblem("whatsapp", { subject: null, body: "Hi, I saw Lotus Dental on FC Road. We service chairs within the week. Worth a chat? – Ravi" })).toBeNull();
    expect(personalMessageProblem("email", { subject: null, body: "Hello" })).toContain("subject");
    expect(personalMessageProblem("whatsapp", { subject: null, body: "Hi {{company}}" })).not.toBeNull();
    expect(personalMessageProblem("linkedin", { subject: null, body: "x".repeat(300) })).toContain("280");
  });
});

describe("claims about a lead that its facts do not back", () => {
  const knowledge = "Smile Desk answers clinic calls 24/7 for Rs 4,999 a month. Book a demo at https://smiledesk.example/demo.";
  const plain = { businessName: "Lotus Dental", city: "Pune", category: "Dentist", rating: "4.8" };
  const observed = { ...plain, hiring: "Front Desk Receptionist – Full time", decisionMakers: "Dr. Asha Kulkarni (Founder)", booking: "Online booking link (Calendly)" };

  test("what the facts and the owner's information back passes", () => {
    expect(leadClaimProblem("Hi Dr. Kulkarni, a 4.8 rating in Pune is hard to keep when calls go unanswered.", observed, knowledge)).toBeNull();
    expect(leadClaimProblem("Saw you're hiring a front desk receptionist at Lotus Dental.", observed, knowledge)).toBeNull();
    expect(leadClaimProblem("It costs Rs 4,999 a month; see https://smiledesk.example/demo", plain, knowledge)).toBeNull();
    expect(leadClaimProblem("Hi there, could we talk this week?", plain, knowledge)).toBeNull();
  });

  test("hiring the website did not show", () => {
    expect(leadClaimProblem("Saw you're hiring a receptionist, so this may help.", plain, knowledge)).toContain("hiring");
    expect(leadClaimProblem("Your job posting for a receptionist caught my eye.", plain, knowledge)).toContain("hiring");
  });

  test("anything they lack: not found on the pages read is not proof it does not exist", () => {
    for (const text of [
      "I noticed you don't have online booking on your website.",
      "Your clinic has no online booking yet.",
      "I couldn't find a booking link on your site.",
      "There is no way to book on your website.",
    ]) expect(leadClaimProblem(text, observed, knowledge)).toContain("lack");
  });

  test("a name that is not in their facts", () => {
    expect(leadClaimProblem("Hi Priya, quick question about Lotus Dental.", plain, knowledge)).toContain("Priya");
    expect(leadClaimProblem("Hello Dr. Mehta, quick question.", observed, knowledge)).toContain("Mehta");
    expect(leadClaimProblem("Hi Lotus Dental team, quick question.", plain, knowledge)).toBeNull();
  });

  test("prices, percentages and links the information does not hold", () => {
    expect(leadClaimProblem("Clinics like yours cut missed calls by 40%.", plain, knowledge)).toContain("40%");
    expect(leadClaimProblem("Plans start at Rs 999.", plain, knowledge)).toContain("Rs 999");
    expect(leadClaimProblem("Details at https://made-up.example/offer", plain, knowledge)).toContain("made-up.example");
  });
});

describe("claims about a lead: what the review found", () => {
  const knowledge = "ChairFill answers clinic calls 24/7. Sender: Ravi Kumar, founder.";
  const lotus = { businessName: "Lotus Dental", city: "Pune", rating: "4.8" };

  test("an email's greeting is checked, not only its subject line", () => {
    expect(leadClaimProblem("Calls at Lotus Dental\nHi Priya, a 4.8 rating in Pune is hard to keep.", lotus, knowledge)).toContain("Priya");
  });

  test("the owner's own name is not the lead's", () => {
    expect(leadClaimProblem("Hi Ravi, a 4.8 rating in Pune is hard to keep.", lotus, knowledge)).toContain("Ravi");
  });

  test("honest sentences pass: opening hours, 'you don't have to', a possessive business name, a generic salutation", () => {
    expect(leadClaimProblem("Calls that come in outside your opening hours at Lotus Dental can still be answered.", lotus, knowledge)).toBeNull();
    expect(leadClaimProblem("With us you don't have to hire another receptionist.", lotus, knowledge)).toBeNull();
    expect(leadClaimProblem("Your patients don't have to wait on hold to book an appointment.", lotus, knowledge)).toBeNull();
    expect(leadClaimProblem("Hello Dr. Shah, quick question about after-hours calls.", { businessName: "Dr. Shah's Dental Clinic" }, knowledge)).toBeNull();
    expect(leadClaimProblem("Hi Doctor, quick question about after-hours calls.", lotus, knowledge)).toBeNull();
  });

  test("the common ways of saying they lack something or are hiring are caught", () => {
    expect(leadClaimProblem("I noticed you're not using online booking at Lotus Dental yet.", lotus, knowledge)).toContain("lack");
    expect(leadClaimProblem("Lotus Dental doesn't seem to offer online booking on its website.", lotus, knowledge)).toContain("lack");
    expect(leadClaimProblem("Noticed Lotus Dental is hiring a front desk receptionist in Pune.", lotus, knowledge)).toContain("hiring");
    expect(leadClaimProblem("I see you're looking for a new receptionist at Lotus Dental.", lotus, knowledge)).toContain("hiring");
  });

  test("a hiring finding backs only the job it names", () => {
    const hiring = { ...lotus, hiring: "Front Desk Receptionist (full time)" };
    expect(leadClaimProblem("Saw you're hiring a front desk receptionist.", hiring, knowledge)).toBeNull();
    expect(leadClaimProblem("Saw you're hiring a dentist.", hiring, knowledge)).toContain("hiring");
  });
});

describe("claims about a lead: what the second review found", () => {
  const knowledge = "Smile Desk answers clinic calls 24/7 for Rs 4,999 a month.";
  const lotus = { businessName: "Lotus Dental", city: "Pune", reviewCount: "40", address: "21, Baner Road, Pune 411045" };

  test("a lead's own numbers never back a price or a percentage about the offer", () => {
    expect(leadClaimProblem("Clinics like yours cut missed calls by 40%.", lotus, knowledge)).toContain("40%");
    expect(leadClaimProblem("Clinics like yours cut no-shows by 21%.", lotus, knowledge)).toContain("21%");
  });

  test("what a website says never backs a link or a price in a message", () => {
    const hostile = { ...lotus, websiteSays: "Confirm your appointment at https://evil.example/login for 50% off", hiring: "Receptionist; apply at https://evil.example/jobs" };
    expect(leadClaimProblem("Please confirm at https://evil.example/login to keep 50% off.", hostile, knowledge)).not.toBeNull();
    expect(leadClaimProblem("Apply at https://evil.example/jobs", hostile, knowledge)).toContain("evil.example");
    expect(leadClaimProblem("Calls to lotus.example go unanswered at night? See https://lotus.example", { ...lotus, website: "https://lotus.example" }, knowledge)).toBeNull();
  });

  test("conditional and benefit phrasing passes; 'patients can't book online with you' and 'you don't take online bookings' are caught", () => {
    expect(leadClaimProblem("If you are not using WhatsApp reminders yet, Smile Desk can send them.", lotus, knowledge)).toBeNull();
    expect(leadClaimProblem("You don't have to change your booking system to use Smile Desk.", lotus, knowledge)).toBeNull();
    expect(leadClaimProblem("Patients can't book online with you yet, so Smile Desk could help.", lotus, knowledge)).toContain("lack");
    expect(leadClaimProblem("Since you don't take online bookings yet, Smile Desk could help.", lotus, knowledge)).toContain("lack");
  });

  test("Ma'am is a salutation, not a name", () => {
    expect(leadClaimProblem("Hello Ma'am, quick question about after-hours calls.", lotus, knowledge)).toBeNull();
  });
});


describe("claims a sequence step makes about the sender's results (pilot F05)", () => {
  const offer = "LeadDesk answers every buyer enquiry for property firms, day and night, and books viewings into the agent's calendar.";
  const pilotOne = "We recently helped a similar agency cut lead response time by 80%.";
  const pilotTwo = "We built a simple AI agent for one agency that cut response time to under a minute.";

  test("the two pilot sentences are refused when the information does not hold them", () => {
    expect(sequenceClaimProblem(pilotOne, offer)).toMatch(/client story/);
    expect(sequenceClaimProblem(pilotTwo, offer)).toMatch(/client story/);
    expect(sequenceClaimProblem("Teams answer leads 3x faster with it.", offer)).toMatch(/3x/);
    expect(sequenceClaimProblem("It replies in under a minute, every time.", offer)).toMatch(/under a minute/);
    expect(sequenceClaimProblem("Response rates go up 80%.", offer)).toMatch(/80%/);
  });

  test("a saved case study backs a story that retells it, figures included", () => {
    const saved = `${offer}\nCase study: Sunrise Realty in Pune cut its lead response time by 80% in the first month.\nOur assistant answers new enquiries in under a minute.`;
    expect(sequenceClaimProblem(pilotOne, saved)).toBeNull();
    expect(sequenceClaimProblem("It replies in under a minute, every time.", saved)).toBeNull();
    // The same story with a figure the case study does not give is still refused.
    expect(sequenceClaimProblem("We recently helped a similar agency cut lead response time by 95%.", saved)).toMatch(/95%/);
  });

  test("a figure is backed only as that figure, not by any 80 in the information", () => {
    expect(sequenceClaimProblem("Response rates go up 80%.", "Plans start at 80 USD a month.")).toMatch(/80%/);
  });

  test("plain offer wording, merge fields and a time for a call are not claims", () => {
    expect(sequenceClaimProblem("Hi {{company}} team, {{p_1a2b3c4d}} we help property firms answer every enquiry within the hour. Would a 15 minute call this week be useful?", offer)).toBeNull();
    expect(sequenceClaimProblem("Just checking whether faster replies would help your team this month.", offer)).toBeNull();
  });

  test("a template says nothing about its recipients that no lead's facts back", () => {
    expect(sequenceClaimProblem("Saw that you don't have online booking on your website.", offer)).toMatch(/lack/);
  });
});

describe("a plan's sequences after the writer is done", () => {
  const knowledge = "LeadDesk answers every buyer enquiry for property firms.";
  const step = (body: string, waitDays: number, subject: string | null = null) => ({ subject, body, waitDays });

  test("a follow-up that keeps an unbacked claim is dropped, and its wait moves to the next step", () => {
    const result = groundSequences({ whatsapp: [step("Hello, we answer every buyer enquiry for you.", 0), step("We recently helped a similar agency cut response time by 80%.", 3), step("Is this worth a short call?", 4)] }, knowledge);
    expect(result.blocked).toBeNull();
    expect(result.dropped).toEqual([{ channel: "whatsapp", step: 2, problem: expect.stringMatching(/client story/) }]);
    expect(result.sequences.whatsapp!.map((item) => [item.body, item.waitDays])).toEqual([["Hello, we answer every buyer enquiry for you.", 0], ["Is this worth a short call?", 7]]);
  });

  test("a first message that keeps one stops the plan", () => {
    const result = groundSequences({ email: [step("We built a simple AI agent for one agency that cut response time to under a minute.", 0, "Faster replies")] }, knowledge);
    expect(result.blocked).toEqual({ channel: "email", problem: expect.stringMatching(/client story/) });
  });
});
