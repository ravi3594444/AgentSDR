"use client";

import { useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from "react";
import { RiArrowDownSLine, RiArrowLeftLine, RiCheckLine, RiFilter3Line, RiSearchLine, RiUser3Line } from "@remixicon/react";

import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Dropdown from "@/components/alignui/dropdown";
import * as Input from "@/components/alignui/input";
import * as Popover from "@/components/alignui/popover";
import { CHANNEL_META } from "@/components/analytics/theme";
import { categoryColor } from "@/components/crm/crm-utils";
import { EmptyState } from "@/components/page/EmptyState";
import { Skeleton } from "@/components/page/Skeletons";
import { cn } from "@/utils/cn";

/**
 * The one inbox shell every split-pane inbox is built from — Master Inbox,
 * LinkedIn Messages, WhatsApp Messages, Tasks and Notes. Each page keeps its
 * own data logic and composes these pieces:
 *
 *   <InboxLayout header={<PageHeader … />}>
 *     <ListPane hidden={!!selected} toolbar={…} tabs={<TriageTabs … />}>rows…</ListPane>
 *     <ReadingPane shown={!!selected} aside={<DetailsPanel … />}>
 *       <ThreadHeader … />
 *       …messages… composer…
 *     </ReadingPane>
 *   </InboxLayout>
 *
 * Three columns on a wide screen: the conversation list, the thread, and the
 * person's details (./DetailsPanel). Narrower, the details become an overlay
 * the thread header toggles. Below `md` one pane shows at a time: the list,
 * or the open thread with a back button in its header.
 */

export type InboxChannel = keyof typeof CHANNEL_META;

/**
 * Header, then the split pane filling the rest of the viewport. Nothing here
 * scrolls the page. On a phone with a thread open (`threadOpen`) the page
 * header steps aside so the conversation gets the screen.
 */
export function InboxLayout({ header, threadOpen = false, children }: { header: ReactNode; threadOpen?: boolean; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn("mb-4", threadOpen && "hidden md:block")}>{header}</div>
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-2xl border border-stroke-soft-200 bg-bg-white-0">
        {children}
      </div>
    </div>
  );
}

/**
 * The conversation list. `toolbar` sits above the rows (search, filters),
 * `tabs` under it (the triage scopes); the rows scroll on their own. `busy`
 * dims the rows during a refetch instead of blanking them.
 */
export function ListPane({
  label,
  hidden,
  toolbar,
  tabs,
  busy,
  scrollRef,
  footer,
  className,
  children,
}: {
  label: string;
  /** Hidden below `md` — a thread is open and has the screen. */
  hidden?: boolean;
  toolbar?: ReactNode;
  tabs?: ReactNode;
  busy?: boolean;
  scrollRef?: Ref<HTMLDivElement>;
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className={cn(
        "min-w-0 w-full shrink-0 flex-col border-stroke-soft-200 md:w-80 md:border-r xl:w-[22rem]",
        hidden ? "hidden md:flex" : "flex",
        className,
      )}
    >
      {toolbar && <div className="shrink-0 space-y-3 p-4 pb-3">{toolbar}</div>}
      {tabs && <div className="shrink-0 border-b border-stroke-soft-200">{tabs}</div>}
      {!tabs && toolbar && <div className="h-px shrink-0 bg-stroke-soft-200" />}
      <div
        ref={scrollRef}
        aria-busy={busy || undefined}
        className={cn("relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2 transition-opacity", busy && "opacity-60")}
      >
        {children}
      </div>
      {footer && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-stroke-soft-200 px-4 py-2 text-paragraph-xs text-text-soft-400">
          {footer}
        </div>
      )}
    </section>
  );
}

/**
 * The reading pane. Below `md` it only shows while a thread is open. `aside`
 * is the details column (DetailsPanel), beside the thread on wide screens and
 * over it on narrow ones.
 */
export function ReadingPane({ shown, aside, className, children }: { shown: boolean; aside?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={cn("relative min-w-0 flex-1 overflow-hidden", shown ? "flex" : "hidden md:flex")}>
      <section aria-label="Conversation" className={cn("@container flex min-w-0 flex-1 flex-col overflow-hidden", className)}>
        {children}
      </section>
      {aside}
    </div>
  );
}

