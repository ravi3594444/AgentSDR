"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  RiAddLine,
  RiAlertLine,
  RiArrowDownLine,
  RiArrowUpLine,
  RiCheckLine,
  RiDeleteBinLine,
  RiErrorWarningLine,
  RiLoader4Line,
  RiSaveLine,
  RiTimerLine,
} from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Input from "@/components/alignui/input";
import * as Select from "@/components/alignui/select";
import * as Textarea from "@/components/alignui/textarea";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import {
  normalizeWhatsappCampaignSteps,
  whatsappCampaignStepsError,
  WHATSAPP_CAMPAIGN_DEFAULT_DELAY_HOURS,
  WHATSAPP_CAMPAIGN_MAX_BODY_LENGTH,
  WHATSAPP_CAMPAIGN_MAX_DELAY_HOURS,
  WHATSAPP_CAMPAIGN_MAX_STEPS,
  WHATSAPP_CAMPAIGN_MIN_DELAY_HOURS,
  type PreviewWhatsappCampaignStepRequest,
  type PreviewWhatsappCampaignStepResponse,
  type UpdateWhatsappCampaignRequest,
  type WhatsappCampaignMergeField,
  type WhatsappCampaignMergeFieldsResponse,
  type WhatsappCampaignStep,
} from "@/lib/whatsapp/campaigns/contract";
import { cn } from "@/utils/cn";
import { apiJson, errorText } from "./api";
import { formatDelay } from "./metrics";

const DEFAULT_FIELDS: WhatsappCampaignMergeField[] = [
  { token: "firstName", label: "First name" },
  { token: "lastName", label: "Last name" },
  { token: "companyName", label: "Company" },
];

type Unit = "hours" | "days";

const newStep = (delayHours: number): WhatsappCampaignStep => ({ id: crypto.randomUUID(), body: "", delayHours });

function stepLabel(index: number): string {
  return index === 0 ? "First message" : `Follow-up ${index}`;
}

/** A step moved out of first place needs a real wait; one moved in does not. */
function withValidDelays(steps: WhatsappCampaignStep[]): WhatsappCampaignStep[] {
  return steps.map((step, index) =>
    index > 0 && step.delayHours < WHATSAPP_CAMPAIGN_MIN_DELAY_HOURS ? { ...step, delayHours: WHATSAPP_CAMPAIGN_DEFAULT_DELAY_HOURS } : step,
  );
}

