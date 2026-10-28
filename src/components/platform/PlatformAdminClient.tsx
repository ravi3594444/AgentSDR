"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { Callout } from "@/components/settings/SettingsKit";
import { formatAllowanceAmount, type AllowanceUnit } from "@/lib/managed/allowances";
import { CLAUDE_CODE_MODELS, type ClaudeCodeModelCheck } from "@/lib/ai/claudeCode/contract";
import {
  ANTHROPIC_MODELS,
  MANAGED_AI_ENGINE_LABEL,
  MANAGED_AI_ENGINES,
  MANAGED_SERVICE_INFO,
  PLATFORM_CREDENTIAL_INFO,
  PLATFORM_CREDENTIAL_KEYS,
  type ManagedAiEngine,
  type ManagedAiSettings,
  type PlatformCredentialKey,
  type PlatformCredentialStatus,
} from "@/lib/managed/catalog";

type Overview = { credentials: PlatformCredentialStatus[]; ai: ManagedAiSettings; aiProblem: string | null };
type PrivateClaude = {
  source: { organizationId: string; userId: string } | null;
  problem: string | null;
  checks: Record<string, ClaudeCodeModelCheck>;
  workspaces: { id: string; name: string }[];
  limits: { message: string; resetsAt: string | null }[];
};
type AdoptSource = { organizationId: string; name: string; available: PlatformCredentialKey[] };
type UsageRow = { organizationId: string; organizationName: string; provider: string; product: string; source: "managed" | "own"; calls: number; units: number; costUsd: number; estimated: boolean };
type UsageReport = { from: string; to: string; rows: UsageRow[]; budgets: { key: string; label: string; unit: AllowanceUnit; used: number; budget: number; workspaceAllowance: number; estimated: boolean }[] };

const field = "h-9 w-full rounded-lg border border-stroke-soft-200 bg-bg-white-0 px-3 text-paragraph-sm text-text-strong-950 disabled:opacity-60";

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.error ?? `The request failed (${response.status})`);
  return body;
}

