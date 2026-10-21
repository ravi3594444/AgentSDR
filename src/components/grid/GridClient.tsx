"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AgGridReact, type CustomCellEditorProps } from "ag-grid-react";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type CellClickedEvent,
  type CellFocusedEvent,
  type CellKeyDownEvent,
  type CellMouseDownEvent,
  type CellValueChangedEvent,
  type ColDef,
  type ColumnMovedEvent,
  type DisplayedColumnsChangedEvent,
  type IHeaderParams,
  type ICellRendererParams,
} from "ag-grid-community";
import "./grid-theme.css";
import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowGoBackLine,
  RiArrowGoForwardLine,
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiCheckboxCircleLine,
  RiCloseLine,
  RiCloseCircleLine,
  RiDeleteBin6Line,
  RiDownload2Line,
  RiFilter3Line,
  RiLayoutColumnLine,
  RiLoader4Line,
  RiStopCircleLine,
  RiMegaphoneLine,
  RiMore2Line,
  RiPlayLine,
  RiRefreshLine,
  RiSearchLine,
  RiSortDesc,
  RiTableLine,
  RiTimeLine,
  RiToolsLine,
  RiUploadCloud2Line,
} from "@remixicon/react";
import type { GridColumn, GridRow, GridTable } from "@/lib/grid/schema";
import { getIntegration } from "@/lib/integrations/catalog";
import IntegrationIcon from "./IntegrationIcon";
import {
  isStaticColumnType,
  type AiConfig,
  type AiOutputConfig,
  type CellMeta,
  type CellMetaMap,
  type ColumnType,
  type IntegrationOutputConfig,
  type TableView,
} from "@/lib/grid/types";
import {
  isFilterGroup,
  VALUELESS_OPERATORS,
  type FilterGroup,
  type SortSpec,
} from "@/lib/grid/query";
import AddColumnMenu from "./AddColumnMenu";
import CellDetailsPanel, { type CellDetailsSelection } from "./CellDetailsPanel";
import ColumnConfigDialog from "./ColumnConfigDialog";
import ColumnMenu from "./ColumnMenu";
import ColumnsMenu from "./ColumnsMenu";
import { useDialogs } from "@/components/DialogProvider";
import AiDialog from "./AiDialog";
import EnrichmentDialog from "./EnrichmentDialog";
import FilterPanel, { EMPTY_FILTERS } from "./FilterPanel";
import ImportDialog from "./ImportDialog";
import CreateCampaignFromGridDialog from "./CreateCampaignFromGridDialog";
import Popover from "./Popover";
import SortPanel from "./SortPanel";
import { columnTypeMeta } from "./columnTypes";
import { clampGridPage, GRID_PAGE_SIZE, gridPageCount, gridPageRange } from "@/lib/grid/pagination";
import * as Checkbox from "@/components/alignui/checkbox";

/**
 * What the Actions menu offers in one click.
 *
 * The four runner columns people actually reach for; the rest stay behind
 * "More column types", so this menu stays a shortcut rather than a second
 * copy of the add-column list.
 */
const QUICK_COLUMN_TYPES: ColumnType[] = ["enrichment", "ai", "http", "formula"];
import { displayHref, effectiveColumnType } from "@/lib/grid/value-types";
import {
  coerceClipboardValue,
  parseClipboardText,
  serializeClipboardGrid,
} from "@/lib/grid/clipboard";

// v33+ is modular: without this every grid throws "No AG Grid modules are
// registered". AllCommunityModule is the whole MIT feature set.
ModuleRegistry.registerModules([AllCommunityModule]);

const HEADER_H = 40;
const ROW_H = 36;
const GUTTER_W = 44;
const COL_W = 220;
const ADD_COL_W = 186;
const INTERNAL_CLIPBOARD_MIME = "application/x-agentsdr-grid+json";

type RowData = Record<string, unknown> & { __id: string; __meta: CellMetaMap };
type PanelName = "columns" | "filter" | "sort" | "search";
type CellCoordinate = { rowIndex: number; columnKey: string };
type CellRange = { anchor: CellCoordinate; focus: CellCoordinate };
type NormalizedCellRange = {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
};
type CellUpdate = { rowId: string; columnKey: string; value: unknown };
type CellEditCommand = { undo: CellUpdate[]; redo: CellUpdate[] };

function normalizeCellRange(
  range: CellRange | null,
  columnKeys: string[],
  rowCount: number,
): NormalizedCellRange | null {
  if (!range || rowCount === 0) return null;
  const anchorColumn = columnKeys.indexOf(range.anchor.columnKey);
  const focusColumn = columnKeys.indexOf(range.focus.columnKey);
  if (anchorColumn < 0 || focusColumn < 0) return null;
  return {
    startRow: Math.max(0, Math.min(range.anchor.rowIndex, range.focus.rowIndex)),
    endRow: Math.min(rowCount - 1, Math.max(range.anchor.rowIndex, range.focus.rowIndex)),
    startColumn: Math.min(anchorColumn, focusColumn),
    endColumn: Math.max(anchorColumn, focusColumn),
  };
}

function isEditingClipboardTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(
    target.closest("input, textarea, [contenteditable='true'], .ag-cell-inline-editing"),
  );
}

function gridRowIndexAtPoint(clientX: number, clientY: number, rowCount: number): number | null {
  const element = document.elementFromPoint(clientX, clientY);
  const rowElement = element instanceof Element ? element.closest<HTMLElement>(".ag-row[row-index]") : null;
  const rowIndex = Number(rowElement?.getAttribute("row-index"));
  return Number.isInteger(rowIndex) && rowIndex >= 0 && rowIndex < rowCount ? rowIndex : null;
}

function fillSourceRowIndex(
  range: NormalizedCellRange,
  targetRow: number,
  destinationRow: number,
): number {
  const sourceHeight = range.endRow - range.startRow + 1;
  return targetRow < range.startRow
    ? range.endRow - ((range.startRow - 1 - destinationRow) % sourceHeight)
    : range.startRow + ((destinationRow - range.endRow - 1) % sourceHeight);
}

function fillPreviewText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Delete / Backspace on a focused cell would make AG Grid open the editor
 * empty. The grid clears the selected cells itself (see onGridKeyDown), so the
 * built-in handling is switched off outside an open editor.
 */
const DEFAULT_COL_DEF: ColDef<RowData> = {
  suppressKeyboardEvent: (params) =>
    !params.editing && (params.event.key === "Delete" || params.event.key === "Backspace"),
};

const theme = themeQuartz.withParams({
  // Colours come from grid-theme.css so the grid follows the light / dark switch.
  accentColor: "var(--grid-accent)",
  backgroundColor: "var(--grid-bg)",
  foregroundColor: "var(--grid-fg)",
  borderColor: "var(--grid-border)",
  headerBackgroundColor: "var(--grid-bg)",
  headerTextColor: "var(--grid-fg)",
  headerFontWeight: 600,
  headerFontSize: 14,
  fontSize: 14,
  fontFamily: "var(--font-sans), system-ui, sans-serif",
  rowHoverColor: "var(--grid-row-hover)",
  selectedRowBackgroundColor: "var(--grid-row-selected)",
  cellHorizontalPadding: 12,
  wrapperBorderRadius: 0,
});

function selectOptions(column: GridColumn): { value: string; label: string }[] {
  const options = (column.config as { options?: unknown } | null)?.options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option: unknown) => {
    if (typeof option === "string") return [{ value: option, label: option }];
    const candidate = option as { value?: unknown; label?: unknown } | null;
    if (candidate && typeof candidate.value === "string") {
      return [{ value: candidate.value, label: typeof candidate.label === "string" ? candidate.label : candidate.value }];
    }
    return [];
  });
}

