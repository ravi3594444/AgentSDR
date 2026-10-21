/** Browser-local appearance choices. Plain white remains the default. */
export const THEMES = {
  golden: { label: "Golden clouds", description: "Sunlit, painted cloudscapes", palette: "light", appearance: "golden-clouds", thumbnail: "/themes/previews/golden-clouds.webp" },
  forest: { label: "Dark forest", description: "Emerald trees and moonlit mist", palette: "dark", appearance: "dark-forest", thumbnail: "/themes/previews/dark-forest.webp" },
  space: { label: "Deep space", description: "Indigo nebulae and distant stars", palette: "dark", appearance: "deep-space", thumbnail: "/themes/previews/deep-space.webp" },
  ocean: { label: "Moonlit ocean", description: "Silver light on midnight waves", palette: "dark", appearance: "moonlit-ocean", thumbnail: "/themes/previews/moonlit-ocean.webp" },
  light: { label: "Light", description: "Clean white canvas · Default", palette: "light", appearance: "plain", thumbnail: null },
  dark: { label: "Pure black", description: "True black, clear contrast", palette: "dark", appearance: "plain", thumbnail: null },
  system: { label: "System", description: "Follows your device", palette: "system", appearance: "plain", thumbnail: null },
} as const;

export type ThemePreference = keyof typeof THEMES;
export type ResolvedTheme = "light" | "dark";
export const DEFAULT_PREFERENCE: ThemePreference = "light";

export function parseThemePreference(value: string | null): ThemePreference {
  return value !== null && Object.prototype.hasOwnProperty.call(THEMES, value) ? value as ThemePreference : DEFAULT_PREFERENCE;
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  const palette = THEMES[preference].palette;
  return palette === "dark" || (palette === "system" && systemDark) ? "dark" : "light";
}

/** What the sidebar's theme button does now, for its accessible name and tooltip: flip a plain palette, or open Appearance for a picture. */
export function themeToggleLabel(preference: ThemePreference, resolved: ResolvedTheme): string {
  return THEMES[preference].thumbnail ? `${THEMES[preference].label} is on. Change the appearance` : `Switch to ${resolved === "dark" ? "light" : "dark"} mode`;
}
