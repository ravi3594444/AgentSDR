import { describe, expect, test } from "bun:test";
import { judgeReply, normalizeForMatch, quoteSupported, unbackedLinks, unbackedNumbers, unbackedRefusal, unbackedTimes, selfFixableTimes, type ModelCheck } from "./replyCheck";

const knowledge = [
  "Business: Bright Path Dental Supplies",
  "Offer: Same-week servicing for dental chairs and autoclaves. Monthly maintenance plan: ₹2,499 per chair per month, includes two visits.",
  "Service area: Pune and Pimpri-Chinchwad.",
  "How meetings are booked: https://cal.example.test/brightpath",
].join("\n\n");

const base: ModelCheck = { intent: "question", questions: [], claims: [], commitments: [], missing: "", escalate: "" };
const reply = "Hi, our monthly maintenance plan is ₹2,499 per chair and includes two visits. — Ravi";

describe("quote matching", () => {
  test("a quote counts only if it appears in the information (case, quotes and spacing ignored)", () => {
    expect(quoteSupported("Monthly maintenance plan: ₹2,499 per chair per month", knowledge)).toBe(true);
    expect(quoteSupported("  service AREA: Pune and Pimpri-Chinchwad. ", knowledge)).toBe(true);
    expect(quoteSupported("Mumbai", knowledge)).toBe(false);
    expect(quoteSupported("Pune", knowledge)).toBe(false);
    expect(normalizeForMatch("  It’s “Hello”  — World. ")).toBe("it's \"hello\" - world");
  });

  test("amounts and times must be in the information", () => {
    expect(unbackedNumbers("It is Rs 2499 a month.", knowledge)).toEqual([]);
    expect(unbackedNumbers("We can do 10% off, or ₹1,999.", knowledge)).toEqual(["₹1,999", "10%"]);
    expect(unbackedTimes("Could we meet Tuesday at 4pm?", knowledge)).toEqual(["4pm", "Tuesday"]);
    expect(unbackedTimes("Book here: https://cal.example.test/brightpath", knowledge)).toEqual([]);
  });

  test("links and addresses must be in the information", () => {
    expect(unbackedLinks("Book here: https://cal.example.test/brightpath.", knowledge)).toEqual([]);
    expect(unbackedLinks("See https://brightpath.example.test/brochure.pdf or write to sales@brightpath.example.test", knowledge))
      .toEqual(["https://brightpath.example.test/brochure.pdf", "sales@brightpath.example.test"]);
  });
});

