"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RiAddLine,
  RiArrowGoBackLine,
  RiCheckboxCircleLine,
  RiDeleteBinLine,
  RiPencilLine,
  RiSearchLine,
  RiStickyNoteLine,
  RiTaskLine,
} from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Checkbox from "@/components/alignui/checkbox";
import * as Input from "@/components/alignui/input";
import * as SegmentedControl from "@/components/alignui/segmented-control";
import * as Textarea from "@/components/alignui/textarea";
import { EmptyState } from "@/components/page/EmptyState";
import { PageHeader } from "@/components/page/PageHeader";
import { fullName } from "@/lib/format/contact";
import { useDialogs } from "@/components/DialogProvider";
import { cn } from "@/utils/cn";
import {
  DayHeading,
  InboxAvatar,
  InboxLayout,
  InlineError,
  ListCount,
  ListPane,
  ListSearch,
  ReadingEmpty,
  ReadingPane,
  RowBadge,
  RowsSkeleton,
  ThreadHeader,
  fullTime,
  rowTime,
  withDayBreaks,
} from "./shell/InboxShell";
import { useInboxHotkeys } from "./shell/hotkeys";

type Item = {
  id: string;
  leadId: string | null;
  name?: string; // tasks
  title?: string; // notes
  description: string | null;
  isCompleted?: boolean; // tasks only
  createdAt: string;
  leadEmail: string | null;
  leadFirstName: string | null;
  leadLastName: string | null;
};

type StatusFilter = "all" | "pending" | "completed";
const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "completed", label: "Done" },
];

const labelOf = (item: Item, isTasks: boolean) => (isTasks ? item.name : item.title) ?? "";
const leadNameOf = (item: Item) => fullName(item.leadFirstName, item.leadLastName) || item.leadEmail || "";

