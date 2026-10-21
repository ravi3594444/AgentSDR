"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  RiAlertLine,
  RiCloseLine,
  RiFileExcel2Line,
  RiLoader4Line,
  RiUploadCloud2Line,
} from "@remixicon/react";
import * as Select from "@/components/alignui/select";
import type { StaticColumnType } from "@/lib/grid/types";
import { columnTypeMeta } from "./columnTypes";

type Mapping =
  | { headerIndex: number; action: "map"; columnKey: string }
  | { headerIndex: number; action: "create"; name: string; type: StaticColumnType }
  | { headerIndex: number; action: "skip" };

type Preview = {
  fileName: string;
  sheetNames: string[];
  headers: string[];
  rows: string[][];
  totalRows: number;
  truncated: boolean;
  maxRows: number;
  mapping: Mapping[];
  columns: { key: string; name: string; type: string }[];
};

const NEW_COLUMN_TYPES: StaticColumnType[] = [
  "text",
  "number",
  "currency",
  "boolean",
  "date",
  "url",
  "email",
  "multiselect",
  "json",
];

export default function ImportDialog({
  open,
  tableId,
  initialFile,
  onClose,
  onImported,
}: {
  open: boolean;
  tableId: string;
  /** A file already chosen elsewhere (New workbook): skips the picker and goes straight to mapping. */
  initialFile?: File | null;
  onClose: () => void;
  onImported: (summary: { rowsInserted: number; columnsCreated: number }) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [sheet, setSheet] = useState<string | undefined>();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Mapping[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [mounted, setMounted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: effect resets/seeds local state when props or open state change; deriving during render would change timing
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: effect resets/seeds local state when props or open state change; deriving during render would change timing
      setFile(null);
      setSheet(undefined);
      setPreview(null);
      setMapping([]);
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const loadPreview = useCallback(
    async (f: File, sheetName?: string) => {
      setBusy(true);
      setError(null);
      try {
        const fd = new FormData();
        fd.append("file", f);
        if (sheetName) fd.append("sheet", sheetName);

        const res = await fetch(`/api/grid/tables/${tableId}/import`, {
          method: "POST",
          body: fd,
        });
        const d = await res.json();
        if (!res.ok) {
          setError(d.error ?? "Could not read that file");
          setPreview(null);
          return;
        }
        setPreview(d);
        setMapping(d.mapping);
        setSheet(sheetName ?? d.sheetNames[0]);
      } catch {
        setError("Upload failed — please try again");
      } finally {
        setBusy(false);
      }
    },
    [tableId],
  );

  const startedWith = useRef<File | null>(null);
  useEffect(() => {
    if (!open || !initialFile || startedWith.current === initialFile) return;
    startedWith.current = initialFile;
    setFile(initialFile);
    void loadPreview(initialFile);
  }, [open, initialFile, loadPreview]);

  const pick = useCallback(
    (f: File | undefined) => {
      if (!f) return;
      setFile(f);
      void loadPreview(f);
    },
    [loadPreview],
  );

  const runImport = useCallback(async () => {
    if (!file || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (sheet) fd.append("sheet", sheet);
      fd.append("mapping", JSON.stringify(mapping));

      const res = await fetch(`/api/grid/tables/${tableId}/import`, {
        method: "POST",
        body: fd,
      });
      const d = await res.json();
      if (!res.ok) {
        setError(d.error ?? "Import failed");
        return;
      }
      onImported({ rowsInserted: d.rowsInserted, columnsCreated: d.columnsCreated });
    } catch {
      setError("Import failed — please try again");
    } finally {
      setBusy(false);
    }
  }, [file, preview, sheet, mapping, tableId, onImported]);

  if (!open || !mounted) return null;

  const included = mapping.filter((m) => m.action !== "skip").length;
  const blankName = mapping.some((m) => m.action === "create" && !m.name.trim());

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-sm" onClick={busy ? undefined : onClose} />

      <div className="relative z-10 flex max-h-[86vh] w-full max-w-4xl flex-col rounded-2xl bg-bg-white-0 shadow-xl ring-1 ring-inset ring-stroke-soft-200">
        <div className="flex shrink-0 items-start justify-between border-b border-stroke-soft-200 px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold text-text-strong-950">Import data</h2>
            <p className="text-[15px] text-text-sub-600">
              CSV, TSV or Excel. The first row is read as column headers.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md p-1 text-text-soft-400 transition hover:bg-bg-weak-50 hover:text-text-sub-600 disabled:opacity-50"
          >
            <RiCloseLine className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {/* ---- file picker ---- */}
          {!preview && (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                pick(e.dataTransfer.files?.[0]);
              }}
              className={`flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed py-16 transition ${
                dragging ? "border-blue-500 bg-blue-50 dark:bg-blue-500/10" : "border-stroke-sub-300 hover:border-stroke-sub-300"
              }`}
            >
              {busy ? (
                <RiLoader4Line className="mb-3 size-7 animate-spin text-text-soft-400" />
              ) : (
                <RiUploadCloud2Line className="mb-3 size-7 text-text-soft-400" />
              )}
              <span className="text-[15px] font-medium text-text-strong-950">
                {busy ? "Reading file…" : "Drop a file here, or click to choose"}
              </span>
              <span className="text-[15px] text-text-sub-600">.csv, .tsv, .txt, .xlsx, .xls</span>
            </button>
          )}

          <input
            ref={inputRef}
            type="file"
            accept=".csv,.tsv,.txt,.xlsx,.xls"
            className="hidden"
            onChange={(e) => pick(e.target.files?.[0])}
          />

          {/* ---- mapping ---- */}
          {preview && (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1.5 rounded-lg bg-bg-weak-50 px-2.5 py-1.5 text-[15px] font-medium text-text-strong-950">
                  <RiFileExcel2Line className="size-4 text-text-soft-400" />
                  {preview.fileName}
                </span>
                <span className="text-[15px] text-text-sub-600">
                  {preview.totalRows.toLocaleString()} row
                  {preview.totalRows === 1 ? "" : "s"} · {included} of {preview.headers.length}{" "}
                  column{preview.headers.length === 1 ? "" : "s"} included
                </span>

                {preview.sheetNames.length > 1 && (
                  <Select.Root
                    size="xsmall"
                    value={sheet ?? ""}
                    disabled={busy}
                    onValueChange={(next) => file && loadPreview(file, next)}
                  >
                    <Select.Trigger aria-label="Sheet" className="ml-auto w-auto">
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Content>
                      {preview.sheetNames.map((n) => (
                        <Select.Item key={n} value={n}>
                          {n}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                )}
              </div>

              {preview.truncated && (
                <p className="mb-3 flex items-center gap-2 rounded-lg bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-[15px] text-amber-800 dark:text-amber-400">
                  <RiAlertLine className="size-4 shrink-0" />
                  Only the first {preview.maxRows.toLocaleString()} rows will be imported.
                </p>
              )}

              <div className="overflow-hidden rounded-xl border border-stroke-soft-200">
                <table className="w-full text-left text-[15px]">
                  <thead className="bg-bg-weak-50 text-text-sub-600">
                    <tr>
                      <th className="px-3 py-2 font-medium">File column</th>
                      <th className="px-3 py-2 font-medium">Sample</th>
                      <th className="px-3 py-2 font-medium">Import as</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.headers.map((header, i) => {
                      const m = mapping[i];
                      const samples = preview.rows
                        .map((r) => r[i])
                        .filter(Boolean)
                        .slice(0, 2)
                        .join(", ");

                      const value =
                        m?.action === "skip"
                          ? "__skip"
                          : m?.action === "map"
                            ? `col:${m.columnKey}`
                            : "__new";

                      return (
                        <tr key={i} className="border-t border-stroke-soft-200">
                          <td className="px-3 py-2 font-medium text-text-strong-950">
                            {header || <span className="text-text-soft-400">(unnamed)</span>}
                          </td>
                          <td className="max-w-[200px] truncate px-3 py-2 text-text-sub-600">
                            {samples || "—"}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              <Select.Root
                                size="xsmall"
                                value={value}
                                onValueChange={(v) => {
                                  setMapping((prev) => {
                                    const next = [...prev];
                                    if (v === "__skip") next[i] = { headerIndex: i, action: "skip" };
                                    else if (v === "__new")
                                      next[i] = {
                                        headerIndex: i,
                                        action: "create",
                                        name: header || `Column ${i + 1}`,
                                        type: "text",
                                      };
                                    else
                                      next[i] = {
                                        headerIndex: i,
                                        action: "map",
                                        columnKey: v.slice(4),
                                      };
                                    return next;
                                  });
                                }}
                              >
                                <Select.Trigger aria-label="Import as" className="min-w-[168px]">
                                  <Select.Value />
                                </Select.Trigger>
                                <Select.Content>
                                  <Select.Item value="__new">+ Create new column</Select.Item>
                                  {preview.columns.map((c) => (
                                    <Select.Item key={c.key} value={`col:${c.key}`}>
                                      {c.name}
                                    </Select.Item>
                                  ))}
                                  <Select.Item value="__skip">Skip this column</Select.Item>
                                </Select.Content>
                              </Select.Root>

                              {m?.action === "create" && (
                                <input
                                  aria-label="New column name"
                                  value={m.name}
                                  placeholder={header || `Column ${i + 1}`}
                                  onChange={(e) =>
                                    setMapping((prev) => {
                                      const copy = [...prev];
                                      copy[i] = { ...m, name: e.target.value };
                                      return copy;
                                    })
                                  }
                                  title={m.name} className="w-[200px] min-w-0 flex-1 rounded-lg border border-stroke-soft-200 bg-bg-white-0 px-2 py-1 text-[15px] text-text-strong-950 outline-none focus:border-blue-500"
                                />
                              )}

                              {m?.action === "create" && (
                                <Select.Root
                                  size="xsmall"
                                  value={m.type}
                                  onValueChange={(next) =>
                                    setMapping((prev) => {
                                      const copy = [...prev];
                                      copy[i] = { ...m, type: next as StaticColumnType };
                                      return copy;
                                    })
                                  }
                                >
                                  <Select.Trigger aria-label="Column type">
                                    <Select.Value />
                                  </Select.Trigger>
                                  <Select.Content>
                                    {NEW_COLUMN_TYPES.map((t) => (
                                      <Select.Item key={t} value={t}>
                                        {columnTypeMeta(t).label}
                                      </Select.Item>
                                    ))}
                                  </Select.Content>
                                </Select.Root>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {error && (
            <p className="mt-3 rounded-lg bg-red-50 dark:bg-red-500/10 px-3 py-2 text-[15px] text-red-700 dark:text-red-400">{error}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-stroke-soft-200 px-5 py-3">
          {preview && (
            <button
              type="button"
              onClick={() => {
                setPreview(null);
                setFile(null);
                startedWith.current = null;
                setError(null);
              }}
              disabled={busy}
              className="mr-auto rounded-lg px-3 py-2 text-[15px] font-medium text-text-sub-600 transition hover:bg-bg-weak-50 disabled:opacity-50"
            >
              Choose a different file
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-stroke-soft-200 px-3 py-2 text-[15px] font-medium text-text-sub-600 transition hover:bg-bg-weak-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={runImport}
            disabled={!preview || busy || included === 0 || blankName}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-[15px] font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            {busy && <RiLoader4Line className="size-4 animate-spin" />}
            {preview ? `Import ${preview.totalRows.toLocaleString()} rows` : "Import"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
