"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useRef } from "react";
import Select from "./ui/Select";
import CategoryFilter from "./CategoryFilter";
import AppFilter from "./AppFilter";
import { useNavigation } from "./NavigationProvider";

const COUNTRY_OPTIONS = [
  { value: "US", label: "🇺🇸 United States" },
  { value: "GB", label: "🇬🇧 United Kingdom" },
  { value: "CA", label: "🇨🇦 Canada" },
  { value: "AU", label: "🇦🇺 Australia" },
  { value: "IN", label: "🇮🇳 India" },
  { value: "DE", label: "🇩🇪 Germany" },
  { value: "FR", label: "🇫🇷 France" },
  { value: "NL", label: "🇳🇱 Netherlands" },
  { value: "BR", label: "🇧🇷 Brazil" },
  { value: "MX", label: "🇲🇽 Mexico" },
  { value: "SG", label: "🇸🇬 Singapore" },
  { value: "NZ", label: "🇳🇿 New Zealand" },
  { value: "SE", label: "🇸🇪 Sweden" },
  { value: "NO", label: "🇳🇴 Norway" },
  { value: "DK", label: "🇩🇰 Denmark" },
];

const PLATFORM_OPTIONS = [
  { value: "", label: "All Platforms" },
  { value: "Shopify", label: "Shopify" },
  { value: "WooCommerce", label: "WooCommerce" },
  { value: "BigCommerce", label: "BigCommerce" },
  { value: "Magento", label: "Magento" },
  { value: "Wix", label: "Wix" },
  { value: "Squarespace", label: "Squarespace" },
];

const SORT_OPTIONS = [
  { value: "annualSales", label: "Annual Sales" },
  { value: "rank", label: "Rank" },
  { value: "domain", label: "Default ⚡" },
];

const DIR_OPTIONS = [
  { value: "desc", label: "↓ Desc" },
  { value: "asc", label: "↑ Asc" },
];

const PAGE_SIZE_OPTIONS = [
  { value: "10", label: "10 rows" },
  { value: "20", label: "20 rows" },
  { value: "50", label: "50 rows" },
];

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="text-[12px] font-bold text-text-strong-950/70 uppercase tracking-widest">
      {children}
    </label>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      {children}
    </div>
  );
}

export default function Filters() {
  const { navigate, isPending } = useNavigation();
  const searchParams = useSearchParams();
  const minRef = useRef<HTMLInputElement>(null);
  const maxRef = useRef<HTMLInputElement>(null);

  const get = (key: string, fallback = "") => searchParams.get(key) ?? fallback;

  const update = useCallback(
    (updates: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, val] of Object.entries(updates)) {
        if (val) params.set(key, val);
        else params.delete(key);
      }
      params.set("page", "1");
      navigate(`?${params.toString()}`);
    },
    [navigate, searchParams]
  );

  const handleTextInput = (key: string, ref: React.RefObject<HTMLInputElement | null>) =>
    (e: React.KeyboardEvent | React.FocusEvent) => {
      if ("key" in e && e.key !== "Enter") return;
      update({ [key]: ref.current?.value ?? "" });
    };

  return (
    <div className="flex flex-col gap-5 px-4 py-4">

      <Section>
        <Label>Country</Label>
        <Select
          value={get("countryCode", "US")}
          onChange={(v) => update({ countryCode: v })}
          options={COUNTRY_OPTIONS}
          variant="primary"
        />
      </Section>

      <div className="h-px bg-bg-weak-50" />

      <Section>
        <Label>Category</Label>
        <CategoryFilter
          countryCode={get("countryCode", "US")}
          c1={get("c1")}
          c2={get("c2")}
          c3={get("c3")}
          onChange={update}
        />
      </Section>

      <div className="h-px bg-bg-weak-50" />

      <Section>
        <Label>App</Label>
        <AppFilter
          value={get("app")}
          onChange={(v) => update({ app: v })}
        />
      </Section>

      <div className="h-px bg-bg-weak-50" />

      <Section>
        <Label>Platform</Label>
        <Select
          value={get("platform")}
          onChange={(v) => update({ platform: v })}
          options={PLATFORM_OPTIONS}
        />
      </Section>

      <Section>
        <Label>Revenue Range ($)</Label>
        <div className="flex items-center gap-1.5">
          <input
            ref={minRef}
            type="number"
            placeholder="Min"
            defaultValue={get("minRevenue")}
            // eslint-disable-next-line react-hooks/refs -- intentional: ref read/written during render to expose the latest value to event handlers
            onKeyDown={handleTextInput("minRevenue", minRef)}
            // eslint-disable-next-line react-hooks/refs -- intentional: ref read/written during render to expose the latest value to event handlers
            onBlur={handleTextInput("minRevenue", minRef)}
            className="w-full h-10 border border-stroke-soft-200 rounded-lg px-3 text-sm text-text-strong-950 placeholder-text-soft-400 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent"
          />
          <span className="text-text-strong-950/30 text-sm shrink-0">–</span>
          <input
            ref={maxRef}
            type="number"
            placeholder="Max"
            defaultValue={get("maxRevenue")}
            // eslint-disable-next-line react-hooks/refs -- intentional: ref read/written during render to expose the latest value to event handlers
            onKeyDown={handleTextInput("maxRevenue", maxRef)}
            // eslint-disable-next-line react-hooks/refs -- intentional: ref read/written during render to expose the latest value to event handlers
            onBlur={handleTextInput("maxRevenue", maxRef)}
            className="w-full h-10 border border-stroke-soft-200 rounded-lg px-3 text-sm text-text-strong-950 placeholder-text-soft-400 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent"
          />
        </div>
      </Section>

      <div className="h-px bg-bg-weak-50" />

      <Section>
        <Label>Sort</Label>
        <Select
          value={get("sortBy", "annualSales")}
          onChange={(v) => update({ sortBy: v })}
          options={SORT_OPTIONS}
        />
        <Select
          value={get("sortDir", "desc")}
          onChange={(v) => update({ sortDir: v })}
          options={DIR_OPTIONS}
        />
      </Section>

      <Section>
        <Label>Per Page</Label>
        <Select
          value={get("pageSize", "20")}
          onChange={(v) => update({ pageSize: v })}
          options={PAGE_SIZE_OPTIONS}
        />
      </Section>

      <div className="flex items-center gap-2">
        <button
          onClick={() => navigate("?countryCode=US&sortBy=annualSales&sortDir=desc&pageSize=20")}
          className="flex-1 h-9 text-sm text-text-strong-950/70 border border-stroke-soft-200 rounded-lg hover:bg-bg-weak-50 hover:text-text-strong-950 transition-colors"
        >
          Reset
        </button>
        {isPending && (
          <div className="w-4 h-4 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin shrink-0" />
        )}
      </div>

    </div>
  );
}
