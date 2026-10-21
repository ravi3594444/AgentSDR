"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowLeftLine,
  RiArrowRightLine,
  RiCheckLine,
  RiDatabase2Line,
  RiDeleteBin6Line,
  RiDragMove2Line,
  RiEditLine,
  RiFileCopyLine,
  RiFolder3Line,
  RiLoader4Line,
  RiSettings3Line,
  RiStarLine,
} from "@remixicon/react";
import * as Dropdown from "@/components/alignui/dropdown";
import type { GridColumn, GridRow, GridTable, GridWorkbook } from "@/lib/grid/schema";
import type { FolderCrumb } from "@/lib/grid/folders";
import type { TableView } from "@/lib/grid/types";
import { useDialogs } from "@/components/DialogProvider";
import GridClient from "./GridClient";
import MoveTableDialog from "./MoveTableDialog";
import SheetIcon from "./SheetIcon";
import WorkbookIcon from "./WorkbookIcon";

function WorkbookActionsMenu({
  children,
  onRename,
  onSettings,
  onDelete,
}: {
  children: ReactNode;
  onRename: () => void;
  onSettings: () => void;
  onDelete: () => void;
}) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>{children}</Dropdown.Trigger>
      <Dropdown.Content align="start" className="w-[280px] rounded-xl">
        <Dropdown.Item onSelect={onRename}><Dropdown.ItemIcon as={RiEditLine} />Rename workbook</Dropdown.Item>
        <Dropdown.Item onSelect={onSettings}><Dropdown.ItemIcon as={RiSettings3Line} />Edit workbook settings</Dropdown.Item>
        <Dropdown.Item disabled><Dropdown.ItemIcon as={RiFileCopyLine} />Duplicate</Dropdown.Item>
        <Dropdown.Item disabled><Dropdown.ItemIcon as={RiStarLine} />Add to favorites</Dropdown.Item>
        <Dropdown.Item disabled><Dropdown.ItemIcon as={RiDragMove2Line} />Move workbook</Dropdown.Item>
        <Dropdown.Item disabled><Dropdown.ItemIcon as={RiDatabase2Line} />View credit usage</Dropdown.Item>
        <Dropdown.Separator />
        <Dropdown.Item destructive onSelect={onDelete}><Dropdown.ItemIcon as={RiDeleteBin6Line} />Delete workbook</Dropdown.Item>
      </Dropdown.Content>
    </Dropdown.Root>
  );
}

function TableActionsMenu({
  children,
  canMoveLeft,
  canMoveRight,
  canDelete,
  onRename,
  onSettings,
  onMoveLeft,
  onMoveRight,
  onMove,
  onDuplicate,
  onDelete,
}: {
  children: ReactNode;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  canDelete: boolean;
  onRename: () => void;
  onSettings: () => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  onMove: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>{children}</Dropdown.Trigger>
      <Dropdown.Content align="start" className="w-[244px] rounded-xl">
        <Dropdown.Item onSelect={onRename}><Dropdown.ItemIcon as={RiEditLine} />Rename</Dropdown.Item>
        <Dropdown.Item onSelect={onSettings}><Dropdown.ItemIcon as={RiSettings3Line} />Edit table settings</Dropdown.Item>
        <Dropdown.Separator />
        {/* The click-and-keyboard path to what dragging a tab does — dragging
            alone would leave reordering unreachable without a mouse. */}
        <Dropdown.Item disabled={!canMoveLeft} onSelect={onMoveLeft}>
          <Dropdown.ItemIcon as={RiArrowLeftLine} />Move left
        </Dropdown.Item>
        <Dropdown.Item disabled={!canMoveRight} onSelect={onMoveRight}>
          <Dropdown.ItemIcon as={RiArrowRightLine} />Move right
        </Dropdown.Item>
        <Dropdown.Item onSelect={onMove}><Dropdown.ItemIcon as={RiDragMove2Line} />Move to workbook…</Dropdown.Item>
        <Dropdown.Item onSelect={onDuplicate}><Dropdown.ItemIcon as={RiFileCopyLine} />Duplicate table</Dropdown.Item>
        <Dropdown.Separator />
        <Dropdown.Item
          destructive
          disabled={!canDelete}
          title={canDelete ? undefined : "A workbook needs at least one table"}
          onSelect={onDelete}
        >
          <Dropdown.ItemIcon as={RiDeleteBin6Line} />Delete
        </Dropdown.Item>
      </Dropdown.Content>
    </Dropdown.Root>
  );
}

