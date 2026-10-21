"use client";

import Link from "next/link";
import { Fragment, useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useDialogs } from "@/components/DialogProvider";
import {
  RiChatSmile3Line,
  RiCheckDoubleLine,
  RiExternalLinkLine,
  RiLayoutRightLine,
  RiLoader4Line,
  RiMessage3Line,
  RiSearchLine,
  RiUserSearchLine,
} from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Select from "@/components/alignui/select";
import { EmptyState } from "@/components/page/EmptyState";
import { PageHeader } from "@/components/page/PageHeader";
import { CallButton } from "@/components/calls/CallButton";
import { LinkedInAccountTag } from "@/components/linkedin/LinkedInAccountTag";
import {
  CrmCategoryControl,
  CrmDraftCard,
  DoNotContactNotice,
  crmCategoryLabel,
  type CrmCategoryOption,
} from "@/components/crm/InboxCrmStrip";
import { crmFetch, errorMessage } from "@/components/crm/crm-utils";
import {
  ActiveFilterChips,
  CategoryChip,
  ChannelTag,
  ConversationRow,
  DayHeading,
  DraftChip,
  FilterField,
  FilterPopover,
  HeaderAction,
  InboxAvatar,
  InboxLayout,
  ListCount,
  ListPane,
  ListSearch,
  ReadingEmpty,
  ReadingPane,
  RowBadge,
  RowMeta,
  RowsSkeleton,
  ThreadHeader,
  ThreadSkeleton,
  TriageTabs,
  dayKeyOf,
  fullTime,
  rowTime,
  withRecencyBreaks,
  type BadgeTone,
  type TriageTab,
} from "@/components/inbox/shell/InboxShell";
import { Bubble, ChatComposer, ComposerDock, ComposerDraftBanner, DaySeparator, ExpandableText, MessageCaption } from "@/components/inbox/shell/Conversation";
import { ContactDetails, DetailsPanel, toLinkedinHref, useCrmRecordSummary, useDetailsPanel, workflowLabel } from "@/components/inbox/shell/DetailsPanel";
import { useInboxHotkeys } from "@/components/inbox/shell/hotkeys";
import { cn } from "@/utils/cn";
import type { ConnectionItem } from "@/lib/linkedin/messages/connectionList";
import {
  ALL_LEADS_FILTER,
  CONNECTIONS_ONLY_FILTER,
  DEFAULT_MESSAGES_STATUS_FILTER,
  UNREPLIED_FILTER,
} from "@/lib/linkedin/messages/connectionList";
import type { InboxCrmContext } from "@/lib/linkedin/messages/crmContext";
import { inboxCrmStepLabel } from "@/lib/linkedin/messages/crmContext";

export type { ConnectionItem };

type ThreadMessage = {
  id: string;
  type: string;
  text: string;
  seen: boolean;
  createdAt: string;
};

type FilterAccount = { id: string; username: string; name: string | null; profilePictureUrl: string | null };
type FilterCampaign = { id: string; name: string };

const SENT_TYPES = new Set(["INVITATION", "ACCEPTANCE", "FOLLOW_UP_1", "FOLLOW_UP_2", "FOLLOW_UP_3", "CUSTOM_SENT"]);

const TYPE_LABEL: Record<string, string> = {
  INVITATION: "Invitation",
  ACCEPTANCE: "Acceptance",
  FOLLOW_UP_1: "Follow-up 1",
  FOLLOW_UP_2: "Follow-up 2",
  FOLLOW_UP_3: "Follow-up 3",
  CUSTOM_SENT: "Sent",
  RECEIVED: "Received",
};

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending",
  REQUEST_SENT: "Invited",
  ACCEPT_MESSAGE_SENT: "Accepted",
  FOLLOW_UP_1_SENT: "Follow-up 1",
  FOLLOW_UP_2_SENT: "Follow-up 2",
  FOLLOW_UP_3_SENT: "Follow-up 3",
  COMPLETED: "Completed",
  REPLIED: "Replied",
  FAILED: "Failed",
};

/** Lead status → badge tone. Only outcomes wear a colour; the steps in between stay grey. */
const STATUS_TONE: Record<string, BadgeTone> = {
  REPLIED: "green",
  FAILED: "red",
  REQUEST_SENT: "orange",
};

const humanize = (value: string) => {
  const input = value.replaceAll("_", " ").trim();
  return input ? input.charAt(0).toUpperCase() + input.slice(1) : "—";
};

/** Status scopes under which the list is CRM-tracked, so a category filter makes sense. */
const CRM_FILTERABLE_STATUSES = new Set<string>([DEFAULT_MESSAGES_STATUS_FILTER, UNREPLIED_FILTER]);

const CATEGORY_FILTER_PREFIX = "category:";

