"use client";

import { useEffect, useMemo, useState } from "react";
import {
  RiArrowDownSLine,
  RiCheckLine,
  RiExternalLinkLine,
  RiKey2Line,
  RiLoader4Line,
  RiRefreshLine,
  RiSearchLine,
} from "@remixicon/react";
import { AiBrandIcon } from "@/components/ai/AiBrandIcon";
import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Checkbox from "@/components/alignui/checkbox";
import * as Input from "@/components/alignui/input";
import * as Select from "@/components/alignui/select";
import { Frame, FramePanel } from "@/components/analytics/kit/Frame";
import { DocsLink } from "@/components/page/DocsLink";
import { EmptyState } from "@/components/page/EmptyState";
import { PlatformLogo } from "@/components/settings/PlatformConnection";
import { Callout, Field } from "@/components/settings/SettingsKit";
import { OPENROUTER_ICON_URL } from "@/lib/platform/catalog";
import { FormSkeleton } from "@/components/settings/SettingsSkeletons";
import { cn } from "@/utils/cn";
import { BRAND } from "@/lib/brand";

type Connection = {
  id: string;
  providerKey?: string;
  name: string;
  enabled?: boolean;
  verified?: boolean;
};

type Model = {
  id: string;
  name: string;
  description?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  supportedParameters?: string[];
  outputModalities?: string[];
};

type Provider = {
  slug: string;
  name: string;
  credentialCount: number;
  prioritizedCredentialCount: number;
  fallbackCredentialCount: number;
  discoveredModelCount: number;
  modelFilterRestricted: boolean;
  allowedModelCount: number;
  unmatchedAllowedModels: string[];
  models: Model[];
};

type DefaultModel = { provider: string; modelId: string };

type Settings = {
  connectionId: string | null;
  providers: string[];
  modelsByProvider: Record<string, string[]>;
  defaultModel: DefaultModel | null;
  transcriptionModel: DefaultModel | null;
  byokOnlyConfirmed: boolean;
};

type CatalogResponse = { providers?: Provider[]; settings?: Partial<Settings> };

const EMPTY_SETTINGS: Settings = {
  connectionId: null,
  providers: [],
  modelsByProvider: {},
  defaultModel: null,
  transcriptionModel: null,
  byokOnlyConfirmed: false,
};

const KEYS_URL = "https://openrouter.ai/settings/keys";
const MANAGEMENT_KEYS_URL = "https://openrouter.ai/settings/management-keys";
const BYOK_URL = "https://openrouter.ai/workspaces/default/byok";

function normalizeSettings(value: unknown): Settings {
  if (!value || typeof value !== "object") return EMPTY_SETTINGS;
  const input = value as Partial<Settings>;
  const modelsByProvider: Record<string, string[]> = {};
  if (input.modelsByProvider && typeof input.modelsByProvider === "object") {
    for (const [provider, models] of Object.entries(input.modelsByProvider)) {
      if (Array.isArray(models)) modelsByProvider[provider] = models.filter((model): model is string => typeof model === "string");
    }
  }
  const defaultModel = input.defaultModel && typeof input.defaultModel === "object"
    && typeof input.defaultModel.provider === "string"
    && typeof input.defaultModel.modelId === "string"
    ? { provider: input.defaultModel.provider, modelId: input.defaultModel.modelId }
    : null;
  const transcriptionModel = input.transcriptionModel && typeof input.transcriptionModel === "object"
    && typeof input.transcriptionModel.provider === "string"
    && typeof input.transcriptionModel.modelId === "string"
    ? { provider: input.transcriptionModel.provider, modelId: input.transcriptionModel.modelId }
    : null;
  return {
    connectionId: typeof input.connectionId === "string" && input.connectionId ? input.connectionId : null,
    providers: Array.isArray(input.providers) ? input.providers.filter((provider): provider is string => typeof provider === "string") : [],
    modelsByProvider,
    defaultModel,
    transcriptionModel,
    byokOnlyConfirmed: input.byokOnlyConfirmed === true,
  };
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(body?.error ?? "Something went wrong. Please try again.");
  return body as T;
}

