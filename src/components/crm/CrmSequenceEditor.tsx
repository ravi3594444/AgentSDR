"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RiAddLine,
  RiDeleteBinLine,
  RiFileCopyLine,
  RiListOrdered2,
  RiMoreLine,
  RiRepeatLine,
  RiSaveLine,
  RiSendPlaneLine,
  RiTimeLine,
} from "@remixicon/react";
import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Dropdown from "@/components/alignui/dropdown";
import * as Select from "@/components/alignui/select";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { PageHeader } from "@/components/page/PageHeader";
import { StatRow } from "@/components/page/StatRow";
import { cn } from "@/utils/cn";
import { ErrorState, fieldClass } from "./CrmLayout";
import { EditorBody } from "./CrmSkeletons";
import { asList, asObject, crmFetch, errorMessage } from "./crm-utils";

type DelayUnit = "minutes" | "hours" | "days";

type EditorStep = {
  clientId: string;
  storedName: string;
  delayAmount: number;
  delayUnit: DelayUnit;
  subjectTemplate: string | null;
  bodyTemplate: string | null;
  messageGoal: string;
  knowledgeTags: string[];
};

type StepPayload = {
  name: string;
  delayMinutes: number;
  subjectTemplate: string | null;
  bodyTemplate: string | null;
  aiInstructions: string;
  knowledgeTags: string[];
};

const MAX_STEPS = 30;
const DEFAULT_IMMEDIATE_GOAL = "Respond to the latest inbound message and move the conversation forward naturally.";
const DEFAULT_FOLLOW_UP_GOAL = "Follow up naturally, add value, and avoid repeating the previous message.";
const inputClass = fieldClass;

function newClientId() {
  return crypto.randomUUID();
}

function splitDelay(delayMinutes: number): { amount: number; unit: DelayUnit } {
  if (delayMinutes > 0 && delayMinutes % 1440 === 0) return { amount: delayMinutes / 1440, unit: "days" };
  if (delayMinutes > 0 && delayMinutes % 60 === 0) return { amount: delayMinutes / 60, unit: "hours" };
  return { amount: delayMinutes, unit: "minutes" };
}

function delayInMinutes(amount: number, unit: DelayUnit) {
  const multiplier = unit === "days" ? 1440 : unit === "hours" ? 60 : 1;
  return Math.round(amount * multiplier);
}

function immediateStep(): EditorStep {
  return {
    clientId: newClientId(),
    storedName: "Immediate reply",
    delayAmount: 0,
    delayUnit: "minutes",
    subjectTemplate: null,
    bodyTemplate: null,
    messageGoal: DEFAULT_IMMEDIATE_GOAL,
    knowledgeTags: [],
  };
}

function followUpStep(): EditorStep {
  return {
    clientId: newClientId(),
    storedName: "Follow-up",
    delayAmount: 2,
    delayUnit: "days",
    subjectTemplate: null,
    bodyTemplate: null,
    messageGoal: DEFAULT_FOLLOW_UP_GOAL,
    knowledgeTags: [],
  };
}

function parseStep(value: Record<string, unknown>, index: number): EditorStep {
  const delay = splitDelay(Number(value.delayMinutes ?? 0));
  return {
    clientId: String(value.id ?? `${index}-${newClientId()}`),
    storedName: String(value.name ?? stepLabel(index)),
    delayAmount: index === 0 ? 0 : delay.amount,
    delayUnit: index === 0 ? "minutes" : delay.unit,
    subjectTemplate: value.subjectTemplate == null ? null : String(value.subjectTemplate),
    bodyTemplate: value.bodyTemplate == null ? null : String(value.bodyTemplate),
    messageGoal: String(value.aiInstructions ?? ""),
    knowledgeTags: asList<string>(value.knowledgeTags),
  };
}

function stepLabel(index: number) {
  return index === 0 ? "Immediate reply" : `Follow-up ${index}`;
}

function persistedStepName(step: EditorStep, index: number) {
  const generated = /^(immediate reply|follow-up(?: \d+)?)$/i.test(step.storedName.trim());
  return generated ? stepLabel(index) : step.storedName.trim();
}

