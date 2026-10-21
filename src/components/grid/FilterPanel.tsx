"use client";

import { useEffect, useRef, useState } from "react";
import { RiAddLine, RiCloseLine, RiEyeLine, RiEyeOffLine, RiMoreLine } from "@remixicon/react";
import * as Select from "@/components/alignui/select";
import type { GridColumn } from "@/lib/grid/schema";
import {
  OPERATOR_LABELS,
  VALUELESS_OPERATORS,
  isFilterGroup,
  type FilterCondition,
  type FilterGroup,
  type FilterOperator,
} from "@/lib/grid/query";
import { columnTypeMeta } from "./columnTypes";
import { effectiveColumnType } from "@/lib/grid/value-types";

/** Operator order follows Clay's dropdown; contains/not-contains are appended. */
const OPERATORS: FilterOperator[] = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "empty",
  "notEmpty",
  "contains",
  "notContains",
];

const VALUE_DEBOUNCE_MS = 400;

/**
 * A filter's value box. Every commit PATCHes the view and refetches the rows,
 * so typing edits a local draft, which is committed once the person pauses,
 * presses Enter or leaves the box. While the box has focus the draft wins over
 * whatever the parent echoes back, so a slow round trip cannot snap it back.
 */
function FilterValueInput({
  value,
  disabled,
  placeholder,
  onCommit,
}: {
  value: string;
  disabled: boolean;
  placeholder: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [prevValue, setPrevValue] = useState(value);
  const [focused, setFocused] = useState(false);
  const timer = useRef<number | null>(null);
  const commitRef = useRef(onCommit);
  const draftRef = useRef(value);

  useEffect(() => {
    commitRef.current = onCommit;
    draftRef.current = draft;
  });

  // The condition changed from outside (another row removed, view switched):
  // take its value unless this box is being typed in.
  if (value !== prevValue) {
    setPrevValue(value);
    if (!focused) {
      setDraft(value);
    }
  }

  const flush = () => {
    if (timer.current === null) return;
    window.clearTimeout(timer.current);
    timer.current = null;
    commitRef.current(draftRef.current);
  };

  // Do not lose a value typed just before the panel closes.
  useEffect(() => () => flush(), []);

  return (
    <input
      value={draft}
      disabled={disabled}
      placeholder={placeholder}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        flush();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") flush();
      }}
      onChange={(e) => {
        const next = e.target.value;
        setDraft(next);
        draftRef.current = next;
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
          timer.current = null;
          commitRef.current(draftRef.current);
        }, VALUE_DEBOUNCE_MS);
      }}
      className="w-[150px] shrink-0 rounded-lg border border-stroke-soft-200 px-2 py-1.5 text-[15px] text-text-strong-950 outline-none focus:border-blue-500 disabled:bg-bg-weak-50 disabled:text-text-disabled-300"
    />
  );
}

export const EMPTY_FILTERS: FilterGroup = { conjunction: "and", conditions: [] };

