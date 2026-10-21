"use client";

import Link from "next/link";
import { useMemo, useState, type FormEvent } from "react";
import * as Button from "@/components/alignui/button";
import * as Checkbox from "@/components/alignui/checkbox";
import * as Input from "@/components/alignui/input";
import * as Select from "@/components/alignui/select";
import * as Textarea from "@/components/alignui/textarea";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { Callout, Field } from "@/components/settings/SettingsKit";
import { PROFILE_CHANNELS, PROFILE_FIELD_MAX, PROFILE_TEXT_FIELDS } from "@/lib/assistant/profile";
import type { BusinessProfile } from "@/lib/assistant/schema";
import { cn } from "@/utils/cn";

/**
 * Settings → Your business: the structured business profile (the same row
 * the chat's save_business_info writes), as a form. Saves send only the
 * fields that changed; the server rewrites the Knowledge copy with them.
 */

type TextField = (typeof PROFILE_TEXT_FIELDS)[number];
type Channel = (typeof PROFILE_CHANNELS)[number];
type FormValues = Record<TextField, string> & { preferredChannels: Channel[] };

type FieldSpec = { key: TextField; label: string; help: string; multiline?: boolean; placeholder?: string; half?: boolean };

const SECTIONS: { id: string; title: string; description: string; fields: FieldSpec[] }[] = [
  {
    id: "about",
    title: "About the business",
    description: "What every message and reply draft says about you. Nothing outside this is claimed.",
    fields: [
      { key: "businessName", label: "Business name", help: "As leads should see it.", half: true },
      { key: "website", label: "Website", help: "Your own site, if you have one.", placeholder: "https://", half: true },
      { key: "offer", label: "What you offer", help: "What you sell, to whom, and why it helps.", multiline: true },
      { key: "problemsSolved", label: "Problems you solve", help: "In your words: the problems your offer fixes, and how. Replies connect a lead's problem to these.", multiline: true },
      { key: "prices", label: "Prices", help: "Prices, packages or rates, as you would quote them. Left empty, messages never name a price.", multiline: true },
    ],
  },
  {
    id: "customers",
    title: "Who to look for",
    description: "What lead searches look for, and where.",
    fields: [
      { key: "targetCustomers", label: "Your customers", help: "Kinds of businesses or roles, their size, and signs they need you.", multiline: true },
      { key: "locations", label: "Where to look", help: "Cities, regions or countries.", placeholder: "Pune, Mumbai" },
    ],
  },
  {
    id: "messages",
    title: "How messages go out",
    description: "Who signs them, what they offer next, and how they should sound.",
    fields: [
      { key: "senderName", label: "Sender name", help: "The name messages are signed with.", half: true },
      { key: "senderRole", label: "Sender role", help: "For example Founder or Sales lead.", half: true },
      { key: "nextStep", label: "Next step for interested leads", help: "What an interested lead is offered: a 10-minute call, a free visit, a quote. Left empty: a short call with the sender." },
      { key: "bookingDetails", label: "How meetings are booked", help: "A calendar link or a phone number." },
      { key: "outreachInstructions", label: "How messages should sound", help: "Tone, and anything messages must or must not say.", multiline: true },
    ],
  },
  {
    id: "notes",
    title: "Anything else",
    description: "Other facts worth remembering, as you would tell a new colleague.",
    fields: [{ key: "notes", label: "Notes", help: "", multiline: true }],
  },
];

const LABELS: Record<TextField | "preferredChannels", string> = {
  ...(Object.fromEntries(SECTIONS.flatMap((section) => section.fields.map((field) => [field.key, field.label]))) as Record<TextField, string>),
  language: "Language",
  preferredChannels: "Preferred channels",
};