export default function CrmSequenceEditor({ sequenceId }: { sequenceId: string }) {
  const router = useRouter();
  const [sequence, setSequence] = useState<Record<string, unknown>>({});
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState<EditorStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "publish" | "duplicate">("");
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError("");
    try {
      const result = await crmFetch(`/sequences/${sequenceId}`);
      const value = asObject(asObject(result).sequence);
      const rows = asList<Record<string, unknown>>(value.draftSteps);
      setSequence(value);
      setName(String(value.name ?? ""));
      setDescription(String(value.description ?? ""));
      setSteps(rows.length ? rows.map(parseStep) : [immediateStep()]);
      setDirty(rows.length === 0);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [sequenceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateMetadata = (field: "name" | "description", value: string) => {
    if (field === "name") setName(value);
    else setDescription(value);
    setDirty(true);
    setNotice("");
  };

  const updateStep = (index: number, patch: Partial<EditorStep>) => {
    setSteps((current) => current.map((step, position) =>
      position === index ? { ...step, ...patch } : step,
    ));
    setDirty(true);
    setNotice("");
  };

  const addFollowUp = () => {
    if (steps.length >= MAX_STEPS) return;
    setSteps((current) => [...current, followUpStep()]);
    setDirty(true);
    setNotice("");
  };

  const removeFollowUp = (index: number) => {
    if (index < 1) return;
    setSteps((current) => current.filter((_, position) => position !== index));
    setDirty(true);
    setNotice("");
  };

  const validationError = useMemo(() => {
    if (!name.trim()) return "Sequence name is required.";
    if (!steps.length) return "Add an immediate reply step before saving.";
    if (steps.length > MAX_STEPS) return `A sequence can contain at most ${MAX_STEPS} steps.`;
    const missingGoal = steps.findIndex((step) => !step.messageGoal.trim());
    if (missingGoal >= 0) return `${stepLabel(missingGoal)} needs a message goal.`;
    const invalidDelay = steps.findIndex((step, index) => index > 0 && (!Number.isInteger(step.delayAmount) || step.delayAmount < 1));
    if (invalidDelay >= 0) return `${stepLabel(invalidDelay)} needs a positive whole-number delay.`;
    return "";
  }, [name, steps]);

  const payload = useMemo(() => ({
    name: name.trim(),
    description: description.trim() || null,
    steps: steps.map<StepPayload>((step, index) => ({
      name: persistedStepName(step, index),
      delayMinutes: index === 0 ? 0 : delayInMinutes(step.delayAmount, step.delayUnit),
      subjectTemplate: step.subjectTemplate,
      bodyTemplate: step.bodyTemplate,
      aiInstructions: step.messageGoal.trim(),
      knowledgeTags: step.knowledgeTags,
    })),
  }), [description, name, steps]);

  const save = async (showNotice = true) => {
    if (validationError) {
      setError(validationError);
      return false;
    }
    setBusy("save");
    setError("");
    setNotice("");
    try {
      await crmFetch(`/sequences/${sequenceId}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      setSequence((current) => ({ ...current, name: payload.name, description: payload.description }));
      setDirty(false);
      if (showNotice) setNotice("Draft saved.");
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setBusy("");
    }
  };

  const publish = async () => {
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy("publish");
    setError("");
    setNotice("");
    try {
      await crmFetch(`/sequences/${sequenceId}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      await crmFetch(`/sequences/${sequenceId}/publish`, { method: "POST" });
      await load(false);
      setDirty(false);
      setNotice("Sequence published. Future CRM runs will use this version.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  };

  const duplicate = async () => {
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy("duplicate");
    setError("");
    setNotice("");
    try {
      const created = asObject(await crmFetch("/sequences", {
        method: "POST",
        body: JSON.stringify({ ...payload, name: `${payload.name} copy` }),
      }));
      const id = asObject(created.sequence).id;
      if (!id) throw new Error("The duplicated sequence did not return an ID");
      router.push(`/crm/sequences/${String(id)}`);
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy("");
    }
  };

  if (loading) return <EditorBody />;
  if (error && !sequence.id) return <div className="space-y-6"><PageHeader back={BACK} title="Sequence" /><ErrorState message={error} onRetry={() => void load()} /></div>;

  const archived = sequence.status === "archived";
  const published = Boolean(sequence.latestPublishedVersionId);
  const publishedVersion = asList<Record<string, unknown>>(sequence.versions).find((version) => version.id === sequence.latestPublishedVersionId)?.version;
  const status = archived ? { label: "Archived", color: "orange" as const } : published ? { label: "Published", color: "green" as const } : { label: "Draft", color: "gray" as const };
  const spanMinutes = steps.reduce((sum, step, index) => sum + (index === 0 ? 0 : delayInMinutes(step.delayAmount || 0, step.delayUnit)), 0);
  return (
    <div className="space-y-5">
      <PageHeader
        back={BACK}
        title={name.trim() || "Untitled sequence"}
        badge={<>
          <Badge.Root variant="lighter" size="medium" color={status.color}><Badge.Dot />{status.label}</Badge.Root>
          {dirty && <Badge.Root variant="lighter" size="medium" color="yellow"><Badge.Dot />Unsaved changes</Badge.Root>}
        </>}
        description="Runs on Email or LinkedIn — the inbound conversation decides which. Every message waits for approval."
        actions={<>
          <Button.Root
            variant="neutral"
            mode="stroke"
            size="small"
            disabled={!dirty || Boolean(validationError) || Boolean(busy)}
            onClick={() => void save()}
          >
            <Button.Icon as={RiSaveLine} />
            {busy === "save" ? "Saving…" : "Save draft"}
          </Button.Root>
          <Button.Root
            variant="primary"
            mode="filled"
            size="small"
            disabled={Boolean(busy) || archived || Boolean(validationError)}
            onClick={() => void publish()}
          >
            <Button.Icon as={RiSendPlaneLine} />
            {busy === "publish" ? "Publishing…" : "Publish"}
          </Button.Root>
          <Dropdown.Root>
            <Dropdown.Trigger asChild>
              <Button.Root variant="neutral" mode="stroke" size="small" disabled={Boolean(busy)} aria-label="Sequence actions">
                <Button.Icon as={RiMoreLine} />
              </Button.Root>
            </Dropdown.Trigger>
            <Dropdown.Content align="end" className="min-w-[180px]">
              <Dropdown.Item
                disabled={Boolean(validationError)}
                onSelect={() => void duplicate()}
              >
                <Dropdown.ItemIcon as={RiFileCopyLine} />
                {busy === "duplicate" ? "Duplicating…" : "Duplicate"}
              </Dropdown.Item>
            </Dropdown.Content>
          </Dropdown.Root>
        </>}
      />

      {error && <ErrorState message={error} onRetry={dirty ? undefined : () => void load()} />}
      <div aria-live="polite">
        {notice && (
          <div role="status" className="rounded-xl bg-success-lighter px-4 py-2.5 text-paragraph-sm text-success-dark ring-1 ring-inset ring-success-light">
            {notice}
          </div>
        )}
      </div>
      {archived && (
        <div className="rounded-xl bg-warning-lighter px-4 py-2.5 text-paragraph-sm text-warning-dark ring-1 ring-inset ring-warning-light">
          This archived sequence cannot be published or assigned. Duplicate it to continue, or delete it from the sequence library.
        </div>
      )}

      <StatRow items={[
        { label: "Steps", value: `${steps.length}`, icon: RiListOrdered2 },
        { label: "Follow-ups", value: `${Math.max(steps.length - 1, 0)}`, icon: RiRepeatLine },
        { label: "Runs over", value: spanMinutes ? formatSpan(spanMinutes) : "Immediate only", icon: RiTimeLine, hint: "From the first reply to the last follow-up, if the lead never answers" },
        { label: "Live version", value: publishedVersion ? `v${String(publishedVersion)}` : published ? "Published" : "Not published", icon: RiSendPlaneLine, hint: "Only the published version runs. Edits change the draft until you publish again." },
      ]} />

      <Frame>
        <FrameHeader title="Details" description="How this sequence shows up in the library and in CRM Settings." />
        <FramePanel className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-paragraph-sm">
              <span className="mb-1.5 block text-label-xs text-text-sub-600">Sequence name</span>
              <input
                required
                maxLength={160}
                disabled={Boolean(busy)}
                value={name}
                onChange={(event) => updateMetadata("name", event.target.value)}
                className={inputClass}
              />
            </label>
            <label className="text-paragraph-sm">
              <span className="mb-1.5 block text-label-xs text-text-sub-600">
                Description <span className="font-normal text-text-soft-400">(optional)</span>
              </span>
              <input
                maxLength={4000}
                disabled={Boolean(busy)}
                value={description}
                onChange={(event) => updateMetadata("description", event.target.value)}
                className={inputClass}
                placeholder="When should this sequence be used?"
              />
            </label>
          </div>
          {validationError && <p role="alert" className="text-label-xs text-error-base">{validationError}</p>}
        </FramePanel>
      </Frame>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12 lg:gap-5">
        <Frame className="lg:sticky lg:top-5 lg:col-span-4">
          <FrameHeader title="Timeline" description="When each message is prepared." />
          <FramePanel className="p-0 sm:p-0">
            <ol className="relative px-4 py-2">
              {steps.map((step, index) => (
                <li key={step.clientId} className="relative flex gap-3 py-3">
                  {index < steps.length - 1 && <span aria-hidden="true" className="absolute left-3 top-10 -bottom-3 w-px bg-stroke-soft-200" />}
                  <span className={cn("relative flex size-6 shrink-0 items-center justify-center rounded-full text-label-xs", index === 0 ? "bg-primary-base text-primary-contrast" : "bg-bg-weak-50 text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200")}>
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-label-sm text-text-strong-950">{stepLabel(index)}</p>
                    {index === 0 ? (
                      <p className="mt-0.5 text-paragraph-xs text-text-sub-600">Immediately after classification</p>
                    ) : (
                      <fieldset disabled={Boolean(busy)} className="mt-2">
                        <legend className="mb-1.5 text-paragraph-xs text-text-sub-600">Wait after previous message</legend>
                        <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-1.5">
                          <input
                            aria-label={`${stepLabel(index)} delay amount`}
                            type="number"
                            min={1}
                            step={1}
                            value={step.delayAmount}
                            onChange={(event) => updateStep(index, { delayAmount: Number(event.target.value) })}
                            className={`${inputClass} h-8 px-2 py-1`}
                          />
                          <Select.Root
                            size="xsmall"
                            value={step.delayUnit}
                            onValueChange={(value) => updateStep(index, { delayUnit: value as DelayUnit })}
                          >
                            <Select.Trigger aria-label={`${stepLabel(index)} delay unit`} className="w-full">
                              <Select.Value />
                            </Select.Trigger>
                            <Select.Content>
                              <Select.Item value="minutes">Minutes</Select.Item>
                              <Select.Item value="hours">Hours</Select.Item>
                              <Select.Item value="days">Days</Select.Item>
                            </Select.Content>
                          </Select.Root>
                        </div>
                      </fieldset>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </FramePanel>
          <FrameFooter>A new inbound reply interrupts any pending follow-up. Every message waits for human approval; nothing sends on its own.</FrameFooter>
        </Frame>

        <div className="min-w-0 space-y-4 lg:col-span-8">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-label-md text-text-strong-950">Message goals</h2>
              <p className="mt-0.5 text-paragraph-sm text-text-sub-600">AI writes each message from the conversation and the goal you set here.</p>
            </div>
            <span className="text-paragraph-xs text-text-soft-400">Up to {MAX_STEPS - 1} follow-ups</span>
          </div>
          {steps.map((step, index) => (
            <StepEditor
              key={step.clientId}
              step={step}
              index={index}
              busy={Boolean(busy)}
              onChange={(patch) => updateStep(index, patch)}
              onRemove={() => removeFollowUp(index)}
            />
          ))}
          <Button.Root
            variant="neutral"
            mode="stroke"
            size="medium"
            className="w-full border border-dashed border-stroke-sub-300 shadow-none ring-0"
            disabled={Boolean(busy) || steps.length >= MAX_STEPS}
            onClick={addFollowUp}
          >
            <Button.Icon as={RiAddLine} />
            Add follow-up
          </Button.Root>
        </div>
      </div>
    </div>
  );
}

const BACK = { href: "/crm/sequences", label: "Sequences" };

/** "9 days", "1 day 4 hours", "45 minutes" — how long the whole sequence spans. */
function formatSpan(minutes: number) {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  const part = (value: number, unit: string) => `${value} ${unit}${value === 1 ? "" : "s"}`;
  if (days) return hours ? `${part(days, "day")} ${part(hours, "hour")}` : part(days, "day");
  if (hours) return rest ? `${part(hours, "hour")} ${part(rest, "minute")}` : part(hours, "hour");
  return part(rest, "minute");
}

function StepEditor({
  step,
  index,
  busy,
  onChange,
  onRemove,
}: {
  step: EditorStep;
  index: number;
  busy: boolean;
  onChange: (patch: Partial<EditorStep>) => void;
  onRemove: () => void;
}) {
  const label = stepLabel(index);
  return (
    <Frame>
      <FrameHeader
        title={<span className="flex items-center gap-2">
          <span className={cn("flex size-5 items-center justify-center rounded-full text-label-xs", index === 0 ? "bg-primary-base text-primary-contrast" : "bg-bg-white-0 text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200")}>{index + 1}</span>
          {label}
        </span>}
        description={index === 0 ? "Created as soon as a reply is classified." : "Prepared only when there is no newer inbound reply."}
        actions={index > 0 && (
          <Button.Root variant="error" mode="ghost" size="xsmall" disabled={busy} onClick={onRemove} aria-label={`Remove ${label}`}>
            <Button.Icon as={RiDeleteBinLine} />
          </Button.Root>
        )}
      />
      <FramePanel>
        <label className="block text-paragraph-sm">
          <span className="mb-1.5 block text-label-xs text-text-sub-600">Message goal</span>
          <textarea
            required
            maxLength={8000}
            rows={3}
            disabled={busy}
            value={step.messageGoal}
            onChange={(event) => onChange({ messageGoal: event.target.value })}
            className={`${inputClass} resize-y`}
            placeholder={index === 0
              ? "For example: Answer their question clearly and suggest a suitable next step."
              : "For example: Share one useful proof point and ask whether they want to continue."}
          />
          <span className="mt-1 block text-paragraph-xs text-text-soft-400">
            Describe the outcome and tone. AI will use the Person, company, thread, classification, and Knowledge context.
          </span>
        </label>
      </FramePanel>
    </Frame>
  );
}
