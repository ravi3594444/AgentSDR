"use client";

import { useMemo, useState } from "react";
import {
  RiErrorWarningLine,
  RiLinkedinBoxFill,
  RiLoader4Line,
  RiMoreLine,
  RiRefreshLine,
  RiSendPlaneLine,
  RiTimeLine,
  RiDashboard3Line,
  RiUserFollowLine,
  RiUserStarLine,
} from "@remixicon/react";
import * as Avatar from "@/components/alignui/avatar";
import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Checkbox from "@/components/alignui/checkbox";
import * as Dropdown from "@/components/alignui/dropdown";
import * as Modal from "@/components/alignui/modal";
import * as Select from "@/components/alignui/select";
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
import { Callout, Field, Meter } from "@/components/settings/SettingsKit";
import { AccountLimitDialog } from "@/components/settings/AccountLimitDialog";
import { numberRule } from "@/lib/channels/rules";
import { timeInputClass } from "@/components/outreach/WorkingHoursModal";
import { ConnectAccountButton, useHostedAuthRedirect } from "@/components/linkedin/HostedAuth";
import {
  DEFAULT_WORK_END,
  DEFAULT_WORK_START,
  DEFAULT_WORK_TIMEZONE,
  hasWorkingHoursConfigured,
  parseWorkDays,
  WEEKDAY_LABELS,
} from "@/lib/linkedin/workingHours";
import { formatNextAllowedRun } from "@/lib/linkedin/nextAllowedRun";
import { cn } from "@/utils/cn";

export type AccountRow = {
  id: string;
  username: string;
  name: string | null;
  profilePictureUrl: string | null;
  status: string;
  limitReached: boolean;
  isPremium: boolean;
  /** This account's own invitations a day; null follows the organization's rule. */
  dailyInviteLimit: number | null;
  workTimezone: string | null;
  workStartTime: string | null;
  workEndTime: string | null;
  workDays: string | null;
  nextAllowedRun: string | null;
};

const LINKEDIN = CHANNEL_META.linkedin.color;

const TIMEZONES = [
  "Asia/Kolkata",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
];

/** Monday first, the way people read a week; values stay 0 = Sunday … 6 = Saturday. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

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

/** The organization's invitations a day (Settings → LinkedIn → Sending rules). */
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

/** "Mon–Sat, 09:00–18:00" for a configured window, "Any time" otherwise. */
function hoursSummary(account: AccountRow): { main: string; tz: string | null } {
  if (!hasWorkingHoursConfigured(account)) return { main: "Any time", tz: null };
  const days = parseWorkDays(account.workDays);
  const key = [...days].sort((a, b) => a - b).join(",");
  const dayLabel =
    days.length === 7
      ? "Every day"
      : key === "1,2,3,4,5"
        ? "Mon–Fri"
        : key === "1,2,3,4,5,6"
          ? "Mon–Sat"
          : WEEK_ORDER.filter((d) => days.includes(d)).map((d) => WEEKDAY_LABELS[d]).join(", ");
  return { main: `${dayLabel}, ${account.workStartTime}–${account.workEndTime}`, tz: account.workTimezone };
}

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

