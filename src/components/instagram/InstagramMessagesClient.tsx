"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  RiAttachment2,
  RiChat3Line,
  RiHistoryLine,
  RiLoader4Line,
  RiSettings3Line,
  RiTodoLine,
  RiUserSearchLine,
} from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Select from "@/components/alignui/select";
import { EmptyState } from "@/components/page/EmptyState";
import { PageHeader } from "@/components/page/PageHeader";
import { ComposerDock } from "@/components/inbox/shell/Conversation";
import {
  ConversationRow,
  DayHeading,
  FilterField,
  FilterPopover,
  InboxAvatar,
  InboxLayout,
  InlineError,
  ListCount,
  ListPane,
  ReadingEmpty,
  ReadingPane,
  RowBadge,
  RowMeta,
  RowsSkeleton,
  ThreadHeader,
  ThreadSkeleton,
  fullTime,
  rowTime,
  withRecencyBreaks,
} from "@/components/inbox/shell/InboxShell";
import { useInboxHotkeys } from "@/components/inbox/shell/hotkeys";
import { useVisiblePolling } from "@/components/whatsapp/usePolling";
import { formatMessageTime } from "@/components/whatsapp/WhatsappThread";
import { errorMessage } from "@/components/crm/crm-utils";
import { InstagramLogo, InstagramTag } from "./InstagramLogo";
import {
  getInstagramChat,
  listInstagramAccounts,
  listInstagramChats,
  markInstagramChatRead,
} from "@/lib/instagram/client";
import type { InstagramAccountSummary, InstagramChatSummary, InstagramMessage } from "@/lib/instagram/contract";
import { cn } from "@/utils/cn";
import { BRAND } from "@/lib/brand";

/** How often the chat list and the open thread refresh while the tab is visible. */
const POLL_INTERVAL_MS = 15_000;

function chatTitle(chat: InstagramChatSummary): string {
  return chat.person?.fullName || chat.name || (chat.username ? `@${chat.username}` : "Instagram user");
}

function accountLabel(account: InstagramAccountSummary): string {
  return account.name || (account.username ? `@${account.username}` : "Instagram account");
}

/**
 * The Instagram inbox: chats on the linked accounts and their messages,
 * read-only. A reply from someone in your leads reaches the CRM, where a
 * draft is written for review in Action required and sent from there —
 * nothing is sent from this page. Imported or late messages are marked
 * History: they are shown, never answered.
 */
