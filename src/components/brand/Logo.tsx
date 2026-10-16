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
 * The monogram on a black tile. A fine border keeps it visible on both
 * themes. The SVG lettering scales with the tile.
 */
export function AppIcon({ className, small = false }: { className?: string; small?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden border border-white/20 bg-black",
        small
          ? "shadow-none"
          : "shadow-[0_8px_20px_-10px_rgb(0_0_0/0.3)]",
        className,
      )}
      // A square tile with gently rounded corners, not an app-store squircle.
      style={{ borderRadius: ICON_RADIUS }}
    >
      <svg viewBox="0 0 32 32" className="relative size-full text-white">
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
