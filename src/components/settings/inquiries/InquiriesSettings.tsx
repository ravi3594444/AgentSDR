"use client";

import { useState } from "react";
import {
  RiAddLine,
  RiArrowDownSLine,
  RiCheckLine,
  RiDeleteBinLine,
  RiFileCopyLine,
  RiGlobalLine,
  RiInboxLine,
  RiInstagramLine,
  RiKey2Line,
  RiPencilLine,
  RiRefreshLine,
  RiWebhookLine,
} from "@remixicon/react";
import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Input from "@/components/alignui/input";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { useDialogs } from "@/components/DialogProvider";
import { EmptyState } from "@/components/page/EmptyState";
import { Callout, Field } from "@/components/settings/SettingsKit";
import { BRAND } from "@/lib/brand";
import { relativeTime } from "@/lib/format/contact";
import type { InquirySummary, IntakeEndpointSummary } from "@/lib/intake/endpoints.server";
import type { IntakeFieldInfo } from "@/lib/intake/fields";
import type { IntakeFieldMap } from "@/lib/intake/schema";
import { cn } from "@/utils/cn";

/**
 * Settings → Inquiries (src/app/settings/inquiries/page.tsx): how a website
 * form reaches AgentSDR, the webhooks (one per form tool), and the latest
 * inquiries. A token is shown once, right after the webhook is made or its
 * token rotated; the list only ever has its last four characters.
 */

type Revealed = { endpointId: string; token: string };

