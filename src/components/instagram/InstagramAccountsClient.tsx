"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  RiAddLine,
  RiDownloadLine,
  RiErrorWarningLine,
  RiHistoryLine,
  RiInboxLine,
  RiLoader4Line,
  RiMoreLine,
  RiRefreshLine,
  RiUserReceivedLine,
} from "@remixicon/react";
import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Checkbox from "@/components/alignui/checkbox";
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
import { InstagramLogo } from "./InstagramLogo";
import {
  importInstagramHistory,
  linkInstagramAccount,
  listInstagramAccounts,
  setInstagramInquiryIntake,
  syncInstagramAccounts,
} from "@/lib/instagram/client";
import type { InstagramAccountStatus, InstagramAccountSummary } from "@/lib/instagram/contract";
import { cn } from "@/utils/cn";

const STATUS_LABEL: Record<InstagramAccountStatus, string> = {
  connected: "Connected",
  credentials: "Needs to sign in again",
  disconnected: "Disconnected",
  error: "Error",
};
const STATUS_COLOR: Record<InstagramAccountStatus, React.ComponentProps<typeof Badge.Root>["color"]> = {
  connected: "green",
  credentials: "orange",
  disconnected: "red",
  error: "red",
};

const healthy = (account: InstagramAccountSummary) => account.status === "connected";

function accountLabel(account: InstagramAccountSummary): string {
  return account.name || (account.username ? `@${account.username}` : "Instagram account");
}

/**
 * Settings → Instagram → Accounts: the Instagram accounts linked through
 * Unipile, who linked each, connecting a new one (Unipile's hosted sign-in),
 * syncing, importing history, and whether new messages from people
 * AgentSDR does not know become inquiries. `inquiryIntakeOn` is the
 * organization's Inquiry intake feature: without it that switch stays off.
 */
