import { RiArrowRightSLine, RiCheckLine, RiLoader4Line, RiPauseLine, RiTimeLine } from "@remixicon/react";
import { formatChatTime } from "@/lib/assistant/chatTime";
import { cn } from "@/utils/cn";
import { Mascot } from "./Mascot";
import { RESEARCH_STAGES, type ResearchProgressModel } from "./researchProgress";

function elapsed(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  return seconds < 60 ? `${seconds}s` : seconds < 3_600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3_600)}h ${Math.floor(seconds / 60) % 60}m`;
}

/** One visible research journey, using actual work and counts. Detailed source rows remain underneath. */
export function ResearchProgressCard({ progress, figures, timeZone }: {
  progress: ResearchProgressModel;
  figures: { label: string; value: string }[];
  timeZone: string;
}) {
  const moving = progress.phase === "working";
  const StatusIcon = moving ? RiLoader4Line : progress.phase === "paused" ? RiPauseLine : RiTimeLine;
  const review = progress.review;
  const reviewFigures = [
    { label: "Reviewed", value: review?.reviewed.toLocaleString("en-US") ?? "—" },
    { label: "Unconfirmed", value: review?.uncertain.toLocaleString("en-US") ?? "—", note: "after review" },
    { label: "Excluded", value: review?.excluded.toLocaleString("en-US") ?? "—" },
  ];
  const counts: { label: string; value: string; note?: string }[] = [...figures.slice(0, 3), ...reviewFigures, ...figures.slice(3)];
  return (
    <div className="px-4 pt-4" data-testid="research-progress" data-phase={progress.phase}>
      <div className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-bg-weak-50 ring-1 ring-inset ring-stroke-soft-200" aria-hidden="true">
          <Mascot mood={moving ? progress.stage === "approach" ? "thinking" : "searching" : "idle"} className="size-8" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <p className="text-label-md text-text-strong-950">{progress.title}</p>
            <span className="inline-flex items-center gap-1.5 text-paragraph-xs text-text-sub-600">
              {progress.phase === "finished" ? <span className="size-1.5 rounded-full bg-text-soft-400" aria-hidden="true" /> : <StatusIcon className={cn("size-3.5", moving && "motion-safe:animate-spin")} aria-hidden="true" />}
              {({ working: "In progress", waiting: "Waiting", paused: "Paused", finished: "Ended", unknown: "Unconfirmed status" })[progress.phase]}
            </span>
          </div>
          {progress.goal && <p className="mt-1 text-paragraph-xs text-text-sub-600 [overflow-wrap:anywhere]">{progress.goal}</p>}
        </div>
      </div>

      <ol aria-label="Research stages" className="mt-4 grid grid-cols-5 gap-1 rounded-xl bg-bg-weak-50 p-1.5">
        {RESEARCH_STAGES.map((step, index) => {
          const current = progress.stage === step.id;
          const seen = progress.visited.includes(step.id);
          return (
            <li key={step.id} aria-current={current ? "step" : undefined} className={cn("relative flex min-w-0 flex-col items-center gap-1 rounded-lg px-0.5 py-2 text-center", current && "bg-bg-white-0 shadow-sm ring-1 ring-inset ring-stroke-soft-200")}>
              <span className={cn("flex size-5 items-center justify-center rounded-full text-[10px] font-medium", current ? "bg-text-strong-950 text-bg-white-0" : seen ? "bg-bg-white-0 text-text-sub-600" : "text-text-soft-400")} aria-hidden="true">
                {current && moving ? <span className="size-1.5 rounded-full bg-current motion-safe:animate-pulse" /> : seen && !current ? <RiCheckLine className="size-3.5" /> : index + 1}
              </span>
              <span className={cn("text-[10px] font-medium leading-4 sm:text-xs", current ? "text-text-strong-950" : "text-text-sub-600")}>{step.label}</span>
              {index < RESEARCH_STAGES.length - 1 && <RiArrowRightSLine className="absolute -right-2 top-3.5 z-10 size-3 text-text-soft-400" aria-hidden="true" />}
            </li>
          );
        })}
      </ol>

      <div className="mt-3 rounded-xl border border-stroke-soft-200 px-3 py-2.5" role="status" aria-live="polite" aria-atomic="true">
        <p className="text-paragraph-xs text-text-strong-950 [overflow-wrap:anywhere]">{progress.action}</p>
      </div>
      {progress.approach && (
        <details className="mt-2 text-paragraph-xs text-text-sub-600">
          <summary className="cursor-pointer py-1 text-label-xs">Research approach</summary>
          <p className="mt-1 leading-5 [overflow-wrap:anywhere]">{progress.approach}</p>
        </details>
      )}

      <dl className="mt-3 grid grid-cols-3 gap-x-3 gap-y-3 rounded-xl bg-bg-weak-50 px-3 py-3 sm:grid-cols-6" data-testid="request-figures">
        {counts.map(({ label, value, note }) => (
          <div key={label} className="min-w-0">
            <dt className="text-[11px] leading-4 text-text-sub-600 [overflow-wrap:anywhere]">{label}</dt>
            <dd className="mt-0.5 text-label-md tabular-nums text-text-strong-950">{value}</dd>
            {note && <dd className="text-[10px] leading-4 text-text-soft-400">{note}</dd>}
          </div>
        ))}
      </dl>
      {review && review.total > 0 && (
        <div className="mt-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-paragraph-xs text-text-sub-600">
            <p>{review.reviewed} of {review.total} saved candidates reviewed</p>
            <p className="tabular-nums">{review.remaining} still to check</p>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-bg-soft-200" role="progressbar" aria-label="Saved candidates reviewed" aria-valuemin={0} aria-valuemax={review.total} aria-valuenow={review.reviewed} aria-valuetext={`${review.reviewed} of ${review.total} saved candidates reviewed`}>
            <div className="research-bar h-full rounded-full bg-text-strong-950/70" style={{ width: `${review.reviewed / review.total * 100}%` }} />
          </div>
        </div>
      )}
      {progress.target && <p className="mt-2 text-paragraph-xs text-text-sub-600"><span className="font-medium tabular-nums text-text-strong-950">{progress.target.matched} / {progress.target.total}</span> {progress.target.newOnly ? "new contactable matches" : "contactable matches"} · {progress.target.named ? "requested" : "default"} target</p>}
      <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-text-soft-400">
        {progress.latestAt && <span>Latest step <time dateTime={progress.latestAt}>{formatChatTime(progress.latestAt, timeZone)}</time></span>}
        {progress.elapsedMs !== null && <span className="tabular-nums">{elapsed(progress.elapsedMs)} elapsed</span>}
        {progress.nextAt && progress.phase === "waiting" && <span>Next check <time dateTime={progress.nextAt}>{formatChatTime(progress.nextAt, timeZone)}</time></span>}
      </p>
    </div>
  );
}