const CHANNEL_LABELS: Record<Channel, string> = { email: "Email", whatsapp: "WhatsApp", linkedin: "LinkedIn", instagram: "Instagram" };
const LANGUAGES = ["en", "hi", "mr", "gu", "ta", "te", "kn", "ml", "bn", "ur", "ar", "es", "pt", "fr", "de", "it", "nl", "id", "tr", "ru", "ja", "ko", "zh"];

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function toForm(profile: BusinessProfile): FormValues {
  const text = Object.fromEntries(PROFILE_TEXT_FIELDS.map((key) => [key, profile[key] ?? ""])) as Record<TextField, string>;
  return { ...text, preferredChannels: [...(profile.preferredChannels ?? [])] };
}

/** The fields that differ from what is saved, as the PATCH body ("" clears a field). */
function changedFields(values: FormValues, saved: FormValues): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of PROFILE_TEXT_FIELDS) {
    const next = key === "language" ? values[key].trim().toLowerCase() : values[key].trim();
    if (next !== saved[key]) patch[key] = next;
  }
  if (JSON.stringify(values.preferredChannels) !== JSON.stringify(saved.preferredChannels)) patch.preferredChannels = values.preferredChannels;
  return patch;
}

export function BusinessProfileForm({
  initialProfile,
  canEdit,
  organizationName,
  instagram,
}: {
  initialProfile: BusinessProfile;
  canEdit: boolean;
  organizationName: string;
  /** Instagram messages are on, so Instagram can be a preferred channel. */
  instagram: boolean;
}) {
  const [saved, setSaved] = useState<FormValues>(() => toForm(initialProfile));
  const [values, setValues] = useState<FormValues>(saved);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const patch = useMemo(() => changedFields(values, saved), [values, saved]);
  const dirty = Object.keys(patch).length > 0;
  const empty = PROFILE_TEXT_FIELDS.every((key) => !saved[key]) && saved.preferredChannels.length === 0;
  const channels = PROFILE_CHANNELS.filter((channel) => channel !== "instagram" || instagram || saved.preferredChannels.includes("instagram"));
  const languages = useMemo(() => [...new Set([...(saved.language ? [saved.language] : []), ...LANGUAGES])], [saved.language]);

  const set = (key: TextField, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    setStatus(null);
  };
  const toggleChannel = (channel: Channel, on: boolean) => {
    setValues((current) => ({
      ...current,
      // Kept in the order they were picked: the first is tried first.
      preferredChannels: on ? [...current.preferredChannels.filter((c) => c !== channel), channel] : current.preferredChannels.filter((c) => c !== channel),
    }));
    setStatus(null);
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!dirty) return;
    setSaving(true);
    setStatus(null);
    try {
      const response = await fetch("/api/settings/business-profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = (await response.json().catch(() => null)) as { profile?: BusinessProfile; profileChanges?: string[]; error?: string } | null;
      if (!response.ok || !body?.profile) throw new Error(body?.error || "Could not save the business profile.");
      const next = toForm(body.profile);
      setSaved(next);
      setValues(next);
      const changed = (body.profileChanges ?? []).map((key) => LABELS[key as keyof typeof LABELS] ?? key);
      setStatus({ tone: "success", text: changed.length ? `Saved: ${changed.join(", ")}. The Knowledge copy is updated too.` : "Nothing changed." });
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : "Could not save the business profile." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-5" aria-label="Business profile">
      {empty && (
        <Callout tone="info" title="Nothing saved yet">
          Fill in what you know, or tell the assistant about your business in{" "}
          <Link href="/assistant" className="underline underline-offset-2">Outreach</Link>: what it learns in the chat is saved here.
        </Callout>
      )}
      {!canEdit && <Callout tone="info">Only owners and admins can change the business profile. The assistant still saves what you tell it in the chat.</Callout>}

      {SECTIONS.map((section) => (
        <Frame key={section.id} aria-labelledby={`profile-${section.id}`}>
          <FrameHeader title={<span id={`profile-${section.id}`}>{section.title}</span>} description={section.description} />
          <FramePanel className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {section.fields.map((field) => {
              const id = `profile-${field.key}`;
              const tooLong = values[field.key].trim().length > PROFILE_FIELD_MAX;
              return (
                <Field
                  key={field.key}
                  label={field.label}
                  htmlFor={id}
                  description={field.help || undefined}
                  error={tooLong ? `Keep it under ${PROFILE_FIELD_MAX.toLocaleString("en")} characters.` : undefined}
                  className={cn(!field.half && "sm:col-span-2")}
                >
                  {field.multiline ? (
                    <Textarea.Root
                      id={id}
                      simple
                      rows={field.key === "notes" ? 4 : 3}
                      value={values[field.key]}
                      onChange={(event) => set(field.key, event.target.value)}
                      disabled={!canEdit || saving}
                      hasError={tooLong}
                      className="min-h-20 resize-y"
                    />
                  ) : (
                    <Input.Root size="medium" hasError={tooLong}>
                      <Input.Wrapper>
                        <Input.Input
                          id={id}
                          value={values[field.key]}
                          onChange={(event) => set(field.key, event.target.value)}
                          disabled={!canEdit || saving}
                          placeholder={field.key === "businessName" ? organizationName : field.placeholder}
                        />
                      </Input.Wrapper>
                    </Input.Root>
                  )}
                </Field>
              );
            })}
            {section.id === "messages" && (
              <>
                <Field label="Preferred channels" description="Tried in the order you tick them. None ticked: each lead gets its best ready channel." className="sm:col-span-2">
                  <div className="flex flex-wrap gap-2" role="group" aria-label="Preferred channels">
                    {channels.map((channel) => {
                      const position = values.preferredChannels.indexOf(channel);
                      const on = position >= 0;
                      return (
                        <label
                          key={channel}
                          className={cn(
                            "flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-label-sm ring-1 ring-inset",
                            on ? "bg-primary-alpha-10 text-text-strong-950 ring-primary-alpha-16" : "text-text-sub-600 ring-stroke-soft-200",
                            (!canEdit || saving) && "cursor-not-allowed opacity-60",
                          )}
                        >
                          <Checkbox.Root checked={on} disabled={!canEdit || saving} onCheckedChange={(checked) => toggleChannel(channel, checked === true)} />
                          {CHANNEL_LABELS[channel]}
                          {on && values.preferredChannels.length > 1 && <span className="text-paragraph-xs tabular-nums text-text-soft-400">{position + 1}</span>}
                        </label>
                      );
                    })}
                  </div>
                </Field>
                <Field label="Language" htmlFor="profile-language" description="For lead searches and the messages written to them." className="sm:col-span-1">
                  <Select.Root size="medium" value={values.language || "none"} onValueChange={(value) => set("language", value === "none" ? "" : value)} disabled={!canEdit || saving}>
                    <Select.Trigger id="profile-language" aria-label="Language">
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="none">Not set (English)</Select.Item>
                      {languages.map((code) => (
                        <Select.Item key={code} value={code}>{languageName(code)}</Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                </Field>
              </>
            )}
          </FramePanel>
          {section.id === "notes" && (
            <FrameFooter>
              A copy of this profile is kept in{" "}
              <Link href="/settings/knowledge" className="underline underline-offset-2">Knowledge</Link>, so reply drafts use it too. It changes only from here or the chat.
            </FrameFooter>
          )}
        </Frame>
      ))}

      {canEdit && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          {status && (
            <span role={status.tone === "error" ? "alert" : "status"} className={cn("min-w-0 text-paragraph-sm", status.tone === "error" ? "text-error-base" : "text-success-base")}>
              {status.text}
            </span>
          )}
          <Button.Root type="button" variant="neutral" mode="stroke" size="small" disabled={!dirty || saving} onClick={() => { setValues(saved); setStatus(null); }}>
            Discard
          </Button.Root>
          <Button.Root type="submit" variant="primary" mode="filled" size="small" disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button.Root>
        </div>
      )}
    </form>
  );
}
