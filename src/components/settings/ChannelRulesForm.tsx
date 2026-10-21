"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getCountries } from "libphonenumber-js";
import * as Button from "@/components/alignui/button";
import * as Input from "@/components/alignui/input";
import * as Select from "@/components/alignui/select";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { Callout, FieldRow } from "@/components/settings/SettingsKit";
import { ruleError, ruleSubmission, rulesSubset, ruleWarning, type Channel, type Rule } from "@/lib/channels/rules";
import { cn } from "@/utils/cn";

/**
 * A settings form generated from the rules registry in
 * src/lib/channels/rules.ts: one row per rule, its bounds enforced, its
 * warning shown past the safe edge, and a way back to the default.
 */

const COMMON_TIMEZONES = ["Asia/Kolkata", "Asia/Singapore", "Asia/Dubai", "Europe/London", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Australia/Sydney", "UTC"];

/** A native time input in the AlignUI field style. */
const timeInputClass =
  "h-9 w-full min-w-0 rounded-lg bg-bg-white-0 px-2.5 text-paragraph-sm tabular-nums text-text-strong-950 shadow-regular-xs outline-none ring-1 ring-inset ring-stroke-soft-200 transition hover:bg-bg-weak-50 focus:shadow-button-important-focus focus:ring-stroke-strong-950 disabled:bg-bg-weak-50 disabled:text-text-disabled-300 disabled:shadow-none disabled:ring-transparent";

type Values = Record<string, unknown>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function describeDefault(rule: Rule): string {
  switch (rule.kind) {
    case "number":
      return `${rule.default} ${rule.unit}`;
    case "range":
      return `${rule.default[0]}–${rule.default[1]} ${rule.unit}`;
    case "country":
      return rule.default ? countryName(rule.default) : "none";
    case "timezone":
    case "time":
      return rule.default;
  }
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
  title,
  description,
}: {
  channel: Channel;
  initialValues: Values;
  canEdit: boolean;
  /** A heading over the rules, when they share a page with other settings. */
  title?: string;
  description?: string;
  /** Show and save only these rules (the "general" ones are split across pages: GENERAL_RULE_PAGES); the others keep what is stored. */
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
      if (!res.ok || !body?.values) throw new Error(body?.error || "Could not save these settings.");
      setSaved(body.values);
      setValues(body.values);
      setStatus({ tone: "success", text: "Saved. It applies within a minute." });
      router.refresh();
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : "Could not save these settings." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {!canEdit && <Callout tone="info">Only owners and admins can change these.</Callout>}
      <Frame>
        {title && <FrameHeader title={title} description={description} />}
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
