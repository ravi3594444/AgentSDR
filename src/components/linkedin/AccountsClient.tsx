"use client";

import { useMemo, useState } from "react";
import {
  RiErrorWarningLine,
  RiLinkedinBoxFill,
  RiLoader4Line,
  RiMoreLine,
  RiRefreshLine,
  RiSendPlaneLine,
  RiUserFollowLine,
  RiUserStarLine,
} from "@remixicon/react";
import * as Avatar from "@/components/alignui/avatar";
import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Dropdown from "@/components/alignui/dropdown";
import * as Table from "@/components/alignui/table";
import { Frame, FramePanel } from "@/components/analytics/kit/Frame";
import { KpiCell, KpiStrip } from "@/components/analytics/kit/KpiStrip";
import { CHANNEL_META, HUE, formatPercent } from "@/components/analytics/theme";
import { DocsLink } from "@/components/page/DocsLink";
import { EmptyState } from "@/components/page/EmptyState";
import {
  AccountIdentity,
  AccountsFrame,
  AccountsNoMatch,
  PresenceDot,
  type AccountFilter,
} from "@/components/settings/AccountsOverview";
import { Callout, Meter } from "@/components/settings/SettingsKit";
import { ConnectAccountButton, useHostedAuthRedirect, ConnectionOutcome } from "@/components/linkedin/HostedAuth";
import { formatNextAllowedRun } from "@/lib/linkedin/nextAllowedRun";

export type AccountRow = {
  id: string;
  username: string;
  name: string | null;
  profilePictureUrl: string | null;
  status: string;
  limitReached: boolean;
  isPremium: boolean;
  /** This account's own invitations a day (set before limits became automatic); null follows the organization's rule. */
  dailyInviteLimit: number | null;
  nextAllowedRun: string | null;
};

const LINKEDIN = CHANNEL_META.linkedin.color;

function LinkedInPremiumIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 shrink-0" fill="none" role="img" aria-label="LinkedIn Premium">
      <rect x="1" y="1" width="14" height="14" rx="3" fill={HUE.amber} />
      <text x="8" y="11.5" textAnchor="middle" fontSize="9" fontWeight="bold" fontFamily="Arial,sans-serif" fill="white">
        in
      </text>
    </svg>
  );
}

function initialsFor(name: string) {
  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  return initials || "?";
}

/** The organization's invitations a day (the LinkedIn sending rules, applied automatically). */
export type InviteLimits = { premium: number; free: number };

function organizationLimit(account: AccountRow, limits: InviteLimits) {
  return account.isPremium ? limits.premium : limits.free;
}

/** The same limit sendInvitations enforces: the account's own, else the organization's for its plan. */
function dailyLimit(account: AccountRow, limits: InviteLimits) {
  return account.dailyInviteLimit ?? organizationLimit(account, limits);
}

const connected = (a: AccountRow) => a.status === "CONNECTED";
const healthy = (a: AccountRow) => connected(a) && !a.limitReached;

function StatusBadge({ account }: { account: AccountRow }) {
  if (healthy(account))
    return (
      <Badge.Root size="medium" variant="lighter" color="green">
        <Badge.Dot />
        Connected
      </Badge.Root>
    );
  if (connected(account))
    return (
      <Badge.Root size="medium" variant="lighter" color="orange">
        <Badge.Dot />
        Limit reached
      </Badge.Root>
    );
  return (
    <Badge.Root size="medium" variant="lighter" color="red">
      <Badge.Dot />
      Disconnected
    </Badge.Root>
  );
}

/**
 * One account. "Reconnect" mints a Unipile hosted-auth link scoped to this
 * account and navigates to it — the same wizard as connecting a new account,
 * except LinkedIn re-authenticates the existing Unipile account in place, so
 * the account id, its campaigns and its history all survive. A disconnected
 * account offers it under its status, not only in the row menu.
 */
