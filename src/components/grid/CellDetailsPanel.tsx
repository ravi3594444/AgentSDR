"use client";

import { useEffect, useMemo, useState } from "react";
import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiCheckLine,
  RiCloseLine,
  RiFileCopyLine,
  RiFlashlightLine,
  RiLoader4Line,
  RiSearchLine,
} from "@remixicon/react";
import type { GridColumn } from "@/lib/grid/schema";
import { inferResponseValueType } from "@/lib/grid/value-types";
import { columnTypeMeta } from "./columnTypes";

export type CellDetailsSelection = {
  rowId: string;
  column: GridColumn;
};

type CellRun = {
  id: string;
  provider: string | null;
  outcome: "hit" | "miss" | "error" | "skipped";
  costCents: number;
  latencyMs: number | null;
  request: unknown;
  response: unknown;
  createdAt: string;
};

type DetailsResponse = {
  sourceColumnKey: string;
  sourceColumnName: string;
  sourceColumnType: "enrichment" | "ai" | "http" | "formula";
  canAddResponseColumn: boolean;
  run: CellRun | null;
  error?: string;
};

type JsonEntry = { label: string; pointer: string; value: unknown };

export default function CellDetailsPanel({
  tableId,
  selection,
  onClose,
  onAdded,
}: {
  tableId: string;
  selection: CellDetailsSelection;
  onClose: () => void;
  onAdded: (columnName: string) => Promise<void>;
}) {
  const [details, setDetails] = useState<DetailsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<JsonEntry | null>(null);
  const [adding, setAdding] = useState(false);
  const [copied, setCopied] = useState(false);
  const [payload, setPayload] = useState<"response" | "request">("response");

  const activePayload = details?.run?.[payload];

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({
      rowId: selection.rowId,
      columnKey: selection.column.key,
    });
    fetch(`/api/grid/tables/${tableId}/cell-details?${query}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as DetailsResponse;
        if (!response.ok) throw new Error(body.error ?? "Could not load cell details");
        if (active) setDetails(body);
      })
      .catch((cause) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : "Could not load cell details");
        }
      });
    return () => { active = false; };
  }, [selection.column.key, selection.rowId, tableId]);

  const searchResults = useMemo(() => {
    if (!details?.run || !search.trim()) return null;
    const needle = search.trim().toLowerCase();
    return flattenJson(activePayload).filter((entry) =>
      entry.pointer && `${entry.label} ${entry.pointer} ${displayValue(entry.value)}`.toLowerCase().includes(needle),
    );
  }, [activePayload, details?.run, search]);

  const copySelected = async () => {
    if (!selected) return;
    await navigator.clipboard.writeText(copyValue(selected.value));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const addSelected = async () => {
    if (!selected || !details?.run) return;
    setAdding(true);
    setError(null);
    try {
      const response = await fetch(`/api/grid/tables/${tableId}/cell-details`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rowId: selection.rowId,
          columnKey: selection.column.key,
          runId: details.run.id,
          pointer: selected.pointer,
          name: suggestedColumnName(selected),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not add column");
      await onAdded(body.column?.name ?? suggestedColumnName(selected));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add column");
    } finally {
      setAdding(false);
    }
  };

  return (
    <aside className="fixed inset-y-0 right-0 z-[80] flex w-[min(520px,100vw)] flex-col border-l border-stroke-soft-200 bg-bg-white-0 shadow-2xl">
      <header className="flex h-[60px] shrink-0 items-center gap-3 border-b border-stroke-soft-200 px-5">
        <RiFlashlightLine className="size-5 text-text-strong-950" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-semibold text-text-strong-950">Cell details</h2>
          <p className="truncate text-[13px] text-text-sub-600">{details?.sourceColumnName ?? selection.column.name}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close cell details" className="rounded-lg p-2 text-text-sub-600 hover:bg-bg-weak-50">
          <RiCloseLine className="size-5" />
        </button>
      </header>

      {details?.run && (
        <div className="grid shrink-0 grid-cols-2 gap-x-4 gap-y-2 border-b border-stroke-soft-200 bg-bg-white-0 px-4 py-3 text-[14px]">
          <div><span className="text-text-soft-400">Provider</span><p className="truncate font-medium text-text-strong-950" title={details.run.provider ?? undefined}>{details.run.provider ?? "Unavailable"}</p></div>
          <div><span className="text-text-soft-400">Outcome</span><p className={`font-medium capitalize ${details.run.outcome === "error" ? "text-red-700 dark:text-red-400" : "text-text-strong-950"}`}>{details.run.outcome}</p></div>
          <div><span className="text-text-soft-400">Latency</span><p className="font-medium text-text-strong-950">{details.run.latencyMs === null ? "Unavailable" : `${details.run.latencyMs} ms`}</p></div>
          <div><span className="text-text-soft-400">Run at</span><p className="font-medium text-text-strong-950">{new Date(details.run.createdAt).toLocaleString()}</p></div>
          {runError(details.run.response) && <div className="col-span-2 rounded-md bg-red-50 dark:bg-red-500/10 px-2.5 py-2 text-red-700 dark:text-red-400"><span className="font-semibold">Error: </span>{runError(details.run.response)}</div>}
        </div>
      )}

      <div className="shrink-0 bg-bg-weak-50 px-4 pt-4">
        <div className="mb-3 flex rounded-lg border border-stroke-soft-200 bg-bg-white-0 p-1">
          {(["response", "request"] as const).map((item) => (
            <button key={item} type="button" onClick={() => { setPayload(item); setSearch(""); setSelected(null); }} className={`flex-1 rounded-md px-3 py-1.5 text-[14px] font-medium capitalize ${payload === item ? "bg-bg-strong-950 text-text-white-0" : "text-text-sub-600 hover:bg-bg-weak-50"}`}>{item}</button>
          ))}
        </div>
        <label className="flex items-center gap-2 rounded-lg border border-stroke-soft-200 bg-bg-white-0 px-3 py-2.5 focus-within:border-blue-500">
          <RiSearchLine className="size-5 text-text-soft-400" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Search ${payload} fields`} className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-text-soft-400" />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-bg-weak-50 p-4">
        {!details && !error && <div className="flex h-40 items-center justify-center gap-2 text-[15px] text-text-sub-600"><RiLoader4Line className="size-4 animate-spin" />Loading API result…</div>}
        {error && <div className="rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-[15px] text-red-700 dark:text-red-400">{error}</div>}
        {details && !details.run && <div className="rounded-lg border border-stroke-soft-200 bg-bg-white-0 p-4 text-[15px] text-text-sub-600">No API result exists for this cell yet. Run this column first.</div>}
        {details?.run && searchResults && (
          <div className="space-y-1.5">
            {searchResults.length ? searchResults.map((entry) => (
              <JsonRow key={entry.pointer} entry={entry} selected={selected?.pointer === entry.pointer} onSelect={setSelected} />
            )) : <p className="px-2 py-8 text-center text-[15px] text-text-sub-600">No matching fields</p>}
          </div>
        )}
        {details?.run && !searchResults && (
          <JsonTree value={activePayload} pointer="" depth={0} selectedPointer={selected?.pointer} onSelect={setSelected} />
        )}
      </div>

      {selected && details?.run && (
        <div className="shrink-0 border-t border-stroke-soft-200 bg-bg-white-0 p-3">
          <div className="mb-2 truncate text-[13px] text-text-sub-600" title={selected.pointer}>{selected.pointer}</div>
          <div className="flex gap-2">
            <button type="button" onClick={() => void copySelected()} className="flex items-center gap-1.5 rounded-lg border border-stroke-soft-200 px-3 py-2 text-[15px] font-medium text-text-strong-950 hover:bg-bg-weak-50">
              {copied ? <RiCheckLine className="size-4 text-emerald-600 dark:text-emerald-400" /> : <RiFileCopyLine className="size-4" />}{copied ? "Copied" : "Copy"}
            </button>
            {payload === "response" && details.canAddResponseColumn && (
              <button type="button" disabled={adding} onClick={() => void addSelected()} className="ml-auto flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-[15px] font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300">
                {adding ? <RiLoader4Line className="size-4 animate-spin" /> : <RiAddLine className="size-4" />}Add to column
              </button>
            )}
          </div>
        </div>
      )}

      {details?.run && (
        <footer className="flex shrink-0 items-center justify-between border-t border-stroke-soft-200 px-4 py-3 text-[14px] text-text-sub-600">
          <span>Updated {new Date(details.run.createdAt).toLocaleString()}</span>
          <span className="capitalize">{details.run.outcome}{details.run.latencyMs !== null ? ` · ${details.run.latencyMs} ms` : ""}{details.run.costCents ? ` · ${details.run.costCents}¢` : ""}</span>
        </footer>
      )}
    </aside>
  );
}