function WorkingHoursDialog({
  account,
  onClose,
  onSaved,
}: {
  account: AccountRow;
  onClose: () => void;
  onSaved: (updated: AccountRow) => void;
}) {
  const [enabled, setEnabled] = useState(hasWorkingHoursConfigured(account));
  const [timezone, setTimezone] = useState(account.workTimezone ?? DEFAULT_WORK_TIMEZONE);
  const [startTime, setStartTime] = useState(account.workStartTime ?? DEFAULT_WORK_START);
  const [endTime, setEndTime] = useState(account.workEndTime ?? DEFAULT_WORK_END);
  const [days, setDays] = useState<number[]>(() => parseWorkDays(account.workDays));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timezones = TIMEZONES.includes(timezone) ? TIMEZONES : [timezone, ...TIMEZONES];
  const noDays = enabled && days.length === 0;
  const inverted = enabled && startTime >= endTime;

  const toggleDay = (day: number) => {
    setDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b)));
  };

  const handleSave = async () => {
    if (noDays) {
      setError("Select at least one working day");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/linkedin/accounts/${account.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          enabled
            ? {
                workHoursEnabled: true,
                workTimezone: timezone,
                workStartTime: startTime,
                workEndTime: endTime,
                workDays: days.join(","),
              }
            : { workHoursEnabled: false },
        ),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error ?? "Save failed");
        return;
      }
      const a = data.account;
      onSaved({
        ...account,
        workTimezone: a.workTimezone,
        workStartTime: a.workStartTime,
        workEndTime: a.workEndTime,
        workDays: a.workDays,
      });
      onClose();
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal.Root open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content size="max-w-lg">
        <Modal.Header icon={RiTimeLine}>
          <Modal.Title>Working hours</Modal.Title>
          <Modal.Description>
            For {account.name || `@${account.username}`}. Profile enrichment, connection requests and follow-ups only run inside this window.
          </Modal.Description>
        </Modal.Header>
        <Modal.Body className="space-y-5">
          <label className="flex cursor-pointer items-start gap-3 rounded-xl p-3 ring-1 ring-inset ring-stroke-soft-200">
            <Checkbox.Root className="mt-0.5" checked={enabled} onCheckedChange={(c) => setEnabled(c === true)} />
            <span>
              <span className="block text-label-sm text-text-strong-950">Restrict outreach to working hours</span>
              <span className="mt-0.5 block text-paragraph-xs text-text-sub-600">Off: this account works whenever its campaigns are due.</span>
            </span>
          </label>

          {enabled && (
            <>
              <Field label="Timezone">
                <Select.Root size="small" value={timezone} onValueChange={setTimezone}>
                  <Select.Trigger aria-label="Timezone">
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Content>
                    {timezones.map((tz) => (
                      <Select.Item key={tz} value={tz}>
                        {tz}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Start" htmlFor={`li-start-${account.id}`}>
                  <input id={`li-start-${account.id}`} type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className={cn(timeInputClass, inverted && "ring-error-base")} />
                </Field>
                <Field label="End" htmlFor={`li-end-${account.id}`} error={inverted ? "Ends before it starts." : undefined}>
                  <input id={`li-end-${account.id}`} type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className={cn(timeInputClass, inverted && "ring-error-base")} />
                </Field>
              </div>

              <fieldset>
                <legend className="text-label-sm text-text-strong-950">Working days</legend>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {WEEK_ORDER.map((day) => {
                    const on = days.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleDay(day)}
                        className={cn(
                          "h-8 min-w-11 rounded-lg px-2.5 text-label-sm outline-none ring-1 ring-inset transition focus-visible:shadow-button-important-focus",
                          on
                            ? "bg-bg-strong-950 text-text-white-0 ring-bg-strong-950"
                            : "bg-bg-white-0 text-text-sub-600 ring-stroke-soft-200 hover:bg-bg-weak-50 hover:text-text-strong-950",
                        )}
                      >
                        {WEEKDAY_LABELS[day]}
                      </button>
                    );
                  })}
                </div>
                {noDays && <p className="mt-1.5 text-paragraph-xs text-error-base">Select at least one working day.</p>}
              </fieldset>
            </>
          )}

          {error && <Callout tone="error">{error}</Callout>}
        </Modal.Body>
        <Modal.Footer>
          <Button.Root variant="neutral" mode="stroke" size="small" onClick={onClose}>
            Cancel
          </Button.Root>
          <Button.Root variant="primary" mode="filled" size="small" onClick={handleSave} disabled={saving || noDays}>
            {saving && <Button.Icon as={RiLoader4Line} className="animate-spin" />}
            {saving ? "Saving…" : "Save hours"}
          </Button.Root>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
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
  onEditHours,
  onEditLimit,
}: {
  account: AccountRow;
  sentToday: number;
  pending: number;
  limits: InviteLimits;
  onEditHours: () => void;
  onEditLimit: () => void;
}) {
  const { redirecting, error, start } = useHostedAuthRedirect();
  const displayName = account.name || account.username;
  const hours = hoursSummary(account);

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
        <p className="truncate text-paragraph-sm text-text-strong-950" title={hours.tz ? `${hours.main} (${hours.tz})` : hours.main}>{hours.main}</p>
        <p className="truncate text-paragraph-xs text-text-sub-600" suppressHydrationWarning>
          Next: {formatNextAllowedRun(account.nextAllowedRun ? new Date(account.nextAllowedRun) : null)}
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
              <Dropdown.Item onSelect={onEditHours}>
                <Dropdown.ItemIcon as={RiTimeLine} />
                {hasWorkingHoursConfigured(account) ? "Edit working hours" : "Set working hours"}
              </Dropdown.Item>
              <Dropdown.Item onSelect={onEditLimit}>
                <Dropdown.ItemIcon as={RiDashboard3Line} />
                Daily request limit
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
  onEditHours,
  onEditLimit,
}: {
  accounts: AccountRow[];
  sentTodayMap: Record<string, number>;
  pendingLeadsMap: Record<string, number>;
  limits: InviteLimits;
  onEditHours: (account: AccountRow) => void;
  onEditLimit: (account: AccountRow) => void;
}) {
  return (
    <Table.Root className="min-w-190 [&>table]:table-fixed">
      <Table.Header>
        <Table.Row>
          <Table.Head scope="col" className="px-4">Account</Table.Head>
          <Table.Head scope="col" className="w-32 px-4">Status</Table.Head>
          <Table.Head scope="col" className="w-36 px-4">Requests today</Table.Head>
          <Table.Head scope="col" className="w-20 px-4 text-right" title="Leads waiting for a connection request from this account">Pending</Table.Head>
          <Table.Head scope="col" className="w-48 px-4">Schedule</Table.Head>
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
            onEditHours={() => onEditHours(account)}
            onEditLimit={() => onEditLimit(account)}
          />
        ))}
      </Table.Body>
    </Table.Root>
  );
}

