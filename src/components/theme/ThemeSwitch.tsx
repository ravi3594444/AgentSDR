"use client";

import { useId } from "react";
import { RiCheckLine, RiComputerLine, RiMoonLine, RiSunLine } from "@remixicon/react";
import { cn } from "@/utils/cn";
import { useTheme, type ThemePreference } from "./ThemeProvider";

const OPTIONS: Array<{ value: ThemePreference; label: string; description: string; icon: typeof RiSunLine }> = [
  { value: "light", label: "Light", description: "A clean white canvas", icon: RiSunLine },
  { value: "dark", label: "Pure black", description: "True black, clear contrast", icon: RiMoonLine },
  { value: "system", label: "System", description: "Follows your device", icon: RiComputerLine },
];

/** A small layout preview, always in its own colours, regardless of the selected theme. */
function ThemePreview({ theme }: { theme: ThemePreference }) {
  const dark = theme === "dark";
  return (
    <div aria-hidden="true" className={cn("relative flex h-24 overflow-hidden rounded-lg border p-2", dark ? "border-neutral-800 bg-black" : "border-neutral-200 bg-white")}>
      <div className={cn("flex w-1/4 flex-col gap-2 border-r pr-2", dark ? "border-neutral-800" : "border-neutral-200")}>
        <div className={cn("mb-1 size-3 rounded-sm", dark ? "bg-white" : "bg-black")} />
        {[0, 1, 2].map((line) => <span key={line} className={cn("h-1 rounded-full", dark ? "bg-neutral-700" : "bg-neutral-200")} />)}
      </div>
      <div className="flex flex-1 flex-col gap-2 pl-2">
        <div className={cn("mt-1 h-1.5 w-2/3 rounded-full", dark ? "bg-neutral-300" : "bg-neutral-800")} />
        <div className="mt-1 grid flex-1 grid-cols-2 gap-1.5">{[0, 1].map((card) => <span key={card} className={cn("rounded border", dark ? "border-neutral-800 bg-neutral-950" : "border-neutral-200 bg-neutral-50")} />)}</div>
        <span className={cn("h-1 w-4/5 rounded-full", dark ? "bg-neutral-800" : "bg-neutral-200")} />
      </div>
      {theme === "system" && <div className="pointer-events-none absolute inset-y-0 right-0 w-1/2 bg-white mix-blend-difference" />}
    </div>
  );
}

/** Native radios provide arrow-key navigation in both the compact and visual variants. */
export function ThemeSwitch({ className, variant = "compact" }: { className?: string; variant?: "compact" | "cards" }) {
  const { preference, setPreference } = useTheme();
  const name = useId();
  const cards = variant === "cards";
  return (
    <fieldset className={cn(cards ? "grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3" : "flex min-w-0 gap-0.5 rounded-lg bg-bg-weak-50 p-0.5 ring-1 ring-inset ring-stroke-soft-200", className)}>
      <legend className="sr-only">Colour theme</legend>
      {OPTIONS.map(({ value, label, description, icon: Icon }) => (
        <label key={value} className="relative min-w-0 flex-1 cursor-pointer">
          <input type="radio" name={name} value={value} checked={preference === value} onChange={() => setPreference(value)} className="peer sr-only" />
          <span className={cn(
            "block transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-primary-base",
            cards ? "h-full rounded-xl border border-stroke-soft-200 p-3 hover:border-stroke-sub-300 peer-checked:border-primary-base peer-checked:ring-1 peer-checked:ring-primary-base" : "rounded-md px-2 py-1.5 text-label-xs text-text-sub-600 peer-checked:bg-bg-strong-950 peer-checked:text-text-white-0",
          )}>
            {cards && <ThemePreview theme={value} />}
            <span className={cn("flex items-center gap-1.5", cards ? "mt-3 text-label-sm" : "justify-center")}>
              <Icon className="size-3.5 shrink-0" aria-hidden="true" />{cards ? label : value === "dark" ? "Dark" : label}
              {cards && <span className={cn("ml-auto flex size-4 items-center justify-center rounded-full border", preference === value ? "border-primary-base bg-primary-base text-primary-contrast" : "border-stroke-sub-300")} aria-hidden="true">{preference === value && <RiCheckLine className="size-3" />}</span>}
            </span>
            {cards && <span className="mt-1 block text-[11px] leading-relaxed text-text-sub-600">{description}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** Flip away from the currently displayed theme. */
export function ThemeToggleButton({ className }: { className?: string }) {
  const { resolved, setPreference } = useTheme();
  const next = resolved === "dark" ? "light" : "dark";
  const Icon = resolved === "dark" ? RiSunLine : RiMoonLine;
  return (
    <button type="button" onClick={() => setPreference(next)} aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`}
      className={cn("flex size-8 items-center justify-center rounded-lg text-text-sub-600 outline-none transition hover:bg-bg-weak-50 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-primary-base", className)}>
      <Icon className="size-[18px]" aria-hidden="true" />
    </button>
  );
}
