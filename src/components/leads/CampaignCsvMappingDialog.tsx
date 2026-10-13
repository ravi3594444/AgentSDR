"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { AlertCircle, ArrowRight, CheckCircle2, FileSpreadsheet, Loader2 } from "lucide-react";

import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Modal from "@/components/alignui/modal";
import * as Select from "@/components/alignui/select";
import { WHATSAPP_CAMPAIGN_IMPORT_FIELDS } from "@/lib/whatsapp/campaigns/contract";
import { spreadsheetUploadProblem, SPREADSHEET_UPLOAD_MAX_BYTES } from "@/lib/spreadsheet/upload";

type Channel = "email" | "linkedin" | "whatsapp";

const CHANNEL_NAME: Record<Channel, string> = { email: "email", linkedin: "LinkedIn", whatsapp: "WhatsApp" };
type Preview = {
  headers: string[];
  rows: string[][];
  totalRows: number;
  suggestedMapping: Record<string, string>;
};
type Operation = "preview" | "import" | null;

const FIELDS: Record<Channel, { key: string; label: string; required?: boolean }[]> = {
  email: [
    { key: "email", label: "Email", required: true },
    { key: "linkedinUrl", label: "LinkedIn URL" },
    { key: "firstName", label: "First name" },
    { key: "lastName", label: "Last name" },
    { key: "fullName", label: "Full name" },
    { key: "title", label: "Job title" },
    { key: "companyName", label: "Company name" },
    { key: "companyDomain", label: "Company domain" },
    { key: "companyLinkedinUrl", label: "Company LinkedIn" },
  ],
  linkedin: [
    { key: "linkedinUrl", label: "LinkedIn URL or provider ID", required: true },
    { key: "linkedinApi", label: "LinkedIn source type" },
    { key: "email", label: "Email" },
    { key: "firstName", label: "First name" },
    { key: "lastName", label: "Last name" },
    { key: "name", label: "Full name" },
    { key: "headline", label: "Job title / headline" },
    { key: "companyName", label: "Company name" },
    { key: "companyDomain", label: "Company domain" },
    { key: "companyLinkedinUrl", label: "Company LinkedIn" },
    { key: "location", label: "Location" },
    { key: "profilePictureUrl", label: "Profile picture URL" },
  ],
  whatsapp: WHATSAPP_CAMPAIGN_IMPORT_FIELDS.map((field) => ({ key: field.key, label: field.label, ...("required" in field ? { required: true } : {}) })),
};

