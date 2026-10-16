"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { RiArrowRightSLine, RiCornerDownLeftLine, RiSearchLine } from "@remixicon/react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "@/utils/cn";
import type { FeatureState } from "@/lib/features/catalog";
import { paletteItems, type PaletteItem } from "./navConfig";

/**
 * "Search or jump to…": every page, settings screen and create shortcut,
 * filtered as you type. ⌘K / Ctrl+K opens it from anywhere; arrows move,
 * Enter goes, Esc closes.
 */
export function CommandPalette({ open, onOpenChange, features = null }: { open: boolean; onOpenChange: (open: boolean) => void; /** The organization's optional features: their pages are listed only while on. */ features?: FeatureState | null }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const items = useMemo(() => paletteItems(features), [features]);

  const matches = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return items;
    return items.filter((item) => {
      const hay = `${item.label} ${item.group} ${item.keywords ?? ""}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [items, query]);

  const groups = useMemo(() => {
    const map = new Map<string, PaletteItem[]>();
    for (const m of matches) map.set(m.group, [...(map.get(m.group) ?? []), m]);
    return [...map];
  }, [matches]);

  function change(next: boolean) {
    if (!next) {
      setQuery("");
      setIndex(0);
    }
    onOpenChange(next);
  }

  function go(item: PaletteItem | undefined) {
    if (!item) return;
    change(false);
    if (item.external) window.open(item.href, "_blank", "noopener,noreferrer");
    else router.push(item.href);
  }

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  let running = -1;
  return (
    <Dialog.Root open={open} onOpenChange={change}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[12vh] z-50 flex max-h-[70vh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-2xl bg-bg-white-0 shadow-regular-md ring-1 ring-inset ring-stroke-soft-200 focus:outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(i + 1, matches.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
            if (e.key === "Enter") { e.preventDefault(); go(matches[index]); }
          }}
        >
          <Dialog.Title className="sr-only">Search or jump to</Dialog.Title>
          <div className="flex items-center gap-3 border-b border-stroke-soft-200 px-4">
            <RiSearchLine className="size-5 shrink-0 text-text-soft-400" aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
              placeholder="Search pages, settings, actions…"
              aria-label="Search pages, settings and actions"
              aria-controls="command-palette-list"
              aria-activedescendant={matches[index] ? `cp-${index}` : undefined}
              className="h-12 min-w-0 flex-1 bg-transparent text-paragraph-md text-text-strong-950 outline-none placeholder:text-text-soft-400"
            />
            <kbd className="rounded-md bg-bg-weak-50 px-1.5 py-0.5 text-label-xs text-text-soft-400 ring-1 ring-inset ring-stroke-soft-200">Esc</kbd>
          </div>
          <ul ref={listRef} id="command-palette-list" role="listbox" className="flex-1 overflow-y-auto p-2">
            {matches.length === 0 && <li className="px-3 py-10 text-center text-paragraph-sm text-text-sub-600">Nothing matches “{query}”.</li>}
            {groups.map(([group, groupItems]) => (
              <li key={group} role="presentation">
                <p className="px-3 pb-1 pt-2 text-paragraph-xs text-text-soft-400">{group}</p>
                <ul role="presentation">
                  {groupItems.map((item) => {
                    running += 1;
                    const i = running;
                    const Icon = item.icon;
                    const active = i === index;
                    return (
                      <li
                        key={`${item.href}-${item.label}`}
                        id={`cp-${i}`}
                        role="option"
                        aria-selected={active}
                        data-index={i}
                        onMouseMove={() => setIndex(i)}
                        onClick={() => go(item)}
                        className={cn("flex h-10 cursor-pointer items-center gap-3 rounded-lg px-3 text-label-sm", active ? "bg-bg-weak-50 text-text-strong-950" : "text-text-sub-600")}
                      >
                        <Icon className="size-[18px] shrink-0 text-text-soft-400" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {active ? <RiCornerDownLeftLine className="size-4 text-text-soft-400" aria-hidden="true" /> : <RiArrowRightSLine className="size-4 text-text-disabled-300" aria-hidden="true" />}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