/** `category:<key>` or a bare subcategory id → the two query params. */
const splitCategoryFilter = (value: string, categories: CrmCategoryOption[]) => {
  if (!value) return { categoryKey: "", subcategoryId: "" };
  if (value.startsWith(CATEGORY_FILTER_PREFIX)) return { categoryKey: value.slice(CATEGORY_FILTER_PREFIX.length), subcategoryId: "" };
  const sub = categories.flatMap((c) => c.subcategories).find((sc) => sc.id === value);
  return { categoryKey: sub?.categoryKey ?? "", subcategoryId: value };
};

const ALL_STATUSES = ["PENDING", "REQUEST_SENT", "ACCEPT_MESSAGE_SENT", "FOLLOW_UP_1_SENT", "FOLLOW_UP_2_SENT", "FOLLOW_UP_3_SENT", "COMPLETED", "REPLIED", "FAILED"];

const TIME_PERIODS = [
  { label: "All time", days: null },
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
];

/** Scopes first, then the lead statuses, as two groups in the scope select. */
const MESSAGE_SCOPE_OPTIONS = [
  { value: ALL_LEADS_FILTER, label: "All conversations" },
  { value: UNREPLIED_FILTER, label: "Needs reply", hint: "Latest message is from the prospect" },
  { value: CONNECTIONS_ONLY_FILTER, label: "Connections only" },
];
const MESSAGE_STATUS_OPTIONS = ALL_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }));

const filtersKeyFrom = (filters: {
  search: string;
  campaignId: string;
  accountId: string;
  status: string;
  periodDays: number | null;
  categoryKey: string;
  subcategoryId: string;
}) =>
  JSON.stringify({
    search: filters.search,
    campaignId: filters.campaignId,
    accountId: filters.accountId,
    status: filters.status,
    periodDays: filters.periodDays,
    categoryKey: filters.categoryKey,
    subcategoryId: filters.subcategoryId,
  });

const DEFAULT_FILTERS_KEY = filtersKeyFrom({
  search: "",
  campaignId: "",
  accountId: "",
  status: DEFAULT_MESSAGES_STATUS_FILTER,
  periodDays: null,
  categoryKey: "",
  subcategoryId: "",
});

type InitialList = {
  connections: ConnectionItem[];
  totalCount: number;
  hasMore: boolean;
};

/** The clock time of a message, for its caption. */
function clockTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Row-level status: the CRM category when the thread is CRM-tracked, else the lead status. */
function RowStatus({ conn }: { conn: ConnectionItem }) {
  if (conn.crm) return <CategoryChip categoryKey={conn.crm.categoryKey} label={crmCategoryLabel(conn.crm)} />;
  if (!conn.leadStatus) return null;
  return <RowBadge tone={STATUS_TONE[conn.leadStatus] ?? "gray"}>{STATUS_LABEL[conn.leadStatus] ?? conn.leadStatus}</RowBadge>;
}

