import { describe, expect, test } from "bun:test";
import { displayBusinessName, lineClash, longestList, pitchProblems, repeatedOpeners, visibleLength } from "./pitch";

// The message the owner saw sent (WhatsApp, 2026-10-16), as the template it came from.
const SENT = [
  "Hi {{company}} team,",
  "{{p_1a2b3c4d}}",
  "Listen, quick one. I run 22nd X AI, an AI consulting agency. We build every type of agent a business needs, calling agents, lead qualification, CRM automation, plus websites and landing pages. If you could automate one part of your lead follow-up, what would it be?",
  "– Ravi, 22nd X AI",
].join("\n");

describe("business names", () => {
  test("the legal form and a listing's tagline are left out", () => {
    expect(displayBusinessName("Sold By Tereza Inc.")).toBe("Sold By Tereza");
    expect(displayBusinessName("Hu & Blue Real Estate Group, LLC")).toBe("Hu & Blue Real Estate Group");
    expect(displayBusinessName("Bright Smile Dental Pvt. Ltd.")).toBe("Bright Smile Dental");
    expect(displayBusinessName("Crystal View Cleaning | Best cleaners in LA")).toBe("Crystal View Cleaning");
    expect(displayBusinessName("Coldwell Banker Hallmark Realty")).toBe("Coldwell Banker Hallmark Realty");
  });
  test("words that belong to the name are kept", () => {
    expect(displayBusinessName("The Cleaning Company")).toBe("The Cleaning Company");
    expect(displayBusinessName("Smith & Co")).toBe("Smith & Co");
    expect(displayBusinessName("Bob's Gaming PC")).toBe("Bob's Gaming PC");
    expect(displayBusinessName("Acme Corp.")).toBe("Acme");
    expect(displayBusinessName("Acme Private Limited")).toBe("Acme");
    expect(displayBusinessName("Acme Pvt. Ltd.")).toBe("Acme");
  });
  test("a name that would be emptied is kept as it was", () => {
    expect(displayBusinessName("Inc.")).toBe("Inc.");
    expect(displayBusinessName("")).toBe("");
  });
});

describe("pitch checks", () => {
  test("the message that went out: a list of five services and too long for a first WhatsApp", () => {
    expect(longestList(SENT)).toBeGreaterThan(3);
    const problems = pitchProblems("whatsapp", SENT, { first: true });
    expect(problems.some((problem) => problem.includes("lists"))).toBe(true);
    expect(problems.some((problem) => problem.includes("keep it under 260"))).toBe(true);
  });
  test("the same word opening two sentences is found; short words are not", () => {
    expect(repeatedOpeners("Listen — we saw your shop.\nListen, quick one. We fix that.")).toEqual(["listen"]);
    expect(repeatedOpeners("We fix leaks. We answer fast.")).toEqual([]);
  });
  test("a short, specific first message passes", () => {
    const good = "Hi {{company}} team,\n{{p_1a2b3c4d}}\nWhen a buyer enquiry comes in after hours, does it wait until morning? We set up an assistant that answers it in seconds and books the viewing. Worth a two-minute look?\n– Ravi, 22nd X AI";
    expect(pitchProblems("whatsapp", good, { first: true })).toEqual([]);
    expect(visibleLength(good)).toBeLessThan(260);
  });
  test("follow-ups are not held to the first message's length", () => {
    const long = `Following up with one more reason. ${"Most enquiries arrive in the evening. ".repeat(12)}`;
    expect(pitchProblems("whatsapp", long, { first: false }).some((problem) => problem.includes("keep it under"))).toBe(false);
  });
});

describe("a lead's line before the message", () => {
  test("the line may not open like the message, or repeat its words", () => {
    expect(lineClash("Listen — I came across Sold By Tereza in Glendale.", "Listen, quick one. I run 22nd X AI.")).toContain("starts with");
    expect(lineClash("Saw you run an AI consulting agency too.", "I run an AI consulting agency.")).toContain("repeats");
    expect(lineClash("Saw Sold By Tereza has 4.9 stars from Glendale buyers.", "When a buyer enquiry comes in after hours, does it wait?")).toBeNull();
    expect(lineClash("", "anything")).toBeNull();
  });
});

describe("checked on the writer's own words", () => {
  test("a role and business name in a signature are not a list (the code adds the signature after the check)", () => {
    const body = "Hi {{company}} team,\nWhen a buyer enquiry comes in after hours, does it wait until morning? We answer it in seconds. Worth a look?\nBest regards,";
    expect(pitchProblems("email", body, { first: true })).toEqual([]);
  });
});