/** Nothing open yet: the same prompt in every inbox, with the keyboard shortcuts. */
export function ReadingEmpty({
  icon,
  title = "Select a conversation",
  description = "Pick one from the list to read it and reply.",
  shortcuts = true,
}: {
  icon: ComponentType<{ className?: string }>;
  title?: string;
  description?: string;
  shortcuts?: boolean;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-bg-weak-50/60">
      <EmptyState icon={icon} title={title} description={description} />
      {shortcuts && (
        <p className="-mt-10 hidden items-center gap-1.5 text-paragraph-xs text-text-soft-400 md:flex">
          <Kbd>J</Kbd>
          <Kbd>K</Kbd>
          to move
          <span aria-hidden="true" className="mx-1">·</span>
          <Kbd>Enter</Kbd>
          to open
          <span aria-hidden="true" className="mx-1">·</span>
          <Kbd>Esc</Kbd>
          back to the list
        </p>
      )}
    </div>
  );
}

/** A key cap for shortcut hints. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-bg-white-0 px-1 font-sans text-[13px] font-medium leading-none text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200", className)}>
      {children}
    </kbd>
  );
}

// ---------------------------------------------------------------- toolbar

/** Search box for the list toolbar. */
export function ListSearch({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
}) {
  return (
    <Input.Root size="small" className="min-w-0 flex-1">
      <Input.Wrapper>
        <Input.Icon as={RiSearchLine} />
        <Input.Input type="search" aria-label={label} placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
      </Input.Wrapper>
    </Input.Root>
  );
}

export type TriageTab = {
  key: string;
  label: string;
  /** Shown beside the label; hidden when 0 or unknown. */
  count?: number | null;
  /** What the count means ("944 unread"), for its tooltip. */
  countTitle?: string;
  /** A hint for the tab itself. */
  title?: string;
};

/**
 * The list's scopes as tabs under the search: the few that decide what to
 * work on next, with counts, and the rest behind "More". A scope picked from
 * "More" takes that tab's place so the current scope is always named.
 */
export function TriageTabs({
  label,
  tabs,
  more = [],
  moreGroups,
  value,
  onChange,
}: {
  label: string;
  tabs: TriageTab[];
  more?: TriageTab[];
  /** `more` split into labelled groups instead of one flat menu. */
  moreGroups?: { label: string; tabs: TriageTab[] }[];
  value: string;
  onChange: (key: string) => void;
}) {
  const groups = moreGroups ?? (more.length ? [{ label: "", tabs: more }] : []);
  const moreTabs = groups.flatMap((group) => group.tabs);
  const activeMore = moreTabs.find((tab) => tab.key === value);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-triage-tab]")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    buttons[(index + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  };

  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex items-stretch gap-0.5 overflow-x-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {tabs.map((tab) => (
        <TabButton key={tab.key} tab={tab} active={tab.key === value} onClick={() => onChange(tab.key)} />
      ))}
      {moreTabs.length > 0 && (
        <Dropdown.Root>
          <Dropdown.Trigger asChild>
            <button
              type="button"
              data-triage-tab
              aria-label={activeMore ? `Showing ${activeMore.label}. Other views` : "More views"}
              className={cn(
                "relative inline-flex h-10 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 text-label-sm outline-none transition focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-base",
                activeMore ? "text-text-strong-950" : "text-text-sub-600 hover:text-text-strong-950",
              )}
            >
              {activeMore ? activeMore.label : "More"}
              {activeMore?.count ? <TabCount count={activeMore.count} title={activeMore.countTitle} active /> : null}
              <RiArrowDownSLine className="size-4 text-text-soft-400" aria-hidden="true" />
              {activeMore && <span aria-hidden="true" className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary-base" />}
            </button>
          </Dropdown.Trigger>
          <Dropdown.Content align="start" className="max-h-[min(28rem,calc(100vh-8rem))] min-w-52 overflow-y-auto">
            {groups.map((group, index) => (
              <Dropdown.Group key={group.label || index}>
                {index > 0 && <Dropdown.Separator />}
                {group.label && <p className="px-2 pb-1 pt-1.5 text-subheading-2xs uppercase text-text-soft-400">{group.label}</p>}
                {group.tabs.map((tab) => (
                  <Dropdown.Item key={tab.key} onSelect={() => onChange(tab.key)} title={tab.title} className="justify-between">
                    <span className="flex min-w-0 items-center gap-2">
                      <RiCheckLine className={cn("size-4 shrink-0", tab.key === value ? "text-primary-base" : "invisible")} aria-hidden="true" />
                      <span className="truncate">{tab.label}</span>
                    </span>
                    {tab.count ? <span className="text-paragraph-xs tabular-nums text-text-soft-400">{tab.count.toLocaleString("en-US")}</span> : null}
                  </Dropdown.Item>
                ))}
              </Dropdown.Group>
            ))}
          </Dropdown.Content>
        </Dropdown.Root>
      )}
    </div>
  );
}

