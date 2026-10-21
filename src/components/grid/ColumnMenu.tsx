"use client";

import { useState } from "react";
import {
  RiArrowLeftLine,
  RiArrowRightLine,
  RiArrowRightSLine,
  RiDeleteBin6Line,
  RiEyeOffLine,
  RiFileCopyLine,
  RiFilter3Line,
  RiGitBranchLine,
  RiListCheck,
  RiPencilLine,
  RiPushpinLine,
  RiSettings3Line,
  RiSortAsc,
  RiSortDesc,
  RiSplitCellsHorizontal,
} from "@remixicon/react";
import type { RemixiconComponentType } from "@remixicon/react";
import type { GridColumn } from "@/lib/grid/schema";
import type { ColumnType, StaticColumnType } from "@/lib/grid/types";
import { columnTypeMeta } from "./columnTypes";
import { effectiveColumnType } from "@/lib/grid/value-types";

const CHANGEABLE_TYPES: StaticColumnType[] = [
  "text",
  "number",
  "currency",
  "boolean",
  "date",
  "url",
  "email",
  "image",
  "select",
  "multiselect",
  "json",
];

export default function ColumnMenu({
  column,
  columns,
  pinned,
  configureLabel,
  onConfigure,
  onClose,
  onError,
  onRename,
  onSaveOptions,
  onInsert,
  onChangeType,
  onDuplicate,
  onSplit,
  onSort,
  onDedupe,
  onFilter,
  onPin,
  onHide,
  onDelete,
}: {
  column: GridColumn;
  columns: GridColumn[];
  pinned: boolean;
  /** Entry that opens the column's own setup dialog (enrichment, AI, HTTP, formula). */
  configureLabel?: string;
  onConfigure?: () => void;
  onClose: () => void;
  onError: (message: string) => void;
  onRename: (name: string) => Promise<void>;
  /** Select / multi-select only: replaces the column's option list. */
  onSaveOptions?: (options: string[]) => Promise<void>;
  onInsert: (side: "left" | "right", anchor: DOMRect) => void;
  onChangeType: (type: ColumnType) => Promise<void>;
  onDuplicate: () => Promise<void>;
  onSplit: (delimiter: "comma" | "space" | "semicolon" | "pipe") => Promise<void>;
  onSort: (direction: "asc" | "desc") => Promise<void>;
  onDedupe: () => Promise<void>;
  onFilter: (anchor: DOMRect) => Promise<void>;
  onPin: () => Promise<void>;
  onHide: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(column.name);
  const [showTypes, setShowTypes] = useState(false);
  const [showUsedIn, setShowUsedIn] = useState(false);
  const [submenu, setSubmenu] = useState<"insert" | "split" | "sort" | null>(null);
  const [busy, setBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [editingOptions, setEditingOptions] = useState(false);
  const [optionsText, setOptionsText] = useState(() => currentOptions(column).join("\n"));
  const [optionsError, setOptionsError] = useState<string | null>(null);

  const usedIn = columns.filter((candidate) => candidate.dependsOn.includes(column.key));
  const valueType = effectiveColumnType(column);
  // Output columns are shaped by their source; enrichment and AI columns have
  // no plain-column form to turn into.
  const isOutput = column.type === "integration_output" || column.type === "ai_output";
  const isSource = column.type === "enrichment" || column.type === "ai";
  const canChangeType = !isOutput && !isSource;
  // A copy of a source would share its output columns, and an output has no
  // setup of its own to copy.
  const canDuplicate = !isOutput && !isSource;
  const canSplit = valueType === "text" && !isSource;

  const trimmedName = name.trim();
  const nameTaken = columns.some(
    (candidate) => candidate.id !== column.id && candidate.name.trim().toLowerCase() === trimmedName.toLowerCase(),
  );
  const canSaveName = !busy && trimmedName !== "" && trimmedName !== column.name && !nameTaken;

  const submitRename = async () => {
    if (!canSaveName) return;
    setBusy(true);
    setRenameError(null);
    try {
      await onRename(trimmedName);
      onClose();
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : "Could not rename the column");
    } finally {
      setBusy(false);
    }
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      onClose();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Column action failed");
    } finally {
      setBusy(false);
    }
  };

  const hasOptions = onSaveOptions && (column.type === "select" || column.type === "multiselect");

  if (editingOptions && onSaveOptions) {
    const options = [...new Set(optionsText.split("\n").map((line) => line.trim()).filter(Boolean))];
    return (
      <form
        className="p-3"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setOptionsError(null);
          onSaveOptions(options)
            .then(onClose)
            .catch((error) => setOptionsError(error instanceof Error ? error.message : "Could not save the options"))
            .finally(() => setBusy(false));
        }}
      >
        <label className="mb-1.5 block text-[14px] font-medium text-text-sub-600">Options, one per line</label>
        <textarea
          autoFocus
          rows={6}
          value={optionsText}
          onChange={(event) => setOptionsText(event.target.value)}
          className="w-full resize-y rounded-lg border border-blue-500 px-2.5 py-2 text-[15px] text-text-strong-950 outline-none ring-1 ring-blue-500"
        />
        {optionsError && <p className="mt-1.5 text-[14px] text-red-600 dark:text-red-400">{optionsError}</p>}
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={() => setEditingOptions(false)} className="rounded-md px-2.5 py-1.5 text-[14px] text-text-sub-600 hover:bg-bg-weak-50">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="rounded-md bg-blue-600 px-2.5 py-1.5 text-[14px] font-medium text-white disabled:opacity-50">
            Save {options.length} option{options.length === 1 ? "" : "s"}
          </button>
        </div>
      </form>
    );
  }

  if (renaming) {
    return (
      <form
        className="p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmedName === column.name) onClose();
          else void submitRename();
        }}
      >
        <label className="mb-1.5 block text-[14px] font-medium text-text-sub-600">
          Rename column
        </label>
        <input
          autoFocus
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setRenameError(null);
          }}
          className="w-full rounded-lg border border-blue-500 px-2.5 py-2 text-[15px] text-text-strong-950 outline-none ring-1 ring-blue-500"
          onFocus={(event) => event.currentTarget.select()}
        />
        {(renameError || nameTaken) && (
          <p className="mt-1.5 text-[14px] text-red-600 dark:text-red-400">
            {renameError ?? "Another column already has this name."}
          </p>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={() => setRenaming(false)} className="rounded-md px-2.5 py-1.5 text-[14px] text-text-sub-600 hover:bg-bg-weak-50">
            Cancel
          </button>
          <button type="submit" disabled={!canSaveName} className="rounded-md bg-blue-600 px-2.5 py-1.5 text-[14px] font-medium text-white disabled:opacity-50">
            Save
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="p-2">
      {onConfigure && (
        <>
          <MenuButton icon={RiSettings3Line} label={configureLabel ?? "Configure…"} onClick={() => void run(async () => onConfigure())} />
          <Divider />
        </>
      )}
      <MenuButton icon={RiPencilLine} label="Rename column" onClick={() => setRenaming(true)} />
      {hasOptions && <MenuButton icon={RiListCheck} label="Edit options" onClick={() => setEditingOptions(true)} />}
      <HoverSubmenu
        icon={RiArrowRightLine}
        label="Insert column"
        open={submenu === "insert"}
        onOpen={() => setSubmenu("insert")}
        onClose={() => setSubmenu(null)}
      >
        <MenuButton icon={RiArrowLeftLine} label="Left" compact onClick={(event) => onInsert("left", event.currentTarget.getBoundingClientRect())} />
        <MenuButton icon={RiArrowRightLine} label="Right" compact onClick={(event) => onInsert("right", event.currentTarget.getBoundingClientRect())} />
      </HoverSubmenu>

      <Divider />
      <MenuButton icon={columnTypeMeta(valueType).icon} label={columnTypeMeta(valueType).label} suffix={canChangeType} active={showTypes} onClick={canChangeType ? () => setShowTypes((value) => !value) : undefined} />
      {showTypes && canChangeType && (
        <div className="ml-7 border-l border-stroke-soft-200 pl-1">
          {CHANGEABLE_TYPES.map((type) => {
            const meta = columnTypeMeta(type);
            return <MenuButton key={type} icon={meta.icon} label={meta.label} active={column.type === type} onClick={() => void run(() => onChangeType(type))} compact />;
          })}
        </div>
      )}

      <Divider />
      <MenuButton icon={RiGitBranchLine} label={`Used in${usedIn.length ? ` (${usedIn.length})` : "…"}`} suffix active={showUsedIn} onClick={() => setShowUsedIn((value) => !value)} />
      {showUsedIn && (
        <div className="ml-7 border-l border-stroke-soft-200 py-1 pl-3 text-[14px] text-text-sub-600">
          {usedIn.length ? usedIn.map((dependent) => <div key={dependent.id} className="py-1">{dependent.name}</div>) : "No columns depend on this one."}
        </div>
      )}
      {canDuplicate && (
        <MenuButton icon={RiFileCopyLine} label="Duplicate" disabled={busy} onClick={() => void run(onDuplicate)} />
      )}
      <HoverSubmenu
        icon={RiSplitCellsHorizontal}
        label="Text to columns"
        open={submenu === "split"}
        disabled={!canSplit || busy}
        title={canSplit ? undefined : "Change this column to Text before splitting it"}
        onOpen={() => setSubmenu("split")}
        onClose={() => setSubmenu(null)}
      >
        <MenuButton icon={RiSplitCellsHorizontal} label="Comma" compact onClick={() => void run(() => onSplit("comma"))} />
        <MenuButton icon={RiSplitCellsHorizontal} label="Space" compact onClick={() => void run(() => onSplit("space"))} />
        <MenuButton icon={RiSplitCellsHorizontal} label="Semicolon" compact onClick={() => void run(() => onSplit("semicolon"))} />
        <MenuButton icon={RiSplitCellsHorizontal} label="Pipe (|)" compact onClick={() => void run(() => onSplit("pipe"))} />
      </HoverSubmenu>
      <HoverSubmenu
        icon={RiSortAsc}
        label="Sort"
        open={submenu === "sort"}
        onOpen={() => setSubmenu("sort")}
        onClose={() => setSubmenu(null)}
      >
        <MenuButton icon={RiSortAsc} label="A → Z" compact onClick={() => void run(() => onSort("asc"))} />
        <MenuButton icon={RiSortDesc} label="Z → A" compact onClick={() => void run(() => onSort("desc"))} />
      </HoverSubmenu>

      <Divider />
      <MenuButton icon={RiGitBranchLine} label="Dedupe rows" disabled={busy} title="Keep the first row for each value in this column" onClick={() => void run(onDedupe)} />
      <MenuButton icon={RiFilter3Line} label="Filter on this column" onClick={(event) => void run(() => onFilter(event.currentTarget.getBoundingClientRect()))} />

      <Divider />
      <MenuButton icon={RiPushpinLine} label={pinned ? "Unpin" : "Pin"} onClick={() => void run(onPin)} />
      <MenuButton icon={RiEyeOffLine} label="Hide" onClick={() => void run(onHide)} />
      <MenuButton icon={RiDeleteBin6Line} label="Delete" danger disabled={busy} onClick={() => void run(onDelete)} />
    </div>
  );
}