export function InstagramMessagesClient({ initialChatId = null }: { initialChatId?: string | null } = {}) {
  const [accounts, setAccounts] = useState<InstagramAccountSummary[]>([]);
  const [accountFilter, setAccountFilter] = useState("");

  const [chats, setChats] = useState<InstagramChatSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(initialChatId);
  const [thread, setThread] = useState<{ chat: InstagramChatSummary; messages: InstagramMessage[] } | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);
  const [threadError, setThreadError] = useState("");

  useEffect(() => {
    void listInstagramAccounts().then((response) => setAccounts(response.accounts)).catch(() => undefined);
  }, []);

  // --- list ---------------------------------------------------------------
  const listRequest = useRef(0);
  const loadList = useCallback(
    async (background = false) => {
      const request = ++listRequest.current;
      if (!background) setLoadingList(true);
      try {
        const response = await listInstagramChats({ accountId: accountFilter || undefined });
        if (request !== listRequest.current) return;
        setListError("");
        setChats((current) => {
          if (!background) return response.chats;
          // A background refresh replaces page one and keeps any older pages already loaded.
          const fresh = new Set(response.chats.map((chat) => chat.id));
          const firstAge = response.chats.at(-1)?.lastMessageAt ?? "";
          const older = current.filter((chat) => !fresh.has(chat.id) && (chat.lastMessageAt ?? "") < firstAge);
          return [...response.chats, ...older];
        });
        if (!background) setNextCursor(response.nextCursor);
      } catch (cause) {
        if (request === listRequest.current && !background) setListError(errorMessage(cause));
      } finally {
        if (request === listRequest.current) setLoadingList(false);
      }
    },
    [accountFilter],
  );

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const response = await listInstagramChats({ accountId: accountFilter || undefined, cursor: nextCursor });
      setChats((current) => {
        const seen = new Set(current.map((chat) => chat.id));
        return [...current, ...response.chats.filter((chat) => !seen.has(chat.id))];
      });
      setNextCursor(response.nextCursor);
    } catch (cause) {
      setListError(errorMessage(cause));
    } finally {
      setLoadingMore(false);
    }
  };

  // --- thread -------------------------------------------------------------
  const threadRequest = useRef(0);
  const loadThread = useCallback(async (id: string, background = false) => {
    const request = ++threadRequest.current;
    if (!background) setLoadingThread(true);
    try {
      const response = await getInstagramChat(id);
      if (request !== threadRequest.current) return;
      setThread({ chat: response.chat, messages: response.messages });
      setThreadError("");
      if (response.chat.unreadCount > 0) {
        void markInstagramChatRead(id).catch(() => undefined);
        setChats((current) => current.map((chat) => (chat.id === id ? { ...chat, unreadCount: 0 } : chat)));
      }
    } catch (cause) {
      if (request === threadRequest.current && !background) setThreadError(errorMessage(cause));
    } finally {
      if (request === threadRequest.current) setLoadingThread(false);
    }
  }, []);

  useEffect(() => {
    if (initialChatId) void loadThread(initialChatId);
  }, [initialChatId, loadThread]);

  const openChat = (chat: InstagramChatSummary) => {
    if (chat.id === selectedId) return;
    setSelectedId(chat.id);
    setThread(null);
    setChats((current) => current.map((item) => (item.id === chat.id ? { ...item, unreadCount: 0 } : item)));
    void loadThread(chat.id);
  };

  useVisiblePolling(() => {
    void loadList(true);
    if (selectedId) void loadThread(selectedId, true);
  }, POLL_INTERVAL_MS);

  const selected = thread?.chat ?? chats.find((chat) => chat.id === selectedId) ?? null;
  const grouped = useMemo(() => withRecencyBreaks(chats, (chat) => (chat.lastMessageAt ? new Date(chat.lastMessageAt) : null)), [chats]);
  const selectedAccount = selected ? accounts.find((item) => item.id === selected.accountId) : undefined;
  const closeChat = useCallback(() => {
    setSelectedId(null);
    setThread(null);
  }, []);
  const listRef = useRef<HTMLDivElement>(null);
  useInboxHotkeys({ listRef, onClose: selectedId ? closeChat : null });

  const name = selected ? chatTitle(selected) : "";
  const person = selected?.person ?? null;
  const recordId = person?.crmRecordId ?? null;

  return (
    <InboxLayout
      threadOpen={selectedId !== null}
      header={
        <PageHeader
          title="Instagram messages"
          description={`Direct messages on your linked Instagram accounts. Replies are drafted for review in Action required and sent from there; ${BRAND.shortName} never starts a chat.`}
          actions={
            <>
              <Button.Root variant="neutral" mode="stroke" size="small" asChild>
                <Link href="/crm/actions">
                  <Button.Icon as={RiTodoLine} />
                  Action required
                </Link>
              </Button.Root>
              <Button.Root variant="neutral" mode="stroke" size="small" asChild>
                <Link href="/settings/instagram-accounts">
                  <Button.Icon as={RiSettings3Line} />
                  Accounts
                </Link>
              </Button.Root>
            </>
          }
        />
      }
    >
      <ListPane
        label="Instagram chats"
        hidden={selectedId !== null}
        busy={loadingList && chats.length > 0}
        scrollRef={listRef}
        toolbar={
          accounts.length > 1 ? (
            <div className="flex items-center justify-end gap-2">
              <FilterPopover count={accountFilter ? 1 : 0} onClear={() => setAccountFilter("")}>
                <FilterField label="Instagram account">
                  <Select.Root size="small" value={accountFilter} onValueChange={setAccountFilter}>
                    <Select.Trigger aria-label="Instagram account">
                      <Select.Value placeholder="All accounts" />
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="">All accounts</Select.Item>
                      {accounts.map((account) => (
                        <Select.Item key={account.id} value={account.id}>{accountLabel(account)}</Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                </FilterField>
              </FilterPopover>
            </div>
          ) : undefined
        }
        footer={<ListCount shown={chats.length} total={nextCursor ? null : chats.length} noun={chats.length === 1 ? "chat" : "chats"} loading={loadingList} />}
      >
        {listError && (
          <InlineError className="m-3" onRetry={() => void loadList()}>
            {listError}
          </InlineError>
        )}
        {loadingList && chats.length === 0 ? (
          <RowsSkeleton />
        ) : chats.length === 0 && !listError ? (
          <EmptyState
            compact
            icon={RiChat3Line}
            title={accountFilter ? "No chats on this account" : "No chats yet"}
            description={
              accounts.length === 0
                ? "Connect an Instagram account to start."
                : "Chats appear as people message your accounts. You can also import recent ones as history."
            }
            action={
              <Button.Root variant="neutral" mode="stroke" size="xsmall" asChild>
                <Link href="/settings/instagram-accounts">{accounts.length === 0 ? "Connect an account" : "Instagram accounts"}</Link>
              </Button.Root>
            }
          />
        ) : (
          grouped.map(({ row: chat, heading }) => {
            const rowName = chatTitle(chat);
            const account = accounts.length > 1 ? accounts.find((item) => item.id === chat.accountId) : undefined;
            const last = chat.lastMessageAt ? new Date(chat.lastMessageAt) : null;
            return (
              <div key={chat.id}>
                {heading && <DayHeading>{heading}</DayHeading>}
                <ConversationRow
                  selected={chat.id === selectedId}
                  unread={chat.unreadCount > 0}
                  unreadCount={chat.unreadCount}
                  onSelect={() => openChat(chat)}
                  avatar={<InboxAvatar name={rowName} />}
                  title={rowName}
                  subtitle={chat.username && rowName !== `@${chat.username}` ? `@${chat.username}` : undefined}
                  time={rowTime(last)}
                  timeTitle={fullTime(last)}
                  snippet={
                    chat.lastMessagePreview ? (
                      <>
                        {chat.lastDirection === "outbound" && <span className="text-text-soft-400">You: </span>}
                        {chat.lastMessagePreview}
                      </>
                    ) : (
                      <span className="italic text-text-soft-400">No messages yet</span>
                    )
                  }
                  meta={
                    !chat.person || account || chat.firstSeenVia === "import" ? (
                      <>
                        {!chat.person && <RowBadge dot={false}>Not in {BRAND.shortName}</RowBadge>}
                        {chat.firstSeenVia === "import" && <RowMeta icon={RiHistoryLine}>Imported</RowMeta>}
                        {account && <RowMeta icon={InstagramLogo}>{accountLabel(account)}</RowMeta>}
                      </>
                    ) : undefined
                  }
                />
              </div>
            );
          })
        )}
        {nextCursor && !loadingList && (
          <div className="flex justify-center py-3">
            <Button.Root variant="neutral" mode="ghost" size="xsmall" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore && <Button.Icon as={RiLoader4Line} className="animate-spin" />}
              Load more
            </Button.Root>
          </div>
        )}
      </ListPane>

      <ReadingPane shown={selectedId !== null}>
        {!selected ? (
          <ReadingEmpty icon={RiChat3Line} description="Pick a chat from the list to read it." />
        ) : (
          <>
            <ThreadHeader
              onBack={closeChat}
              backLabel="Back to chats"
              avatar={<InboxAvatar name={name} />}
              title={name}
              badges={person ? (recordId ? undefined : <RowBadge dot={false}>Not in CRM</RowBadge>) : <RowBadge dot={false}>Not in {BRAND.shortName}</RowBadge>}
              subtitle={
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <InstagramTag label={selectedAccount ? `to ${accountLabel(selectedAccount)}` : "Instagram"} />
                  {selected.username && selected.username !== name.replace(/^@/, "") && <span className="text-text-soft-400">· @{selected.username}</span>}
                </span>
              }
              actions={
                recordId ? (
                  <Button.Root variant="neutral" mode="stroke" size="xsmall" asChild className="@max-3xl:w-8 @max-3xl:px-0" title="Open CRM record">
                    <Link href={`/crm/records/${recordId}`} aria-label="Open CRM record">
                      <Button.Icon as={RiUserSearchLine} />
                      <span className="hidden @3xl:inline">Record</span>
                    </Link>
                  </Button.Root>
                ) : undefined
              }
            />

            {threadError && (
              <InlineError className="m-3" onRetry={() => void loadThread(selected.id)}>
                {threadError}
              </InlineError>
            )}
            {loadingThread && !thread ? (
              <ThreadSkeleton />
            ) : (
              <InstagramMessageList messages={thread?.messages ?? []} threadKey={selected.id} leadName={name} />
            )}

            <ComposerDock>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-bg-weak-50 px-3.5 py-2.5 text-paragraph-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200">
                <span className="min-w-0 flex-1">
                  {person
                    ? "Replies to this chat are drafted for review in Action required and sent from there."
                    : `Replies are drafted once the sender is in your leads (or arrives as an inquiry). Until then this chat is read-only here.`}
                </span>
                <Button.Root variant="neutral" mode="stroke" size="xsmall" asChild>
                  <Link href={recordId ? `/crm/records/${recordId}` : "/crm/actions"}>{recordId ? "Open record" : "Action required"}</Link>
                </Button.Root>
              </div>
            </ComposerDock>
          </>
        )}
      </ReadingPane>
    </InboxLayout>
  );
}

function dayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const yesterday = new Date();
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(iso) === dayKey(now.toISOString())) return "Today";
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  }).format(date);
}

