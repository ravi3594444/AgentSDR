import { describe, expect, test } from "bun:test";
import { availableTokens, ensureSignOff, personalizationKey, personalLineProblem, sequenceProblem, templateProblem, templateTokens } from "./messages";

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
