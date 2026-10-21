"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getCountries } from "libphonenumber-js";
import * as Button from "@/components/alignui/button";
import * as Checkbox from "@/components/alignui/checkbox";
import * as Input from "@/components/alignui/input";
import * as Select from "@/components/alignui/select";
import { Frame, FramePanel } from "@/components/analytics/kit/Frame";
import { Callout, FieldRow } from "@/components/settings/SettingsKit";
import { timeInputClass } from "@/components/outreach/WorkingHoursModal";
import { ruleError, ruleSubmission, rulesSubset, ruleWarning, type Channel, type Rule, type WeeklyHours } from "@/lib/channels/rules";
import { cn } from "@/utils/cn";

/**
 * The Sending rules form for one channel, generated from the registry in
 * src/lib/channels/rules.ts: one row per rule, its bounds enforced, its
 * warning shown past the safe edge, and a way back to the default.
 */

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const COMMON_TIMEZONES = ["Asia/Kolkata", "Asia/Singapore", "Asia/Dubai", "Europe/London", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Australia/Sydney", "UTC"];

type Values = Record<string, unknown>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function describeDefault(rule: Rule): string {
  switch (rule.kind) {
    case "number":
      return `${rule.default} ${rule.unit}`;
    case "range":
      return `${rule.default[0]}–${rule.default[1]} ${rule.unit}`;
    case "hours":
      return rule.default ? hoursSummary(rule.default) : "any time";
    case "country":
      return rule.default ? countryName(rule.default) : "none";
    case "timezone":
    case "time":
      return rule.default;
  }
}

function hoursSummary(h: WeeklyHours): string {
  return `${h.days.map((d) => DAY_LABELS[d]).join(", ")} ${h.start}–${h.end} (${h.timezone})`;
}

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function NumberInput({ id, value, onChange, disabled, label }: { id: string; value: number; onChange: (n: number) => void; disabled: boolean; label?: string }) {
  return (
    <Input.Root size="small" className="w-24">
      <Input.Wrapper>
        <Input.Input
          id={id}
          type="number"
          inputMode="numeric"
          aria-label={label}
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))}
          disabled={disabled}
          className="tabular-nums"
        />
      </Input.Wrapper>
    </Input.Root>
  );
}

/** Every zone the browser knows, with `current` and the common ones first. */
function useTimeZones(current: string | undefined): string[] {
  return useMemo(() => {
    const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
    return [...new Set([...(current ? [current] : []), ...COMMON_TIMEZONES, ...all])];
  }, [current]);
}

