import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PREFERENCE, parseThemePreference, resolveTheme, THEMES } from "./themes";

const root = join(import.meta.dir, "..", "..", "..");
const css = readFileSync(join(root, "src/app/globals.css"), "utf8");
const px = (name: string) => {
  const match = css.match(new RegExp(`--text-${name}: ([0-9.]+)rem;`));
  if (!match) throw new Error(`no --text-${name}`);
  return Number(match[1]) * 16;
};

describe("text size (the owner asked for bigger text)", () => {
  test("shared body and small text are 16 px and 14 px, medium text stays above body text", () => {
    expect([px("paragraph-sm"), px("label-sm")]).toEqual([16, 16]);
    expect([px("paragraph-xs"), px("label-xs")]).toEqual([14, 14]);
    expect(px("label-2xs")).toBe(12);
    expect(Math.min(px("paragraph-md"), px("label-md"))).toBeGreaterThan(16);
  });

  test("no fixed-pixel text class is smaller than 10 px", () => {
    const files = new Bun.Glob("src/**/*.tsx").scanSync({ cwd: root });
    const small: string[] = [];
    for (const file of files) {
      for (const match of readFileSync(join(root, file), "utf8").matchAll(/text-\[(\d+)px\]/g)) {
        if (Number(match[1]) < 10) small.push(`${file}: ${match[0]}`);
      }
    }
    expect(small).toEqual([]);
  });
});

describe("stored appearance", () => {
  test("white is the default and unknown or prototype names fall back to it", () => {
    expect(DEFAULT_PREFERENCE).toBe("light");
    for (const value of [null, "", "purple", "Dark", "golden-clouds", "__proto__", "toString", "constructor"]) {
      expect(parseThemePreference(value)).toBe("light");
    }
    for (const key of Object.keys(THEMES)) expect(parseThemePreference(key)).toBe(key as keyof typeof THEMES);
  });

  test("each choice resolves to its control palette", () => {
    expect(resolveTheme("golden", true)).toBe("light");
    for (const key of ["forest", "space", "ocean", "dark"] as const) expect(resolveTheme(key, false)).toBe("dark");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("illustrated themes", () => {
  const block = (appearance: string) => {
    const match = css.match(new RegExp(`html\\[data-appearance="${appearance}"\\] \\{([^}]+)\\}`));
    if (!match) throw new Error(`no <html> block for ${appearance}`);
    const vars = Object.fromEntries([...match[1]!.matchAll(/(--[a-z0-9-]+): ([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
    return vars as Record<string, string>;
  };
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x! + 0.05) / (y! + 0.05); };

  test("their colours are set on <html>, so menus, popovers and dialogs outside the app shell match", () => {
    for (const appearance of Object.values(THEMES).map((theme) => theme.appearance).filter((name) => name !== "plain")) {
      expect(block(appearance)["--color-bg-white-0"]).toMatch(/^#/);
      expect(css).not.toContain(`html[data-appearance="${appearance}"] .app-workspace {`);
    }
  });

  test("secondary and hint text keep 4.5:1 on the solid surfaces of every illustrated theme", () => {
    for (const appearance of ["golden-clouds", "dark-forest", "deep-space", "moonlit-ocean"]) {
      const vars = block(appearance);
      for (const text of ["--color-text-sub-600", "--color-text-soft-400"]) {
        for (const surface of ["--color-bg-white-0", "--color-bg-weak-50", "--color-bg-weak-25"]) {
          expect({ appearance, text, surface, ratio: Number(ratio(vars[text]!, vars[surface]!).toFixed(2)) }).toMatchObject({ ratio: expect.any(Number) });
          expect(ratio(vars[text]!, vars[surface]!)).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  test("sections with dense lists keep a mostly opaque surface over the picture", () => {
    expect(css).toMatch(/\.workspace-surface \{\s*background-color: color-mix\(in srgb, var\(--color-bg-white-0\) 88%, transparent\);/);
    for (const file of ["src/app/outreach/layout.tsx", "src/app/linkedin/layout.tsx", "src/app/whatsapp/layout.tsx", "src/app/calling/layout.tsx", "src/app/instagram/layout.tsx", "src/app/tables/page.tsx", "src/components/leads/LeadsClient.tsx"]) {
      expect({ file, surface: readFileSync(join(root, file), "utf8").includes("workspace-surface") }).toEqual({ file, surface: true });
    }
  });
});
