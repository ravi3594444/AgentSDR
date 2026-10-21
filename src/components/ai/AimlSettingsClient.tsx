"use client";

import { useEffect, useMemo, useState } from "react";
import { RiCheckLine, RiExternalLinkLine, RiKey2Line, RiLoader4Line, RiRefreshLine, RiSearchLine } from "@remixicon/react";
import { AiBrandIcon } from "@/components/ai/AiBrandIcon";
import { StepFrame, linkClass } from "@/components/ai/ByokSettingsClient";
import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Checkbox from "@/components/alignui/checkbox";
import * as Input from "@/components/alignui/input";
import * as Select from "@/components/alignui/select";
import { FormSkeleton } from "@/components/settings/SettingsSkeletons";
import { Callout, Field } from "@/components/settings/SettingsKit";
import { AIML_KEYS_URL, AIML_MODELS_DOCS_URL, AIML_PROVIDER_KEY, AIML_PROVIDER_NAME } from "@/lib/ai/aimlapi-types";
import { BRAND } from "@/lib/brand";
import { cn } from "@/utils/cn";

type Connection = { id: string; providerKey?: string; name: string; verified?: boolean };
type Model = { id: string; name: string; developer?: string; description?: string; context_length?: number; capabilities?: string[] };
type Selection = { provider: string; modelId: string };
type Settings = {
  connectionId: string | null;
  providers: string[];
  modelsByProvider: Record<string, string[]>;
  defaultModel: Selection | null;
  researchModel?: Selection | null;
  researchDailyLimit?: number;
};

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(body?.error ?? "Something went wrong. Please try again.");
  return body as T;
}

const CAPABILITY_LABELS: Record<string, string> = { tools: "Tools", vision: "Vision", reasoning: "Reasoning", web_search: "Web search" };

function formatContext(value?: number) {
  return value ? `${new Intl.NumberFormat("en-US", { notation: "compact" }).format(value)} context` : null;
}

/**
 * AI Settings for an AI/ML API connection: one key, then the models every AI
 * feature may use and a default. Only structured-output chat models are
 * listed (the server filters AI/ML's catalog), so whatever is picked can
 * answer the app's JSON-schema requests. Saving makes AI/ML API the provider
 * for the whole organization.
 */