function pairKey(provider: string, modelId: string) {
  return `${provider}::${modelId}`;
}

function formatContextLength(value?: number) {
  if (!value) return null;
  return `${new Intl.NumberFormat("en-US", { notation: "compact" }).format(value)} context`;
}

function formatPrice(value?: string) {
  if (!value || value === "0") return null;
  const amount = Number(value) * 1_000_000;
  return Number.isFinite(amount) ? `$${amount.toFixed(amount < 0.01 ? 4 : 2)} / 1M` : null;
}

function ProviderModelPicker({
  provider,
  enabled,
  selectedModels,
  open,
  search,
  onToggleProvider,
  onToggleOpen,
  onSearch,
  onToggleModel,
  onToggleVisible,
}: {
  provider: Provider;
  enabled: boolean;
  selectedModels: string[];
  open: boolean;
  search: string;
  onToggleProvider: () => void;
  onToggleOpen: () => void;
  onSearch: (value: string) => void;
  onToggleModel: (modelId: string) => void;
  onToggleVisible: (models: Model[]) => void;
}) {
  const query = search.trim().toLowerCase();
  const models = query
    ? provider.models.filter((model) =>
        `${model.name} ${model.id} ${model.description ?? ""}`.toLowerCase().includes(query),
      )
    : provider.models;
  const hasPrioritizedCredential = provider.prioritizedCredentialCount > 0;
  const hasModels = provider.models.length > 0;
  const canEnable = hasPrioritizedCredential && hasModels;
  const allVisibleSelected = models.length > 0
    && models.every((model) => selectedModels.includes(model.id));

  let unavailableMessage: React.ReactNode = null;
  if (!hasPrioritizedCredential) {
    unavailableMessage = <>This provider only has fallback-section credentials. Move or add a key in OpenRouter&apos;s prioritized BYOK section.</>;
  } else if (!hasModels && provider.modelFilterRestricted) {
    unavailableMessage = <>
      This key is restricted to {provider.allowedModelCount} model{provider.allowedModelCount === 1 ? "" : "s"}, but none could be resolved to a selectable OpenRouter text or image model.
      {provider.unmatchedAllowedModels.length > 0 && <span className="mt-1 block break-words font-mono text-[13px]">{provider.unmatchedAllowedModels.join(", ")}</span>}
      <span className="mt-1 block">For Azure deployments, set <code>model_slug</code> and <strong>This key applies to</strong> to the canonical ID (for example, <code>openai/gpt-4o</code>), not the Azure deployment name.</span>
    </>;
  } else if (!hasModels) {
    unavailableMessage = <>OpenRouter returned no text or image models for this provider. Refresh after checking the provider configuration.</>;
  }

  return (
    <article className={cn("flex flex-col overflow-hidden rounded-xl bg-bg-white-0 ring-1 ring-inset transition", enabled ? "ring-stroke-sub-300 shadow-regular-xs" : "ring-stroke-soft-200")}>
      <label className={cn("flex items-start gap-3 px-4 py-3", canEnable || enabled ? "cursor-pointer" : "cursor-not-allowed")}>
        <Checkbox.Root
          className="mt-2"
          checked={enabled}
          disabled={!canEnable && !enabled}
          onCheckedChange={onToggleProvider}
          aria-label={`Enable ${provider.name}`}
        />
        <AiBrandIcon identifier={provider.slug} label={provider.name} className="size-9" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-label-sm text-text-strong-950">{provider.name}</span>
          <span className="mt-0.5 block text-paragraph-xs text-text-sub-600">
            <code className="font-mono">{provider.slug}</code> · {provider.prioritizedCredentialCount} prioritized credential{provider.prioritizedCredentialCount === 1 ? "" : "s"}
            {provider.fallbackCredentialCount > 0 ? ` · ${provider.fallbackCredentialCount} fallback-only` : ""}
          </span>
        </span>
        <Badge.Root size="medium" variant="lighter" color={selectedModels.length ? "blue" : "gray"} className="shrink-0">
          {selectedModels.length} selected
        </Badge.Root>
      </label>

      <div className="border-t border-stroke-soft-200 p-3">
        {unavailableMessage ? (
          <Callout tone="warning">
            <p>{unavailableMessage}</p>
            <a href={`${BYOK_URL}/${provider.slug}`} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-label-xs underline underline-offset-2">
              Review {provider.name} BYOK settings<RiExternalLinkLine className="size-3.5" aria-hidden="true" />
            </a>
          </Callout>
        ) : (
          <>
            <button
              type="button"
              onClick={onToggleOpen}
              aria-expanded={open}
              className="flex h-9 w-full items-center justify-between gap-2 rounded-lg bg-bg-white-0 px-3 text-left text-paragraph-sm text-text-strong-950 shadow-regular-xs outline-none ring-1 ring-inset ring-stroke-soft-200 transition hover:bg-bg-weak-50 focus-visible:shadow-button-important-focus focus-visible:ring-stroke-strong-950"
            >
              <span className={cn(!selectedModels.length && "text-text-soft-400")}>
                {selectedModels.length ? `${selectedModels.length} model${selectedModels.length === 1 ? "" : "s"} selected` : `Select ${provider.name} models`}
              </span>
              <RiArrowDownSLine className={cn("size-5 text-text-soft-400 transition-transform duration-200", open && "rotate-180")} aria-hidden="true" />
            </button>

            {open && (
              <div className="mt-2 rounded-xl bg-bg-weak-50 p-2 ring-1 ring-inset ring-stroke-soft-200">
                <div className="flex items-center gap-2">
                  <Input.Root size="xsmall" className="min-w-0 flex-1">
                    <Input.Wrapper>
                      <Input.Icon as={RiSearchLine} />
                      <Input.Input value={search} onChange={(event) => onSearch(event.target.value)} aria-label={`Search ${provider.name} models`} placeholder={`Search ${provider.name} models…`} />
                    </Input.Wrapper>
                  </Input.Root>
                  <Button.Root type="button" variant="neutral" mode="ghost" size="xsmall" onClick={() => onToggleVisible(models)} disabled={!models.length}>
                    {allVisibleSelected ? "Clear shown" : "Select shown"}
                  </Button.Root>
                </div>
                <div className="mt-2 max-h-72 divide-y divide-stroke-soft-200 overflow-y-auto rounded-lg bg-bg-white-0 ring-1 ring-inset ring-stroke-soft-200">
                  {models.map((model) => (
                    <label key={model.id} className="flex cursor-pointer items-start gap-2.5 px-3 py-2.5 transition hover:bg-bg-weak-50">
                      <Checkbox.Root className="mt-1" checked={selectedModels.includes(model.id)} onCheckedChange={() => onToggleModel(model.id)} />
                      <AiBrandIcon identifier={model.id} label={model.name} className="size-7" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-label-sm text-text-strong-950">{model.name}</span>
                        <span className="mt-0.5 block truncate font-mono text-paragraph-xs text-text-sub-600">{model.id}</span>
                        {model.description && <span className="mt-1 line-clamp-2 block text-paragraph-xs text-text-soft-400">{model.description}</span>}
                        <span className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-paragraph-xs text-text-sub-600">
                          {model.outputModalities?.includes("image") && <span>Image</span>}
                          {model.outputModalities?.includes("text") && <span>Text</span>}
                          {formatContextLength(model.context_length) && <span>{formatContextLength(model.context_length)}</span>}
                          {formatPrice(model.pricing?.prompt) && <span>Input {formatPrice(model.pricing?.prompt)}</span>}
                          {formatPrice(model.pricing?.completion) && <span>Output {formatPrice(model.pricing?.completion)}</span>}
                        </span>
                      </span>
                    </label>
                  ))}
                  {!models.length && <p className="px-3 py-5 text-center text-paragraph-sm text-text-sub-600">No models match this search.</p>}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </article>
  );
}

/** A numbered setup step: the number turns into a tick once the step is done. */
export function StepFrame({
  step,
  done,
  title,
  description,
  actions,
  children,
}: {
  step: number;
  done: boolean;
  title: string;
  description: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Frame>
      <header className="flex flex-col gap-3 px-4 pb-3 pt-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <span
            aria-label={done ? `Step ${step}, done` : `Step ${step}`}
            className={cn(
              "mt-px flex size-5 shrink-0 items-center justify-center rounded-full text-label-xs tabular-nums",
              done ? "bg-success-base text-static-white" : "bg-bg-white-0 text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200",
            )}
          >
            {done ? <RiCheckLine className="size-3.5" aria-hidden="true" /> : step}
          </span>
          <div className="min-w-0">
            <h3 className="text-label-sm text-text-strong-950">{title}</h3>
            <div className="mt-0.5 max-w-2xl text-paragraph-xs text-text-sub-600">{description}</div>
          </div>
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 pl-8 sm:pl-0">{actions}</div>}
      </header>
      <FramePanel>{children}</FramePanel>
    </Frame>
  );
}

export const linkClass = "inline-flex items-center gap-1 rounded text-label-xs text-text-sub-600 underline decoration-stroke-sub-300 underline-offset-2 outline-none transition hover:text-text-strong-950 hover:decoration-text-strong-950 focus-visible:ring-2 focus-visible:ring-primary-base";

export default function ByokSettingsClient({ onSaved }: { onSaved?: () => void } = {}) {
  const [settings, setSettings] = useState<Settings>(EMPTY_SETTINGS);
  const [catalog, setCatalog] = useState<Provider[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [showConnectForm, setShowConnectForm] = useState(false);
  const [accountName, setAccountName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [managementKey, setManagementKey] = useState("");
  const [providerSearch, setProviderSearch] = useState("");
  const [modelSearch, setModelSearch] = useState<Record<string, string>>({});
  const [openModelPicker, setOpenModelPicker] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function loadCatalog(connectionId = settings.connectionId) {
    const params = connectionId ? `?all=1&connectionId=${encodeURIComponent(connectionId)}` : "?all=1";
    const response = await fetch(`/api/ai/openrouter/models${params}`);
    const data = await readJson<CatalogResponse>(response);
    setCatalog(data.providers ?? []);
  }

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetch("/api/ai/openrouter/settings").then((response) => readJson<Settings>(response)),
      fetch("/api/grid/ai/providers/openrouter/connections").then((response) => readJson<{ connections?: Connection[] }>(response)),
    ]).then(async ([saved, accountData]) => {
      if (cancelled) return;
      const accounts = accountData.connections ?? [];
      // Saved settings that point at another provider's connection (AI/ML API)
      // are not this panel's: start OpenRouter's setup from empty.
      const savedSettings = normalizeSettings(saved);
      const normalized = savedSettings.connectionId && !accounts.some((account) => account.id === savedSettings.connectionId)
        ? EMPTY_SETTINGS
        : savedSettings;
      setSettings(normalized);
      setConnections(accounts);
      if (normalized.connectionId) {
        const response = await fetch(`/api/ai/openrouter/models?all=1&connectionId=${encodeURIComponent(normalized.connectionId)}`);
        const models = await readJson<CatalogResponse>(response);
        if (!cancelled) setCatalog(models.providers ?? []);
      }
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load AI settings.");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const selectedPairs = useMemo(() => {
    const selectedProviders = new Set(settings.providers);
    return catalog.flatMap((provider) => selectedProviders.has(provider.slug)
      ? (settings.modelsByProvider[provider.slug] ?? [])
        .filter((modelId) => provider.models.some((model) => model.id === modelId))
        .map((modelId) => ({ provider: provider.slug, modelId }))
      : []);
  }, [catalog, settings.modelsByProvider, settings.providers]);

  const defaultPairs = useMemo(() => selectedPairs.filter((item) => {
    const model = catalog
      .find((provider) => provider.slug === item.provider)
      ?.models.find((candidate) => candidate.id === item.modelId);
    return model?.outputModalities?.includes("text")
      && model.supportedParameters?.includes("tools");
  }), [catalog, selectedPairs]);

  const filteredProviders = useMemo(() => {
    const query = providerSearch.trim().toLowerCase();
    return query
      ? catalog.filter((provider) => `${provider.name} ${provider.slug}`.toLowerCase().includes(query))
      : catalog;
  }, [catalog, providerSearch]);

  function updateSettings(patch: Partial<Settings>) {
    setSettings((current) => {
      const next = patch.connectionId !== undefined && patch.connectionId !== current.connectionId
        ? {
            ...current,
            providers: [],
            modelsByProvider: {},
            defaultModel: null,
            transcriptionModel: null,
            byokOnlyConfirmed: false,
            ...patch,
          }
        : { ...current, ...patch };
      const tm = next.transcriptionModel;
      return tm && !(next.providers.includes(tm.provider) && next.modelsByProvider[tm.provider]?.includes(tm.modelId))
        ? { ...next, transcriptionModel: null }
        : next;
    });
    setSuccess(null);
  }

  function toggleProvider(slug: string) {
    const enabled = settings.providers.includes(slug);
    const providers = enabled ? settings.providers.filter((provider) => provider !== slug) : [...settings.providers, slug];
    updateSettings({
      providers,
      defaultModel: enabled && settings.defaultModel?.provider === slug ? null : settings.defaultModel,
    });
  }

  function toggleModel(provider: string, modelId: string) {
    const current = settings.modelsByProvider[provider] ?? [];
    const selected = current.includes(modelId);
    const nextModels = selected ? current.filter((id) => id !== modelId) : [...current, modelId];
    updateSettings({
      providers: selected || settings.providers.includes(provider) ? settings.providers : [...settings.providers, provider],
      modelsByProvider: { ...settings.modelsByProvider, [provider]: nextModels },
      defaultModel: selected && settings.defaultModel?.provider === provider && settings.defaultModel.modelId === modelId ? null : settings.defaultModel,
    });
  }

  function toggleVisibleModels(provider: Provider, models: Model[]) {
    const current = settings.modelsByProvider[provider.slug] ?? [];
    const allSelected = models.length > 0 && models.every((model) => current.includes(model.id));
    const nextModels = allSelected
      ? current.filter((id) => !models.some((model) => model.id === id))
      : [...new Set([...current, ...models.map((model) => model.id)])];
    updateSettings({
      providers: settings.providers.includes(provider.slug) ? settings.providers : [...settings.providers, provider.slug],
      modelsByProvider: { ...settings.modelsByProvider, [provider.slug]: nextModels },
      defaultModel: allSelected && settings.defaultModel?.provider === provider.slug && models.some((model) => model.id === settings.defaultModel?.modelId)
        ? null
        : settings.defaultModel,
    });
  }

  function setDefaultModel(value: string) {
    const selected = selectedPairs.find((item) => pairKey(item.provider, item.modelId) === value);
    updateSettings({ defaultModel: selected ? selected : null });
  }

  function setTranscriptionModel(value: string) {
    const selected = selectedPairs.find((item) => pairKey(item.provider, item.modelId) === value);
    updateSettings({ transcriptionModel: selected ? selected : null });
  }

  async function refreshDiscovery() {
    setRefreshing(true);
    setError(null);
    try {
      await loadCatalog();
      setSuccess("BYOK providers refreshed.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not refresh BYOK providers.");
    } finally {
      setRefreshing(false);
    }
  }

  function switchConnection(connectionId: string) {
    if (connectionId === settings.connectionId) return;
    updateSettings({
      connectionId,
      providers: [],
      modelsByProvider: {},
      defaultModel: null,
      transcriptionModel: null,
      byokOnlyConfirmed: false,
    });
    setRefreshing(true);
    setError(null);
    setSuccess(null);
    void loadCatalog(connectionId)
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Could not refresh BYOK providers."))
      .finally(() => setRefreshing(false));
  }

  async function connectAccount() {
    if (!apiKey.trim() || !managementKey.trim()) {
      setError("Enter both the inference API key and management API key.");
      return;
    }
    setConnecting(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch("/api/grid/ai/providers/openrouter/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: accountName.trim() || "OpenRouter account",
          credentials: { apiKey: apiKey.trim(), managementKey: managementKey.trim() },
        }),
      });
      const data = await readJson<{ connection?: Connection }>(response);
      if (!data.connection) throw new Error("The account was created without a connection record.");
      setConnections((current) => [data.connection!, ...current.filter((item) => item.id !== data.connection!.id)]);
      updateSettings({ connectionId: data.connection.id });
      setApiKey("");
      setManagementKey("");
      setAccountName("");
      setShowConnectForm(false);
      await loadCatalog(data.connection.id);
      setSuccess("OpenRouter account connected and verified.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect OpenRouter.");
    } finally {
      setConnecting(false);
    }
  }

  async function save() {
    if (!settings.connectionId) return setError("Connect an OpenRouter account before saving.");
    if (!settings.providers.length) return setError("Select at least one BYOK provider.");
    if (!selectedPairs.length) return setError("Select at least one model.");
    if (!settings.defaultModel) return setError("Choose a default model.");
    if (!settings.byokOnlyConfirmed) return setError("Confirm that OpenRouter shared capacity fallback is set to Never use shared capacity.");
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch("/api/ai/openrouter/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const saved = await readJson<Settings>(response);
      setSettings(normalizeSettings(saved));
      setSuccess("AI settings saved. Every AI feature now uses OpenRouter.");
      onSaved?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save AI settings.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <FormSkeleton frames={3} />;

  const selectedConnection = connections.find((connection) => connection.id === settings.connectionId);
  const stepsDone = [Boolean(selectedConnection), selectedPairs.length > 0, Boolean(settings.defaultModel), settings.byokOnlyConfirmed];
  const transcriptionValue = settings.transcriptionModel ? pairKey(settings.transcriptionModel.provider, settings.transcriptionModel.modelId) : "";
  const defaultValue = settings.defaultModel ? pairKey(settings.defaultModel.provider, settings.defaultModel.modelId) : "";

  return (
    <div className="space-y-4">
      {error && <Callout tone="error">{error}</Callout>}
      {success && <Callout tone="success">{success}</Callout>}

      <StepFrame
        step={1}
        done={stepsDone[0]}
        title="OpenRouter account"
        description="Your inference and management keys are encrypted before they are stored."
        actions={
          <>
            <a href={KEYS_URL} target="_blank" rel="noreferrer" className={linkClass}>Inference keys<RiExternalLinkLine className="size-3.5" aria-hidden="true" /></a>
            <a href={MANAGEMENT_KEYS_URL} target="_blank" rel="noreferrer" className={linkClass}>Management keys<RiExternalLinkLine className="size-3.5" aria-hidden="true" /></a>
          </>
        }
      >
        {connections.length > 0 && (
          <div role="radiogroup" aria-label="OpenRouter account" className="grid gap-2 sm:grid-cols-2">
            {connections.map((connection) => {
              const active = connection.id === settings.connectionId;
              return (
                <button
                  key={connection.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => switchConnection(connection.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left outline-none ring-inset transition focus-visible:shadow-button-important-focus",
                    active ? "bg-bg-white-0 ring-2 ring-primary-base" : "ring-1 ring-stroke-soft-200 hover:bg-bg-weak-50",
                  )}
                >
                  <PlatformLogo src={OPENROUTER_ICON_URL} size="small" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-label-sm text-text-strong-950">{connection.name}</span>
                    <span className={cn("mt-0.5 block text-paragraph-xs", connection.verified === false ? "text-warning-dark" : "text-text-sub-600")}>
                      {connection.verified === false ? "Verification required" : "Verified and ready to use"}
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
              {connections.length ? "Connect another account" : "Connect OpenRouter"}
            </Button.Root>
            {!connections.length && <DocsLink page="integrations/openrouter#set-it-up" />}
            {!selectedConnection && <p className="text-paragraph-xs text-text-sub-600">Connect an account to choose providers and models.</p>}
          </div>
        ) : (
          <div className={cn("rounded-xl bg-bg-weak-50 p-4 ring-1 ring-inset ring-stroke-soft-200", connections.length > 0 && "mt-4")}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h4 className="text-label-sm text-text-strong-950">Connect OpenRouter</h4>
                <p className="mt-0.5 text-paragraph-xs text-text-sub-600">Create or copy both keys from the OpenRouter dashboard. They are verified before they are saved.</p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <DocsLink page="integrations/openrouter#set-it-up" appearance="inline" className={linkClass} />
                <a href={KEYS_URL} target="_blank" rel="noreferrer" className={linkClass}>Open dashboard<RiExternalLinkLine className="size-3.5" aria-hidden="true" /></a>
              </div>
            </div>
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <Field label="Account name" htmlFor="or-name" optional>
                <Input.Root size="small">
                  <Input.Wrapper>
                    <Input.Input id="or-name" value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder="OpenRouter production" />
                  </Input.Wrapper>
                </Input.Root>
              </Field>
              <Field label="Inference API key" htmlFor="or-key" required>
                <Input.Root size="small">
                  <Input.Wrapper>
                    <Input.Input id="or-key" type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-or-v1-…" />
                  </Input.Wrapper>
                </Input.Root>
              </Field>
              <Field label="Management API key" htmlFor="or-mgmt" required>
                <Input.Root size="small">
                  <Input.Wrapper>
                    <Input.Input id="or-mgmt" type="password" autoComplete="new-password" value={managementKey} onChange={(event) => setManagementKey(event.target.value)} placeholder="sk-or-mgmt-…" />
                  </Input.Wrapper>
                </Input.Root>
              </Field>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button.Root type="button" variant="neutral" mode="stroke" size="small" onClick={() => setShowConnectForm(false)} disabled={connecting}>
                Cancel
              </Button.Root>
              <Button.Root type="button" variant="primary" mode="filled" size="small" onClick={() => void connectAccount()} disabled={connecting || !apiKey.trim() || !managementKey.trim()}>
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
        title="Providers and models"
        description="The providers OpenRouter may route requests to. Only the models you select are available in AI columns."
        actions={
          <Button.Root type="button" variant="neutral" mode="stroke" size="xsmall" onClick={() => void refreshDiscovery()} disabled={refreshing || !settings.connectionId}>
            <Button.Icon as={refreshing ? RiLoader4Line : RiRefreshLine} className={cn(refreshing && "animate-spin")} />
            {refreshing ? "Refreshing…" : "Refresh providers"}
          </Button.Root>
        }
      >
        <Input.Root size="small">
          <Input.Wrapper>
            <Input.Icon as={RiSearchLine} />
            <Input.Input type="search" aria-label="Search providers" value={providerSearch} onChange={(event) => setProviderSearch(event.target.value)} placeholder="Search providers…" />
          </Input.Wrapper>
        </Input.Root>
        {filteredProviders.length ? (
          <div className={cn("mt-4 grid gap-3 xl:grid-cols-2", refreshing && "opacity-60")} aria-busy={refreshing || undefined}>
            {filteredProviders.map((provider) => (
              <ProviderModelPicker
                key={provider.slug}
                provider={provider}
                enabled={settings.providers.includes(provider.slug)}
                selectedModels={settings.modelsByProvider[provider.slug] ?? []}
                open={openModelPicker === provider.slug}
                search={modelSearch[provider.slug] ?? ""}
                onToggleProvider={() => toggleProvider(provider.slug)}
                onToggleOpen={() => setOpenModelPicker((current) => current === provider.slug ? null : provider.slug)}
                onSearch={(value) => setModelSearch((current) => ({ ...current, [provider.slug]: value }))}
                onToggleModel={(modelId) => toggleModel(provider.slug, modelId)}
                onToggleVisible={(models) => toggleVisibleModels(provider, models)}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            compact
            icon={RiSearchLine}
            title={providerSearch.trim() ? "No providers match" : "No BYOK providers found"}
            description={providerSearch.trim() ? "Try another search." : settings.connectionId ? "Add a key in OpenRouter's BYOK settings, then refresh." : "Connect an OpenRouter account first."}
          />
        )}
      </StepFrame>

      <StepFrame
        step={3}
        done={stepsDone[2]}
        title="Default model"
        description="Every internal AI task uses this text model, and new compatible AI columns select it automatically."
      >
        <Field
          label="Provider and model"
          description={defaultPairs.length ? "Only selected text models that support structured output are listed." : "Select at least one text model with structured-output support above to choose a default."}
          className="max-w-xl"
        >
          <Select.Root size="small" value={defaultValue} onValueChange={(value) => setDefaultModel(value)} disabled={!defaultPairs.length && !defaultValue}>
            <Select.Trigger aria-label="Default model">
              <Select.Value placeholder="Select a default model" />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="">Select a default model</Select.Item>
              {defaultPairs.map((item) => {
                const provider = catalog.find((candidate) => candidate.slug === item.provider);
                const model = provider?.models.find((candidate) => candidate.id === item.modelId);
                return (
                  <Select.Item key={pairKey(item.provider, item.modelId)} value={pairKey(item.provider, item.modelId)}>
                    {provider?.name ?? item.provider} · {model?.name ?? item.modelId}
                  </Select.Item>
                );
              })}
            </Select.Content>
          </Select.Root>
        </Field>
        <Field
          label="Call transcription model"
          description="Used to transcribe WhatsApp call recordings. Pick a model that accepts audio (e.g. a Gemini model)."
          className="mt-4 max-w-xl"
        >
          <Select.Root size="small" value={transcriptionValue} onValueChange={(value) => setTranscriptionModel(value)} disabled={!selectedPairs.length && !transcriptionValue}>
            <Select.Trigger aria-label="Call transcription model">
              <Select.Value placeholder="Off" />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="">Off</Select.Item>
              {selectedPairs.map((item) => {
                const provider = catalog.find((candidate) => candidate.slug === item.provider);
                const model = provider?.models.find((candidate) => candidate.id === item.modelId);
                return (
                  <Select.Item key={pairKey(item.provider, item.modelId)} value={pairKey(item.provider, item.modelId)}>
                    {provider?.name ?? item.provider} · {model?.name ?? item.modelId}
                  </Select.Item>
                );
              })}
            </Select.Content>
          </Select.Root>
        </Field>
      </StepFrame>

      <StepFrame
        step={4}
        done={stepsDone[3]}
        title="Shared capacity"
        description={`${BRAND.shortName} only sends requests on your own provider keys.`}
      >
        <label className={cn("flex cursor-pointer items-start gap-3 rounded-xl p-3.5 ring-1 ring-inset transition", settings.byokOnlyConfirmed ? "ring-stroke-soft-200" : "bg-warning-lighter ring-warning-light")}>
          <Checkbox.Root className="mt-0.5" checked={settings.byokOnlyConfirmed} onCheckedChange={(checked) => updateSettings({ byokOnlyConfirmed: checked === true })} />
          <span className="min-w-0">
            <span className="block text-label-sm text-text-strong-950">Never use shared capacity</span>
            <span className="mt-1 block text-paragraph-xs text-text-sub-600">
              In every enabled provider&apos;s OpenRouter BYOK settings, set Shared capacity fallback to <strong className="font-medium text-text-strong-950">Never use shared capacity on this provider</strong>. OpenRouter does not expose this setting through its public API, so this confirmation is required before {BRAND.shortName} will send requests.
            </span>
            <a href={BYOK_URL} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} className={cn(linkClass, "mt-2")}>
              Review OpenRouter BYOK settings<RiExternalLinkLine className="size-3.5" aria-hidden="true" />
            </a>
          </span>
        </label>
      </StepFrame>

      <div className="sticky bottom-0 z-10 -mx-4 -mb-5 flex flex-wrap items-center justify-between gap-3 border-t border-stroke-soft-200 bg-bg-white-0/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:-mb-6 sm:px-6 lg:-mx-8 lg:-mb-7 lg:px-8">
        <p className="text-paragraph-xs text-text-sub-600">
          {selectedConnection ? (
            <>
              Using <span className="text-text-strong-950">{selectedConnection.name}</span> · {stepsDone.filter(Boolean).length} of 4 steps done
            </>
          ) : (
            "Connect an OpenRouter account to continue"
          )}
        </p>
        <Button.Root type="button" variant="primary" mode="filled" size="small" onClick={() => void save()} disabled={saving || !settings.connectionId || !settings.byokOnlyConfirmed}>
          {saving && <Button.Icon as={RiLoader4Line} className="animate-spin" />}
          {saving ? "Saving…" : "Save AI settings"}
        </Button.Root>
      </div>
    </div>
  );
}
