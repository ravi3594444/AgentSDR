"use client";

import { useRef, useState } from "react";
import {
  RiAddLine,
  RiArrowLeftLine,
  RiDeleteBinLine,
  RiEyeLine,
  RiTimeLine,
} from "@remixicon/react";

import * as Button from "@/components/alignui/button";
import * as Input from "@/components/alignui/input";
import * as Textarea from "@/components/alignui/textarea";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { cn } from "@/utils/cn";
import type { SequenceStep } from "@/lib/outreach/schema";
import MergeFieldChips from "./MergeFieldChips";
import PreviewModal from "./PreviewModal";

function emptyStep(stepNumber: number): SequenceStep {
  return {
    stepNumber,
    subject: "",
    body: "",
    waitDays: stepNumber === 1 ? 0 : 3,
  };
}

function sequenceError(steps: SequenceStep[]): string | null {
  if (!steps[0]?.subject.trim()) return "The initial email needs a subject.";
  const emptyBody = steps.findIndex((step) => !step.body.trim());
  if (emptyBody >= 0) return `Email step ${emptyBody + 1} needs a message body.`;
  return null;
}

export default function SequenceComposer({
  campaignId,
  initialSequence,
  onBack,
  onSaved,
  saveLabel = "Save",
  savingLabel = "Saving…",
}: {
  campaignId: string;
  initialSequence: SequenceStep[];
  onBack?: () => void;
  onSaved?: (sequence: SequenceStep[]) => void;
  saveLabel?: string;
  savingLabel?: string;
}) {
  const [steps, setSteps] = useState<SequenceStep[]>(
    initialSequence.length > 0 ? initialSequence : [emptyStep(1)],
  );
  const [selected, setSelected] = useState(0);
  const [saving, setSaving] = useState(false);
  const [previewStep, setPreviewStep] = useState<SequenceStep | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  // Guards against the selected index dangling after a removal.
  const index = Math.min(selected, steps.length - 1);
  const step = steps[index];

  function updateStep(i: number, patch: Partial<SequenceStep>) {
    setSavedAt(null);
    setError(null);
    setSteps((prev) => prev.map((item, n) => (n === i ? { ...item, ...patch } : item)));
  }

  function addStep() {
    setSavedAt(null);
    setError(null);
    setSteps((prev) => [...prev, emptyStep(prev.length + 1)]);
    setSelected(steps.length);
  }

  function removeStep(i: number) {
    setSavedAt(null);
    setError(null);
    setSteps((prev) =>
      prev.filter((_, n) => n !== i).map((item, n) => ({ ...item, stepNumber: n + 1 })),
    );
    setSelected((prev) => Math.max(0, prev > i ? prev - 1 : prev));
  }

  async function handleSave() {
    const validationError = sequenceError(steps);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/outreach/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sequence: steps }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error ?? "Failed to save sequence");
        return;
      }
      setSavedAt(Date.now());
      onSaved?.(steps);
    } catch {
      setError("Failed to save sequence. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <Frame>
          <FrameHeader
            title="Sequence flow"
            description={`${steps.length} ${steps.length === 1 ? "email" : "emails"}, in order. Select one to edit it.`}
          />
          <FramePanel className="p-2 sm:p-3">
            <div className="flex flex-col">
              {steps.map((item, i) => (
                <div key={i}>
                  {i > 0 && (
                    <div className="flex items-center gap-2 py-2 pl-3">
                      <span className="h-6 w-px bg-stroke-soft-200" />
                      <span className="flex items-center gap-1.5 text-paragraph-xs text-text-sub-600">
                        <RiTimeLine className="size-3.5 text-text-soft-400" />
                        Wait
                        <input
                          type="number"
                          min={1}
                          value={item.waitDays}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) =>
                            updateStep(i, {
                              waitDays: Number(event.target.value) || 1,
                            })
                          }
                          className="h-6 w-11 rounded-md bg-bg-weak-50 px-1 text-center text-paragraph-xs text-text-strong-950 outline-none ring-1 ring-inset ring-stroke-soft-200 focus:ring-primary-base"
                          aria-label={`Wait days before email step ${item.stepNumber}`}
                        />
                        days
                      </span>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => setSelected(i)}
                    className={cn(
                      "group/step flex w-full items-start gap-2.5 rounded-xl p-3 text-left",
                      "transition duration-200 ease-out",
                      index === i
                        ? "bg-primary-alpha-10 ring-1 ring-inset ring-primary-base"
                        : "hover:bg-bg-weak-50",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded-md text-label-xs",
                        index === i
                          ? "bg-primary-base text-primary-contrast"
                          : "bg-bg-weak-50 text-text-sub-600",
                      )}
                    >
                      {item.stepNumber}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-label-sm text-text-strong-950">
                        Email step {item.stepNumber}
                      </span>
                      <span className="mt-0.5 block truncate text-paragraph-xs text-text-soft-400">
                        {item.subject.trim() || (i === 0 ? "No subject yet" : "Same thread")}
                      </span>
                    </span>
                    {steps.length > 1 && (
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label={`Remove step ${item.stepNumber}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          removeStep(i);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            event.stopPropagation();
                            removeStep(i);
                          }
                        }}
                        className="shrink-0 rounded p-0.5 text-text-soft-400 opacity-0 transition duration-200 ease-out hover:text-error-base focus:opacity-100 group-hover/step:opacity-100"
                      >
                        <RiDeleteBinLine className="size-4" />
                      </span>
                    )}
                  </button>
                </div>
              ))}
            </div>

            <Button.Root
              variant="neutral"
              mode="stroke"
              size="xsmall"
              className="mt-3 w-full"
              onClick={addStep}
            >
              <Button.Icon as={RiAddLine} />
              Add follow-up
            </Button.Root>
          </FramePanel>
        </Frame>

        <Frame>
          <FrameHeader
            title={index === 0 ? "Initial email" : `Follow-up ${index}`}
            description={
              index === 0
                ? "Sends as soon as the campaign starts."
                : `Sends ${step.waitDays} day${step.waitDays === 1 ? "" : "s"} after the previous step.`
            }
            actions={
              <Button.Root
                variant="neutral"
                mode="stroke"
                size="xsmall"
                onClick={() => setPreviewStep(step)}
              >
                <Button.Icon as={RiEyeLine} />
                Preview
              </Button.Root>
            }
          />
          <FramePanel>
            <div>
              <label
                htmlFor={`subject-${index}`}
                className="mb-1.5 block text-label-sm text-text-strong-950"
              >
                Subject
              </label>
              <Input.Root size="small">
                <Input.Wrapper>
                  <Input.Input
                    id={`subject-${index}`}
                    placeholder={
                      index === 0 ? "Subject" : "Leave blank to continue the same thread"
                    }
                    value={step.subject}
                    onChange={(event) => updateStep(index, { subject: event.target.value })}
                  />
                </Input.Wrapper>
              </Input.Root>
            </div>

            <div className="mt-4">
              <label
                htmlFor={`body-${index}`}
                className="mb-1.5 block text-label-sm text-text-strong-950"
              >
                Email body
              </label>
              <MergeFieldChips
                campaignId={campaignId}
                targetRef={bodyRef}
                value={step.body}
                onChange={(next) => updateStep(index, { body: next })}
              />
              <div>
                <Textarea.Root
                  id={`body-${index}`}
                  ref={bodyRef}
                  simple
                  rows={12}
                  placeholder="Write your email — {A|B} picks one at random, {{firstName}} merges a field"
                  value={step.body}
                  onChange={(event) => updateStep(index, { body: event.target.value })}
                  className="min-h-64"
                />
              </div>
            </div>
          </FramePanel>
        </Frame>
      </div>

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-xl bg-error-lighter px-4 py-3 text-paragraph-sm text-error-base"
        >
          {error}
        </div>
      )}

      <div className="mt-5 flex items-center justify-between gap-3 border-t border-stroke-soft-200 pt-5">
        <div>
          {onBack && (
            <Button.Root variant="neutral" mode="stroke" size="small" onClick={onBack}>
              <Button.Icon as={RiArrowLeftLine} />
              Back
            </Button.Root>
          )}
        </div>
        <div className="flex items-center gap-3">
          {savedAt && !saving && <span className="text-paragraph-xs text-success-base">Saved</span>}
          <Button.Root
            variant="primary"
            mode="filled"
            size="small"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? savingLabel : saveLabel}
          </Button.Root>
        </div>
      </div>

      {previewStep && (
        <PreviewModal
          campaignId={campaignId}
          step={previewStep}
          onClose={() => setPreviewStep(null)}
        />
      )}
    </div>
  );
}