function JsonTree({ value, pointer, depth, selectedPointer, onSelect }: {
  value: unknown;
  pointer: string;
  depth: number;
  selectedPointer?: string;
  onSelect: (entry: JsonEntry) => void;
}) {
  if (!value || typeof value !== "object") {
    const entry = { label: pointer.split("/").at(-1) || "Result", pointer, value };
    return <JsonRow entry={entry} selected={selectedPointer === pointer} onSelect={onSelect} />;
  }
  return (
    <div className={depth ? "ml-3 border-l border-stroke-sub-300 pl-2" : "space-y-1.5"}>
      {Object.entries(value).map(([key, child]) => (
        <JsonBranch key={`${pointer}/${escapePointer(key)}`} label={key} value={child} pointer={`${pointer}/${escapePointer(key)}`} depth={depth} selectedPointer={selectedPointer} onSelect={onSelect} />
      ))}
    </div>
  );
}

function JsonBranch({ label, value, pointer, depth, selectedPointer, onSelect }: {
  label: string;
  value: unknown;
  pointer: string;
  depth: number;
  selectedPointer?: string;
  onSelect: (entry: JsonEntry) => void;
}) {
  const expandable = value !== null && typeof value === "object";
  const [open, setOpen] = useState(depth < 1);
  if (!expandable) return <JsonRow entry={{ label, pointer, value }} selected={selectedPointer === pointer} onSelect={onSelect} />;
  const count = Array.isArray(value) ? value.length : Object.keys(value as object).length;
  return (
    <div className="space-y-1.5">
      <div className={`flex items-center rounded-lg border bg-bg-white-0 ${selectedPointer === pointer ? "border-blue-400 ring-1 ring-blue-400" : "border-stroke-soft-200"}`}>
        <button type="button" onClick={() => setOpen((current) => !current)} className="p-2 text-text-sub-600">
          {open ? <RiArrowDownSLine className="size-4" /> : <RiArrowRightSLine className="size-4" />}
        </button>
        <button type="button" onClick={() => onSelect({ label, pointer, value })} className="min-w-0 flex-1 py-2 pr-3 text-left text-[15px]">
          <span className="font-medium text-text-strong-950">{humanize(label)}</span><span className="ml-2 text-text-sub-600">{Array.isArray(value) ? "[ ]" : "{ }"} {count}</span>
        </button>
      </div>
      {open && <JsonTree value={value} pointer={pointer} depth={depth + 1} selectedPointer={selectedPointer} onSelect={onSelect} />}
    </div>
  );
}

