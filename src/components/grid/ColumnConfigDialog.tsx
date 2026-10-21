"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { RiAddLine, RiCloseLine, RiLoader4Line, RiMagicLine } from "@remixicon/react";
import * as Select from "@/components/alignui/select";
import type { GridColumn } from "@/lib/grid/schema";
import type { ColumnConfig, ColumnType, FormulaConfig, HttpConfig } from "@/lib/grid/types";

type HeaderPair = { key: string; value: string };
type PreviewState =
  | { state: "idle" | "loading" }
  | { state: "success"; value: unknown; rowNumber: number }
  | { state: "error"; error: string };

export default function ColumnConfigDialog({
  open,
  tableId,
  type,
  column: columnProp,
  columns,
  previewRowId,
  afterColumnId,
  beforeColumnId,
  onClose,
  onSaved,
}: {
  open: boolean;
  tableId: string;
  type: Extract<ColumnType, "formula" | "http">;
  column?: GridColumn | null;
  columns: GridColumn[];
  previewRowId?: string;
  afterColumnId?: string;
  beforeColumnId?: string;
  onClose: () => void;
  onSaved: (activeJobs?: number) => void | Promise<void>;
}) {
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);
  // A column created by this dialog: if the run that follows is refused, the
  // dialog stays open on it and the next save updates it instead of adding another.
  const [created, setCreated] = useState<GridColumn | null>(null);
  const column = columnProp ?? created;
  const initialFormula = (column?.config ?? {}) as FormulaConfig;
  const initialHttp = (column?.config ?? {}) as HttpConfig;
  const [name, setName] = useState(column?.name ?? (type === "formula" ? "Formula" : "HTTP API"));
  const [expression, setExpression] = useState(initialFormula.expression ?? "");
  const [method, setMethod] = useState<HttpConfig["method"]>(initialHttp.method ?? "GET");
  const [url, setUrl] = useState(initialHttp.url ?? "");
  const [headers, setHeaders] = useState<HeaderPair[]>(
    Object.entries(initialHttp.headers ?? {}).map(([key, value]) => ({ key, value })),
  );
  const [body, setBody] = useState(initialHttp.body ?? "");
  const [responsePath, setResponsePath] = useState(initialHttp.responsePath ?? "");
  const [authEnvVar, setAuthEnvVar] = useState(initialHttp.authEnvVar ?? "");
  const [providerKey, setProviderKey] = useState(initialHttp.providerKey ?? "");
  const [costCents, setCostCents] = useState(
    initialHttp.costCents === undefined ? "" : String(initialHttp.costCents),
  );
  const [autoRun, setAutoRun] = useState(column?.autoRun ?? true);
  const [slashAt, setSlashAt] = useState<number | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [busyRun, setBusyRun] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [suggestion, setSuggestion] = useState<{ formula: string; explanation: string } | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const formulaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open || type !== "formula" || !expression.trim() || !previewRowId) {
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setPreview({ state: "loading" });
      try {
        const res = await fetch(`/api/grid/tables/${tableId}/formula-preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expression, rowId: previewRowId }),
          signal: controller.signal,
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          setPreview({ state: "error", error: data.error ?? "Preview failed" });
          return;
        }
        setPreview({ state: "success", value: data.value, rowNumber: data.rowNumber ?? 1 });
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setPreview({ state: "error", error: "Preview failed" });
        }
      }
    }, 350);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [expression, open, previewRowId, tableId, type]);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && slashAt === null && !busy) onClose();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [busy, onClose, open, slashAt]);

  if (!open || !mounted) return null;

  // The live preview already ran this exact expression: a parse failure there
  // would only be refused by the server on save, so say so up front. Runtime
  // errors on one row (a missing value, a bad LOOKUP) are not blocked — they
  // may be fine on other rows.
  const formulaSyntaxError =
    type === "formula" && preview.state === "error" && /syntax|unexpected|unterminated|unmatched|invalid or unexpected/i.test(preview.error)
      ? preview.error
      : null;

  const referenceColumns = columns.filter((candidate) => candidate.id !== column?.id);

  const insertColumn = (key: string) => {
    const input = formulaRef.current;
    const start = slashAt ?? input?.selectionStart ?? expression.length;
    const end = input?.selectionEnd ?? start;
    const token = `{{${key}}}`;
    setExpression(`${expression.slice(0, start)}${token}${expression.slice(end)}`);
    setSlashAt(null);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const generateWithAi = async () => {
    if (!aiPrompt.trim()) return;
    setGenerating(true);
    setGenerationError(null);
    try {
      const response = await fetch(`/api/grid/tables/${tableId}/formula-generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: aiPrompt.trim(), currentExpression: expression.trim() || undefined }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Could not generate formula");
      setSuggestion({ formula: data.formula, explanation: data.explanation });
      setExpression(data.formula);
      setPreview({ state: "idle" });
      requestAnimationFrame(() => formulaRef.current?.focus());
    } catch (cause) {
      setGenerationError(cause instanceof Error ? cause.message : "Could not generate formula");
    } finally {
      setGenerating(false);
    }
  };

  const save = async (runAfterSave = false) => {
    if (!name.trim()) {
      setError("Column name is required");
      return;
    }

    let config: ColumnConfig;
    if (type === "formula") {
      if (!expression.trim()) {
        setError("Formula is required");
        return;
      }
      if (formulaSyntaxError) {
        setError(`Fix the formula first: ${formulaSyntaxError}`);
        return;
      }
      config = { expression: expression.trim() } satisfies FormulaConfig;
    } else {
      if (!url.trim()) {
        setError("URL is required");
        return;
      }
      const parsedCost = costCents.trim() === "" ? undefined : Number(costCents);
      if (parsedCost !== undefined && (!Number.isFinite(parsedCost) || parsedCost < 0)) {
        setError("Cost must be zero or a positive number");
        return;
      }
      config = {
        method,
        url: url.trim(),
        headers: Object.fromEntries(
          headers.filter((header) => header.key.trim()).map((header) => [header.key.trim(), header.value]),
        ),
        body: method === "GET" ? undefined : body || undefined,
        responsePath: responsePath.trim() || undefined,
        authEnvVar: authEnvVar.trim() || undefined,
        providerKey: providerKey.trim() || undefined,
        costCents: parsedCost,
      } satisfies HttpConfig;
    }

    setBusy(true);
    setBusyRun(runAfterSave);
    setError(null);
    try {
      const endpoint = column
        ? `/api/grid/tables/${tableId}/columns/${column.id}`
        : `/api/grid/tables/${tableId}/columns`;
      const res = await fetch(endpoint, {
        method: column ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          type,
          config,
          autoRun,
          ...(!column && afterColumnId ? { afterColumnId } : {}),
          ...(!column && beforeColumnId ? { beforeColumnId } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not save column");
        return;
      }
      if (!column && data.column) setCreated(data.column as GridColumn);
      let activeJobs: number | undefined;
      if (runAfterSave) {
        const runRes = await fetch(`/api/grid/tables/${tableId}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ columnKey: data.column.key }),
        });
        const runData = await runRes.json().catch(() => ({}));
        if (!runRes.ok) {
          // The column is saved: refresh the grid, but keep the dialog open to show why the run failed.
          await onSaved();
          setError(runData.error ?? "Saved, but the run could not start");
          return;
        }
        activeJobs = runData.activeJobs;
      }
      setError(null);
      await onSaved(activeJobs);
      onClose();
    } catch {
      setError("Could not save column");
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-slate-900/25" onClick={busy ? undefined : onClose} />
      <div className="relative z-10 flex h-full w-full max-w-xl flex-col bg-bg-white-0 shadow-2xl ring-1 ring-stroke-soft-200">
        <div className="flex items-start justify-between border-b border-stroke-soft-200 px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold text-text-strong-950">
              {column ? "Configure" : "Add"} {type === "formula" ? "formula" : "HTTP API"} column
            </h2>
            <p className="mt-0.5 text-[15px] text-text-sub-600">
              {type === "formula"
                ? <>Type <span className="font-mono">/</span> to insert another column.</>
                : <>Reference row values with tokens such as <span className="font-mono">{"{{email}}"}</span>.</>}
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md p-1 text-text-soft-400 hover:bg-bg-weak-50">
            <RiCloseLine className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <Field label="Column name">
            <input autoFocus value={name} onChange={(event) => { setName(event.target.value); setError(null); }} className={inputClass} />
          </Field>

          {type === "formula" ? (
            <>
              <div className="rounded-xl border border-violet-200 dark:border-violet-500/30 bg-violet-50/60 dark:bg-violet-500/10 p-3">
                <div className="flex items-center gap-2 text-[15px] font-semibold text-violet-900 dark:text-violet-400"><RiMagicLine className="size-4" />Generate formula with AI</div>
                <p className="mt-1 text-[14px] text-violet-700 dark:text-violet-400">Describe the result you want. AI can use this workbook’s columns and cross-table LOOKUP.</p>
                <textarea value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} rows={3} maxLength={2000} placeholder='Example: Find the industry from the Companies table by matching this row’s company domain' className={`${inputClass} mt-3 resize-y`} />
                <div className="mt-2 flex items-center justify-between gap-3">
                  <p className={`text-[14px] ${generationError ? "text-red-600 dark:text-red-400" : "text-violet-700 dark:text-violet-400"}`} role={generationError ? "alert" : undefined}>
                    {generationError ?? (suggestion ? "Formula generated and inserted below." : "")}
                  </p>
                  <button type="button" disabled={generating || !aiPrompt.trim()} onClick={() => void generateWithAi()} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-[14px] font-semibold text-white hover:bg-violet-700 disabled:opacity-50">{generating ? <RiLoader4Line className="size-4 animate-spin" /> : <RiMagicLine className="size-4" />}{generating ? "Generating…" : "Generate"}</button>
                </div>
                {suggestion && <p className="mt-2 text-[14px] text-text-sub-600">{suggestion.explanation}</p>}
              </div>
              <Field label="Formula" hint={'JavaScript, FormulaJS, lodash (_), moment, and LOOKUP("Table", {{value}}, "Match column", "Return column") are available.'}>
                <div className="relative">
                <textarea
                  ref={formulaRef}
                  value={expression}
                  rows={7}
                  spellCheck={false}
                  placeholder={'e.g. CONCATENATE({{firstName}}, " ", {{lastName}})'}
                  onChange={(event) => {
                    setExpression(event.target.value);
                    setError(null);
                    setPreview({ state: "idle" });
                    const cursor = event.target.selectionStart;
                    setSlashAt(event.target.value[cursor - 1] === "/" ? cursor - 1 : null);
                  }}
                  className={`${inputClass} resize-y font-mono leading-5`}
                />
                {slashAt !== null && (
                  <ColumnPicker columns={referenceColumns} onPick={insertColumn} onClose={() => setSlashAt(null)} />
                )}
                </div>
              </Field>
            </>
          ) : (
            <>
              <div className="grid grid-cols-[112px_1fr] gap-2">
                <Field label="Method">
                  <Select.Root size="small" value={method} onValueChange={(next) => { setMethod(next as HttpConfig["method"]); setError(null); }}>
                    <Select.Trigger aria-label="Method" className="w-full">
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Content>
                      {(["GET", "POST", "PUT", "PATCH"] as const).map((item) => (
                        <Select.Item key={item} value={item}>{item}</Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                </Field>
                <Field label="URL">
                  <input value={url} onChange={(event) => { setUrl(event.target.value); setError(null); }} placeholder="https://api.example.com/people/{{email}}" className={inputClass} />
                </Field>
              </div>

              <Field label="Headers" hint="Secrets should use the environment-variable field below, never a literal value here.">
                <div className="space-y-2">
                  {headers.map((header, index) => (
                    <div key={index} className="grid grid-cols-[1fr_1.5fr_32px] gap-2">
                      <input value={header.key} placeholder="Header name" onChange={(event) => setHeaders((all) => all.map((item, i) => i === index ? { ...item, key: event.target.value } : item))} className={inputClass} />
                      <input value={header.value} onChange={(event) => setHeaders((all) => all.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} placeholder="Value or {{columnKey}}" className={inputClass} />
                      <button type="button" aria-label="Remove header" onClick={() => setHeaders((all) => all.filter((_, i) => i !== index))} className="rounded-lg border border-stroke-soft-200 text-text-soft-400 hover:bg-bg-weak-50"><RiCloseLine className="mx-auto size-4" /></button>
                    </div>
                  ))}
                  <button type="button" onClick={() => setHeaders((all) => [...all, { key: "", value: "" }])} className="flex items-center gap-1 text-[15px] font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-400"><RiAddLine className="size-4" /> Add header</button>
                </div>
              </Field>

              {method !== "GET" && <Field label="Request body"><textarea value={body} onChange={(event) => { setBody(event.target.value); setError(null); }} rows={6} spellCheck={false} placeholder={'{"email":"{{email}}"}'} className={`${inputClass} resize-y font-mono`} /></Field>}
              <Field label="Response path" hint="Optional dot path, for example data.person.email."><input value={responsePath} onChange={(event) => { setResponsePath(event.target.value); setError(null); }} placeholder="data.result" className={inputClass} /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Credential env var" hint="Must start with GRID_HTTP_SECRET_. Only the name is stored."><input value={authEnvVar} onChange={(event) => { setAuthEnvVar(event.target.value); setError(null); }} placeholder="GRID_HTTP_SECRET_ACME" className={inputClass} /></Field>
                <Field label="Provider key"><input value={providerKey} onChange={(event) => { setProviderKey(event.target.value); setError(null); }} placeholder="apollo" className={inputClass} /></Field>
              </div>
              <Field label="Cost per call (cents)"><input type="number" min="0" step="0.000001" value={costCents} onChange={(event) => { setCostCents(event.target.value); setError(null); }} placeholder="0" className={inputClass} /></Field>
            </>
          )}

          {type === "formula" && (
            <div className="rounded-xl border border-stroke-soft-200 bg-bg-weak-50 p-3">
              <div className="mb-1 text-[14px] font-semibold uppercase tracking-wide text-text-sub-600">Live preview</div>
              {!previewRowId ? <p className="text-[15px] text-text-sub-600">Add a row to preview this formula.</p> : preview.state === "loading" ? <p className="flex items-center gap-2 text-[15px] text-text-sub-600"><RiLoader4Line className="size-4 animate-spin" /> Evaluating row 1…</p> : preview.state === "error" ? <p className="break-words text-[15px] text-red-600 dark:text-red-400">{preview.error}</p> : preview.state === "success" ? <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words text-[15px] text-text-strong-950">{formatPreview(preview.value)}</pre> : <p className="text-[15px] text-text-sub-600">Enter a formula to preview row 1.</p>}
            </div>
          )}

          <label className="flex items-center gap-2 text-[15px] text-text-strong-950">
            <input type="checkbox" checked={autoRun} onChange={(event) => setAutoRun(event.target.checked)} className="size-4 rounded border-stroke-sub-300" />
            Auto-run when input columns change
          </label>
        </div>

        {(error || formulaSyntaxError) && <p role="alert" className="mx-5 mt-3 rounded-lg bg-red-50 dark:bg-red-500/10 px-3 py-2 text-[15px] text-red-700 dark:text-red-400">{error ?? `Formula syntax error: ${formulaSyntaxError}`}</p>}
        <div className="mt-3 flex justify-end gap-2 border-t border-stroke-soft-200 px-5 py-4">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-lg border border-stroke-soft-200 px-3 py-2 text-[15px] font-medium text-text-strong-950 hover:bg-bg-weak-50">Cancel</button>
          <button type="button" onClick={() => void save()} disabled={busy || !!formulaSyntaxError} className="relative rounded-lg border border-blue-200 dark:border-blue-500/30 px-3 py-2 text-[15px] font-medium text-blue-700 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10 disabled:opacity-50"><span className={busy && !busyRun ? "invisible" : undefined}>Save</span>{busy && !busyRun && <RiLoader4Line className="absolute inset-0 m-auto size-4 animate-spin" />}</button>
          <button type="button" onClick={() => void save(true)} disabled={busy || !!formulaSyntaxError} className="relative rounded-lg bg-blue-600 px-3 py-2 text-[15px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"><span className={busy && busyRun ? "invisible" : undefined}>Save &amp; run</span>{busy && busyRun && <RiLoader4Line className="absolute inset-0 m-auto size-4 animate-spin" />}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const inputClass = "w-full rounded-lg border border-stroke-soft-200 bg-bg-white-0 px-3 py-2 text-[15px] text-text-strong-950 outline-none placeholder:text-text-soft-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500";

function emptySubscribe() {
  return () => {};
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-[15px] font-medium text-text-strong-950">{label}</span>{children}{hint && <span className="mt-1 block text-[14px] text-text-sub-600">{hint}</span>}</label>;
}

function ColumnPicker({ columns, onPick, onClose }: { columns: GridColumn[]; onPick: (key: string) => void; onClose: () => void }) {
  return <div className="absolute left-2 top-full z-20 mt-1 max-h-52 w-72 overflow-y-auto rounded-lg border border-stroke-soft-200 bg-bg-white-0 p-1 shadow-lg">{columns.length ? columns.map((column) => <button key={column.id} type="button" onClick={() => onPick(column.key)} className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[15px] hover:bg-bg-weak-50"><span className="truncate text-text-strong-950">{column.name}</span><span className="ml-2 font-mono text-[13px] text-text-soft-400">{column.key}</span></button>) : <p className="px-2 py-1.5 text-[15px] text-text-sub-600">No other columns yet.</p>}<button type="button" onClick={onClose} className="mt-1 w-full border-t border-stroke-soft-200 px-2 py-1.5 text-left text-[14px] text-text-soft-400">Close</button></div>;
}

function formatPreview(value: unknown): string {
  if (typeof value === "string") return value || "(empty string)";
  if (value === undefined) return "undefined";
  return JSON.stringify(value, null, 2);
}