describe("judgeReply", () => {
  test("a question answered with a real quote is sent", () => {
    const verdict = judgeReply({ ...base, questions: [{ question: "How much is the plan?", answered: true, evidence: "Monthly maintenance plan: ₹2,499 per chair per month" }] }, { reply, knowledge, leadName: "Dr Rao" });
    expect(verdict.action).toBe("send");
  });

  test("a made-up quote is not evidence: the owner is asked", () => {
    const verdict = judgeReply({ ...base, questions: [{ question: "Do you cover Mumbai?", answered: true, evidence: "We cover Mumbai" }] }, { reply: "Yes, we cover Mumbai.", knowledge, leadName: "Dr Rao" });
    expect(verdict).toMatchObject({ action: "hold", kind: "missing_info" });
    if (verdict.action === "hold") expect(verdict.decision).toContain("Mumbai");
  });

  test("an unanswered question becomes a focused question for the owner", () => {
    const verdict = judgeReply({ ...base, questions: [{ question: "Do you service X-ray machines?", answered: false, evidence: "" }], missing: "Do you service dental X-ray machines?" }, { reply: "Thanks for asking!", knowledge, leadName: "Dr Rao" });
    expect(verdict).toMatchObject({ action: "hold", kind: "missing_info", decision: "Do you service dental X-ray machines?" });
  });

  test("invented prices, discounts and appointments are held", () => {
    expect(judgeReply(base, { reply: "I can give you 15% off this month.", knowledge, leadName: "A" })).toMatchObject({ action: "hold", kind: "commitment" });
    expect(judgeReply({ ...base, intent: "negotiation" }, { reply: "OK, ₹1,999 then.", knowledge, leadName: "A" })).toMatchObject({ action: "hold", kind: "negotiation" });
    expect(judgeReply({ ...base, intent: "scheduling" }, { reply: "Does Thursday at 11am work?", knowledge, leadName: "A" })).toMatchObject({ action: "hold", kind: "meeting" });
  });

  test("a booking link from the information may be offered", () => {
    const verdict = judgeReply({ ...base, intent: "scheduling", commitments: [{ commitment: "book a call", evidence: "How meetings are booked: https://cal.example.test/brightpath" }] }, { reply: "Pick any time here: https://cal.example.test/brightpath", knowledge, leadName: "A" });
    expect(verdict.action).toBe("send");
  });

  test("an invented link is held, even when the model calls the answer supported", () => {
    const verdict = judgeReply({ ...base, questions: [{ question: "How much is the plan?", answered: true, evidence: "Monthly maintenance plan: ₹2,499 per chair per month" }] },
      { reply: `${reply} Brochure: https://brightpath.example.test/brochure.pdf`, knowledge, leadName: "Dr Rao" });
    expect(verdict).toMatchObject({ action: "hold", kind: "commitment" });
  });

  test("unbacked claims and promises are held with the reason", () => {
    expect(judgeReply({ ...base, claims: [{ claim: "We are the largest supplier in India", evidence: "" }] }, { reply: "We are the largest supplier in India.", knowledge, leadName: "A" })).toMatchObject({ action: "hold", kind: "missing_info" });
    expect(judgeReply({ ...base, commitments: [{ commitment: "send the brochure today", evidence: "" }] }, { reply: "I'll send the brochure.", knowledge, leadName: "A" })).toMatchObject({ action: "hold", kind: "commitment" });
  });

  test("opt-outs stop, complaints and escalations go to the owner, out-of-office waits", () => {
    expect(judgeReply({ ...base, intent: "opt_out" }, { reply: "Sorry to bother you.", knowledge, leadName: "A" })).toMatchObject({ action: "opt_out" });
    expect(judgeReply({ ...base, intent: "complaint" }, { reply: "Sorry.", knowledge, leadName: "A" })).toMatchObject({ action: "hold", kind: "complaint" });
    expect(judgeReply({ ...base, escalate: "They mention a legal dispute." }, { reply: "Thanks.", knowledge, leadName: "A" })).toMatchObject({ action: "hold", kind: "uncertain" });
    expect(judgeReply({ ...base, intent: "out_of_office" }, { reply: "Thanks.", knowledge, leadName: "A" })).toMatchObject({ action: "hold" });
  });

  test("a thank-you with no claims is sent", () => {
    expect(judgeReply({ ...base, intent: "not_interested" }, { reply: "Thanks for letting me know, Dr Rao. All the best. — Ravi", knowledge, leadName: "Dr Rao" }).action).toBe("send");
  });
});

describe("saying what is not offered", () => {
  test("a refusal needs the owner's information to state the limit", () => {
    expect(unbackedRefusal("No, we currently only provide chair and autoclave servicing.", ["Same-week servicing for dental chairs and autoclaves"])).toBe(true);
    expect(unbackedRefusal("Hum sirf Pune mein service karte hain.", ["Service area: Pune and Pimpri-Chinchwad."])).toBe(true);
    expect(unbackedRefusal("We only serve Pune and PCMC.", ["We serve only Pune and Pimpri-Chinchwad, not other cities."])).toBe(false);
    expect(unbackedRefusal("Yes, the plan is ₹2,499 per chair.", [])).toBe(false);
  });

  test("an X-ray question answered 'no' from a list of services goes to the owner", () => {
    const verdict = judgeReply(
      { ...base, questions: [{ question: "Do you service X-ray machines?", answered: true, evidence: "Same-week servicing for dental chairs and autoclaves" }] },
      { reply: "No, we currently only provide chair and autoclave servicing. — Ravi", knowledge, leadName: "Dr Rao" },
    );
    expect(verdict).toMatchObject({ action: "hold", kind: "missing_info" });
  });
});

describe("selfFixableTimes", () => {
  test("only a reply whose sole fault is a proposed time is rewritten by itself", () => {
    const check = (problems: string[]) => ({ intent: "question", questions: [], claims: [], commitments: [], problems });
    expect(selfFixableTimes(check(["time not in your information: this week"]))).toEqual(["this week"]);
    expect(selfFixableTimes(check(["time not in your information: this week", "amount not in your information: ₹1,999"]))).toBeNull();
    expect(selfFixableTimes(check([]))).toBeNull();
  });
});
