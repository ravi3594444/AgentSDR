import { cn } from "@/utils/cn";
import { BRAND } from "@/lib/brand";
import { brandDisplayClass } from "./font";

/**
 * The product logo — the one source for the app chrome and the auth pages.
 * Until a drawn logo exists it is a text wordmark: BRAND.monogram on the app
 * tile, and BRAND.wordmark beside it. The favicon (src/app/icon.svg) and the
 * Apple touch icon (src/app/apple-icon.tsx) draw the same tile; change them
 * together.
 */

/** The icon tile's corner radius. */
export const ICON_RADIUS = "14%";

/**
 * The monogram on a glass app tile. `small` trims the glow for header and
 * footer sizes, where the headline's halo would read as a blur. The letters
 * are SVG text, so they scale with whatever size the tile is given.
 */
export function AppIcon({ className, small = false }: { className?: string; small?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden bg-gradient-to-b from-[#5b7bff] to-[#1f3bad]",
        small
          ? "shadow-[inset_0_1px_0_rgb(255_255_255/0.35),inset_0_0_0_1px_rgb(255_255_255/0.18),0_2px_8px_-2px_rgb(51_92_255/0.55)]"
          : "shadow-[inset_0_1px_0_rgb(255_255_255/0.35),inset_0_0_0_1px_rgb(255_255_255/0.18),0_8px_24px_-6px_rgb(51_92_255/0.8)]",
        className,
      )}
      // A square tile with gently rounded corners, not an app-store squircle.
      style={{ borderRadius: ICON_RADIUS }}
    >
      {/* Soft grid on the icon face, like a glass app tile. */}
      <span className="absolute inset-0 bg-[linear-gradient(rgb(255_255_255/0.08)_1px,transparent_1px),linear-gradient(90deg,rgb(255_255_255/0.08)_1px,transparent_1px)] bg-[size:25%_25%]" />
      <svg viewBox="0 0 32 32" className="relative size-full text-white drop-shadow-[0_1px_1px_rgb(11_10_26/0.35)]">
        <text
          x="16"
          y="16.5"
          textAnchor="middle"
          dominantBaseline="central"
          fill="currentColor"
          fontSize="12"
          fontWeight="800"
          letterSpacing="-0.4"
          style={{ fontFamily: "var(--font-landing-display), ui-sans-serif, system-ui, sans-serif" }}
        >
          {BRAND.monogram}
        </text>
      </svg>
    </span>
  );
}

/**
 * Tile and wordmark together: the mark on top, the suffix beneath it in a
 * quieter weight. The text takes the surrounding colour, so it follows the
 * theme; pass a colour in `className` on fixed backgrounds. `textClassName`
 * sizes the mark; the suffix stays a step smaller.
 */
export function Logo({
  className,
  iconClassName = "size-7",
  textClassName = "text-[16px]",
}: {
  className?: string;
  iconClassName?: string;
  textClassName?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <AppIcon small className={iconClassName} />
      <span className={cn(brandDisplayClass, "flex min-w-0 flex-col leading-none")}>
        <span className={cn("whitespace-nowrap font-bold tracking-[-0.02em]", textClassName)}>{BRAND.wordmark.mark}</span>
        <span className="mt-[3px] whitespace-nowrap text-[10.5px] font-semibold uppercase tracking-[0.14em] opacity-60">{BRAND.wordmark.suffix}</span>
      </span>
    </span>
  );
}
