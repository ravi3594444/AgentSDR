"use client";

import { useId, useState } from "react";
import { RiEyeLine, RiEyeOffLine } from "@remixicon/react";
import { cn } from "@/utils/cn";

/*
 * The auth pages' form pieces. They sit on AuthShell's fixed dark
 * background (auth pages do not follow the app theme), so colours are set
 * here rather than taken from the theme tokens.
 */

export function Spinner() {
  return (
    <svg className="size-4 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

/**
 * A labelled input. `labelAside` sits at the right end of the label row
 * (e.g. "Forgot password?"). A password input gets a show/hide toggle.
 */
export function Field({
  label,
  labelAside,
  hint,
  className,
  type,
  ...props
}: { label: string; labelAside?: React.ReactNode; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const [revealed, setRevealed] = useState(false);
  const isPassword = type === "password";
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-zinc-100">
          {label}
        </label>
        {labelAside && <span className="text-xs">{labelAside}</span>}
      </div>
      <div className="relative">
        <input
          id={id}
          type={isPassword && revealed ? "text" : type}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className={cn(
            "h-11 w-full rounded-lg border border-white/12 bg-white/[0.03] px-3.5 text-sm text-white placeholder:text-zinc-500 transition-colors hover:border-white/20 focus:border-white/30 focus:bg-white/[0.05] focus:outline-none focus:ring-2 focus:ring-white/40",
            isPassword && "pr-11",
            className,
          )}
          {...props}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            aria-label={revealed ? "Hide password" : "Show password"}
            aria-pressed={revealed}
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-zinc-400 transition-colors hover:text-zinc-100 focus-visible:text-zinc-100 focus-visible:outline-none"
          >
            {revealed ? <RiEyeOffLine className="size-[18px]" /> : <RiEyeLine className="size-[18px]" />}
          </button>
        )}
      </div>
      {hint && (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-zinc-500">
          {hint}
        </p>
      )}
    </div>
  );
}

export function ErrorCallout({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-sm text-red-300">
      {children}
    </div>
  );
}

export function InfoCallout({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" className="rounded-lg border border-white/20 bg-white/5 px-3 py-2.5 text-sm text-zinc-200">
      {children}
    </div>
  );
}

/** The form's primary action: a light button on the dark page. */
export function SubmitButton({
  loading,
  loadingLabel,
  children,
  disabled,
}: {
  loading: boolean;
  loadingLabel: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="submit"
      disabled={loading || disabled}
      className="h-11 w-full rounded-lg bg-zinc-100 text-sm font-medium text-zinc-950 shadow-[inset_0_-1px_0_rgb(0_0_0/0.12)] transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-not-allowed disabled:opacity-60"
    >
      {loading ? (
        <span className="flex items-center justify-center gap-2">
          <Spinner />
          {loadingLabel}
        </span>
      ) : (
        children
      )}
    </button>
  );
}

export function SecondaryButton({
  loading,
  className,
  children,
  ...props
}: { loading?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      disabled={loading || props.disabled}
      className={cn(
        "flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-white/12 bg-white/[0.03] text-sm font-medium text-zinc-100 transition-colors hover:border-white/20 hover:bg-white/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

/** Quiet inline links ("Forgot password?") and footer actions ("Create one"). */
export const linkClass = "font-medium text-zinc-100 underline-offset-4 transition-colors hover:text-white hover:underline";
export const quietLinkClass = "text-zinc-400 underline-offset-4 transition-colors hover:text-zinc-100 hover:underline";
