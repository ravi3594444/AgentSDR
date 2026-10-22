"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { ConnectAccountButton, ConnectionOutcome } from "@/components/linkedin/HostedAuth";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RiChat1Line,
  RiDownloadLine,
  RiErrorWarningLine,
  RiFireLine,
  RiLoader4Line,
  RiMoreLine,
  RiPhoneLine,
  RiRefreshLine,
  RiStarFill,
  RiStarLine,
} from "@remixicon/react";
import { WhatsappLogo } from "./WhatsappLogo";
import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Dropdown from "@/components/alignui/dropdown";
import * as Table from "@/components/alignui/table";
import { Frame, FramePanel } from "@/components/analytics/kit/Frame";
import { KpiCell, KpiStrip } from "@/components/analytics/kit/KpiStrip";
import { EmptyState } from "@/components/page/EmptyState";
import { errorMessage, formatDate } from "@/components/crm/crm-utils";
import {
  AccountIdentity,
  AccountsFrame,
  AccountsNoMatch,
  PresenceDot,
  type AccountFilter,
} from "@/components/settings/AccountsOverview";
import { Callout } from "@/components/settings/SettingsKit";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { AccountsSkeleton } from "@/components/settings/SettingsSkeletons";
import {
  backfillWhatsappAccount,
  listWhatsappAccounts,
  setDefaultWhatsappAccount,
  syncWhatsappAccounts,
} from "@/lib/whatsapp/client";
import { type WhatsappAccountStatus, type WhatsappAccountSummary } from "@/lib/whatsapp/contract";
import { cn } from "@/utils/cn";
import { BRAND } from "@/lib/brand";

const STATUS_LABEL: Record<WhatsappAccountStatus, string> = {
  connected: "Connected",
  credentials: "Needs credentials",
  disconnected: "Disconnected",
  error: "Error",
};
const STATUS_COLOR: Record<WhatsappAccountStatus, React.ComponentProps<typeof Badge.Root>["color"]> = {
  connected: "green",
  credentials: "orange",
  disconnected: "red",
  error: "red",
};

function isFuture(iso: string | null): boolean {
  return Boolean(iso) && new Date(iso as string).getTime() > Date.now();
}

const healthy = (a: WhatsappAccountSummary) => a.status === "connected";

/** The organization's WhatsApp pacing rules the numbers follow, applied automatically. */
export type WhatsappNumberRules = { warmupHours: number; newChatsPerDay: number; secondsBetweenSends: number };

