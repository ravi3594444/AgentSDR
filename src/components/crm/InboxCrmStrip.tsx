"use client";

import { useState } from "react";
import { RiErrorWarningLine, RiLoader4Line, RiRouteLine, RiSparkling2Fill } from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import { useDialogs } from "@/components/DialogProvider";
import { ClassificationPicker, humanize, type ClassificationChoice } from "@/components/crm/ActionRowTools";
import { crmFetch, errorMessage } from "@/components/crm/crm-utils";
import type { InboxCrmContext, InboxCrmDraft, InboxCrmSummary } from "@/lib/linkedin/messages/crmContext";
import { inboxCrmStepLabel } from "@/lib/linkedin/messages/crmContext";
import { cn } from "@/utils/cn";

/**
 * CRM state for an open inbox thread, as the pieces the inbox places where
 * they are acted on:
 *
 * - `CrmCategoryControl` — the classification, as the tinted chip in the
 *   thread header; picking another category reclassifies the record.
 * - `CrmDraftCard` — the drafted reply, pinned above the composer where it
 *   is reviewed and sent.
 * - `DoNotContactNotice` — in place of the composer when the lead opted out.
 * - `crmSequenceLine` — sequence, step and next action, for the details column.
 *
 * `InboxCrmStrip` still composes them into one band for any caller that
 * wants the old all-in-one strip.
 */

/** Shape of `GET /api/crm/categories` → `categories[]`, as far as the inbox needs it. */
export type CrmCategoryOption = {
  key: string;
  label?: string;
  subcategories: { id: string; name: string; categoryKey: string; active?: boolean }[];
};

/** The (sub)category a row or header names: the subcategory, else the category, else "Unclassified". */
export function crmCategoryLabel(summary: Pick<InboxCrmSummary, "categoryKey" | "subcategoryName"> | null | undefined): string {
  if (!summary) return "Unclassified";
  return summary.subcategoryName ?? (summary.categoryKey ? humanize(summary.categoryKey) : "Unclassified");
}

/** "Sequence · Reply drafted · next 30 Sep, 13:39". */
export function crmSequenceLine(context: InboxCrmSummary): string {
  const nextAt = context.nextActionAt ? new Date(context.nextActionAt) : null;
  const nextAtLabel = nextAt && !Number.isNaN(nextAt.getTime())
    ? nextAt.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : null;
  return `${context.sequenceName ? `${context.sequenceName} · ` : ""}${inboxCrmStepLabel(context)}${nextAtLabel ? ` · next ${nextAtLabel}` : ""}`;
}

/**
 * The record's classification as the header's category chip. Saving calls
 * `onClassified` so the caller re-fetches and watches for the regenerated draft.
 */
