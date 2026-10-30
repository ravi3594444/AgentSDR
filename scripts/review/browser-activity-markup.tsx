/** Real React render; no browser, server, database or external service. */
import { renderToStaticMarkup } from "react-dom/server";
import { RequestActivity } from "@/components/assistant/RequestActivity";
import type { ResearchJob, ResearchMessage } from "@/components/assistant/researchView";

let checks = 0;
const check = (label: string, ok: unknown) => { if (!ok) throw new Error(label); checks++; console.log(`PASS ${label}`); };
const details: Array<{ id: string; tool: string; status: string; toolResult: { data: Record<string, unknown> } }> = [
  { id: "task", tool: "browser_task", status: "ok", toolResult: { data: { grant: { goal: 'Send "hi" to the confirmed number' } } } },
  ...Array.from({ length: 11 }, (_, i) => ({ id: `step-${i}`, tool: "browser_tab_read", status: "ok", toolResult: { data: { url: "https://web.whatsapp.com/send?phone=12025550101" } } })),
];
const render = (research: ResearchMessage[] = [], jobs: ResearchJob[] = []) => renderToStaticMarkup(<RequestActivity research={research} jobs={jobs} details={details} renderDetail={() => "Technical step"} numbers={null} target={null} outreach={false} timeZone="UTC" working={false} workingLabel={null} />);
const html = render();
check("a browser-only request has a browser activity heading", html.includes("Browser activity") && html.includes("Chrome · WhatsApp"));
check("browser calls are not described as searches or multiplied source counts", !html.includes("Also searched directly") && !html.includes("Your Chrome ×") && !html.includes("Sources used:"));
check("twelve technical steps remain available in collapsed Details", html.includes("12") && html.includes("steps") && html.includes("<details") && !html.includes("<details open"));
check("a direct task does not acquire lead-count tiles", !html.includes("request-figures"));
details.at(-1)!.toolResult.data.readiness = { state: "timeout" };
check("an ordinary readiness wait has truthful waiting text", render().includes("Waiting for page"));
delete details.at(-1)!.toolResult.data.readiness;
const research: ResearchMessage[] = [{ id: "search", tool: "find_leads", status: "ok", content: "", toolInput: { what: "clinics", where: "Pune" }, toolResult: { data: { jobId: "job" } } }];
const jobs: ResearchJob[] = [{ id: "job", kind: "discovery", status: "succeeded", stage: "done", progress: {}, result: { found: 2, eligible: 1 }, error: null, audienceId: null }];
const mixed = render(research, jobs);
check("a mixed request retains its provider search and separate browser activity", mixed.includes('aria-label="Searches"') && mixed.includes("Browser activity:") && mixed.includes("Google Maps"));
console.log(`Browser activity markup checks: ${checks} passed.`);