function TabButton({ tab, active, onClick }: { tab: TriageTab; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      data-triage-tab
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      title={tab.title}
      className={cn(
        "relative inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-label-sm outline-none transition focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-base",
        active ? "text-text-strong-950" : "text-text-sub-600 hover:text-text-strong-950",
      )}
    >
      {tab.label}
      {tab.count ? <TabCount count={tab.count} title={tab.countTitle} active={active} /> : null}
      {active && <span aria-hidden="true" className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary-base" />}
    </button>
  );
}

function TabCount({ count, title, active }: { count: number; title?: string; active: boolean }) {
  return (
    <span
      title={title}
      className={cn(
        "rounded-full px-1.5 text-[13px] font-medium leading-[1.125rem] tabular-nums",
        active ? "bg-bg-weak-50 text-text-strong-950 ring-1 ring-inset ring-stroke-soft-200" : "text-text-soft-400",
      )}
    >
      {count > 999 ? `${Math.floor(count / 100) / 10}k` : count.toLocaleString("en-US")}
    </span>
  );
}

/**
 * "Filter" button opening a popover of labelled fields, the same control the
 * Leads table uses. `count` is how many filters are set; `onClear` resets them.
 */
export function FilterPopover({
  count,
  onClear,
  clearDisabled,
  open,
  onOpenChange,
  width = "w-[min(20rem,calc(100vw-2rem))]",
  footer,
  iconOnly = false,
  children,
}: {
  count: number;
  onClear?: () => void;
  /** Defaults to "nothing is set"; pass it when the popover stages changes before applying. */
  clearDisabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  width?: string;
  footer?: ReactNode;
  /** Just the icon (with the count), for a toolbar beside the search box. */
  iconOnly?: boolean;
  children: ReactNode;
}) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <Button.Root variant="neutral" mode="stroke" size="small" className={cn("shrink-0", iconOnly && "gap-1 px-2.5")} aria-label={iconOnly ? `Filters${count ? ` (${count} set)` : ""}` : undefined} title={iconOnly ? "Filters" : undefined}>
          <Button.Icon as={RiFilter3Line} />
          {!iconOnly && "Filter"}
          {count > 0 && (
            <Badge.Root size="medium" variant="filled" color="blue" square>
              {count}
            </Badge.Root>
          )}
        </Button.Root>
      </Popover.Trigger>
      <Popover.Content
        align="end"
        showArrow={false}
        sideOffset={8}
        className={cn("max-h-[min(36rem,calc(100vh-6rem))] overflow-y-auto", width)}
        // Selects that portal their menu to <body> (FilterSelect) must not
        // read as a click outside and close the popover under the pointer.
        onInteractOutside={(event) => {
          const target = event.target as Element | null;
          if (target?.closest?.('[role="listbox"]')) event.preventDefault();
        }}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-label-md text-text-strong-950">Filters</h2>
          {onClear && (
            <button
              type="button"
              onClick={onClear}
              disabled={clearDisabled ?? !count}
              className="text-label-sm text-primary-base outline-none hover:underline focus-visible:underline disabled:pointer-events-none disabled:text-text-disabled-300"
            >
              Clear all
            </button>
          )}
        </div>
        <div className="mt-4 space-y-4">{children}</div>
        {footer && <div className="mt-5 border-t border-stroke-soft-200 pt-4">{footer}</div>}
      </Popover.Content>
    </Popover.Root>
  );
}

/** A labelled field inside FilterPopover. */
export function FilterField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <span className="block text-label-xs text-text-sub-600">{label}</span>
      {children}
      {hint && <p className="text-paragraph-xs text-text-soft-400">{hint}</p>}
    </div>
  );
}

