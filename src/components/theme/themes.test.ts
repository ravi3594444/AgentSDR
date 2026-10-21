import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PREFERENCE, parseThemePreference, resolveTheme, themeToggleLabel, THEMES } from "./themes";

const root = join(import.meta.dir, "..", "..", "..");
const css = readFileSync(join(root, "src/app/globals.css"), "utf8");
const landing = readFileSync(join(root, "src/components/landing/landing.css"), "utf8");
const rem = (name: string) => {
  const match = css.match(new RegExp(`--text-${name}: ([0-9.]+)rem;`));
  if (!match) throw new Error(`no --text-${name}`);
  return Number(match[1]) * 16;
};

describe("text size (the owner asked for bigger text)", () => {
  test("shared body and small text are 16 px and 14 px, medium text stays above body text", () => {
    expect([rem("paragraph-sm"), rem("label-sm")]).toEqual([16, 16]);
    expect([rem("paragraph-xs"), rem("label-xs")]).toEqual([14, 14]);
    expect(rem("label-2xs")).toBe(12);
    expect(Math.min(rem("paragraph-md"), rem("label-md"))).toBeGreaterThan(16);
  });

  test("Tailwind's own text-xs, text-sm and text-base follow the same scale", () => {
    expect([rem("xs"), rem("sm"), rem("base")]).toEqual([14, 16, 17]);
  });

  test("no text is set below 10 px: component classes, the app's styles or the landing page's", () => {
    const small: string[] = [];
    for (const file of new Bun.Glob("src/**/*.tsx").scanSync({ cwd: root })) {
      for (const match of readFileSync(join(root, file), "utf8").matchAll(/text-\[(\d+)px\]/g)) if (Number(match[1]) < 10) small.push(`${file}: ${match[0]}`);
    }
    for (const [file, text] of [["globals.css", css], ["landing.css", landing]] as const) {
      for (const match of text.matchAll(/font-size: ?(\d+)px/g)) if (Number(match[1]) < 10) small.push(`${file}: ${match[0]}`);
    }
    expect(small).toEqual([]);
  });
});

