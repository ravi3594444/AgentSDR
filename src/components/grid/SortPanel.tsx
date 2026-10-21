"use client";

import { RiDeleteBin6Line, RiDraggable } from "@remixicon/react";
import * as Select from "@/components/alignui/select";
import type { GridColumn } from "@/lib/grid/schema";
import type { SortSpec } from "@/lib/grid/query";
import { columnTypeMeta } from "./columnTypes";
import { effectiveColumnType } from "@/lib/grid/value-types";

/**
 * Direction wording follows the column type, the way Clay does: "A → Z" for
 * text is meaningless on a number column, and "1 → 9" is meaningless on a date.
 */
function directionLabels(type: string): { asc: string; desc: string } {
  if (type === "number" || type === "currency") return { asc: "1 → 9", desc: "9 → 1" };
  if (type === "date") return { asc: "Oldest first", desc: "Newest first" };
  if (type === "boolean") return { asc: "Unchecked first", desc: "Checked first" };
  return { asc: "A → Z", desc: "Z → A" };
}

export default function SortPanel({
  columns,
  value,
  onChange,
}: {
  columns: GridColumn[];
  value: SortSpec[];
  onChange: (next: SortSpec[]) => void;
}) {
  const add = () => {
    // Offer a column that is not already sorted, so a second "Add sort" does
    // not silently duplicate the first.
    const used = new Set(value.map((s) => s.columnKey));
    const next = columns.find((c) => !used.has(c.key)) ?? columns[0];
    if (!next) return;
    onChange([...value, { columnKey: next.key, direction: "asc" }]);
  };

  return (
    <div className="p-3">
      {value.length === 0 && (
        <p className="mb-2 px-1 text-[15px] text-text-sub-600">
          No sorts yet — rows keep their natural order.
        </p>
      )}

      <div className="space-y-2">
        {value.map((s, i) => {
          const col = columns.find((c) => c.key === s.columnKey);
          const valueType = col ? effectiveColumnType(col) : "text";
          const Icon = columnTypeMeta(valueType).icon;
          const labels = directionLabels(valueType);

          return (
            <div key={i} className="flex items-center gap-2">
              <RiDraggable className="size-4 shrink-0 text-text-disabled-300" />

              <Select.Root
                size="xsmall"
                value={s.columnKey}
                onValueChange={(next) =>
                  onChange(value.map((x, idx) => (idx === i ? { ...x, columnKey: next } : x)))
                }
              >
                <Select.Trigger aria-label="Sort column" className="min-w-0 flex-1">
                  <Icon className="size-4 shrink-0 text-text-soft-400" />
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  {columns.map((c) => (
                    <Select.Item key={c.key} value={c.key}>
                      {c.name}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>

              <Select.Root
                size="xsmall"
                value={s.direction}
                onValueChange={(next) =>
                  onChange(
                    value.map((x, idx) =>
                      idx === i ? { ...x, direction: next as "asc" | "desc" } : x,
                    ),
                  )
                }
              >
                <Select.Trigger aria-label="Sort direction" className="w-[150px] shrink-0">
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="asc">{labels.asc}</Select.Item>
                  <Select.Item value="desc">{labels.desc}</Select.Item>
                </Select.Content>
              </Select.Root>

              <button
                type="button"
                onClick={() => onChange(value.filter((_, idx) => idx !== i))}
                className="shrink-0 rounded p-1 text-red-500 transition hover:bg-red-50 dark:hover:bg-red-500/10"
              >
                <RiDeleteBin6Line className="size-4" />
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={add}
        disabled={!columns.length}
        className="mt-2 w-full rounded-lg border border-stroke-soft-200 py-2 text-center text-[15px] text-text-sub-600 transition hover:bg-bg-weak-50 disabled:opacity-50"
      >
        Add sort
      </button>
    </div>
  );
}
