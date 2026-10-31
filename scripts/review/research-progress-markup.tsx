/** React render only: no browser, server, accounts or outgoing actions. */
import { renderToStaticMarkup } from "react-dom/server";
import { RequestActivity } from "@/components/assistant/RequestActivity";
import type { ProgressMessage, ProgressObjective } from "@/components/assistant/researchProgress";

let checks = 0;
const check = (label: string, ok: unknown) => { if (!ok) throw new Error(label); checks++; console.log(`PASS ${label}`); };
const objective: ProgressObjective = { status: "active", request: "Find potential clients for website and automation work", review: { leads: 26, match: 5, noMatch: 3, unconfirmed: 12, pending: 6, unchecked: 14 }, leadTarget: 50, targetNamed: false, leads: 5, waiting: null, nextEligibleAt: null, stopDetail: null, createdAt: "2026-10-31T10:00:00Z", stoppedAt: null };
const activity: ProgressMessage[] = [
  { id: "brief", role: "tool", tool: "set_brief", status: "ok", toolResult: { data: { brief: { approach: "Compare businesses with manual booking workflows" } } } },
  { id: "review", role: "tool", tool: "review_leads", status: "ok", toolResult: null },
  { id: "read", role: "tool", tool: "browser_tab_read", status: "running", toolResult: null },
];
const render = (patch: Partial<Parameters<typeof RequestActivity>[0]> = {}) => renderToStaticMarkup(<RequestActivity research={[]} jobs={[]} details={activity} activity={activity} objective={objective} renderDetail={() => "Saved technical step"} numbers={{ found: 26, contactable: 26, matching: 5, contacted: 0, replied: 0, interested: 0 }} target={null} outreach={false} timeZone="UTC" working agentActive statusKnown workingLabel="Reading a page" {...patch} />);
const html = render();
check("browser-only lead research has a visible journey without a provider job", html.includes('data-testid="research-progress"') && html.includes("Checking potential clients") && html.includes("Reading the open page in Chrome"));
check("all five stages and the saved approach are present", ["Approach", "Find", "Check fit", "Shortlist", "Results", "Compare businesses with manual booking workflows"].every((label) => html.includes(label)));
check("review progress is measured against the saved candidate count", html.includes("12 of 26 saved candidates reviewed") && html.includes('aria-valuenow="12"') && html.includes('aria-valuemax="26"') && html.includes("14 still to check"));
check("the default target is labelled honestly", html.includes("5 / 50") && html.includes("default") && !html.includes("50 you asked for"));
check("activity animations respect reduced motion and Details stays collapsed", html.includes("motion-safe:animate-spin") && html.includes("motion-safe:animate-pulse") && html.includes("Saved technical step") && !html.includes("<details open"));
check("live status failure stops activity animation and keeps saved progress", (() => { const failed = render({ statusKnown: false }); return failed.includes("Live status unavailable") && failed.includes("Refresh status to confirm") && failed.includes("12 of 26") && !failed.includes("animate-spin") && !failed.includes("animate-pulse") && failed.includes('data-mood="idle"'); })());
check("a status failure does not leave a stale provider row animated", (() => { const failed = render({ statusKnown: false, research: [{ id: "source", tool: "find_leads", status: "running", content: "", toolInput: null, toolResult: null }] }); return failed.includes("Status unavailable") && !failed.includes("animate-spin") && !failed.includes("animate-pulse"); })());
check("paused research is visibly paused with its results retained", (() => { const paused = render({ objective: { ...objective, status: "paused" } }); return paused.includes("Research paused") && paused.includes("12 of 26") && !paused.includes("animate-spin"); })());
check("older responses with no review counters do not invent reviewed zeros", (() => { const old = render({ objective: { ...objective, review: undefined } }); return !old.includes("saved candidates reviewed") && !old.includes("0 still to check") && old.includes("Reviewed"); })());
check("a brief without a recorded request summary shows unknown counts", (() => { const brief = activity.slice(0, 1); const loading = render({ activity: brief, details: brief, objective: null, numbers: null }); return loading.includes(">—</dd>") && !loading.includes(">0</dd>"); })());
check("ordinary browser tasks retain their own activity and no lead figures", (() => { const task = [{ id: "task", tool: "browser_task", status: "ok", toolResult: null }]; const direct = render({ activity: task, details: task, objective: null, numbers: null }); return direct.includes("Using Chrome") && !direct.includes('data-testid="research-progress"') && !direct.includes('data-testid="request-figures"'); })());
console.log(`Research progress markup: ${checks} passed. React render only.`);
