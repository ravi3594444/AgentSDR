import Link from "next/link";
import type { ReactNode } from "react";
import { RiArrowLeftSLine } from "@remixicon/react";

/**
 * The one page header, matching Analytics: an optional back link, the title
 * with an optional badge beside it, a one-line description or meta row, and
 * actions on the right (stacked under the title on narrow screens).
 */
export function PageHeader({
  title,
  description,
  back,
  badge,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** A detail page's way back to its list. */
  back?: { href: string; label: string };
  /** State that qualifies the page (a status badge), not the section. */
  badge?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header>
      {back && (
        <Link href={back.href} className="-ml-1 mb-2 inline-flex items-center gap-0.5 rounded-md px-1 text-label-xs text-text-sub-600 outline-none transition hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-primary-base">
          <RiArrowLeftSLine className="size-4" aria-hidden="true" />
          {back.label}
        </Link>
      )}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="min-w-0 break-words text-[26px] font-semibold leading-tight tracking-[-0.035em] text-text-strong-950">{title}</h1>
            {badge}
          </div>
          {description && <div className="mt-2 max-w-2xl text-paragraph-sm leading-relaxed text-text-sub-600">{description}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 self-start">{actions}</div>}
      </div>
    </header>
  );
}

/** The page's outer padding and width, the same as Analytics. */
export function PageContainer({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-[1440px] px-4 py-5 sm:px-6 sm:py-6 lg:px-8 ${className}`}>{children}</div>;
}