const ORIGIN_LABEL = {
  lead: "",
  agentsdr: `Sent from ${BRAND.shortName}`,
  phone: "Sent from Instagram",
} as const;

/**
 * Oldest-first messages with day separators, in the WhatsApp thread's shape.
 * A history message (imported, or older than the account's link) is muted
 * and marked "History": it is shown for context and never answered. Scrolls
 * to the bottom when the chat changes and follows new messages while the
 * reader is near the bottom.
 */
function InstagramMessageList({ messages, threadKey, leadName }: { messages: InstagramMessage[]; threadKey: string; leadName: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastKey = useRef<string | null>(null);
  const lastCount = useRef(0);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const switched = lastKey.current !== threadKey;
    const grew = messages.length > lastCount.current;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 160;
    if (switched || (grew && nearBottom)) element.scrollTop = element.scrollHeight;
    lastKey.current = threadKey;
    lastCount.current = messages.length;
  }, [messages, threadKey]);

  const firstName = leadName.trim().replace(/^@/, "").split(/\s+/)[0];

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
      {messages.length === 0 ? (
        <p className="py-8 text-center text-paragraph-sm text-text-soft-400">No messages yet. Messages received and sent appear here.</p>
      ) : (
        messages.map((message, index) => {
          const previous = messages[index - 1];
          const next = messages[index + 1];
          const outbound = message.direction === "outbound";
          const newDay = !previous || dayKey(previous.sentAt) !== dayKey(message.sentAt);
          const sameRun = (other: InstagramMessage | undefined) =>
            Boolean(other)
            && dayKey(other!.sentAt) === dayKey(message.sentAt)
            && other!.direction === message.direction
            && other!.origin === message.origin
            && other!.historical === message.historical;
          const groupStart = !sameRun(previous);
          const groupEnd = !sameRun(next);
          const label = outbound ? ORIGIN_LABEL[message.origin] : "";
          const who = outbound ? "You" : firstName;
          return (
            <div key={message.id}>
              {newDay && (
                <div className="my-4 flex items-center gap-3 first:mt-0" role="separator" aria-label={dayLabel(message.sentAt)}>
                  <span className="h-px flex-1 bg-stroke-soft-200" />
                  <span className="text-label-xs text-text-soft-400" suppressHydrationWarning>
                    {dayLabel(message.sentAt)}
                  </span>
                  <span className="h-px flex-1 bg-stroke-soft-200" />
                </div>
              )}
              <div className={cn("flex flex-col", outbound ? "items-end" : "items-start", groupStart ? "mt-3" : "mt-1")}>
                {groupStart && (who || label || message.historical) && (
                  <div className={cn("mb-1 flex items-baseline gap-1.5 px-1 text-paragraph-xs", outbound ? "justify-end" : "justify-start")}>
                    {who && <span className="text-label-xs text-text-strong-950">{who}</span>}
                    {label && <span className="text-text-soft-400">{who ? "· " : ""}{label}</span>}
                    {message.historical && (
                      <span
                        title="History: imported, or sent before this account was linked. Shown for context, never answered."
                        className="inline-flex items-center gap-0.5 self-center rounded-md bg-bg-weak-50 px-1.5 py-px text-label-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200"
                      >
                        <RiHistoryLine className="size-3" aria-hidden="true" />
                        History
                      </span>
                    )}
                  </div>
                )}
                <div
                  className={cn(
                    "max-w-[min(36rem,85%)] rounded-2xl px-3.5 py-2 text-paragraph-sm text-text-strong-950 ring-1 ring-inset",
                    outbound ? "bg-primary-alpha-10 ring-primary-alpha-16" : "bg-bg-weak-50 ring-stroke-soft-200",
                    message.historical && "opacity-70",
                    outbound ? [!groupStart && "rounded-tr-md", !groupEnd && "rounded-br-md"] : [!groupStart && "rounded-tl-md", !groupEnd && "rounded-bl-md"],
                  )}
                >
                  {message.attachments.map((attachment, attachmentIndex) => (
                    <p key={attachment.id ?? attachmentIndex} className="mb-1 flex items-center gap-1 text-paragraph-xs text-text-sub-600">
                      <RiAttachment2 className="size-3.5 shrink-0" aria-hidden="true" />
                      <span className="truncate">{attachment.name || attachment.type || "Attachment"}</span>
                    </p>
                  ))}
                  {message.body && <p className="whitespace-pre-wrap break-words">{message.body}</p>}
                  <div className="mt-0.5 flex items-center justify-end gap-1 text-[11px] leading-4 text-text-soft-400">
                    {message.historical && <span className="sr-only">History, </span>}
                    <span className="tabular-nums" suppressHydrationWarning>{formatMessageTime(message.sentAt)}</span>
                  </div>
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