export function MessagesLayout({
  campaigns,
  accounts,
  initialList,
}: {
  campaigns: FilterCampaign[];
  accounts: FilterAccount[];
  initialList: InitialList;
}) {
  const dialogs = useDialogs();
  const [connections, setConnections] = useState(initialList.connections);
  const [totalCount, setTotalCount] = useState(initialList.totalCount);
  const [hasMore, setHasMore] = useState(initialList.hasMore);
  const [listPage, setListPage] = useState(1);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const lastLoadedFiltersKeyRef = useRef(DEFAULT_FILTERS_KEY);
  const [selected, setSelected] = useState<ConnectionItem | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [crmContext, setCrmContext] = useState<InboxCrmContext | null>(null);
  /** The CRM draft the operator chose to send as; resolved against the live context below. */
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  /** While set, the CRM context is polled for the regenerated draft until this time (ms). */
  const [draftWatchUntil, setDraftWatchUntil] = useState<number | null>(null);
  /** Draft that reclassification superseded — seeing it again does not end the watch. */
  const supersededDraftIdRef = useRef<string | null>(null);
  const [crmCategories, setCrmCategories] = useState<CrmCategoryOption[]>([]);
  const threadScrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const threadAbortRef = useRef<AbortController | null>(null);
  const activeThreadIdRef = useRef<string | null>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const listSentinelRef = useRef<HTMLDivElement>(null);

  // Filters
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [campaignFilter, setCampaignFilter] = useState("");
  const [accountFilter, setAccountFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>(DEFAULT_MESSAGES_STATUS_FILTER);
  const [periodFilter, setPeriodFilter] = useState("");
  /** `category:<key>` or a subcategory id; only meaningful under a CRM-tracked status scope. */
  const [categoryFilter, setCategoryFilter] = useState("");

  const periodDays = periodFilter
    ? (TIME_PERIODS.find((p) => p.label === periodFilter)?.days ?? null)
    : null;

  const showCategoryFilter = CRM_FILTERABLE_STATUSES.has(statusFilter);
  const { categoryKey: categoryKeyFilter, subcategoryId: subcategoryIdFilter } = splitCategoryFilter(
    showCategoryFilter ? categoryFilter : "",
    crmCategories
  );

  useEffect(() => {
    let cancelled = false;
    crmFetch<{ categories?: CrmCategoryOption[] }>("/categories")
      .then((data) => {
        if (!cancelled) setCrmCategories(Array.isArray(data?.categories) ? data.categories : []);
      })
      .catch(() => {
        /* no CRM taxonomy: the filter and picker stay empty */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const buildConnectionsQuery = useCallback(
    (page: number) => {
      const q = new URLSearchParams({ page: String(page) });
      if (debouncedSearch) q.set("search", debouncedSearch);
      if (campaignFilter) q.set("campaignId", campaignFilter);
      if (accountFilter) q.set("accountId", accountFilter);
      q.set("status", statusFilter);
      if (periodDays) q.set("periodDays", String(periodDays));
      if (categoryKeyFilter) q.set("categoryKey", categoryKeyFilter);
      if (subcategoryIdFilter) q.set("subcategoryId", subcategoryIdFilter);
      return q;
    },
    [debouncedSearch, campaignFilter, accountFilter, statusFilter, periodDays, categoryKeyFilter, subcategoryIdFilter]
  );

  const fetchConnectionsPage = useCallback(
    async (page: number) => {
      const res = await fetch(`/api/linkedin/messages/connections?${buildConnectionsQuery(page)}`);
      const data = await res.json();
      if (!data.ok) return null;
      return data as {
        connections: ConnectionItem[];
        totalCount: number;
        hasMore: boolean;
        page: number;
      };
    },
    [buildConnectionsQuery]
  );

  useEffect(() => {
    const filtersKey = filtersKeyFrom({
      search: debouncedSearch,
      campaignId: campaignFilter,
      accountId: accountFilter,
      status: statusFilter,
      periodDays: periodDays ?? null,
      categoryKey: categoryKeyFilter,
      subcategoryId: subcategoryIdFilter,
    });

    if (filtersKey === lastLoadedFiltersKeyRef.current) return;

    let cancelled = false;
    setLoadingList(true);
    setListPage(1);

    (async () => {
      const data = await fetchConnectionsPage(1);
      if (cancelled || !data) {
        if (!cancelled) setLoadingList(false);
        return;
      }
      setConnections(data.connections);
      setTotalCount(data.totalCount);
      setHasMore(data.hasMore);
      setListPage(data.page);
      lastLoadedFiltersKeyRef.current = filtersKey;
      setLoadingList(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [fetchConnectionsPage, debouncedSearch, campaignFilter, accountFilter, statusFilter, periodDays, categoryKeyFilter, subcategoryIdFilter]);

  const loadMoreConnections = useCallback(async () => {
    if (loadingMore || loadingList || !hasMore) return;
    setLoadingMore(true);
    try {
      const nextPage = listPage + 1;
      const data = await fetchConnectionsPage(nextPage);
      if (!data) return;
      setConnections((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        const added = data.connections.filter((c) => !seen.has(c.id));
        return [...prev, ...added];
      });
      setTotalCount(data.totalCount);
      setHasMore(data.hasMore);
      setListPage(data.page);
    } finally {
      setLoadingMore(false);
    }
  }, [fetchConnectionsPage, hasMore, listPage, loadingList, loadingMore]);

  useEffect(() => {
    const root = listScrollRef.current;
    const target = listSentinelRef.current;
    if (!root || !target || !hasMore || loadingList || loadingMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMoreConnections();
      },
      { root, rootMargin: "80px", threshold: 0 }
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loadMoreConnections, connections.length, loadingList, loadingMore]);

  // Only the thread's own scroller moves; the page never does.
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const scroller = threadScrollRef.current;
    scroller?.scrollTo({ top: scroller.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    if (messages.length > 0) scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => () => threadAbortRef.current?.abort(), []);

  /**
   * CRM state for the open thread. Anything but `{ context }` (route missing,
   * 404, 500, non-CRM thread) reads as "no strip"; a stale response for a
   * thread that is no longer open is dropped.
   */
  const loadCrmContext = useCallback(async (connId: string) => {
    try {
      const res = await fetch(`/api/linkedin/messages/crm-context?connectionId=${connId}`);
      const data = res.ok ? await res.json() : null;
      if (activeThreadIdRef.current !== connId) return;
      const context = (data?.context as InboxCrmContext | undefined) ?? null;
      setCrmContext(context);
      // A new draft that is no longer generating ends the post-classification watch.
      const draft = context?.draft;
      if (draft && draft.status !== "generating" && draft.id !== supersededDraftIdRef.current) setDraftWatchUntil(null);
    } catch {
      /* network error: keep whatever the strip already shows */
    }
  }, []);

  /**
   * "Use draft" only holds while the server still offers that draft for
   * review; a regenerated, discarded or already-sent draft drops the reply
   * back to a plain LinkedIn send. A revision bump is followed automatically.
   */
  const activeDraft = useMemo(() => {
    const draft = crmContext?.draft;
    if (!activeDraftId || !draft || draft.id !== activeDraftId || draft.status !== "awaiting_review") return null;
    return { id: draft.id, revision: draft.revision };
  }, [activeDraftId, crmContext?.draft]);

  const reloadThread = useCallback(async (connId: string) => {
    const res = await fetch(`/api/linkedin/messages/thread?connectionId=${connId}`);
    const data = await res.json();
    if (activeThreadIdRef.current !== connId) return;
    const next: ThreadMessage[] = data.messages ?? [];
    setMessages((prev) => {
      if (
        prev.length === next.length &&
        prev[prev.length - 1]?.id === next[next.length - 1]?.id
      ) {
        return prev;
      }
      return next;
    });
    setConnections((prev) =>
      prev.map((c) => (c.id === connId ? { ...c, unseenCount: 0 } : c))
    );
  }, []);

  // Refresh open thread so inbound webhook messages appear without re-opening.
  useEffect(() => {
    const connId = selected?.id;
    if (!connId) return;

    const refreshThread = async () => {
      if (activeThreadIdRef.current !== connId || sending) return;
      try {
        await Promise.all([reloadThread(connId), loadCrmContext(connId)]);
      } catch {
        /* ignore poll errors */
      }
    };

    const interval = setInterval(refreshThread, 10_000);
    return () => clearInterval(interval);
  }, [selected?.id, sending, reloadThread, loadCrmContext]);

  // After a reclassification the CRM regenerates the draft asynchronously:
  // poll every 3s until loadCrmContext sees a finished draft, for at most ~45s.
  useEffect(() => {
    const connId = selected?.id;
    if (!draftWatchUntil || !connId) return;
    const interval = setInterval(() => {
      if (Date.now() > draftWatchUntil) setDraftWatchUntil(null);
      else void loadCrmContext(connId);
    }, 3_000);
    return () => clearInterval(interval);
  }, [draftWatchUntil, selected?.id, loadCrmContext]);

  const openThread = async (conn: ConnectionItem) => {
    threadAbortRef.current?.abort();
    const controller = new AbortController();
    threadAbortRef.current = controller;
    // A CRM draft belongs to the thread it was drafted for: never carry it over.
    if (activeDraftId && activeThreadIdRef.current !== conn.id) setText("");
    activeThreadIdRef.current = conn.id;

    setSelected(conn);
    setMessages([]);
    setCrmContext(null);
    setActiveDraftId(null);
    setDraftWatchUntil(null);
    supersededDraftIdRef.current = null;
    setLoadingThread(true);
    void loadCrmContext(conn.id);
    try {
      const res = await fetch(`/api/linkedin/messages/thread?connectionId=${conn.id}`, {
        signal: controller.signal,
      });
      if (activeThreadIdRef.current !== conn.id) return;
      const data = await res.json();
      if (activeThreadIdRef.current !== conn.id) return;
      setMessages(data.messages ?? []);
      setConnections((prev) => prev.map((c) => (c.id === conn.id ? { ...c, unseenCount: 0 } : c)));
      window.dispatchEvent(new CustomEvent("messages-unread-changed"));
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      throw err;
    } finally {
      if (!controller.signal.aborted && activeThreadIdRef.current === conn.id) {
        setLoadingThread(false);
        setTimeout(() => scrollToBottom("instant"), 50);
      }
    }
  };

  const sendViaCrmDraft = async (draft: { id: string; revision: number }, body: string) => {
    if (!selected) return;
    const connId = selected.id;
    try {
      await crmFetch(`/drafts/${draft.id}/send`, {
        method: "POST",
        body: JSON.stringify({ revision: draft.revision, body }),
      });
      setActiveDraftId(null);
      // The CRM mirrors the sent message into the LinkedIn thread.
      await Promise.all([reloadThread(connId).catch(() => undefined), loadCrmContext(connId)]);
      setConnections((prev) =>
        prev.map((c) =>
          c.id === connId ? { ...c, lastMessage: { text: body, type: "CUSTOM_SENT", createdAt: new Date().toISOString() } } : c
        )
      );
    } catch (err) {
      // 409 (stale revision / step no longer pending) and anything else: keep
      // the text, show the API's message, and resync the strip.
      setText(body);
      void dialogs.alert({ title: "Could not send draft", description: errorMessage(err), variant: "error" });
      void loadCrmContext(connId);
    }
  };

  const handleSend = async () => {
    if (!selected || !text.trim() || sending || crmContext?.doNotContact) return;
    const body = text.trim();
    setText("");
    setSending(true);
    if (activeDraft) {
      try {
        await sendViaCrmDraft(activeDraft, body);
      } finally {
        setSending(false);
        textareaRef.current?.focus();
      }
      return;
    }
    try {
      const res = await fetch("/api/linkedin/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ connectionId: selected.id, text: body }),
      });
      const data = await res.json();
      if (data.message) {
        setMessages((prev) => [...prev, data.message]);
        setConnections((prev) =>
          prev.map((c) =>
            c.id === selected.id
              ? { ...c, lastMessage: { text: body, type: "CUSTOM_SENT", createdAt: data.message.createdAt } }
              : c
          )
        );
      } else {
        setText(body);
        void dialogs.alert({ title: "Could not send message", description: data.error, variant: "error" });
      }
    } catch {
      setText(body);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const renderMessages = () => {
    if (messages.length === 0) {
      return <EmptyState icon={RiMessage3Line} title="No messages yet" description="Messages sent and received with this connection appear here." />;
    }
    const theirName = (selected?.name ?? "").trim().split(/\s+/)[0] || "Them";
    const lastId = messages[messages.length - 1]?.id;

    return messages.map((msg, i) => {
      const isSent = SENT_TYPES.has(msg.type);
      const prev = messages[i - 1];
      const next = messages[i + 1];
      const date = new Date(msg.createdAt);
      const sameRun = (other: ThreadMessage | undefined) =>
        Boolean(other) &&
        dayKeyOf(new Date(other!.createdAt)) === dayKeyOf(date) &&
        SENT_TYPES.has(other!.type) === isSent &&
        (!isSent || other!.type === msg.type);
      const newDay = !prev || dayKeyOf(new Date(prev.createdAt)) !== dayKeyOf(date);
      const isFirst = !sameRun(prev);
      const isLast = !sameRun(next);
      const stepLabel = isSent && msg.type !== "CUSTOM_SENT" ? TYPE_LABEL[msg.type] ?? null : null;

      return (
        <Fragment key={msg.id}>
          {newDay && <DaySeparator date={date} />}
          <div className={cn("flex flex-col", isSent ? "items-end" : "items-start", isFirst ? "mt-4 first:mt-0" : "mt-1")}>
            {isFirst && (
              <MessageCaption
                outbound={isSent}
                who={isSent ? "You" : theirName}
                detail={stepLabel}
                time={clockTime(date)}
                timeTitle={fullTime(date)}
              />
            )}
            <Bubble outbound={isSent} first={isFirst} last={isLast} title={fullTime(date)}>
              <ExpandableText text={msg.text} collapsed={msg.id !== lastId} />
            </Bubble>
          </div>
        </Fragment>
      );
    });
  };

  const displayName = (conn: ConnectionItem) => conn.name ?? conn.linkedinUrl ?? "Unknown";

  const clearFilters = () => {
    setSearch("");
    setCampaignFilter("");
    setAccountFilter("");
    setStatusFilter(DEFAULT_MESSAGES_STATUS_FILTER);
    setPeriodFilter("");
    setCategoryFilter("");
  };
  // The category filter only applies to CRM-tracked scopes; leaving one
  // clears it in the same render so the list does not fetch twice.
  const changeStatusFilter = (value: string) => {
    setStatusFilter(value);
    if (!CRM_FILTERABLE_STATUSES.has(value)) setCategoryFilter("");
  };

  const categoryLabel = useMemo(() => {
    if (!categoryFilter) return "";
    if (categoryFilter.startsWith(CATEGORY_FILTER_PREFIX)) {
      const key = categoryFilter.slice(CATEGORY_FILTER_PREFIX.length);
      const category = crmCategories.find((c) => c.key === key);
      return `All ${category?.label ?? humanize(key)}`;
    }
    return crmCategories.flatMap((c) => c.subcategories).find((sc) => sc.id === categoryFilter)?.name ?? "Category";
  }, [categoryFilter, crmCategories]);

  // The popover's filters; search and the scope tabs live in the toolbar itself.
  const popoverFilterCount = [campaignFilter, accountFilter, periodFilter, showCategoryFilter ? categoryFilter : ""].filter(Boolean).length;
  const clearPopoverFilters = () => {
    setCampaignFilter("");
    setAccountFilter("");
    setPeriodFilter("");
    setCategoryFilter("");
  };
  const accountName = (id: string) => {
    const account = accounts.find((a) => a.id === id);
    return account ? account.name ?? `@${account.username}` : "Sender";
  };
  const chips = [
    campaignFilter && { key: "campaign", label: campaigns.find((c) => c.id === campaignFilter)?.name ?? "Campaign", onRemove: () => setCampaignFilter("") },
    accountFilter && { key: "account", label: `From ${accountName(accountFilter)}`, onRemove: () => setAccountFilter("") },
    periodFilter && { key: "period", label: periodFilter, onRemove: () => setPeriodFilter("") },
    showCategoryFilter && categoryFilter && { key: "category", label: categoryLabel, onRemove: () => setCategoryFilter("") },
  ].filter((chip): chip is { key: string; label: string; onRemove: () => void } => Boolean(chip));

  const closeThread = useCallback(() => {
    activeThreadIdRef.current = null;
    setSelected(null);
    setCrmContext(null);
    setActiveDraftId(null);
    setDraftWatchUntil(null);
  }, []);

  const scopeLabel =
    MESSAGE_SCOPE_OPTIONS.find((o) => o.value === statusFilter)?.label ?? STATUS_LABEL[statusFilter] ?? "Conversations";

  useInboxHotkeys({ listRef: listScrollRef, onClose: selected ? closeThread : null });
  const details = useDetailsPanel(selected?.id ?? null);
  const recordId = crmContext?.recordId ?? selected?.crm?.recordId ?? null;
  const { summary: record, loading: recordLoading } = useCrmRecordSummary(recordId, details.open);
  const crmSummary = crmContext ?? selected?.crm ?? null;

  // The scopes as tabs; only the open scope's total is known.
  const scopeTab = (value: string, label: string, title?: string): TriageTab => ({
    key: value,
    label,
    title,
    count: value === statusFilter && !loadingList ? totalCount : null,
    countTitle: value === statusFilter ? `${totalCount.toLocaleString("en-US")} conversations` : undefined,
  });
  const triage = (
    <TriageTabs
      label="Show conversations"
      value={statusFilter}
      onChange={changeStatusFilter}
      tabs={[
        scopeTab(DEFAULT_MESSAGES_STATUS_FILTER, "Replied", "Leads who replied"),
        scopeTab(UNREPLIED_FILTER, "Needs reply", "Latest message is from the prospect"),
        scopeTab(ALL_LEADS_FILTER, "All", "Every campaign lead"),
      ]}
      moreGroups={[
        { label: "Show", tabs: [scopeTab(CONNECTIONS_ONLY_FILTER, "Connections only", "Connections with no campaign lead")] },
        {
          label: "Lead status",
          tabs: MESSAGE_STATUS_OPTIONS.filter((o) => o.value !== DEFAULT_MESSAGES_STATUS_FILTER).map((o) => scopeTab(o.value, o.label)),
        },
      ]}
    />
  );

  const selectedName = selected ? displayName(selected) : "";
  const senderLabel = selected?.linkedInAccountName ?? (selected?.linkedInAccountUsername ? `@${selected.linkedInAccountUsername}` : null);

  const detailsPanel = selected ? (
    <DetailsPanel open={details.open} wide={details.wide} onClose={() => details.setOpen(false)}>
      <ContactDetails
        name={selectedName}
        avatarSrc={selected.profilePictureUrl ?? record?.profilePictureUrl}
        headline={selected.headline ?? record?.title}
        company={record?.company}
        channel="linkedin"
        links={{ recordId, linkedinUrl: selected.linkedinUrl ?? record?.linkedinUrl, email: record?.email, phone: record?.phone }}
        crm={
          crmSummary
            ? {
                recordId,
                categoryKey: crmSummary.categoryKey,
                categoryLabel: crmCategoryLabel(crmSummary),
                stage: workflowLabel(crmSummary.workflowState),
                sequence: crmSummary.sequenceName,
                step: inboxCrmStepLabel(crmSummary),
                nextActionAt: crmSummary.nextActionAt,
                lastInboundAt: record?.lastInboundAt,
                lastOutboundAt: record?.lastOutboundAt,
                doNotContact: crmContext?.doNotContact ?? record?.doNotContact,
              }
            : null
        }
        crmLoading={Boolean(recordId) && recordLoading && !crmSummary}
        facts={[
          ...(selected.campaignName ? [{ label: "Campaign", value: selected.campaignName, title: selected.campaignName }] : []),
          ...(selected.linkedInAccountUsername
            ? [
                {
                  label: "Sent from",
                  value: (
                    <LinkedInAccountTag
                      account={{ username: selected.linkedInAccountUsername, name: selected.linkedInAccountName, profilePictureUrl: selected.linkedInAccountPicture }}
                      size="sm"
                    />
                  ),
                },
              ]
            : []),
          ...(selected.leadStatus ? [{ label: "Lead status", value: STATUS_LABEL[selected.leadStatus] ?? selected.leadStatus }] : []),
          ...(selected.connectedAt ? [{ label: "Connected", value: new Date(selected.connectedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) }] : []),
        ]}
        actions={record?.personId && record.phone ? <CallButton personId={record.personId} crmRecordId={recordId} phone={record.phone} numberMenu={false} /> : undefined}
      />
    </DetailsPanel>
  ) : undefined;

  return (
    <InboxLayout
      threadOpen={selected !== null}
      header={
        <PageHeader
          title="Messages"
          description="LinkedIn conversations from your campaigns, and who is waiting on a reply."
        />
      }
    >
      <ListPane
        label="LinkedIn conversations"
        hidden={selected !== null}
        busy={loadingList && connections.length > 0}
        scrollRef={listScrollRef}
        toolbar={
          <>
            <div className="flex items-center gap-2">
              <ListSearch value={search} onChange={setSearch} placeholder="Search by name" label="Search conversations by name" />
              <FilterPopover count={popoverFilterCount} onClear={clearPopoverFilters}>
                <FilterField label="Campaign">
                  <Select.Root size="small" value={campaignFilter} onValueChange={setCampaignFilter}>
                    <Select.Trigger aria-label="Campaign filter">
                      <Select.Value placeholder="All campaigns" />
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="">All campaigns</Select.Item>
                      {campaigns.map((c) => (
                        <Select.Item key={c.id} value={c.id}>
                          {c.name}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                </FilterField>
                <FilterField label="Sender">
                  <Select.Root size="small" value={accountFilter} onValueChange={setAccountFilter}>
                    <Select.Trigger aria-label="Sender account filter">
                      <Select.Value placeholder="All senders" />
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="">All senders</Select.Item>
                      {accounts.map((a) => (
                        <Select.Item key={a.id} value={a.id}>
                          <span className="flex min-w-0 items-center gap-2">
                            <InboxAvatar name={a.name ?? a.username} src={a.profilePictureUrl} size="xs" className="size-5 text-[11px]" />
                            <span className="truncate">{a.name ?? `@${a.username}`}</span>
                            {a.name && <span className="truncate text-text-soft-400">@{a.username}</span>}
                          </span>
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                </FilterField>
                <FilterField label="Last activity">
                  <Select.Root size="small" value={periodFilter} onValueChange={setPeriodFilter}>
                    <Select.Trigger aria-label="Time period filter">
                      <Select.Value placeholder="All time" />
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="">All time</Select.Item>
                      {TIME_PERIODS.slice(1).map((p) => (
                        <Select.Item key={p.label} value={p.label}>
                          {p.label}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                </FilterField>
                <FilterField label="CRM category" hint={showCategoryFilter ? undefined : "Applies when the list shows Replied or Needs reply."}>
                  <Select.Root size="small" value={showCategoryFilter ? categoryFilter : ""} onValueChange={setCategoryFilter} disabled={!showCategoryFilter || crmCategories.length === 0}>
                    <Select.Trigger aria-label="CRM category filter">
                      <Select.Value placeholder="All categories" />
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="">All categories</Select.Item>
                      {crmCategories.map((category) => {
                        const label = category.label ?? humanize(category.key);
                        return (
                          <Select.Group key={category.key}>
                            <Select.Separator />
                            <Select.GroupLabel>{label}</Select.GroupLabel>
                            <Select.Item value={`${CATEGORY_FILTER_PREFIX}${category.key}`}>All {label}</Select.Item>
                            {category.subcategories
                              .filter((sc) => sc.active !== false)
                              .map((sc) => (
                                <Select.Item key={sc.id} value={sc.id}>
                                  {sc.name}
                                </Select.Item>
                              ))}
                          </Select.Group>
                        );
                      })}
                    </Select.Content>
                  </Select.Root>
                </FilterField>
              </FilterPopover>
            </div>
            <ActiveFilterChips chips={chips} onClearAll={clearPopoverFilters} />
          </>
        }
        tabs={triage}
        footer={<ListCount shown={connections.length} total={totalCount} noun={totalCount === 1 ? "conversation" : "conversations"} loading={loadingList} />}
      >
        {loadingList && connections.length === 0 ? (
          <RowsSkeleton />
        ) : connections.length === 0 ? (
          search || popoverFilterCount > 0 ? (
            <EmptyState
              compact
              icon={RiSearchLine}
              title="No conversations match"
              description={`Nothing in “${scopeLabel}” matches this search and these filters.`}
              action={
                <Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={clearFilters}>
                  Clear filters
                </Button.Root>
              }
            />
          ) : statusFilter === UNREPLIED_FILTER ? (
            <EmptyState compact icon={RiCheckDoubleLine} title="You're all caught up" description="Nobody is waiting on a reply right now." />
          ) : (
            <EmptyState
              compact
              icon={RiChatSmile3Line}
              title={statusFilter === DEFAULT_MESSAGES_STATUS_FILTER ? "No replies yet" : `Nothing in “${scopeLabel}”`}
              description={
                statusFilter === DEFAULT_MESSAGES_STATUS_FILTER
                  ? "Prospects who reply show up here. Switch to All to see everyone."
                  : "Connections appear here after leads accept your invitations."
              }
            />
          )
        ) : (
          withRecencyBreaks(connections, (conn) => (conn.lastMessage ? new Date(conn.lastMessage.createdAt) : null)).map(({ row: conn, heading }) => {
            const name = displayName(conn);
            const hasUnseen = conn.unseenCount > 0;
            const last = conn.lastMessage ? new Date(conn.lastMessage.createdAt) : null;
            const drafted = conn.crm?.hasDraft === true;
            const step = conn.crm ? inboxCrmStepLabel(conn.crm) : null;
            return (
              <Fragment key={conn.id}>
                {heading && <DayHeading>{heading}</DayHeading>}
                <ConversationRow
                  selected={selected?.id === conn.id}
                  unread={hasUnseen}
                  unreadCount={conn.unseenCount}
                  onSelect={() => openThread(conn)}
                  avatar={<InboxAvatar name={name} src={conn.profilePictureUrl} />}
                  title={name}
                  time={rowTime(last)}
                  timeTitle={fullTime(last)}
                  snippet={
                    conn.lastMessage ? (
                      <>
                        {SENT_TYPES.has(conn.lastMessage.type) && <span className="text-text-soft-400">You: </span>}
                        {conn.lastMessage.text}
                      </>
                    ) : (
                      <span className="italic text-text-soft-400">No messages yet</span>
                    )
                  }
                  hint={conn.headline ?? undefined}
                  meta={
                    <>
                      {drafted && <DraftChip />}
                      <RowStatus conn={conn} />
                      {!drafted && step && step !== "No next step" && <RowMeta keep>{step}</RowMeta>}
                    </>
                  }
                />
              </Fragment>
            );
          })
        )}
        {!loadingList && connections.length > 0 && (
          <div ref={listSentinelRef} className="flex min-h-8 justify-center py-3">
            {loadingMore && <RiLoader4Line className="size-5 animate-spin text-text-soft-400" aria-label="Loading more" />}
          </div>
        )}
      </ListPane>

      <ReadingPane shown={selected !== null} aside={detailsPanel}>
        {!selected ? (
          <ReadingEmpty icon={RiMessage3Line} description="Pick a conversation from the list to read it and reply." />
        ) : (
          <>
            <ThreadHeader
              onBack={closeThread}
              avatar={<InboxAvatar name={selectedName} src={selected.profilePictureUrl} />}
              title={selectedName}
              badges={
                crmContext ? (
                  <CrmCategoryControl
                    context={crmContext}
                    categories={crmCategories}
                    disabled={sending}
                    onClassified={() => {
                      supersededDraftIdRef.current = crmContext.draft?.id ?? null;
                      setActiveDraftId(null);
                      setDraftWatchUntil(Date.now() + 45_000);
                      void loadCrmContext(selected.id);
                    }}
                  />
                ) : (
                  <RowStatus conn={selected} />
                )
              }
              channel="linkedin"
              subtitle={selected.headline ?? undefined}
              actions={
                <>
                  {recordId && (
                    <Button.Root variant="neutral" mode="stroke" size="xsmall" asChild className="@max-3xl:w-8 @max-3xl:px-0" title="Open CRM record">
                      <Link href={`/crm/records/${recordId}`} aria-label="Open CRM record">
                        <Button.Icon as={RiUserSearchLine} />
                        <span className="hidden @3xl:inline">Record</span>
                      </Link>
                    </Button.Root>
                  )}
                  {selected.linkedinUrl && (
                    <HeaderAction icon={RiExternalLinkLine} label="LinkedIn profile" href={toLinkedinHref(selected.linkedinUrl)} external iconOnly />
                  )}
                  <HeaderAction icon={RiLayoutRightLine} label={details.open ? "Hide details" : "Show details"} onClick={details.toggle} pressed={details.open} iconOnly />
                </>
              }
            />

            {loadingThread ? (
              <ThreadSkeleton />
            ) : (
              <div ref={threadScrollRef} className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto flex w-full max-w-3xl flex-col px-4 py-5 sm:px-6">{renderMessages()}</div>
              </div>
            )}

            <ComposerDock>
              {crmContext?.doNotContact ? (
                <DoNotContactNotice />
              ) : !selected.chatId ? (
                <p className="py-1 text-center text-paragraph-xs text-text-soft-400">
                  No chat with this connection yet — you can reply once they send a message.
                </p>
              ) : (
                <>
                  {crmContext?.draft && (
                    <CrmDraftCard
                      draft={crmContext.draft}
                      active={activeDraft?.id === crmContext.draft.id}
                      disabled={sending}
                      onUse={() => {
                        const draft = crmContext.draft!;
                        setText(draft.body);
                        setActiveDraftId(draft.id);
                        textareaRef.current?.focus();
                      }}
                    />
                  )}
                  <ChatComposer
                    value={text}
                    onChange={(value) => {
                      setText(value);
                      if (!value.trim()) setActiveDraftId(null);
                    }}
                    onSubmit={() => void handleSend()}
                    sending={sending}
                    textareaRef={textareaRef}
                    tone={activeDraft ? "draft" : "default"}
                    banner={
                      activeDraft ? (
                        <ComposerDraftBanner
                          onClear={() => {
                            setActiveDraftId(null);
                            setText("");
                          }}
                        />
                      ) : undefined
                    }
                    submitLabel={activeDraft ? "Approve & send" : "Send"}
                    placeholder={`Message ${selectedName.split(" ")[0] || "them"}…`}
                    meta={<ChannelTag channel="linkedin" label={senderLabel ? `as ${senderLabel}` : "LinkedIn"} />}
                  />
                </>
              )}
            </ComposerDock>
          </>
        )}
      </ReadingPane>
    </InboxLayout>
  );
}