/** Removable chips for the filters that are set, so they stay visible with the popover closed. */
export function ActiveFilterChips({ chips, onClearAll }: { chips: { key: string; label: string; onRemove: () => void }[]; onClearAll?: () => void }) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <span key={chip.key} className="inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-bg-weak-50 pl-2 pr-1 text-label-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200">
          <span className="truncate" title={chip.label}>{chip.label}</span>
          <button
            type="button"
            onClick={chip.onRemove}
            aria-label={`Remove filter: ${chip.label}`}
            className="flex size-4 shrink-0 items-center justify-center rounded text-text-soft-400 outline-none transition hover:bg-bg-white-0 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-primary-base"
          >
            <svg viewBox="0 0 24 24" fill="none" className="size-3" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
            </svg>
          </button>
        </span>
      ))}
      {onClearAll && chips.length > 1 && (
        <button type="button" onClick={onClearAll} className="h-6 rounded-md px-1.5 text-label-xs text-primary-base outline-none hover:underline focus-visible:underline">
          Clear all
        </button>
      )}
    </div>
  );
}

/** "20 of 1,224" — the list footer's count. */
export function ListCount({ shown, total, noun, loading }: { shown: number; total?: number | null; noun: string; loading?: boolean }) {
  if (loading && shown === 0) return <Skeleton className="h-3.5 w-20" />;
  const text =
    total == null
      ? `${shown.toLocaleString("en-US")} ${noun}`
      : shown >= total
        ? `${total.toLocaleString("en-US")} ${noun}`
        : `${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} ${noun}`;
  return <span className="shrink-0 whitespace-nowrap text-paragraph-xs tabular-nums text-text-soft-400">{text}</span>;
}

// ---------------------------------------------------------------- rows

