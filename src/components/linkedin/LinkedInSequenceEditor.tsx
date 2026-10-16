"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, Eye, Loader2, Save, Timer } from "lucide-react";
import * as AlignButton from "@/components/alignui/button";
import * as Modal from "@/components/alignui/modal";
import * as Select from "@/components/alignui/select";
import * as Textarea from "@/components/alignui/textarea";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import {
  EMPTY_LINKEDIN_SEQUENCE,
  LINKEDIN_SEQUENCE_STEPS,
  linkedinSequenceError,
  normalizeLinkedinSequence,
  type LinkedinCampaignSequence,
  type LinkedinSequenceField,
} from "@/lib/linkedin/campaignSequence";
import { MAX_INVITATION_MESSAGE_LENGTH } from "@/lib/linkedin/invitationMessage";
import { cn } from "@/utils/cn";

type MergeField = { token: string; label: string };
type PreviewLead = { id: string; name: string | null; linkedinUrl: string };
type PreviewResult = {
  rendered: string;
  unresolved: string[];
  exceedsInvitationLimit: boolean;
  lead: PreviewLead;
};

const DEFAULT_FIELDS: MergeField[] = [
  { token: "firstName", label: "First name" },
  { token: "lastName", label: "Last name" },
  { token: "company", label: "Company" },
];

function sequenceFromNullable(input: Partial<Record<LinkedinSequenceField, string | null>>): LinkedinCampaignSequence {
  return normalizeLinkedinSequence(input);
}

