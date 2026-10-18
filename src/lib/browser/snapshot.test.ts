import { describe, expect, test } from "bun:test";
import { elementLine, fillProblem, formatSnapshot, minutesBetween, type PageElement } from "./snapshot";

const link: PageElement = { n: 1, tag: "a", type: null, label: "Next page", href: "https://dir.example/agents?page=2" };
const search: PageElement = { n: 2, tag: "input", type: "search", label: "Search agents", href: null };
const password: PageElement = { n: 3, tag: "input", type: "password", label: "Password", href: null };
const button: PageElement = { n: 4, tag: "button", type: null, label: "", href: null };

describe("what the assistant reads of a browser page", () => {
  test("elements are numbered with their kind, label and link", () => {
    expect(elementLine(link)).toBe('[1] link "Next page" → https://dir.example/agents?page=2');
    expect(elementLine(search)).toBe('[2] input:search "Search agents"');
    expect(elementLine(button)).toBe('[4] button "(no label)"');
  });

  test("the page reads as address, elements and text", () => {
    const text = formatSnapshot({ url: "https://dir.example/agents", title: "Agents", text: "Real   estate\nagents in Pune", elements: [link, search] });
    expect(text).toBe([
      "Page: https://dir.example/agents “Agents”",
      'Elements: [1] link "Next page" → https://dir.example/agents?page=2 [2] input:search "Search agents"',
      "Text: Real estate agents in Pune",
    ].join("\n"));
  });
});

describe("what may be typed", () => {
  test("text fields yes; passwords, buttons and missing elements no", () => {
    expect(fillProblem(search)).toBeNull();
    expect(fillProblem(password)).toContain("never types credentials");
    expect(fillProblem(button)).toContain("not a text field");
    expect(fillProblem(undefined)).toContain("no such element");
  });
});

describe("minutes billed", () => {
  test("rounded up, at least one", () => {
    const start = new Date("2026-10-18T20:00:00Z");
    expect(minutesBetween(start, new Date("2026-10-18T20:00:05Z"))).toBe(1);
    expect(minutesBetween(start, new Date("2026-10-18T20:02:01Z"))).toBe(3);
  });
});