export function InstagramAccountsClient({ inquiryIntakeOn }: { inquiryIntakeOn: boolean }) {
  const [accounts, setAccounts] = useState<InstagramAccountSummary[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [linking, setLinking] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AccountFilter>("all");
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const returned = searchParams.get("unipile");
  const handledReturn = useRef(false);

  const load = useCallback(async () => {
    try {
      const response = await listInstagramAccounts();
      setAccounts(response.accounts);
      setCanManage(response.canManage);
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  const sync = useCallback(async (message?: string) => {
    setSyncing(true);
    setNotice("");
    setError("");
    try {
      const response = await syncInstagramAccounts();
      setAccounts(response.accounts);
      setNotice(message ?? (response.accounts.length ? "Synced from Unipile." : "Synced — Unipile has no Instagram account linked yet."));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    // Loads once on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    // Back from Unipile's sign-in (only owners and admins start one): sync
    // once — Unipile cannot always reach this instance's account webhook,
    // e.g. on a developer machine — then drop the marker so a reload does
    // not repeat it.
    if (!returned || handledReturn.current) return;
    handledReturn.current = true;
    void (async () => {
      if (returned === "success") await sync("Instagram account linked. It is synced and listed below.");
      else setError("The Instagram sign-in did not finish. Try connecting again.");
      router.replace(pathname, { scroll: false });
    })();
  }, [returned, sync, router, pathname]);

  const connect = async () => {
    setLinking(true);
    setError("");
    setNotice("");
    try {
      const { url } = await linkInstagramAccount();
      // Unipile's sign-in runs on its own domain and must not be framed.
      window.location.assign(url);
    } catch (cause) {
      setError(errorMessage(cause));
      setLinking(false);
    }
  };

  const importHistory = async (account: InstagramAccountSummary) => {
    setBusyId(account.id);
    setNotice("");
    setError("");
    try {
      const result = await importInstagramHistory(account.id);
      setNotice(
        result.importedMessages || result.importedChats
          ? `Imported ${result.importedMessages.toLocaleString("en-US")} ${result.importedMessages === 1 ? "message" : "messages"} in ${result.importedChats.toLocaleString("en-US")} ${result.importedChats === 1 ? "chat" : "chats"} from ${accountLabel(account)} as history${result.skippedGroups ? ` (${result.skippedGroups} group ${result.skippedGroups === 1 ? "chat" : "chats"} skipped)` : ""}. They show in Instagram → Messages and are never answered.`
          : `Nothing new to import for ${accountLabel(account)}.`,
      );
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  };

  const toggleInquiries = async (account: InstagramAccountSummary, enabled: boolean) => {
    setBusyId(account.id);
    setNotice("");
    setError("");
    try {
      const updated = await setInstagramInquiryIntake(account.id, enabled);
      setAccounts((current) => current?.map((item) => (item.id === updated.id ? updated : item)) ?? current);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (accounts ?? []).filter((account) => {
      if (filter === "healthy" && !healthy(account)) return false;
      if (filter === "attention" && healthy(account)) return false;
      return !q || `${account.name ?? ""} ${account.username ?? ""}`.toLowerCase().includes(q);
    });
  }, [accounts, query, filter]);

  const total = accounts?.length ?? 0;
  const connected = accounts?.filter(healthy).length ?? 0;
  const attention = total - connected;
  const takingInquiries = accounts?.filter((account) => account.inquiryIntake).length ?? 0;

  const connectAction = (
    <Button.Root variant="primary" mode="filled" size="small" disabled={linking} onClick={() => void connect()}>
      <Button.Icon as={linking ? RiLoader4Line : RiAddLine} className={cn(linking && "animate-spin")} />
      {linking ? "Opening Unipile…" : "Connect Instagram"}
    </Button.Root>
  );
  const syncAction = (
    <Button.Root variant="neutral" mode="stroke" size="small" disabled={syncing} onClick={() => void sync()}>
      <Button.Icon as={RiRefreshLine} className={cn(syncing && "animate-spin")} />
      {syncing ? "Syncing…" : "Sync from Unipile"}
    </Button.Root>
  );

  return (
    <SettingsPage
      title="Instagram accounts"
      description={`Link Instagram accounts through Unipile to send an initial DM from an approved Assistant plan and handle replies. Replies follow the run’s Automatic or Review mode.`}
      actions={canManage ? <>{syncAction}{connectAction}</> : undefined}
    >
      <div className="space-y-5">
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
                icon={InstagramLogo}
                title="No Instagram accounts yet"
                description={
                  canManage
                    ? "Connect an account through Unipile's Instagram sign-in — your password stays with Unipile. An account already linked in the Unipile dashboard appears after a sync."
                    : "An owner or admin of this organization can connect an Instagram account."
                }
                action={canManage ? <div className="flex flex-wrap items-center justify-center gap-2">{connectAction}{syncAction}</div> : undefined}
              />
            </FramePanel>
          </Frame>
        ) : (
          <div>
            <KpiStrip columns={3}>
              <KpiCell icon={InstagramLogo} label="Connected" value={String(connected)} context={`of ${total} ${total === 1 ? "account" : "accounts"}`} />
              <KpiCell
                icon={RiErrorWarningLine}
                label="Needs attention"
                value={String(attention)}
                context={attention === 0 ? "Every account can reply" : "Reconnect these in Unipile, then sync"}
                hint="Accounts that are disconnected, need their owner to sign in again, or report an error. They can neither receive nor send."
              />
              <KpiCell
                icon={RiUserReceivedLine}
                label="Taking inquiries"
                value={String(takingInquiries)}
                context={inquiryIntakeOn ? "New people become inquiries" : "Inquiry intake is off"}
                hint="On these accounts, the first message of a new chat from someone not yet in your leads becomes an inquiry. Needs Inquiry intake on in Settings → Providers & features."
              />
            </KpiStrip>

            <Callout tone="info" title="History is shown, never answered" className="mt-5">
              “Import history” brings an account&rsquo;s recent chats in so you can read them in Instagram → Messages. Imported
              messages, and any message sent before the account was linked, are marked History: they are never counted unread,
              never reach the Inbox and never get a reply. Only new messages are drafted for.
            </Callout>

            <p className="mt-3 text-paragraph-xs text-text-sub-600">
              Start an Instagram outreach plan in the <Link href="/assistant" className="underline">Assistant</Link>.
              Each approved recipient gets one initial DM, at any time of day; each account is paced automatically, and new people count toward your <Link href="/settings/sending" className="underline">daily lead limit</Link>.
              The inquiry checkbox below applies to new people who write first; outbound replies follow their run.
            </p>

            <AccountsFrame
              title="Accounts"
              description="Each account's direct messages reach the CRM for people you already have; replies go out from the account the person wrote to."
              filter={filter}
              onFilterChange={setFilter}
              counts={{ all: total, healthy: connected, attention }}
              search={query}
              onSearchChange={setQuery}
              searchPlaceholder="Search accounts…"
            >
              {filtered.length === 0 ? (
                <AccountsNoMatch noun="accounts" />
              ) : (
                <Table.Root className="min-w-200 [&>table]:table-fixed">
                  <Table.Header>
                    <Table.Row>
                      <Table.Head scope="col" className="px-4">Account</Table.Head>
                      <Table.Head scope="col" className="w-48 px-4">Status</Table.Head>
                      <Table.Head scope="col" className="w-64 px-4">Treat new messages from unknown people as inquiries</Table.Head>
                      <Table.Head scope="col" className="w-36 px-4">Last synced</Table.Head>
                      <Table.Head scope="col" className="w-16 px-4"><span className="sr-only">Actions</span></Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body spacing={4}>
                    {filtered.map((account) => {
                      const busy = busyId === account.id;
                      const label = accountLabel(account);
                      const switchId = `instagram-inquiries-${account.id}`;
                      // Turning it off is always allowed; on needs the organization's Inquiry intake.
                      const canToggle = canManage && !busy && (account.inquiryIntake || inquiryIntakeOn);
                      return (
                        <Table.Row key={account.id} className={cn(busy && "opacity-60")} aria-busy={busy || undefined}>
                          <Table.Cell className="h-16 px-4">
                            <AccountIdentity
                              media={
                                <>
                                  <span className="flex size-8 items-center justify-center rounded-full bg-bg-weak-50 ring-1 ring-inset ring-stroke-soft-200">
                                    <InstagramLogo className="size-[18px]" />
                                  </span>
                                  <PresenceDot ok={healthy(account)} />
                                </>
                              }
                              name={<span className="truncate text-label-sm text-text-strong-950">{label}</span>}
                              detail={[
                                account.username && account.name ? `@${account.username}` : null,
                                account.connectedBy ? `Linked by ${account.connectedBy.name ?? "a former member"}` : "Linked in Unipile",
                              ].filter(Boolean).join(" · ")}
                              extra={
                                account.lastImportedAt ? (
                                  <p className="truncate text-paragraph-xs text-text-soft-400" suppressHydrationWarning>
                                    History imported {formatDate(account.lastImportedAt)}
                                  </p>
                                ) : undefined
                              }
                            />
                          </Table.Cell>
                          <Table.Cell className="px-4">
                            <Badge.Root size="medium" variant="lighter" color={STATUS_COLOR[account.status]}>
                              <Badge.Dot />
                              {STATUS_LABEL[account.status]}
                            </Badge.Root>
                          </Table.Cell>
                          <Table.Cell className="px-4">
                            <div className="flex items-start gap-2">
                              <Checkbox.Root
                                id={switchId}
                                checked={account.inquiryIntake}
                                disabled={!canToggle}
                                onCheckedChange={(checked) => void toggleInquiries(account, checked === true)}
                                className="mt-0.5"
                              />
                              <label htmlFor={switchId} className={cn("min-w-0 text-paragraph-xs", canToggle ? "text-text-strong-950" : "text-text-soft-400")}>
                                {account.inquiryIntake ? "On" : "Off"}
                                <span className="block text-text-soft-400">
                                  {!inquiryIntakeOn && !account.inquiryIntake ? (
                                    <>
                                      Needs Inquiry intake, in{" "}
                                      <Link href="/settings/advanced" className="underline underline-offset-2 hover:text-text-strong-950">
                                        Settings → Providers & features
                                      </Link>
                                    </>
                                  ) : !canManage ? (
                                    "Only owners and admins can change this"
                                  ) : (
                                    "First message of a new chat"
                                  )}
                                </span>
                              </label>
                            </div>
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
                                <Dropdown.Content align="end" className="w-64">
                                  <Dropdown.Item disabled={!canManage || account.status !== "connected"} onSelect={() => void importHistory(account)}>
                                    <Dropdown.ItemIcon as={RiDownloadLine} />
                                    <span className="flex-1">
                                      Import history
                                      <span className="block text-paragraph-xs text-text-soft-400">Recent chats, shown as history — never answered</span>
                                    </span>
                                  </Dropdown.Item>
                                  <Dropdown.Item asChild>
                                    <Link href="/instagram/messages">
                                      <Dropdown.ItemIcon as={RiInboxLine} />
                                      Open messages
                                    </Link>
                                  </Dropdown.Item>
                                  {account.historyCutoffAt && (
                                    <p className="flex items-center gap-1.5 px-2 pb-1.5 pt-1 text-paragraph-xs text-text-soft-400" suppressHydrationWarning>
                                      <RiHistoryLine className="size-3.5 shrink-0" aria-hidden="true" />
                                      History before {formatDate(account.historyCutoffAt)}
                                    </p>
                                  )}
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
