import { METRICS, type MetricKey } from "@/lib/reporting/metrics";

/**
 * How the shared figures are counted, in the words both Overview and
 * Analytics use (src/lib/reporting/metrics.ts). Current counts say "now".
 */
export function MetricDefinitions({ keys }: { keys: readonly MetricKey[] }) {
  return (
    <dl className="grid gap-x-8 gap-y-3 text-paragraph-xs sm:grid-cols-2">
      {keys.map((key) => (
        <div key={key} className="min-w-0">
          <dt className="text-label-xs text-text-strong-950">
            {METRICS[key].label}
            <span className="ml-1.5 font-normal text-text-soft-400">{METRICS[key].kind === "now" ? "right now" : "in the period"}</span>
          </dt>
          <dd className="mt-0.5 text-text-sub-600">{METRICS[key].definition}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The shared figures both pages show, in the order the definitions are listed. */
export const SHARED_METRIC_KEYS: readonly MetricKey[] = [
  "sent",
  "delivered",
  "read",
  "replies",
  "peopleContacted",
  "peopleReplied",
  "replyRate",
  "foundLeads",
  "qualifiedLeads",
  "contactableLeads",
  "needsYouNow",
  "draftsAwaitingReviewNow",
  "actionRequiredNow",
  "followUpsDueNow",
  "plansAwaitingStartNow",
  "stillToSendNow",
];
