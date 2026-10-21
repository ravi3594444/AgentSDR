"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { getSearchRemainingTier } from "@/lib/linkedin/searchLeadLimit";

function limitRingClass(remaining: number): string {
  const tier = getSearchRemainingTier(remaining);
  if (tier === "green") return "ring-2 ring-emerald-500";
  if (tier === "red") return "ring-2 ring-red-500";
  return "ring-2 ring-amber-400";
}

export type FilterSelectOption = {
  value: string;
  label: string;
  sublabel?: string;
  avatarUrl?: string | null;
  remainingCount?: number;
};

type FilterSelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: FilterSelectOption[];
  placeholder: string;
  clearLabel?: string;
  showAvatars?: boolean;
  showLimitBadges?: boolean;
  allowClear?: boolean;
  compact?: boolean;
  disabled?: boolean;
  className?: string;
};

function OptionAvatar({
  src,
  name,
  size = "sm",
  remainingCount,
}: {
  src?: string | null;
  name: string;
  size?: "sm" | "md";
  remainingCount?: number;
}) {
  const [err, setErr] = useState(false);
  const cls = size === "sm" ? "h-6 w-6 text-[12px]" : "h-7 w-7 text-xs";
  const initials = name
    .split(/[\s/@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  const ringClass =
    remainingCount !== undefined ? limitRingClass(remainingCount) : "";
  const title =
    remainingCount !== undefined ? `${remainingCount} searches left today` : undefined;

  const inner =
    src && !err ? (
      <img
        src={src}
        alt={name}
        className="h-full w-full rounded-full bg-bg-weak-50 object-cover"
        onError={() => setErr(true)}
      />
    ) : (
      <span className="flex h-full w-full items-center justify-center rounded-full bg-primary-lighter font-semibold text-primary-base">
        {initials || "?"}
      </span>
    );

  return (
    <span
      className={`relative shrink-0 rounded-full overflow-hidden ${cls} ${ringClass}`}
      title={title}
    >
      {inner}
    </span>
  );
}

export function FilterSelect({
  value,
  onChange,
  options,
  placeholder,
  clearLabel = "All",
  showAvatars = false,
  showLimitBadges = false,
  allowClear = true,
  compact = false,
  disabled = false,
  className = "",
}: FilterSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The menu is portalled to <body>: an absolutely positioned child is still
  // clipped by any ancestor with overflow:hidden, and these selects sit inside
  // scroll panels that have it. z-index cannot rescue a clipped box.
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number } | null>(null);

  const place = useCallback(() => {
    const trigger = rootRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.max(rect.width, 224);
    // Flip to the left when a wider menu would run past the viewport edge.
    const left = Math.min(rect.left, Math.max(8, window.innerWidth - width - 8));
    setAnchor({ top: rect.bottom + 6, left, width });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    window.addEventListener("resize", place);
    // Capture phase so scrolling any ancestor panel keeps the menu attached.
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  const selected = options.find((o) => o.value === value);
  const showPlaceholder = allowClear ? !value : !selected;

  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  const optionRowClass = (active: boolean) =>
    `flex w-full items-center gap-2.5 px-3 py-2 text-left text-paragraph-sm transition-colors ${
      active ? "bg-primary-lighter text-primary-base" : "text-text-sub-600 hover:bg-bg-weak-50"
    }`;

  const triggerPad = compact ? "py-2" : "py-2.5";

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        className={`flex w-full items-center gap-2 rounded-lg bg-bg-white-0 px-3 pr-9 text-left text-paragraph-sm shadow-regular-xs ring-1 ring-inset outline-none transition disabled:cursor-not-allowed disabled:opacity-60 ${triggerPad} ${
          open ? "ring-stroke-strong-950 shadow-button-important-focus" : "ring-stroke-soft-200 hover:bg-bg-weak-50"
        }`}
      >
        {showAvatars && selected && (
          <OptionAvatar
            src={selected.avatarUrl}
            name={selected.label}
            size="md"
            remainingCount={showLimitBadges ? selected.remainingCount : undefined}
          />
        )}
        <span className={`flex-1 truncate ${showPlaceholder ? "text-text-soft-400" : "font-medium text-text-strong-950"}`}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown
          className={`pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-text-soft-400 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && !disabled && anchor && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          style={{ top: anchor.top, left: anchor.left, width: anchor.width }}
          className="fixed z-[60] max-h-72 overflow-y-auto rounded-xl bg-bg-white-0 py-1 shadow-regular-lg ring-1 ring-inset ring-stroke-soft-200"
        >
          {allowClear && (
            <>
              <button type="button" onClick={() => pick("")} className={optionRowClass(!value)}>
                <span className={`flex-1 truncate ${!value ? "font-medium" : ""}`}>{clearLabel}</span>
                {!value && <Check className="size-4 shrink-0 text-primary-base" />}
              </button>
              <div className="my-1 border-t border-stroke-soft-200" />
            </>
          )}

          {options.length === 0 ? (
            <p className="px-3 py-2 text-paragraph-sm text-text-soft-400">No options</p>
          ) : (
            options.map((opt) => {
              const active = value === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => pick(opt.value)}
                  className={optionRowClass(active)}
                >
                  {showAvatars && (
                    <OptionAvatar
                      src={opt.avatarUrl}
                      name={opt.label}
                      remainingCount={showLimitBadges ? opt.remainingCount : undefined}
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate ${active ? "font-medium" : ""}`}>{opt.label}</span>
                    {opt.sublabel && (
                      <span className="block truncate text-paragraph-xs text-text-soft-400">{opt.sublabel}</span>
                    )}
                  </span>
                  {active && <Check className="size-4 shrink-0 text-primary-base" />}
                </button>
              );
            })
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