export default function FilterPanel({
  columns,
  value,
  onChange,
}: {
  columns: GridColumn[];
  value: FilterGroup;
  onChange: (next: FilterGroup) => void;
}) {
  const [menuFor, setMenuFor] = useState<number | null>(null);

  const set = (conditions: (FilterCondition | FilterGroup)[]) =>
    onChange({ ...value, conditions });

  const addCondition = () =>
    set([
      ...value.conditions,
      { columnKey: columns[0]?.key ?? "", operator: "eq", value: "" },
    ]);

  const addGroup = () =>
    set([
      ...value.conditions,
      {
        conjunction: "and",
        conditions: [{ columnKey: columns[0]?.key ?? "", operator: "eq", value: "" }],
      } satisfies FilterGroup,
    ]);

  const patchAt = (i: number, patch: Partial<FilterCondition>) =>
    set(
      value.conditions.map((c, idx) =>
        idx === i && !isFilterGroup(c) ? { ...c, ...patch } : c,
      ),
    );

  const removeAt = (i: number) => set(value.conditions.filter((_, idx) => idx !== i));

  return (
    <div className="p-3">
      {value.conditions.length === 0 && (
        <p className="mb-2 px-1 text-[15px] text-text-sub-600">
          No filters yet — every row is shown.
        </p>
      )}

      <div className="space-y-2">
        {value.conditions.map((c, i) => {
          if (isFilterGroup(c)) {
            // Nested groups render one level, which is as deep as Clay goes in
            // practice and keeps the panel legible.
            return (
              <div key={i} className="rounded-lg border border-stroke-soft-200 bg-bg-weak-50 p-2">
                <div className="mb-1.5 flex items-center justify-between">
                  <Select.Root
                    size="xsmall"
                    value={c.conjunction}
                    onValueChange={(next) =>
                      set(
                        value.conditions.map((x, idx) =>
                          idx === i
                            ? { ...(x as FilterGroup), conjunction: next as "and" | "or" }
                            : x,
                        ),
                      )
                    }
                  >
                    <Select.Trigger aria-label="Group conjunction" className="w-auto">
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="and">All of</Select.Item>
                      <Select.Item value="or">Any of</Select.Item>
                    </Select.Content>
                  </Select.Root>
                  <button
                    type="button"
                    onClick={() => removeAt(i)}
                    className="rounded p-1 text-text-soft-400 hover:bg-bg-soft-200 hover:text-text-sub-600"
                  >
                    <RiCloseLine className="size-3.5" />
                  </button>
                </div>
                <FilterPanel
                  columns={columns}
                  value={c}
                  onChange={(next) =>
                    set(value.conditions.map((x, idx) => (idx === i ? next : x)))
                  }
                />
              </div>
            );
          }

          const col = columns.find((x) => x.key === c.columnKey);
          const Icon = columnTypeMeta(col ? effectiveColumnType(col) : "text").icon;
          const needsValue = !VALUELESS_OPERATORS.has(c.operator);

          return (
            <div key={i} className="flex items-center gap-2">
              <span className="w-11 shrink-0 text-[15px] text-text-sub-600">
                {i === 0 ? (
                  "Where"
                ) : (
                  <Select.Root
                    size="xsmall"
                    value={value.conjunction}
                    onValueChange={(next) =>
                      onChange({ ...value, conjunction: next as "and" | "or" })
                    }
                  >
                    <Select.Trigger aria-label="Filter conjunction" className="w-full">
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="and">and</Select.Item>
                      <Select.Item value="or">or</Select.Item>
                    </Select.Content>
                  </Select.Root>
                )}
              </span>

              <Select.Root
                size="xsmall"
                value={c.columnKey}
                onValueChange={(next) => patchAt(i, { columnKey: next })}
              >
                <Select.Trigger aria-label="Column" className="min-w-0 flex-1">
                  <Icon className="size-4 shrink-0 text-text-soft-400" />
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  {columns.map((x) => (
                    <Select.Item key={x.key} value={x.key}>
                      {x.name}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>

              <Select.Root
                size="xsmall"
                value={c.operator}
                onValueChange={(next) => patchAt(i, { operator: next as FilterOperator })}
              >
                <Select.Trigger aria-label="Operator" className="w-[150px] shrink-0">
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  {OPERATORS.map((op) => (
                    <Select.Item key={op} value={op}>
                      {OPERATOR_LABELS[op]}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>

              <FilterValueInput
                value={c.value ?? ""}
                disabled={!needsValue}
                placeholder={needsValue ? "" : "—"}
                onCommit={(next) => patchAt(i, { value: next })}
              />

              <button
                type="button"
                title={c.disabled ? "Filter is muted" : "Mute this filter"}
                onClick={() => patchAt(i, { disabled: !c.disabled })}
                className="shrink-0 rounded p-1 text-text-soft-400 hover:bg-bg-weak-50 hover:text-text-sub-600"
              >
                {c.disabled ? (
                  <RiEyeOffLine className="size-4" />
                ) : (
                  <RiEyeLine className="size-4" />
                )}
              </button>

              <div className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setMenuFor(menuFor === i ? null : i)}
                  className="rounded p-1 text-text-soft-400 hover:bg-bg-weak-50 hover:text-text-sub-600"
                >
                  <RiMoreLine className="size-4" />
                </button>
                {menuFor === i && (
                  <div className="absolute right-0 top-7 z-10 w-32 rounded-lg border border-stroke-soft-200 bg-bg-white-0 py-1 shadow-lg">
                    <button
                      type="button"
                      onClick={() => {
                        removeAt(i);
                        setMenuFor(null);
                      }}
                      className="w-full px-3 py-1.5 text-left text-[15px] text-red-600 dark:text-red-400 hover:bg-bg-weak-50"
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center gap-1">
        <button
          type="button"
          onClick={addCondition}
          disabled={!columns.length}
          className="flex items-center gap-1.5 rounded-lg border border-blue-200 dark:border-blue-500/30 px-2.5 py-1.5 text-[15px] font-medium text-text-strong-950 transition hover:bg-bg-weak-50 disabled:opacity-50"
        >
          <RiAddLine className="size-4" />
          Add filter
        </button>
        <button
          type="button"
          onClick={addGroup}
          disabled={!columns.length}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[15px] font-medium text-text-strong-950 transition hover:bg-bg-weak-50 disabled:opacity-50"
        >
          <RiAddLine className="size-4" />
          Add filter group
        </button>
        <button
          type="button"
          onClick={() => onChange(EMPTY_FILTERS)}
          disabled={!value.conditions.length}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[15px] font-medium text-red-600 dark:text-red-400 transition hover:bg-red-50 dark:hover:bg-red-500/10 disabled:opacity-40"
        >
          <RiCloseLine className="size-4" />
          Clear filters
        </button>
      </div>
    </div>
  );
}