/** How long a prefetched sheet stays servable before it is refetched. */
const SHEET_TTL_MS = 15_000;

type SheetCacheEntry = { at: number; promise: Promise<SheetPayload | null> };

export type SheetPayload = {
  table: GridTable;
  columns: GridColumn[];
  rows: GridRow[];
  /** Rows matching the saved view. */
  total: number;
  /** Rows in the table regardless of the view, for the "12/400 rows" label. */
  unfilteredTotal: number;
  cursor: number;
  coverage: Record<string, number>;
  activeJobs: number;
  view: TableView;
};

export default function WorkbookClient({
  workbook,
  tables: initialTables,
  breadcrumbs,
  initialSheet,
}: {
  workbook: GridWorkbook;
  tables: GridTable[];
  /** Folder trail above this workbook, root-first — matches the file list. */
  breadcrumbs: FolderCrumb[];
  initialSheet: SheetPayload;
}) {
  const router = useRouter();
  const dialogs = useDialogs();
  const [currentWorkbook, setCurrentWorkbook] = useState(workbook);
  const [tables, setTables] = useState(initialTables);
  const [sheet, setSheet] = useState<SheetPayload>(initialSheet);
  const [loading, setLoading] = useState(false);
  /**
   * The tab the user just clicked, highlighted before its data arrives.
   *
   * Without it the whole switch is invisible until the fetch lands — the old
   * sheet stays on screen under an unchanged tab strip, which reads as a dead
   * click rather than as loading.
   */
  const [pendingId, setPendingId] = useState<string | null>(null);
  /** Gates the overlay so an already-prefetched switch does not flash it. */
  const [showLoadingOverlay, setShowLoadingOverlay] = useState(false);
  const [saving, setSaving] = useState(false);
  const [movingTable, setMovingTable] = useState<GridTable | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const activeId = sheet.table.id;
  /** What the tab strip paints as current: the click wins over the load. */
  const selectedId = pendingId ?? activeId;
  const pendingTable = pendingId ? tables.find((t) => t.id === pendingId) : null;

  // Drag handlers reorder `tables` on every dragover for a live preview, then
  // persist once on drop. The drop handler reads the order through this ref
  // rather than its own closure, which was captured before those reorders.
  const tablesRef = useRef(tables);
  // eslint-disable-next-line react-hooks/refs -- intentional: ref read/written during render to expose the latest value to event handlers
  tablesRef.current = tables;

  /** Tab order when the drag began, so a drag back to the start saves nothing. */
  const orderAtDragStart = useRef<string[] | null>(null);
  /** Set by a real drop, so the dragend that follows it is not read as a cancel. */
  const droppedRef = useRef(false);

  /**
   * In-flight and recently-finished sheet fetches, keyed by table id.
   *
   * Hovering a tab starts its fetch, so by the time the click lands the data
   * is usually already here. Entries are short-lived and the sheet being left
   * is evicted on the way out, so an edit made in GridClient — which refetches
   * into its own state, not through here — can never be served back as stale.
   */
  const sheetCache = useRef(new Map<string, SheetCacheEntry>());

  const fetchSheet = useCallback((tableId: string) => {
    const cached = sheetCache.current.get(tableId);
    if (cached && Date.now() - cached.at < SHEET_TTL_MS) return cached.promise;

    // Built in two steps so the fetch body can identify its own entry when it
    // fails — the object has to exist before the promise that references it.
    const entry: SheetCacheEntry = { at: Date.now(), promise: Promise.resolve(null) };
    entry.promise = (async (): Promise<SheetPayload | null> => {
      try {
        const res = await fetch(`/api/grid/tables/${tableId}`);
        if (!res.ok) throw new Error("request failed");
        const d = await res.json();
        return {
          table: d.table,
          columns: d.columns,
          rows: d.rows,
          total: d.total,
          unfilteredTotal: d.unfilteredTotal ?? d.total,
          cursor: d.cursor,
          coverage: d.coverage ?? {},
          activeJobs: d.activeJobs ?? 0,
          view: d.view ?? {},
        };
      } catch {
        // Never cache a failure: drop this entry so the next attempt retries
        // instead of replaying the error for the rest of the TTL. Guarded on
        // identity so a newer entry for the same tab is not evicted.
        if (sheetCache.current.get(tableId) === entry) sheetCache.current.delete(tableId);
        return null;
      }
    })();
    sheetCache.current.set(tableId, entry);
    return entry.promise;
  }, []);

  /** Bumped per switch so a slow first click cannot overwrite a faster second. */
  const loadSeq = useRef(0);

  const loadSheet = useCallback(async (tableId: string) => {
    const seq = ++loadSeq.current;
    // The sheet being left may have been edited in GridClient since it was
    // cached, so its entry goes rather than being served back later.
    sheetCache.current.delete(activeId);
    setPendingId(tableId);
    setLoading(true);
    try {
      const payload = await fetchSheet(tableId);
      if (seq !== loadSeq.current) return;
      if (payload) {
        setSheet(payload);
      } else {
        void dialogs.alert({
          title: "Could not open that table",
          description: "The table did not load. Check your connection and try again.",
          variant: "error",
        });
      }
    } finally {
      if (seq === loadSeq.current) {
        setPendingId(null);
        setLoading(false);
        setShowLoadingOverlay(false);
      }
    }
  }, [activeId, dialogs, fetchSheet]);

  // A switch that resolves from the prefetch cache finishes in a frame or two.
  // Showing the overlay only once it has actually taken a moment keeps those
  // from flashing a spinner that is gone before it can be read.
  useEffect(() => {
    if (!loading) return;
    const timer = window.setTimeout(() => setShowLoadingOverlay(true), 120);
    return () => window.clearTimeout(timer);
  }, [loading]);

  const refreshTabs = useCallback(async () => {
    const res = await fetch(`/api/grid/tables?workbookId=${workbook.id}`);
    if (res.ok) setTables((await res.json()).tables);
  }, [workbook.id]);

  const addSheet = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/grid/tables", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workbookId: workbook.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        void dialogs.alert({
          title: "Could not add a table",
          description: data.error,
          variant: "error",
        });
        return;
      }
      await refreshTabs();
      await loadSheet(data.table.id);
    } finally {
      setSaving(false);
    }
  }, [workbook.id, dialogs, refreshTabs, loadSheet]);

  const renameWorkbook = useCallback(async () => {
    const name = (
      await dialogs.prompt({
        title: "Rename workbook",
        label: "Name",
        defaultValue: currentWorkbook.name,
        confirmLabel: "Rename",
      })
    )?.trim();
    if (!name || name === currentWorkbook.name) return;
    const res = await fetch(`/api/grid/workbooks/${currentWorkbook.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return dialogs.alert({
        title: "Could not rename workbook",
        description: data.error,
        variant: "error",
      });
    }
    setCurrentWorkbook(data.workbook);
  }, [currentWorkbook, dialogs]);

  const editWorkbookSettings = useCallback(async () => {
    const description = await dialogs.prompt({
      title: "Workbook settings",
      label: "Description",
      defaultValue: currentWorkbook.description ?? "",
      placeholder: "What this workbook is for",
      allowEmpty: true,
    });
    if (description === null) return;
    const res = await fetch(`/api/grid/workbooks/${currentWorkbook.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: description.trim() || null }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return dialogs.alert({
        title: "Could not update workbook",
        description: data.error,
        variant: "error",
      });
    }
    setCurrentWorkbook(data.workbook);
  }, [currentWorkbook, dialogs]);

  const removeWorkbook = useCallback(async () => {
    const ok = await dialogs.confirm({
      title: "Delete workbook?",
      description: `“${currentWorkbook.name}” and every table, column and row inside it will be permanently deleted. This cannot be undone.`,
      confirmLabel: "Delete workbook",
      variant: "error",
    });
    if (!ok) return;
    const res = await fetch(`/api/grid/workbooks/${currentWorkbook.id}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return dialogs.alert({
        title: "Could not delete workbook",
        description: data.error,
        variant: "error",
      });
    }
    router.push("/tables");
    router.refresh();
  }, [currentWorkbook, dialogs, router]);

  const patchTable = useCallback(async (table: GridTable, patch: Record<string, unknown>) => {
    const res = await fetch(`/api/grid/tables/${table.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      void dialogs.alert({
        title: "Could not update table",
        description: data.error,
        variant: "error",
      });
      return null;
    }
    // Take only the fields this patch changed (plus the timestamp). The open
    // grid owns the rest, such as Auto-run, and the server copy may not match
    // what it shows until its next load.
    const changed = Object.fromEntries(
      [...Object.keys(patch), "updatedAt"]
        .filter((key) => key in data.table)
        .map((key) => [key, data.table[key]]),
    );
    setTables((all) => all.map((item) => item.id === table.id ? { ...item, ...changed } : item));
    if (table.id === activeId) {
      setSheet((current) => ({ ...current, table: { ...current.table, ...changed } }));
    }
    return data.table as GridTable;
  }, [activeId, dialogs]);

  // Inline rename from double-clicking a tab. `finishedRef` keeps Enter (which
  // unmounts the input and so blurs it) from committing a second time.
  const [editingTableId, setEditingTableId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const finishedRef = useRef(false);
  const finishInlineRename = useCallback(async (table: GridTable, commit: boolean) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setEditingTableId(null);
    const name = editingName.trim();
    if (commit && name && name !== table.name) await patchTable(table, { name });
  }, [editingName, patchTable]);

  const renameTable = useCallback(async (table: GridTable) => {
    const name = (
      await dialogs.prompt({
        title: "Rename table",
        label: "Name",
        defaultValue: table.name,
        confirmLabel: "Rename",
      })
    )?.trim();
    if (!name || name === table.name) return;
    await patchTable(table, { name });
  }, [dialogs, patchTable]);

  const editTableSettings = useCallback(async (table: GridTable) => {
    const description = await dialogs.prompt({
      title: "Table settings",
      label: "Description",
      defaultValue: table.description ?? "",
      placeholder: "What this table holds",
      allowEmpty: true,
    });
    if (description === null) return;
    await patchTable(table, { description: description.trim() || null });
  }, [dialogs, patchTable]);

  const removeTable = useCallback(async (table: GridTable) => {
    if (tables.length === 1) {
      await dialogs.alert({
        title: "This is the only table",
        description: "A workbook must contain at least one table. Add another before deleting this one.",
      });
      return;
    }
    const ok = await dialogs.confirm({
      title: "Delete table?",
      description: `“${table.name}” and all of its columns and rows will be permanently deleted. This cannot be undone.`,
      confirmLabel: "Delete table",
      variant: "error",
    });
    if (!ok) return;
    const res = await fetch(`/api/grid/tables/${table.id}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return dialogs.alert({
        title: "Could not delete table",
        description: data.error,
        variant: "error",
      });
    }

    const remaining = tables.filter((item) => item.id !== table.id);
    setTables(remaining);
    if (table.id === activeId) {
      await loadSheet(remaining[0].id);
    }
  }, [activeId, dialogs, loadSheet, tables]);

  const persistOrder = useCallback(async (ordered: GridTable[]) => {
    const res = await fetch(`/api/grid/workbooks/${workbook.id}/tables/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tableIds: ordered.map((t) => t.id) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      void dialogs.alert({
        title: "Could not reorder those tables",
        description: data.error,
        variant: "error",
      });
      await refreshTabs();
      return;
    }
    setTables(data.tables);
  }, [dialogs, refreshTabs, workbook.id]);

  /** Swaps a tab with its neighbour — the menu's Move left / Move right. */
  const nudgeTable = useCallback(async (table: GridTable, delta: -1 | 1) => {
    const current = tablesRef.current;
    const from = current.findIndex((t) => t.id === table.id);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= current.length) return;

    const next = [...current];
    [next[from], next[to]] = [next[to], next[from]];
    setTables(next);
    await persistOrder(next);
  }, [persistOrder]);

  const onTabDragOver = useCallback((event: React.DragEvent, targetId: string) => {
    event.preventDefault();
    if (!dragId || dragId === targetId) return;
    setTables((current) => {
      const from = current.findIndex((t) => t.id === dragId);
      const to = current.findIndex((t) => t.id === targetId);
      if (from === -1 || to === -1) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, [dragId]);

  const onTabDrop = useCallback(async () => {
    if (!dragId) return;
    setDragId(null);

    // A drag that ended where it started is a no-op, not a write.
    const ordered = tablesRef.current;
    const before = orderAtDragStart.current;
    orderAtDragStart.current = null;
    if (!before || before.join() === ordered.map((t) => t.id).join()) return;

    await persistOrder(ordered);
  }, [dragId, persistOrder]);

  const cancelTabDrag = useCallback(() => {
    const before = orderAtDragStart.current;
    orderAtDragStart.current = null;
    setDragId(null);
    if (!before) return;
    setTables((current) => {
      const restored = before.flatMap((id) => current.find((t) => t.id === id) ?? []);
      return restored.length === current.length ? restored : current;
    });
  }, []);

  const duplicateTable = useCallback(async (table: GridTable) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/grid/tables/${table.id}/duplicate`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return dialogs.alert({
          title: "Could not duplicate that table",
          description: data.error,
          variant: "error",
        });
      }
      await refreshTabs();
      await loadSheet(data.table.id);
    } finally {
      setSaving(false);
    }
  }, [dialogs, loadSheet, refreshTabs]);

  const moveTableToWorkbook = useCallback(async (destinationWorkbookId: string) => {
    const table = movingTable;
    if (!table) return;

    const res = await fetch(`/api/grid/tables/${table.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workbookId: destinationWorkbookId }),
    });
    const data = await res.json().catch(() => ({}));
    // Thrown so MoveTableDialog can show the reason inline and stay open.
    if (!res.ok) throw new Error(data.error ?? "Could not move that table");

    setMovingTable(null);
    const remaining = tablesRef.current.filter((t) => t.id !== table.id);
    setTables(remaining);
    // The open sheet just left this workbook, so fall back to a tab that
    // is still here rather than rendering a table that moved away.
    if (table.id === activeId && remaining.length) await loadSheet(remaining[0].id);
    router.refresh();
  }, [activeId, loadSheet, movingTable, router]);

  // Keep the URL pointing at the open sheet, so a refresh or a shared link
  // reopens the same tab instead of snapping back to the first one.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("table") !== activeId) {
      url.searchParams.set("table", activeId);
      window.history.replaceState(null, "", url);
    }
  }, [activeId]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-white-0">
      {/* ---------- breadcrumb ---------- */}
      <div className="flex h-[46px] shrink-0 items-center gap-1.5 border-b border-stroke-soft-200 px-3 text-[15px]">
        <Link
          href="/tables"
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-text-sub-600 transition hover:bg-bg-weak-50"
        >
          <RiFolder3Line className="size-4 text-text-soft-400" />
          All Files
        </Link>
        {/* The folders this workbook is filed under. Without them the trail
            claimed every workbook sat at the root, and the one link out went
            to All Files rather than back to the folder the user came from. */}
        {breadcrumbs.map((crumb) => (
          <span key={crumb.id} className="flex items-center gap-1.5">
            <span className="text-text-disabled-300">/</span>
            <Link
              href={`/tables?folder=${crumb.id}`}
              className="max-w-[180px] truncate rounded-md px-1.5 py-1 text-text-sub-600 transition hover:bg-bg-weak-50"
            >
              {crumb.name}
            </Link>
          </span>
        ))}
        <span className="text-text-disabled-300">/</span>
        <WorkbookActionsMenu
          onRename={() => void renameWorkbook()}
          onSettings={() => void editWorkbookSettings()}
          onDelete={() => void removeWorkbook()}
        >
          <button type="button" className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-text-strong-950 transition hover:bg-bg-weak-50">
            <WorkbookIcon />
            {currentWorkbook.name}
            <RiArrowDownSLine className="size-4 text-text-soft-400" />
          </button>
        </WorkbookActionsMenu>
        <span className="text-text-disabled-300">/</span>
        <TableActionsMenu
          canMoveLeft={tables.findIndex((t) => t.id === activeId) > 0}
          canMoveRight={tables.findIndex((t) => t.id === activeId) < tables.length - 1}
          canDelete={tables.length > 1}
          onRename={() => void renameTable(sheet.table)}
          onSettings={() => void editTableSettings(sheet.table)}
          onMoveLeft={() => void nudgeTable(sheet.table, -1)}
          onMoveRight={() => void nudgeTable(sheet.table, 1)}
          onMove={() => setMovingTable(sheet.table)}
          onDuplicate={() => void duplicateTable(sheet.table)}
          onDelete={() => void removeTable(sheet.table)}
        >
          <button type="button" className="flex items-center gap-1.5 rounded-md px-1.5 py-1 font-medium text-text-strong-950 transition hover:bg-bg-weak-50">
            <SheetIcon />
            {sheet.table.name}
            <RiArrowDownSLine className="size-4 text-text-soft-400" />
          </button>
        </TableActionsMenu>
        {loading && <RiLoader4Line className="size-4 animate-spin text-text-soft-400" />}
      </div>

      {/* ---------- grid ---------- */}
      <div className="relative min-h-0 flex-1">
        {loading && showLoadingOverlay && (
          // Covers the outgoing sheet rather than sitting beside it: leaving
          // the previous table's rows fully legible under a corner spinner is
          // what made a switch look like it had not happened.
          <div className="absolute inset-0 z-20 flex items-start justify-center bg-bg-white-0/70 pt-24">
            <span className="flex items-center gap-2 rounded-full border border-stroke-soft-200 bg-bg-white-0 px-3.5 py-2 text-[15px] font-medium text-text-sub-600 shadow-sm">
              <RiLoader4Line className="size-4 animate-spin text-blue-600 dark:text-blue-400" />
              Loading {pendingTable?.name ?? "table"}…
            </span>
          </div>
        )}
        <GridClient
          key={sheet.table.id}
          table={sheet.table}
          columns={sheet.columns}
          rows={sheet.rows}
          cursor={sheet.cursor}
          total={sheet.total}
          unfilteredTotal={sheet.unfilteredTotal}
          coverage={sheet.coverage}
          initialActiveJobs={sheet.activeJobs}
          view={sheet.view}
          onTableChanged={refreshTabs}
        />
      </div>

      {/* ---------- sheet tabs ---------- */}
      <div className="flex h-[48px] shrink-0 items-center gap-1 border-t border-stroke-soft-200 px-3">
        <div className="flex items-center gap-1 overflow-x-auto">
          {tables.map((t, index) => {
            const active = t.id === selectedId;
            const dragging = t.id === dragId;
            return (
              <div
                key={t.id}
                draggable={editingTableId !== t.id}
                onDragStart={() => {
                  setDragId(t.id);
                  orderAtDragStart.current = tablesRef.current.map((item) => item.id);
                  droppedRef.current = false;
                }}
                onDragOver={(event) => onTabDragOver(event, t.id)}
                onDrop={() => {
                  droppedRef.current = true;
                  void onTabDrop();
                }}
                onDragEnd={() => {
                  // Esc or a drop outside any tab ends the drag without a drop:
                  // put the tabs back instead of saving the live preview.
                  if (!droppedRef.current) cancelTabDrag();
                }}
                title="Drag to reorder"
                className={`flex shrink-0 cursor-grab items-center border-t-2 text-[15px] font-medium transition active:cursor-grabbing ${
                  active
                    ? "border-blue-600 text-blue-600 dark:text-blue-400"
                    : "border-transparent text-text-sub-600 hover:bg-bg-weak-50"
                } ${dragging ? "opacity-40" : ""}`}
              >
                {editingTableId === t.id ? (
                  <span className="flex items-center gap-1.5 py-[5px] pl-2.5 pr-1">
                    <SheetIcon />
                    <input
                      autoFocus
                      aria-label="Table name"
                      value={editingName}
                      maxLength={200}
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) => setEditingName(event.target.value)}
                      onBlur={() => void finishInlineRename(t, true)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void finishInlineRename(t, true);
                        else if (event.key === "Escape") void finishInlineRename(t, false);
                      }}
                      className="w-[140px] rounded border border-blue-500 bg-bg-white-0 px-1.5 py-0.5 text-[15px] font-medium text-text-strong-950 outline-none"
                    />
                  </span>
                ) : (
                <button
                  type="button"
                  onClick={() => !active && loadSheet(t.id)}
                  onDoubleClick={() => {
                    finishedRef.current = false;
                    setEditingName(t.name);
                    setEditingTableId(t.id);
                  }}
                  // Start the fetch on approach. A pointer takes a few hundred
                  // milliseconds to travel and press, which is most of what the
                  // switch used to spend waiting after the click.
                  onPointerEnter={() => !active && void fetchSheet(t.id)}
                  onFocus={() => !active && void fetchSheet(t.id)}
                  className="flex items-center gap-1.5 py-[7px] pl-2.5 pr-1"
                >
                  <SheetIcon />
                  {t.name}
                </button>
                )}
                <TableActionsMenu
                  canMoveLeft={index > 0}
                  canMoveRight={index < tables.length - 1}
                  canDelete={tables.length > 1}
                  onRename={() => void renameTable(t)}
                  onSettings={() => void editTableSettings(t)}
                  onMoveLeft={() => void nudgeTable(t, -1)}
                  onMoveRight={() => void nudgeTable(t, 1)}
                  onMove={() => setMovingTable(t)}
                  onDuplicate={() => void duplicateTable(t)}
                  onDelete={() => void removeTable(t)}
                >
                  <button
                    type="button"
                    aria-label={`Actions for ${t.name}`}
                    className="py-[7px] pl-1 pr-2.5"
                  >
                    <RiArrowDownSLine className={`size-4 ${active ? "text-blue-500" : "text-text-soft-400"}`} />
                  </button>
                </TableActionsMenu>
              </div>
            );
          })}
        </div>

        <button
          type="button"
          onClick={addSheet}
          disabled={saving}
          className="ml-1 flex shrink-0 items-center gap-1.5 rounded-lg border border-stroke-soft-200 px-2.5 py-[7px] text-[15px] font-medium text-text-strong-950 transition hover:bg-bg-weak-50 disabled:opacity-50"
        >
          {saving ? <RiLoader4Line className="size-4 animate-spin" /> : <RiAddLine className="size-4" />}
          Add
        </button>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="flex items-center gap-1.5 px-2 text-[15px] text-text-sub-600">
            <RiCheckLine className="size-4 text-emerald-500" />
            Table up to date
          </span>
        </div>
      </div>

      <MoveTableDialog
        open={movingTable !== null}
        tableName={movingTable?.name ?? ""}
        currentWorkbookId={currentWorkbook.id}
        blockedReason={
          tables.length <= 1
            ? "This is the workbook's only table. Duplicate it first — a workbook must keep at least one."
            : null
        }
        onClose={() => setMovingTable(null)}
        onMove={moveTableToWorkbook}
      />
    </div>
  );
}
