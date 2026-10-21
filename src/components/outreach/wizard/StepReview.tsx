"use client";

import { useEffect, useState } from "react";
import {
  RiArrowLeftLine,
  RiDraftLine,
  RiMailCheckLine,
  RiPlayCircleLine,
  RiStackLine,
  RiTeamLine,
} from "@remixicon/react";

import Link from "next/link";

import * as Button from "@/components/alignui/button";
import { useDialogs } from "@/components/DialogProvider";
import { DocsLink } from "@/components/page/DocsLink";
import type { SequenceStep } from "@/lib/outreach/schema";

type MailboxSummary = { status: string };

export default function StepReview({
  campaignId,
  name,
  leadCount,
  sequence,
  onBack,
  onDone,
}: {
  campaignId: string;
  name: string;
  leadCount: number;
  sequence: SequenceStep[];
  onBack: () => void;
  onDone: (campaignId: string) => void;
}) {
  const dialogs = useDialogs();
  const [connectedMailboxes, setConnectedMailboxes] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState<"draft" | "launch" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/outreach/mailboxes")
      .then((r) => r.json())
      .then((data: { mailboxes: MailboxSummary[] }) => {
        setConnectedMailboxes(data.mailboxes.filter((m) => m.status === "connected").length);
      })
      .catch(() => setConnectedMailboxes(0));
  }, []);

  const canLaunch =
    connectedMailboxes !== null &&
    connectedMailboxes > 0 &&
    sequence.length > 0 &&
    leadCount > 0;

  async function finish(status: "draft" | "active") {
    setSubmitting(status === "active" ? "launch" : "draft");
    setError(null);
    try {
      const res = await fetch(`/api/outreach/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; warning?: string };
      if (!res.ok) {
        setError(data.error ?? "Failed to save");
        return;
      }
      // Launched; its emails may not be prepared for sending yet (they are again automatically).
      if (data.warning) await dialogs.alert({ title: "Campaign launched", description: data.warning, variant: "info" });
      onDone(campaignId);
    } catch {
      setError("Could not update the campaign. Check your connection and try again.");
    } finally {
      setSubmitting(null);
    }
  }

  const lastWait = sequence.length > 1 ? sequence[sequence.length - 1].waitDays : null;

  const cards = [
    { label: "Campaign", value: name, icon: RiDraftLine },
    { label: "Leads", value: `${leadCount.toLocaleString()} enrolled`, icon: RiTeamLine },
    { label: "Sequence", value: `${sequence.length} step${sequence.length === 1 ? "" : "s"}`, icon: RiStackLine },
  ];

  return (
    <div className="mx-auto max-w-3xl">
      <h2 className="text-title-h5 text-text-strong-950">Review and launch</h2>
      <p className="mt-1 text-paragraph-sm text-text-sub-600">Confirm the audience, sequence and sending readiness before the campaign goes live.</p>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        {cards.map(({ label, value, icon: Icon }) => (
          <div key={label} className="rounded-2xl bg-bg-white-0 p-4 shadow-regular-xs ring-1 ring-inset ring-stroke-soft-200">
            <div className="flex items-center gap-2 text-paragraph-xs text-text-soft-400"><Icon className="size-4" />{label}</div>
            <p className="mt-2 truncate text-label-md text-text-strong-950">{value}</p>
            {label === "Sequence" && lastWait !== null ? <p className="mt-1 text-paragraph-xs text-text-soft-400">Final follow-up waits {lastWait} day{lastWait === 1 ? "" : "s"}</p> : null}
          </div>
        ))}
      </div>

      <div className={`mt-4 flex flex-wrap items-center gap-3 rounded-xl px-4 py-3 text-paragraph-sm ${
        connectedMailboxes === null
          ? "bg-bg-weak-50 text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200"
          : connectedMailboxes > 0
            ? "bg-success-lighter text-success-dark"
            : "bg-warning-lighter text-warning-dark"
      }`}>
        <RiMailCheckLine className="size-5 shrink-0" />
        {connectedMailboxes === null
          ? "Checking mailboxes…"
          : connectedMailboxes > 0
            ? `${connectedMailboxes} mailbox${connectedMailboxes === 1 ? "" : "es"} connected and ready to send — round-robin assignment`
            : (
              <>
                <span className="min-w-0 flex-1">No connected mailboxes — connect one before launching</span>
                <span className="flex flex-wrap items-center gap-3 text-paragraph-xs">
                  <Link href="/settings/email-accounts" className="font-medium underline underline-offset-2">
                    Add a mailbox
                  </Link>
                  <DocsLink page="email/connect#add-a-mailbox" appearance="inline" className="text-current underline" />
                </span>
              </>
            )}
      </div>

      {leadCount === 0 && <p className="mt-3 text-paragraph-xs text-away-base">No leads are enrolled yet. Save as draft, or go back and add recipients before launching.</p>}

      {error && <p className="mt-3 rounded-xl bg-error-lighter px-4 py-3 text-paragraph-sm text-error-base">{error}</p>}

      <div className="mt-8 flex flex-col-reverse gap-3 border-t border-stroke-soft-200 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <Button.Root variant="neutral" mode="ghost" size="medium" onClick={onBack}>
          <Button.Icon as={RiArrowLeftLine} />Back
        </Button.Root>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button.Root
            variant="neutral"
            mode="stroke"
            size="medium"
            onClick={() => void finish("draft")}
            disabled={submitting !== null}
          >
            <Button.Icon as={RiDraftLine} />
            {submitting === "draft" ? "Saving…" : "Save as draft"}
          </Button.Root>
          <Button.Root
            onClick={() => void finish("active")}
            disabled={submitting !== null || !canLaunch}
            title={!canLaunch ? "Needs a connected mailbox, a complete sequence, and at least one lead" : undefined}
          >
            <Button.Icon as={RiPlayCircleLine} />
            {submitting === "launch" ? "Launching…" : "Launch campaign"}
          </Button.Root>
        </div>
      </div>
    </div>
  );
}