function TimeZoneInput({ id, value, onChange, disabled }: { id: string; value: string; onChange: (v: string) => void; disabled: boolean }) {
  const zones = useTimeZones(value);
  return (
    <Select.Root size="small" value={value} onValueChange={onChange} disabled={disabled}>
      <Select.Trigger id={id} aria-label="Time zone">
        <Select.Value />
      </Select.Trigger>
      <Select.Content>
        {zones.map((zone) => (
          <Select.Item key={zone} value={zone}>{zone}</Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}

function HoursInput({ id, rule, value, onChange, disabled }: { id: string; rule: Rule & { kind: "hours" }; value: WeeklyHours | null; onChange: (v: WeeklyHours | null) => void; disabled: boolean }) {
  const fallback: WeeklyHours = { timezone: "Asia/Kolkata", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };
  const zones = useTimeZones(value?.timezone);

  if (rule.optional && value === null) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-paragraph-sm text-text-sub-600">Any time</span>
        <Button.Root type="button" size="xxsmall" variant="neutral" mode="stroke" disabled={disabled} onClick={() => onChange(rule.default ?? fallback)}>
          Set hours
        </Button.Root>
      </div>
    );
  }
  const h = value ?? fallback;
  const set = (patch: Partial<WeeklyHours>) => onChange({ ...h, ...patch });
  return (
    <div className="flex flex-col gap-2.5">
      <Select.Root size="small" value={h.timezone} onValueChange={(timezone) => set({ timezone })} disabled={disabled}>
        <Select.Trigger id={id} aria-label="Time zone">
          <Select.Value />
        </Select.Trigger>
        <Select.Content>
          {zones.map((zone) => (
            <Select.Item key={zone} value={zone}>{zone}</Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
        {DAY_LABELS.map((label, day) => {
          const on = h.days.includes(day);
          return (
            <label key={label} className={cn("flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-label-xs ring-1 ring-inset", on ? "bg-primary-alpha-10 text-primary-base ring-primary-alpha-16" : "text-text-sub-600 ring-stroke-soft-200")}>
              <Checkbox.Root
                checked={on}
                disabled={disabled}
                onCheckedChange={(checked) => set({ days: checked === true ? [...h.days, day].sort((a, b) => a - b) : h.days.filter((d) => d !== day) })}
              />
              {label}
            </label>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <input type="time" aria-label="Start" value={h.start} disabled={disabled} onChange={(e) => set({ start: e.target.value })} className={cn(timeInputClass, h.start >= h.end && "ring-error-base")} />
        <span className="shrink-0 text-paragraph-xs text-text-soft-400">to</span>
        <input type="time" aria-label="End" value={h.end} disabled={disabled} onChange={(e) => set({ end: e.target.value })} className={cn(timeInputClass, h.start >= h.end && "ring-error-base")} />
      </div>
      {rule.optional && (
        <button type="button" disabled={disabled} onClick={() => onChange(null)} className="self-start text-paragraph-xs text-text-sub-600 underline-offset-2 hover:underline disabled:opacity-50">
          Clear: send at any time
        </button>
      )}
    </div>
  );
}

function CountryInput({ id, value, onChange, disabled }: { id: string; value: string; onChange: (v: string) => void; disabled: boolean }) {
  const countries = useMemo(
    () => getCountries().map((code) => ({ code, name: countryName(code) })).sort((a, b) => a.name.localeCompare(b.name)),
    [],
  );
  return (
    <Select.Root size="small" value={value || "none"} onValueChange={(v) => onChange(v === "none" ? "" : v)} disabled={disabled}>
      <Select.Trigger id={id} aria-label="Country">
        <Select.Value />
      </Select.Trigger>
      <Select.Content>
        <Select.Item value="none">None (numbers need a + and country code)</Select.Item>
        {countries.map((c) => (
          <Select.Item key={c.code} value={c.code}>{c.name} ({c.code})</Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}

export function ChannelRulesForm({
  channel,
  initialValues,
  canEdit,
  keys,
}: {
  channel: Channel;
  initialValues: Values;
  canEdit: boolean;
  /** Show and save only these rules (the "general" ones are split across two pages); the others keep what is stored. */
  keys?: readonly string[];
}) {
  const router = useRouter();
  const rules = useMemo(() => rulesSubset(channel, keys), [channel, keys]);
  const [saved, setSaved] = useState<Values>(initialValues);
  const [values, setValues] = useState<Values>(initialValues);
  const [status, setStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const errors = Object.fromEntries(rules.map((rule) => [rule.key, ruleError(rule, values[rule.key])]));
  const hasErrors = Object.values(errors).some(Boolean);
  const dirty = rules.some((rule) => !same(values[rule.key], saved[rule.key]));

  const set = (key: string, value: unknown) => {
    setValues((v) => ({ ...v, [key]: value }));
    setStatus(null);
  };

  async function save() {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/settings/channel-rules/${channel}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ruleSubmission(rules, values)),
      });
      const body = (await res.json().catch(() => null)) as { values?: Values; error?: string } | null;
      if (!res.ok || !body?.values) throw new Error(body?.error || "Could not save the sending rules.");
      setSaved(body.values);
      setValues(body.values);
      setStatus({ tone: "success", text: "Saved. Sending follows these rules within a minute." });
      router.refresh();
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : "Could not save the sending rules." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {!canEdit && <Callout tone="info">Only owners and admins can change these.</Callout>}
      <Frame>
        <FramePanel className="divide-y divide-stroke-soft-200">
          {rules.map((rule) => {
            const id = `rule-${channel}-${rule.key}`;
            const value = values[rule.key];
            const error = errors[rule.key];
            const warning = error ? null : ruleWarning(rule, value);
            const isDefault = same(value, rule.default);
            return (
              <FieldRow
                key={rule.key}
                htmlFor={id}
                label={rule.label}
                description={
                  <>
                    {rule.help}
                    {rule.override && <span className="mt-1 block text-text-soft-400">{rule.override}</span>}
                  </>
                }
              >
                <div className="flex w-full flex-col gap-2 sm:items-end">
                  {rule.kind === "number" && (
                    <div className="flex items-center gap-2">
                      <NumberInput id={id} value={value as number} onChange={(n) => set(rule.key, n)} disabled={!canEdit} />
                      <span className="text-paragraph-xs text-text-sub-600">{rule.unit}</span>
                    </div>
                  )}
                  {rule.kind === "range" && (
                    <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                      <NumberInput id={id} label="Lowest" value={(value as [number, number])[0]} onChange={(n) => set(rule.key, [n, (value as [number, number])[1]])} disabled={!canEdit} />
                      <span className="text-paragraph-xs text-text-soft-400">to</span>
                      <NumberInput id={`${id}-hi`} label="Highest" value={(value as [number, number])[1]} onChange={(n) => set(rule.key, [(value as [number, number])[0], n])} disabled={!canEdit} />
                      <span className="text-paragraph-xs text-text-sub-600">{rule.unit}</span>
                    </div>
                  )}
                  {rule.kind === "hours" && (
                    <div className="w-full text-left">
                      <HoursInput id={id} rule={rule} value={value as WeeklyHours | null} onChange={(v) => set(rule.key, v)} disabled={!canEdit} />
                    </div>
                  )}
                  {rule.kind === "timezone" && (
                    <div className="w-full text-left">
                      <TimeZoneInput id={id} value={value as string} onChange={(v) => set(rule.key, v)} disabled={!canEdit} />
                    </div>
                  )}
                  {rule.kind === "time" && (
                    <input
                      id={id}
                      type="time"
                      value={value as string}
                      disabled={!canEdit}
                      onChange={(e) => set(rule.key, e.target.value)}
                      className={cn(timeInputClass, "w-28", error && "ring-error-base")}
                    />
                  )}
                  {rule.kind === "country" && (
                    <div className="w-full text-left">
                      <CountryInput id={id} value={value as string} onChange={(v) => set(rule.key, v)} disabled={!canEdit} />
                    </div>
                  )}
                  {error && <p role="alert" className="text-paragraph-xs text-error-base">{error}</p>}
                  {warning && <Callout tone="warning" className="w-full py-2 text-left">{warning}</Callout>}
                  <p className="text-paragraph-xs text-text-soft-400">
                    Default: {describeDefault(rule)}
                    {!isDefault && canEdit && (
                      <>
                        {" · "}
                        <button type="button" onClick={() => set(rule.key, rule.default)} className="text-text-sub-600 underline-offset-2 hover:underline">
                          Use default
                        </button>
                      </>
                    )}
                  </p>
                </div>
              </FieldRow>
            );
          })}
        </FramePanel>
      </Frame>
      {canEdit && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          {status && <span role={status.tone === "error" ? "alert" : "status"} className={cn("text-paragraph-sm", status.tone === "error" ? "text-error-base" : "text-success-base")}>{status.text}</span>}
          <Button.Root type="button" variant="neutral" mode="stroke" size="small" disabled={!dirty || saving} onClick={() => { setValues(saved); setStatus(null); }}>
            Discard
          </Button.Root>
          <Button.Root type="button" variant="primary" mode="filled" size="small" disabled={!dirty || hasErrors || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save changes"}
          </Button.Root>
        </div>
      )}
    </div>
  );
}