async function call<T>(url: string, init?: { method: string; body?: unknown }): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    method: init?.method ?? "GET",
    headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.error ?? "Something went wrong. Please try again.");
  return body;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export function InquiriesSettings({
  webhookUrl,
  canManage,
  fields,
  initialEndpoints,
  initialInquiries,
}: {
  webhookUrl: string;
  canManage: boolean;
  fields: IntakeFieldInfo[];
  initialEndpoints: IntakeEndpointSummary[];
  initialInquiries: InquirySummary[];
}) {
  const dialogs = useDialogs();
  const [endpoints, setEndpoints] = useState(initialEndpoints);
  const [inquiries, setInquiries] = useState(initialInquiries);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [mapOpen, setMapOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(id: string, action: () => Promise<void>) {
    setBusy(id);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  const replace = (endpoint: IntakeEndpointSummary) =>
    setEndpoints((current) => current.map((item) => (item.id === endpoint.id ? endpoint : item)));

  function create(event: React.FormEvent) {
    event.preventDefault();
    void run("new", async () => {
      const created = await call<{ endpoint: IntakeEndpointSummary; token: string }>("/api/intake/endpoints", {
        method: "POST",
        body: { name: newName.trim() || undefined },
      });
      setEndpoints((current) => [created.endpoint, ...current]);
      setRevealed({ endpointId: created.endpoint.id, token: created.token });
      setMapOpen(created.endpoint.id);
      setCreating(false);
      setNewName("");
    });
  }

  async function rename(endpoint: IntakeEndpointSummary) {
    const name = await dialogs.prompt({ title: "Rename webhook", label: "Name", defaultValue: endpoint.name, confirmLabel: "Rename" });
    if (name === null || name.trim() === endpoint.name) return;
    await run(endpoint.id, async () => {
      replace((await call<{ endpoint: IntakeEndpointSummary }>(`/api/intake/endpoints/${endpoint.id}`, { method: "PATCH", body: { name } })).endpoint);
    });
  }

  async function toggle(endpoint: IntakeEndpointSummary) {
    if (endpoint.enabled) {
      const confirmed = await dialogs.confirm({
        title: `Turn off “${endpoint.name}”?`,
        description: "Submissions sent to it are refused until you turn it on again; your form tool may retry them or drop them.",
        confirmLabel: "Turn off",
      });
      if (!confirmed) return;
    }
    await run(endpoint.id, async () => {
      replace((await call<{ endpoint: IntakeEndpointSummary }>(`/api/intake/endpoints/${endpoint.id}`, { method: "PATCH", body: { enabled: !endpoint.enabled } })).endpoint);
    });
  }

  async function rotate(endpoint: IntakeEndpointSummary) {
    const confirmed = await dialogs.confirm({
      title: `New token for “${endpoint.name}”?`,
      description: "The current token stops working at once. Put the new one in your form tool straight after.",
      confirmLabel: "Rotate token",
      variant: "error",
    });
    if (!confirmed) return;
    await run(endpoint.id, async () => {
      const rotated = await call<{ endpoint: IntakeEndpointSummary; token: string }>(`/api/intake/endpoints/${endpoint.id}/rotate`, { method: "POST" });
      replace(rotated.endpoint);
      setRevealed({ endpointId: rotated.endpoint.id, token: rotated.token });
    });
  }

  async function remove(endpoint: IntakeEndpointSummary) {
    const confirmed = await dialogs.confirm({
      title: `Delete “${endpoint.name}”?`,
      description: "Submissions sent to it are refused from now on. The inquiries it already received are kept.",
      confirmLabel: "Delete",
      variant: "error",
    });
    if (!confirmed) return;
    await run(endpoint.id, async () => {
      await call(`/api/intake/endpoints/${endpoint.id}`, { method: "DELETE" });
      setEndpoints((current) => current.filter((item) => item.id !== endpoint.id));
      if (revealed?.endpointId === endpoint.id) setRevealed(null);
    });
  }

  async function saveMap(endpoint: IntakeEndpointSummary, fieldMap: IntakeFieldMap) {
    await run(endpoint.id, async () => {
      replace((await call<{ endpoint: IntakeEndpointSummary }>(`/api/intake/endpoints/${endpoint.id}`, { method: "PATCH", body: { fieldMap } })).endpoint);
    });
  }

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      const [list, recent] = await Promise.all([
        call<{ endpoints: IntakeEndpointSummary[] }>("/api/intake/endpoints"),
        call<{ inquiries: InquirySummary[] }>("/api/intake/inquiries?limit=50&historical=1"),
      ]);
      setEndpoints(list.endpoints);
      setInquiries(recent.inquiries);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <SetupSteps webhookUrl={webhookUrl} />

      {error && <Callout tone="error">{error}</Callout>}

      <Frame>
        <FrameHeader
          title="Webhooks"
          description="One per form tool, each with its own token, so you can turn one off without touching the others."
          actions={canManage && !creating && endpoints.length > 0 ? (
            <Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={() => setCreating(true)}>
              <Button.Icon as={RiAddLine} />
              New webhook
            </Button.Root>
          ) : undefined}
        />
        <FramePanel className="p-0 sm:p-0">
          {creating && (
            <form onSubmit={create} className="flex flex-col gap-2 border-b border-stroke-soft-200 p-3 sm:flex-row sm:items-center sm:p-4">
              <div className="min-w-0 flex-1">
                <Input.Root size="small">
                  <Input.Wrapper>
                    <Input.Icon as={RiWebhookLine} />
                    <Input.Input
                      autoFocus
                      aria-label="Webhook name"
                      placeholder="Name, e.g. Contact page (Zapier)"
                      value={newName}
                      maxLength={100}
                      onChange={(event) => setNewName(event.target.value)}
                    />
                  </Input.Wrapper>
                </Input.Root>
              </div>
              <div className="flex gap-2">
                <Button.Root type="button" variant="neutral" mode="stroke" size="small" disabled={busy === "new"} onClick={() => setCreating(false)}>
                  Cancel
                </Button.Root>
                <Button.Root type="submit" variant="primary" mode="filled" size="small" disabled={busy === "new"}>
                  {busy === "new" ? "Creating…" : "Create webhook"}
                </Button.Root>
              </div>
            </form>
          )}

          {endpoints.length ? (
            <ul className="divide-y divide-stroke-soft-200">
              {endpoints.map((endpoint) => (
                <EndpointRow
                  key={endpoint.id}
                  endpoint={endpoint}
                  webhookUrl={webhookUrl}
                  fields={fields}
                  canManage={canManage}
                  busy={busy === endpoint.id}
                  token={revealed?.endpointId === endpoint.id ? revealed.token : null}
                  onTokenDone={() => setRevealed(null)}
                  mapOpen={mapOpen === endpoint.id}
                  onToggleMap={() => setMapOpen((open) => (open === endpoint.id ? null : endpoint.id))}
                  onRename={() => void rename(endpoint)}
                  onToggle={() => void toggle(endpoint)}
                  onRotate={() => void rotate(endpoint)}
                  onDelete={() => void remove(endpoint)}
                  onSaveMap={(map) => void saveMap(endpoint, map)}
                />
              ))}
            </ul>
          ) : !creating ? (
            <EmptyState
              compact
              icon={RiWebhookLine}
              title="No webhooks yet"
              description={canManage ? "Create one, then add its URL and token to your form tool." : "An owner or admin creates them."}
              action={canManage ? (
                <Button.Root variant="primary" mode="filled" size="small" onClick={() => setCreating(true)}>
                  <Button.Icon as={RiAddLine} />
                  Create webhook
                </Button.Root>
              ) : undefined}
            />
          ) : null}
        </FramePanel>
        {!canManage && <FrameFooter>Only owners and admins can add or change webhooks.</FrameFooter>}
      </Frame>

      <Frame>
        <FrameHeader
          title="Recent inquiries"
          description="The latest 50, newest first. Historical ones were sent as a backfill and are never acted on."
          actions={(
            <Button.Root variant="neutral" mode="ghost" size="xsmall" disabled={refreshing} onClick={() => void refresh()}>
              <Button.Icon as={RiRefreshLine} className={cn(refreshing && "animate-spin")} />
              Refresh
            </Button.Root>
          )}
        />
        <FramePanel className="p-0 sm:p-0">
          {inquiries.length ? (
            <ul className="divide-y divide-stroke-soft-200">
              {inquiries.map((inquiry) => <InquiryRow key={inquiry.id} inquiry={inquiry} />)}
            </ul>
          ) : (
            <EmptyState
              compact
              icon={RiInboxLine}
              title="No inquiries yet"
              description="Send a test submission from your form tool; it shows up here within seconds."
            />
          )}
        </FramePanel>
      </Frame>
    </div>
  );
}

/** The one-time setup, said plainly: a site's address alone connects nothing. */
function SetupSteps({ webhookUrl }: { webhookUrl: string }) {
  const steps: React.ReactNode[] = [
    <>Create a webhook below. You get a secret token for it, shown once.</>,
    <>
      In your form tool, add a webhook that sends each submission as a <Code>POST</Code> to this URL, with the token in an{" "}
      <Code>X-AgentSDR-Token</Code> header:
      <CopyValue value={webhookUrl} className="mt-1.5" />
      <ul className="mt-2 list-disc space-y-1 pl-4">
        <li><span className="text-text-strong-950">Zapier or Make:</span> after your form&apos;s trigger, add <em>Webhooks by Zapier → POST</em> or <em>HTTP → Make a request</em>, send the form&apos;s fields, and add the header.</li>
        <li><span className="text-text-strong-950">Webflow, WordPress (Contact Form 7, WPForms, Gravity Forms, Elementor) and similar:</span> use the form&apos;s webhook setting or plugin. If it cannot add a header, put the token in the URL instead (<Code>?token=…</Code>); it may then show up in that tool&apos;s logs.</li>
        <li><span className="text-text-strong-950">A developer:</span> JSON, form-urlencoded or multipart, up to 64 KB. The example shown with the token works as is.</li>
      </ul>
    </>,
    <>Send a test submission. It appears under Recent inquiries, and the webhook shows when it last heard from your form.</>,
    <>Fields called email, phone, name, message and the like are recognized on their own. If yours are named differently, map them on the webhook.</>,
  ];
  return (
    <Frame>
      <FrameHeader title="How it connects" description="A one-time setup in your form tool, by you or whoever looks after your website." />
      <FramePanel className="flex flex-col gap-4">
        <Callout tone="info" title="Entering your website's address does not connect its forms">
          {BRAND.shortName} cannot see what visitors type into a form on your site. Your form tool has to send each submission here.
        </Callout>
        <ol className="space-y-3">
          {steps.map((step, index) => (
            <li key={index} className="flex gap-2.5 text-paragraph-sm text-text-sub-600">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-bg-weak-50 text-label-xs text-text-strong-950 ring-1 ring-inset ring-stroke-soft-200">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">{step}</div>
            </li>
          ))}
        </ol>
        <p className="border-t border-stroke-soft-200 pt-3 text-paragraph-xs text-text-sub-600">
          A submission with a valid email or phone becomes a contact (the same person if they are already in your contacts). Nothing is sent
          to them and no CRM record is made; what they wrote is kept for the assistant. To bring in old submissions, add{" "}
          <Code>?historical=1</Code> to the URL: they are kept and listed, never acted on.
        </p>
      </FramePanel>
    </Frame>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-bg-weak-50 px-1 py-0.5 font-mono text-paragraph-xs text-text-strong-950 ring-1 ring-inset ring-stroke-soft-200">{children}</code>;
}

function EndpointRow({
  endpoint,
  webhookUrl,
  fields,
  canManage,
  busy,
  token,
  onTokenDone,
  mapOpen,
  onToggleMap,
  onRename,
  onToggle,
  onRotate,
  onDelete,
  onSaveMap,
}: {
  endpoint: IntakeEndpointSummary;
  webhookUrl: string;
  fields: IntakeFieldInfo[];
  canManage: boolean;
  busy: boolean;
  token: string | null;
  onTokenDone: () => void;
  mapOpen: boolean;
  onToggleMap: () => void;
  onRename: () => void;
  onToggle: () => void;
  onRotate: () => void;
  onDelete: () => void;
  onSaveMap: (map: IntakeFieldMap) => void;
}) {
  const mapped = Object.keys(endpoint.fieldMap).length;
  return (
    <li className={cn("flex flex-col gap-3 px-3 py-3 sm:px-4", busy && "opacity-60")} aria-busy={busy || undefined}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-bg-weak-50 ring-1 ring-inset ring-stroke-soft-200">
          <RiWebhookLine className="size-4 text-text-sub-600" aria-hidden="true" />
        </span>
        <div className="min-w-40 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-label-sm text-text-strong-950">{endpoint.name}</p>
            <Badge.Root size="small" variant="lighter" color={endpoint.enabled ? "green" : "gray"}>{endpoint.enabled ? "On" : "Off"}</Badge.Root>
          </div>
          <p className="mt-0.5 text-paragraph-xs text-text-sub-600">
            <span className="font-mono">Token …{endpoint.tokenHint}</span>
            {" · "}
            {endpoint.lastReceivedAt ? (
              <>Last received <time dateTime={endpoint.lastReceivedAt} title={formatWhen(endpoint.lastReceivedAt)} suppressHydrationWarning>{relativeTime(endpoint.lastReceivedAt)}</time></>
            ) : "Nothing received yet"}
            {" · "}
            {endpoint.inquiries} {endpoint.inquiries === 1 ? "inquiry" : "inquiries"}
          </p>
        </div>
        <div className="ml-11 flex flex-wrap items-center gap-1.5 sm:ml-0">
          <Button.Root variant="neutral" mode="ghost" size="xsmall" onClick={onToggleMap} aria-expanded={mapOpen}>
            Field mapping{mapped ? ` (${mapped})` : ""}
            <Button.Icon as={RiArrowDownSLine} className={cn("transition-transform duration-200", mapOpen && "rotate-180")} />
          </Button.Root>
          {canManage && (
            <>
              <Button.Root variant="neutral" mode="ghost" size="xsmall" disabled={busy} onClick={onRename} aria-label={`Rename ${endpoint.name}`} title="Rename">
                <Button.Icon as={RiPencilLine} />
              </Button.Root>
              <Button.Root variant="neutral" mode="ghost" size="xsmall" disabled={busy} onClick={onRotate}>
                <Button.Icon as={RiKey2Line} />
                Rotate token
              </Button.Root>
              <Button.Root variant="neutral" mode="stroke" size="xsmall" disabled={busy} onClick={onToggle}>
                {endpoint.enabled ? "Turn off" : "Turn on"}
              </Button.Root>
              <Button.Root variant="error" mode="ghost" size="xsmall" disabled={busy} onClick={onDelete} aria-label={`Delete ${endpoint.name}`} title="Delete">
                <Button.Icon as={RiDeleteBinLine} />
              </Button.Root>
            </>
          )}
        </div>
      </div>

      {token && <TokenReveal webhookUrl={webhookUrl} token={token} onDone={onTokenDone} />}
      {mapOpen && (
        <FieldMapEditor key={JSON.stringify(endpoint.fieldMap)} endpoint={endpoint} fields={fields} canManage={canManage} busy={busy} onSave={onSaveMap} />
      )}
    </li>
  );
}

/** The token, right after it was made: copy it now, it is not shown again. */
function TokenReveal({ webhookUrl, token, onDone }: { webhookUrl: string; token: string; onDone: () => void }) {
  const example = [
    `curl -X POST '${webhookUrl}' \\`,
    `  -H 'X-AgentSDR-Token: ${token}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"name":"Test Person","email":"test.person@example.com","message":"Testing the website form webhook"}'`,
  ].join("\n");
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-bg-weak-50 p-3 sm:ml-11">
      <Callout tone="warning" title="Copy the token now">
        It is not shown again. If it is lost, rotate it and put the new one in your form tool.
      </Callout>
      <div className="flex flex-col gap-1">
        <span className="text-label-xs text-text-strong-950">URL</span>
        <CopyValue value={webhookUrl} />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-label-xs text-text-strong-950">Token (header <span className="font-mono">X-AgentSDR-Token</span>)</span>
        <CopyValue value={token} />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-label-xs text-text-strong-950">Try it</span>
        <CopyValue value={example} multiline />
        <span className="text-paragraph-xs text-text-sub-600">This records a test contact, Test Person; delete it from People afterwards.</span>
      </div>
      <div className="flex justify-end">
        <Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={onDone}>
          <Button.Icon as={RiCheckLine} />
          I&apos;ve copied it
        </Button.Root>
      </div>
    </div>
  );
}

/** Which form field holds what; an empty one is recognized by its usual names (the placeholder). */
function FieldMapEditor({
  endpoint,
  fields,
  canManage,
  busy,
  onSave,
}: {
  endpoint: IntakeEndpointSummary;
  fields: IntakeFieldInfo[];
  canManage: boolean;
  busy: boolean;
  onSave: (map: IntakeFieldMap) => void;
}) {
  const [draft, setDraft] = useState<IntakeFieldMap>(endpoint.fieldMap);
  const changed = fields.some(({ key }) => (draft[key]?.trim() ?? "") !== (endpoint.fieldMap[key] ?? ""));
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-stroke-soft-200 p-3 sm:ml-11"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft);
      }}
    >
      <p className="text-paragraph-xs text-text-sub-600">
        Your form&apos;s name for each field. Leave one empty to recognize it by the usual names shown. Case, spaces, dashes and
        underscores do not matter; a nested field can be named by its path, like <span className="font-mono">data.email</span>.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((info) => {
          const id = `intake-map-${endpoint.id}-${info.key}`;
          const usual = [...info.aliases, ...(info.shallowAliases ?? [])];
          return (
            <Field key={info.key} label={info.label} htmlFor={id}>
              <Input.Root size="small">
                <Input.Wrapper>
                  <Input.Input
                    id={id}
                    value={draft[info.key] ?? ""}
                    placeholder={usual.length > 3 ? `${usual.slice(0, 3).join(", ")}…` : usual.join(", ")}
                    title={`Recognized when empty: ${usual.join(", ")}`}
                    disabled={!canManage || busy}
                    maxLength={200}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => setDraft((current) => ({ ...current, [info.key]: event.target.value }))}
                  />
                </Input.Wrapper>
              </Input.Root>
            </Field>
          );
        })}
      </div>
      {canManage && (
        <div className="flex justify-end gap-2">
          <Button.Root type="button" variant="neutral" mode="ghost" size="xsmall" disabled={busy || !changed} onClick={() => setDraft(endpoint.fieldMap)}>
            Reset
          </Button.Root>
          <Button.Root type="submit" variant="primary" mode="filled" size="xsmall" disabled={busy || !changed}>
            {busy ? "Saving…" : "Save mapping"}
          </Button.Root>
        </div>
      )}
    </form>
  );
}