function money(value: number): string {
  return value < 0.01 && value > 0 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** One stored default key: its masked status, and the form that stores, replaces or removes it. */
function CredentialRow({ status, onChanged }: { status: PlatformCredentialStatus; onChanged: () => Promise<void> }) {
  const info = PLATFORM_CREDENTIAL_INFO[status.key];
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function store() {
    setBusy(true);
    setError(null);
    try {
      await call(`/api/platform/credentials/${status.key}`, { method: "PUT", body: JSON.stringify(values) });
      setValues({});
      setOpen(false);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove the platform's ${info.label} key? Every workspace on the Included service stops using ${info.label} until a key is stored again.`)) return;
    setBusy(true);
    setError(null);
    try {
      await call(`/api/platform/credentials/${status.key}`, { method: "DELETE" });
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const details = [
    ...Object.entries(status.values).map(([key, value]) => `${info.fields.find((f) => f.key === key)?.label ?? key}: ${value}`),
    ...Object.entries(status.hints).map(([key, hint]) => `${info.fields.find((f) => f.key === key)?.label ?? key} ${hint}`),
  ];

  return (
    <li className="flex flex-col gap-3 border-b border-stroke-soft-200 py-4 last:border-b-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-label-sm text-text-strong-950">{info.label}</span>
            <Badge.Root variant="lighter" size="small" color={status.stored ? "green" : "gray"}>{status.stored ? "Stored" : "Not stored"}</Badge.Root>
          </div>
          <p className="mt-1 break-words text-paragraph-xs text-text-sub-600">
            {status.stored
              ? [
                details.join(" · "),
                status.verifiedAt ? `verified ${new Date(status.verifiedAt).toLocaleString()}` : null,
                status.adoptedFrom ? `adopted from ${status.adoptedFrom.name ?? status.adoptedFrom.organizationId}` : null,
                status.webhooks ? `webhooks ${status.webhooks.status}${status.webhooks.message ? ` (${status.webhooks.message})` : ""}` : null,
              ].filter(Boolean).join(" · ")
              : `Included workspaces cannot use ${info.label} until a key is stored.`}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button.Root variant="neutral" mode="stroke" size="xsmall" disabled={busy} onClick={() => setOpen((value) => !value)}>{status.stored ? "Replace" : "Store key"}</Button.Root>
          {status.stored && <Button.Root variant="error" mode="stroke" size="xsmall" disabled={busy} onClick={() => void remove()}>Remove</Button.Root>}
        </div>
      </div>
      {open && (
        <div className="flex flex-col gap-3 rounded-lg bg-bg-weak-50 p-3">
          {info.fields.map((f) => (
            <label key={f.key} className="flex flex-col gap-1 text-label-xs text-text-strong-950">
              {f.label}{f.required ? "" : " (optional)"}
              <input
                className={field}
                type={f.secret ? "password" : "text"}
                autoComplete="off"
                placeholder={f.secret && status.hints[f.key] ? "Leave empty to keep the stored value" : f.placeholder ?? ""}
                value={values[f.key] ?? ""}
                disabled={busy}
                onChange={(event) => setValues((current) => ({ ...current, [f.key]: event.target.value }))}
              />
              {f.help && <span className="text-paragraph-xs font-normal text-text-sub-600">{f.help}</span>}
            </label>
          ))}
          <p className="text-paragraph-xs text-text-sub-600">Checked with one cheap call before it is stored, then kept encrypted. It is never shown again; only its last four characters.</p>
          {error && <Callout tone="error">{error}</Callout>}
          <div className="flex justify-end gap-2">
            <Button.Root variant="neutral" mode="ghost" size="xsmall" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button.Root>
            <Button.Root variant="primary" mode="filled" size="xsmall" disabled={busy} onClick={() => void store()}>{busy ? "Checking…" : "Verify and store"}</Button.Root>
          </div>
        </div>
      )}
      {!open && error && <Callout tone="error">{error}</Callout>}
    </li>
  );
}

/** The Included AI engine and its model. */
function AiEngineForm({ overview, onChanged }: { overview: Overview; onChanged: () => Promise<void> }) {
  const stored = useMemo(() => new Set(overview.credentials.filter((c) => c.stored).map((c) => c.key)), [overview]);
  const [engine, setEngine] = useState<ManagedAiEngine | "">(overview.ai.engine ?? "");
  const [model, setModel] = useState(overview.ai.defaultModel?.modelId ?? "");
  const [upstream, setUpstream] = useState(overview.ai.engine === "openrouter" ? overview.ai.defaultModel?.provider ?? "" : "");
  const [research, setResearch] = useState(overview.ai.researchModel?.modelId ?? "");
  const [transcription, setTranscription] = useState(overview.ai.transcriptionModel?.modelId ?? "");
  const [confirmed, setConfirmed] = useState(overview.ai.byokOnlyConfirmed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [privateClaude, setPrivateClaude] = useState<PrivateClaude | null>(null);
  const [approved, setApproved] = useState<string[]>(overview.ai.sharedClaude?.approvedOrganizationIds ?? []);

  useEffect(() => {
    let current = true;
    void call<PrivateClaude>("/api/platform/claude-code").then(
      (value) => { if (current) setPrivateClaude(value); },
      (cause: unknown) => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); },
    );
    return () => { current = false; };
  }, []);

  async function save(next: ManagedAiEngine | "") {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const provider = next === "openrouter" ? upstream.trim() : next;
      await call("/api/platform/ai", {
        method: "PUT",
        body: JSON.stringify(next ? {
          engine: next,
          defaultModel: { provider, modelId: model.trim() },
          researchModel: next === "aimlapi" && research.trim() ? { provider: "aimlapi", modelId: research.trim() } : null,
          transcriptionModel: next === "openrouter" && transcription.trim() ? { provider, modelId: transcription.trim() } : null,
          byokOnlyConfirmed: next === "openrouter" && confirmed,
          ...(next === "claude-code" ? { sharedClaude: { ...privateClaude?.source, approvedOrganizationIds: approved } } : {}),
        } : { engine: null }),
      });
      setSaved(true);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-label-xs text-text-strong-950 sm:max-w-sm">
        Engine for Included workspaces
        <select className={field} value={engine} disabled={busy} onChange={(event) => { setEngine(event.target.value as ManagedAiEngine | ""); setSaved(false); }}>
          <option value="">None (Included AI is off)</option>
          {MANAGED_AI_ENGINES.map((key) => (
            <option key={key} value={key} disabled={key === "claude-code" ? !privateClaude?.source : !stored.has(key)}>{MANAGED_AI_ENGINE_LABEL[key]}{key === "claude-code" ? "" : stored.has(key) ? "" : " (store its key first)"}</option>
          ))}
        </select>
      </label>
      {engine !== "claude-code" && privateClaude?.problem && <p className="text-paragraph-xs text-text-sub-600">Claude Code private test: {privateClaude.problem}</p>}
      {engine === "claude-code" && (
        <div className="flex flex-col gap-3 rounded-lg bg-bg-weak-50 p-3">
          <p className="text-paragraph-sm text-text-strong-950">Private testing on your signed-in Claude Code account. Only the workspaces you select can use it. Chats stay separate; your account&apos;s usage limits are shared.</p>
          <Link className="text-paragraph-sm underline" href="/settings/ai">Sign in or check a model in AI provider settings</Link>
          {privateClaude?.problem && <Callout tone="warning">{privateClaude.problem}</Callout>}
          <label className="flex flex-col gap-1 text-label-xs text-text-strong-950 sm:max-w-sm">Model
            <select className={field} value={model} disabled={busy} onChange={(event) => setModel(event.target.value)}>
              <option value="">Choose a checked model</option>
              {CLAUDE_CODE_MODELS.map((item) => {
                const check = privateClaude?.checks[item.key];
                return <option key={item.key} value={item.key} disabled={!check?.ok}>{item.label}{check?.ok ? ` (${check.modelId})` : " — check it first"}</option>;
              })}
            </select>
          </label>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-label-xs text-text-strong-950">Approved test workspaces</legend>
            {privateClaude?.workspaces.map((workspace) => (
              <label key={workspace.id} className="flex items-center gap-2 text-paragraph-sm text-text-strong-950">
                <input type="checkbox" checked={approved.includes(workspace.id)} disabled={busy} onChange={(event) => setApproved((current) => event.target.checked ? [...current, workspace.id] : current.filter((id) => id !== workspace.id))} />
                {workspace.name}
              </label>
            ))}
          </fieldset>
          {privateClaude?.limits.map((limit, index) => <Callout key={index} tone="warning">{limit.message}{limit.resetsAt ? ` Reset: ${new Date(limit.resetsAt).toLocaleString()}.` : ""}</Callout>)}
          <p className="text-paragraph-xs text-text-sub-600">One AI step at a time per account. No automatic switch to a paid API. Subscription use is recorded as calls and tokens, without inventing an API charge.</p>
        </div>
      )}
      {engine === "anthropic" && (
        <label className="flex flex-col gap-1 text-label-xs text-text-strong-950 sm:max-w-sm">
          Default model
          <select className={field} value={model} disabled={busy} onChange={(event) => setModel(event.target.value)}>
            <option value="">Choose a Claude model</option>
            {ANTHROPIC_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label} ({m.id})</option>)}
          </select>
        </label>
      )}
      {engine === "openrouter" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-label-xs text-text-strong-950">Upstream provider (BYOK slug)<input className={field} value={upstream} placeholder="e.g. deepinfra" disabled={busy} onChange={(event) => setUpstream(event.target.value)} /></label>
          <label className="flex flex-col gap-1 text-label-xs text-text-strong-950">Default model<input className={field} value={model} placeholder="e.g. z-ai/glm-5" disabled={busy} onChange={(event) => setModel(event.target.value)} /></label>
          <label className="flex flex-col gap-1 text-label-xs text-text-strong-950">Transcription model (optional)<input className={field} value={transcription} disabled={busy} onChange={(event) => setTranscription(event.target.value)} /></label>
          <label className="flex items-center gap-2 text-paragraph-xs text-text-strong-950 sm:col-span-2"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} />Every enabled provider in OpenRouter&apos;s BYOK dashboard is set to never use shared capacity.</label>
        </div>
      )}
      {engine === "aimlapi" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-label-xs text-text-strong-950">Default model<input className={field} value={model} placeholder="e.g. openai/gpt-4o-mini" disabled={busy} onChange={(event) => setModel(event.target.value)} /></label>
          <label className="flex flex-col gap-1 text-label-xs text-text-strong-950">Web research model (optional)<input className={field} value={research} placeholder="e.g. perplexity/sonar" disabled={busy} onChange={(event) => setResearch(event.target.value)} /></label>
        </div>
      )}
      {overview.aiProblem && <Callout tone="warning">{overview.aiProblem}</Callout>}
      {error && <Callout tone="error">{error}</Callout>}
      {saved && !error && <p className="text-paragraph-xs text-success-base">Saved. Included workspaces use it within 30 seconds.</p>}
      <p className="text-paragraph-xs text-text-sub-600">Workspaces on My own provider keep their own engine and models. Customers never see which engine or model the Included service uses.</p>
      <div className="flex justify-end">
        <Button.Root variant="primary" mode="filled" size="xsmall" disabled={busy || (Boolean(engine) && !model.trim()) || (engine === "claude-code" && (Boolean(privateClaude?.problem) || !privateClaude?.source || approved.length === 0 || !privateClaude.checks[model]?.ok))} onClick={() => void save(engine)}>{busy ? "Saving…" : "Save AI engine"}</Button.Root>
      </div>
    </div>
  );
}