function HoverSubmenu({
  icon,
  label,
  open,
  disabled,
  title,
  onOpen,
  onClose,
  children,
}: {
  icon: RemixiconComponentType;
  label: string;
  open: boolean;
  disabled?: boolean;
  title?: string;
  onOpen: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div onMouseEnter={disabled ? undefined : onOpen} onMouseLeave={onClose}>
      <MenuButton
        icon={icon}
        label={label}
        suffix
        active={open}
        disabled={disabled}
        title={title}
        onClick={disabled ? undefined : () => (open ? onClose() : onOpen())}
        onFocus={disabled ? undefined : onOpen}
      />
      {open && !disabled && (
        <div className="ml-7 border-l border-stroke-soft-200 py-0.5 pl-1">
          {children}
        </div>
      )}
    </div>
  );
}

function Divider() {
  return <div className="my-1.5 h-px bg-bg-weak-50" />;
}

function MenuButton({
  icon: Icon,
  label,
  suffix,
  active,
  compact,
  danger,
  disabled,
  title,
  onClick,
  onFocus,
}: {
  icon: RemixiconComponentType;
  label: string;
  suffix?: boolean;
  active?: boolean;
  compact?: boolean;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onFocus?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      onFocus={onFocus}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 text-left transition ${compact ? "py-1.5 text-[14px]" : "py-2 text-[15px]"} ${
        disabled
          ? "cursor-not-allowed text-text-disabled-300"
          : danger
            ? "text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
            : active
              ? "bg-bg-weak-50 text-text-strong-950"
              : "text-text-strong-950 hover:bg-bg-weak-50"
      }`}
    >
      <Icon className="size-[17px] shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {suffix && <RiArrowRightSLine className="size-4 shrink-0" />}
    </button>
  );
}

/** A select column's options as plain values (they may be stored as strings or {value, label}). */
function currentOptions(column: GridColumn): string[] {
  const options = (column.config as { options?: unknown } | null)?.options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option: unknown) => {
    if (typeof option === "string") return [option];
    const value = (option as { value?: unknown } | null)?.value;
    return typeof value === "string" ? [value] : [];
  });
}