function initialsOf(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

const AVATAR_SIZE = { xs: "size-6 text-[12px]", sm: "size-8 text-label-xs", md: "size-9 text-label-xs", lg: "size-14 text-label-lg" } as const;

/**
 * A person's photo, or their initials when there is none. Stored LinkedIn
 * CDN URLs expire, so a picture that fails falls back to initials; keyed by
 * the URL so a new photo gets a fresh chance.
 */
export function InboxAvatar({ name, src, size = "md", className }: { name: string; src?: string | null; size?: keyof typeof AVATAR_SIZE; className?: string }) {
  return <AvatarInner key={src ?? ""} name={name} src={src} size={size} className={className} />;
}

function AvatarInner({ name, src, size, className }: { name: string; src?: string | null; size: keyof typeof AVATAR_SIZE; className?: string }) {
  const [failed, setFailed] = useState(false);
  const base = cn("inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full", AVATAR_SIZE[size], className);
  if (src && !failed) {
    // eslint-disable-next-line @next/next/no-img-element -- remote CDN photo, sized by CSS
    return <img src={src} alt="" className={cn(base, "bg-bg-weak-50 object-cover")} onError={() => setFailed(true)} referrerPolicy="no-referrer" />;
  }
  // A bare phone number or address has no initials worth showing.
  const hasLetters = /\p{L}/u.test(name) && !name.includes("@");
  return (
    <span aria-hidden="true" className={cn(base, "bg-bg-weak-50 text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200")}>
      {hasLetters ? initialsOf(name) : <RiUser3Line className="size-[45%]" />}
    </span>
  );
}

/**
 * One conversation in the list. Name and time; for email a subject line; a
 * two-line preview; and at most a couple of quiet chips. Unread reads as a
 * dot in the gutter and heavier text — nothing else changes colour. A
 * real <button> marked `data-inbox-row`, so Tab, Enter and j/k all reach it.
 */
export function ConversationRow({
  selected,
  unread,
  unreadCount,
  onSelect,
  avatar,
  title,
  time,
  timeTitle,
  subtitle,
  headline,
  snippet,
  meta,
  accent,
  hint,
}: {
  selected: boolean;
  unread?: boolean;
  unreadCount?: number;
  onSelect: () => void;
  avatar: ReactNode;
  title: string;
  time?: string;
  timeTitle?: string;
  /** Muted text after the name (company), dropped first when space runs out. */
  subtitle?: ReactNode;
  /** A line above the preview — an email's subject. */
  headline?: ReactNode;
  snippet?: ReactNode;
  meta?: ReactNode;
  /** A small mark on the avatar's corner (an AI draft waiting). */
  accent?: ReactNode;
  /** The row's tooltip (the mailbox a thread belongs to). */
  hint?: string;
}) {
  const count = unreadCount ?? 0;
  return (
    <button
      type="button"
      data-inbox-row
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      title={hint}
      className={cn(
        "group relative mt-1 flex w-full items-start gap-3 rounded-xl py-3.5 pl-4 pr-3 text-left outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-base",
        selected ? "bg-bg-weak-50 ring-1 ring-inset ring-stroke-sub-300" : "hover:bg-bg-weak-50",
      )}
    >
      {selected && <span aria-hidden="true" className="absolute bottom-4 left-0 top-4 w-0.5 rounded-full bg-text-strong-950" />}
      {unread && <span aria-hidden="true" className="absolute left-1.5 top-[1.3rem] size-1.5 rounded-full bg-primary-base" />}
      <span className="relative shrink-0">
        {avatar}
        {accent && <span className="absolute -bottom-0.5 -right-1">{accent}</span>}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-2">
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className={cn("truncate text-label-sm", unread ? "font-semibold text-text-strong-950" : "text-text-strong-950")} title={title}>
              {unread && <span className="sr-only">Unread: </span>}
              {title}
            </span>
            {subtitle && <span className="hidden min-w-0 truncate text-paragraph-xs text-text-soft-400 sm:inline">{subtitle}</span>}
          </span>
          {time && (
            <span
              className={cn("shrink-0 whitespace-nowrap text-paragraph-xs tabular-nums", unread ? "font-medium text-text-strong-950" : "text-text-soft-400")}
              title={timeTitle}
              suppressHydrationWarning
            >
              {time}
            </span>
          )}
        </span>
        {headline && <span className={cn("mt-0.5 truncate text-paragraph-xs", unread ? "font-medium text-text-strong-950" : "text-text-sub-600")}>{headline}</span>}
        {(snippet || count > 0) && (
          <span className="mt-0.5 flex items-center gap-2">
            <span className={cn("min-w-0 flex-1 line-clamp-2 text-paragraph-xs leading-5 [overflow-wrap:anywhere]", unread && !headline ? "text-text-strong-950" : "text-text-sub-600")}>{snippet}</span>
            {count > 0 && (
              <span className="flex h-[1.125rem] min-w-[1.125rem] shrink-0 items-center justify-center rounded-full bg-primary-base px-1 text-[13px] font-semibold leading-none text-primary-contrast" aria-label={`${count} unread`}>
                {count > 9 ? "9+" : count}
              </span>
            )}
          </span>
        )}
        {meta && <span className="mt-1.5 flex min-w-0 items-center gap-1.5 overflow-hidden">{meta}</span>}
      </span>
    </button>
  );
}

export type BadgeTone = "gray" | "blue" | "green" | "orange" | "red";

/** A status badge sized for list rows and thread headers; long labels truncate with the full text in `title`. */
export function RowBadge({ tone = "gray", dot = true, children, title }: { tone?: BadgeTone; dot?: boolean; children: ReactNode; title?: string }) {
  return (
    <Badge.Root size="medium" variant="lighter" color={tone} className="max-w-[9.5rem] shrink-0" title={title ?? (typeof children === "string" ? children : undefined)}>
      {dot && <Badge.Dot />}
      <span className="truncate">{children}</span>
    </Badge.Root>
  );
}

/**
 * A CRM category as a read-only chip tinted in the category's identity
 * colour, naming the (sub)category. The thread header uses the editable
 * ClassificationPicker, which looks the same.
 */
export function CategoryChip({ categoryKey, label, title }: { categoryKey: string | null | undefined; label: string; title?: string }) {
  return (
    <span
      title={title ?? label}
      className={cn("inline-flex h-5 min-w-0 max-w-[10rem] shrink items-center rounded-md px-1.5 text-label-xs ring-1 ring-inset", categoryColor(categoryKey).tone)}
    >
      <span className="truncate">{label}</span>
    </span>
  );
}

/** "AI draft" — a reply is drafted and waiting for review. */
export function DraftChip({ label = "AI draft" }: { label?: string }) {
  return (
    <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-md bg-primary-alpha-10 px-1.5 text-label-xs text-primary-base" title="An AI-drafted reply is waiting for review">
      <svg viewBox="0 0 24 24" className="size-3" aria-hidden="true" fill="currentColor">
        <path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2zm7 12l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14z" />
      </svg>
      {label}
    </span>
  );
}

/** A quiet meta item (step label, mailbox, campaign) beside the chips. */
export function RowMeta({ icon: Icon, children, title, keep }: { icon?: ComponentType<{ className?: string }>; children: ReactNode; title?: string; /** Keep whole; its neighbours truncate first. */ keep?: boolean }) {
  return (
    <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1 text-paragraph-xs text-text-soft-400", keep && "shrink-0")} title={title}>
      {Icon && <Icon className="size-3.5 shrink-0" aria-hidden="true" />}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** A group heading inside the list ("Today", "Earlier"). Sticks while its rows scroll. */
export function DayHeading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="sticky top-0 z-10 -mx-1.5 flex items-center justify-between gap-2 bg-bg-white-0/95 px-4.5 pb-1 pt-3 backdrop-blur-sm" suppressHydrationWarning>
      <span className="text-subheading-2xs uppercase text-text-soft-400">{children}</span>
      {action}
    </div>
  );
}

/** Skeleton rows for a list's first load. */
export function RowsSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="pt-1.5">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex gap-3 py-2.5 pl-4 pr-3">
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2 pt-0.5">
            <div className="flex justify-between gap-3">
              <Skeleton className="h-3.5 w-1/2" />
              <Skeleton className="h-3 w-8" />
            </div>
            <Skeleton className="h-3 w-4/5" />
            {i % 2 === 0 && <Skeleton className="h-4 w-20 rounded-md" />}
          </div>
        </div>
      ))}
    </div>
  );
}

