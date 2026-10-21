"use client";

import { useEffect, useRef, useState } from "react";
import type { ColumnType } from "@/lib/grid/types";
import { COLUMN_TYPE_GROUPS } from "./columnTypes";

/**
 * The "Add column" dropdown, matching Clay's grouping and order.
 *
 * Anchored to its trigger rather than centred as a modal — this is a menu, not
 * a dialog, and the distinction matters for how quickly a column can be added.
 */
export default function AddColumnMenu({
  open,
  onClose,
  onPick,
  anchorRect,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (type: ColumnType) => void;
  anchorRect: DOMRect | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: effect resets/seeds local state when props or open state change; deriving during render would change timing
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;

    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open || !mounted || !anchorRect) return null;

  // Flip upward when the menu would overflow the viewport bottom.
  const MENU_H = 560;
  const openUp = anchorRect.bottom + MENU_H > window.innerHeight;
  const top = openUp ? Math.max(8, anchorRect.top - MENU_H - 4) : anchorRect.bottom + 4;
  const left = Math.min(anchorRect.left, window.innerWidth - 296);

  return (
    <div
      ref={ref}
      style={{ top, left, maxHeight: MENU_H }}
      className="fixed z-50 w-72 overflow-y-auto overscroll-contain rounded-xl border border-stroke-soft-200 bg-bg-white-0 py-1.5 shadow-[0_12px_32px_-8px_rgba(15,23,42,0.18)]"
    >
      {COLUMN_TYPE_GROUPS.map((group, gi) => (
        <div key={gi}>
          {gi > 0 && <div className="my-1.5 h-px bg-bg-weak-50" />}
          {group.map((m) => (
            <button
              key={m.type}
              type="button"
              disabled={!m.available}
              title={m.available ? undefined : "Coming soon — see docs/design/enrichment-plan.md"}
              onClick={() => {
                if (!m.available) return;
                onPick(m.type);
                onClose();
              }}
              className={`flex w-full items-center gap-2.5 px-3 py-[7px] text-left text-[15px] transition ${
                m.available
                  ? "text-text-strong-950 hover:bg-bg-weak-50"
                  : "cursor-not-allowed text-text-disabled-300"
              }`}
            >
              <m.icon
                className={`size-[18px] shrink-0 ${
                  m.available ? "text-text-soft-400" : "text-text-disabled-300"
                }`}
              />
              <span className="truncate">{m.label}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