export function WhatsappSequenceEditor({
  campaignId,
  initialSteps,
  sentByStep,
  leadsVersion = 0,
  onSaved,
  saveLabel = "Save sequence",
}: {
  campaignId: string;
  initialSteps: WhatsappCampaignStep[];
  /** Messages sent per step id, shown beside each step of a running campaign. */
  sentByStep?: Record<string, number>;
  /** Changes whenever leads are added or removed, so the preview list refreshes. */
  leadsVersion?: number;
  onSaved?: (steps: WhatsappCampaignStep[]) => void;
  saveLabel?: string;
}) {
  const [steps, setSteps] = useState<WhatsappCampaignStep[]>(() =>
    initialSteps.length > 0 ? initialSteps.map((s) => ({ ...s })) : [newStep(0)],
  );
  const [units, setUnits] = useState<Record<string, Unit>>(() =>
    Object.fromEntries(initialSteps.map((s) => [s.id, s.delayHours > 0 && s.delayHours % 24 === 0 ? "days" : "hours"])),
  );
  const [selected, setSelected] = useState(0);
  const [fields, setFields] = useState<WhatsappCampaignMergeField[]>(DEFAULT_FIELDS);
  const [leads, setLeads] = useState<WhatsappCampaignMergeFieldsResponse["leads"]>([]);
  const [previewLeadId, setPreviewLeadId] = useState("");
  const [preview, setPreview] = useState<PreviewWhatsappCampaignStepResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  const index = Math.min(selected, steps.length - 1);
  const step = steps[index]!;
  const validationError = useMemo(() => whatsappCampaignStepsError(steps), [steps]);

  useEffect(() => {
    let cancelled = false;
    apiJson<WhatsappCampaignMergeFieldsResponse>(`/api/whatsapp/campaigns/${campaignId}/merge-fields`)
      .then((data) => {
        if (cancelled) return;
        if (data.fields?.length) setFields(data.fields);
        const list = data.leads ?? [];
        setLeads(list);
        setPreviewLeadId((current) => (list.some((l) => l.id === current) ? current : (list[0]?.id ?? "")));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [campaignId, leadsVersion]);

  // Live preview: re-rendered shortly after typing stops, against the chosen lead.
  const body = step.body;
  useEffect(() => {
    if (!body.trim()) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setPreviewing(true);
      try {
        const request: PreviewWhatsappCampaignStepRequest = { body, leadId: previewLeadId || undefined };
        const result = await apiJson<PreviewWhatsappCampaignStepResponse>(`/api/whatsapp/campaigns/${campaignId}/preview`, { method: "POST", body: JSON.stringify(request) });
        if (cancelled) return;
        setPreview(result);
        setPreviewError(null);
      } catch (cause) {
        if (cancelled) return;
        setPreview(null);
        setPreviewError(errorText(cause, "Could not render preview"));
      } finally {
        if (!cancelled) setPreviewing(false);
      }
    }, 450);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [campaignId, body, previewLeadId]);

  function change(next: WhatsappCampaignStep[]) {
    setSaved(false);
    setError(null);
    setSteps(next);
  }

  function updateStep(patch: Partial<WhatsappCampaignStep>) {
    change(steps.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function insertToken(token: string) {
    const input = editorRef.current;
    const start = input?.selectionStart ?? body.length;
    const end = input?.selectionEnd ?? body.length;
    const insert = `{{${token}}}`;
    updateStep({ body: `${body.slice(0, start)}${insert}${body.slice(end)}` });
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + insert.length, start + insert.length);
    });
  }

  function addFollowUp() {
    if (steps.length >= WHATSAPP_CAMPAIGN_MAX_STEPS) return;
    const created = newStep(WHATSAPP_CAMPAIGN_DEFAULT_DELAY_HOURS);
    setUnits((u) => ({ ...u, [created.id]: "days" }));
    change([...steps, created]);
    setSelected(steps.length);
  }

  function move(direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[index], next[target]] = [next[target]!, next[index]!];
    change(withValidDelays(next));
    setSelected(target);
  }

  function remove() {
    if (steps.length <= 1) return;
    change(withValidDelays(steps.filter((_, i) => i !== index)));
    setSelected(Math.max(0, index - 1));
  }

  function setDelay(value: number, unit: Unit) {
    updateStep({ delayHours: Math.round(unit === "days" ? value * 24 : value) });
  }

  async function save() {
    const issue = whatsappCampaignStepsError(steps);
    if (issue) { setError(issue); return; }
    setSaving(true);
    setError(null);
    try {
      const normalized = normalizeWhatsappCampaignSteps(steps);
      const request: UpdateWhatsappCampaignRequest = { steps: normalized };
      await apiJson(`/api/whatsapp/campaigns/${campaignId}`, { method: "PATCH", body: JSON.stringify(request) });
      setSteps(normalized.map((s, i) => (i === 0 ? { ...s, delayHours: 0 } : s)));
      setSaved(true);
      onSaved?.(normalized);
    } catch (cause) {
      setError(errorText(cause, "Could not save sequence"));
    } finally {
      setSaving(false);
    }
  }

  const unit: Unit = units[step.id] ?? (step.delayHours > 0 && step.delayHours % 24 === 0 ? "days" : "hours");
  const delayValue = unit === "days" ? step.delayHours / 24 : step.delayHours;
  const maxDelay = unit === "days" ? WHATSAPP_CAMPAIGN_MAX_DELAY_HOURS / 24 : WHATSAPP_CAMPAIGN_MAX_DELAY_HOURS;
  const showPreview = body.trim().length > 0;

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)] lg:gap-5">
      <Frame>
        <FrameHeader title="Sequence flow" description="Sent to every lead in order, personalised at send time." />
        <FramePanel className="p-2 sm:p-2">
          <ol className="flex flex-col">
            {steps.map((candidate, i) => {
              const written = candidate.body.trim().length > 0;
              const active = index === i;
              const sent = sentByStep?.[candidate.id];
              return (
                <li key={candidate.id}>
                  {i > 0 && (
                    <div className="flex items-center gap-2 py-1.5 pl-5 text-paragraph-xs text-text-soft-400">
                      <span aria-hidden="true" className="h-4 w-px bg-stroke-soft-200" />
                      <RiTimerLine className="size-3.5" aria-hidden="true" />
                      Wait {formatDelay(candidate.delayHours)}, if no reply
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => setSelected(i)}
                    aria-current={active ? "step" : undefined}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-xl p-2.5 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-primary-base",
                      active ? "bg-bg-weak-50" : "hover:bg-bg-weak-50",
                    )}
                  >
                    <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-md text-label-xs", active ? "bg-primary-base text-primary-contrast" : "bg-bg-weak-50 text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200")}>{i + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-label-sm text-text-strong-950">{stepLabel(i)}</span>
                      <span className="mt-0.5 block truncate text-paragraph-xs text-text-sub-600">{written ? candidate.body : "Not written yet"}</span>
                      {sent !== undefined && sent > 0 && <span className="mt-0.5 block text-paragraph-xs tabular-nums text-text-soft-400">{sent.toLocaleString("en-US")} sent</span>}
                    </span>
                    {written && <RiCheckLine className="mt-0.5 size-4 shrink-0 text-success-base" aria-label="Written" />}
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="mt-2 border-t border-stroke-soft-200 p-1 pt-2">
            <Button.Root variant="neutral" mode="ghost" size="xsmall" className="w-full" onClick={addFollowUp} disabled={steps.length >= WHATSAPP_CAMPAIGN_MAX_STEPS}>
              <Button.Icon as={RiAddLine} />
              {steps.length >= WHATSAPP_CAMPAIGN_MAX_STEPS ? `Up to ${WHATSAPP_CAMPAIGN_MAX_STEPS} messages` : "Add follow-up"}
            </Button.Root>
          </div>
        </FramePanel>
      </Frame>

      <Frame>
        <FrameHeader
          title={stepLabel(index)}
          description={index === 0 ? "Opens the chat. Sent once the number's new-chat limit allows." : "Sent in the same chat, only if the lead has not replied."}
          actions={
            <div className="flex items-center gap-1">
              <Button.Root variant="neutral" mode="ghost" size="xsmall" onClick={() => move(-1)} disabled={index === 0} aria-label="Move message up">
                <Button.Icon as={RiArrowUpLine} />
              </Button.Root>
              <Button.Root variant="neutral" mode="ghost" size="xsmall" onClick={() => move(1)} disabled={index === steps.length - 1} aria-label="Move message down">
                <Button.Icon as={RiArrowDownLine} />
              </Button.Root>
              <Button.Root variant="neutral" mode="ghost" size="xsmall" onClick={remove} disabled={steps.length <= 1} aria-label="Remove message">
                <Button.Icon as={RiDeleteBinLine} />
              </Button.Root>
            </div>
          }
        />
        <FramePanel>
          {index > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span className="text-label-sm text-text-strong-950">Wait</span>
              <Input.Root size="small" className="w-24">
                <Input.Wrapper>
                  <Input.Input
                    type="number"
                    min={1}
                    max={maxDelay}
                    step={1}
                    aria-label="Wait before this message"
                    value={Number.isFinite(delayValue) ? String(delayValue) : ""}
                    onChange={(e) => setDelay(Number(e.target.value), unit)}
                  />
                </Input.Wrapper>
              </Input.Root>
              <Select.Root
                size="small"
                value={unit}
                onValueChange={(value) => {
                  const next = value as Unit;
                  setUnits((u) => ({ ...u, [step.id]: next }));
                  // Days keep the same wait where they can; otherwise round to a whole day.
                  if (next === "days") updateStep({ delayHours: Math.max(24, Math.round(step.delayHours / 24) * 24) });
                }}
              >
                <Select.Trigger className="w-28" aria-label="Wait unit"><Select.Value /></Select.Trigger>
                <Select.Content>
                  <Select.Item value="hours">hours</Select.Item>
                  <Select.Item value="days">days</Select.Item>
                </Select.Content>
              </Select.Root>
              <span className="text-paragraph-sm text-text-sub-600">after the previous message</span>
            </div>
          )}

          <p className="mb-2 text-paragraph-xs text-text-sub-600">Merge fields from People and imported columns. Click one to insert it.</p>
          <div className="max-h-24 overflow-y-auto rounded-xl bg-bg-weak-50 p-2.5 ring-1 ring-inset ring-stroke-soft-200">
            <div className="flex flex-wrap gap-1.5">
              {fields.map((field) => (
                <button
                  type="button"
                  key={field.token}
                  title={field.label}
                  onClick={() => insertToken(field.token)}
                  className="rounded-md bg-bg-white-0 px-2 py-1 font-mono text-subheading-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200 transition hover:text-text-strong-950 hover:ring-stroke-sub-300"
                >{`{{${field.token}}}`}</button>
              ))}
            </div>
          </div>

          <div className="mt-3">
            <Textarea.Root
              ref={editorRef}
              simple
              rows={8}
              aria-label={stepLabel(index)}
              maxLength={WHATSAPP_CAMPAIGN_MAX_BODY_LENGTH}
              value={body}
              onChange={(event) => updateStep({ body: event.target.value })}
              placeholder={index === 0 ? "Hi {{firstName}}, …" : "Following up on my last message, …"}
              className="min-h-44"
              hasError={Boolean(validationError) && !body.trim()}
            />
            <div className="mt-1.5 flex items-start justify-between gap-3 text-paragraph-xs text-text-soft-400">
              <span>Spin text: {"{Hi|Hello|Hey}"} picks one option at random for each lead.</span>
              <span className="shrink-0 tabular-nums">{body.length}/{WHATSAPP_CAMPAIGN_MAX_BODY_LENGTH}</span>
            </div>
          </div>

          <div className="mt-4 rounded-xl bg-bg-weak-50 p-3 ring-1 ring-inset ring-stroke-soft-200">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-label-sm text-text-strong-950">Preview</span>
              {leads.length > 0 && (
                <Select.Root size="xsmall" value={previewLeadId} onValueChange={setPreviewLeadId}>
                  <Select.Trigger className="w-56" aria-label="Preview as lead"><Select.Value placeholder="Preview as…" /></Select.Trigger>
                  <Select.Content>
                    {leads.map((lead) => <Select.Item key={lead.id} value={lead.id}>{lead.name || lead.phone}</Select.Item>)}
                  </Select.Content>
                </Select.Root>
              )}
            </div>
            <div className="mt-2.5 min-h-16">
              {!showPreview ? (
                <p className="text-paragraph-sm text-text-sub-600">Write the message to see it rendered for a real lead.</p>
              ) : leads.length === 0 ? (
                <p className="text-paragraph-sm text-text-sub-600">Add a lead to preview this message with real data.</p>
              ) : previewError ? (
                <p className="text-paragraph-sm text-error-base">{previewError}</p>
              ) : preview ? (
                <div className={cn("transition-opacity", previewing && "opacity-60")}>
                  {preview.unresolved.length > 0 && (
                    <p className="mb-2 flex items-start gap-1.5 rounded-lg bg-warning-lighter px-3 py-2 text-paragraph-xs text-warning-dark">
                      <RiAlertLine className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                      <span>Empty for {preview.lead.name || preview.lead.phone}: {preview.unresolved.map((token) => `{{${token}}}`).join(", ")}. It sends as blank text.</span>
                    </p>
                  )}
                  <p className="max-w-md whitespace-pre-wrap break-words rounded-xl rounded-tl-sm bg-bg-white-0 px-3.5 py-2.5 text-paragraph-sm leading-6 text-text-strong-950 ring-1 ring-inset ring-stroke-soft-200">{preview.rendered}</p>
                </div>
              ) : (
                <p className="flex items-center gap-2 text-paragraph-sm text-text-sub-600"><RiLoader4Line className="size-4 animate-spin" aria-hidden="true" />Rendering…</p>
              )}
            </div>
          </div>

          {(validationError || error) && (
            <p role="alert" className="mt-4 flex items-center gap-2 rounded-xl bg-error-lighter px-3 py-2 text-paragraph-sm text-error-base">
              <RiErrorWarningLine className="size-4 shrink-0" />{error ?? validationError}
            </p>
          )}
          <div className="mt-5 flex items-center justify-end gap-3 border-t border-stroke-soft-200 pt-4">
            {saved && <span role="status" className="text-paragraph-xs text-success-base">Saved</span>}
            <Button.Root variant="primary" mode="filled" size="small" onClick={() => void save()} disabled={saving || Boolean(validationError)}>
              <Button.Icon as={saving ? RiLoader4Line : RiSaveLine} className={cn(saving && "animate-spin")} />
              {saving ? "Saving…" : saveLabel}
            </Button.Root>
          </div>
        </FramePanel>
        <FrameFooter>
          First messages count against each number&apos;s new-chats-per-day limit (Settings → WhatsApp → Sending rules). A reply on any channel stops the lead&apos;s sequence and lands in the Inbox.
        </FrameFooter>
      </Frame>
    </div>
  );
}