export default function NotesTasksClient({ mode }: { mode: "tasks" | "notes" }) {
  const dialogs = useDialogs();
  const isTasks = mode === "tasks";
  const noun = isTasks ? "task" : "note";
  const Noun = isTasks ? "Task" : "Note";
  const endpoint = isTasks ? "/api/outreach/inbox/tasks" : "/api/outreach/inbox/notes";
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  // Held by id so the detail pane shows the saved values after a reload.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");

  const fetchItems = useCallback(async () => {
    const res = await fetch(endpoint);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (isTasks ? data.tasks : data.notes) as Item[];
  }, [endpoint, isTasks]);

  useEffect(() => {
    let cancelled = false;
    fetchItems()
      .then((next) => {
        if (cancelled) return;
        setItems(next);
        setLoadError(false);
      })
      .catch(() => !cancelled && setLoadError(true))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [fetchItems]);

  /** Reload after a change; the list stays on screen, dimmed. */
  async function reload() {
    setRefreshing(true);
    try {
      setItems(await fetchItems());
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }

  const counts = useMemo(() => {
    const done = items.filter((item) => item.isCompleted).length;
    return { all: items.length, pending: items.length - done, completed: done };
  }, [items]);

  const filtered = useMemo(
    () =>
      items.filter((item) => {
        const label = labelOf(item, isTasks);
        const term = search.trim().toLowerCase();
        if (term && !`${label} ${item.description ?? ""} ${leadNameOf(item)}`.toLowerCase().includes(term)) return false;
        if (isTasks && statusFilter !== "all") return statusFilter === "completed" ? item.isCompleted : !item.isCompleted;
        return true;
      }),
    [items, isTasks, search, statusFilter],
  );
  const grouped = useMemo(() => withDayBreaks(filtered, (item) => new Date(item.createdAt)), [filtered]);
  const selected = items.find((item) => item.id === selectedId) ?? null;

  function openForCreate() {
    setSelectedId(null);
    setCreating(true);
    setEditing(true);
    setFormName("");
    setFormDescription("");
  }

  function openForEdit(item: Item) {
    setSelectedId(item.id);
    setCreating(false);
    setEditing(true);
    setFormName(labelOf(item, isTasks));
    setFormDescription(item.description ?? "");
  }

  function closeForm() {
    setEditing(false);
    setCreating(false);
  }

  async function handleSave() {
    if (!formName.trim() || saving) return;
    setSaving(true);
    try {
      const body = JSON.stringify(isTasks ? { name: formName, description: formDescription } : { title: formName, description: formDescription });
      if (creating) {
        const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body });
        const data = await res.json().catch(() => null);
        const created = (isTasks ? data?.task : data?.note) as Item | undefined;
        if (created?.id) setSelectedId(created.id);
      } else if (selected) {
        await fetch(`${endpoint}/${selected.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body });
      }
      closeForm();
      await reload();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(item: Item) {
    const ok = await dialogs.confirm({
      title: `Delete this ${noun}?`,
      description: "This cannot be undone.",
      confirmLabel: "Delete",
      variant: "error",
    });
    if (!ok) return;
    await fetch(`${endpoint}/${item.id}`, { method: "DELETE" });
    if (selectedId === item.id) setSelectedId(null);
    await reload();
  }

  async function handleToggleComplete(item: Item) {
    await fetch(`${endpoint}/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isCompleted: !item.isCompleted }),
    });
    await reload();
  }

  const narrowing = Boolean(search.trim()) || (isTasks && statusFilter !== "all");
  const paneOpen = editing || selected !== null;
  const listRef = useRef<HTMLDivElement>(null);
  const closeSelected = useCallback(() => setSelectedId(null), []);
  useInboxHotkeys({ listRef, onClose: selected && !editing ? closeSelected : null });

  const header = (
    <PageHeader
      back={{ href: "/outreach/inbox", label: "Master Inbox" }}
      title={isTasks ? "Tasks" : "Notes"}
      description={
        isTasks
          ? "Follow-ups to do, added here or from a thread in the Master Inbox."
          : "What you want to remember about a lead, added here or from a thread in the Master Inbox."
      }
      actions={
        <Button.Root variant="primary" mode="filled" size="small" onClick={openForCreate}>
          <Button.Icon as={RiAddLine} />
          New {noun}
        </Button.Root>
      }
    />
  );

  return (
    <InboxLayout header={header} threadOpen={paneOpen}>
      <ListPane
        label={isTasks ? "Tasks" : "Notes"}
        hidden={paneOpen}
        busy={refreshing}
        scrollRef={listRef}
        toolbar={
          <>
            <ListSearch value={search} onChange={setSearch} placeholder={`Search ${noun}s…`} label={`Search ${noun}s`} />
            <div className="flex items-center justify-between gap-2">
              {isTasks ? (
                <SegmentedControl.Root value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
                  <SegmentedControl.List className="w-auto">
                    {STATUS_FILTERS.map((f) => (
                      <SegmentedControl.Trigger key={f.key} value={f.key} className="gap-1.5 px-2.5">
                        {f.label}
                        <span className="tabular-nums text-text-soft-400">{counts[f.key]}</span>
                      </SegmentedControl.Trigger>
                    ))}
                  </SegmentedControl.List>
                </SegmentedControl.Root>
              ) : (
                <span className="text-label-sm text-text-strong-950">All notes</span>
              )}
              {!isTasks && <ListCount shown={filtered.length} total={items.length} noun={items.length === 1 ? "note" : "notes"} loading={loading} />}
            </div>
          </>
        }
      >
        {loadError && (
          <InlineError className="m-3" onRetry={() => void reload()}>
            Could not load {noun}s.
          </InlineError>
        )}
        {loading && items.length === 0 ? (
          <RowsSkeleton />
        ) : filtered.length === 0 ? (
          loadError ? null : narrowing && items.length > 0 ? (
            <EmptyState compact icon={RiSearchLine} title={`No ${noun}s match`} description="Try another search or status." />
          ) : (
            <EmptyState
              compact
              icon={isTasks ? RiTaskLine : RiStickyNoteLine}
              title={`No ${noun}s yet`}
              description={`Add one here, or with “+ ${Noun}” on a thread in the Master Inbox.`}
              action={
                <Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={openForCreate}>
                  <Button.Icon as={RiAddLine} />
                  New {noun}
                </Button.Root>
              }
            />
          )
        ) : (
          grouped.map(({ row: item, heading }) => {
            const label = labelOf(item, isTasks);
            const lead = leadNameOf(item);
            const isSelected = selectedId === item.id && !creating;
            const open = () => {
              setSelectedId(item.id);
              closeForm();
            };
            return (
              <div key={item.id}>
                {heading && <DayHeading>{heading}</DayHeading>}
                <div
                  role="button"
                  tabIndex={0}
                  data-inbox-row
                  aria-current={isSelected ? "true" : undefined}
                  onClick={open}
                  onKeyDown={(e) => {
                    if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      open();
                    }
                  }}
                  className={cn(
                    "mt-0.5 flex cursor-pointer items-start gap-3 rounded-xl py-2.5 pl-4 pr-3 outline-none transition-colors",
                    "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-base",
                    isSelected ? "bg-bg-weak-50 ring-1 ring-inset ring-stroke-soft-200" : "hover:bg-bg-weak-50",
                  )}
                >
                  {isTasks && (
                    <span className="pt-0.5" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      <Checkbox.Root
                        checked={item.isCompleted === true}
                        onCheckedChange={() => void handleToggleComplete(item)}
                        aria-label={item.isCompleted ? `Mark “${label}” as not done` : `Mark “${label}” as done`}
                      />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className={cn("truncate text-label-sm", item.isCompleted ? "text-text-soft-400 line-through" : "text-text-strong-950")} title={label}>
                        {label}
                      </p>
                      <span className="shrink-0 text-paragraph-xs tabular-nums text-text-soft-400" title={fullTime(new Date(item.createdAt))} suppressHydrationWarning>
                        {rowTime(new Date(item.createdAt))}
                      </span>
                    </div>
                    {item.description && <p className="mt-0.5 line-clamp-2 text-paragraph-xs text-text-sub-600">{item.description}</p>}
                    {lead && (
                      <p className="mt-1.5 flex min-w-0 items-center gap-1.5 text-paragraph-xs text-text-soft-400">
                        <InboxAvatar name={lead} size="sm" className="size-5 text-[10px] ring-0" />
                        <span className="truncate">{lead}</span>
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </ListPane>

      <ReadingPane shown={paneOpen}>
        {editing ? (
          <>
            <ThreadHeader onBack={closeForm} backLabel={`Back to ${noun}s`} title={creating ? `New ${noun}` : `Edit ${noun}`} />
            <form
              className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-5"
              onSubmit={(e) => {
                e.preventDefault();
                void handleSave();
              }}
            >
              <div className="max-w-xl space-y-4">
                <label className="block space-y-1.5">
                  <span className="block text-label-sm text-text-strong-950">{isTasks ? "Task" : "Title"}</span>
                  <Input.Root>
                    <Input.Wrapper>
                      <Input.Input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder={isTasks ? "Task name" : "Note title"} autoFocus />
                    </Input.Wrapper>
                  </Input.Root>
                </label>
                <label className="block space-y-1.5">
                  <span className="block text-label-sm text-text-strong-950">Description</span>
                  <Textarea.Root simple rows={6} value={formDescription} onChange={(e) => setFormDescription(e.target.value)} placeholder="Description…" />
                </label>
                <div className="flex items-center gap-2">
                  <Button.Root type="submit" variant="primary" mode="filled" size="small" disabled={!formName.trim() || saving}>
                    {saving ? "Saving…" : "Save"}
                  </Button.Root>
                  <Button.Root type="button" variant="neutral" mode="stroke" size="small" onClick={closeForm}>
                    Cancel
                  </Button.Root>
                </div>
              </div>
            </form>
          </>
        ) : selected ? (
          <>
            <ThreadHeader
              onBack={() => setSelectedId(null)}
              backLabel={`Back to ${noun}s`}
              title={<span className={cn(selected.isCompleted && "text-text-soft-400 line-through")}>{labelOf(selected, isTasks)}</span>}
              badges={isTasks ? <RowBadge tone={selected.isCompleted ? "green" : "gray"}>{selected.isCompleted ? "Done" : "Pending"}</RowBadge> : undefined}
              subtitle={<span suppressHydrationWarning>Created {fullTime(new Date(selected.createdAt))}</span>}
              actions={
                <>
                  {isTasks && (
                    <Button.Root variant="neutral" mode="stroke" size="xxsmall" onClick={() => void handleToggleComplete(selected)}>
                      <Button.Icon as={selected.isCompleted ? RiArrowGoBackLine : RiCheckboxCircleLine} />
                      {selected.isCompleted ? "Reopen" : "Mark done"}
                    </Button.Root>
                  )}
                  <Button.Root variant="neutral" mode="stroke" size="xxsmall" onClick={() => openForEdit(selected)}>
                    <Button.Icon as={RiPencilLine} />
                    Edit
                  </Button.Root>
                  <Button.Root variant="error" mode="stroke" size="xxsmall" onClick={() => void handleDelete(selected)}>
                    <Button.Icon as={RiDeleteBinLine} />
                    Delete
                  </Button.Root>
                </>
              }
            />
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-5">
              {selected.leadEmail && (
                <div className="flex max-w-xl items-center gap-3 rounded-xl bg-bg-weak-50 px-3 py-2.5 ring-1 ring-inset ring-stroke-soft-200">
                  <InboxAvatar name={leadNameOf(selected)} size="sm" className="bg-bg-white-0" />
                  <div className="min-w-0">
                    <p className="truncate text-label-sm text-text-strong-950">{leadNameOf(selected)}</p>
                    <p className="truncate text-paragraph-xs text-text-sub-600">{selected.leadEmail}</p>
                  </div>
                </div>
              )}
              {selected.description ? (
                <p className="max-w-xl whitespace-pre-wrap text-paragraph-sm text-text-strong-950">{selected.description}</p>
              ) : (
                <p className="text-paragraph-sm text-text-soft-400">No description.</p>
              )}
            </div>
          </>
        ) : (
          <ReadingEmpty
            icon={isTasks ? RiTaskLine : RiStickyNoteLine}
            title={`Select a ${noun}`}
            description={`Pick one from the list to read or edit it, or add a new ${noun}.`}
          />
        )}
      </ReadingPane>
    </InboxLayout>
  );
}