/** Popup editor for multiselect cells: a checkbox per option, plus any stored value the list lacks. */
function MultiSelectEditor(props: CustomCellEditorProps<RowData, unknown> & { options: string[] }) {
  const current = Array.isArray(props.value) ? props.value.map(String) : [];
  const choices = [...props.options, ...current.filter((value) => !props.options.includes(value))];
  const toggle = (value: string) => {
    const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
    props.onValueChange(next);
  };
  return (
    <div className="max-h-64 min-w-[200px] overflow-auto rounded-lg border border-stroke-soft-200 bg-bg-white-0 p-1.5 shadow-lg">
      {choices.length === 0 && <p className="px-2 py-1.5 text-[14px] text-text-sub-600">This column has no options.</p>}
      {choices.map((value) => (
        <label key={value} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[15px] text-text-strong-950 hover:bg-bg-weak-50">
          <input type="checkbox" checked={current.includes(value)} onChange={() => toggle(value)} />
          <span className="truncate">{value}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * Editing behaviour per static column type. Every editor result goes through
 * the same coercion as paste and import, so a typed "42" is the number 42 and
 * JSON is edited as JSON text instead of "[object Object]". Booleans have no
 * editor: a click or Space toggles them (see onCellClicked).
 */
function editorFor(column: GridColumn): Pick<ColDef<RowData>, "cellEditor" | "cellEditorParams" | "cellEditorPopup" | "valueParser"> {
  const type = column.type;
  if (!isStaticColumnType(type)) return {};
  const base = {
    valueParser: (params: { newValue: unknown }) =>
      coerceClipboardValue(params.newValue === undefined || params.newValue === null ? "" : String(params.newValue), type),
  };
  if (type === "select") {
    const values = selectOptions(column).map((option) => option.value);
    if (values.length) {
      return {
        ...base,
        cellEditor: "agSelectCellEditor",
        // A value the options lack stays selectable only while the cell holds it.
        cellEditorParams: (params: { value?: unknown }) => {
          const held = typeof params.value === "string" && params.value !== "" && !values.includes(params.value) ? [params.value] : [];
          return { values: ["", ...values, ...held] };
        },
      };
    }
  }
  if (type === "multiselect") {
    return {
      ...base,
      cellEditor: MultiSelectEditor,
      cellEditorParams: { options: selectOptions(column).map((option) => option.value) },
      cellEditorPopup: true,
    };
  }
  if (type === "json") return { ...base, cellEditorParams: { useFormatter: true } };
  return base;
}

function isPendingMeta(meta: CellMeta | undefined): boolean {
  return meta?.status === "queued" || meta?.status === "running" || meta?.status === "processing";
}

/** True while any of these rows still has a cell waiting on a run. */
function hasPendingCells(rows: RowData[]): boolean {
  return rows.some((row) => Object.values(row.__meta ?? {}).some((meta) => isPendingMeta(meta as CellMeta | undefined)));
}

/** Years and similar identifiers read as "2010", not "2,010". */
const UNGROUPED_NUMBER_NAME = /year|founded/i;

function toRowData(rows: GridRow[]): RowData[] {
  return rows.map((r) => ({ ...(r.cells ?? {}), __id: r.id, __meta: r.cellMeta ?? {} }));
}

/** Column types whose cells are produced by running something, not typed. */
const RUNNABLE_SOURCE_TYPES: ReadonlySet<ColumnType> = new Set(["enrichment", "ai", "http", "formula"]);

/** A run column's own result columns, so deleting the source can take them along. */
function outputColumnsOf(source: GridColumn, columns: GridColumn[]): GridColumn[] {
  const outputKeys = new Set<string>();
  if (source.type === "ai") {
    for (const key of Object.values((source.config as AiConfig).outputColumns ?? {})) outputKeys.add(key);
  }
  return columns.filter((candidate) => {
    if (candidate.id === source.id) return false;
    if (outputKeys.has(candidate.key)) return true;
    if (source.type === "enrichment" && candidate.type === "integration_output") {
      return (candidate.config as IntegrationOutputConfig).sourceColumnKey === source.key;
    }
    if (source.type === "ai" && candidate.type === "ai_output") {
      return (candidate.config as AiOutputConfig).sourceColumnKey === source.key;
    }
    return false;
  });
}

/** Filters that actually narrow the rows: enabled, and with a value unless the operator needs none. */
function countActiveFilters(group: FilterGroup): number {
  let count = 0;
  for (const condition of group.conditions) {
    if (isFilterGroup(condition)) {
      count += countActiveFilters(condition);
    } else if (!condition.disabled && (VALUELESS_OPERATORS.has(condition.operator) || (condition.value ?? "") !== "")) {
      count += 1;
    }
  }
  return count;
}

/** Pinned columns render first, so the display order must start with them. */
function displayOrderFor(columns: GridColumn[], pinnedKeys: string[]): string[] {
  const pinnedSet = new Set(pinnedKeys);
  return [
    ...columns.filter((column) => pinnedSet.has(column.key)),
    ...columns.filter((column) => !pinnedSet.has(column.key)),
  ].map((column) => column.key);
}

/** What a cell shows as text. Objects and arrays must never fall through to "[object Object]". */
function formatCellValue(value: unknown, column: GridColumn, valueType: ColumnType): string {
  if (value === undefined || value === null) return "";
  if (valueType === "boolean") return value === true || String(value).toLowerCase() === "true" ? "✓" : "";
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "object" && item !== null ? JSON.stringify(item) : String(item))).join(", ");
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  if (valueType === "select" && column.type === "select") {
    return selectOptions(column).find((option) => option.value === value)?.label ?? String(value);
  }
  return String(value);
}

/* ---------- header renderers ---------- */

/** Type icon + name, matching Clay's "T New Column". */
function ColumnHeader(props: IHeaderParams & {
  colType: ColumnType;
  valueType?: ColumnType;
  integrationKey?: string;
  active?: boolean;
  onSelect: (extend: boolean) => void;
  onOpen: (rect: DOMRect) => void;
  onRun?: (rect: DOMRect) => void;
}) {
  const meta = columnTypeMeta(props.valueType ?? props.colType);
  const integration = props.integrationKey ? getIntegration(props.integrationKey) : null;
  const iconClass = props.active ? "text-white" : "text-text-sub-600";
  const icon = integration && props.colType === "enrichment" ? (
    <IntegrationIcon integration={integration} size={17} className="rounded" />
  ) : integration && props.colType === "integration_output" ? (
    <span className="flex shrink-0 items-center gap-1">
      <IntegrationIcon integration={integration} size={14} className="rounded" />
      <meta.icon className={`size-[14px] ${iconClass}`} />
    </span>
  ) : props.colType === "formula" ? (
    <span className={`w-[15px] shrink-0 text-center font-serif text-[18px] italic leading-none ${iconClass}`}>ƒ</span>
  ) : (
    <meta.icon className={`size-[15px] shrink-0 ${iconClass}`} />
  );
  return (
    <div className={`-mx-3 flex h-full w-[calc(100%+24px)] items-center overflow-hidden transition ${props.active ? "bg-blue-600 text-white" : "hover:bg-bg-weak-50"}`}>
      <button
        type="button"
        title="Select column (Shift-click to extend)"
        onClick={(event) => props.onSelect(event.shiftKey)}
        onDoubleClick={(event) => {
          event.preventDefault();
          props.onOpen(event.currentTarget.getBoundingClientRect());
        }}
        className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch pl-3 text-left"
      >
        {icon}
        <span className={`truncate font-semibold ${props.active ? "text-white" : "text-text-strong-950"}`}>{props.displayName}</span>
      </button>
      <button
        type="button"
        title={`Configure ${props.displayName}`}
        aria-label={`Configure ${props.displayName}`}
        onClick={(event) => {
          event.stopPropagation();
          props.onOpen(event.currentTarget.getBoundingClientRect());
        }}
        className={`rounded-md p-1 ${props.active ? "text-white hover:bg-blue-500" : "text-text-soft-400 hover:bg-bg-weak-50 hover:text-text-strong-950"}`}
      >
        <RiArrowDownSLine className="size-4" />
      </button>
      {props.onRun && (
        <button type="button" title="Run column" aria-label={`Run ${props.displayName}`} onClick={(event) => { event.stopPropagation(); props.onRun?.(event.currentTarget.getBoundingClientRect()); }} className={`mr-1 rounded-md border p-1.5 ${props.active ? "border-blue-400 text-white hover:bg-blue-500" : "border-stroke-soft-200 bg-bg-white-0 text-text-strong-950 hover:bg-bg-weak-50"}`}>
          <RiPlayLine className="size-4" />
        </button>
      )}
    </div>
  );
}

/** The trailing "+ Add column" header cell. */
function AddColumnHeader(props: IHeaderParams & { onOpen: (rect: DOMRect) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => props.onOpen(e.currentTarget.getBoundingClientRect())}
      className="-mx-3 flex h-full w-[calc(100%+24px)] items-center gap-1.5 px-3 text-text-sub-600 transition hover:bg-bg-weak-50"
    >
      <RiAddLine className="size-[15px] shrink-0" />
      <span className="font-medium">Add column</span>
    </button>
  );
}

/** Selection gutter: keep row numbers visible until hover, then reveal selection. */
function GutterHeader(props: IHeaderParams & {
  checked: boolean | "indeterminate";
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex size-full items-center justify-center">
      <Checkbox.Root
        checked={props.checked}
        onCheckedChange={(checked) => props.onCheckedChange(checked !== false)}
        aria-label="Select all rows on this page"
      />
    </div>
  );
}

function GutterCell(props: ICellRendererParams<RowData> & {
  isSelected: (rowId: string) => boolean;
  onToggle: (rowId: string) => void;
}) {
  if (props.node.rowPinned === "top") {
    return <span className="text-[13px] font-medium text-text-soft-400">%</span>;
  }
  const rowOffset = Number((props as ICellRendererParams<RowData> & { rowOffset?: number }).rowOffset ?? 0);
  const selected = props.isSelected(props.data!.__id);
  return (
    <div className="group relative flex size-full items-center justify-center">
      <span className={`text-[13px] tabular-nums text-text-soft-400 ${selected ? "hidden" : "group-hover:hidden group-focus-within:hidden"}`}>
        {rowOffset + (props.node.rowIndex ?? 0) + 1}
      </span>
      <Checkbox.Root
        checked={selected}
        onCheckedChange={() => props.onToggle(props.data!.__id)}
        aria-label={`${selected ? "Deselect" : "Select"} row ${rowOffset + (props.node.rowIndex ?? 0) + 1}`}
        className={`absolute inset-0 m-auto ${selected ? "" : "invisible group-hover:visible group-focus-within:visible"}`}
      />
    </div>
  );
}

/** A run that finished without finding anything (the server marks it outcome "miss"). */
function isMiss(meta: CellMeta | undefined): boolean {
  return (meta as { outcome?: string } | undefined)?.outcome === "miss";
}

/** A run that finished without finding anything, as opposed to one that has not run. */
const NO_RESULT = <span className="italic text-text-soft-400">No result</span>;

function IntegrationActionCell(props: ICellRendererParams<RowData> & { onRun?: (rowId: string) => void; disabled?: boolean }) {
  if (props.node.rowPinned === "top") return props.value ?? "";
  const meta = props.data?.__meta?.[props.colDef?.field ?? ""] as CellMeta | undefined;
  const inProgress = meta?.status === "queued" || meta?.status === "running" || meta?.status === "processing";

  let content: React.ReactNode;
  if (meta?.status === "queued") {
    content = <span className="flex items-center gap-1.5 text-text-sub-600"><RiTimeLine className="size-4" />Queued…</span>;
  } else if (meta?.status === "running") {
    content = <span className="flex items-center gap-1.5 text-text-sub-600"><RiLoader4Line className="size-4 animate-spin" />Running…</span>;
  } else if (meta?.status === "processing") {
    content = <span className="flex items-center gap-1.5 text-blue-600 dark:text-blue-400"><RiLoader4Line className="size-4 animate-spin" />Waiting for provider…</span>;
  } else if (meta?.status === "error") {
    content = <span title={meta.error} className="flex items-center gap-1.5 truncate font-medium text-red-700 dark:text-red-400"><RiCloseCircleLine className="size-4 shrink-0" /><span className="truncate">{meta.error || "API call failed"}</span></span>;
  } else if (meta?.status === "success" && isMiss(meta) && (props.value === undefined || props.value === null || props.value === "")) {
    content = NO_RESULT;
  } else if (meta?.status === "success") {
    content = <span className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400"><RiCheckboxCircleLine className="size-4" />{String(props.value ?? "Completed")}</span>;
  } else {
    content = <span className="text-text-soft-400">Not run</span>;
  }

  return (
    <div className="group/action flex size-full min-w-0 items-center gap-2">
      <div className="min-w-0 flex-1 truncate">{content}</div>
      {!inProgress && props.data && props.onRun && (
        <button
          type="button"
          disabled={props.disabled}
          title="Run this row"
          aria-label="Run this row"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            props.onRun?.(props.data!.__id);
          }}
          className="shrink-0 rounded-md bg-blue-600 p-1 text-white opacity-0 shadow-sm transition hover:bg-blue-700 focus:opacity-100 disabled:cursor-not-allowed disabled:bg-blue-300 group-hover/action:opacity-100"
        >
          <RiPlayLine className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** Result cell for HTTP and formula columns: the value, or why there isn't one yet. */
function RunnerValueCell(props: ICellRendererParams<RowData> & { onRun?: (rowId: string) => void; disabled?: boolean }) {
  if (props.node.rowPinned === "top") return props.valueFormatted ?? props.value ?? "";
  const meta = props.data?.__meta?.[props.colDef?.field ?? ""] as CellMeta | undefined;
  const inProgress = meta?.status === "queued" || meta?.status === "running" || meta?.status === "processing";
  const text = props.valueFormatted ?? (props.value === undefined || props.value === null ? "" : String(props.value));

  let content: React.ReactNode;
  if (meta?.status === "queued") {
    content = <span className="flex items-center gap-1.5 text-text-sub-600"><RiTimeLine className="size-4" />Queued…</span>;
  } else if (meta?.status === "running" || meta?.status === "processing") {
    content = <span className="flex items-center gap-1.5 text-text-sub-600"><RiLoader4Line className="size-4 animate-spin" />Running…</span>;
  } else if (meta?.status === "error") {
    content = <span title={meta.error} className="flex items-center gap-1.5 truncate font-medium text-red-700 dark:text-red-400"><RiCloseCircleLine className="size-4 shrink-0" /><span className="truncate">{meta.error || "Run failed"}</span></span>;
  } else if (isMiss(meta) && text === "") {
    content = NO_RESULT;
  } else {
    content = <span title={text}>{text}</span>;
  }

  return (
    <div className="group/action flex size-full min-w-0 items-center gap-2">
      <div className="min-w-0 flex-1 truncate">{content}</div>
      {!inProgress && props.data && props.onRun && (
        <button
          type="button"
          disabled={props.disabled}
          title="Run this row"
          aria-label="Run this row"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            props.onRun?.(props.data!.__id);
          }}
          className="shrink-0 rounded-md bg-blue-600 p-1 text-white opacity-0 shadow-sm transition hover:bg-blue-700 focus:opacity-100 disabled:cursor-not-allowed disabled:bg-blue-300 group-hover/action:opacity-100"
        >
          <RiPlayLine className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function IntegrationOutputCell(props: ICellRendererParams<RowData> & { sourceColumnKey?: string; valueType?: ColumnType; ungrouped?: boolean }) {
  if (props.node.rowPinned === "top") return props.value ?? "";
  if (props.value !== undefined && props.value !== null && props.value !== "") {
    const type = props.valueType ?? "text";
    if (type === "image" && typeof props.value === "string") {
      const src = props.value.trim();
      if (/^(?:https?:\/\/|data:image\/)/i.test(src)) {
        // eslint-disable-next-line @next/next/no-img-element
        return <img src={src} alt="Generated result" className="h-8 max-w-full rounded object-cover" />;
      }
    }
    const href = displayHref(props.value, type);
    if (href) {
      return <a href={href} target={type === "email" ? undefined : "_blank"} rel={type === "email" ? undefined : "noreferrer"} onClick={(event) => event.stopPropagation()} className="truncate text-blue-600 dark:text-blue-400 hover:underline">{String(props.value)}</a>;
    }
    if (type === "date") {
      const raw = String(props.value);
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
      const parsed = new Date(raw);
      if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleString();
    }
    if (type === "number" && Number.isFinite(Number(props.value))) return Number(props.value).toLocaleString(undefined, props.ungrouped ? { useGrouping: false } : undefined);
    if (type === "boolean") {
      const checked = props.value === true || props.value === 1 || String(props.value).toLowerCase() === "true";
      return <span className="flex items-center gap-1.5"><RiCheckboxCircleLine className={`size-4 ${checked ? "text-emerald-600 dark:text-emerald-400" : "text-text-disabled-300"}`} />{checked ? "True" : "False"}</span>;
    }
    if (type === "json" || typeof props.value === "object") {
      const json = JSON.stringify(props.value);
      return <span title={json} className="block truncate font-mono text-[13px] text-text-sub-600">{json}</span>;
    }
    return String(props.value);
  }
  const sourceMeta = props.sourceColumnKey
    ? props.data?.__meta?.[props.sourceColumnKey] as CellMeta | undefined
    : undefined;
  if (sourceMeta?.status === "queued" || sourceMeta?.status === "running" || sourceMeta?.status === "processing") {
    return <span className="flex items-center gap-1.5 italic text-text-soft-400"><RiTimeLine className="size-4" />Waiting for result…</span>;
  }
  if (sourceMeta?.status === "error") {
    return <span className="italic text-text-soft-400">Action failed</span>;
  }
  if (isMiss(sourceMeta)) return NO_RESULT;
  return "";
}

function AddRowsControl(props: {
  addRows: number;
  busy: boolean;
  onAdd: () => void;
  onCountChange: (count: number) => void;
}) {
  return (
    <div className="flex h-full items-center gap-2 bg-bg-white-0 px-3">
      <button
        type="button"
        onClick={props.onAdd}
        disabled={props.busy}
        className="flex items-center gap-1.5 rounded-lg border border-stroke-soft-200 px-2.5 py-[7px] text-[15px] font-medium text-text-strong-950 transition hover:bg-bg-weak-50 disabled:opacity-50"
      >
        <RiAddLine className="size-4" />
        Add
      </button>
      <input
        type="number"
        min={1}
        max={1000}
        value={props.addRows}
        onChange={(event) =>
          props.onCountChange(Math.max(1, Math.min(1000, Number(event.target.value) || 1)))
        }
        className="w-[68px] rounded-lg border border-stroke-soft-200 px-2 py-[7px] text-[15px] text-text-strong-950 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
      />
      <span className="text-[15px] text-text-sub-600">more rows at the bottom</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export default function GridClient({
  table,
  columns: initialColumns,
  rows: initialRows,
  cursor: initialCursor,
  total,
  unfilteredTotal: initialUnfiltered,
  coverage: initialCoverage,
  initialActiveJobs,
  view: initialView,
  onTableChanged,
}: {
  table: GridTable;
  columns: GridColumn[];
  rows: GridRow[];
  cursor: number;
  total: number;
  unfilteredTotal: number;
  coverage: Record<string, number>;
  initialActiveJobs: number;
  view: TableView;
  onTableChanged?: () => void;
}) {
  const dialogs = useDialogs();
  const [columns, setColumns] = useState(initialColumns);
  const [rowData, setRowData] = useState<RowData[]>(() => toRowData(initialRows));
  const [coverage, setCoverage] = useState(initialCoverage);
  const [rowCount, setRowCount] = useState(total);
  const [unfiltered, setUnfiltered] = useState(initialUnfiltered);
  const [autoRun, setAutoRun] = useState(table.autoRun);
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
  const [allMatchingSelected, setAllMatchingSelected] = useState(false);
  const [activeJobs, setActiveJobs] = useState(initialActiveJobs);
  const [addRows, setAddRows] = useState(10);
  const [page, setPage] = useState(0);

  const [view, setView] = useState<TableView>(initialView ?? {});
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");

  const [panel, setPanel] = useState<{ name: PanelName; rect: DOMRect } | null>(null);
  const [addMenu, setAddMenu] = useState<{
    rect: DOMRect;
    afterColumnId?: string;
    beforeColumnId?: string;
  } | null>(null);
  const [columnMenu, setColumnMenu] = useState<{ column: GridColumn; rect: DOMRect } | null>(null);
  const [runMenu, setRunMenu] = useState<{ column: GridColumn; rect: DOMRect } | null>(null);
  const [rowActionsRect, setRowActionsRect] = useState<DOMRect | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [createCampaignOpen, setCreateCampaignOpen] = useState(false);
  const [configuring, setConfiguring] = useState<{
    type: "formula" | "http";
    column?: GridColumn;
    afterColumnId?: string;
    beforeColumnId?: string;
  } | null>(null);
  const [enrichmentPosition, setEnrichmentPosition] = useState<{
    column?: GridColumn;
    afterColumnId?: string;
    beforeColumnId?: string;
  } | null>(null);
  const [aiPosition, setAiPosition] = useState<{
    column?: GridColumn;
    afterColumnId?: string;
    beforeColumnId?: string;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cellDetails, setCellDetails] = useState<CellDetailsSelection | null>(null);
  const [cellRange, setCellRange] = useState<CellRange | null>(null);
  const [fillTargetRow, setFillTargetRow] = useState<number | null>(null);
  const [columnDisplayOrder, setColumnDisplayOrder] = useState<string[]>([]);
  const [cellSavingLabel, setCellSavingLabel] = useState<string | null>(null);
  const [historyCounts, setHistoryCounts] = useState({ undo: 0, redo: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Progress polling: `watching` is switched on by anything that can queue work
  // (a run, a dialog save, an edit with auto-run); `pollSuspended` is the
  // give-up latch for cells that stay "running" with no job behind them.
  const [watching, setWatching] = useState(false);
  const [pollSuspended, setPollSuspended] = useState(false);
  const [stopping, setStopping] = useState(false);

  const graceUntilRef = useRef(0);
  const rowDataRef = useRef<RowData[]>([]);
  const refetchRef = useRef<(search?: string, pageIndex?: number) => Promise<void>>(async () => {});
  const cursorRef = useRef(initialCursor);
  const refetchSequence = useRef(0);
  // Saved-view bookkeeping: the last view the server confirmed (to roll back a
  // failed save), the newest save's sequence number, and how many are in flight
  // (a refetch must not overwrite the optimistic view while one is).
  const committedViewRef = useRef<TableView>(initialView ?? {});
  const viewSaveSequence = useRef(0);
  const viewSavesInFlight = useRef(0);
  const gridRef = useRef<AgGridReact<RowData>>(null);
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const fillHandleElementRef = useRef<HTMLDivElement>(null);
  const selectingCellsRef = useRef(false);
  const fillDragRef = useRef<{ pointerId: number; targetRow: number } | null>(null);
  const pointerMoveFrameRef = useRef<number | null>(null);
  const pendingPointerRef = useRef<{ clientX: number; clientY: number; pointerId: number } | null>(null);
  const cellOperationRef = useRef(false);
  const undoStackRef = useRef<CellEditCommand[]>([]);
  const redoStackRef = useRef<CellEditCommand[]>([]);

  // Toasts float over the grid and clear themselves: errors linger longer.
  useEffect(() => {
    if (!notice) return;

    const timeout = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!error) return;

    const timeout = window.setTimeout(() => setError(null), 10000);
    return () => window.clearTimeout(timeout);
  }, [error]);

  // The details panel would sit on top of a column setup dialog.
  const columnDialogOpen = Boolean(configuring || enrichmentPosition || aiPosition);
  if (columnDialogOpen && cellDetails) setCellDetails(null);

  useEffect(() => {
    const finishSelection = () => {
      selectingCellsRef.current = false;
    };
    window.addEventListener("pointerup", finishSelection);
    window.addEventListener("blur", finishSelection);
    return () => {
      window.removeEventListener("pointerup", finishSelection);
      window.removeEventListener("blur", finishSelection);
      if (pointerMoveFrameRef.current !== null) {
        window.cancelAnimationFrame(pointerMoveFrameRef.current);
      }
    };
  }, []);

  const hidden = useMemo(() => view.hiddenColumns ?? [], [view.hiddenColumns]);
  const pinned = useMemo(() => view.pinnedColumns ?? [], [view.pinnedColumns]);
  const visibleColumns = useMemo(
    () => columns.filter((column) => !hidden.includes(column.key)),
    [columns, hidden],
  );
  const displayedColumns = useMemo(() => {
    const byKey = new Map(visibleColumns.map((column) => [column.key, column]));
    const ordered = columnDisplayOrder
      .map((key) => byKey.get(key))
      .filter((column): column is GridColumn => Boolean(column));
    const seen = new Set(ordered.map((column) => column.key));
    return [...ordered, ...visibleColumns.filter((column) => !seen.has(column.key))];
  }, [columnDisplayOrder, visibleColumns]);
  const displayedColumnKeys = useMemo(
    () => displayedColumns.map((column) => column.key),
    [displayedColumns],
  );
  const normalizedCellRange = useMemo(
    () => normalizeCellRange(cellRange, displayedColumnKeys, rowData.length),
    [cellRange, displayedColumnKeys, rowData.length],
  );

  const paintCellSelection = useCallback(() => {
    const root = gridContainerRef.current;
    if (!root) return;
    const fillHandle = fillHandleElementRef.current;
    if (fillHandle) fillHandle.hidden = true;
    const cells = root.querySelectorAll<HTMLElement>(".ag-row[row-index] .ag-cell[col-id]");
    for (const cell of cells) {
      cell.querySelector(":scope > .grid-cell-duplicate-label")?.remove();
      cell.classList.remove(
        "grid-cell-range",
        "grid-cell-range-top",
        "grid-cell-range-bottom",
        "grid-cell-range-left",
        "grid-cell-range-right",
        "grid-cell-fill-handle-cell",
        "grid-cell-fill-preview",
      );
      if (!normalizedCellRange || cell.closest(".ag-floating-top")) continue;
      const row = Number(cell.closest<HTMLElement>(".ag-row[row-index]")?.getAttribute("row-index"));
      const column = displayedColumnKeys.indexOf(cell.getAttribute("col-id") ?? "");
      if (!Number.isInteger(row) || column < 0) continue;

      const selected = row >= normalizedCellRange.startRow
        && row <= normalizedCellRange.endRow
        && column >= normalizedCellRange.startColumn
        && column <= normalizedCellRange.endColumn;
      if (selected) {
        cell.classList.add("grid-cell-range");
        if (row === normalizedCellRange.startRow) cell.classList.add("grid-cell-range-top");
        if (row === normalizedCellRange.endRow) cell.classList.add("grid-cell-range-bottom");
        if (column === normalizedCellRange.startColumn) cell.classList.add("grid-cell-range-left");
        if (column === normalizedCellRange.endColumn) cell.classList.add("grid-cell-range-right");
        if (row === normalizedCellRange.endRow && column === normalizedCellRange.endColumn) {
          cell.classList.add("grid-cell-fill-handle-cell");
          if (fillHandle) {
            const cellRect = cell.getBoundingClientRect();
            const rootRect = root.getBoundingClientRect();
            fillHandle.style.transform = `translate3d(${cellRect.right - rootRect.left - 9}px, ${cellRect.bottom - rootRect.top - 9}px, 0)`;
            fillHandle.hidden = false;
          }
        }
      }

      const previewed = fillTargetRow !== null
        && column >= normalizedCellRange.startColumn
        && column <= normalizedCellRange.endColumn
        && isStaticColumnType(displayedColumns[column]?.type)
        && (fillTargetRow < normalizedCellRange.startRow
          ? row >= fillTargetRow && row < normalizedCellRange.startRow
          : row > normalizedCellRange.endRow && row <= fillTargetRow);
      if (previewed) {
        cell.classList.add("grid-cell-fill-preview");
        const label = document.createElement("span");
        label.className = "grid-cell-duplicate-label";
        const sourceRowIndex = fillSourceRowIndex(normalizedCellRange, fillTargetRow, row);
        const previewValue = rowData[sourceRowIndex]?.[displayedColumns[column].key];
        label.textContent = fillPreviewText(previewValue);
        label.title = label.textContent;
        cell.appendChild(label);
      }
    }
  }, [displayedColumnKeys, displayedColumns, fillTargetRow, normalizedCellRange, rowData]);

  useLayoutEffect(() => {
    paintCellSelection();
  }, [paintCellSelection]);

  useEffect(() => {
    const root = gridContainerRef.current;
    if (!root) return;
    let frame = 0;
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(paintCellSelection);
    };
    root.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      root.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.cancelAnimationFrame(frame);
    };
  }, [paintCellSelection]);
  const filters = (view.filters as FilterGroup | undefined) ?? EMPTY_FILTERS;
  const sorts = (view.sorts as SortSpec[] | undefined) ?? [];

  const activeFilterCount = useMemo(() => countActiveFilters(filters), [filters]);

  const aiOutputSources = useMemo(() => {
    const result = new Map<string, { sourceColumnKey: string; valueType: ColumnType }>();
    for (const source of columns) {
      if (source.type !== "ai") continue;
      const config = source.config as AiConfig;
      for (const [outputKey, columnKey] of Object.entries(config.outputColumns ?? {})) {
        const configuredType = config.outputs?.find((field) => field.key === outputKey)?.type;
        result.set(columnKey, {
          sourceColumnKey: source.key,
          valueType: configuredType
            ?? (config.useCase === "image-generation" ? "image" : config.outputFormat === "json_schema" ? "json" : "text"),
        });
      }
    }
    for (const output of columns) {
      if (output.type !== "ai_output") continue;
      const config = output.config as AiOutputConfig;
      result.set(output.key, { sourceColumnKey: config.sourceColumnKey, valueType: config.valueType });
    }
    return result;
  }, [columns]);

  // Re-seed when the active sheet changes.
  useEffect(() => {
    refetchSequence.current += 1;
    viewSaveSequence.current += 1;
    viewSavesInFlight.current = 0;
    committedViewRef.current = initialView ?? {};
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: effect resets/seeds local state when props or open state change; deriving during render would change timing
    setColumns(initialColumns);
    setRowData(toRowData(initialRows));
    setCoverage(initialCoverage);
    setRowCount(total);
    setUnfiltered(initialUnfiltered);
    setAutoRun(table.autoRun);
    setActiveJobs(initialActiveJobs);
    setView(initialView ?? {});
    setSearch("");
    setAppliedSearch("");
    setPage(0);
    setSelectedRowIds([]);
    setAllMatchingSelected(false);
    setCellDetails(null);
    setCellRange(null);
    setFillTargetRow(null);
    setColumnDisplayOrder([]);
    undoStackRef.current = [];
    redoStackRef.current = [];
    setHistoryCounts({ undo: 0, redo: 0 });
    cursorRef.current = initialCursor;
    // Keyed on the table only. The initial* props are the page-load payload;
    // re-seeding when any of them (or table.autoRun) changes would throw away
    // every edit and column made since, e.g. after toggling Auto-run and renaming.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table.id]);

  const refetch = useCallback(
    async (searchTerm = appliedSearch, pageIndex = page) => {
      const sequence = ++refetchSequence.current;
      const requestPage = async (index: number) => {
        const qs = new URLSearchParams({
          limit: String(GRID_PAGE_SIZE),
          offset: String(index * GRID_PAGE_SIZE),
        });
        if (searchTerm) qs.set("search", searchTerm);
        const response = await fetch(`/api/grid/tables/${table.id}?${qs}`);
        return { response, data: await response.json() };
      };

      let { response: res, data: d } = await requestPage(pageIndex);
      if (sequence !== refetchSequence.current) return;
      if (!res.ok) {
        setError(d.error ?? "Could not load rows");
        return;
      }
      const safePage = clampGridPage(pageIndex, d.total);
      if (safePage !== pageIndex) {
        ({ response: res, data: d } = await requestPage(safePage));
        if (sequence !== refetchSequence.current) return;
        if (!res.ok) {
          setError(d.error ?? "Could not load rows");
          return;
        }
      }
      setPage(safePage);
      setError(null);
      setColumns(d.columns);
      setRowData(toRowData(d.rows));
      setCoverage(d.coverage ?? {});
      setActiveJobs(d.activeJobs ?? 0);
      setRowCount(d.total);
      setUnfiltered(d.unfilteredTotal ?? d.total);
      // A view save still in flight owns the view: its optimistic value is
      // newer than anything this response saw, and overwriting it would snap a
      // controlled input back while the person is typing.
      const serverView: TableView = d.view ?? {};
      if (viewSavesInFlight.current === 0) {
        committedViewRef.current = serverView;
        setView(serverView);
      }
      // Newly added or reordered columns take their server position at once
      // instead of waiting at the far right until a reload.
      setColumnDisplayOrder(displayOrderFor(d.columns, serverView.pinnedColumns ?? []));
      // The selection survives a refetch of the same page (a poll finishing,
      // an edit saving); it only means something while the page is unchanged.
      if (safePage !== page) setCellRange(null);
      setFillTargetRow(null);
      cursorRef.current = d.cursor;
    },
    [table.id, appliedSearch, page],
  );

  /**
   * Filters, sorts and hidden columns are part of the saved view, so every
   * change persists and then refetches. Search is deliberately NOT saved — it
   * is a transient lookup, not a property of the table.
   */
  const saveView = useCallback(
    async (next: TableView) => {
      const sequence = ++viewSaveSequence.current;
      viewSavesInFlight.current += 1;
      let saved = false;
      setView(next);
      setBusy(true);
      try {
        const res = await fetch(`/api/grid/tables/${table.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ view: next }),
        });
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          throw new Error(b.error ?? "Could not save the view");
        }
        saved = true;
        committedViewRef.current = next;
      } catch (cause) {
        // Put back what the server still has, unless a newer save has already
        // replaced the optimistic view (that one decides the final state).
        if (sequence === viewSaveSequence.current) setView(committedViewRef.current);
        setError(cause instanceof Error ? cause.message : "Could not save the view");
      } finally {
        viewSavesInFlight.current -= 1;
      }
      try {
        // A newer save supersedes this one's refetch; it will load the rows.
        if (saved && sequence === viewSaveSequence.current) {
          setPage(0);
          setSelectedRowIds([]);
          setAllMatchingSelected(false);
          setCellRange(null);
          await refetch(appliedSearch, 0);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not load rows");
      } finally {
        setBusy(false);
      }
    },
    [table.id, refetch, appliedSearch],
  );

  const runSearch = useCallback(
    async (term: string) => {
      setAppliedSearch(term);
      setPage(0);
      setSelectedRowIds([]);
      setAllMatchingSelected(false);
      setCellRange(null);
      setBusy(true);
      try {
        await refetch(term, 0);
      } finally {
        setBusy(false);
      }
    },
    [refetch],
  );

  useEffect(() => {
    rowDataRef.current = rowData;
  }, [rowData]);
  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);

  const pendingCells = useMemo(() => hasPendingCells(rowData), [rowData]);

  /**
   * Called after anything that can queue work. The run endpoints answer with a
   * job count, but a short run can already be finished (0) by the time the
   * grid refetches, and a count alone never started polling for cells that
   * were queued by a dialog or an edit. The grace window keeps polling alive
   * long enough to see the first results either way.
   */
  const startWatching = useCallback((graceMs = 15000) => {
    graceUntilRef.current = Math.max(graceUntilRef.current, Date.now() + graceMs);
    setPollSuspended(false);
    setWatching(true);
  }, []);

  // Poll while jobs are active, while any loaded cell is queued/running, or
  // inside the grace window after a start. Also true on mount when the first
  // page already has work in flight. Backs off from 1.5s to 5s, gives up after
  // 20 minutes, and always ends with one authoritative refetch.
  const shouldPoll = !pollSuspended && (activeJobs > 0 || pendingCells || watching);
  useEffect(() => {
    if (!shouldPoll) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let ticks = 0;
    const startedAt = Date.now();

    const finish = async (giveUp: boolean) => {
      setWatching(false);
      if (giveUp) setPollSuspended(true);
      try {
        await refetchRef.current();
      } catch {
        // The next action refetches; nothing more to do here.
      }
    };

    const tick = async () => {
      if (cancelled) return;
      let next = ticks < 20 ? 1500 : ticks < 60 ? 3000 : 5000;
      ticks += 1;
      try {
        const res = await fetch(`/api/grid/tables/${table.id}/changes?cursor=${cursorRef.current}`);
        if (cancelled) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d: { rows: GridRow[]; cursor: number; activeJobs: number } = await res.json();
        if (cancelled) return;
        failures = 0;
        // Applying a change replaces row objects under the grid, which can
        // cancel a cell the person is typing into. The cursor is left where it
        // was, so the next tick picks the same changes up once they are done.
        if (!gridRef.current?.api?.getEditingCells().length) {
          cursorRef.current = d.cursor;
          setActiveJobs(d.activeJobs);
          const changed = toRowData(d.rows);
          if (changed.length) {
            setRowData((prev) => {
              const byId = new Map(prev.map((r) => [r.__id, r]));
              for (const r of changed) {
                if (byId.has(r.__id)) byId.set(r.__id, r);
              }
              return [...byId.values()];
            });
          }
          const changedIds = new Set(changed.map((r) => r.__id));
          const stillPending =
            hasPendingCells(changed) ||
            hasPendingCells(rowDataRef.current.filter((r) => !changedIds.has(r.__id)));
          if (d.activeJobs === 0 && !stillPending && Date.now() >= graceUntilRef.current) {
            // Reconcile from the authoritative snapshot: clears any optimistic
            // queued/running state an incremental poll missed at the moment the
            // final job left the queue.
            await finish(false);
            return;
          }
        }
        if (Date.now() - startedAt > 20 * 60 * 1000) {
          await finish(true);
          return;
        }
      } catch (cause) {
        // A blip is retried; a poll that keeps failing (signed out, server
        // down) stops instead of hammering the API.
        failures += 1;
        if (failures >= 5 && !cancelled) {
          setWatching(false);
          setPollSuspended(true);
          setError(
            `Lost contact with the server while checking progress${cause instanceof Error ? ` (${cause.message})` : ""}. Reload the page to see the latest results.`,
          );
          return;
        }
        next = 3000;
      }
      if (!cancelled) timer = setTimeout(() => void tick(), next);
    };

    timer = setTimeout(() => void tick(), 1500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [shouldPoll, table.id]);

  /* ---- mutations ---- */

  const addColumn = useCallback(
    async (type: ColumnType) => {
      if (type === "enrichment") {
        setEnrichmentPosition({
          afterColumnId: addMenu?.afterColumnId,
          beforeColumnId: addMenu?.beforeColumnId,
        });
        return;
      }
      if (type === "ai") {
        setAiPosition({
          afterColumnId: addMenu?.afterColumnId,
          beforeColumnId: addMenu?.beforeColumnId,
        });
        return;
      }
      if (type === "formula" || type === "http") {
        setConfiguring({
          type,
          afterColumnId: addMenu?.afterColumnId,
          beforeColumnId: addMenu?.beforeColumnId,
        });
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/grid/tables/${table.id}/columns`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: columnTypeMeta(type).label,
            type,
            afterColumnId: addMenu?.afterColumnId,
            beforeColumnId: addMenu?.beforeColumnId,
          }),
        });
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          setError(b.error ?? "Could not add column");
          return;
        }
        await refetch();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not add column");
      } finally {
        setBusy(false);
      }
    },
    [table.id, refetch, addMenu],
  );

  const patchColumn = useCallback(
    async (column: GridColumn, patch: Record<string, unknown>) => {
      setError(null);
      const res = await fetch(`/api/grid/tables/${table.id}/columns/${column.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not update column");
      await refetch();
    },
    [refetch, table.id],
  );

  const duplicateColumn = useCallback(
    async (column: GridColumn) => {
      const res = await fetch(`/api/grid/tables/${table.id}/columns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${column.name} copy`,
          type: column.type,
          config: column.config,
          autoRun: column.autoRun,
          afterColumnId: column.id,
          // A static column holds typed values, so the copy carries them too.
          ...(isStaticColumnType(column.type) ? { copyValuesFrom: column.key } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not duplicate column");
      await refetch();
    },
    [refetch, table.id],
  );

  const splitColumn = useCallback(
    async (column: GridColumn, delimiter: "comma" | "space" | "semicolon" | "pipe") => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/grid/tables/${table.id}/columns/${column.id}/text-to-columns`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ delimiter }),
          },
        );
        const data: { columnsCreated?: number; rowsUpdated?: number; error?: string } = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error ?? "Could not split this column");
        await refetch();
        setNotice(`Created ${data.columnsCreated ?? 0} text column${data.columnsCreated === 1 ? "" : "s"}.`);
      } finally {
        setBusy(false);
      }
    },
    [refetch, table.id],
  );

  const dedupeColumn = useCallback(
    async (column: GridColumn) => {
      const confirmed = await dialogs.confirm({
        title: `Remove duplicate ${column.name} rows?`,
        description: `Rows with the same non-empty value in “${column.name}” will be deleted, keeping the first row. Other column values in those duplicate rows will also be deleted.`,
        confirmLabel: "Remove duplicate rows",
        variant: "error",
      });
      if (!confirmed) return;

      setBusy(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/grid/tables/${table.id}/columns/${column.id}/dedupe`,
          { method: "POST" },
        );
        const data: { deleted?: number; error?: string } = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error ?? "Could not remove duplicate rows");
        if (data.deleted) {
          undoStackRef.current = [];
          redoStackRef.current = [];
          setHistoryCounts({ undo: 0, redo: 0 });
        }
        setSelectedRowIds([]);
        setAllMatchingSelected(false);
        setCellRange(null);
        await refetch();
        const deleted = data.deleted ?? 0;
        setNotice(deleted
          ? `Removed ${deleted.toLocaleString()} duplicate row${deleted === 1 ? "" : "s"}.`
          : "No duplicate non-empty values were found.");
      } finally {
        setBusy(false);
      }
    },
    [dialogs, refetch, table.id],
  );

  const deleteColumnFromMenu = useCallback(
    async (column: GridColumn) => {
      // A source's own result columns go with it; anything else that reads
      // the source or one of its results must be dealt with first.
      const outputs = outputColumnsOf(column, columns);
      const removing = new Set([column.key, ...outputs.map((output) => output.key)]);
      const usedIn = columns.filter(
        (candidate) =>
          !removing.has(candidate.key) && candidate.dependsOn.some((key) => removing.has(key)),
      );
      if (usedIn.length) {
        setError(`“${column.name}” is used by ${usedIn.map((item) => item.name).join(", ")}. Remove those references first.`);
        return;
      }
      const ok = await dialogs.confirm({
        title: outputs.length ? "Delete column and its outputs?" : "Delete column?",
        description: outputs.length
          ? `“${column.name}” will be permanently deleted along with ${outputs.length} output column${outputs.length === 1 ? "" : "s"} (${outputs.map((output) => output.name).join(", ")}) and every value in them. This cannot be undone.`
          : `“${column.name}” and every value in it will be permanently deleted. This cannot be undone.`,
        confirmLabel: outputs.length ? `Delete ${outputs.length + 1} columns` : "Delete column",
        variant: "error",
      });
      if (!ok) return;
      const res = await fetch(
        `/api/grid/tables/${table.id}/columns/${column.id}${outputs.length ? "?withOutputs=1" : ""}`,
        { method: "DELETE" },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not delete column");
      // Cell history can reference this column, so discard it after a
      // destructive schema change instead of offering a stale undo action.
      undoStackRef.current = [];
      redoStackRef.current = [];
      setHistoryCounts({ undo: 0, redo: 0 });
      await refetch();
    },
    [columns, dialogs, refetch, table.id],
  );

  const deleteSelectedRows = useCallback(async () => {
    if (!selectedRowIds.length) return;
    const count = selectedRowIds.length;
    const ok = await dialogs.confirm({
      title: `Delete ${count} row${count === 1 ? "" : "s"}?`,
      description: "The selected rows and all of their values will be permanently deleted. This cannot be undone.",
      confirmLabel: `Delete ${count} row${count === 1 ? "" : "s"}`,
      variant: "error",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/grid/tables/${table.id}/rows`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowIds: selectedRowIds }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not delete rows");
        return;
      }
      setSelectedRowIds([]);
      setAllMatchingSelected(false);
      setCellRange(null);
      setRowActionsRect(null);
      // Deleted row IDs cannot safely participate in later cell undo/redo.
      undoStackRef.current = [];
      redoStackRef.current = [];
      setHistoryCounts({ undo: 0, redo: 0 });
      setNotice(`Deleted ${data.deleted} row${data.deleted === 1 ? "" : "s"}.`);
      await refetch();
    } finally {
      setBusy(false);
    }
  }, [dialogs, refetch, selectedRowIds, table.id]);

  const exportSelectedRows = useCallback(async () => {
    if (!selectedRowIds.length) return;
    const orderedRowIds = allMatchingSelected
      ? selectedRowIds
      : rowData.map((row) => row.__id).filter((rowId) => selectedRowIds.includes(rowId));
    setBusy(true);
    setError(null);
    setRowActionsRect(null);
    try {
      const response = await fetch(`/api/grid/tables/${table.id}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rowIds: orderedRowIds,
          columnKeys: displayedColumns.length
            ? displayedColumns.map((column) => column.key)
            : undefined,
        }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setError(data.error ?? "Could not export the selected rows");
        return;
      }

      const disposition = response.headers.get("Content-Disposition") ?? "";
      const fileName = disposition.match(/filename="([^"]+)"/)?.[1] ?? "selected-rows.csv";
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setNotice(`Exported ${orderedRowIds.length.toLocaleString()} selected row${orderedRowIds.length === 1 ? "" : "s"}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not export the selected rows");
    } finally {
      setBusy(false);
    }
  }, [allMatchingSelected, displayedColumns, rowData, selectedRowIds, table.id]);

  const appendRows = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/grid/tables/${table.id}/rows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: addRows }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error ?? "Could not add rows");
        return;
      }

      const created = Array.isArray(data.rows) ? data.rows.length : addRows;
      const hasQuery = Boolean(appliedSearch) || activeFilterCount > 0 || sorts.length > 0;
      if (hasQuery) {
        setNotice(`Added ${created} row${created === 1 ? "" : "s"}. Clear filters or sorting to view them at the end.`);
        await refetch();
      } else {
        const lastPage = clampGridPage(Number.MAX_SAFE_INTEGER, unfiltered + created);
        setNotice(`Added ${created} row${created === 1 ? "" : "s"} and opened the last page.`);
        await refetch("", lastPage);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add rows");
    } finally {
      setBusy(false);
    }
  }, [table.id, addRows, refetch, appliedSearch, activeFilterCount, sorts.length, unfiltered]);

  const goToPage = useCallback(async (nextPage: number) => {
    const target = clampGridPage(nextPage, rowCount);
    if (target === page) return;
    setBusy(true);
    setError(null);
    setSelectedRowIds([]);
    setAllMatchingSelected(false);
    setCellRange(null);
    try {
      await refetch(appliedSearch, target);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load rows");
    } finally {
      setBusy(false);
    }
  }, [appliedSearch, page, refetch, rowCount]);

  const syncHistoryCounts = useCallback(() => {
    setHistoryCounts({
      undo: undoStackRef.current.length,
      redo: redoStackRef.current.length,
    });
  }, []);

  const recordCellCommand = useCallback((command: CellEditCommand) => {
    if (!command.undo.length || !command.redo.length) return;
    undoStackRef.current.push(command);
    if (undoStackRef.current.length > 50) undoStackRef.current.shift();
    redoStackRef.current = [];
    syncHistoryCounts();
  }, [syncHistoryCounts]);

  const persistCellUpdates = useCallback(async (
    updates: CellUpdate[],
    successMessage?: string,
    options: { lockAlreadyHeld?: boolean; recordHistory?: boolean; pendingLabel?: string } = {},
  ) => {
    if (!updates.length) {
      setNotice("The selection has no editable cells.");
      return false;
    }

    if (!options.lockAlreadyHeld) {
      if (cellOperationRef.current) {
        setNotice("Another cell update is still in progress.");
        return false;
      }
      cellOperationRef.current = true;
    }

    setBusy(true);
    setCellSavingLabel(options.pendingLabel ?? "Saving changes…");
    setError(null);
    try {
      let response: Response;
      try {
        response = await fetch(`/api/grid/tables/${table.id}/cells`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ updates }),
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not update cells");
        return false;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error ?? "Could not update cells");
        return false;
      }
      if (options.recordHistory !== false && Array.isArray(data.previousValues)) {
        const previousValues = data.previousValues.filter(
          (update: unknown): update is CellUpdate => Boolean(
            update
            && typeof update === "object"
            && typeof (update as CellUpdate).rowId === "string"
            && typeof (update as CellUpdate).columnKey === "string",
          ),
        );
        if (previousValues.length === updates.length) {
          recordCellCommand({ undo: previousValues, redo: updates });
        }
      }
      // With auto-run on, an edit can queue dependent columns.
      if (typeof data.queued === "number" && data.queued > 0) startWatching();
      try {
        await refetch();
      } catch (cause) {
        // The database mutation already succeeded. Keep history aligned with
        // that saved state even if a transient refresh request fails.
        setError(cause instanceof Error
          ? `Changes were saved, but the table could not refresh: ${cause.message}`
          : "Changes were saved, but the table could not refresh.");
        return true;
      }
      if (successMessage) setNotice(successMessage);
      return true;
    } finally {
      if (!options.lockAlreadyHeld) {
        cellOperationRef.current = false;
        setBusy(false);
        setCellSavingLabel(null);
      }
    }
  }, [recordCellCommand, refetch, startWatching, table.id]);

  const onCellValueChanged = useCallback(
    async (event: CellValueChangedEvent<RowData>) => {
      const columnKey = event.colDef.field;
      if (!columnKey || !event.data) return;
      // newValue was already coerced to the column's type by its valueParser.
      const applied = await persistCellUpdates(
        [{ rowId: event.data.__id, columnKey, value: event.newValue ?? null }],
      );
      if (!applied) {
        // AG Grid applies edits optimistically; put the old value back when
        // the server rejects the mutation so the UI never shows an unsaved edit.
        event.data[columnKey] = event.oldValue;
        event.api.refreshCells({ rowNodes: [event.node], columns: [columnKey], force: true });
      }
    },
    [persistCellUpdates],
  );

  const undoLastCellChange = useCallback(async () => {
    if (cellOperationRef.current) return;
    const command = undoStackRef.current.pop();
    if (!command) return;
    syncHistoryCounts();
    const applied = await persistCellUpdates(
      command.undo,
      `Undid ${command.undo.length.toLocaleString()} cell change${command.undo.length === 1 ? "" : "s"}.`,
      { recordHistory: false },
    );
    if (applied) redoStackRef.current.push(command);
    else undoStackRef.current.push(command);
    syncHistoryCounts();
  }, [persistCellUpdates, syncHistoryCounts]);

  const redoLastCellChange = useCallback(async () => {
    if (cellOperationRef.current) return;
    const command = redoStackRef.current.pop();
    if (!command) return;
    syncHistoryCounts();
    const applied = await persistCellUpdates(
      command.redo,
      `Redid ${command.redo.length.toLocaleString()} cell change${command.redo.length === 1 ? "" : "s"}.`,
      { recordHistory: false },
    );
    if (applied) undoStackRef.current.push(command);
    else redoStackRef.current.push(command);
    syncHistoryCounts();
  }, [persistCellUpdates, syncHistoryCounts]);

  const selectedCellMatrix = useCallback((): unknown[][] | null => {
    if (!normalizedCellRange) return null;
    const { startRow, endRow, startColumn, endColumn } = normalizedCellRange;
    return rowData.slice(startRow, endRow + 1).map((row) =>
      displayedColumns
        .slice(startColumn, endColumn + 1)
        .map((column) => row[column.key]),
    );
  }, [displayedColumns, normalizedCellRange, rowData]);

  const clearSelectedCells = useCallback(async () => {
    if (!normalizedCellRange) return;
    const updates: CellUpdate[] = [];
    for (let rowIndex = normalizedCellRange.startRow; rowIndex <= normalizedCellRange.endRow; rowIndex += 1) {
      const row = rowData[rowIndex];
      if (!row) continue;
      for (let columnIndex = normalizedCellRange.startColumn; columnIndex <= normalizedCellRange.endColumn; columnIndex += 1) {
        const column = displayedColumns[columnIndex];
        if (column && isStaticColumnType(column.type)) {
          updates.push({ rowId: row.__id, columnKey: column.key, value: null });
        }
      }
    }
    await persistCellUpdates(
      updates,
      `Cleared ${updates.length.toLocaleString()} cell${updates.length === 1 ? "" : "s"}.`,
    );
  }, [displayedColumns, normalizedCellRange, persistCellUpdates, rowData]);

  const onGridCopy = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    if (isEditingClipboardTarget(event.target)) return;
    const matrix = selectedCellMatrix();
    if (!matrix) return;
    event.clipboardData.setData("text/plain", serializeClipboardGrid(matrix, { escapeFormulas: true }));
    try {
      event.clipboardData.setData(INTERNAL_CLIPBOARD_MIME, JSON.stringify(matrix));
    } catch {
      // Some browsers reject custom clipboard MIME types; text/plain remains.
    }
    event.preventDefault();
    setNotice(`Copied ${matrix.length * (matrix[0]?.length ?? 0)} cell${matrix.length * (matrix[0]?.length ?? 0) === 1 ? "" : "s"}.`);
  }, [selectedCellMatrix]);

  const onGridCut = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    if (isEditingClipboardTarget(event.target)) return;
    const matrix = selectedCellMatrix();
    if (!matrix) return;
    event.clipboardData.setData("text/plain", serializeClipboardGrid(matrix, { escapeFormulas: true }));
    try {
      event.clipboardData.setData(INTERNAL_CLIPBOARD_MIME, JSON.stringify(matrix));
    } catch {
      // Some browsers reject custom clipboard MIME types; text/plain remains.
    }
    event.preventDefault();
    void clearSelectedCells();
  }, [clearSelectedCells, selectedCellMatrix]);

  const onGridPaste = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    // Once the user has double-clicked into the editor, the browser owns the
    // paste and inserts the entire clipboard payload into that one cell.
    if (isEditingClipboardTarget(event.target) || busy || !normalizedCellRange) return;

    const clipboardTypes = Array.from(event.clipboardData.types);
    const internalPayload = clipboardTypes.includes(INTERNAL_CLIPBOARD_MIME)
      ? event.clipboardData.getData(INTERNAL_CLIPBOARD_MIME)
      : "";
    let source: unknown[][] | null = null;
    if (internalPayload) {
      try {
        const parsed: unknown = JSON.parse(internalPayload);
        if (Array.isArray(parsed) && parsed.every((row) => Array.isArray(row))) {
          source = parsed as unknown[][];
        }
      } catch {
        // Fall through to the interoperable text representation.
      }
    }
    if (!source) {
      if (!clipboardTypes.includes("text/plain")) return;
      source = parseClipboardText(event.clipboardData.getData("text/plain"));
    }
    if (!source.length || !source.some((row) => row.length)) return;
    event.preventDefault();

    const selectionRows = normalizedCellRange.endRow - normalizedCellRange.startRow + 1;
    const selectionColumns = normalizedCellRange.endColumn - normalizedCellRange.startColumn + 1;
    const sourceRows = source.length;
    const sourceColumns = Math.max(0, ...source.map((row) => row.length));
    const repeatIntoSelection = (selectionRows > 1 || selectionColumns > 1)
      && selectionRows >= sourceRows
      && selectionColumns >= sourceColumns
      && selectionRows % sourceRows === 0
      && selectionColumns % sourceColumns === 0;
    const desiredRows = repeatIntoSelection ? selectionRows : sourceRows;
    const desiredColumns = repeatIntoSelection ? selectionColumns : sourceColumns;
    if (desiredRows > 1_000) {
      setError("Paste supports up to 1,000 rows at a time. Use Import for a larger sheet.");
      return;
    }
    const existingTargetColumns = displayedColumns.slice(
      normalizedCellRange.startColumn,
      normalizedCellRange.startColumn + desiredColumns,
    );
    const missingColumnCount = desiredColumns - existingTargetColumns.length;
    if (missingColumnCount > 100) {
      setError("Paste can create up to 100 new columns at a time. Use Import for a wider dataset.");
      return;
    }
    const editableColumnCount = existingTargetColumns.filter((column) => isStaticColumnType(column.type)).length
      + missingColumnCount;
    const editableCellCount = desiredRows * editableColumnCount;
    if (editableCellCount > 50_000) {
      setError("Paste is limited to 50,000 editable cells at a time.");
      return;
    }
    if (cellOperationRef.current) {
      setNotice("Another cell update is still in progress.");
      return;
    }
    cellOperationRef.current = true;
    setBusy(true);
    setCellSavingLabel("Pasting…");
    setError(null);

    void (async () => {
      let addedColumns = 0;
      let addedRows = 0;
      try {
        const targetColumns = [...existingTargetColumns];
        let targetRowIds = rowData
          .slice(normalizedCellRange.startRow, normalizedCellRange.startRow + desiredRows)
          .map((row) => row.__id);

        if (targetRowIds.length < desiredRows) {
          const qs = new URLSearchParams();
          if (appliedSearch) qs.set("search", appliedSearch);
          const response = await fetch(`/api/grid/tables/${table.id}/selection?${qs}`);
          const data: { rowIds?: string[]; error?: string } = await response.json().catch(() => ({}));
          if (!response.ok || !Array.isArray(data.rowIds)) {
            setError(data.error ?? "Could not resolve rows for this paste");
            return;
          }
          const startOffset = page * GRID_PAGE_SIZE + normalizedCellRange.startRow;
          targetRowIds = data.rowIds.slice(startOffset, startOffset + desiredRows);
        }

        if (missingColumnCount > 0) {
          setCellSavingLabel(`Adding ${missingColumnCount.toLocaleString()} column${missingColumnCount === 1 ? "" : "s"}…`);
          for (let index = 0; index < missingColumnCount; index += 1) {
            const response = await fetch(`/api/grid/tables/${table.id}/columns`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: `Column ${columns.length + index + 1}`,
                type: "text",
              }),
            });
            const data: { column?: GridColumn; error?: string } = await response.json().catch(() => ({}));
            if (!response.ok || !data.column) {
              throw new Error(data.error ?? "Could not add columns for this paste");
            }
            targetColumns.push(data.column);
            addedColumns += 1;
          }
        }

        if (targetRowIds.length < desiredRows) {
          const missingRowCount = desiredRows - targetRowIds.length;
          setCellSavingLabel(`Adding ${missingRowCount.toLocaleString()} row${missingRowCount === 1 ? "" : "s"}…`);
          const addRowsResponse = await fetch(`/api/grid/tables/${table.id}/rows`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ count: missingRowCount }),
          });
          const addRowsData: { rows?: GridRow[]; error?: string } = await addRowsResponse.json().catch(() => ({}));
          if (!addRowsResponse.ok || !Array.isArray(addRowsData.rows)) {
            throw new Error(addRowsData.error ?? "Could not add rows for this paste");
          }
          const createdRowIds = addRowsData.rows.map((row) => row.id);
          if (createdRowIds.length !== missingRowCount) {
            throw new Error("The table could not create every row needed for this paste");
          }
          targetRowIds = [...targetRowIds, ...createdRowIds];
          addedRows = createdRowIds.length;
        }

        const updates: CellUpdate[] = [];
        for (let rowOffset = 0; rowOffset < desiredRows; rowOffset += 1) {
          const sourceRow = source[rowOffset % sourceRows] ?? [];
          for (let columnOffset = 0; columnOffset < targetColumns.length; columnOffset += 1) {
            const column = targetColumns[columnOffset];
            if (!isStaticColumnType(column.type)) continue;
            const raw = sourceRow[columnOffset % Math.max(1, sourceColumns)] ?? "";
            updates.push({
              rowId: targetRowIds[rowOffset],
              columnKey: column.key,
              value: typeof raw === "string" ? coerceClipboardValue(raw, column.type) : raw,
            });
          }
        }

        const pastedRange: CellRange = {
          anchor: {
            rowIndex: normalizedCellRange.startRow,
            columnKey: targetColumns[0].key,
          },
          focus: {
            rowIndex: normalizedCellRange.startRow + desiredRows - 1,
            columnKey: targetColumns[targetColumns.length - 1].key,
          },
        };
        const selectionFitsCurrentPage = addedRows === 0
          ? desiredRows <= rowData.length - normalizedCellRange.startRow
          : !appliedSearch
            && activeFilterCount === 0
            && sorts.length === 0
            && normalizedCellRange.startRow + desiredRows <= GRID_PAGE_SIZE;
        if (selectionFitsCurrentPage) setCellRange(pastedRange);
        const expansionSummary = [
          addedRows ? `${addedRows.toLocaleString()} row${addedRows === 1 ? "" : "s"}` : "",
          addedColumns ? `${addedColumns.toLocaleString()} column${addedColumns === 1 ? "" : "s"}` : "",
        ].filter(Boolean).join(" and ");
        const applied = await persistCellUpdates(
          updates,
          `Pasted ${updates.length.toLocaleString()} editable cell${updates.length === 1 ? "" : "s"}${expansionSummary ? ` after adding ${expansionSummary}` : ""}.`,
          { lockAlreadyHeld: true, pendingLabel: "Pasting…" },
        );
        if (applied && selectionFitsCurrentPage) setCellRange(pastedRange);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "Could not paste cells";
        if (addedColumns || addedRows) {
          await refetch().catch(() => undefined);
        }
        setError(message);
      } finally {
        cellOperationRef.current = false;
        setBusy(false);
        setCellSavingLabel(null);
      }
    })();
  }, [activeFilterCount, appliedSearch, busy, columns.length, displayedColumns, normalizedCellRange, page, persistCellUpdates, refetch, rowData, sorts.length, table.id]);

  const onGridKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isEditingClipboardTarget(event.target)) return;
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) void redoLastCellChange();
      else void undoLastCellChange();
      return;
    }
    if (modifier && event.key.toLowerCase() === "y") {
      event.preventDefault();
      void redoLastCellChange();
      return;
    }
    if (event.key === "Escape") {
      setCellRange(null);
      return;
    }
    // Clear the selected cells, but only when focus is on a grid cell itself
    // (not the gutter checkbox, a toolbar button or an open editor).
    if (
      (event.key === "Delete" || event.key === "Backspace")
      && !modifier
      && normalizedCellRange
      && !busy
      && event.target instanceof Element
      && event.target.closest(".ag-cell")
    ) {
      event.preventDefault();
      void clearSelectedCells();
    }
  }, [busy, clearSelectedCells, normalizedCellRange, redoLastCellChange, undoLastCellChange]);

  // Keyboard navigation moves the focused cell; mirror it into the range so
  // copy, paste and clear act on the cell the person is actually on. Mouse
  // focus is handled by onCellMouseDown (which also does shift-extend).
  const onCellFocused = useCallback((event: CellFocusedEvent<RowData>) => {
    if (event.sourceEvent instanceof MouseEvent) return;
    if (event.rowIndex === null || event.rowIndex === undefined || event.rowPinned) return;
    const column = event.column;
    const columnKey = typeof column === "string" ? column : column?.getColId();
    if (!columnKey || !displayedColumnKeys.includes(columnKey)) return;
    const coordinate = { rowIndex: event.rowIndex, columnKey };
    const extend = event.sourceEvent instanceof KeyboardEvent && event.sourceEvent.shiftKey;
    setCellRange((current) =>
      extend && current
        ? { ...current, focus: coordinate }
        : { anchor: coordinate, focus: coordinate },
    );
  }, [displayedColumnKeys]);

  const onCellMouseDown = useCallback((event: CellMouseDownEvent<RowData>) => {
    if (event.node.rowPinned === "top" || !event.data || event.node.rowIndex === null) return;
    const columnKey = event.colDef.field;
    if (!columnKey || !displayedColumnKeys.includes(columnKey)) return;
    const mouseEvent = event.event instanceof MouseEvent ? event.event : null;
    if (mouseEvent && mouseEvent.button !== 0) return;
    if (mouseEvent?.target instanceof Element && mouseEvent.target.closest("a, button, input, textarea, [contenteditable='true']")) return;

    const coordinate = { rowIndex: event.node.rowIndex, columnKey };
    selectingCellsRef.current = true;
    setCellRange((current) =>
      mouseEvent?.shiftKey && current
        ? { ...current, focus: coordinate }
        : { anchor: coordinate, focus: coordinate },
    );
  }, [displayedColumnKeys]);

  const fillSelectedCells = useCallback(async (targetRow: number) => {
    if (!normalizedCellRange
      || (targetRow >= normalizedCellRange.startRow && targetRow <= normalizedCellRange.endRow)) {
      setFillTargetRow(null);
      return;
    }
    if (cellOperationRef.current) {
      setFillTargetRow(null);
      setNotice("Another cell update is still in progress.");
      return;
    }
    cellOperationRef.current = true;
    setBusy(true);
    setCellSavingLabel("Duplicating…");
    setFillTargetRow(targetRow);

    // Yield a frame before doing any copy work or network I/O. This guarantees
    // the destination placeholders paint immediately after pointer release.
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });

    const originalRange = cellRange;
    const firstTarget = targetRow < normalizedCellRange.startRow ? targetRow : normalizedCellRange.endRow + 1;
    const lastTarget = targetRow < normalizedCellRange.startRow ? normalizedCellRange.startRow - 1 : targetRow;
    const updates: CellUpdate[] = [];

    for (let rowIndex = firstTarget; rowIndex <= lastTarget; rowIndex += 1) {
      const destination = rowData[rowIndex];
      if (!destination) continue;
      const sourceRowIndex = fillSourceRowIndex(normalizedCellRange, targetRow, rowIndex);
      const source = rowData[sourceRowIndex];
      if (!source) continue;
      for (let columnIndex = normalizedCellRange.startColumn; columnIndex <= normalizedCellRange.endColumn; columnIndex += 1) {
        const column = displayedColumns[columnIndex];
        if (column && isStaticColumnType(column.type)) {
          updates.push({ rowId: destination.__id, columnKey: column.key, value: source[column.key] });
        }
      }
    }

    const expandedRange: CellRange = {
      anchor: {
        rowIndex: Math.min(targetRow, normalizedCellRange.startRow),
        columnKey: displayedColumns[normalizedCellRange.startColumn].key,
      },
      focus: {
        rowIndex: Math.max(targetRow, normalizedCellRange.endRow),
        columnKey: displayedColumns[normalizedCellRange.endColumn].key,
      },
    };
    let applied = false;
    try {
      applied = await persistCellUpdates(
        updates,
        `Duplicated ${updates.length.toLocaleString()} editable cell${updates.length === 1 ? "" : "s"}.`,
        { lockAlreadyHeld: true, pendingLabel: "Duplicating…" },
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not duplicate cells");
    } finally {
      cellOperationRef.current = false;
      setBusy(false);
      setCellSavingLabel(null);
      setFillTargetRow(null);
    }
    setCellRange(applied ? expandedRange : originalRange);
  }, [cellRange, displayedColumns, normalizedCellRange, persistCellUpdates, rowData]);

  const onFillHandlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!normalizedCellRange || event.button !== 0 || busy || cellOperationRef.current) return;

    event.preventDefault();
    event.stopPropagation();
    selectingCellsRef.current = false;
    fillDragRef.current = { pointerId: event.pointerId, targetRow: normalizedCellRange.endRow };
    setFillTargetRow(normalizedCellRange.endRow);
    gridContainerRef.current?.setPointerCapture(event.pointerId);
  }, [busy, normalizedCellRange]);

  const onGridPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = fillDragRef.current;
    if ((!drag || drag.pointerId !== event.pointerId) && !selectingCellsRef.current) return;
    pendingPointerRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      pointerId: event.pointerId,
    };
    if (pointerMoveFrameRef.current !== null) return;
    pointerMoveFrameRef.current = window.requestAnimationFrame(() => {
      pointerMoveFrameRef.current = null;
      const point = pendingPointerRef.current;
      if (!point) return;
      const currentDrag = fillDragRef.current;
      if (currentDrag && currentDrag.pointerId === point.pointerId) {
        const rowIndex = gridRowIndexAtPoint(point.clientX, point.clientY, rowData.length);
        if (rowIndex === null || rowIndex === currentDrag.targetRow) return;
        currentDrag.targetRow = rowIndex;
        setFillTargetRow(rowIndex);
        return;
      }
      if (!selectingCellsRef.current) return;
      const element = document.elementFromPoint(point.clientX, point.clientY);
      const cell = element instanceof Element ? element.closest<HTMLElement>(".ag-cell[col-id]") : null;
      const rowElement = cell?.closest<HTMLElement>(".ag-row[row-index]");
      if (!cell || !rowElement || rowElement.closest(".ag-floating-top")) return;
      const rowIndex = Number(rowElement.getAttribute("row-index"));
      const columnKey = cell.getAttribute("col-id") ?? "";
      if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= rowData.length
        || !displayedColumnKeys.includes(columnKey)) return;
      setCellRange((current) => {
        if (!current || (current.focus.rowIndex === rowIndex && current.focus.columnKey === columnKey)) return current;
        return { ...current, focus: { rowIndex, columnKey } };
      });
    });
  }, [displayedColumnKeys, rowData.length]);

  const finishFillDrag = useCallback((event: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
    const drag = fillDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (pointerMoveFrameRef.current !== null) {
      window.cancelAnimationFrame(pointerMoveFrameRef.current);
      pointerMoveFrameRef.current = null;
    }
    const finalRow = gridRowIndexAtPoint(event.clientX, event.clientY, rowData.length);
    if (finalRow !== null) drag.targetRow = finalRow;
    fillDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (commit) void fillSelectedCells(drag.targetRow);
    else setFillTargetRow(null);
  }, [fillSelectedCells, rowData.length]);

  const toggleBoolean = useCallback(async (row: RowData, column: GridColumn) => {
    const current = row[column.key];
    const checked = current === true || String(current).toLowerCase() === "true";
    await persistCellUpdates([{ rowId: row.__id, columnKey: column.key, value: !checked }]);
  }, [persistCellUpdates]);

  const onCellClicked = useCallback((event: CellClickedEvent<RowData>) => {
    if (event.node.rowPinned === "top" || !event.data) return;
    // The per-row run button and cell links do their own thing.
    const target = event.event?.target;
    if (target instanceof Element && target.closest("a, button")) return;
    const columnKey = event.colDef.field;
    if (!columnKey) return;
    const column = columns.find((candidate) => candidate.key === columnKey);
    if (!column) return;
    if (column.type === "boolean") {
      // One click flips a checkbox; modifiers are for selecting a range.
      const mouse = event.event instanceof MouseEvent ? event.event : null;
      if (mouse && (mouse.shiftKey || mouse.metaKey || mouse.ctrlKey || mouse.altKey)) return;
      void toggleBoolean(event.data, column);
      return;
    }
    if (column.type !== "enrichment" && column.type !== "integration_output" && column.type !== "ai" && column.type !== "http" && column.type !== "formula" && !aiOutputSources.has(column.key)) return;
    setCellDetails({ rowId: event.data.__id, column });
  }, [aiOutputSources, columns, toggleBoolean]);

  const onCellKeyDown = useCallback((event: CellKeyDownEvent<RowData>) => {
    if (event.node.rowPinned === "top" || !event.data) return;
    const keyboard = event.event instanceof KeyboardEvent ? event.event : null;
    if (!keyboard || keyboard.key !== " " || keyboard.shiftKey || keyboard.metaKey || keyboard.ctrlKey || keyboard.altKey) return;
    const column = columns.find((candidate) => candidate.key === event.colDef.field);
    if (column?.type !== "boolean") return;
    keyboard.preventDefault();
    void toggleBoolean(event.data, column);
  }, [columns, toggleBoolean]);

  const toggleAutoRun = useCallback(async () => {
    const previous = autoRun;
    const next = !previous;
    setAutoRun(next);
    try {
      const res = await fetch(`/api/grid/tables/${table.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoRun: next }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? "Could not change Auto-run");
      }
      onTableChanged?.();
    } catch (cause) {
      setAutoRun(previous);
      setError(cause instanceof Error ? cause.message : "Could not change Auto-run");
    }
  }, [autoRun, table.id, onTableChanged]);

  const runColumn = useCallback(async (column: GridColumn, rowIds?: string[], options: { onlyEmpty?: boolean } = {}) => {
    // An empty list means "no rows", never "every row".
    if (rowIds && rowIds.length === 0) {
      setRunMenu(null);
      setNotice("There are no rows to run.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/grid/tables/${table.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ columnKey: column.key, rowIds, ...(options.onlyEmpty ? { onlyEmpty: true } : {}) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Could not start column");
      setActiveJobs(data.activeJobs ?? 0);
      startWatching();
      await refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start column");
    } finally {
      setRunMenu(null);
      setBusy(false);
    }
  }, [refetch, startWatching, table.id]);

  const stopRun = useCallback(async () => {
    setStopping(true);
    try {
      const response = await fetch(`/api/grid/tables/${table.id}/run`, { method: "DELETE" });
      const data: { cancelled?: number; reset?: number; activeJobs?: number; error?: string } = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Could not stop the run");
      graceUntilRef.current = 0;
      setActiveJobs(data.activeJobs ?? 0);
      const total = (data.cancelled ?? 0) + (data.reset ?? 0);
      setNotice(total > 0 ? `Stopped. ${total.toLocaleString()} queued cell${total === 1 ? "" : "s"} cleared.` : "Nothing was running.");
      await refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not stop the run");
    } finally {
      setStopping(false);
    }
  }, [refetch, table.id]);

  /* ---- column defs ---- */

  const selectedRowIdSet = useMemo(() => new Set(selectedRowIds), [selectedRowIds]);
  useEffect(() => {
    gridRef.current?.api?.redrawRows();
  }, [selectedRowIdSet]);
  const pageRowIds = useMemo(() => rowData.map((row) => row.__id), [rowData]);
  const selectedOnPage = pageRowIds.filter((id) => selectedRowIdSet.has(id)).length;
  const pageSelectionState: boolean | "indeterminate" =
    pageRowIds.length > 0 && selectedOnPage === pageRowIds.length
      ? true
      : selectedOnPage > 0
        ? "indeterminate"
        : false;

  const toggleRowSelection = useCallback((rowId: string) => {
    // Editing a query-wide selection should never leave a misleading hidden
    // selection on the other pages. Keep the remaining rows on this page.
    if (allMatchingSelected) {
      setAllMatchingSelected(false);
      setSelectedRowIds(pageRowIds.filter((id) => id !== rowId));
      return;
    }
    setAllMatchingSelected(false);
    setSelectedRowIds((current) =>
      current.includes(rowId) ? current.filter((id) => id !== rowId) : [...current, rowId],
    );
  }, [allMatchingSelected, pageRowIds]);

  const togglePageSelection = useCallback((checked: boolean) => {
    if (allMatchingSelected) {
      setAllMatchingSelected(false);
      setSelectedRowIds(checked ? pageRowIds : []);
      return;
    }
    setAllMatchingSelected(false);
    setSelectedRowIds((current) => {
      const next = new Set(current);
      for (const id of pageRowIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return [...next];
    });
  }, [allMatchingSelected, pageRowIds]);

  const selectAllMatchingRows = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (appliedSearch) qs.set("search", appliedSearch);
      const res = await fetch(`/api/grid/tables/${table.id}/selection?${qs}`);
      const data: { rowIds?: string[]; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(data.rowIds)) {
        setError(data.error ?? "Could not select all matching rows");
        return;
      }
      setSelectedRowIds(data.rowIds);
      setAllMatchingSelected(true);
    } finally {
      setBusy(false);
    }
  }, [appliedSearch, table.id]);

  const onDisplayedColumnsChanged = useCallback((event: DisplayedColumnsChangedEvent<RowData>) => {
    const known = new Set(visibleColumns.map((column) => column.key));
    const allDisplayedColumns = event.api.getAllDisplayedColumns();
    const addColumnIndex = allDisplayedColumns.findIndex((column) => column.getColId() === "__add");
    if (addColumnIndex >= 0 && addColumnIndex !== allDisplayedColumns.length - 1) {
      event.api.moveColumns(["__add"], allDisplayedColumns.length - 1);
    }
    const next = allDisplayedColumns
      .map((column) => column.getColId())
      .filter((key) => known.has(key));
    setColumnDisplayOrder((current) =>
      current.length === next.length && current.every((key, index) => key === next[index])
        ? current
        : next,
    );
  }, [visibleColumns]);

  /** Persist a finished header drag: PATCH the column to sit right after its new left neighbour. */
  const onColumnMoved = useCallback((event: ColumnMovedEvent<RowData>) => {
    if (!event.finished || event.source !== "uiColumnMoved" || !event.column) return;
    const movedKey = event.column.getColId();
    const moved = columns.find((column) => column.key === movedKey);
    if (!moved) return;
    // Pinned columns are drawn first whatever their stored position, so the
    // anchor is the neighbour within the moved column's own group (pinned or
    // not): "after a pinned column" would land somewhere else in stored order.
    const movedPinned = pinned.includes(movedKey);
    const sameGroup = (key: string) => pinned.includes(key) === movedPinned;
    const known = new Set(columns.map((column) => column.key));
    const shownKeys = event.api
      .getAllDisplayedColumns()
      .map((column) => column.getColId())
      .filter((key) => known.has(key) && sameGroup(key));
    const index = shownKeys.indexOf(movedKey);
    if (index < 0) return;
    const leftKey = index > 0 ? shownKeys[index - 1] : null;
    const left = leftKey ? columns.find((column) => column.key === leftKey) ?? null : null;

    const withoutMoved = columns.filter((column) => column.id !== moved.id);
    // Where it sat before the drag, among the columns that were showing.
    const shownBefore = columns.filter((column) => !hidden.includes(column.key) && sameGroup(column.key));
    const previousLeft = shownBefore[shownBefore.findIndex((column) => column.id === moved.id) - 1];
    const insertAt = left ? withoutMoved.findIndex((column) => column.id === left.id) + 1 : 0;
    // Dropped back where it started: nothing to save.
    if ((left?.id ?? null) === (previousLeft?.id ?? null)) return;
    const reordered = [...withoutMoved.slice(0, insertAt), moved, ...withoutMoved.slice(insertAt)];
    setColumns(reordered);

    void (async () => {
      try {
        const res = await fetch(`/api/grid/tables/${table.id}/columns/${moved.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ afterColumnId: left?.id ?? null }),
        });
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          throw new Error(b.error ?? "Could not move the column");
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not move the column");
        await refetch().catch(() => undefined);
      }
    })();
  }, [columns, hidden, pinned, refetch, table.id]);

  const selectColumn = useCallback((columnKey: string, extend: boolean) => {
    if (!rowData.length) return;
    setCellRange((current) => {
      const anchorColumnKey = extend && current ? current.anchor.columnKey : columnKey;
      return {
        anchor: { rowIndex: 0, columnKey: anchorColumnKey },
        focus: { rowIndex: rowData.length - 1, columnKey },
      };
    });
  }, [rowData.length]);

  const colDefs = useMemo<ColDef<RowData>[]>(() => {
    const gutter: ColDef<RowData> = {
      colId: "__gutter",
      headerName: "",
      width: GUTTER_W,
      minWidth: GUTTER_W,
      maxWidth: GUTTER_W,
      pinned: "left",
      resizable: false,
      sortable: false,
      filter: false,
      editable: false,
      suppressMovable: true,
      headerComponent: GutterHeader,
      headerComponentParams: {
        checked: pageSelectionState,
        onCheckedChange: togglePageSelection,
      },
      cellRenderer: GutterCell,
      cellRendererParams: {
        rowOffset: page * GRID_PAGE_SIZE,
        isSelected: (rowId: string) => selectedRowIdSet.has(rowId),
        onToggle: toggleRowSelection,
      },
      cellClass: "grid-gutter-cell",
    };

    const userCols = visibleColumns.map<ColDef<RowData>>((c) => {
      const aiOutput = aiOutputSources.get(c.key);
      const valueType = aiOutput?.valueType ?? effectiveColumnType(c);
      const runSource = RUNNABLE_SOURCE_TYPES.has(c.type)
        ? c
        : c.type === "integration_output"
          ? columns.find((candidate) =>
              candidate.key === (c.config as IntegrationOutputConfig).sourceColumnKey
              && candidate.type === "enrichment",
            )
          : aiOutput
            ? columns.find((candidate) => candidate.key === aiOutput.sourceColumnKey && candidate.type === "ai")
            : undefined;
      return {
        field: c.key,
        headerName: c.name,
        headerComponent: ColumnHeader,
        headerComponentParams: {
          colType: c.type,
          valueType,
          integrationKey:
            c.type === "enrichment" || c.type === "integration_output"
              ? (c.config as { integrationKey?: string }).integrationKey
              : undefined,
          active: columnMenu?.column.id === c.id,
          onSelect: (extend: boolean) => selectColumn(c.key, extend),
          // Every column opens the column menu; run columns list their own
          // "Edit …" entry there, so rename / pin / sort / delete stay reachable.
          onOpen: (rect: DOMRect) =>
            setColumnMenu((current) =>
              current?.column.id === c.id ? null : { column: c, rect },
            ),
          onRun: runSource
            ? (rect: DOMRect) => setRunMenu({ column: runSource, rect })
            : undefined,
        },
        editable: (p) => p.node.rowPinned !== "top" && isStaticColumnType(c.type) && c.type !== "boolean" && !aiOutput,
        ...editorFor(c),
        cellDataType: false,
        // initialWidth: a width the person dragged survives column-def updates.
        initialWidth: COL_W,
        minWidth: 90,
        pinned: pinned.includes(c.key) ? "left" : undefined,
        resizable: true,
        // Sorting and filtering are server-side over JSONB, so AG Grid's own
        // client-side versions are off: they would only ever reorder the fetched
        // page, which silently disagrees with the toolbar's row count.
        sortable: false,
        filter: false,
        cellRenderer:
          c.type === "enrichment" || c.type === "ai"
            ? IntegrationActionCell
            : c.type === "http" || c.type === "formula"
              ? RunnerValueCell
              : c.type === "integration_output" || Boolean(aiOutput)
                ? IntegrationOutputCell
                : undefined,
        cellRendererParams:
          c.type === "enrichment" || c.type === "ai" || c.type === "http" || c.type === "formula"
            ? { onRun: (rowId: string) => void runColumn(c, [rowId]), disabled: busy }
            : c.type === "integration_output"
            ? { sourceColumnKey: (c.config as IntegrationOutputConfig).sourceColumnKey, valueType, ungrouped: UNGROUPED_NUMBER_NAME.test(c.name) }
            : aiOutput
              ? { sourceColumnKey: aiOutput.sourceColumnKey, valueType, ungrouped: UNGROUPED_NUMBER_NAME.test(c.name) }
            : undefined,
        valueFormatter: (p) =>
          p.node?.rowPinned === "top"
            ? p.value === undefined || p.value === null
              ? ""
              : `${p.value}%`
            : formatCellValue(p.value, c, valueType),
        cellClass: (p) => {
          if (p.node.rowPinned === "top") return "grid-coverage-cell";
          const classes: string[] = [];
          const meta = (p.data?.__meta?.[c.key] ?? undefined) as CellMeta | undefined;
          if (meta?.status === "error") classes.push("grid-cell-error");
          if (meta?.status === "running" || meta?.status === "processing") classes.push("grid-cell-running");
          return classes.join(" ");
        },
      };
    });

    const adder: ColDef<RowData> = {
      colId: "__add",
      headerName: "",
      width: ADD_COL_W,
      minWidth: ADD_COL_W,
      maxWidth: ADD_COL_W,
      resizable: false,
      sortable: false,
      filter: false,
      editable: false,
      suppressMovable: true,
      headerComponent: AddColumnHeader,
      headerComponentParams: { onOpen: (rect: DOMRect) => setAddMenu({ rect }) },
      valueGetter: () => "",
    };

    return [gutter, ...userCols, adder];
  }, [aiOutputSources, busy, columnMenu?.column, columns, page, pageSelectionState, pinned, runColumn, selectColumn, selectedRowIdSet, togglePageSelection, toggleRowSelection, visibleColumns]);

  // Stable close handlers: Popover re-subscribes its document listeners
  // whenever onClose changes identity, and an inline arrow changes every render.
  const closePanel = useCallback(() => setPanel(null), []);
  const closeColumnMenu = useCallback(() => setColumnMenu(null), []);
  const closeRunMenu = useCallback(() => setRunMenu(null), []);
  const closeRowActions = useCallback(() => setRowActionsRect(null), []);
  const closeAddMenu = useCallback(() => setAddMenu(null), []);

  // The grid is no longer remounted per page, so bring the new page to the top.
  useEffect(() => {
    const api = gridRef.current?.api;
    if (!api) return;
    api.clearFocusedCell();
    api.ensureIndexVisible(0);
  }, [page]);

  const changeColumnType = useCallback(async (column: GridColumn, type: ColumnType) => {
    // Formula and HTTP columns keep their whole setup in config, which a type
    // change to a plain column replaces with {}: that is not undoable.
    if ((column.type === "formula" || column.type === "http") && isStaticColumnType(type)) {
      const ok = await dialogs.confirm({
        title: `Change ${column.name} to a ${columnTypeMeta(type).label} column?`,
        description: column.type === "formula"
          ? "The formula will be discarded and the column will become a plain column. Existing values stay, but they will no longer be calculated."
          : "The HTTP request setup (URL, headers, body and response path) will be discarded and the column will become a plain column. Existing values stay, but they will no longer be fetched.",
        confirmLabel: "Change type",
        variant: "error",
      });
      if (!ok) return;
    }
    await patchColumn(column, { type, config: {} });
  }, [dialogs, patchColumn]);

  const pinnedTop = useMemo<RowData[]>(
    () => [{ __id: "__coverage", __meta: {}, ...coverage }],
    [coverage],
  );

  const totalPages = gridPageCount(rowCount);
  const visibleRange = gridPageRange(page, rowCount);

  /** The "Edit …" entry a run column's menu leads with, opening its own dialog. */
  const configureProps = (column: GridColumn): { configureLabel?: string; onConfigure?: () => void } => {
    switch (column.type) {
      case "enrichment":
        return { configureLabel: "Edit enrichment", onConfigure: () => setEnrichmentPosition({ column }) };
      case "ai":
        return { configureLabel: "Edit AI column", onConfigure: () => setAiPosition({ column }) };
      case "http":
        return { configureLabel: "Edit HTTP API", onConfigure: () => setConfiguring({ type: "http", column }) };
      case "formula":
        return { configureLabel: "Edit formula", onConfigure: () => setConfiguring({ type: "formula", column }) };
      default:
        return {};
    }
  };

  const openPanel = (name: PanelName) => (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setPanel((p) => (p?.name === name ? null : { name, rect }));
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-white-0">
      {/* ---------- toolbar ---------- */}
      <div className="flex h-[52px] shrink-0 items-center gap-1.5 border-b border-stroke-soft-200 px-3">
        <div className="flex items-center rounded-lg border border-stroke-soft-200">
          <button
            type="button"
            onClick={toggleAutoRun}
            className={`flex items-center gap-1.5 rounded-l-lg px-2.5 py-[7px] text-[15px] font-medium transition ${
              autoRun ? "text-text-strong-950 hover:bg-bg-weak-50" : "text-text-soft-400 hover:bg-bg-weak-50"
            }`}
          >
            <RiRefreshLine className={`size-4 ${autoRun ? "text-emerald-500" : "text-text-disabled-300"}`} />
            Auto-run
          </button>
          <div className="h-5 w-px bg-bg-soft-200" />
          <span className="flex items-center gap-1.5 px-2.5 py-[7px] text-[15px] text-text-sub-600">
            <RiTableLine className="size-4 text-text-soft-400" />
            {activeJobs}
          </span>
        </div>

        {(activeJobs > 0 || pendingCells) && (
          <div className="flex items-center gap-1.5 rounded-lg border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/10 py-[3px] pl-2.5 pr-[3px] text-[15px] font-medium text-blue-700 dark:text-blue-400">
            <RiLoader4Line className="size-4 animate-spin" />
            <span>
              Running{activeJobs > 0 ? ` · ${activeJobs.toLocaleString()} left` : ""}
            </span>
            <button
              type="button"
              disabled={stopping}
              onClick={() => void stopRun()}
              className="flex items-center gap-1 rounded-md bg-bg-white-0 px-2 py-1 text-[14px] font-semibold text-red-600 dark:text-red-400 shadow-sm ring-1 ring-inset ring-stroke-soft-200 transition hover:bg-red-50 dark:hover:bg-red-500/10 disabled:opacity-50"
            >
              <RiStopCircleLine className="size-3.5" />
              {stopping ? "Stopping…" : "Stop"}
            </button>
          </div>
        )}

        <button
          type="button"
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-[7px] text-[15px] font-medium text-text-strong-950 transition hover:bg-bg-weak-50"
        >
          <RiTableLine className="size-4 text-text-soft-400" />
          Default view
        </button>

        <div className="flex items-center rounded-lg border border-stroke-soft-200">
          <button
            type="button"
            aria-label="Undo"
            title="Undo (Ctrl/Cmd+Z)"
            disabled={busy || historyCounts.undo === 0}
            onClick={() => void undoLastCellChange()}
            className="rounded-l-lg p-[7px] text-text-sub-600 transition hover:bg-bg-weak-50 disabled:cursor-not-allowed disabled:text-text-disabled-300"
          >
            <RiArrowGoBackLine className="size-4" />
          </button>
          <div className="h-5 w-px bg-bg-soft-200" />
          <button
            type="button"
            aria-label="Redo"
            title="Redo (Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y)"
            disabled={busy || historyCounts.redo === 0}
            onClick={() => void redoLastCellChange()}
            className="rounded-r-lg p-[7px] text-text-sub-600 transition hover:bg-bg-weak-50 disabled:cursor-not-allowed disabled:text-text-disabled-300"
          >
            <RiArrowGoForwardLine className="size-4" />
          </button>
        </div>

        <ToolbarToggle
          icon={RiLayoutColumnLine}
          label={`${visibleColumns.length}/${columns.length} columns`}
          active={panel?.name === "columns"}
          highlight={hidden.length > 0}
          onClick={openPanel("columns")}
        />

        <span className="flex items-center gap-1.5 rounded-lg px-2.5 py-[7px] text-[15px] font-medium text-text-strong-950">
          <RiTableLine className="size-4 text-text-soft-400" />
          {rowCount}/{unfiltered} rows
        </span>

        <ToolbarToggle
          icon={RiFilter3Line}
          label={activeFilterCount ? String(activeFilterCount) : undefined}
          title="Filter"
          active={panel?.name === "filter"}
          highlight={activeFilterCount > 0}
          onClick={openPanel("filter")}
        />
        <ToolbarToggle
          icon={RiSortDesc}
          label={sorts.length ? String(sorts.length) : undefined}
          title="Sort"
          active={panel?.name === "sort"}
          highlight={sorts.length > 0}
          onClick={openPanel("sort")}
        />
        <ToolbarToggle
          icon={RiSearchLine}
          title="Search"
          active={panel?.name === "search"}
          highlight={appliedSearch.length > 0}
          onClick={openPanel("search")}
        />

        {appliedSearch && (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              void runSearch("");
            }}
            className="flex items-center gap-1 rounded-md bg-blue-50 dark:bg-blue-500/10 px-2 py-1 text-[14px] font-medium text-blue-700 dark:text-blue-400"
          >
            “{appliedSearch}”
            <RiCloseLine className="size-3.5" />
          </button>
        )}

        {busy && <RiLoader4Line className="ml-1 size-4 animate-spin text-text-soft-400" />}

        <div className="ml-auto flex items-center gap-1.5">
          {selectedRowIds.length > 0 && (
            <span className="rounded-md bg-blue-50 dark:bg-blue-500/10 px-2.5 py-[7px] text-[15px] font-medium text-blue-700 dark:text-blue-400">
              {selectedRowIds.length} selected
            </span>
          )}
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="flex items-center gap-1.5 rounded-lg border border-stroke-soft-200 px-2.5 py-[7px] text-[15px] font-medium text-text-strong-950 transition hover:bg-bg-weak-50"
          >
            <RiUploadCloud2Line className="size-4 text-text-soft-400" />
            Import
          </button>
          <button
            type="button"
            onClick={(event) => setRowActionsRect(event.currentTarget.getBoundingClientRect())}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-[7px] text-[15px] font-medium text-white transition hover:bg-blue-700"
          >
            {selectedRowIds.length ? <RiMore2Line className="size-4" /> : <RiToolsLine className="size-4" />}
            Actions
            <RiArrowDownSLine className="size-4" />
          </button>
        </div>
      </div>

      {selectedRowIds.length > 0 && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-primary-alpha-20 bg-primary-alpha-10 px-3 py-2 text-[15px] text-text-sub-600">
          <span>
            {allMatchingSelected
              ? `All ${rowCount.toLocaleString()} matching rows are selected.`
              : `${selectedOnPage.toLocaleString()} row${selectedOnPage === 1 ? "" : "s"} on this page selected.`}
          </span>
          <div className="flex items-center gap-3 whitespace-nowrap">
            {!allMatchingSelected && selectedOnPage === pageRowIds.length && rowCount > pageRowIds.length && (
              <button
                type="button"
                onClick={() => void selectAllMatchingRows()}
                disabled={busy}
                className="font-semibold text-primary-base hover:text-primary-dark disabled:opacity-50"
              >
                Select all {rowCount.toLocaleString()} matching rows
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setSelectedRowIds([]);
                setAllMatchingSelected(false);
              }}
              className="font-medium text-text-soft-400 hover:text-text-strong-950"
            >
              Clear selection
            </button>
          </div>
        </div>
      )}

      {/* ---------- grid ---------- */}
      <div className="min-h-0 flex-1 overflow-auto bg-bg-white-0">
        <div
          ref={gridContainerRef}
          className="grid-clay h-full border-b border-stroke-soft-200"
          onCopy={onGridCopy}
          onCut={onGridCut}
          onPaste={onGridPaste}
          onKeyDown={onGridKeyDown}
          onPointerMove={onGridPointerMove}
          onPointerUp={(event) => finishFillDrag(event, true)}
          onPointerCancel={(event) => finishFillDrag(event, false)}
        >
          <AgGridReact<RowData>
            ref={gridRef}
            key={table.id}
            theme={theme}
            columnDefs={colDefs}
            defaultColDef={DEFAULT_COL_DEF}
            rowData={rowData}
            pinnedTopRowData={pinnedTop}
            getRowId={(p) => p.data.__id}
            getRowClass={(params) =>
              params.data && selectedRowIdSet.has(params.data.__id)
                ? "grid-row-selected"
                : undefined
            }
            headerHeight={HEADER_H}
            rowHeight={ROW_H}
            onCellValueChanged={onCellValueChanged}
            onCellClicked={onCellClicked}
            onCellKeyDown={onCellKeyDown}
            enterNavigatesVertically
            enterNavigatesVerticallyAfterEdit
            onCellMouseDown={onCellMouseDown}
            onCellFocused={onCellFocused}
            onColumnMoved={onColumnMoved}
            onDisplayedColumnsChanged={onDisplayedColumnsChanged}
            stopEditingWhenCellsLoseFocus
            animateRows={false}
          />
          <div
            ref={fillHandleElementRef}
            className="grid-fill-handle"
            aria-hidden="true"
            hidden
            onPointerDown={onFillHandlePointerDown}
          />
          {(error || notice) && (
            <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex flex-col items-center gap-2 px-3" role="status" aria-live="polite">
              {error && <Toast tone="error" onClose={() => setError(null)}>{error}</Toast>}
              {notice && <Toast tone="success" onClose={() => setNotice(null)}>{notice}</Toast>}
            </div>
          )}
          {cellSavingLabel && (
            <div className="pointer-events-none absolute right-3 top-3 z-20 flex items-center gap-1.5 rounded-md border border-blue-200 dark:border-blue-500/30 bg-bg-white-0/95 px-2.5 py-1.5 text-[14px] font-medium text-blue-700 dark:text-blue-400 shadow-sm">
              <RiLoader4Line className="size-3.5 animate-spin" />
              {cellSavingLabel}
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-14 shrink-0 items-center justify-between gap-4 border-t border-stroke-soft-200 bg-bg-white-0 px-3 text-[15px] text-text-sub-600">
        <AddRowsControl addRows={addRows} busy={busy} onAdd={appendRows} onCountChange={setAddRows} />
        <span className="ml-auto whitespace-nowrap tabular-nums">
          {visibleRange.start.toLocaleString()}–{visibleRange.end.toLocaleString()} of {rowCount.toLocaleString()}
        </span>
        <div className="flex items-center gap-1.5">
          <button type="button" disabled={busy || page === 0} onClick={() => void goToPage(0)} className="rounded-lg border border-stroke-soft-200 px-2.5 py-1.5 font-medium text-text-strong-950 hover:bg-bg-weak-50 disabled:opacity-40">First</button>
          <button type="button" aria-label="Previous page" disabled={busy || page === 0} onClick={() => void goToPage(page - 1)} className="rounded-lg border border-stroke-soft-200 p-1.5 text-text-strong-950 hover:bg-bg-weak-50 disabled:opacity-40"><RiArrowLeftSLine className="size-4" /></button>
          <label className="flex items-center gap-1.5 tabular-nums">
            <span>Page</span>
            <input
              key={page}
              aria-label="Page number"
              type="number"
              min={1}
              max={totalPages}
              defaultValue={page + 1}
              onBlur={(event) => {
                const target = clampGridPage(Number(event.currentTarget.value) - 1, rowCount);
                event.currentTarget.value = String(target + 1);
                void goToPage(target);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  const target = clampGridPage(Number(event.currentTarget.value) - 1, rowCount);
                  event.currentTarget.value = String(target + 1);
                  void goToPage(target);
                }
              }}
              className="w-16 rounded-lg border border-stroke-soft-200 px-2 py-1.5 text-center text-text-strong-950 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
            <span>of {totalPages}</span>
          </label>
          <button type="button" aria-label="Next page" disabled={busy || page >= totalPages - 1} onClick={() => void goToPage(page + 1)} className="rounded-lg border border-stroke-soft-200 p-1.5 text-text-strong-950 hover:bg-bg-weak-50 disabled:opacity-40"><RiArrowRightSLine className="size-4" /></button>
          <button type="button" disabled={busy || page >= totalPages - 1} onClick={() => void goToPage(totalPages - 1)} className="rounded-lg border border-stroke-soft-200 px-2.5 py-1.5 font-medium text-text-strong-950 hover:bg-bg-weak-50 disabled:opacity-40">Last</button>
        </div>
      </div>

      {/* ---------- popovers ---------- */}
      {runMenu && (
        <Popover anchorRect={runMenu.rect} onClose={closeRunMenu} width={260}>
          <div className="p-2">
            <p className="truncate px-3 pb-1.5 pt-1 text-[13px] font-semibold uppercase tracking-wide text-text-soft-400">
              Run {runMenu.column.name}
            </p>
            {selectedRowIds.length > 0 && (
              <button type="button" disabled={busy} onClick={() => void runColumn(runMenu.column, selectedRowIds)} className="flex w-full items-center gap-2 rounded-lg bg-primary-alpha-10 px-3 py-2 text-left text-[15px] font-semibold text-primary-base hover:bg-primary-alpha-20 disabled:opacity-50"><RiPlayLine className="size-4" />Run {selectedRowIds.length.toLocaleString()} selected row{selectedRowIds.length === 1 ? "" : "s"}</button>
            )}
            <button type="button" disabled={busy} onClick={() => void runColumn(runMenu.column, rowData.slice(0, 10).map((row) => row.__id))} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[15px] font-medium text-text-strong-950 hover:bg-bg-weak-50 disabled:opacity-50"><RiPlayLine className="size-4" />Run first 10 rows on this page</button>
            <button type="button" disabled={busy} onClick={() => void runColumn(runMenu.column)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[15px] font-medium text-text-strong-950 hover:bg-bg-weak-50 disabled:opacity-50"><RiPlayLine className="size-4" />Run all rows</button>
            <button type="button" disabled={busy} onClick={() => void runColumn(runMenu.column, undefined, { onlyEmpty: true })} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[15px] font-medium text-text-strong-950 hover:bg-bg-weak-50 disabled:opacity-50"><RiPlayLine className="size-4" />Run empty cells only</button>
          </div>
        </Popover>
      )}

      {panel?.name === "columns" && (
        <Popover anchorRect={panel.rect} onClose={closePanel} width={320}>
          <ColumnsMenu
            columns={columns}
            hidden={hidden}
            onChange={(nextHidden) => saveView({ ...view, hiddenColumns: nextHidden })}
          />
        </Popover>
      )}

      {panel?.name === "filter" && (
        <Popover anchorRect={panel.rect} onClose={closePanel} width={720}>
          <FilterPanel
            columns={columns}
            value={filters}
            onChange={(next) => saveView({ ...view, filters: next })}
          />
        </Popover>
      )}

      {panel?.name === "sort" && (
        <Popover anchorRect={panel.rect} onClose={closePanel} width={520}>
          <SortPanel
            columns={columns}
            value={sorts}
            onChange={(next) => saveView({ ...view, sorts: next })}
          />
        </Popover>
      )}

      {panel?.name === "search" && (
        <Popover anchorRect={panel.rect} onClose={closePanel} width={380}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch(search.trim());
              setPanel(null);
            }}
            className="flex items-center gap-2 p-2"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-stroke-soft-200 px-2.5 py-2">
              <RiSearchLine className="size-4 shrink-0 text-text-soft-400" />
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search"
                className="min-w-0 flex-1 bg-transparent text-[15px] text-text-strong-950 outline-none placeholder:text-text-soft-400"
              />
            </div>
            <button
              type="submit"
              className="shrink-0 rounded-lg border border-stroke-soft-200 px-2.5 py-2 text-[15px] font-medium text-text-strong-950 transition hover:bg-bg-weak-50"
            >
              Search
            </button>
          </form>
        </Popover>
      )}

      {columnMenu && (
        <Popover
          anchorRect={columnMenu.rect}
          onClose={closeColumnMenu}
          width={300}
        >
          <ColumnMenu
            column={columnMenu.column}
            columns={columns}
            pinned={pinned.includes(columnMenu.column.key)}
            onClose={closeColumnMenu}
            onError={(message) => setError(message)}
            onRename={(name) => patchColumn(columnMenu.column, { name })}
            onSaveOptions={(options) =>
              patchColumn(columnMenu.column, { config: { ...(columnMenu.column.config as object), options } })}
            onInsert={(side, rect) => {
              setColumnMenu(null);
              setAddMenu({
                rect,
                ...(side === "left"
                  ? { beforeColumnId: columnMenu.column.id }
                  : { afterColumnId: columnMenu.column.id }),
              });
            }}
            onChangeType={(type) => changeColumnType(columnMenu.column, type)}
            {...configureProps(columnMenu.column)}
            onDuplicate={() => duplicateColumn(columnMenu.column)}
            onSplit={(delimiter) => splitColumn(columnMenu.column, delimiter)}
            onSort={(direction) =>
              saveView({
                ...view,
                sorts: [
                  { columnKey: columnMenu.column.key, direction },
                  ...sorts.filter((sort) => sort.columnKey !== columnMenu.column.key),
                ],
              })
            }
            onDedupe={() => dedupeColumn(columnMenu.column)}
            onFilter={async (rect) => {
              const exists = filters.conditions.some(
                (condition) =>
                  !isFilterGroup(condition) && condition.columnKey === columnMenu.column.key,
              );
              if (!exists) {
                await saveView({
                  ...view,
                  filters: {
                    ...filters,
                    conditions: [
                      ...filters.conditions,
                      { columnKey: columnMenu.column.key, operator: "eq", value: "" },
                    ],
                  },
                });
              }
              setPanel({ name: "filter", rect });
            }}
            onPin={() =>
              saveView({
                ...view,
                pinnedColumns: pinned.includes(columnMenu.column.key)
                  ? pinned.filter((key) => key !== columnMenu.column.key)
                  : [...pinned, columnMenu.column.key],
              })
            }
            onHide={() =>
              saveView({
                ...view,
                hiddenColumns: hidden.includes(columnMenu.column.key)
                  ? hidden
                  : [...hidden, columnMenu.column.key],
              })
            }
            onDelete={() => deleteColumnFromMenu(columnMenu.column)}
          />
        </Popover>
      )}

      {rowActionsRect && (
        <Popover
          anchorRect={rowActionsRect}
          onClose={closeRowActions}
          width={252}
          align="right"
        >
          <div className="p-2">
            {/* The four column types worth one click. Everything else is a
                keystroke away behind "More column types", rather than making
                this menu a duplicate of the add-column list. */}
            <p className="px-2.5 pb-1 pt-1.5 text-[13px] font-semibold uppercase tracking-wide text-text-soft-400">
              Add column
            </p>
            {QUICK_COLUMN_TYPES.map((type) => {
              const meta = columnTypeMeta(type);
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => {
                    setRowActionsRect(null);
                    void addColumn(type);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[15px] text-text-strong-950 transition hover:bg-bg-weak-50"
                >
                  <meta.icon className="size-[17px] shrink-0 text-text-soft-400" />
                  {meta.label}
                </button>
              );
            })}
            <button
              type="button"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setRowActionsRect(null);
                setAddMenu({ rect });
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[15px] text-text-strong-950 transition hover:bg-bg-weak-50"
            >
              <RiAddLine className="size-[17px] shrink-0 text-text-soft-400" />
              More column types…
            </button>

            <div className="my-1.5 h-px bg-bg-weak-50" />
            <p className="px-2.5 pb-1 text-[13px] font-semibold uppercase tracking-wide text-text-soft-400">
              Table
            </p>
            <button
              type="button"
              onClick={() => {
                setRowActionsRect(null);
                setImportOpen(true);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[15px] text-text-strong-950 transition hover:bg-bg-weak-50"
            >
              <RiUploadCloud2Line className="size-[17px] shrink-0 text-text-soft-400" />
              Import CSV or Excel
            </button>

            {/* Row actions only exist when there is a selection, which is why
                this menu is no longer gated on one — the column and table
                actions above are always available. */}
            {selectedRowIds.length > 0 && (
              <>
                <div className="my-1.5 h-px bg-bg-weak-50" />
                <p className="px-2.5 pb-1 text-[13px] font-semibold uppercase tracking-wide text-text-soft-400">
                  {selectedRowIds.length} selected row{selectedRowIds.length === 1 ? "" : "s"}
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void exportSelectedRows()}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[15px] font-medium text-text-strong-950 transition hover:bg-bg-weak-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <RiDownload2Line className="size-[17px] text-text-soft-400" />
                  Export selected rows as CSV
                </button>
                <button
                  type="button"
                  disabled={selectedRowIds.length > 5000}
                  title={selectedRowIds.length > 5000 ? "Campaigns can contain at most 5,000 selected rows" : undefined}
                  onClick={() => {
                    setRowActionsRect(null);
                    setCreateCampaignOpen(true);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[15px] font-medium text-blue-700 dark:text-blue-400 transition hover:bg-blue-50 dark:hover:bg-blue-500/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <RiMegaphoneLine className="size-[17px]" />
                  Create campaign
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRowActionsRect(null);
                    void deleteSelectedRows();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[15px] font-medium text-red-600 dark:text-red-400 transition hover:bg-red-50 dark:hover:bg-red-500/10"
                >
                  <RiDeleteBin6Line className="size-[17px]" />
                  Delete {selectedRowIds.length} row{selectedRowIds.length === 1 ? "" : "s"}
                </button>
              </>
            )}
          </div>
        </Popover>
      )}

      <AddColumnMenu
        open={addMenu !== null}
        anchorRect={addMenu?.rect ?? null}
        onClose={closeAddMenu}
        onPick={addColumn}
      />

      {aiPosition && (
        <AiDialog
          // Mount a fresh form for each new/edit session. Its initial state is
          // derived from this column, and canceled edits must not leak forward.
          key={aiPosition.column?.id ?? "new-ai-column"}
          open
          tableId={table.id}
          columns={columns}
          firstRowIds={rowData.slice(0, 10).map((row) => row.__id)}
          afterColumnId={aiPosition.afterColumnId}
          beforeColumnId={aiPosition.beforeColumnId}
          column={aiPosition.column}
          onClose={() => setAiPosition(null)}
          onSaved={async (nextActiveJobs) => {
            if (nextActiveJobs !== undefined) setActiveJobs(nextActiveJobs);
            // A save can queue a run even when the count it reports is 0.
            startWatching();
            await refetch();
          }}
        />
      )}

      {enrichmentPosition && (
        <EnrichmentDialog
          // Keep enrichment on the same per-session lifecycle as AI.
          key={enrichmentPosition.column?.id ?? "new-enrichment-column"}
          open
          tableId={table.id}
          columns={columns}
          firstRowIds={rowData.slice(0, 10).map((row) => row.__id)}
          afterColumnId={enrichmentPosition.afterColumnId}
          beforeColumnId={enrichmentPosition.beforeColumnId}
          column={enrichmentPosition.column}
          onClose={() => setEnrichmentPosition(null)}
          onSaved={async (nextActiveJobs) => {
            if (nextActiveJobs !== undefined) setActiveJobs(nextActiveJobs);
            // A save can queue a run even when the count it reports is 0.
            startWatching();
            await refetch();
          }}
        />
      )}

      <ImportDialog
        open={importOpen}
        tableId={table.id}
        onClose={() => setImportOpen(false)}
        onImported={async ({ rowsInserted, columnsCreated }) => {
          setImportOpen(false);
          setNotice(
            `Imported ${rowsInserted.toLocaleString()} row${rowsInserted === 1 ? "" : "s"}` +
              (columnsCreated
                ? ` and created ${columnsCreated} column${columnsCreated === 1 ? "" : "s"}`
                : ""),
          );
          await refetch(appliedSearch, 0);
        }}
      />

      {createCampaignOpen && (
        <CreateCampaignFromGridDialog
          open
          tableId={table.id}
          columns={columns}
          rowIds={selectedRowIds}
          onClose={() => setCreateCampaignOpen(false)}
          onCreated={({ campaignId, channel, created, failed }) => {
            setCreateCampaignOpen(false);
            setSelectedRowIds([]);
            setAllMatchingSelected(false);
            setNotice(`Created ${channel === "email" ? "email" : "LinkedIn"} campaign with ${created} person${created === 1 ? "" : "s"}${failed ? `; ${failed} row${failed === 1 ? "" : "s"} skipped` : ""}. Campaign ID: ${campaignId}`);
          }}
        />
      )}

      {configuring && (
        <ColumnConfigDialog
          open
          tableId={table.id}
          type={configuring.type}
          column={configuring.column}
          columns={columns}
          previewRowId={rowData.find((row) => row.__id !== "__coverage")?.__id}
          afterColumnId={configuring.afterColumnId}
          beforeColumnId={configuring.beforeColumnId}
          onClose={() => setConfiguring(null)}
          onSaved={async (nextActiveJobs) => {
            if (nextActiveJobs !== undefined) setActiveJobs(nextActiveJobs);
            // A save can queue a run even when the count it reports is 0.
            startWatching();
            await refetch();
          }}
        />
      )}

      {cellDetails && (
        <CellDetailsPanel
          key={`${cellDetails.rowId}:${cellDetails.column.key}`}
          tableId={table.id}
          selection={cellDetails}
          onClose={() => setCellDetails(null)}
          onAdded={async (columnName) => {
            setNotice(`Added “${columnName}” as a column.`);
            await refetch();
          }}
        />
      )}
    </div>
  );
}

/** Floating message over the grid: it never moves the rows underneath it. */
function Toast({ tone, onClose, children }: { tone: "error" | "success"; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className={`pointer-events-auto flex max-w-xl items-start gap-2 rounded-lg border px-3 py-2 text-[15px] shadow-lg ${
        tone === "error"
          ? "border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-400"
          : "border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-400"
      }`}
    >
      <span className="min-w-0 flex-1 break-words">{children}</span>
      <button type="button" aria-label="Dismiss" onClick={onClose} className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100">
        <RiCloseLine className="size-4" />
      </button>
    </div>
  );
}

function ToolbarToggle({
  icon: Icon,
  label,
  title,
  active,
  highlight,
  onClick,
}: {
  icon: typeof RiTableLine;
  label?: string;
  title?: string;
  active?: boolean;
  highlight?: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg px-2.5 py-[7px] text-[15px] font-medium transition ${
        active
          ? "bg-bg-weak-50 text-text-strong-950"
          : highlight
            ? "bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-500/15"
            : "text-text-strong-950 hover:bg-bg-weak-50"
      }`}
    >
      <Icon className={`size-4 ${highlight && !active ? "text-blue-500" : "text-text-soft-400"}`} />
      {label}
    </button>
  );
}