/** Adopting one named organization's own keys as the platform's defaults. */
function AdoptForm({ onChanged }: { onChanged: () => Promise<void> }) {
  const [sources, setSources] = useState<AdoptSource[] | null>(null);
  const [organizationId, setOrganizationId] = useState("");
  const [keys, setKeys] = useState<PlatformCredentialKey[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    // Loads the list once.
    void call<{ sources: AdoptSource[] }>("/api/platform/adopt").then((body) => setSources(body.sources), (cause: unknown) => setMessage({ tone: "error", text: cause instanceof Error ? cause.message : String(cause) }));
  }, []);

  const source = sources?.find((s) => s.organizationId === organizationId) ?? null;

  async function adopt() {
    if (!source || !keys.length) return;
    if (!window.confirm(`Copy ${source.name}'s own keys for ${keys.map((k) => PLATFORM_CREDENTIAL_INFO[k].label).join(", ")} into the platform's defaults? Its own keys and settings stay exactly as they are.`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await call<{ adopted: PlatformCredentialKey[]; skipped: { key: PlatformCredentialKey; reason: string }[]; aiSettingsAdopted: boolean }>("/api/platform/adopt", { method: "POST", body: JSON.stringify({ organizationId, keys }) });
      const parts = [
        result.adopted.length ? `Adopted: ${result.adopted.map((k) => PLATFORM_CREDENTIAL_INFO[k].label).join(", ")}.` : "Nothing was adopted.",
        ...result.skipped.map((s) => `${PLATFORM_CREDENTIAL_INFO[s.key].label}: ${s.reason}.`),
        result.aiSettingsAdopted ? "Its AI model choice is now the Included one." : "",
      ];
      setMessage({ tone: result.adopted.length ? "success" : "error", text: parts.filter(Boolean).join(" ") });
      setKeys([]);
      await onChanged();
    } catch (cause) {
      setMessage({ tone: "error", text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  }

  if (sources && !sources.length) return <p className="text-paragraph-sm text-text-sub-600">No organization has saved keys of its own.</p>;
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-label-xs text-text-strong-950 sm:max-w-sm">
        Organization to copy from
        <select className={field} value={organizationId} disabled={busy || !sources} onChange={(event) => { setOrganizationId(event.target.value); setKeys([]); }}>
          <option value="">{sources ? "Choose an organization" : "Loading…"}</option>
          {sources?.map((s) => <option key={s.organizationId} value={s.organizationId}>{s.name}</option>)}
        </select>
      </label>
      {source && (
        <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
          <legend className="mb-1 text-label-xs text-text-strong-950">Its keys to copy</legend>
          {source.available.map((key) => (
            <label key={key} className="flex items-center gap-2 text-paragraph-sm text-text-strong-950">
              <input type="checkbox" checked={keys.includes(key)} disabled={busy} onChange={(event) => setKeys((current) => event.target.checked ? [...current, key] : current.filter((k) => k !== key))} />
              {PLATFORM_CREDENTIAL_INFO[key].label}
            </label>
          ))}
        </fieldset>
      )}
      {message && <Callout tone={message.tone === "success" ? "success" : "error"}>{message.text}</Callout>}
      <div className="flex justify-end">
        <Button.Root variant="neutral" mode="stroke" size="xsmall" disabled={busy || !source || !keys.length} onClick={() => void adopt()}>{busy ? "Adopting…" : "Adopt as defaults"}</Button.Root>
      </div>
    </div>
  );
}

function monthParam(offset: number): string {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Use by workspace and provider, and the platform budgets. */
function UsagePanel() {
  const [month, setMonth] = useState(monthParam(0));
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    // Reloads whenever the month changes.
    void call<UsageReport>(`/api/platform/usage?month=${month}`).then((body) => { if (current) { setReport(body); setError(null); } }, (cause: unknown) => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { current = false; };
  }, [month]);

  const managedCost = report?.rows.filter((row) => row.source === "managed").reduce((sum, row) => sum + row.costUsd, 0) ?? 0;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="flex flex-col gap-1 text-label-xs text-text-strong-950">
          Month (UTC)
          <select className={`${field} w-44`} value={month} onChange={(event) => setMonth(event.target.value)}>
            {[0, -1, -2].map((offset) => <option key={offset} value={monthParam(offset)}>{monthParam(offset)}</option>)}
          </select>
        </label>
        {report && <p className="text-paragraph-sm text-text-strong-950">Included cost this month: <strong>{money(managedCost)}</strong> <span className="text-text-sub-600">(estimated where a provider reports no bill)</span></p>}
      </div>
      {error && <Callout tone="error">{error}</Callout>}
      {report && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-paragraph-sm">
              <thead className="text-label-xs text-text-sub-600"><tr><th className="py-2 pr-3 font-medium">Platform budget</th><th className="py-2 pr-3 font-medium">Used</th><th className="py-2 pr-3 font-medium">Budget</th><th className="py-2 font-medium">Per workspace</th></tr></thead>
              <tbody>
                {report.budgets.map((budget) => (
                  <tr key={budget.key} className="border-t border-stroke-soft-200">
                    <td className="py-2 pr-3 text-text-strong-950">{budget.label}{budget.estimated ? " (estimated)" : ""}</td>
                    <td className="py-2 pr-3">{formatAllowanceAmount(budget.used, budget.unit)}</td>
                    <td className="py-2 pr-3">{formatAllowanceAmount(budget.budget, budget.unit)}</td>
                    <td className="py-2">{formatAllowanceAmount(budget.workspaceAllowance, budget.unit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-paragraph-sm">
              <thead className="text-label-xs text-text-sub-600"><tr><th className="py-2 pr-3 font-medium">Workspace</th><th className="py-2 pr-3 font-medium">Provider</th><th className="py-2 pr-3 font-medium">Keys</th><th className="py-2 pr-3 font-medium">Calls</th><th className="py-2 pr-3 font-medium">Units</th><th className="py-2 font-medium">Cost</th></tr></thead>
              <tbody>
                {report.rows.length === 0 && <tr><td colSpan={6} className="py-3 text-text-sub-600">Nothing used this month.</td></tr>}
                {report.rows.map((row) => (
                  <tr key={`${row.organizationId}:${row.provider}:${row.product}:${row.source}`} className="border-t border-stroke-soft-200">
                    <td className="py-2 pr-3 text-text-strong-950">{row.organizationName}</td>
                    <td className="py-2 pr-3">{row.provider} · {row.product}</td>
                    <td className="py-2 pr-3">{row.source === "managed" ? "Included" : "Own"}</td>
                    <td className="py-2 pr-3">{row.calls.toLocaleString()}</td>
                    <td className="py-2 pr-3">{Math.round(row.units).toLocaleString()}</td>
                    <td className="py-2">{row.provider === "ai" && row.product === "claude-code" ? "Account plan (cost not reported)" : <>{money(row.costUsd)}{row.estimated ? " est." : ""}</>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export function PlatformAdminClient() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOverview(await call<Overview>("/api/platform/credentials"));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    // Loads once on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const byService = useMemo(() => {
    const services = [...new Set(PLATFORM_CREDENTIAL_KEYS.map((key) => PLATFORM_CREDENTIAL_INFO[key].service))];
    return services.map((service) => ({ service, keys: PLATFORM_CREDENTIAL_KEYS.filter((key) => PLATFORM_CREDENTIAL_INFO[key].service === service) }));
  }, []);

  return (
    <div className="mt-6 flex flex-col gap-6">
      {error && <Callout tone="error">{error}</Callout>}
      <Frame>
        <FrameHeader title="Default keys" description="The platform's own credentials. Workspaces on the Included service use them; workspaces on My own provider use theirs. Stored encrypted; only the last four characters are shown." />
        <FramePanel>
          {!overview && !error && <p className="text-paragraph-sm text-text-sub-600">Loading…</p>}
          {overview && byService.map(({ service, keys }) => (
            <section key={service} className="mb-2">
              <h3 className="pt-3 text-label-xs uppercase tracking-wide text-text-sub-600">{service === "exa" ? "Exa web research" : MANAGED_SERVICE_INFO[service].label}</h3>
              <ul>
                {keys.map((key) => {
                  const status = overview.credentials.find((c) => c.key === key);
                  return status ? <CredentialRow key={key} status={status} onChanged={load} /> : null;
                })}
              </ul>
            </section>
          ))}
        </FramePanel>
      </Frame>
      {overview && (
        <Frame>
          <FrameHeader title="Included AI" description="Choose the default AI service, or approve specific workspaces for private testing on your Claude Code login." />
          <FramePanel><AiEngineForm key={JSON.stringify(overview.ai)} overview={overview} onChanged={load} /></FramePanel>
        </Frame>
      )}
      <Frame>
        <FrameHeader title="Adopt an existing configuration" description="Copy one organization's own keys into the defaults, for example the organization you already run on. Only when you choose it here; nothing is guessed, and the originals stay as they are." />
        <FramePanel><AdoptForm onChanged={load} /></FramePanel>
      </Frame>
      <Frame>
        <FrameHeader title="Usage" description="What each workspace used this month, on the platform's keys (Included) and on its own. Costs are estimated where a provider does not report its bill." />
        <FramePanel><UsagePanel /></FramePanel>
      </Frame>
    </div>
  );
}