function AccountTableRow({
  account,
  sentToday,
  pending,
  limits,
}: {
  account: AccountRow;
  sentToday: number;
  pending: number;
  limits: InviteLimits;
}) {
  const { redirecting, error, start } = useHostedAuthRedirect();
  const displayName = account.name || account.username;

  return (
    <Table.Row aria-busy={redirecting || undefined}>
      <Table.Cell className="h-16 px-4">
        <AccountIdentity
          media={
            <>
              <Avatar.Root size="32" color="blue">
                {account.profilePictureUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={account.profilePictureUrl} alt="" className="size-full rounded-full object-cover" />
                ) : (
                  initialsFor(displayName)
                )}
              </Avatar.Root>
              <PresenceDot ok={connected(account)} />
            </>
          }
          name={
            <>
              <span className="truncate text-label-sm text-text-strong-950" title={displayName}>{displayName}</span>
              {account.isPremium && <LinkedInPremiumIcon />}
            </>
          }
          detail={`@${account.username}`}
        />
      </Table.Cell>

      <Table.Cell className="px-4">
        <div className="flex flex-col items-start gap-1">
          <StatusBadge account={account} />
          {!connected(account) && (
            <button
              type="button"
              disabled={redirecting}
              onClick={() => start(account.id)}
              className="inline-flex items-center gap-1 rounded text-label-xs text-text-strong-950 underline decoration-stroke-sub-300 underline-offset-2 outline-none transition hover:decoration-text-strong-950 focus-visible:ring-2 focus-visible:ring-primary-base disabled:text-text-disabled-300"
            >
              {redirecting ? <RiLoader4Line className="size-3.5 animate-spin" aria-hidden="true" /> : <RiRefreshLine className="size-3.5" aria-hidden="true" />}
              {redirecting ? "Opening Unipile…" : "Reconnect"}
            </button>
          )}
          {error && (
            <span role="alert" className="max-w-32 truncate text-paragraph-xs text-error-base" title={error}>
              Reconnect failed
            </span>
          )}
        </div>
      </Table.Cell>

      <Table.Cell className="px-4">
        <Meter value={sentToday} max={dailyLimit(account, limits)} color={LINKEDIN} label={`Connection requests sent today by ${displayName}`} />
        {account.dailyInviteLimit !== null && <p className="mt-0.5 text-paragraph-xs text-text-soft-400">Own limit</p>}
      </Table.Cell>

      <Table.Cell className="px-4 text-right text-paragraph-sm tabular-nums text-text-strong-950">
        {pending.toLocaleString("en-US")}
      </Table.Cell>

      <Table.Cell className="px-4">
        <p className="truncate text-paragraph-sm text-text-strong-950" suppressHydrationWarning>
          {formatNextAllowedRun(account.nextAllowedRun ? new Date(account.nextAllowedRun) : null)}
        </p>
      </Table.Cell>

      <Table.Cell className="px-4">
        <div className="flex justify-end">
          <Dropdown.Root>
            <Dropdown.Trigger asChild>
              <Button.Root variant="neutral" mode="ghost" size="xsmall" disabled={redirecting} aria-label={`More actions for ${displayName}`}>
                <Button.Icon as={RiMoreLine} />
              </Button.Root>
            </Dropdown.Trigger>
            <Dropdown.Content align="end">
              <Dropdown.Item onSelect={() => start(account.id)}>
                <Dropdown.ItemIcon as={RiRefreshLine} />
                Reconnect account
              </Dropdown.Item>
            </Dropdown.Content>
          </Dropdown.Root>
        </div>
      </Table.Cell>
    </Table.Row>
  );
}

function AccountsTable({
  accounts,
  sentTodayMap,
  pendingLeadsMap,
  limits,
}: {
  accounts: AccountRow[];
  sentTodayMap: Record<string, number>;
  pendingLeadsMap: Record<string, number>;
  limits: InviteLimits;
}) {
  return (
    <Table.Root className="min-w-190 [&>table]:table-fixed">
      <Table.Header>
        <Table.Row>
          <Table.Head scope="col" className="px-4">Account</Table.Head>
          <Table.Head scope="col" className="w-32 px-4">Status</Table.Head>
          <Table.Head scope="col" className="w-36 px-4">Requests today</Table.Head>
          <Table.Head scope="col" className="w-20 px-4 text-right" title="Leads waiting for a connection request from this account">Pending</Table.Head>
          <Table.Head scope="col" className="w-48 px-4" title="Accounts work at any time; after each run an account rests before the next">Next run</Table.Head>
          <Table.Head scope="col" className="w-14 px-4"><span className="sr-only">Actions</span></Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body spacing={4}>
        {accounts.map((account) => (
          <AccountTableRow
            key={account.id}
            account={account}
            sentToday={sentTodayMap[account.id] ?? 0}
            pending={pendingLeadsMap[account.id] ?? 0}
            limits={limits}
          />
        ))}
      </Table.Body>
    </Table.Root>
  );
}