export function CrmCategoryControl({
  context,
  categories,
  disabled,
  onClassified,
  className,
}: {
  context: InboxCrmContext;
  categories: CrmCategoryOption[];
  disabled?: boolean;
  onClassified: () => void;
  className?: string;
}) {
  const dialogs = useDialogs();
  const [saving, setSaving] = useState(false);

  const classify = async (choice: ClassificationChoice) => {
    if (saving) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        categoryKey: choice.categoryKey,
        subcategoryId: choice.subcategoryId,
        expectedContextVersion: context.contextVersion,
      };
      if (context.classificationId) body.classificationId = context.classificationId;
      await crmFetch(`/records/${context.recordId}/classification`, { method: "PATCH", body: JSON.stringify(body) });
      onClassified();
    } catch (err) {
      void dialogs.alert({ title: "Could not update classification", description: errorMessage(err), variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
      <ClassificationPicker
        categories={categories}
        categoryKey={context.categoryKey}
        subcategoryId={context.subcategoryId}
        subcategoryName={context.subcategoryName}
        onChange={(choice) => void classify(choice)}
        disabled={disabled || saving}
        compact
        title="CRM category — change to reclassify"
        className="min-w-0 max-w-[11rem]"
      />
      {saving && <RiLoader4Line className="size-3.5 shrink-0 animate-spin text-text-soft-400" aria-label="Saving classification" />}
    </span>
  );
}

/** The lead opted out: said once, where the reply box would be. */
export function DoNotContactNotice({ className }: { className?: string }) {
  return (
    <div role="alert" className={cn("flex items-start gap-2 rounded-xl bg-error-lighter px-3 py-2.5 text-paragraph-xs text-error-dark ring-1 ring-inset ring-error-light", className)}>
      <RiErrorWarningLine className="mt-px size-4 shrink-0" aria-hidden="true" />
      <span>
        <span className="text-label-xs">Do not contact.</span> This lead opted out, so sending is turned off.
      </span>
    </div>
  );
}

/**
 * The drafted reply, above the composer. Ready: a preview and "Review draft",
 * which loads it into the reply box to edit and approve. Drafting: a quiet
 * progress line. Failed: the reason. Hidden while the draft is in the box —
 * the composer carries it then.
 */
export function CrmDraftCard({
  draft,
  active,
  disabled,
  onUse,
  useLabel = "Review draft",
}: {
  draft: InboxCrmDraft;
  active: boolean;
  disabled?: boolean;
  onUse: () => void;
  useLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (active) return null;
  const typeLabel = draft.stepType === "follow_up" ? "Follow-up" : "Reply";
  const stepLabel = draft.stepName && draft.stepName !== typeLabel ? draft.stepName : null;
  const ready = draft.status === "awaiting_review";
  const long = draft.body.length > 200 || draft.body.split("\n").length > 3;

  return (
    <section
      aria-label="AI-drafted reply"
      className={cn(
        "rounded-xl px-3.5 py-2.5 ring-1 ring-inset",
        draft.status === "failed" ? "bg-bg-weak-50 ring-stroke-soft-200" : "bg-primary-alpha-10 ring-primary-alpha-16",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-primary-base text-primary-contrast">
          <RiSparkling2Fill className="size-3" aria-hidden="true" />
        </span>
        <p className="min-w-0 flex-1 truncate text-label-xs text-text-strong-950" title={stepLabel ?? undefined}>
          {ready ? `AI ${typeLabel.toLowerCase()} ready` : draft.status === "generating" ? `Drafting a ${typeLabel.toLowerCase()}…` : `${typeLabel} draft failed`}
          {stepLabel && <span className="font-normal text-text-sub-600"> · {stepLabel}</span>}
        </p>
        {draft.status === "generating" && <RiLoader4Line className="size-4 shrink-0 animate-spin text-primary-base" aria-hidden="true" />}
        {ready && (
          <Button.Root variant="primary" mode="filled" size="xxsmall" onClick={onUse} disabled={disabled} className="shrink-0">
            {useLabel}
          </Button.Root>
        )}
      </div>
      {draft.status === "failed" && draft.error && <p className="mt-1 line-clamp-2 text-paragraph-xs text-error-base" title={draft.error}>{draft.error}</p>}
      {ready && draft.body && (
        <div className="mt-1.5 pl-7">
          <p className={cn("whitespace-pre-wrap text-paragraph-xs leading-relaxed text-text-sub-600", expanded ? "max-h-48 overflow-y-auto" : "line-clamp-2")}>{draft.body}</p>
          {long && (
            <button
              type="button"
              onClick={() => setExpanded((open) => !open)}
              aria-expanded={expanded}
              className="mt-0.5 text-label-xs text-text-sub-600 underline-offset-2 outline-none hover:text-text-strong-950 hover:underline focus-visible:underline"
            >
              {expanded ? "Show less" : "Show full draft"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** The all-in-one band: category, sequence line, do-not-contact and the draft. */
export function InboxCrmStrip({
  context,
  categories,
  activeDraftId,
  disabled,
  onClassified,
  onUseDraft,
}: {
  context: InboxCrmContext;
  categories: CrmCategoryOption[];
  activeDraftId: string | null;
  disabled?: boolean;
  onClassified: () => void;
  onUseDraft: (draft: InboxCrmDraft) => void;
}) {
  const sequenceLine = crmSequenceLine(context);
  return (
    <div className="space-y-2 border-t border-stroke-soft-200 bg-bg-weak-50 px-4 py-2.5 sm:px-5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <CrmCategoryControl context={context} categories={categories} disabled={disabled} onClassified={onClassified} />
        <span className="inline-flex min-w-0 items-center gap-1 text-paragraph-xs text-text-sub-600" title={sequenceLine}>
          <RiRouteLine className="size-3.5 shrink-0 text-text-soft-400" aria-hidden="true" />
          <span className="truncate">{sequenceLine}</span>
        </span>
      </div>
      {context.doNotContact && <DoNotContactNotice />}
      {context.draft && (
        <CrmDraftCard draft={context.draft} active={activeDraftId === context.draft.id} disabled={disabled || context.doNotContact} onUse={() => onUseDraft(context.draft!)} />
      )}
    </div>
  );
}
