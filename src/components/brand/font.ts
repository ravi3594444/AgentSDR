import { Manrope } from "next/font/google";

/**
 * The brand's display face: Manrope 500–800. It sets the wordmark and the
 * app-tile monogram everywhere (sidebar, auth pages), so the root layout puts
 * its variable on <html>. Loaded the same way as the app's other faces
 * (next/font, self-hosted at build time). The variable keeps its original
 * name (--font-landing-display) so existing references keep working.
 */
export const brandDisplay = Manrope({ subsets: ["latin"], weight: ["500", "600", "700", "800"], variable: "--font-landing-display", display: "swap" });

/** Tailwind classes for text in the display face. */
export const brandDisplayClass = "font-[family-name:var(--font-landing-display)] font-medium";
