"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RiChat3Line,
  RiCheckDoubleLine,
  RiLayoutRightLine,
  RiLoader4Line,
  RiSearchLine,
  RiSmartphoneLine,
  RiUserSearchLine,
} from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Select from "@/components/alignui/select";
import { DocsLink } from "@/components/page/DocsLink";
import { EmptyState } from "@/components/page/EmptyState";
import { PageHeader } from "@/components/page/PageHeader";
import { Skeleton } from "@/components/page/Skeletons";
import { CallButton } from "@/components/calls/CallButton";
import { titleAtCompany } from "@/components/calling/callingShared";
import { categoryToneClass } from "@/components/crm/ActionRowTools";
import { DoNotContactNotice } from "@/components/crm/InboxCrmStrip";
import {
  ChannelTag,
  ConversationRow,
  DayHeading,
  FilterField,
  FilterPopover,
  HeaderAction,
  InboxAvatar,
  InboxLayout,
  InlineError,
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
  fullTime,
  rowTime,
  withRecencyBreaks,
} from "@/components/inbox/shell/InboxShell";
import { ComposerDock } from "@/components/inbox/shell/Conversation";
import { ContactDetails, DetailsPanel, useCrmRecordSummary, useDetailsPanel, workflowLabel } from "@/components/inbox/shell/DetailsPanel";
import { useInboxHotkeys } from "@/components/inbox/shell/hotkeys";
import { WhatsappComposer, WhatsappMessageList } from "@/components/whatsapp/WhatsappThread";
import { useVisiblePolling, WHATSAPP_POLL_INTERVAL_MS } from "@/components/whatsapp/usePolling";
import { CATEGORY_LABELS, errorMessage, type CrmCategory } from "@/components/crm/crm-utils";
import { cn } from "@/utils/cn";
import {
  getWhatsappChat,
  listWhatsappAccounts,
  listWhatsappChats,
  markWhatsappChatRead,
  sendWhatsapp,
} from "@/lib/whatsapp/client";
import type { WhatsappAccountSummary, WhatsappChatSummary, WhatsappMessage } from "@/lib/whatsapp/contract";
import { BRAND } from "@/lib/brand";

function chatTitle(chat: WhatsappChatSummary): string {
  return chat.person?.fullName || chat.name || chat.phone || "Unknown number";
}

function accountLabel(account: WhatsappAccountSummary): string {
  return account.name || account.phone || "WhatsApp number";
}