/** "Loading more…" / end-of-list line under the rows. */
export function ListEnd({ children }: { children: ReactNode }) {
  return <p className="px-4 py-3 text-center text-paragraph-xs text-text-soft-400">{children}</p>;
}

// ---------------------------------------------------------------- reading pane

/** Channel identity: the channel's icon in its colour, and its name. */
export function ChannelTag({ channel, label }: { channel: InboxChannel; label?: string }) {
  const meta = CHANNEL_META[channel];
  const Icon = meta.icon;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-paragraph-xs text-text-sub-600">
      <span style={{ color: meta.color }} className="inline-flex">
        <Icon className="size-3.5" />
      </span>
      {label ?? meta.label}
    </span>
  );
}

/**
 * The open thread's header: who it is (name, the CRM category, company or
 * headline, channel) on the left, and the thread's actions on the right —
 * one row, so the conversation starts high on the screen. `strip` is an
 * optional band under it (notices).
 */
export function ThreadHeader({
  onBack,
  backLabel = "Back to conversations",
  avatar,
  title,
  badges,
  subtitle,
  extra,
  channel,
  actions,
  strip,
}: {
  onBack: () => void;
  backLabel?: string;
  avatar?: ReactNode;
  title: ReactNode;
  badges?: ReactNode;
  subtitle?: ReactNode;
  /** A further muted line (Cc list). */
  extra?: ReactNode;
  channel?: InboxChannel;
  actions?: ReactNode;
  strip?: ReactNode;
}) {
  return (
    <header className="shrink-0 border-b border-stroke-soft-200 bg-bg-white-0">
      <div className="flex items-center gap-3 px-3 py-3 sm:px-5 sm:py-4">
        <Button.Root variant="neutral" mode="ghost" size="xsmall" onClick={onBack} aria-label={backLabel} className="-ml-1 shrink-0 md:hidden">
          <Button.Icon as={RiArrowLeftLine} />
        </Button.Root>
        {avatar && <span className="hidden shrink-0 sm:inline-flex">{avatar}</span>}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 max-w-fit shrink truncate text-label-md text-text-strong-950">{title}</div>
            {/* Beside the name when there is room; the badges give way first. */}
            {badges && <div className="hidden min-w-6 shrink-[100] items-center gap-1.5 @xl:flex">{badges}</div>}
          </div>
          {(channel || subtitle || badges) && (
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
              {/* On a narrow pane the badges lead the second line instead. */}
              {badges && <div className="flex min-w-0 max-w-[65%] shrink-0 items-center gap-1.5 @xl:hidden">{badges}</div>}
              {channel && <ChannelTag channel={channel} />}
              {channel && subtitle && <span aria-hidden="true" className="text-text-soft-400">·</span>}
              {subtitle && <div className="min-w-0 truncate text-paragraph-xs text-text-sub-600">{subtitle}</div>}
            </div>
          )}
          {extra && <div className="mt-0.5 truncate text-paragraph-xs text-text-soft-400">{extra}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      {strip}
    </header>
  );
}

/**
 * A header action: icon + label when the thread column is wide, icon only
 * when it is not (a container query on the reading pane, so an open details
 * column counts). The label stays as its accessible name and tooltip.
 */
export function HeaderAction({
  icon,
  label,
  onClick,
  href,
  external,
  pressed,
  iconOnly,
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  iconOnly?: boolean;
  onClick?: () => void;
  href?: string;
  external?: boolean;
  pressed?: boolean;
  className?: string;
}) {
  const body = (
    <>
      <Button.Icon as={icon} />
      {!iconOnly && <span className="hidden @3xl:inline">{label}</span>}
    </>
  );
  const classes = cn("shrink-0", iconOnly ? "w-8 px-0" : "@max-3xl:w-8 @max-3xl:px-0", pressed && "bg-bg-weak-50 text-text-strong-950", className);
  if (href) {
    return (
      <Button.Root variant="neutral" mode="stroke" size="xsmall" asChild className={classes} title={label}>
        <a href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})} aria-label={label}>
          {body}
        </a>
      </Button.Root>
    );
  }
  return (
    <Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={onClick} className={classes} title={label} aria-label={label} aria-pressed={pressed}>
      {body}
    </Button.Root>
  );
}

