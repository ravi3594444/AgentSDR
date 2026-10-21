"use client";

import { useMemo, useState } from "react";
import { RiEyeLine, RiEyeOffLine, RiSearchLine, RiSortAsc } from "@remixicon/react";
import type { GridColumn } from "@/lib/grid/schema";
import { columnTypeMeta } from "./columnTypes";
import { effectiveColumnType } from "@/lib/grid/value-types";

/**
 * The "n/m columns" popover: search, bulk show/hide, and a per-column toggle.
 *
 * Hiding is a view concern only — the column and its data stay exactly as they
 * were, which is why this writes hiddenColumns rather than deleting anything.
 */
export default function ColumnsMenu({
  columns,
  hidden,
  onChange,
}: {
  columns: GridColumn[];
  hidden: string[];
  onChange: (nextHidden: string[]) => void;
}) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const t = search.trim().toLowerCase();
    return t ? columns.filter((c) => c.name.toLowerCase().includes(t)) : columns;
  }, [columns, search]);

  const hiddenSet = new Set(hidden);
  const toggle = (key: string) =>
    onChange(hiddenSet.has(key) ? hidden.filter((k) => k !== key) : [...hidden, key]);

  return (
    <div className="py-1.5">
      <div className="px-2 pb-1.5">
        <div className="flex items-center gap-2 rounded-lg border border-blue-500 px-2.5 py-2 ring-1 ring-blue-500">
          <RiSearchLine className="size-4 shrink-0 text-text-soft-400" />
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-text-strong-950 outline-none placeholder:text-text-soft-400"
          />
        </div>
      </div>

      <button
        type="button"
        onClick={() => onChange([])}
        disabled={!hidden.length}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[15px] text-text-strong-950 transition hover:bg-bg-weak-50 disabled:text-text-disabled-300"
      >
        <RiEyeLine className="size-[18px] shrink-0 text-text-soft-400" />
        Show all columns
      </button>
      <button
        type="button"
        onClick={() => onChange(columns.map((c) => c.key))}
        disabled={hidden.length === columns.length}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[15px] text-text-strong-950 transition hover:bg-bg-weak-50 disabled:text-text-disabled-300"
      >
        <RiSortAsc className="size-[18px] shrink-0 text-text-soft-400" />
        Hide all columns
      </button>

      <div className="my-1.5 h-px bg-bg-weak-50" />

      <div className="max-h-[320px] overflow-y-auto">
        {filtered.length === 0 && (
          <p className="px-3 py-3 text-[15px] text-text-soft-400">No columns match.</p>
        )}
        {filtered.map((c) => {
          const isHidden = hiddenSet.has(c.key);
          const Icon = columnTypeMeta(effectiveColumnType(c)).icon;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => toggle(c.key)}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-bg-weak-50"
            >
              <Icon
                className={`size-[18px] shrink-0 ${isHidden ? "text-text-disabled-300" : "text-text-soft-400"}`}
              />
              <span
                className={`min-w-0 flex-1 truncate text-[15px] ${
                  isHidden ? "text-text-disabled-300" : "text-text-strong-950"
                }`}
              >
                {c.name}
              </span>
              {isHidden ? (
                <RiEyeOffLine className="size-4 shrink-0 text-text-disabled-300" />
              ) : (
                <RiEyeLine className="size-4 shrink-0 text-text-soft-400" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