/** `initialChatId` opens that chat on arrival (Messages?chat=…, e.g. from a campaign lead). */
export function WhatsappMessagesClient({ initialChatId = null }: { initialChatId?: string | null } = {}) {
  const [accounts, setAccounts] = useState<WhatsappAccountSummary[]>([]);
  const [accountFilter, setAccountFilter] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const [chats, setChats] = useState<WhatsappChatSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(initialChatId);
  const [thread, setThread] = useState<{ chat: WhatsappChatSummary; messages: WhatsappMessage[] } | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);
  const [threadError, setThreadError] = useState("");
  const [draft, setDraft] = useState("");

  useEffect(() => {
    void listWhatsappAccounts().then((response) => setAccounts(response.accounts)).catch(() => undefined);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // --- list ---------------------------------------------------------------
  const listRequest = useRef(0);
  const loadList = useCallback(
    async (background = false) => {
      const request = ++listRequest.current;
      if (!background) setLoadingList(true);
      try {
        const response = await listWhatsappChats({ accountId: accountFilter || undefined, search: search || undefined, unread: unreadOnly });
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
    [accountFilter, search, unreadOnly],
  );

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const response = await listWhatsappChats({ accountId: accountFilter || undefined, search: search || undefined, unread: unreadOnly, cursor: nextCursor });
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
      const response = await getWhatsappChat(id);
      if (request !== threadRequest.current) return;
      setThread({ chat: response.chat, messages: response.messages });
      setThreadError("");
      if (response.chat.unreadCount > 0) {
        void markWhatsappChatRead(id).catch(() => undefined);
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

  const openChat = (chat: WhatsappChatSummary) => {
    if (chat.id === selectedId) return;
    setSelectedId(chat.id);
    setThread(null);
    setDraft("");
    setChats((current) => current.map((item) => (item.id === chat.id ? { ...item, unreadCount: 0 } : item)));
    void loadThread(chat.id);
  };

  useVisiblePolling(() => {
    void loadList(true);
    if (selectedId) void loadThread(selectedId, true);
  }, WHATSAPP_POLL_INTERVAL_MS);

  const send = async (text: string) => {
    if (!thread) return;
    const response = await sendWhatsapp({ chatId: thread.chat.id, text });
    setDraft("");
    setThread((current) => (current ? { chat: response.chat, messages: [...current.messages, response.message] } : current));
    setChats((current) => [response.chat, ...current.filter((chat) => chat.id !== response.chat.id)]);
  };

  const accountOptions = useMemo(
    () => accounts.map((account) => ({ value: account.id, label: accountLabel(account), sublabel: account.phone && account.name ? account.phone : undefined })),
    [accounts],
  );
  const filtersActive = Boolean(search || unreadOnly || accountFilter);
  const selected = thread?.chat ?? chats.find((chat) => chat.id === selectedId) ?? null;
  const grouped = useMemo(() => withRecencyBreaks(chats, (chat) => (chat.lastMessageAt ? new Date(chat.lastMessageAt) : null)), [chats]);
  const selectedAccount = selected ? accounts.find((item) => item.id === selected.accountId) : undefined;
  const clearFilters = () => {
    setSearchInput("");
    setUnreadOnly(false);
    setAccountFilter("");
  };
  const closeChat = useCallback(() => {
    setSelectedId(null);
    setThread(null);
  }, []);
  const listRef = useRef<HTMLDivElement>(null);
  useInboxHotkeys({ listRef, onClose: selectedId ? closeChat : null });
  const details = useDetailsPanel(selectedId);
  const recordId = selected?.person?.crmRecordId ?? null;
  // The header's category chip needs the record whether or not the details are open.
  const { summary: record, loading: recordLoading } = useCrmRecordSummary(recordId);
  // Unread across the chats loaded so far; with more pages to load it is a floor.
  const unreadLoaded = chats.filter((chat) => chat.unreadCount > 0).length;

  const name = selected ? chatTitle(selected) : "";
  const person = selected?.person ?? null;
  const detailsPanel = selected ? (
    <DetailsPanel open={details.open} wide={details.wide} onClose={() => details.setOpen(false)}>
      <ContactDetails
        name={name}
        avatarSrc={person?.profilePictureUrl ?? record?.profilePictureUrl}
        headline={person?.title ?? record?.title}
        company={record?.company ?? (person?.companyName ? { name: person.companyName } : null)}
        channel="whatsapp"
        links={{ recordId, phone: selected.phone ?? record?.phone, email: record?.email, linkedinUrl: record?.linkedinUrl }}
        crm={
          record
            ? {
                recordId,
                categoryKey: record.categoryKey,
                categoryLabel: record.subcategory ?? (record.categoryKey ? CATEGORY_LABELS[record.categoryKey as CrmCategory] ?? record.categoryKey : "Unclassified"),
                stage: workflowLabel(record.workflowState),
                sequence: record.sequence,
                nextActionAt: record.nextActionAt,
                lastInboundAt: record.lastInboundAt,
                lastOutboundAt: record.lastOutboundAt,
                doNotContact: record.doNotContact,
              }
            : null
        }
        crmLoading={Boolean(recordId) && recordLoading}
        facts={[
          ...(selectedAccount ? [{ label: "Number", value: accountLabel(selectedAccount), title: selectedAccount.phone ?? undefined }] : []),
          ...(selected.lastMessageAt ? [{ label: "Last message", value: rowTime(new Date(selected.lastMessageAt)), title: fullTime(new Date(selected.lastMessageAt)) }] : []),
          ...(!person ? [{ label: `In ${BRAND.shortName}`, value: "Not yet — add the number to People" }] : []),
        ]}
      />
    </DetailsPanel>
  ) : undefined;

  return (
    <InboxLayout
      threadOpen={selectedId !== null}
      header={
        <PageHeader
          title="Messages"
          description="WhatsApp chats on your linked numbers, including what you send from the phone."
          actions={
            <Button.Root variant="neutral" mode="stroke" size="small" asChild>
              <Link href="/settings/whatsapp-accounts">
                <Button.Icon as={RiSmartphoneLine} />
                Numbers
              </Link>
            </Button.Root>
          }
        />
      }
    >
      <ListPane
        label="WhatsApp chats"
        hidden={selectedId !== null}
        busy={loadingList && chats.length > 0}
        scrollRef={listRef}
        toolbar={
          <div className="flex items-center gap-2">
            <ListSearch value={searchInput} onChange={setSearchInput} placeholder="Search name or number" label="Search chats" />
            {accounts.length > 1 && (
              <FilterPopover count={accountFilter ? 1 : 0} onClear={() => setAccountFilter("")}>
                <FilterField label="WhatsApp number">
                  <Select.Root size="small" value={accountFilter} onValueChange={setAccountFilter}>
                    <Select.Trigger aria-label="WhatsApp number">
                      <Select.Value placeholder="All numbers" />
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="">All numbers</Select.Item>
                      {accountOptions.map((option) => (
                        <Select.Item key={option.value} value={option.value}>
                          {option.label}
                          {option.sublabel && <span className="ml-1.5 text-text-soft-400">{option.sublabel}</span>}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                </FilterField>
              </FilterPopover>
            )}
          </div>
        }
        tabs={
          <TriageTabs
            label="Filter chats"
            value={unreadOnly ? "unread" : "all"}
            onChange={(value) => setUnreadOnly(value === "unread")}
            tabs={[
              { key: "all", label: "All" },
              { key: "unread", label: "Unread", count: unreadLoaded || null, countTitle: `${unreadLoaded}${nextCursor ? "+" : ""} unread chats` },
            ]}
          />
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
          filtersActive ? (
            <EmptyState
              compact
              icon={unreadOnly && !search ? RiCheckDoubleLine : RiSearchLine}
              title={unreadOnly && !search ? "You're all caught up" : "No chats match"}
              description={unreadOnly && !search ? "Nothing unread right now." : "Try another name or number."}
              action={
                <Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={clearFilters}>
                  Show all chats
                </Button.Root>
              }
            />
          ) : (
            <EmptyState
              compact
              icon={RiChat3Line}
              title="No chats yet"
              description={
                accounts.length === 0
                  ? "Link a WhatsApp number to start."
                  : "Chats appear as leads reply, or import recent ones from your linked numbers."
              }
              action={
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button.Root variant="neutral" mode="stroke" size="xsmall" asChild>
                    <Link href="/settings/whatsapp-accounts">{accounts.length === 0 ? "Link a number" : "WhatsApp numbers"}</Link>
                  </Button.Root>
                  {accounts.length === 0 && <DocsLink page="whatsapp/accounts#link-a-number" size="xsmall" />}
                </div>
              }
            />
          )
        ) : (
          grouped.map(({ row: chat, heading }) => {
            const rowName = chatTitle(chat);
            const unread = chat.unreadCount > 0;
            const account = accounts.length > 1 ? accounts.find((item) => item.id === chat.accountId) : undefined;
            const last = chat.lastMessageAt ? new Date(chat.lastMessageAt) : null;
            return (
              <div key={chat.id}>
                {heading && <DayHeading>{heading}</DayHeading>}
                <ConversationRow
                  selected={chat.id === selectedId}
                  unread={unread}
                  unreadCount={chat.unreadCount}
                  onSelect={() => openChat(chat)}
                  avatar={<InboxAvatar name={rowName} src={chat.person?.profilePictureUrl} />}
                  title={rowName}
                  subtitle={chat.person?.companyName ?? undefined}
                  time={rowTime(last)}
                  timeTitle={fullTime(last)}
                  hint={chat.person ? titleAtCompany(chat.person) ?? undefined : chat.phone ?? undefined}
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
                    !chat.person || account ? (
                      <>
                        {!chat.person && <RowBadge dot={false}>Not in {BRAND.shortName}</RowBadge>}
                        {account && <RowMeta icon={RiSmartphoneLine}>{accountLabel(account)}</RowMeta>}
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

      <ReadingPane shown={selectedId !== null} aside={detailsPanel}>
        {!selected ? (
          <ReadingEmpty icon={RiChat3Line} description="Pick a chat from the list to read it and reply." />
        ) : (
          <>
            <ThreadHeader
              onBack={closeChat}
              backLabel="Back to chats"
              avatar={<InboxAvatar name={name} src={person?.profilePictureUrl} />}
              title={name}
              badges={
                person ? (
                  recordId ? (
                    record ? (
                      <CategoryBadge categoryKey={record.categoryKey} label={record.subcategory ?? (record.categoryKey ? CATEGORY_LABELS[record.categoryKey as CrmCategory] ?? record.categoryKey : "Unclassified")} />
                    ) : (
                      <Skeleton className="h-6 w-20 rounded-md" />
                    )
                  ) : (
                    <RowBadge dot={false}>Not in CRM</RowBadge>
                  )
                ) : (
                  <RowBadge dot={false}>Not in {BRAND.shortName}</RowBadge>
                )
              }
              channel="whatsapp"
              subtitle={[person ? titleAtCompany(person) : null, selected.phone && selected.phone !== name ? selected.phone : null].filter(Boolean).join(" · ") || undefined}
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
                  {person && <CallButton personId={person.id} crmRecordId={recordId} phone={selected.phone} numberMenu={false} />}
                  <HeaderAction icon={RiLayoutRightLine} label={details.open ? "Hide details" : "Show details"} onClick={details.toggle} pressed={details.open} iconOnly />
                </>
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
              <WhatsappMessageList
                messages={thread?.messages ?? []}
                threadKey={selected.id}
                leadName={name}
                className="px-4 py-5 sm:px-6"
                emptyText="No messages yet. Messages sent and received appear here."
              />
            )}

            <ComposerDock>
              {record?.doNotContact ? (
                <DoNotContactNotice />
              ) : (
                <WhatsappComposer
                  value={draft}
                  onChange={setDraft}
                  onSend={send}
                  disabled={!thread}
                  placeholder={`Message ${name.split(" ")[0] || "them"}…`}
                  meta={
                    <span title="Sent through Unipile. New chats wait 24 h after a number is linked, and messages are spaced 10 s apart.">
                      <ChannelTag channel="whatsapp" label={selectedAccount ? `from ${accountLabel(selectedAccount)}` : "WhatsApp"} />
                    </span>
                  }
                />
              )}
            </ComposerDock>
          </>
        )}
      </ReadingPane>
    </InboxLayout>
  );
}

/** The record's CRM category, tinted in its identity colour (read-only: WhatsApp has no reclassify route of its own). */
function CategoryBadge({ categoryKey, label }: { categoryKey: string | null; label: string }) {
  return (
    <span
      title={`CRM category: ${label}`}
      className={cn(
        "inline-flex h-6 min-w-0 max-w-[11rem] items-center rounded-md px-2 text-label-xs ring-1 ring-inset",
        categoryToneClass[categoryKey ?? ""] ?? "bg-bg-weak-50 text-text-sub-600 ring-stroke-soft-200",
      )}
    >
      <span className="truncate">{label}</span>
    </span>
  );
}
