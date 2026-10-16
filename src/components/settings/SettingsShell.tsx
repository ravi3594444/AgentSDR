"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { RiCloseLine, RiSettings3Line } from "@remixicon/react";
import * as Modal from "@/components/alignui/modal";
import { cn } from "@/utils/cn";
import type { FeatureState } from "@/lib/features/catalog";
import { itemPages, visibleSettingsNav, type SettingsTab } from "./settingsNav";

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The organization's optional features, read once per settings box: rows
 * tied to a feature (settingsNav.ts) appear only while it is on. Until the
 * answer arrives — or if it fails — they stay hidden.
 */
function useFeatureState(): FeatureState | null {
  const [features, setFeatures] = useState<FeatureState | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/features", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { features?: FeatureState } | null) => {
        if (!cancelled && body?.features) setFeatures(body.features);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return features;
}

/** The same row shapes the app sidebar uses, so Settings reads as part of it. */
const rowBase =
  "flex w-full items-center gap-2.5 rounded-lg text-label-sm outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-primary-base";
const rowState = (active: boolean) =>
  active ? "bg-bg-weak-50 text-text-strong-950" : "text-text-sub-600 hover:bg-bg-weak-50 hover:text-text-strong-950";

/**
 * A channel's pages as underline tabs across the top of the section — the
 * look of PageTabs, as links. In the pop-up they replace the history entry
 * like the rail does, and leave room for the close button.
 */