/** Message area skeleton while a thread loads. */
export function ThreadSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading conversation" className="flex flex-1 flex-col gap-4 overflow-hidden px-5 py-6">
      <div className="space-y-1.5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-14 w-3/5 rounded-2xl" />
      </div>
      <div className="ml-auto w-2/5 space-y-1.5">
        <Skeleton className="ml-auto h-3 w-16" />
        <Skeleton className="h-10 w-full rounded-2xl" />
      </div>
      <div className="space-y-1.5">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-20 w-1/2 rounded-2xl" />
      </div>
      <div className="ml-auto w-3/5 space-y-1.5">
        <Skeleton className="ml-auto h-3 w-16" />
        <Skeleton className="h-14 w-full rounded-2xl" />
      </div>
    </div>
  );
}

/** Inline error with an optional retry. */
export function InlineError({ children, onRetry, className }: { children: ReactNode; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cn("flex items-start justify-between gap-3 rounded-lg bg-error-lighter px-3 py-2 text-paragraph-xs text-error-dark ring-1 ring-inset ring-error-light", className)}>
      <span className="min-w-0">{children}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="shrink-0 text-label-xs text-error-dark underline-offset-2 outline-none hover:underline focus-visible:underline">
          Try again
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- time

export function dayKeyOf(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** "Today", "Yesterday", "Mon, Sep 12", or with the year when it is not this year. */
export function dayHeading(date: Date, now = new Date()): string {
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKeyOf(date) === dayKeyOf(now)) return "Today";
  if (dayKeyOf(date) === dayKeyOf(yesterday)) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

/** A list row's time: the clock today, the weekday this week, the date otherwise. */
export function rowTime(date: Date | null, now = new Date()): string {
  if (!date) return "";
  if (dayKeyOf(date) === dayKeyOf(now)) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = (startOfDay(now) - startOfDay(date)) / DAY_MS;
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() === now.getFullYear() ? undefined : "2-digit" });
}

/** Full timestamp for a `title` tooltip. */
export function fullTime(date: Date | null): string | undefined {
  return date ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : undefined;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** Today / Yesterday / This week / Earlier — the list's grouping, coarse enough to scan. */
export function recencyBucket(date: Date, now = new Date()): string {
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  return "Earlier";
}

/**
 * Walks rows in order and reports whether each starts a new day, for lists
 * sorted newest-first. Rows without a date never start a group.
 */
export function withDayBreaks<T>(rows: T[], dateOf: (row: T) => Date | null): { row: T; heading: string | null }[] {
  let last: string | null = null;
  const now = new Date();
  return rows.map((row) => {
    const date = dateOf(row);
    if (!date) return { row, heading: null };
    const key = dayKeyOf(date);
    if (key === last) return { row, heading: null };
    last = key;
    return { row, heading: dayHeading(date, now) };
  });
}

/**
 * Like withDayBreaks, in coarse buckets (Today, Yesterday, This week,
 * Earlier). Each heading appears once, so a list that is not strictly
 * newest-first never repeats one.
 */
export function withRecencyBreaks<T>(rows: T[], dateOf: (row: T) => Date | null): { row: T; heading: string | null }[] {
  const seen = new Set<string>();
  const now = new Date();
  return rows.map((row) => {
    const date = dateOf(row);
    if (!date) return { row, heading: null };
    const bucket = recencyBucket(date, now);
    if (seen.has(bucket)) return { row, heading: null };
    seen.add(bucket);
    return { row, heading: bucket };
  });
}