function JsonRow({ entry, selected, onSelect }: { entry: JsonEntry; selected: boolean; onSelect: (entry: JsonEntry) => void }) {
  const valueType = inferResponseValueType(entry.value, `${entry.label} ${entry.pointer}`);
  const TypeIcon = columnTypeMeta(valueType).icon;
  return (
    <button type="button" onClick={() => onSelect(entry)} className={`flex w-full items-start gap-2 rounded-lg border bg-bg-white-0 px-3 py-2 text-left text-[15px] ${selected ? "border-blue-400 ring-1 ring-blue-400" : "border-stroke-soft-200 hover:border-stroke-sub-300"}`}>
      <TypeIcon className="mt-0.5 size-4 shrink-0 text-text-sub-600" />
      <span className="font-medium text-text-strong-950">{humanize(entry.label)}</span>
      <span className="min-w-0 break-all text-text-sub-600">{displayValue(entry.value)}</span>
    </button>
  );
}

function flattenJson(value: unknown, pointer = "", label = "Result"): JsonEntry[] {
  const entry = { label, pointer, value };
  if (!value || typeof value !== "object") return [entry];
  return [entry, ...Object.entries(value).flatMap(([key, child]) =>
    flattenJson(child, `${pointer}/${escapePointer(key)}`, key),
  )];
}

function escapePointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function suggestedColumnName(entry: JsonEntry): string {
  const parts = entry.pointer.split("/").filter(Boolean);
  const leaf = /^\d+$/.test(parts.at(-1) ?? "") ? parts.at(-2) : parts.at(-1);
  return humanize((leaf ?? entry.label).replace(/~1/g, "/").replace(/~0/g, "~"));
}

function displayValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "object") return Array.isArray(value) ? `[${value.length}]` : `{${Object.keys(value as object).length}}`;
  return String(value);
}

function runError(response: unknown): string | null {
  if (!response || typeof response !== "object" || !("error" in response)) return null;
  const error = (response as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : null;
  }
  return null;
}

function copyValue(value: unknown): string {
  return value && typeof value === "object" ? JSON.stringify(value, null, 2) : String(value ?? "");
}