export default function AimlSettingsClient({ onSaved }: { onSaved?: () => void }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [researchModel, setResearchModel] = useState<string>("");
  const [researchDailyLimit, setResearchDailyLimit] = useState<number>(25);
  const [catalog, setCatalog] = useState<Model[]>([]);
  const [activeHere, setActiveHere] = useState(false);
  const [search, setSearch] = useState("");
  const [onlySelected, setOnlySelected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [showConnectForm, setShowConnectForm] = useState(false);
  const [accountName, setAccountName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function loadCatalog(id: string) {
    const data = await readJson<{ providers?: Array<{ slug: string; models: Model[] }> }>(
      await fetch(`/api/ai/openrouter/models?all=1&connectionId=${encodeURIComponent(id)}`),
    );
    setCatalog(data.providers?.find((provider) => provider.slug === AIML_PROVIDER_KEY)?.models ?? []);
  }

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetch("/api/ai/openrouter/settings").then((response) => readJson<Settings>(response)),
      fetch(`/api/grid/ai/providers/${AIML_PROVIDER_KEY}/connections`).then((response) => readJson<{ connections?: Connection[] }>(response)),
    ]).then(async ([saved, accountData]) => {
      if (cancelled) return;
      const accounts = accountData.connections ?? [];
      setConnections(accounts);
      // The saved settings belong to this panel only when they point at an AI/ML connection.
      const ours = saved.connectionId && accounts.some((account) => account.id === saved.connectionId) ? saved.connectionId : null;
      setActiveHere(Boolean(ours));
      const id = ours ?? accounts.find((account) => account.verified !== false)?.id ?? null;
      setConnectionId(id);
      if (ours) {
        setSelected(saved.modelsByProvider?.[AIML_PROVIDER_KEY] ?? []);
        setDefaultModel(saved.defaultModel?.provider === AIML_PROVIDER_KEY ? saved.defaultModel.modelId : "");
        setResearchModel(saved.researchModel?.provider === AIML_PROVIDER_KEY ? saved.researchModel.modelId : "");
      }
      if (typeof saved.researchDailyLimit === "number") setResearchDailyLimit(saved.researchDailyLimit);
      if (id) await loadCatalog(id);
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load AI settings.");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const byId = useMemo(() => new Map(catalog.map((model) => [model.id, model])), [catalog]);
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return catalog.filter((model) =>
      (!onlySelected || selected.includes(model.id))
      && (!query || `${model.name} ${model.id} ${model.developer ?? ""}`.toLowerCase().includes(query)));
  }, [catalog, onlySelected, search, selected]);
  const selectedAvailable = selected.filter((id) => byId.has(id));
  // Research needs a model AI/ML marks as searching the web; it must also be one of the selected models.
  const searchCapable = selectedAvailable.filter((id) => byId.get(id)?.capabilities?.includes("web_search"));
  const missing = selected.filter((id) => !byId.has(id));

  function toggle(modelId: string) {
    setSuccess(null);
    const next = selected.includes(modelId) ? selected.filter((id) => id !== modelId) : [...selected, modelId];
    setSelected(next);
    // A lone selected model becomes the default; a removed default is cleared.
    if (!defaultModel || !next.includes(defaultModel)) setDefaultModel(next.length === 1 ? next[0] : "");
  }

  async function connectAccount() {
    if (!apiKey.trim()) return setError(`Enter your ${AIML_PROVIDER_NAME} key.`);
    setConnecting(true);
    setError(null);
    setSuccess(null);
    try {
      const data = await readJson<{ connection?: Connection }>(await fetch(`/api/grid/ai/providers/${AIML_PROVIDER_KEY}/connections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: accountName.trim() || `${AIML_PROVIDER_NAME} account`, credentials: { apiKey: apiKey.trim() } }),
      }));
      const connection = data.connection;
      if (!connection) throw new Error("The account was created without a connection record.");
      setConnections((current) => [connection, ...current.filter((item) => item.id !== connection.id)]);
      setConnectionId(connection.id);
      setApiKey("");
      setAccountName("");
      setShowConnectForm(false);
      await loadCatalog(connection.id);
      setSuccess(`${AIML_PROVIDER_NAME} key verified and saved (encrypted). Choose models below, then save.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not connect ${AIML_PROVIDER_NAME}.`);
    } finally {
      setConnecting(false);
    }
  }

  async function refresh() {
    if (!connectionId) return;
    setRefreshing(true);
    setError(null);
    try {
      await loadCatalog(connectionId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not refresh the model list.");
    } finally {
      setRefreshing(false);
    }
  }

  async function save() {
    if (!connectionId) return setError(`Connect an ${AIML_PROVIDER_NAME} key before saving.`);
    if (!selectedAvailable.length) return setError("Select at least one model.");
    if (!defaultModel || !selectedAvailable.includes(defaultModel)) return setError("Choose a default model.");
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const saved = await readJson<Settings>(await fetch("/api/ai/openrouter/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId,
          providers: [AIML_PROVIDER_KEY],
          modelsByProvider: { [AIML_PROVIDER_KEY]: selectedAvailable },
          defaultModel: { provider: AIML_PROVIDER_KEY, modelId: defaultModel },
          transcriptionModel: null,
          researchModel: researchModel && searchCapable.includes(researchModel) ? { provider: AIML_PROVIDER_KEY, modelId: researchModel } : null,
          researchDailyLimit,
          byokOnlyConfirmed: false,
        }),
      }));
      setSelected(saved.modelsByProvider?.[AIML_PROVIDER_KEY] ?? []);
      setActiveHere(true);
      setSuccess(`AI settings saved. Every AI feature now uses ${AIML_PROVIDER_NAME}.`);
      onSaved?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save AI settings.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <FormSkeleton frames={3} />;

  const selectedConnection = connections.find((connection) => connection.id === connectionId);
  const stepsDone = [Boolean(selectedConnection), selectedAvailable.length > 0, Boolean(defaultModel && selectedAvailable.includes(defaultModel))];

  return (
    <div className="space-y-4">
      {error && <Callout tone="error">{error}</Callout>}
      {success && <Callout tone="success">{success}</Callout>}

      <StepFrame
        step={1}
        done={stepsDone[0]}
        title={`${AIML_PROVIDER_NAME} key`}
        description={<>One key is the whole connection: no management key, BYOK providers or routing setting. It is checked with {AIML_PROVIDER_NAME} and encrypted before it is stored, for this organization only.</>}
        actions={<a href={AIML_KEYS_URL} target="_blank" rel="noreferrer" className={linkClass}>{AIML_PROVIDER_NAME} keys<RiExternalLinkLine className="size-3.5" aria-hidden="true" /></a>}
      >
        {connections.length > 0 && (
          <div role="radiogroup" aria-label={`${AIML_PROVIDER_NAME} account`} className="grid gap-2 sm:grid-cols-2">
            {connections.map((connection) => {
              const active = connection.id === connectionId;
              return (
                <button
                  key={connection.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => {
                    if (active) return;
                    setConnectionId(connection.id);
                    setSuccess(null);
                    setRefreshing(true);
                    void loadCatalog(connection.id).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load models.")).finally(() => setRefreshing(false));
                  }}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left outline-none ring-inset transition focus-visible:shadow-button-important-focus",
                    active ? "bg-bg-white-0 ring-2 ring-primary-base" : "ring-1 ring-stroke-soft-200 hover:bg-bg-weak-50",
                  )}
                >
                  <RiKey2Line className="size-5 shrink-0 text-text-sub-600" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-label-sm text-text-strong-950">{connection.name}</span>
                    <span className={cn("mt-0.5 block text-paragraph-xs", connection.verified === false ? "text-warning-dark" : "text-text-sub-600")}>
                      {connection.verified === false ? "Verification required" : "Verified"}
                    </span>
                  </span>
                  {active && <RiCheckLine className="size-5 shrink-0 text-primary-base" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        )}
        {!showConnectForm ? (
          <div className={cn("flex flex-wrap items-center gap-3", connections.length > 0 && "mt-4")}>
            <Button.Root type="button" variant={connections.length ? "neutral" : "primary"} mode={connections.length ? "stroke" : "filled"} size="small" onClick={() => { setShowConnectForm(true); setError(null); }}>
              <Button.Icon as={RiKey2Line} />
              {connections.length ? "Add another key" : `Connect ${AIML_PROVIDER_NAME}`}
            </Button.Root>
          </div>
        ) : (
          <div className={cn("rounded-xl bg-bg-weak-50 p-4 ring-1 ring-inset ring-stroke-soft-200", connections.length > 0 && "mt-4")}>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Account name" htmlFor="aiml-name" optional>
                <Input.Root size="small">
                  <Input.Wrapper>
                    <Input.Input id="aiml-name" value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder={`${AIML_PROVIDER_NAME} production`} />
                  </Input.Wrapper>
                </Input.Root>
              </Field>
              <Field label={`${AIML_PROVIDER_NAME} key`} htmlFor="aiml-key" required>
                <Input.Root size="small">
                  <Input.Wrapper>
                    <Input.Input id="aiml-key" type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Paste the key" />
                  </Input.Wrapper>
                </Input.Root>
              </Field>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button.Root type="button" variant="neutral" mode="stroke" size="small" onClick={() => setShowConnectForm(false)} disabled={connecting}>Cancel</Button.Root>
              <Button.Root type="button" variant="primary" mode="filled" size="small" onClick={() => void connectAccount()} disabled={connecting || !apiKey.trim()}>
                {connecting && <Button.Icon as={RiLoader4Line} className="animate-spin" />}
                {connecting ? "Verifying…" : "Verify & connect"}
              </Button.Root>
            </div>
          </div>
        )}
      </StepFrame>

      <StepFrame
        step={2}
        done={stepsDone[1]}
        title="Models"
        description={<>Chat models {AIML_PROVIDER_NAME} lists with structured output, which reply sorting, drafts and AI columns need. Only the models you select can be used. <a href={AIML_MODELS_DOCS_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2">Model list</a></>}
        actions={
          <Button.Root type="button" variant="neutral" mode="stroke" size="xsmall" onClick={() => void refresh()} disabled={refreshing || !connectionId}>
            <Button.Icon as={refreshing ? RiLoader4Line : RiRefreshLine} className={cn(refreshing && "animate-spin")} />
            {refreshing ? "Refreshing…" : "Refresh models"}
          </Button.Root>
        }
      >
        {!connectionId ? (
          <p className="text-paragraph-sm text-text-sub-600">Connect a key to choose models.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Input.Root size="small" className="min-w-0 flex-1">
                <Input.Wrapper>
                  <Input.Icon as={RiSearchLine} />
                  <Input.Input type="search" aria-label="Search models" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search models, e.g. gpt-4o-mini or gemini…" />
                </Input.Wrapper>
              </Input.Root>
              <label className="flex cursor-pointer items-center gap-2 text-paragraph-sm text-text-sub-600">
                <Checkbox.Root checked={onlySelected} onCheckedChange={(checked) => setOnlySelected(checked === true)} />
                Selected only ({selectedAvailable.length})
              </label>
            </div>
            {missing.length > 0 && (
              <Callout tone="warning" className="mt-3">
                No longer listed with structured output, so they will be dropped on save: {missing.join(", ")}
              </Callout>
            )}
            <div className={cn("mt-3 max-h-96 divide-y divide-stroke-soft-200 overflow-y-auto rounded-xl bg-bg-white-0 ring-1 ring-inset ring-stroke-soft-200", refreshing && "opacity-60")} aria-busy={refreshing || undefined}>
              {visible.slice(0, 200).map((model) => (
                <label key={model.id} className="flex cursor-pointer items-start gap-2.5 px-3 py-2.5 transition hover:bg-bg-weak-50">
                  <Checkbox.Root className="mt-1" checked={selected.includes(model.id)} onCheckedChange={() => toggle(model.id)} aria-label={model.name} />
                  <AiBrandIcon identifier={model.id} label={model.name} className="size-7" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-label-sm text-text-strong-950">{model.name}</span>
                    <span className="mt-0.5 block truncate font-mono text-paragraph-xs text-text-sub-600">{model.id}</span>
                    <span className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-paragraph-xs text-text-sub-600">
                      {model.developer && <span>{model.developer}</span>}
                      {formatContext(model.context_length) && <span>{formatContext(model.context_length)}</span>}
                      {(model.capabilities ?? []).filter((capability) => CAPABILITY_LABELS[capability]).map((capability) => <span key={capability}>{CAPABILITY_LABELS[capability]}</span>)}
                    </span>
                  </span>
                </label>
              ))}
              {!visible.length && <p className="px-3 py-5 text-center text-paragraph-sm text-text-sub-600">{catalog.length ? "No models match." : "The model list is empty. Refresh, or check that api.aimlapi.com is reachable from the server."}</p>}
              {visible.length > 200 && <p className="px-3 py-3 text-center text-paragraph-xs text-text-sub-600">Showing 200 of {visible.length}. Search to narrow the list.</p>}
            </div>
          </>
        )}
      </StepFrame>

      <StepFrame
        step={3}
        done={stepsDone[2]}
        title="Default model"
        description="Reply sorting, drafts and other internal AI tasks use this model; new AI columns start on it."
      >
        <Field label="Model" className="max-w-xl" description={selectedAvailable.length ? undefined : "Select models above first."}>
          <Select.Root size="small" value={defaultModel} onValueChange={(value) => { setDefaultModel(value); setSuccess(null); }} disabled={!selectedAvailable.length}>
            <Select.Trigger aria-label="Default model">
              <Select.Value placeholder="Select a default model" />
            </Select.Trigger>
            <Select.Content>
              {selectedAvailable.map((id) => (
                <Select.Item key={id} value={id}>{byId.get(id)?.name ?? id}</Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </Field>
        <Callout tone="info" className="mt-4 max-w-2xl">
          With {AIML_PROVIDER_NAME}, call transcription stays off (it has not been checked with {AIML_PROVIDER_NAME}&apos;s audio models yet), and web-research or image AI columns in Tables need OpenRouter. Replies follow each plan&apos;s reply mode, as with OpenRouter: in Review mode drafts wait for you; in Automatic mode ordinary replies are sent and anything unusual waits for you. What needs you is in the Inbox (Needs you).
        </Callout>
      </StepFrame>

      <StepFrame
        step={4}
        done={Boolean(researchModel && searchCapable.includes(researchModel))}
        title="Web research (optional)"
        description="Leads → Companies → Research answers a question about one company from public web pages and saves the answer with its source links. It does not find new leads or read social media."
      >
        <div className="grid max-w-2xl gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <Field
            label="Research model"
            description={searchCapable.length
              ? "Only selected models marked Web search are listed. An answer that comes back without sources is refused, never saved."
              : "Select a model marked Web search in step 2 first. Perplexity Sonar was checked to return its sources."}
          >
            <Select.Root size="small" value={researchModel || "off"} onValueChange={(value) => { setResearchModel(value === "off" ? "" : value); setSuccess(null); }} disabled={!searchCapable.length}>
              <Select.Trigger aria-label="Research model">
                <Select.Value placeholder="Off" />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="off">Off</Select.Item>
                {searchCapable.map((id) => (
                  <Select.Item key={id} value={id}>{byId.get(id)?.name ?? id}</Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Field>
          <Field label="Runs per day" description="Failed runs count too.">
            <Input.Root size="small">
              <Input.Wrapper>
                <Input.Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={500}
                  aria-label="Research runs per day"
                  value={researchDailyLimit}
                  onChange={(event) => { setResearchDailyLimit(Math.min(500, Math.max(1, Number(event.target.value) || 1))); setSuccess(null); }}
                />
              </Input.Wrapper>
            </Input.Root>
          </Field>
        </div>
      </StepFrame>

      <div className="sticky bottom-0 z-10 -mx-4 -mb-5 flex flex-wrap items-center justify-between gap-3 border-t border-stroke-soft-200 bg-bg-white-0/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:-mb-6 sm:px-6 lg:-mx-8 lg:-mb-7 lg:px-8">
        <p className="text-paragraph-xs text-text-sub-600">
          {activeHere
            ? <>{BRAND.shortName} uses <span className="text-text-strong-950">{AIML_PROVIDER_NAME}</span> · {selectedAvailable.length} model{selectedAvailable.length === 1 ? "" : "s"}</>
            : <>Saving switches every AI feature to {AIML_PROVIDER_NAME}.</>}
          {" "}
          <Badge.Root size="small" variant="lighter" color={stepsDone.every(Boolean) ? "green" : "gray"} className="ml-1 align-middle">{stepsDone.filter(Boolean).length} of 3 steps</Badge.Root>
        </p>
        <Button.Root type="button" variant="primary" mode="filled" size="small" onClick={() => void save()} disabled={saving || !connectionId}>
          {saving && <Button.Icon as={RiLoader4Line} className="animate-spin" />}
          {saving ? "Saving…" : "Save AI settings"}
        </Button.Root>
      </div>
    </div>
  );
}