function SectionTabs({ tabs, activeHref, modal, label }: { tabs: SettingsTab[]; activeHref: string; modal: boolean; label: string }) {
  return (
    <nav aria-label={`${label} pages`} className={cn("shrink-0 border-b border-stroke-soft-200 px-4 sm:px-6 lg:px-8 lg:pt-3", modal && "lg:pr-16")}>
      <div className="-mb-px flex gap-5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map(({ href, label: tabLabel, icon: Icon }) => {
          const active = href === activeHref;
          return (
            <Link
              key={href}
              href={href}
              replace={modal}
              scroll={false}
              aria-current={active ? "page" : undefined}
              className={cn("relative flex h-11 shrink-0 items-center gap-2 text-label-sm outline-none transition-colors focus-visible:text-text-strong-950", active ? "text-text-strong-950" : "text-text-sub-600 hover:text-text-strong-950")}
            >
              <Icon className={cn("size-[18px] shrink-0", active ? "text-text-strong-950" : "text-text-soft-400")} aria-hidden="true" />
              {tabLabel}
              <span className={cn("absolute inset-x-0 bottom-0 h-0.5 rounded-full", active ? "bg-primary-base" : "bg-transparent")} aria-hidden="true" />
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

function CloseButton({ className }: { className?: string }) {
  return (
    <Modal.Close
      aria-label="Close settings"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg text-text-soft-400 outline-none transition hover:bg-bg-weak-50 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-primary-base",
        className,
      )}
    >
      <RiCloseLine className="size-5" aria-hidden="true" />
    </Modal.Close>
  );
}

/**
 * The settings box. On wide screens: a rail on the left (title, then the
 * sections under their group labels, like the app sidebar) and the section
 * on the right, scrolling on its own. Narrow screens get a top bar and a
 * scrollable strip of sections instead of the rail.
 *
 * `modal` is the pop-up opened over the current page (src/app/@modal). There,
 * moving between sections replaces the history entry rather than adding one,
 * so a single Back — which is what Close does — returns to the page beneath.
 */
function SettingsFrame({ children, modal }: { children: React.ReactNode; modal: boolean }) {
  const pathname = usePathname();
  const features = useFeatureState();
  const nav = useMemo(() => visibleSettingsNav(features), [features]);
  const items = useMemo(() => nav.flatMap((group) => group.items), [nav]);
  // A row is active on any of its pages; with tabs, the page is one of them.
  const activeItem = items.find((item) => itemPages(item).some((page) => isActive(pathname, page.href)));
  const activeHref = activeItem?.href ?? "";
  const activePage = activeItem ? itemPages(activeItem).find((page) => isActive(pathname, page.href))?.href ?? "" : "";
  const Title = modal ? Modal.Title : "h1";
  const Description = modal ? Modal.Description : "p";
  const stripRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the active section visible in the narrow-screen strip, and start each
  // section at its top rather than where the previous one was scrolled to.
  useEffect(() => {
    const active = stripRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    const strip = stripRef.current;
    if (active && strip) strip.scrollLeft = active.offsetLeft - strip.clientWidth / 2 + active.clientWidth / 2;
    scrollRef.current?.scrollTo({ top: 0 });
  }, [activeHref, activePage]);

  return (
    <div data-modal={modal ? "" : undefined} className="group/settings flex h-full min-h-0 flex-col lg:flex-row">
      {/* Wide screens: the rail. */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-stroke-soft-200 lg:flex">
        <div className="flex items-center gap-2.5 px-5 pb-4 pt-5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-bg-weak-50 ring-1 ring-inset ring-stroke-soft-200">
            <RiSettings3Line className="size-4 text-text-sub-600" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <Title className="text-label-md text-text-strong-950">Settings</Title>
            <Description className="sr-only">Connected accounts, AI, CRM and your preferences.</Description>
          </div>
        </div>
        <nav aria-label="Settings sections" className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          {nav.map((group, index) => (
            <div key={group.label} className={cn(index > 0 && "mt-4")}>
              <p className="mb-1 px-2 text-paragraph-xs text-text-soft-400">{group.label}</p>
              <ul className="space-y-0.5">
                {group.items.map(({ href, label, icon: Icon }) => {
                  const active = href === activeHref;
                  return (
                    <li key={href}>
                      <Link
                        href={href}
                        replace={modal}
                        scroll={false}
                        aria-current={active ? "page" : undefined}
                        className={cn(rowBase, rowState(active), "h-9 px-2")}
                      >
                        <Icon className={cn("size-[18px] shrink-0", active ? "text-text-strong-950" : "text-text-soft-400")} aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      {/* Narrow screens: a top bar and a strip of sections. */}
      <div className="shrink-0 border-b border-stroke-soft-200 lg:hidden">
        <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <RiSettings3Line className="size-5 shrink-0 text-text-soft-400" aria-hidden="true" />
            {/* The rail's title is hidden here; one Title per dialog is enough for screen readers. */}
            <p className="text-label-md text-text-strong-950" aria-hidden="true">Settings</p>
          </div>
          {modal && <CloseButton />}
        </div>
        <nav aria-label="Settings sections">
          <div
            ref={stripRef}
            className="flex gap-1 overflow-x-auto px-3 pb-2.5 sm:px-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {items.map(({ href, label, icon: Icon }) => {
              const active = href === activeHref;
              return (
                <Link
                  key={href}
                  href={href}
                  replace={modal}
                  scroll={false}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-label-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary-base",
                    active
                      ? "bg-bg-white-0 text-text-strong-950 shadow-regular-xs ring-1 ring-inset ring-stroke-soft-200"
                      : "text-text-sub-600 hover:bg-bg-weak-50 hover:text-text-strong-950",
                  )}
                >
                  <Icon className={cn("size-4 shrink-0", active ? "text-text-strong-950" : "text-text-soft-400")} aria-hidden="true" />
                  {label}
                </Link>
              );
            })}
          </div>
        </nav>
      </div>

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {modal && <CloseButton className="absolute right-4 top-4 z-10 hidden lg:flex" />}
        {activeItem?.tabs && <SectionTabs tabs={activeItem.tabs} activeHref={activePage} modal={modal} label={activeItem.label} />}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  );
}

/** /settings opened directly (a pasted link, a hosted-auth return): the box fills the page. */
export function SettingsShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-hidden bg-bg-weak-50 sm:p-4 lg:p-6">
      <div className="mx-auto h-full max-w-[1200px] overflow-hidden bg-bg-white-0 sm:rounded-2xl sm:shadow-regular-sm sm:ring-1 sm:ring-inset sm:ring-stroke-soft-200">
        <SettingsFrame modal={false}>{children}</SettingsFrame>
      </div>
    </div>
  );
}

/** /settings reached by a link inside the app: the same box as a pop-up over that page. */
export function SettingsModal({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  return (
    <Modal.Root open onOpenChange={(open) => { if (!open) router.back(); }}>
      <Modal.Content
        hideClose
        size="max-w-[1200px]"
        className={cn(
          "max-h-none overflow-hidden",
          // Phones: a full-screen sheet. From sm: a centred box.
          "max-sm:inset-0 max-sm:h-dvh max-sm:w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:ring-0",
          "sm:h-[min(880px,calc(100dvh-4rem))]",
        )}
      >
        <SettingsFrame modal>{children}</SettingsFrame>
      </Modal.Content>
    </Modal.Root>
  );
}
