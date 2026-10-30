import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The handoff's check: viewing a lead or its evidence must not prepare,
// approve or send outreach. The list opens with one request, a GET of the
// prospects route, which only reads (audienceProspects). A browser test is
// not available here, so this reads the code on that path.

const root = join(import.meta.dir, "..", "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");
const panel = read("components", "assistant", "ProspectsList.tsx");
const importsOf = (source: string) => [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!);

describe("opening a lead list or its evidence is a GET only", () => {
  test("the panel makes one request, through prospectsRequest, with no method or body", () => {
    expect(panel.match(/fetch\(/g)?.length).toBe(1);
    expect(panel).toMatch(/fetch\(url, init\)/);
    expect(panel).toContain("prospectsRequest(audienceId)");
    expect(panel).not.toMatch(/method\s*:/);
    expect(panel).not.toMatch(/body\s*:/);
  });

  test("the panel imports nothing that prepares, approves, starts or sends", () => {
    for (const path of importsOf(panel)) expect(path).not.toMatch(/outreach|send|prepare|approv|runs|autopilot|server/i);
  });

  test("its evidence links only open the source page in a new tab", () => {
    for (const anchor of panel.match(/<a [^>]*>/g) ?? []) {
      expect(anchor).toContain('target="_blank"');
      expect(anchor).toContain('rel="noopener noreferrer"');
      expect(anchor).not.toMatch(/onClick/);
    }
    expect(panel).not.toMatch(/<button|onClick=/);
  });

  test("the route answers GET alone, opened as a read (mutation: false)", () => {
    const route = read("app", "api", "assistant", "audiences", "[id]", "prospects", "route.ts");
    expect([...route.matchAll(/export async function (\w+)/g)].map((match) => match[1])).toEqual(["GET"]);
    expect(route).toContain("{ mutation: false }");
  });

  test("audienceProspects only selects", () => {
    const query = read("lib", "assistant", "qualification.server.ts");
    expect(query).not.toMatch(/\.(insert|update|delete)\(|\.execute\(|\.transaction\(/);
    for (const path of importsOf(query)) expect(path).not.toMatch(/outreach|send|prepare|approv|autopilot/i);
  });
});

describe("the list is one component, opened from the card, the request rows and the report", () => {
  const client = read("components", "assistant", "AssistantClient.tsx");
  const research = read("components", "assistant", "RequestActivity.tsx");
  const row = read("components", "activity", "WorkRow.tsx");

  test("the chat and its research card use the extracted ProspectsList and define none of their own", () => {
    for (const file of [client, research]) {
      expect(file).toContain('from "@/components/assistant/ProspectsList"');
      expect(file).not.toMatch(/function ProspectsList\(/);
      expect(file).not.toMatch(/function WebsiteFindings\(/);
    }
    // Under each search (research card), under added or imported contacts and under the final report (chat).
    expect(research.match(/<ProspectsList /g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(client.match(/<ProspectsList /g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test("a finished search row under a request opens its own list", () => {
    expect(row).toContain('from "@/components/assistant/ProspectsList"');
    expect(row).toContain("searchListOf(item)");
    expect(row).toContain("<ProspectsList ");
    expect(row).toContain("workCounts(item)");
    expect(row).not.toMatch(/\} new`/);
  });

  test("its control is an obvious View leads (N), and its body is kept: counts, source, why, left out, routes with source pages, need and website findings", () => {
    expect(panel).toContain("viewLeadsLabel(count)");
    expect(panel).not.toContain("Review the leads: source, why they match, evidence");
    for (const kept of ["potential match", "with their own words showing a need", "A potential match is not an interested customer.", "Why: ", "Left out: ", "Contact: Unknown", "No evidence of a need found.", "Location: ", "Budget: ", "Not found on the", "Named on their website:", "not counted as interest"]) expect(panel).toContain(kept);
    expect(panel).toMatch(/route\.sourceUrl \? <a href=\{route\.sourceUrl\}/);
    expect(panel).toMatch(/onToggle=/);
  });

  test("its dates are written in the organization's zone passed in, never the browser's", () => {
    expect(panel).toContain("timeZone: string");
    expect(panel).toContain("formatChatDate(");
    expect(panel).not.toMatch(/useContext/);
    expect(panel).not.toMatch(/\.toLocale(?:Date|Time)?String\(/);
  });
});
