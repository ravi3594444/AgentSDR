"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RiRefreshLine } from "@remixicon/react";

import * as Button from "@/components/alignui/button";
import { useDialogs } from "@/components/DialogProvider";
import { cn } from "@/utils/cn";

type SyncResponse = {
  ok: boolean;
  error?: string;
  synced?: { emailAddress: string; status: string; added: boolean }[];
  skipped?: { account: string; reason: string }[];
  unlinked?: string[];
  webhooks?: { status: string; message?: string } | null;
};

/**
 * Makes the email inboxes linked in Unipile sending mailboxes (no Google
 * Workspace or domain needed) and shows what happened.
 */
export default function SyncUnipileMailboxesButton({ mode = "stroke" }: { mode?: "filled" | "stroke" }) {
  const dialogs = useDialogs();
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);

  async function sync() {
    setSyncing(true);
    try {
      const response = await fetch("/api/outreach/mailboxes/sync-unipile", { method: "POST" });
      const data = (await response.json().catch(() => ({ ok: false }))) as SyncResponse;
      if (!response.ok || !data.ok) {
        await dialogs.alert({ title: "Could not sync from Unipile", description: data.error ?? `HTTP ${response.status}`, variant: "error" });
        return;
      }
      router.refresh();
      const synced = data.synced ?? [];
      const added = synced.filter((m) => m.added).length;
      const lines = [
        synced.length
          ? `${synced.length} ${synced.length === 1 ? "inbox" : "inboxes"} from Unipile${added ? `, ${added} new` : ""}: ${synced.map((m) => `${m.emailAddress} (${m.status})`).join(", ")}.`
          : "Unipile has no email inbox linked yet. Link a Gmail, Outlook or IMAP account in the Unipile dashboard, then sync again.",
        ...(data.skipped ?? []).map((s) => `Skipped ${s.account}: ${s.reason}.`),
        ...(data.unlinked?.length ? [`No longer linked in Unipile: ${data.unlinked.join(", ")}.`] : []),
        ...(data.webhooks && data.webhooks.status !== "registered"
          ? [`Replies arrive through Unipile's email webhook, which is not registered yet: ${data.webhooks.message ?? data.webhooks.status}.`]
          : []),
      ];
      await dialogs.alert({
        title: "Synced from Unipile",
        description: (
          <span className="flex flex-col gap-2">
            {lines.map((line) => <span key={line}>{line}</span>)}
          </span>
        ),
      });
    } catch {
      await dialogs.alert({ title: "Could not sync from Unipile", description: "Network error.", variant: "error" });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <Button.Root variant={mode === "filled" ? "primary" : "neutral"} mode={mode} size="small" disabled={syncing} onClick={() => void sync()}>
      <Button.Icon as={RiRefreshLine} className={cn(syncing && "animate-spin")} />
      {syncing ? "Syncing…" : "Sync from Unipile"}
    </Button.Root>
  );
}