describe("stored appearance", () => {
  test("white is the default and unknown or prototype names fall back to it", () => {
    expect(DEFAULT_PREFERENCE).toBe("light");
    for (const value of [null, "", "purple", "Dark", "golden-clouds", "__proto__", "toString", "constructor"]) expect(parseThemePreference(value)).toBe("light");
    for (const key of Object.keys(THEMES)) expect(parseThemePreference(key)).toBe(key as keyof typeof THEMES);
  });

  test("each choice resolves to its control palette", () => {
    expect(resolveTheme("golden", true)).toBe("light");
    for (const key of ["forest", "space", "ocean", "dark"] as const) expect(resolveTheme(key, false)).toBe("dark");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  test("the sidebar button says what it does: flip a plain theme, or open Appearance for a picture", () => {
    expect(themeToggleLabel("light", "light")).toBe("Switch to dark mode");
    expect(themeToggleLabel("dark", "dark")).toBe("Switch to light mode");
    expect(themeToggleLabel("system", "dark")).toBe("Switch to light mode");
    for (const key of ["golden", "forest", "space", "ocean"] as const) expect(themeToggleLabel(key, resolveTheme(key, false))).toBe(`${THEMES[key].label} is on. Change the appearance`);
  });
});

/** Specificity of the simple selectors these rules use: [ids, classes/attributes/pseudo-classes, elements]. */
function specificity(selector: string): [number, number, number] {
  let rest = selector; let b = 0;
  // :not(x) counts as its argument.
  rest = rest.replace(/:not\(([^()]*)\)/g, (_, inner: string) => { const [, ib] = specificity(inner); b += ib; return ""; });
  b += (rest.match(/\[[^\]]+\]/g) ?? []).length; rest = rest.replace(/\[[^\]]+\]/g, "");
  b += (rest.match(/\.[a-z0-9_-]+/gi) ?? []).length + (rest.match(/:(root|hover|focus)\b/g) ?? []).length;
  rest = rest.replace(/\.[a-z0-9_-]+/gi, "").replace(/:[a-z-]+/g, "");
  return [(rest.match(/#/g) ?? []).length, b, (rest.match(/(^|[\s>+~])[a-z]+/g) ?? []).length];
}
const above = (x: number[], y: number[]) => x[0]! !== y[0]! ? x[0]! > y[0]! : x[1]! !== y[1]! ? x[1]! > y[1]! : x[2]! > y[2]!;

describe("illustrated themes", () => {
  const ILLUSTRATED = Object.values(THEMES).filter((theme) => theme.thumbnail);
  const blockOf = (appearance: string) => {
    const match = css.match(new RegExp(`(html\\[data-appearance="${appearance}"\\][^{]*)\\{([^}]+)\\}`));
    if (!match) throw new Error(`no <html> block for ${appearance}`);
    return { selector: match[1]!.trim(), vars: Object.fromEntries([...match[2]!.matchAll(/(--[a-z0-9-]+): ([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()])) as Record<string, string> };
  };
  const channels = (colour: string): [number, number, number, number] => {
    const hex = colour.match(/^#([0-9a-f]{6})$/i);
    if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)).concat(1) as [number, number, number, number];
    const rgb = colour.match(/^rgb\((\d+) (\d+) (\d+) \/ (\d+)%\)$/);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), Number(rgb[4]) / 100];
    throw new Error(`unreadable colour ${colour}`);
  };
  const over = (top: string, under: string): string => {
    const [r, g, b, a] = channels(top); const [R, G, B] = channels(under);
    return "#" + [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  };
  const lum = (colour: string) => {
    const [r, g, b] = channels(colour).slice(0, 3).map((c) => c / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x! + 0.05) / (y! + 0.05); };

  test("their colours are set on <html>, so menus, popovers and dialogs outside the app shell match", () => {
    for (const theme of ILLUSTRATED) {
      expect(blockOf(theme.appearance).vars["--color-bg-white-0"]).toMatch(/^#/);
      expect(css).not.toContain(`html[data-appearance="${theme.appearance}"] .app-workspace {`);
    }
  });

  test("the dark ones outrank the device dark-mode block, so a device in dark mode keeps their colours", () => {
    const media = css.match(/@media \(prefers-color-scheme: dark\) \{\s*([^{]+)\{/);
    expect(media?.[1]?.trim()).toBe(':root:not([data-theme="light"]):not(.light)');
    for (const theme of ILLUSTRATED.filter((t) => t.palette === "dark")) {
      const { selector } = blockOf(theme.appearance);
      expect({ selector, wins: above(specificity(selector), specificity(media![1]!.trim())) }).toEqual({ selector, wins: true });
    }
  });

  test("secondary and hint text keep 4.5:1 on every solid surface", () => {
    for (const theme of ILLUSTRATED) {
      const { vars } = blockOf(theme.appearance);
      for (const text of ["--color-text-sub-600", "--color-text-soft-400"]) {
        for (const surface of ["--color-bg-white-0", "--color-bg-weak-50", "--color-bg-weak-25"]) {
          expect({ theme: theme.appearance, text, surface, ok: ratio(vars[text]!, vars[surface]!) >= 4.5 }).toMatchObject({ ok: true });
        }
        expect({ theme: theme.appearance, text, onSurface: ratio(vars[text]!, over(vars["--workspace-surface"]!, vars["--workspace-art-base"]!)) >= 4.5 }).toMatchObject({ onSurface: true });
      }
    }
  });

  // The artwork pixel at the 1st luminance percentile (darkest, Golden clouds) or the 99th (brightest, the
  // dark themes) of where text sits: the header band and the chat column, desktop cover 1184×900, measured
  // from public/themes/*.webp. The tint is composited over it exactly as the canvas paints it.
  const REFERENCE: Record<string, string> = { "golden-clouds": "#476a9c", "dark-forest": "#959f88", "deep-space": "#636d8a", "moonlit-ocean": "#989997" };
  test("secondary and hint text keep 4.5:1 over the artwork itself, at its darkest (light) or brightest (dark) 1%", () => {
    for (const theme of ILLUSTRATED) {
      const { vars } = blockOf(theme.appearance);
      const canvas = over(vars["--workspace-art-tint"]!, REFERENCE[theme.appearance]!);
      for (const text of ["--color-text-sub-600", "--color-text-soft-400"]) {
        const value = Number(ratio(vars[text]!, canvas).toFixed(2));
        expect({ theme: theme.appearance, text, enough: value >= 4.5, value }).toMatchObject({ enough: true });
      }
    }
  });

  test("sections with dense lists keep a mostly opaque surface over the picture", () => {
    expect(css).toMatch(/\.workspace-surface \{\s*background-color: var\(--workspace-surface\);/);
    for (const theme of ILLUSTRATED) expect(blockOf(theme.appearance).vars["--workspace-surface"]).toMatch(/\/ 88%\)$/);
    for (const file of ["src/app/outreach/layout.tsx", "src/app/linkedin/layout.tsx", "src/app/whatsapp/layout.tsx", "src/app/calling/layout.tsx", "src/app/instagram/layout.tsx", "src/app/tables/page.tsx", "src/components/leads/LeadsClient.tsx"]) {
      expect({ file, surface: /className="workspace-surface[ "]/.test(readFileSync(join(root, file), "utf8")) }).toEqual({ file, surface: true });
    }
  });
});
