"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  RiAddLine,
  RiArrowLeftLine,
  RiCheckboxBlankLine,
  RiCheckboxLine,
  RiCloseLine,
  RiExternalLinkLine,
  RiFlashlightLine,
  RiLoader4Line,
  RiSearchLine,
} from "@remixicon/react";
import * as Select from "@/components/alignui/select";
import type { GridColumn } from "@/lib/grid/schema";
import type { IntegrationConnection } from "@/lib/grid/providers";
import type { EnrichmentConfig } from "@/lib/grid/types";
import { effectiveColumnType, inputAcceptsColumnType } from "@/lib/grid/value-types";
import { DocsLink } from "@/components/page/DocsLink";
import IntegrationIcon from "./IntegrationIcon";
import {
  ACTION_CATEGORIES,
  INTEGRATIONS,
  getIntegration,
  getIntegrationAction,
} from "@/lib/integrations/catalog";
import type { ActionInputDefinition } from "@/lib/integrations/types";

type Step = "setup" | "outputs";

function ColumnMappingSelect({
  input,
  columns,
  value,
  onChange,
}: {
  input: ActionInputDefinition;
  columns: GridColumn[];
  value: string;
  onChange: (columnKey: string) => void;
}) {
  // The server's rule (a Text "domain" column can feed a URL input).
  const compatible = columns.filter((column) =>
    inputAcceptsColumnType(input.acceptedColumnTypes, effectiveColumnType(column)),
  );
  return (
    <>
      <Select.Root size="small" value={value} onValueChange={onChange}>
        <Select.Trigger aria-label="Table column" className="w-full">
          <Select.Value />
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="">Select a table column</Select.Item>
          {compatible.map((column) => (
            <Select.Item key={column.key} value={column.key}>
              {column.name} · {effectiveColumnType(column)}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
      {!compatible.length && (
        <span className="mt-1 block text-[13px] text-amber-700 dark:text-amber-400">
          No compatible {input.acceptedColumnTypes.join(" or ")} column exists.
        </span>
      )}
    </>
  );
}

export default function EnrichmentDialog({
  open,
  tableId,
  columns,
  firstRowIds,
  column: columnProp,
  afterColumnId,
  beforeColumnId,
  onClose,
  onSaved,
}: {
  open: boolean;
  tableId: string;
  columns: GridColumn[];
  firstRowIds: string[];
  column?: GridColumn;
  afterColumnId?: string;
  beforeColumnId?: string;
  onClose: () => void;
  onSaved: (activeJobs?: number) => void | Promise<void>;
}) {
  // A column created by this dialog: if the run that follows is refused, the
  // dialog stays open on it and the next save updates it instead of adding another.
  const [created, setCreated] = useState<GridColumn | null>(null);
  const column = columnProp ?? created ?? undefined;
  const seededColumnId = useRef<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [search, setSearch] = useState("");
  const [outputSearch, setOutputSearch] = useState("");
  const [integrationKey, setIntegrationKey] = useState(INTEGRATIONS[0]?.key ?? "");
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("setup");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [activeFilterKeys, setActiveFilterKeys] = useState<string[]>([]);
  const [outputs, setOutputs] = useState<Set<string>>(new Set());
  const [connections, setConnections] = useState<IntegrationConnection[]>([]);
  const [connectedIntegrationKeys, setConnectedIntegrationKeys] = useState<Set<string>>(new Set());
  const [connectionsLoading, setConnectionsLoading] = useState(false);
  const [connectionId, setConnectionId] = useState("");
  const [addingAccount, setAddingAccount] = useState(false);
  const [accountName, setAccountName] = useState("");
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({});
  const [autoRun, setAutoRun] = useState(true);
  const [runInBatches, setRunInBatches] = useState(false);
  const [conditionEnabled, setConditionEnabled] = useState(false);
  const [runCondition, setRunCondition] = useState("");
  const [delayEnabled, setDelayEnabled] = useState(false);
  const [delaySeconds, setDelaySeconds] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The portal target only exists after client hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);
  useEffect(() => {
    if (!open) {
      seededColumnId.current = null;
      // Closing the dialog resets its draft before the next open.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSearch("");
      setOutputSearch("");
      setActionKey(null);
      setStep("setup");
      setInputs({});
      setActiveFilterKeys([]);
      setOutputs(new Set());
      setConnections([]);
      setConnectedIntegrationKeys(new Set());
      setConnectionsLoading(false);
      setConnectionId("");
      setAddingAccount(false);
      setAccountName("");
      setCredentialValues({});
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !column || column.type !== "enrichment") return;
    // Seed once per column: a grid refresh hands over a new column object
    // while the form is being edited, and must not reset it.
    if (seededColumnId.current === column.id) return;
    seededColumnId.current = column.id;
    const config = column.config as EnrichmentConfig;
    // Synchronize the editable draft when a saved enrichment is opened.
    setIntegrationKey(config.integrationKey);
    setActionKey(config.actionKey);
    setStep("setup");
    const action = getIntegrationAction(config.integrationKey, config.actionKey);
    setInputs(Object.fromEntries(Object.entries(config.inputs).map(([key, binding]) => [key, binding.columnKey])));
    setActiveFilterKeys(
      action?.inputs
        .filter((input) => input.group === "filter" && !input.hidden && config.inputs[input.key])
        .map((input) => input.key) ?? [],
    );
    const catalogOutputKeys = new Set(action?.outputs.map((output) => output.key) ?? []);
    setOutputs(new Set(Object.keys(config.outputs).filter((key) => catalogOutputKeys.has(key))));
    setConnectionId(config.connectionId);
    setAutoRun(column.autoRun);
    setRunInBatches(Boolean(config.runInBatches));
    setConditionEnabled(Boolean(config.runCondition));
    setRunCondition(config.runCondition ?? "");
    setDelayEnabled(Boolean(config.delaySeconds));
    setDelaySeconds(config.delaySeconds || 30);
  }, [column, open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.all(
      INTEGRATIONS.map(async (candidate) => {
        try {
          const response = await fetch(`/api/grid/integrations/${candidate.key}/connections`);
          if (!response.ok) return null;
          const data = await response.json();
          const available = (data.connections ?? []).some(
            (connection: IntegrationConnection) => connection.enabled && connection.verified,
          );
          return available ? candidate.key : null;
        } catch {
          return null;
        }
      }),
    ).then((keys) => {
      if (!cancelled) setConnectedIntegrationKeys(new Set(keys.filter((key): key is string => Boolean(key))));
    });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open || !integrationKey) return;
    let cancelled = false;
    // Reflect the request started by this dependency change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConnectionsLoading(true);
    void fetch(`/api/grid/integrations/${integrationKey}/connections`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Could not load accounts");
        if (!cancelled) {
          const next = (data.connections ?? []) as IntegrationConnection[];
          setConnections(next);
          if (next.some((item) => item.enabled && item.verified)) {
            setConnectedIntegrationKeys((current) => new Set(current).add(integrationKey));
          } else {
            setConnectedIntegrationKeys((current) => {
              const updated = new Set(current);
              updated.delete(integrationKey);
              return updated;
            });
          }
          setConnectionId((current) =>
            next.some((item) => item.id === current && item.verified)
              ? current
              : next.find((item) => item.verified)?.id || "",
          );
        }
      })
      .catch((cause) => !cancelled && setError(cause instanceof Error ? cause.message : "Could not load accounts"))
      .finally(() => !cancelled && setConnectionsLoading(false));
    return () => { cancelled = true; };
  }, [integrationKey, open]);

  function selectIntegration(key: string) {
    setIntegrationKey(key);
    setAddingAccount(false);
    setAccountName("");
    setCredentialValues({});
    setError(null);
  }

  // The column's own outputs (and the column itself) cannot be its inputs: that would be a cycle.
  const inputColumns = useMemo(() => columns.filter((candidate) =>
    candidate.id !== column?.id
    && !(column
      && candidate.type === "integration_output"
      && (candidate.config as { sourceColumnKey?: string }).sourceColumnKey === column.key)
  ), [columns, column]);

  const integration = getIntegration(integrationKey);
  const action = actionKey ? getIntegrationAction(integrationKey, actionKey) : null;
  const categoryName = action
    ? ACTION_CATEGORIES.find((category) => category.key === action.category)?.name
    : null;

  const filteredActions = useMemo(() => {
    if (!integration) return [];
    const query = search.trim().toLowerCase();
    if (!query) return integration.actions;
    return integration.actions.filter((candidate) =>
      [candidate.name, candidate.description, candidate.category, ...candidate.tags]
        .join(" ").toLowerCase().includes(query),
    );
  }, [integration, search]);

  const filteredOutputs = useMemo(() => {
    if (!action) return [];
    const query = outputSearch.trim().toLowerCase();
    return query
      ? action.outputs.filter((output) => `${output.name} ${output.key} ${output.columnType}`.toLowerCase().includes(query))
      : action.outputs;
  }, [action, outputSearch]);

  function chooseAction(nextActionKey: string) {
    if (connectionsLoading) return;
    if (!connectedIntegrationKeys.has(integrationKey)) {
      setAddingAccount(true);
      return;
    }
    setActionKey(nextActionKey);
    setStep("setup");
    setInputs({});
    setActiveFilterKeys([]);
    setOutputs(new Set());
    setError(null);
  }

  async function addAccount() {
    if (!integration) return;
    const missing = integration.auth.fields.find(
      (field) => field.required && !credentialValues[field.key]?.trim(),
    );
    if (missing) return setError(`Enter ${missing.label}.`);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/grid/integrations/${integration.key}/connections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: accountName, credentials: credentialValues }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error ?? "Could not add account");
        return;
      }
      setConnections((current) => [...current, data.connection]);
      setConnectedIntegrationKeys((current) => new Set(current).add(integration.key));
      setConnectionId(data.connection.id);
      setAddingAccount(false);
      setAccountName("");
      setCredentialValues({});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add account");
    } finally {
      setBusy(false);
    }
  }

  function continueToOutputs() {
    if (!action) return;
    if (!connectionId) return setError(`Connect a ${integration?.name ?? "provider"} account first.`);
    const missing = action.inputs.find((input) => input.required && !inputs[input.key]);
    if (missing) return setError(`Select a compatible column for ${missing.name}.`);
    if (action.filterBuilder) {
      const mappedFilters = action.inputs.filter(
        (input) => input.group === "filter" && inputs[input.key],
      ).length;
      if (mappedFilters < action.filterBuilder.minFilters) {
        return setError(
          `Add and map at least ${action.filterBuilder.minFilters} search filter${action.filterBuilder.minFilters === 1 ? "" : "s"}.`,
        );
      }
    }
    setError(null);
    setStep("outputs");
  }

  function setInputColumn(inputKey: string, columnKey: string) {
    setError(null);
    setInputs((current) => {
      if (columnKey) return { ...current, [inputKey]: columnKey };
      const next = { ...current };
      delete next[inputKey];
      return next;
    });
  }

  function addFilter(inputKey: string) {
    if (!inputKey) return;
    setActiveFilterKeys((current) => current.includes(inputKey) ? current : [...current, inputKey]);
  }

  function replaceFilter(currentKey: string, nextKey: string) {
    if (!nextKey || currentKey === nextKey) return;
    setActiveFilterKeys((current) => current.map((key) => key === currentKey ? nextKey : key));
    setInputs((current) => {
      const next = { ...current };
      delete next[currentKey];
      return next;
    });
  }

  function removeFilter(inputKey: string) {
    setActiveFilterKeys((current) => current.filter((key) => key !== inputKey));
    setInputColumn(inputKey, "");
  }

  async function save(runFirstTen: boolean) {
    if (!action || !connectionId) return;
    if (!outputs.size) return setError("Select at least one output column.");
    // The grid can hand over its coverage row, which is not a real row.
    const runRowIds = firstRowIds.filter((id) => id !== "__coverage").slice(0, 10);
    if (runFirstTen && action.implemented && runRowIds.length === 0) {
      return setError("There are no rows on this page to run. Use Save, then run once rows are loaded.");
    }
    const mappedInputs = Object.fromEntries(
      Object.entries(inputs).filter(([, columnKey]) => Boolean(columnKey)),
    );
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/grid/tables/${tableId}/enrichments`, {
        method: column ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          integrationKey,
          actionKey: action.key,
          columnId: column?.id,
          connectionId,
          inputs: mappedInputs,
          selectedOutputs: [...outputs],
          autoRun,
          runInBatches,
          runCondition: conditionEnabled ? runCondition : undefined,
          delaySeconds: delayEnabled ? delaySeconds : 0,
          afterColumnId,
          beforeColumnId,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return setError(data.error ?? "Could not add enrichment");
      if (!column && Array.isArray(data.columns) && data.columns[0]) {
        // Already seeded from what is on screen; do not re-seed from the saved copy.
        seededColumnId.current = (data.columns[0] as GridColumn).id;
        setCreated(data.columns[0] as GridColumn);
      }

      let activeJobs: number | undefined;
      if (runFirstTen && action.implemented) {
        const runResponse = await fetch(`/api/grid/tables/${tableId}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ columnKey: data.primaryColumnKey, rowIds: runRowIds }),
        });
        const runData = await runResponse.json().catch(() => ({}));
        if (!runResponse.ok) {
          // The columns exist now: refresh the grid and keep the dialog open on them.
          await onSaved();
          return setError(runData.error ?? "Columns saved, but the run could not start");
        }
        activeJobs = runData.activeJobs;
      }

      setError(null);
      await onSaved(activeJobs);
      onClose();
    } catch {
      setError("Could not save this enrichment");
    } finally {
      setBusy(false);
    }
  }

  if (!open || !mounted) return null;

  const mappedFilterCount = action?.inputs.filter(
    (input) => input.group === "filter" && inputs[input.key],
  ).length ?? 0;
  const missingInputs = !action
    || action.inputs.some((input) => input.required && !inputs[input.key])
    || Boolean(action.filterBuilder && mappedFilterCount < action.filterBuilder.minFilters);
  const configuredConnection = connections.find((item) => item.id === connectionId && item.verified);
  const visibleInputs = action?.inputs.filter((input) => !input.hidden) ?? [];
  const filterInputs = visibleInputs.filter((input) => input.group === "filter");
  const advancedInputs = visibleInputs.filter((input) => input.group === "advanced");
  const standardInputs = visibleInputs.filter((input) => !input.group);
  const activeFilterInputs = activeFilterKeys.flatMap((key) => {
    const input = filterInputs.find((candidate) => candidate.key === key);
    return input ? [input] : [];
  });
  const legacyMappedFilterInputs = action?.inputs.filter(
    (input) => input.hidden && input.group === "filter" && inputs[input.key],
  ) ?? [];
  const unusedFilterInputs = filterInputs.filter((input) => !activeFilterKeys.includes(input.key));

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-slate-900/35 backdrop-blur-[1px]" onClick={busy ? undefined : onClose} />
      <div className={`absolute flex overflow-hidden bg-bg-white-0 shadow-2xl ring-1 ring-stroke-soft-200 ${action ? "inset-y-0 right-0 w-full max-w-[600px] flex-col" : "left-1/2 top-1/2 h-[min(760px,90vh)] w-[min(1000px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl"}`}>
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-stroke-soft-200 px-5">
          <div className="flex min-w-0 items-center gap-2">
            {action && <button type="button" onClick={() => step === "outputs" ? setStep("setup") : column ? onClose() : setActionKey(null)} disabled={busy} className="rounded-lg border border-stroke-soft-200 p-2 text-text-sub-600 hover:bg-bg-weak-50"><RiArrowLeftLine className="size-5" /></button>}
            {action && integration && <IntegrationIcon integration={integration} size={32} />}
            <h2 className="truncate text-[18px] font-semibold text-text-strong-950">{action ? action.name : "Add enrichment"}</h2>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="rounded-lg p-1.5 text-text-sub-600 hover:bg-bg-weak-50 disabled:opacity-50"><RiCloseLine className="size-5" /></button>
        </div>

        {!action ? (
          <Catalog
            search={search}
            setSearch={setSearch}
            integrationKey={integrationKey}
            setIntegrationKey={selectIntegration}
            filteredActions={filteredActions}
            chooseAction={chooseAction}
            connectedIntegrationKeys={connectedIntegrationKeys}
            connectionsLoading={connectionsLoading}
            addingAccount={addingAccount}
            onAddingAccountChange={setAddingAccount}
            accountName={accountName}
            onAccountNameChange={(next) => { setAccountName(next); setError(null); }}
            credentialValues={credentialValues}
            onCredentialChange={(key, value) =>
              { setCredentialValues((current) => ({ ...current, [key]: value })); setError(null); }
            }
            busy={busy}
            error={error}
            onAddAccount={addAccount}
          />
        ) : step === "setup" ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto bg-bg-weak-50/50 p-5">
              <section className="mb-4">
                <h3 className="text-[15px] font-semibold text-text-strong-950">Action</h3>
                <div className="mt-2 rounded-xl border border-stroke-soft-200 bg-bg-white-0 p-4">
                  <p className="text-[16px] font-semibold text-text-strong-950">{integration?.name} <span className="mx-1 text-text-soft-400">›</span> {action.name}</p>
                  <p className="mt-1 text-[15px] text-text-sub-600">{action.description}</p>
                  <a href={action.docsUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[14px] font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-400 hover:underline">View documentation <RiExternalLinkLine className="size-3.5" /></a>
                  <p className="mt-2 text-[13px] font-medium text-text-soft-400">{categoryName} · Enrichment</p>
                </div>
              </section>

              <section className="mb-4 overflow-hidden rounded-xl border border-stroke-soft-200 bg-bg-white-0">
                <h3 className="bg-bg-weak-50 px-4 py-3 text-[16px] font-semibold text-text-strong-950">Account</h3>
                <div className="p-4">
                  {connections.length > 0 && (
                    <Select.Root size="small" value={connectionId} onValueChange={(next) => { setConnectionId(next); setError(null); }}>
                      <Select.Trigger aria-label={`${integration?.name ?? "Integration"} account`} className="w-full">
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Content>
                        <Select.Item value="">Select {integration?.name} account</Select.Item>
                        {connections.map((connection) => (
                          <Select.Item key={connection.id} value={connection.id} disabled={!connection.verified}>
                            {connection.name}{connection.verified ? "" : " (verification required)"}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Root>
                  )}
                  {!addingAccount ? (
                    <button type="button" onClick={() => setAddingAccount(true)} className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2.5 text-[15px] font-medium text-white hover:bg-blue-700"><RiAddLine className="size-4" />Add account</button>
                  ) : (
                    <div className="mt-2 rounded-lg border border-blue-200 dark:border-blue-500/30 bg-blue-50/50 dark:bg-blue-500/10 p-3">
                      <input value={accountName} onChange={(event) => { setAccountName(event.target.value); setError(null); }} placeholder={`${integration?.name} account name`} className="mt-2 w-full rounded-lg border border-stroke-soft-200 bg-bg-white-0 px-3 py-2 text-[15px] outline-none focus:border-blue-500" />
                      {integration?.auth.fields.map((field) => (
                        <label key={field.key} className="mt-2 block">
                          <span className="mb-1 block text-[13px] font-medium text-text-sub-600">{field.label}{field.required && <span className="text-red-500"> *</span>}</span>
                          <input type={field.inputType} autoComplete="off" value={credentialValues[field.key] ?? ""} onChange={(event) => { setCredentialValues((current) => ({ ...current, [field.key]: event.target.value })); setError(null); }} placeholder={field.placeholder} className="w-full rounded-lg border border-stroke-soft-200 bg-bg-white-0 px-3 py-2 text-[15px] outline-none focus:border-blue-500" />
                        </label>
                      ))}
                      <p className="mt-2 text-[13px] text-text-sub-600">The key is encrypted before it is stored and is never shown again.</p>
                      <div className="mt-2 flex justify-end gap-2"><button type="button" onClick={() => { setAddingAccount(false); setCredentialValues({}); }} className="px-2 py-1.5 text-[14px] text-text-sub-600">Cancel</button><button type="button" onClick={() => void addAccount()} disabled={busy || integration?.auth.fields.some((field) => field.required && !credentialValues[field.key]?.trim())} className="rounded-md bg-blue-600 px-2.5 py-1.5 text-[14px] font-medium text-white disabled:opacity-50">{busy ? "Verifying…" : "Verify & connect"}</button></div>
                    </div>
                  )}
                </div>
              </section>

              <section className="mb-4 overflow-hidden rounded-xl border border-stroke-soft-200 bg-bg-white-0">
                <h3 className="bg-bg-weak-50 px-4 py-3 text-[16px] font-semibold text-text-strong-950">Column mapping</h3>
                <div className="space-y-4 p-4">
                  {standardInputs.length > 0 && (
                    <div className="space-y-4">
                      <p className="text-[14px] font-semibold uppercase tracking-wide text-text-sub-600">Setup inputs</p>
                      {standardInputs.map((input) => (
                        <label key={input.key} className="block">
                          <span className="mb-1.5 block text-[15px] font-medium text-text-strong-950">
                            {input.name}{input.required && <span className="text-red-500"> *</span>}
                          </span>
                          {input.description && <span className="mb-2 block text-[14px] text-text-sub-600">{input.description}</span>}
                          <ColumnMappingSelect
                            input={input}
                            columns={inputColumns}
                            value={inputs[input.key] ?? ""}
                            onChange={(columnKey) => setInputColumn(input.key, columnKey)}
                          />
                        </label>
                      ))}
                    </div>
                  )}

                  {action.filterBuilder && (
                    <div className="space-y-3">
                      <div>
                        <p className="text-[14px] font-semibold uppercase tracking-wide text-text-sub-600">Search filters</p>
                        <p className="mt-1 text-[14px] leading-5 text-text-sub-600">
                          Add a Cleanlist filter, then choose the table column whose values should be sent for it.
                        </p>
                      </div>

                      {legacyMappedFilterInputs.map((input) => (
                        <div key={input.key} className="rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50/70 dark:bg-amber-500/10 p-3">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <p className="text-[15px] font-medium text-amber-950 dark:text-amber-400">Legacy JSON filters</p>
                              <p className="mt-1 text-[14px] leading-5 text-amber-800 dark:text-amber-400">
                                This saved mapping still works. Add named filters below when you want a guided setup.
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => setInputColumn(input.key, "")}
                              className="rounded-lg p-2 text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-500/15"
                              aria-label="Remove legacy JSON filter mapping"
                            >
                              <RiCloseLine className="size-4" />
                            </button>
                          </div>
                          <div className="mt-3">
                            <ColumnMappingSelect
                              input={input}
                              columns={inputColumns}
                              value={inputs[input.key] ?? ""}
                              onChange={(columnKey) => setInputColumn(input.key, columnKey)}
                            />
                          </div>
                        </div>
                      ))}

                      {activeFilterInputs.map((input) => (
                        <div key={input.key} className="rounded-lg border border-stroke-soft-200 bg-bg-weak-50/60 p-3">
                          <div className="flex items-start gap-2">
                            <label className="min-w-0 flex-1">
                              <span className="mb-1 block text-[13px] font-medium text-text-sub-600">Filter</span>
                              <Select.Root size="small" value={input.key} onValueChange={(next) => replaceFilter(input.key, next)}>
                                <Select.Trigger aria-label="Filter" className="w-full">
                                  <Select.Value />
                                </Select.Trigger>
                                <Select.Content>
                                  <Select.Item value={input.key}>{input.name}</Select.Item>
                                  {unusedFilterInputs.map((candidate) => (
                                    <Select.Item key={candidate.key} value={candidate.key}>{candidate.name}</Select.Item>
                                  ))}
                                </Select.Content>
                              </Select.Root>
                            </label>
                            <button
                              type="button"
                              onClick={() => removeFilter(input.key)}
                              className="mt-5 rounded-lg p-2.5 text-text-sub-600 hover:bg-bg-soft-200 hover:text-text-strong-950"
                              aria-label={`Remove ${input.name} filter`}
                            >
                              <RiCloseLine className="size-4" />
                            </button>
                          </div>
                          {input.description && <p className="mt-2 text-[14px] text-text-sub-600">{input.description}</p>}
                          <label className="mt-3 block">
                            <span className="mb-1 block text-[13px] font-medium text-text-sub-600">Map values from</span>
                            <ColumnMappingSelect
                              input={input}
                              columns={inputColumns}
                              value={inputs[input.key] ?? ""}
                              onChange={(columnKey) => setInputColumn(input.key, columnKey)}
                            />
                          </label>
                        </div>
                      ))}

                      {unusedFilterInputs.length > 0 && (
                        <label className="block">
                          <span className="mb-1 block text-[13px] font-medium text-text-sub-600">Add filter</span>
                          <Select.Root size="small" value="" onValueChange={addFilter}>
                            <Select.Trigger aria-label="Add filter" className="w-full border-dashed border-blue-300 dark:border-blue-500/30 bg-blue-50/40 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400">
                              <Select.Value placeholder="+ Choose a filter" />
                            </Select.Trigger>
                            <Select.Content>
                              {unusedFilterInputs.map((input) => (
                                <Select.Item key={input.key} value={input.key}>{input.name}</Select.Item>
                              ))}
                            </Select.Content>
                          </Select.Root>
                        </label>
                      )}

                      {activeFilterInputs.length === 0 && legacyMappedFilterInputs.length === 0 && (
                        <p className="rounded-lg bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-[14px] text-amber-800 dark:text-amber-400">
                          Add and map at least one filter to continue.
                        </p>
                      )}
                    </div>
                  )}

                  {advancedInputs.length > 0 && (
                    <details className="rounded-lg border border-stroke-soft-200">
                      <summary className="cursor-pointer px-3 py-2.5 text-[15px] font-medium text-text-strong-950">
                        Advanced settings
                      </summary>
                      <div className="space-y-4 border-t border-stroke-soft-200 p-3">
                        {advancedInputs.map((input) => (
                          <label key={input.key} className="block">
                            <span className="mb-1.5 block text-[15px] font-medium text-text-strong-950">
                              {input.name}{input.required && <span className="text-red-500"> *</span>}
                            </span>
                            {input.description && <span className="mb-2 block text-[14px] text-text-sub-600">{input.description}</span>}
                            <ColumnMappingSelect
                              input={input}
                              columns={inputColumns}
                              value={inputs[input.key] ?? ""}
                              onChange={(columnKey) => setInputColumn(input.key, columnKey)}
                            />
                          </label>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              </section>

              <section className="overflow-hidden rounded-xl border border-stroke-soft-200 bg-bg-white-0">
                <h3 className="bg-bg-weak-50 px-4 py-3 text-[16px] font-semibold text-text-strong-950">Run settings</h3>
                <div className="space-y-4 p-4 text-[15px]">
                  <Toggle label="Auto-run" checked={autoRun} onChange={setAutoRun} />
                  <Toggle label="Run in batches" checked={runInBatches} onChange={setRunInBatches} disabled />
                  <label className="flex items-start gap-2"><input type="checkbox" checked={conditionEnabled} onChange={(event) => setConditionEnabled(event.target.checked)} className="mt-0.5 size-4" /><span><span className="font-medium text-text-strong-950">Add run condition</span><span className="block text-[14px] text-text-sub-600">Only run if this expression resolves to true.</span></span></label>
                  {conditionEnabled && <input value={runCondition} onChange={(event) => setRunCondition(event.target.value)} placeholder="Example: {{email}} != ''" className="w-full rounded-lg border border-stroke-soft-200 px-3 py-2 text-[15px] outline-none focus:border-blue-500" />}
                  <div><p className="font-medium text-text-strong-950">Delay run</p><label className="mt-2 flex items-center gap-2"><input type="radio" checked={!delayEnabled} onChange={() => setDelayEnabled(false)} />Run immediately</label><label className="mt-2 flex items-center gap-2"><input type="radio" checked={delayEnabled} onChange={() => setDelayEnabled(true)} />Run after delay</label>{delayEnabled && <label className="mt-2 flex items-center gap-2 pl-5"><input type="number" min={1} max={600} value={delaySeconds} onChange={(event) => setDelaySeconds(Math.max(1, Math.min(600, Number(event.target.value) || 1)))} className="w-20 rounded-lg border border-stroke-soft-200 px-2 py-1.5" />seconds</label>}</div>
                </div>
              </section>
            </div>
            {error && <p role="alert" className="mx-5 mb-3 mt-3 shrink-0 rounded-lg bg-red-50 dark:bg-red-500/10 px-3 py-2 text-[15px] text-red-700 dark:text-red-400">{error}</p>}
            <div className="flex shrink-0 items-center justify-between border-t border-stroke-soft-200 bg-bg-white-0 px-5 py-4"><span className="text-[14px] text-text-sub-600">{configuredConnection ? "Account connected" : "API key required"}</span><button type="button" onClick={continueToOutputs} disabled={busy || missingInputs || !configuredConnection} className="rounded-lg bg-blue-600 px-4 py-2.5 text-[15px] font-semibold text-white disabled:bg-blue-300">Continue to add fields</button></div>
          </>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <div className="flex items-start justify-between gap-3"><div><h3 className="text-[18px] font-semibold text-text-strong-950">Add data as columns to your table</h3><p className="mt-2 text-[15px] leading-5 text-text-sub-600">Select the data points you want added as columns. The integration runs once per row.</p></div><span className="shrink-0 text-[15px] text-text-sub-600">{outputs.size} selected</span></div>
              <label className="mt-5 flex items-center gap-2 rounded-lg border border-stroke-soft-200 px-3 py-2.5"><RiSearchLine className="size-4 text-text-soft-400" /><input value={outputSearch} onChange={(event) => setOutputSearch(event.target.value)} placeholder="Search data columns" className="min-w-0 flex-1 text-[15px] outline-none" /></label>
              <div className="mt-4 space-y-2">{filteredOutputs.map((output) => { const selected = outputs.has(output.key); const alreadyAdded = column ? Object.prototype.hasOwnProperty.call((column.config as EnrichmentConfig).outputs, output.key) : false; return <button key={output.key} type="button" disabled={alreadyAdded} onClick={() => { setError(null); setOutputs((current) => { const next = new Set(current); if (selected) next.delete(output.key); else next.add(output.key); return next; }); }} className="flex w-full items-center gap-3 rounded-lg bg-bg-weak-50 px-3 py-3 text-left hover:bg-bg-weak-50 disabled:cursor-default">{selected ? <RiCheckboxLine className="size-5 text-blue-600 dark:text-blue-400" /> : <RiCheckboxBlankLine className="size-5 text-text-soft-400" />}<span className="min-w-0 flex-1"><span className="font-medium text-text-strong-950">{output.name}</span>{output.example && <span className="ml-2 text-text-sub-600">{output.example}</span>}<span className="block text-[13px] text-text-soft-400">{output.columnType}{alreadyAdded ? " · already added" : ""}</span></span></button>; })}</div>
            </div>
            {error && <p role="alert" className="mx-5 mb-3 mt-3 shrink-0 rounded-lg bg-red-50 dark:bg-red-500/10 px-3 py-2 text-[15px] text-red-700 dark:text-red-400">{error}</p>}
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-stroke-soft-200 bg-bg-white-0 px-5 py-4"><button type="button" onClick={() => void save(false)} disabled={busy || !outputs.size} className="rounded-lg border border-stroke-soft-200 px-3 py-2.5 text-[15px] font-semibold text-text-strong-950 hover:bg-bg-weak-50 disabled:opacity-50">{column ? "Save changes" : "Save without running"}</button><button type="button" title={action.implemented ? undefined : "The live Apollo handler is not implemented yet"} onClick={() => void save(true)} disabled={busy || !outputs.size || !action.implemented} className="flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2.5 text-[15px] font-semibold text-white disabled:bg-blue-300">{busy && <RiLoader4Line className="size-4 animate-spin" />}Save &amp; run 10 rows</button></div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function Catalog({
  search,
  setSearch,
  integrationKey,
  setIntegrationKey,
  filteredActions,
  chooseAction,
  connectedIntegrationKeys,
  connectionsLoading,
  addingAccount,
  onAddingAccountChange,
  accountName,
  onAccountNameChange,
  credentialValues,
  onCredentialChange,
  busy,
  error,
  onAddAccount,
}: {
  search: string;
  setSearch: (value: string) => void;
  integrationKey: string;
  setIntegrationKey: (value: string) => void;
  filteredActions: NonNullable<ReturnType<typeof getIntegration>>["actions"];
  chooseAction: (key: string) => void;
  connectedIntegrationKeys: ReadonlySet<string>;
  connectionsLoading: boolean;
  addingAccount: boolean;
  onAddingAccountChange: (value: boolean) => void;
  accountName: string;
  onAccountNameChange: (value: string) => void;
  credentialValues: Record<string, string>;
  onCredentialChange: (key: string, value: string) => void;
  busy: boolean;
  error: string | null;
  onAddAccount: () => Promise<void>;
}) {
  const integration = getIntegration(integrationKey);
  const connected = connectedIntegrationKeys.has(integrationKey);
  return (
    <>
      <label className="flex h-[58px] shrink-0 items-center gap-3 border-b border-stroke-soft-200 px-6">
        <RiSearchLine className="size-5 text-text-soft-400" />
        <input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search providers and enrichments…" className="min-w-0 flex-1 text-[15px] outline-none placeholder:text-text-soft-400" />
      </label>
      <div className="flex h-[54px] shrink-0 items-end gap-6 border-b border-stroke-soft-200 px-6">
        <span className="border-b-2 border-blue-600 px-1 pb-3 text-[16px] font-semibold text-blue-600 dark:text-blue-400">Integrations</span>
        <span className="px-1 pb-3 text-[16px] text-text-disabled-300">Discover</span>
        <span className="px-1 pb-3 text-[16px] text-text-disabled-300">Templates</span>
        <span className="px-1 pb-3 text-[16px] text-text-disabled-300">Functions</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="w-64 shrink-0 overflow-y-auto border-r border-stroke-soft-200 p-3">
          {INTEGRATIONS.map((candidate) => {
            const candidateConnected = connectedIntegrationKeys.has(candidate.key);
            return (
              <button key={candidate.key} type="button" onClick={() => setIntegrationKey(candidate.key)} className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[16px] font-medium ${candidate.key === integrationKey ? "bg-bg-weak-50" : "hover:bg-bg-weak-50"}`}>
                <span className={candidateConnected ? "" : "grayscale opacity-50"}><IntegrationIcon integration={candidate} size={28} /></span>
                <span className={candidateConnected ? "text-text-strong-950" : "text-text-sub-600"}>{candidate.name}</span>
                <span className={`ml-auto size-2 rounded-full ${candidateConnected ? "bg-emerald-500" : "bg-bg-sub-300"}`} />
              </button>
            );
          })}
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="flex items-start justify-between gap-4 border-b border-stroke-soft-200 px-6 py-4">
            <div><h3 className="text-[16px] font-semibold">{integration?.name}</h3><p className="mt-1 text-[15px] text-text-sub-600">{integration?.description}</p></div>
            {connectionsLoading ? (
              <span className="shrink-0 rounded-full bg-bg-weak-50 px-2 py-1 text-[13px] font-medium text-text-sub-600">Checking connection…</span>
            ) : connected ? (
              <span className="shrink-0 rounded-full bg-emerald-50 dark:bg-emerald-500/10 px-2 py-1 text-[13px] font-medium text-emerald-700 dark:text-emerald-400">Connected</span>
            ) : (
              <button type="button" onClick={() => onAddingAccountChange(true)} className="shrink-0 rounded-lg bg-blue-600 px-3 py-2 text-[14px] font-semibold text-white hover:bg-blue-700"><RiAddLine className="mr-1 inline size-4" />Add integration</button>
            )}
          </div>
          {!connectionsLoading && !connected && (
            <div className="border-b border-stroke-soft-200 bg-blue-50/40 dark:bg-blue-500/10 px-6 py-4">
              {!addingAccount ? (
                <div>
                  <p className="text-[15px] font-semibold text-text-strong-950">Connect {integration?.name} to use its actions</p>
                  <p className="mt-1 text-[14px] text-text-sub-600">
                    Your credentials will be verified before the integration is enabled.{" "}
                    <DocsLink page="integrations/enrichment-providers#connect-a-provider-account" appearance="inline" className="ml-1 text-[14px]" />
                  </p>
                </div>
              ) : (
                <div className="rounded-xl border border-blue-200 dark:border-blue-500/30 bg-bg-white-0 p-4">
                  <h4 className="text-[16px] font-semibold text-text-strong-950">Add {integration?.name} account</h4>
                  <label className="mt-3 block">
                    <span className="mb-1 block text-[14px] font-medium text-text-strong-950">Account name</span>
                    <input value={accountName} onChange={(event) => onAccountNameChange(event.target.value)} placeholder={`${integration?.name ?? "Integration"} account`} className="w-full rounded-lg border border-stroke-soft-200 px-3 py-2 text-[15px] outline-none focus:border-blue-500" />
                  </label>
                  {integration?.auth.fields.map((field) => (
                    <label key={field.key} className="mt-3 block">
                      <span className="mb-1 block text-[14px] font-medium text-text-strong-950">{field.label}{field.required && <span className="text-red-500"> *</span>}</span>
                      <input type={field.inputType} autoComplete="off" value={credentialValues[field.key] ?? ""} onChange={(event) => onCredentialChange(field.key, event.target.value)} placeholder={field.placeholder} className="w-full rounded-lg border border-stroke-soft-200 px-3 py-2 text-[15px] outline-none focus:border-blue-500" />
                    </label>
                  ))}
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <p className="text-[13px] text-text-sub-600">Credentials are encrypted and never shown again.</p>
                    {integration?.auth.helpUrl && <a href={integration.auth.helpUrl} target="_blank" rel="noreferrer" className="shrink-0 text-[13px] font-medium text-blue-600 dark:text-blue-400 hover:underline">Find your API key <RiExternalLinkLine className="inline size-3" /></a>}
                  </div>
                  {error && <p className="mt-3 rounded-lg bg-red-50 dark:bg-red-500/10 px-3 py-2 text-[14px] text-red-700 dark:text-red-400">{error}</p>}
                  <div className="mt-4 flex justify-end gap-2">
                    <button type="button" disabled={busy} onClick={() => onAddingAccountChange(false)} className="rounded-lg px-3 py-2 text-[14px] font-medium text-text-sub-600 hover:bg-bg-weak-50 disabled:opacity-50">Cancel</button>
                    <button type="button" disabled={busy || integration?.auth.fields.some((field) => field.required && !credentialValues[field.key]?.trim())} onClick={() => void onAddAccount()} className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-[14px] font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300">{busy && <RiLoader4Line className="size-3.5 animate-spin" />}{busy ? "Verifying…" : "Verify & connect"}</button>
                  </div>
                </div>
              )}
            </div>
          )}
          {filteredActions.map((candidate) => (
            <div key={candidate.key} className={`flex items-start border-b border-stroke-soft-200 ${connected ? "hover:bg-bg-weak-50" : "bg-bg-weak-50/50 text-text-soft-400"}`}>
              <button type="button" disabled={!connected || connectionsLoading} aria-disabled={!connected || connectionsLoading} onClick={() => chooseAction(candidate.key)} className="flex min-w-0 flex-1 items-start gap-3 px-6 py-4 text-left disabled:cursor-not-allowed">
                {integration && <span className={connected ? "" : "grayscale opacity-50"}><IntegrationIcon integration={integration} size={28} /></span>}
                <span>
                  <span className={`block text-[16px] font-semibold ${connected ? "text-text-strong-950" : "text-text-sub-600"}`}>{candidate.name}</span>
                  <span className={`mt-1 block text-[15px] ${connected ? "text-text-sub-600" : "text-text-soft-400"}`}>{candidate.description}</span>
                  <span className={`mt-1.5 block text-[14px] ${connected ? "text-text-sub-600" : "text-text-soft-400"}`}><RiFlashlightLine className="mr-1 inline size-3.5" />Enrichment · {integration?.name}</span>
                </span>
              </button>
              <a href={candidate.docsUrl} target="_blank" rel="noreferrer" aria-label={`Open documentation for ${candidate.name}`} title="View documentation" className="m-4 rounded-md p-2 text-text-soft-400 hover:bg-bg-white-0 hover:text-blue-600 dark:hover:text-blue-400"><RiExternalLinkLine className="size-4" /></a>
            </div>
          ))}
        </main>
      </div>
    </>
  );
}

function Toggle({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return <div className="flex items-center justify-between"><span><span className="font-medium text-text-strong-950">{label}</span>{disabled && <span className="ml-2 text-[13px] text-text-soft-400">Coming later</span>}</span><button type="button" disabled={disabled} aria-pressed={checked} onClick={() => onChange(!checked)} className={`relative h-6 w-11 rounded-full transition ${checked ? "bg-blue-600" : "bg-bg-sub-300"} disabled:opacity-50`}><span className={`absolute top-1 size-4 rounded-full bg-static-white transition ${checked ? "left-6" : "left-1"}`} /></button></div>;
}