export function WhatsappAccountsClient({ rules }: { rules: WhatsappNumberRules }) {
  const [accounts, setAccounts] = useState<WhatsappAccountSummary[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AccountFilter>("all");
  const newChatsOf = (a: WhatsappAccountSummary) => a.newChatsPerDay ?? rules.newChatsPerDay;

  const load = useCallback(async () => {
    try {
      setAccounts((await listWhatsappAccounts()).accounts);
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sync = async () => {
    setSyncing(true);
    setNotice("");
    setError("");
    try {
      const response = await syncWhatsappAccounts();
      setAccounts(response.accounts);
      setNotice(response.accounts.length ? "Synced from Unipile." : "Synced — Unipile has no WhatsApp number linked yet.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSyncing(false);
    }
  };

  const makeDefault = async (account: WhatsappAccountSummary) => {
    setBusyId(account.id);
    setNotice("");
    try {
      await setDefaultWhatsappAccount(account.id);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  };

  const backfill = async (account: WhatsappAccountSummary) => {
    setBusyId(account.id);
    setNotice("");
    setError("");
    try {
      await backfillWhatsappAccount(account.id);
      setNotice(`Importing recent chats for ${account.name || account.phone || "this number"}. They appear in Messages shortly.`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (accounts ?? []).filter((a) => {
      if (filter === "healthy" && !healthy(a)) return false;
      if (filter === "attention" && healthy(a)) return false;
      return !q || `${a.name ?? ""} ${a.phone ?? ""}`.toLowerCase().includes(q);
    });
  }, [accounts, query, filter]);

  const total = accounts?.length ?? 0;
  const connected = accounts?.filter(healthy).length ?? 0;
  const attention = total - connected;
  const warmingCount = accounts?.filter((a) => isFuture(a.warmUpEndsAt)).length ?? 0;
  const defaultAccount = accounts?.find((a) => a.isDefault) ?? null;

  const syncAction = (
    <div className="flex flex-wrap items-start gap-2">
      <ConnectAccountButton channel="whatsapp" label="Connect WhatsApp number" />
      <Button.Root variant="neutral" mode="stroke" size="small" disabled={syncing} onClick={() => void sync()}>
        <Button.Icon as={RiRefreshLine} className={cn(syncing && "animate-spin")} />
        {syncing ? "Syncing…" : "Sync from Unipile"}
      </Button.Root>
    </div>
  );

  return (
    <SettingsPage
      title="WhatsApp accounts"
      description={`The numbers ${BRAND.shortName} messages from, linked in Unipile. Calls are placed from web.whatsapp.com by the recorder extension.`}
      actions={syncAction}
    >
      <div className="space-y-5">
        <ConnectionOutcome />
        {notice && <Callout tone="success">{notice}</Callout>}
        {error && (
          <Callout
            tone="error"
            action={
              !accounts && (
                <Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={() => void load()}>
                  Try again
                </Button.Root>
              )
            }
          >
            {error}
          </Callout>
        )}

        {accounts === null ? (
          !error && <AccountsSkeleton />
        ) : accounts.length === 0 ? (
          <Frame>
            <FramePanel>
              <EmptyState
                icon={WhatsappLogo}
                title="No WhatsApp numbers yet"
                description="Connect a number: Unipile shows a QR code to scan with the phone the rep calls from. A number already linked in your own Unipile dashboard appears after a sync."
                action={syncAction}
              />
            </FramePanel>
          </Frame>
        ) : (
          <div>
            <KpiStrip columns={4}>
              <KpiCell icon={RiPhoneLine} label="Connected" value={String(connected)} context={`of ${total} ${total === 1 ? "number" : "numbers"}`} />
              <KpiCell
                icon={RiErrorWarningLine}
                label="Needs attention"
                value={String(attention)}
                context={attention === 0 ? "Every number can message" : "Relink these in Unipile, then sync"}
                hint="Numbers that are disconnected, need credentials, or report an error. A banned number also loses its calling."
              />
              <KpiCell
                icon={RiFireLine}
                label="Warming up"
                value={String(warmingCount)}
                context={`No new chats for ${rules.warmupHours} h after linking`}
                hint="A newly linked number can reply to existing chats straight away, but starts new ones only after the warm-up, to protect it from bans."
              />
              <KpiCell
                icon={RiChat1Line}
                label="New chats per 24 hours"
                value={String((accounts ?? []).filter(healthy).reduce((sum, a) => sum + newChatsOf(a), 0))}
                context={`${rules.newChatsPerDay} per number · ${rules.secondsBetweenSends} s between sends`}
                hint="Each connected number starts at most this many new chats in any rolling 24 hours (no reset at midnight), shared by every campaign on it, and messages from one number are spaced apart. Replies in open chats are not limited. AgentSDR paces each number automatically to protect it; new people also count toward your daily lead limit."
              />
            </KpiStrip>

            <AccountsFrame
              title="Numbers"
              description={defaultAccount ? `${defaultAccount.name || defaultAccount.phone || "The default number"} is used when no other number is chosen.` : "No default number yet — make one the default from its menu."}
              filter={filter}
              onFilterChange={setFilter}
              counts={{ all: total, healthy: connected, attention }}
              search={query}
              onSearchChange={setQuery}
              searchPlaceholder="Search numbers…"
            >
              {filtered.length === 0 ? (
                <AccountsNoMatch noun="numbers" />
              ) : (
                <Table.Root className="min-w-180 [&>table]:table-fixed">
                  <Table.Header>
                    <Table.Row>
                      <Table.Head scope="col" className="px-4">Number</Table.Head>
                      <Table.Head scope="col" className="w-64 px-4">Status</Table.Head>
                      <Table.Head scope="col" className="w-36 px-4">New chats / 24 h</Table.Head>
                      <Table.Head scope="col" className="w-36 px-4">Last synced</Table.Head>
                      <Table.Head scope="col" className="w-16 px-4"><span className="sr-only">Actions</span></Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body spacing={4}>
                    {filtered.map((account) => {
                      const warming = isFuture(account.warmUpEndsAt);
                      const busy = busyId === account.id;
                      const label = account.name || account.phone || "this number";
                      return (
                        <Table.Row key={account.id} className={cn(busy && "opacity-60")} aria-busy={busy || undefined}>
                          <Table.Cell className="h-16 px-4">
                            <AccountIdentity
                              media={
                                <>
                                  <WhatsappLogo className="size-8" />
                                  <PresenceDot ok={healthy(account)} />
                                </>
                              }
                              name={
                                <>
                                  <span className="truncate text-label-sm text-text-strong-950">{account.name || account.phone || "WhatsApp number"}</span>
                                  {account.isDefault && (
                                    <Badge.Root size="small" variant="lighter" color="gray" className="shrink-0">
                                      <Badge.Icon as={RiStarFill} />
                                      Default
                                    </Badge.Root>
                                  )}
                                </>
                              }
                              detail={account.phone && account.name ? account.phone : undefined}
                            />
                          </Table.Cell>
                          <Table.Cell className="px-4">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge.Root size="medium" variant="lighter" color={STATUS_COLOR[account.status]}>
                                <Badge.Dot />
                                {STATUS_LABEL[account.status]}
                              </Badge.Root>
                              {warming && (
                                <span className="text-paragraph-xs text-text-sub-600" suppressHydrationWarning>
                                  Warming up until {formatDate(account.warmUpEndsAt)}
                                </span>
                              )}
                            </div>
                          </Table.Cell>
                          <Table.Cell className="px-4">
                            <p className="text-paragraph-sm tabular-nums text-text-strong-950">{newChatsOf(account)}</p>
                            {account.newChatsPerDay !== null && <p className="text-paragraph-xs text-text-soft-400">Own limit</p>}
                          </Table.Cell>
                          <Table.Cell className="whitespace-nowrap px-4 text-paragraph-sm text-text-sub-600" suppressHydrationWarning>
                            {account.lastSyncedAt ? formatDate(account.lastSyncedAt) : "Never"}
                          </Table.Cell>
                          <Table.Cell className="px-4">
                            <div className="flex justify-end">
                              <Dropdown.Root>
                                <Dropdown.Trigger asChild>
                                  <Button.Root variant="neutral" mode="ghost" size="xsmall" disabled={busy} aria-label={`More actions for ${label}`}>
                                    <Button.Icon as={busy ? RiLoader4Line : RiMoreLine} className={cn(busy && "animate-spin")} />
                                  </Button.Root>
                                </Dropdown.Trigger>
                                <Dropdown.Content align="end">
                                  {!account.isDefault && (
                                    <Dropdown.Item onSelect={() => void makeDefault(account)}>
                                      <Dropdown.ItemIcon as={RiStarLine} />
                                      Make default
                                    </Dropdown.Item>
                                  )}
                                  <Dropdown.Item disabled={account.status !== "connected"} onSelect={() => void backfill(account)}>
                                    <Dropdown.ItemIcon as={RiDownloadLine} />
                                    Import recent chats
                                  </Dropdown.Item>
                                </Dropdown.Content>
                              </Dropdown.Root>
                            </div>
                          </Table.Cell>
                        </Table.Row>
                      );
                    })}
                  </Table.Body>
                </Table.Root>
              )}
            </AccountsFrame>
          </div>
        )}
      </div>
    </SettingsPage>
  );
}