export function LinkedInSequenceEditor({
  campaignId,
  initialSequence,
  onSaved,
  saveLabel = "Save sequence",
}: {
  campaignId: string;
  initialSequence?: Partial<Record<LinkedinSequenceField, string | null>>;
  onSaved?: (sequence: LinkedinCampaignSequence) => void;
  saveLabel?: string;
}) {
  const [sequence, setSequence] = useState<LinkedinCampaignSequence>(() =>
    sequenceFromNullable(initialSequence ?? EMPTY_LINKEDIN_SEQUENCE),
  );
  const [selected, setSelected] = useState(0);
  const [fields, setFields] = useState<MergeField[]>(DEFAULT_FIELDS);
  const [leads, setLeads] = useState<PreviewLead[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLeadId, setPreviewLeadId] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/linkedin/campaigns/${campaignId}/merge-fields`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        if (Array.isArray(data.fields) && data.fields.length) setFields(data.fields);
        if (Array.isArray(data.leads)) {
          setLeads(data.leads);
          setPreviewLeadId((current) => current || data.leads[0]?.id || "");
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [campaignId]);

  const step = LINKEDIN_SEQUENCE_STEPS[selected]!;
  const validationError = useMemo(() => linkedinSequenceError(sequence), [sequence]);

  function update(field: LinkedinSequenceField, value: string) {
    setSaved(false);
    setError(null);
    setSequence((current) => ({ ...current, [field]: value }));
  }

  function insertToken(token: string) {
    const value = sequence[step.field];
    const input = editorRef.current;
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}{{${token}}}${value.slice(end)}`;
    update(step.field, next);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + token.length + 4, start + token.length + 4);
    });
  }

  async function save() {
    const issue = linkedinSequenceError(sequence);
    if (issue) { setError(issue); return; }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/linkedin/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sequence),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error ?? "Could not save sequence");
      const normalized = normalizeLinkedinSequence(sequence);
      setSequence(normalized);
      setSaved(true);
      onSaved?.(normalized);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save sequence");
    } finally {
      setSaving(false);
    }
  }

  async function renderPreview(leadId = previewLeadId) {
    setPreviewing(true);
    setPreviewError(null);
    try {
      const response = await fetch(`/api/linkedin/campaigns/${campaignId}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field: step.field, template: sequence[step.field], leadId: leadId || undefined }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Could not render preview");
      setPreview(data as PreviewResult);
    } catch (cause) {
      setPreview(null);
      setPreviewError(cause instanceof Error ? cause.message : "Could not render preview");
    } finally {
      setPreviewing(false);
    }
  }

  function openPreview() {
    setPreviewOpen(true);
    void renderPreview();
  }

  return (
    <>
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)] lg:gap-5">
        <Frame>
          <FrameHeader title="Sequence flow" description="Applies to every lead, personalised at send time. Timing follows the live LinkedIn sender." />
          <FramePanel className="p-2 sm:p-2">
            <ol className="flex flex-col">
              {LINKEDIN_SEQUENCE_STEPS.map((candidate, index) => {
                const hasMessage = Boolean(sequence[candidate.field].trim());
                const active = selected === index;
                return (
                  <li key={candidate.field}>
                    {index > 0 && (
                      <div className="flex items-center gap-2 py-1.5 pl-5 text-paragraph-xs text-text-soft-400">
                        <span aria-hidden="true" className="h-4 w-px bg-stroke-soft-200" />
                        <Timer className="size-3.5" aria-hidden="true" />
                        {candidate.timing}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => setSelected(index)}
                      aria-current={active ? "step" : undefined}
                      className={cn(
                        "flex w-full items-start gap-2.5 rounded-xl p-2.5 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-primary-base",
                        active ? "bg-bg-weak-50" : "hover:bg-bg-weak-50",
                      )}
                    >
                      <span className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded-md text-label-xs",
                        active ? "bg-primary-base text-primary-contrast" : "bg-bg-weak-50 text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200",
                      )}>{index + 1}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-label-sm text-text-strong-950">{candidate.shortLabel}</span>
                        <span className="mt-0.5 block truncate text-paragraph-xs text-text-sub-600">
                          {hasMessage ? sequence[candidate.field] : "No message — optional"}
                        </span>
                      </span>
                      {hasMessage && <Check className="mt-0.5 size-4 shrink-0 text-success-base" aria-label="Written" />}
                    </button>
                  </li>
                );
              })}
            </ol>
          </FramePanel>
        </Frame>

        <Frame>
          <FrameHeader
            title={step.label}
            description={step.description}
            actions={
              <AlignButton.Root variant="neutral" mode="stroke" size="xsmall" onClick={openPreview}>
                <AlignButton.Icon as={Eye} />Preview
              </AlignButton.Root>
            }
          />
          <FramePanel>
            <p className="mb-2 text-paragraph-xs text-text-sub-600">Merge fields from People and imported raw columns — click one to insert it.</p>
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
                rows={10}
                aria-label={step.label}
                maxLength={step.field === "invitationMessage" ? MAX_INVITATION_MESSAGE_LENGTH : undefined}
                value={sequence[step.field]}
                onChange={(event) => update(step.field, event.target.value)}
                placeholder={`Write your ${step.label.toLowerCase()}…`}
                className="min-h-56"
                hasError={Boolean(validationError)}
              />
              {step.field === "invitationMessage" && (
                <p className="mt-1.5 text-right text-paragraph-xs tabular-nums text-text-soft-400">
                  {sequence.invitationMessage.length}/{MAX_INVITATION_MESSAGE_LENGTH}
                </p>
              )}
            </div>

            {(validationError || error) && (
              <p role="alert" className="mt-4 flex items-center gap-2 rounded-xl bg-error-lighter px-3 py-2 text-paragraph-sm text-error-base">
                <AlertCircle className="size-4 shrink-0" />{error ?? validationError}
              </p>
            )}
            <div className="mt-5 flex items-center justify-end gap-3 border-t border-stroke-soft-200 pt-4">
              {saved && <span role="status" className="text-paragraph-xs text-success-base">Saved</span>}
              <AlignButton.Root variant="primary" mode="filled" size="small" onClick={() => void save()} disabled={saving || Boolean(validationError)}>
                <AlignButton.Icon as={saving ? Loader2 : Save} className={saving ? "animate-spin" : undefined} />
                {saving ? "Saving…" : saveLabel}
              </AlignButton.Root>
            </div>
          </FramePanel>
        </Frame>
      </div>

      <Modal.Root open={previewOpen} onOpenChange={setPreviewOpen}>
        <Modal.Content size="max-w-2xl">
          <Modal.Header>
            <div>
              <Modal.Title>Preview · {step.label}</Modal.Title>
              <Modal.Description>This uses the same People variables and rendering path as the live sender.</Modal.Description>
            </div>
          </Modal.Header>
          <Modal.Body>
            {leads.length > 0 && (
              <label className="block text-label-sm text-text-strong-950">
                Preview as
                <Select.Root size="small" value={previewLeadId} onValueChange={(value) => { setPreviewLeadId(value); void renderPreview(value); }}>
                  <Select.Trigger className="mt-1.5 w-full"><Select.Value /></Select.Trigger>
                  <Select.Content>
                    {leads.map((lead) => <Select.Item key={lead.id} value={lead.id}>{lead.name || lead.linkedinUrl}</Select.Item>)}
                  </Select.Content>
                </Select.Root>
              </label>
            )}
            <div className="mt-4 min-h-36 rounded-xl bg-bg-weak-50 p-4 ring-1 ring-inset ring-stroke-soft-200">
              {previewing ? (
                <div className="flex h-28 items-center justify-center gap-2 text-paragraph-sm text-text-sub-600"><Loader2 className="size-4 animate-spin" />Rendering preview…</div>
              ) : previewError ? (
                <p className="text-paragraph-sm text-error-base">{previewError}</p>
              ) : preview ? (
                <>
                  {preview.unresolved.length > 0 && (
                    <p className="mb-3 rounded-lg bg-warning-lighter px-3 py-2 text-paragraph-xs text-warning-dark">
                      Empty for this person: {preview.unresolved.map((token) => `{{${token}}}`).join(", ")}
                    </p>
                  )}
                  {preview.exceedsInvitationLimit && (
                    <p className="mb-3 rounded-lg bg-red-alpha-10 px-3 py-2 text-paragraph-xs text-error-base">This rendered invitation exceeds 300 characters.</p>
                  )}
                  <p className="whitespace-pre-wrap break-words text-paragraph-sm leading-6 text-text-strong-950">{preview.rendered || "(No message — this step will be skipped.)"}</p>
                </>
              ) : null}
            </div>
          </Modal.Body>
          <Modal.Footer>
            <AlignButton.Root variant="neutral" mode="stroke" size="small" onClick={() => void renderPreview()} disabled={previewing}>Render again</AlignButton.Root>
            <Modal.Close asChild><AlignButton.Root variant="primary" mode="filled" size="small">Done</AlignButton.Root></Modal.Close>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>
    </>
  );
}
