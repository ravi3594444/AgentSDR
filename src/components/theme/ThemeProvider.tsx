"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { DEFAULT_PREFERENCE, parseThemePreference, resolveTheme, THEMES, type ResolvedTheme, type ThemePreference } from "./themes";

export type { ResolvedTheme, ThemePreference } from "./themes";

/**
 * Plain palettes and illustrated workspace themes, remembered per browser.
 *
 * The AlignUI token layer (globals.css) already carries a full dark palette
 * under `.dark`; switching themes is toggling that class on <html> (plus
 * data-theme and color-scheme, so native controls and the OS-preference
 * block agree). THEME_INIT_SCRIPT runs in <head> before first paint so a
 * dark page never flashes light; this provider then keeps it in sync.
 * Each artwork uses a light or dark control palette and a separate appearance
 * attribute; components that resolve only light/dark keep their contract.
 */

export const THEME_STORAGE_KEY = "agentsdr-theme";

/** Inlined into <head> by the root layout. Keep it dependency-free and tiny. */
export const THEME_INIT_SCRIPT = `(function(){var p="${DEFAULT_PREFERENCE}",t=${JSON.stringify(THEMES)};try{p=localStorage.getItem("${THEME_STORAGE_KEY}")||p;}catch(_){}if(!Object.prototype.hasOwnProperty.call(t,p))p="${DEFAULT_PREFERENCE}";var d=t[p].palette==="dark"||(p==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);var e=document.documentElement;e.classList.toggle("dark",d);e.setAttribute("data-theme",d?"dark":"light");e.setAttribute("data-appearance",t[p].appearance);e.style.colorScheme=d?"dark":"light";})();`;

function readPreference(): ThemePreference {
  try {
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

function subscribeToSystem(onChange: () => void) {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const systemIsDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

function apply(theme: ResolvedTheme, preference: ThemePreference) {
  const el = document.documentElement;
  el.classList.toggle("dark", theme === "dark");
  el.setAttribute("data-theme", theme);
  el.setAttribute("data-appearance", THEMES[preference].appearance);
  el.style.colorScheme = theme;
}

type ThemeContextValue = {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // The server can't read localStorage: null until the stored choice is read after mount. Until
  // then the class set by THEME_INIT_SCRIPT stands, so a dark page doesn't flash light.
  const [stored, setPreferenceState] = useState<ThemePreference | null>(null);
  const preference = stored ?? DEFAULT_PREFERENCE;
  const dark = useSyncExternalStore(subscribeToSystem, systemIsDark, () => false);
  const resolved = resolveTheme(preference, dark);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setPreferenceState(readPreference()));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (stored !== null) apply(resolved, preference);
  }, [stored, resolved, preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Blocked storage: the choice holds for this visit only.
    }
  }, []);

  const value = useMemo(() => ({ preference, resolved, setPreference }), [preference, resolved, setPreference]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}