function exampleFor(header: string | undefined, preview: Preview): string {
  if (!header) return "Choose a source column";
  const index = preview.headers.indexOf(header);
  if (index < 0) return "Column unavailable";
  const values = preview.rows
    .map((row) => String(row[index] ?? "").trim())
    .filter(Boolean)
    .filter((value, valueIndex, all) => all.indexOf(value) === valueIndex)
    .slice(0, 2);
  return values.length ? values.join(" · ") : "No sample value";
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export default function CampaignCsvMappingDialog({ file, endpoint, channel, onClose, onImported }: {
  file: File;
  endpoint: string;
  channel: Channel;
  onClose: () => void;
  onImported: (result: Record<string, unknown>) => void;
}) {
  const fieldIdPrefix = useId();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  // The routes check the same; checking first spares uploading a file they would refuse.
  const uploadProblem = useMemo(
    () => spreadsheetUploadProblem(file, channel === "whatsapp" ? 2 * SPREADSHEET_UPLOAD_MAX_BYTES : SPREADSHEET_UPLOAD_MAX_BYTES),
    [channel, file],
  );
  const [busyState, setBusy] = useState(true);
  const busy = busyState && !uploadProblem;
  const [operation, setOperation] = useState<Operation>("preview");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [errorState, setError] = useState<string | null>(null);
  const error = errorState ?? uploadProblem;

  useEffect(() => {
    if (uploadProblem) return;
    let cancelled = false;
    const form = new FormData();
    form.append("file", file);
    form.append("mode", "preview");
    fetch(endpoint, { method: "POST", body: form })
      .then(async (response) => ({ response, data: await response.json().catch(() => ({})) }))
      .then(({ response, data }) => {
        if (cancelled) return;
        if (!response.ok) throw new Error(data.error ?? "Could not preview file");
        setPreview(data);
        setMapping(data.suggestedMapping ?? {});
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not preview file");
      })
      .finally(() => {
        if (!cancelled) {
          setBusy(false);
          setOperation(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint, file, uploadProblem]);

  useEffect(() => {
    if (operation !== "import") return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [operation]);

  const fields = FIELDS[channel];
  const required = fields.find((field) => field.required)!;
  const selectedHeaders = Object.values(mapping).filter(Boolean);
  const mappedHeaders = new Set(selectedHeaders);
  const duplicateHeaders = useMemo(() => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const header of selectedHeaders) {
      if (seen.has(header)) duplicates.add(header);
      seen.add(header);
    }
    return duplicates;
  }, [selectedHeaders]);
  const mappedFieldCount = fields.filter((field) => mapping[field.key]).length;
  const unmappedColumnCount = preview
    ? preview.headers.filter((header) => !mappedHeaders.has(header)).length
    : 0;
  const requiredMissing = Boolean(preview && !mapping[required.key]);

  function updateMapping(sourceHeader: string, fieldKey: string) {
    setMapping((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([key, header]) => key !== fieldKey && header !== sourceHeader),
      );
      if (fieldKey) next[fieldKey] = sourceHeader;
      return next;
    });
    setError(null);
  }

  async function submit() {
    if (requiredMissing) {
      setError(`Choose a source column for ${required.label}.`);
      return;
    }
    if (duplicateHeaders.size) {
      setError("Each source column can map to only one destination field.");
      return;
    }
    setBusy(true);
    setOperation("import");
    setElapsedSeconds(0);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("mapping", JSON.stringify(mapping));
      const response = await fetch(endpoint, { method: "POST", body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error ?? "Import failed");
      onImported(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Import failed");
    } finally {
      setBusy(false);
      setOperation(null);
    }
  }

  return (
    <Modal.Root open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Modal.Content size="max-w-5xl" hideClose={busy} aria-describedby={`${fieldIdPrefix}-description`}>
        <Modal.Header icon={FileSpreadsheet}>
          <Modal.Title>Map campaign columns</Modal.Title>
          <Modal.Description id={`${fieldIdPrefix}-description`}>
            Match the columns in {file.name} to the fields used by this {CHANNEL_NAME[channel]} campaign.
          </Modal.Description>
        </Modal.Header>

        <Modal.Body className="mt-5 border-t border-stroke-soft-200 p-0">
          {busy && !preview ? (
            <div className="flex min-h-72 flex-col items-center justify-center gap-3 text-center">
              <span className="flex size-10 items-center justify-center rounded-full bg-primary-alpha-10 text-primary-base">
                <Loader2 className="size-5 animate-spin" aria-hidden="true" />
              </span>
              <div>
                <p className="text-label-sm text-text-strong-950">Reading spreadsheet</p>
                <p className="mt-1 text-paragraph-xs text-text-sub-600">Preparing columns and sample values…</p>
              </div>
            </div>
          ) : null}

          {preview ? (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-stroke-soft-200 bg-bg-weak-50 px-5 py-3">
                <Badge.Root variant="lighter" color="blue">{preview.totalRows.toLocaleString()} rows</Badge.Root>
                <Badge.Root variant="lighter" color="green">{mappedFieldCount} mapped</Badge.Root>
                <Badge.Root variant="lighter" color="gray">{unmappedColumnCount} kept as variables</Badge.Root>
                <p className="w-full text-paragraph-xs text-text-sub-600 sm:ml-auto sm:w-auto">
                  One platform field can be mapped only once.
                </p>
              </div>

              <div className="p-5">
                {operation === "import" ? (
                  <div className="mb-4 flex items-start gap-2.5 rounded-xl bg-information-lighter p-3 text-information-dark ring-1 ring-inset ring-information-light" role="status" aria-live="polite">
                    <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden="true" />
                    <div>
                      <p className="text-paragraph-sm font-medium">Importing {preview.totalRows.toLocaleString()} rows…</p>
                      <p className="mt-0.5 text-paragraph-xs">
                        Saving leads and checking duplicates. Keep this window open. Elapsed: {formatElapsed(elapsedSeconds)}.
                        {elapsedSeconds >= 60 ? " Large imports can take several minutes; do not start the import again." : ""}
                      </p>
                    </div>
                  </div>
                ) : requiredMissing ? (
                  <div className="mb-4 flex items-start gap-2.5 rounded-xl bg-warning-lighter p-3 text-warning-dark ring-1 ring-inset ring-warning-light">
                    <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <p className="text-paragraph-sm">
                      Map <span className="font-semibold">{required.label}</span> before importing so every row has the required campaign identity.
                    </p>
                  </div>
                ) : (
                  <div className="mb-4 flex items-center gap-2.5 rounded-xl bg-success-lighter p-3 text-success-dark ring-1 ring-inset ring-success-light">
                    <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
                    <p className="text-paragraph-sm">Required identity column mapped. Review optional fields before importing.</p>
                  </div>
                )}

                <div className="overflow-hidden rounded-xl ring-1 ring-inset ring-stroke-soft-200">
                  <div className="hidden grid-cols-[minmax(12rem,0.9fr)_minmax(10rem,1fr)_minmax(14rem,1fr)] gap-4 bg-bg-weak-50 px-4 py-2.5 text-subheading-xs uppercase tracking-wide text-text-soft-400 sm:grid">
                    <span>Source CSV column</span>
                    <span>Example</span>
                    <span>Platform field</span>
                  </div>
                  <div className="divide-y divide-stroke-soft-200">
                    {preview.headers.map((header, headerIndex) => {
                      const selectedFieldKey = fields.find((field) => mapping[field.key] === header)?.key ?? "";
                      const controlId = `${fieldIdPrefix}-source-${headerIndex}`;
                      return (
                        <div key={`${header}-${headerIndex}`} className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(12rem,0.9fr)_minmax(10rem,1fr)_minmax(14rem,1fr)] sm:items-center sm:gap-4">
                          <label htmlFor={controlId} className="flex min-w-0 items-center gap-2 text-label-sm text-text-strong-950">
                            <span className="truncate" title={header}>{header}</span>
                          </label>
                          <p className="min-w-0 truncate text-paragraph-xs text-text-sub-600" title={exampleFor(header, preview)}>
                            <span className="mr-1 font-medium text-text-soft-400 sm:hidden">Example:</span>
                            {exampleFor(header, preview)}
                          </p>
                          <div className="flex min-w-0 items-center gap-2">
                            <ArrowRight className="hidden size-4 shrink-0 text-text-soft-400 sm:block" aria-hidden="true" />
                            <Select.Root
                              size="small"
                              value={selectedFieldKey}
                              onValueChange={(value) => updateMapping(header, value)}
                              disabled={busy}
                            >
                              <Select.Trigger id={controlId} className="min-w-0 flex-1"><Select.Value /></Select.Trigger>
                              <Select.Content>
                                <Select.Item value="">Keep as variable (do not map)</Select.Item>
                                {fields.map((field) => {
                                  const usedElsewhere = Boolean(mapping[field.key] && mapping[field.key] !== header);
                                  return (
                                    <Select.Item key={field.key} value={field.key} disabled={usedElsewhere}>
                                      {field.label}{field.required ? " — required" : ""}{usedElsewhere ? " — already mapped" : ""}
                                    </Select.Item>
                                  );
                                })}
                              </Select.Content>
                            </Select.Root>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {channel === "linkedin" ? (
                  <p className="mt-4 rounded-xl bg-information-lighter px-3.5 py-3 text-paragraph-xs text-information-dark ring-1 ring-inset ring-information-light">
                    <span className="font-semibold">LinkedIn source type is not a profile ID.</span>{" "}
                    Map it only when a CSV column contains <span className="font-mono">sales_navigator</span> or <span className="font-mono">recruiter</span>. For regular LinkedIn profile URLs, leave it unmapped.
                  </p>
                ) : null}

                <p className="mt-4 rounded-xl bg-information-lighter px-3.5 py-3 text-paragraph-xs text-information-dark ring-1 ring-inset ring-information-light">
                  Mapped profile fields update People and Company. Unmapped CSV columns are preserved in People raw data and remain available as template variables. Duplicate identities are merged{channel === "email" ? ", and suppressed recipients are skipped" : ""}.
                </p>
              </div>
            </>
          ) : null}

          {error ? (
            <div className="mx-5 mb-5 flex items-start gap-2 rounded-xl bg-error-lighter px-3.5 py-3 text-paragraph-sm text-error-dark ring-1 ring-inset ring-error-light" role="alert" aria-live="polite">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          ) : null}
        </Modal.Body>

        <Modal.Footer className="justify-between">
          <p className="hidden text-paragraph-xs text-text-sub-600 sm:block">
            {operation === "import" && preview
              ? `Processing ${preview.totalRows.toLocaleString()} rows · ${formatElapsed(elapsedSeconds)} elapsed`
              : preview
                ? `${mappedHeaders.size} of ${preview.headers.length} source columns mapped`
                : "Preparing preview"}
          </p>
          <div className="ml-auto flex items-center gap-2">
            <Button.Root type="button" variant="neutral" mode="stroke" size="small" onClick={onClose} disabled={busy}>
              Cancel
            </Button.Root>
            <Button.Root type="button" variant="primary" mode="filled" size="small" onClick={() => void submit()} disabled={busy || !preview || requiredMissing || duplicateHeaders.size > 0}>
              {busy ? <Button.Icon as={Loader2} className="animate-spin" /> : <Button.Icon as={FileSpreadsheet} />}
              {operation === "import" ? `Importing ${preview?.totalRows.toLocaleString() ?? ""} rows…` : `Import ${preview ? preview.totalRows.toLocaleString() : ""} rows`}
            </Button.Root>
          </div>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
