import type { ComponentType, ReactNode } from "react";
import { cn } from "@/utils/cn";

/**
 * Shared empty state, with the layered-icon pattern seen on 21st.dev.
 * https://21st.dev/@serafimcloud/components/empty-state
 * Uses the existing props and actions: a short title that says what
 * is missing, one line on what to do about it, and an optional action.
 * Use inside a FramePanel or a split pane; it centres itself.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  compact = false,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  /** Less vertical padding, for small cards and list panes. */
  compact?: boolean;
}) {
  return (
    <div className={cn("group/empty flex flex-col items-center justify-center text-center", compact ? "px-4 py-8" : "px-6 py-16", className)}>
      <div aria-hidden="true" className={cn("relative flex items-center justify-center", compact ? "size-10" : "h-16 w-28")}>
        {!compact && <>
          <span className="absolute left-2 top-3 size-11 -rotate-12 rounded-xl border border-stroke-soft-200 bg-bg-weak-50 transition-transform duration-200 group-hover/empty:-translate-x-1 motion-reduce:transition-none" />
          <span className="absolute right-2 top-3 size-11 rotate-12 rounded-xl border border-stroke-soft-200 bg-bg-weak-50 transition-transform duration-200 group-hover/empty:translate-x-1 motion-reduce:transition-none" />
        </>}
        <span className={cn("relative flex items-center justify-center rounded-xl border border-stroke-sub-300 bg-bg-white-0 shadow-regular-xs", compact ? "size-10" : "size-14")}>
          <Icon className={cn("text-text-strong-950", compact ? "size-5" : "size-6")} />
        </span>
      </div>
      <p className="mt-4 text-label-md text-text-strong-950">{title}</p>
      {description && <p className="mt-2 max-w-sm text-paragraph-sm leading-relaxed text-text-sub-600">{description}</p>}
      {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}
