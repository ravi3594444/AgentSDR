"use client";

import Link from "next/link";
import { useState } from "react";
import { RiArrowDownSLine, RiInformationLine } from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import { compactEvent } from "@/lib/assistant/chatEvents";
import { cn } from "@/utils/cn";

/**
 * A status line in the chat. A report that carries its figures as data
 * (chatEvents.ts) shows one compact line of counts, with the full text
 * under Show details; any other event — every one in older chats — shows
 * its text as it always did.
 */

const TONE = {
  neutral: "bg-bg-weak-50 text-text-sub-600",
  good: "bg-success-lighter/60 text-text-sub-600",
  warning: "bg-warning-lighter/70 text-text-sub-600",
  bad: "bg-error-lighter/70 text-text-sub-600",
} as const;

export function EventRow({ content, toolResult, links, retry, retryDisabled, onRetry }: {
  content: string;
  toolResult: unknown;
  links: { label: string; href: string }[];
  retry: boolean;
  retryDisabled: boolean;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const compact = compactEvent({ toolResult });
  const linkRow = links.map((link) => (
    <Link key={link.href} href={link.href} className="ml-2 whitespace-nowrap font-medium text-primary-base underline-offset-2 hover:underline">{link.label}</Link>
  ));
  const retryButton = retry && (
    <Button.Root variant="neutral" mode="stroke" size="xxsmall" className="shrink-0" disabled={retryDisabled} onClick={onRetry}>Retry</Button.Root>
  );

  if (!compact) {
    return (
      <div className="flex items-start gap-2 rounded-lg bg-bg-weak-50 px-3 py-2 text-paragraph-xs text-text-sub-600">
        <RiInformationLine className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">{content}{linkRow}</span>
        {retryButton}
      </div>
    );
  }
  return (
    <div className={cn("rounded-lg px-3 py-2 text-paragraph-xs", TONE[compact.tone])} data-testid="event-compact">
      <div className="flex items-start gap-2">
        <RiInformationLine className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-label-xs text-text-strong-950">{compact.title}</p>
          {compact.figures.length > 0 && (
            <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
              {compact.figures.map((figure) => <span key={figure.label}><span className="font-medium tabular-nums text-text-strong-950">{figure.value}</span> {figure.label}</span>)}
            </p>
          )}
          {compact.note && <p className="mt-1 [overflow-wrap:anywhere]">{compact.note}</p>}
          {open && <p className="mt-2 border-t border-stroke-soft-200 pt-2 [overflow-wrap:anywhere]">{content}{linkRow}</p>}
        </div>
        {retryButton}
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-label-xs text-text-sub-600 hover:text-text-strong-950">
          {open ? "Hide" : "Details"}<RiArrowDownSLine className={cn("size-4 transition-transform", open && "rotate-180")} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