function InquiryRow({ inquiry }: { inquiry: InquirySummary }) {
  const when = inquiry.submittedAt ?? inquiry.receivedAt;
  const route = [inquiry.email, inquiry.phone, inquiry.instagramUsername ? `@${inquiry.instagramUsername}` : null].filter(Boolean) as string[];
  const Icon = inquiry.source === "instagram" ? RiInstagramLine : RiGlobalLine;
  const source = inquiry.source === "instagram"
    ? "Instagram"
    : inquiry.endpointName ? `Website form · ${inquiry.endpointName}` : "Website form";
  return (
    <li className="flex gap-3 px-3 py-3 sm:px-4">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-bg-weak-50 ring-1 ring-inset ring-stroke-soft-200">
        <Icon className="size-4 text-text-sub-600" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="truncate text-label-sm text-text-strong-950">{inquiry.name ?? route[0] ?? "No name"}</p>
          <Badge.Root size="small" variant="lighter" color={inquiry.status === "unusable" ? "red" : "green"}>
            {inquiry.status === "unusable" ? "Unusable" : "Received"}
          </Badge.Root>
          {inquiry.historical && <Badge.Root size="small" variant="lighter" color="gray">Historical</Badge.Root>}
        </div>
        <p className="mt-0.5 truncate text-paragraph-xs text-text-sub-600">{route.length ? route.join(" · ") : "No email or phone"}</p>
        {inquiry.message && <p className="mt-1 line-clamp-2 whitespace-pre-line text-paragraph-sm text-text-strong-950">{inquiry.message}</p>}
        {inquiry.reason && <p className="mt-1 text-paragraph-xs text-error-base">{inquiry.reason}</p>}
        {inquiry.status !== "unusable" && inquiry.dropped.map((item) => (
          <p key={item.field} className="mt-1 text-paragraph-xs text-warning-dark">
            {item.field === "email" ? "Email" : "Phone"} not kept: {item.reason}
          </p>
        ))}
        <p className="mt-1 text-paragraph-xs text-text-soft-400">
          {source} · <time dateTime={when} suppressHydrationWarning>{formatWhen(when)}</time>
        </p>
      </div>
    </li>
  );
}

/** A value with Copy; long values wrap (multiline keeps their line breaks). */
function CopyValue({ value, multiline = false, className }: { value: string; multiline?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: the value is selectable text, so it can still be copied by hand.
    }
  }
  return (
    <div className={cn("flex items-start gap-2 rounded-md bg-bg-white-0 p-2 ring-1 ring-inset ring-stroke-soft-200", className)}>
      <code className={cn("min-w-0 flex-1 select-all font-mono text-paragraph-xs text-text-strong-950", multiline ? "whitespace-pre-wrap break-all" : "break-all")}>
        {value}
      </code>
      <Button.Root type="button" variant="neutral" mode="ghost" size="xxsmall" onClick={() => void copy()}>
        <Button.Icon as={copied ? RiCheckLine : RiFileCopyLine} />
        {copied ? "Copied" : "Copy"}
      </Button.Root>
    </div>
  );
}
