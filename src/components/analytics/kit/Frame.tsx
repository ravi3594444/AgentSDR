import Link from "next/link";
import { RiArrowRightLine } from "@remixicon/react";
import { cn } from "@/utils/cn";

/**
 * The house card ("Frame"): a quiet border, a distinct header, and a
 * single surface for the content. Compose:
 *
 *   <Frame>
 *     <FrameHeader title description actions />
 *     <FramePanel>…body…</FramePanel>
 *     <FrameFooter>note</FrameFooter>   // or <FrameFooterLink href>View all →</FrameFooterLink>
 *   </Frame>
 *
 * ChartCard is a Frame with the table-view toggle wired in; use it for charts.
 */
export function Frame({ className, children, ...rest }: React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={cn("flex min-w-0 flex-col rounded-xl border border-stroke-soft-200 bg-bg-white-0", className)} {...rest}>
      {children}
    </section>
  );
}

/**
 * Title + one-line description on the left, `actions` (tabs, filters, select,
 * badge, button) on the right. Filters belong here, not in a row under the
 * title: the whole group drops below the title only when the frame is too
 * narrow for both, and wraps within itself before it would overflow.
 */
export function FrameHeader({ title, description, actions }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-stroke-soft-200 px-4 py-4 sm:px-5">
      <div className="min-w-0">
        <h2 className="text-label-sm text-text-strong-950">{title}</h2>
        {description && <p className="mt-0.5 text-paragraph-xs text-text-sub-600">{description}</p>}
      </div>
      {actions && <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto">{actions}</div>}
    </header>
  );
}

export function FramePanel({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("min-w-0 flex-1 rounded-xl bg-bg-white-0 p-4 sm:p-5", className)} {...rest}>
      {children}
    </div>
  );
}

/** A quiet note under the panel, inside the frame. */
export function FrameFooter({ children }: { children: React.ReactNode }) {
  return <p className="border-t border-stroke-soft-200 px-4 py-3 text-paragraph-xs text-text-sub-600">{children}</p>;
}

/** Full-width subtle link under the panel: "View all campaigns →". */
export function FrameFooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="mt-1 flex h-9 items-center justify-center gap-1.5 rounded-lg text-label-xs text-text-sub-600 outline-none transition hover:bg-bg-white-0 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-primary-base">
      {children} <RiArrowRightLine className="size-3.5" aria-hidden="true" />
    </Link>
  );
}
