"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Select from "../ui/Select";
import CategoryFilter from "../CategoryFilter";
import AppFilter from "../AppFilter";

const MODE_OPTIONS = [
  { value: "filters", label: "From filters" },
  { value: "manual", label: "Manual domain list" },
];

const TARGET_MODE_OPTIONS = [
  { value: "leads", label: "Number of leads" },
  { value: "domains", label: "Top N domains" },
];

const COUNTRY_OPTIONS = [
  { value: "US", label: "🇺🇸 United States" },
  { value: "GB", label: "🇬🇧 United Kingdom" },
  { value: "CA", label: "🇨🇦 Canada" },
  { value: "AU", label: "🇦🇺 Australia" },
  { value: "IN", label: "🇮🇳 India" },
  { value: "DE", label: "🇩🇪 Germany" },
];

const PLATFORM_OPTIONS = [
  { value: "", label: "All Platforms" },
  { value: "Shopify", label: "Shopify" },
  { value: "WooCommerce", label: "WooCommerce" },
  { value: "BigCommerce", label: "BigCommerce" },
];

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="text-[12px] font-bold text-text-strong-950/70 uppercase tracking-widest">
      {children}
    </label>
  );
}

const inputCls =
  "w-full h-10 border border-stroke-soft-200 rounded-lg px-3 text-sm text-text-strong-950 placeholder-text-soft-400 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent";

export default function CreateCampaignForm() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [inputMode, setInputMode] = useState("filters");
  const [jobTitles, setJobTitles] = useState("");
  const [targetMode, setTargetMode] = useState("leads");
  const [targetLeadCount, setTargetLeadCount] = useState("3000");
  const [targetDomainCount, setTargetDomainCount] = useState("150");

  // filters mode
  const [countryCode, setCountryCode] = useState("US");
  const [platform, setPlatform] = useState("");
  const [minRevenue, setMinRevenue] = useState("");
  const [maxRevenue, setMaxRevenue] = useState("");
  const [c1, setC1] = useState("");
  const [c2, setC2] = useState("");
  const [c3, setC3] = useState("");
  const [app, setApp] = useState("");

  // manual mode
  const [domainsText, setDomainsText] = useState("");

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);

    const body: Record<string, unknown> = {
      inputMode,
      jobTitles: jobTitles
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      targetMode,
      ...(targetMode === "domains"
        ? { targetDomainCount: Number(targetDomainCount) || 150 }
        : { targetLeadCount: Number(targetLeadCount) || 3000 }),
    };

    if (inputMode === "filters") {
      body.filters = {
        countryCode,
        platform: platform || undefined,
        minRevenue: minRevenue || undefined,
        maxRevenue: maxRevenue || undefined,
        c1: c1 || undefined,
        c2: c2 || undefined,
        c3: c3 || undefined,
        app: app || undefined,
      };
    } else {
      body.domains = domainsText
        .split(/[\n,]+/)
        .map((d) => d.trim())
        .filter(Boolean);
    }

    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create campaign");
      router.push(`/campaigns/${data.campaign.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create campaign");
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-5 px-4 py-4">
      <div className="flex flex-col gap-1.5">
        <Label>Source</Label>
        <Select value={inputMode} onChange={setInputMode} options={MODE_OPTIONS} variant="primary" />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Target by</Label>
        <Select value={targetMode} onChange={setTargetMode} options={TARGET_MODE_OPTIONS} />
      </div>

      {targetMode === "domains" ? (
        <div className="flex flex-col gap-1.5">
          <Label>Top domains</Label>
          <input
            type="number"
            value={targetDomainCount}
            onChange={(e) => setTargetDomainCount(e.target.value)}
            placeholder="150"
            className={inputCls}
          />
          <p className="text-[13px] text-text-strong-950/45">
            Fetches this many top domains (highest revenue first) and runs qualification on all of
            them, whatever fraction ends up qualified.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Label>Lead target</Label>
          <input
            type="number"
            value={targetLeadCount}
            onChange={(e) => setTargetLeadCount(e.target.value)}
            placeholder="3000"
            className={inputCls}
          />
          <p className="text-[13px] text-text-strong-950/45">Stops once qualified leads reach this number.</p>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Label>Job titles (for Apollo link)</Label>
        <input
          value={jobTitles}
          onChange={(e) => setJobTitles(e.target.value)}
          placeholder="CEO, Founder, Head of Marketing"
          className={inputCls}
        />
      </div>

      <div className="h-px bg-bg-weak-50" />

      {inputMode === "filters" ? (
        <>
          <div className="flex flex-col gap-1.5">
            <Label>Country</Label>
            <Select value={countryCode} onChange={setCountryCode} options={COUNTRY_OPTIONS} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Platform</Label>
            <Select value={platform} onChange={setPlatform} options={PLATFORM_OPTIONS} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Revenue Range ($)</Label>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                placeholder="Min"
                value={minRevenue}
                onChange={(e) => setMinRevenue(e.target.value)}
                className={inputCls}
              />
              <span className="text-text-strong-950/30 text-sm shrink-0">–</span>
              <input
                type="number"
                placeholder="Max"
                value={maxRevenue}
                onChange={(e) => setMaxRevenue(e.target.value)}
                className={inputCls}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Industry / Category</Label>
            <CategoryFilter
              countryCode={countryCode}
              c1={c1}
              c2={c2}
              c3={c3}
              onChange={(updates) => {
                if ("c1" in updates) { setC1(updates.c1); setC2(updates.c2 ?? ""); setC3(updates.c3 ?? ""); }
                else if ("c2" in updates) { setC2(updates.c2); setC3(updates.c3 ?? ""); }
                else if ("c3" in updates) setC3(updates.c3);
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Installed App</Label>
            <AppFilter value={app} onChange={setApp} />
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Label>Domains (one per line)</Label>
          <textarea
            value={domainsText}
            onChange={(e) => setDomainsText(e.target.value)}
            placeholder={"brand-one.com\nbrand-two.com"}
            rows={6}
            className="w-full border border-stroke-soft-200 rounded-lg px-3 py-2 text-sm text-text-strong-950 placeholder-text-soft-400 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent resize-y"
          />
        </div>
      )}

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      <button
        onClick={handleSubmit}
        disabled={submitting}
        className="h-10 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
      >
        {submitting && (
          <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
        )}
        {submitting ? "Creating…" : "Create campaign"}
      </button>
    </div>
  );
}
