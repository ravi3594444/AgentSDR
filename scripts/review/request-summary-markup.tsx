/** Real React render of disposable database payloads; no browser or providers. */
import { renderToStaticMarkup } from "react-dom/server";
import type { RequestSummary } from "@/lib/assistant/requests.server";
import { RequestSummaryView } from "@/components/assistant/RequestSummaryView";

const fixture = JSON.parse(await Bun.stdin.text()) as { research: RequestSummary; failed: RequestSummary; outreach: RequestSummary };
let checked = 0;
function check(label: string, ok: boolean) {
  if (!ok) throw new Error(label);
  checked++;
}
const figure = (html: string, label: string, n: number) => new RegExp(`>${label}</dt>\\s*<dd[^>]*>${n}</dd>`).test(html);
for (const compact of [true, false]) {
  const html = renderToStaticMarkup(<RequestSummaryView summary={fixture.research} compact={compact} />);
  check("found is 14, not the zero matching count", figure(html, "Found", 14));
  check("contactable is the deduplicated six, not the sum of source counts", figure(html, "Contactable", 6));
  check("details call zero matches matching leads", html.includes("0 Matching") && !html.includes("0 leads found"));
  check("the default target never appears as 25 wanted", !html.includes("25 wanted") && !html.includes("of 25"));
  check("normal progress has no blocker warning", !html.includes('data-testid="request-blocker"'));
  check("research only does not show irrelevant contacted/replied/interested tiles", !/>Contacted</.test(html) && !/>Replied</.test(html) && !/>Interested</.test(html));
  check("provider waiting is accurate, not Scheduled", html.includes("Waiting for provider results") && !html.includes("Scheduled"));
  const waiting = fixture.research.children.searches.find((item) => item.stateLabel === "Waiting for provider results")!;
  check("the next check is in a machine-readable time element", /next check/i.test(html) && html.includes(`dateTime="${waiting.nextAt}"`));
  check("the provider label is retained", html.includes("Bright Data"));
  const failed = renderToStaticMarkup(<RequestSummaryView summary={fixture.failed} compact={compact} />);
  check("genuine failure warnings are retained", failed.includes('data-testid="request-blocker"') && failed.includes("unreadable snapshot"));
  const outreach = renderToStaticMarkup(<RequestSummaryView summary={fixture.outreach} compact={compact} />);
  check("outreach figures remain visible after research becomes outreach", />Contacted</.test(outreach) && />Replied</.test(outreach) && />Interested</.test(outreach));
}
console.log(`${checked} React markup checks passed (compact + full)`);