export function AccountsClient({
  accounts,
  sentTodayMap,
  pendingLeadsMap,
  inviteLimits,
}: {
  accounts: AccountRow[];
  sentTodayMap: Record<string, number>;
  pendingLeadsMap: Record<string, number>;
  inviteLimits: InviteLimits;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<AccountFilter>("all");

  const connectedCount = accounts.filter(connected).length;
  const disconnected = accounts.length - connectedCount;
  const limited = accounts.filter((a) => connected(a) && a.limitReached).length;
  const healthyCount = accounts.filter(healthy).length;
  const totalSent = accounts.reduce((sum, a) => sum + (sentTodayMap[a.id] ?? 0), 0);
  const totalCapacity = accounts.filter(connected).reduce((sum, a) => sum + dailyLimit(a, inviteLimits), 0);
  const premium = accounts.filter((a) => a.isPremium).length;

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return accounts.filter((a) => {
      if (filter === "healthy" && !healthy(a)) return false;
      if (filter === "attention" && healthy(a)) return false;
      if (!term) return true;
      return (a.name ?? "").toLowerCase().includes(term) || a.username.toLowerCase().includes(term);
    });
  }, [accounts, search, filter]);

  if (accounts.length === 0) {
    return (
      <Frame>
        <FramePanel>
          <EmptyState
            icon={RiLinkedinBoxFill}
            title="No LinkedIn accounts yet"
            description="Connect one through Unipile — it syncs back here as soon as you finish."
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <ConnectAccountButton />
                <DocsLink page="linkedin/accounts#add-a-linkedin-account" />
              </div>
            }
          />
        </FramePanel>
      </Frame>
    );
  }

  return (
    <div>
      <KpiStrip columns={4}>
        <KpiCell icon={RiUserFollowLine} label="Connected" value={String(connectedCount)} context={`of ${accounts.length} accounts`} />
        <KpiCell
          icon={RiErrorWarningLine}
          label="Needs attention"
          value={String(accounts.length - healthyCount)}
          context={
            disconnected + limited === 0
              ? "Every account can send"
              : [disconnected > 0 && `${disconnected} disconnected`, limited > 0 && `${limited} at LinkedIn's limit`].filter(Boolean).join(" · ")
          }
          hint="Disconnected accounts need reconnecting through Unipile. Accounts at LinkedIn's limit resume on their own."
        />
        <KpiCell
          icon={RiSendPlaneLine}
          label="Requests today"
          value={totalSent.toLocaleString("en-US")}
          context={totalCapacity > 0 ? `${formatPercent(Math.min(totalSent / totalCapacity, 1))} of ${totalCapacity} a day` : "No connected capacity"}
          hint="Connection requests sent today, against the daily limits of connected accounts. New people also count toward your daily lead limit."
        />
        <KpiCell icon={RiUserStarLine} label="Premium" value={String(premium)} context={`${accounts.length - premium} on a free plan`} hint={`Premium accounts send up to ${inviteLimits.premium} connection requests a day, free accounts ${inviteLimits.free}. AgentSDR paces each account automatically to keep it safe.`} />
      </KpiStrip>

      <div className="mt-5 empty:hidden"><ConnectionOutcome /></div>
      {disconnected > 0 && (
        <Callout tone="warning" className="mt-5" title={`${disconnected} ${disconnected === 1 ? "account is" : "accounts are"} disconnected`}>
          Campaigns skip them until they are reconnected. Reconnect re-authenticates the same account in place, so its campaigns and history stay.
        </Callout>
      )}

      <AccountsFrame
        title="Accounts"
        description="Requests sent today, leads waiting, and when each account next works. Accounts work at any time of day."
        filter={filter}
        onFilterChange={setFilter}
        counts={{ all: accounts.length, healthy: healthyCount, attention: accounts.length - healthyCount }}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search accounts…"
      >
        {filtered.length === 0 ? (
          <AccountsNoMatch noun="accounts" />
        ) : (
          <AccountsTable accounts={filtered} sentTodayMap={sentTodayMap} pendingLeadsMap={pendingLeadsMap} limits={inviteLimits} />
        )}
      </AccountsFrame>
    </div>
  );
}