export function AccountsClient({
  accounts: initialAccounts,
  sentTodayMap,
  pendingLeadsMap,
  inviteLimits,
}: {
  accounts: AccountRow[];
  sentTodayMap: Record<string, number>;
  pendingLeadsMap: Record<string, number>;
  inviteLimits: InviteLimits;
}) {
  const [accounts, setAccounts] = useState(initialAccounts);
  const [editingAccount, setEditingAccount] = useState<AccountRow | null>(null);
  const [limitAccount, setLimitAccount] = useState<AccountRow | null>(null);
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
          hint="Connection requests sent today, against the daily limits of connected accounts."
        />
        <KpiCell icon={RiUserStarLine} label="Premium" value={String(premium)} context={`${accounts.length - premium} on a free plan`} hint={`Premium accounts can send ${inviteLimits.premium} connection requests a day; free accounts ${inviteLimits.free}. Change it in Settings → LinkedIn sending rules, or per account.`} />
      </KpiStrip>

      {disconnected > 0 && (
        <Callout tone="warning" className="mt-5" title={`${disconnected} ${disconnected === 1 ? "account is" : "accounts are"} disconnected`}>
          Campaigns skip them until they are reconnected. Reconnect re-authenticates the same account in place, so its campaigns and history stay.
        </Callout>
      )}

      <AccountsFrame
        title="Accounts"
        description="Daily request limits, working hours and when each account next works."
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
          <AccountsTable accounts={filtered} sentTodayMap={sentTodayMap} pendingLeadsMap={pendingLeadsMap} limits={inviteLimits} onEditHours={setEditingAccount} onEditLimit={setLimitAccount} />
        )}
      </AccountsFrame>

      {editingAccount && (
        <WorkingHoursDialog
          key={editingAccount.id}
          account={editingAccount}
          onClose={() => setEditingAccount(null)}
          onSaved={(updated) => {
            setAccounts((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
          }}
        />
      )}
      {limitAccount && (
        <AccountLimitDialog
          key={limitAccount.id}
          title="Daily request limit"
          accountLabel={limitAccount.name || `@${limitAccount.username}`}
          rule={numberRule("linkedin", limitAccount.isPremium ? "invitesPerDayPremium" : "invitesPerDayFree")}
          organizationValue={organizationLimit(limitAccount, inviteLimits)}
          value={limitAccount.dailyInviteLimit}
          onClose={() => setLimitAccount(null)}
          onSave={async (dailyInviteLimit) => {
            const res = await fetch(`/api/linkedin/accounts/${limitAccount.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ dailyInviteLimit }),
            });
            const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
            if (!data?.ok) throw new Error(data?.error ?? "Save failed");
            setAccounts((prev) => prev.map((a) => (a.id === limitAccount.id ? { ...a, dailyInviteLimit } : a)));
          }}
        />
      )}
    </div>
  );
}
