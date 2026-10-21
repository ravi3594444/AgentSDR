"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- the template is a file download from an API route, not a page */

import { useRef, useState } from "react";
import { RiDownloadLine, RiUploadCloud2Line } from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Modal from "@/components/alignui/modal";
import { spreadsheetUploadProblem } from "@/lib/spreadsheet/upload";

type ImportResult = {
  total: number;
  created: number;
  updated: number;
  failed: Array<{ row: number; identity: string; error: string }>;
  /** Of the created/updated, people known only by phone (for WhatsApp). */
  phoneOnly?: number;
  /** Imported rows whose phone was not saved, and why. */
  warnings?: Array<{ row: number; identity: string; message: string }>;
  /** Rows with no Email, LinkedIn URL or phone, left out. */
  skippedNoIdentity?: number;
};

export function PeopleImportModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);

  async function submit() {
    const file = fileRef.current?.files?.[0];
    if (!file) return setError("Choose a file first");
    const problem = spreadsheetUploadProblem(file);
    if (problem) return setError(problem);
    setSubmitting(true); setError(""); setResult(null);
    try {
      const form = new FormData(); form.append("file", file);
      const response = await fetch("/api/leads/people/import", { method: "POST", body: form });
      const data = await response.json().catch(() => ({})) as ImportResult & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `Import failed (HTTP ${response.status})`);
      setResult(data); onImported();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Import failed");
    } finally { setSubmitting(false); }
  }

  return (
    <Modal.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Modal.Content size="max-w-lg">
        <Modal.Header icon={RiUploadCloud2Line}>
          <Modal.Title>Import people</Modal.Title>
          <Modal.Description>Creates or updates People by Email or LinkedIn URL, or by phone number when a row has neither (for WhatsApp). CRM records begin after a reply.</Modal.Description>
        </Modal.Header>
        <Modal.Body>
          <a href="/api/leads/people/import/template" className="inline-flex items-center gap-1.5 text-label-sm text-primary-base hover:underline"><RiDownloadLine className="size-4" aria-hidden="true" />Download Excel template</a>
          <label className="mt-3 flex cursor-pointer flex-col items-center gap-1 rounded-xl border border-dashed border-stroke-soft-200 px-4 py-8 text-center transition hover:border-primary-base hover:bg-bg-weak-50">
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="sr-only" onChange={(event) => setFileName(event.target.files?.[0]?.name ?? "")} />
            <RiUploadCloud2Line className="size-6 text-text-soft-400" aria-hidden="true" />
            <span className="text-paragraph-sm text-text-sub-600">{fileName || "Choose an .xlsx or .csv file"}</span>
            <span className="text-paragraph-xs text-text-soft-400">Up to 10 MB and 5,000 rows. Local numbers without + use the Default phone country (Settings → Sending defaults).</span>
          </label>
          {error && <p role="alert" className="mt-3 text-paragraph-sm text-error-base">{error}</p>}
          {result && (
            <div className="mt-4 rounded-xl bg-bg-weak-50 p-3 text-paragraph-sm text-text-sub-600">
              <p role="status">{result.total} processed · {result.created} created · {result.updated} updated · {result.failed.length} failed</p>
              {!!result.phoneOnly && <p className="mt-1">{result.phoneOnly} of them by phone number only (usable in WhatsApp campaigns).</p>}
              {!!result.skippedNoIdentity && <p className="mt-1">{result.skippedNoIdentity} row{result.skippedNoIdentity === 1 ? "" : "s"} skipped: no Email, LinkedIn URL or phone number.</p>}
              {result.failed.length > 0 && <ul className="mt-2 max-h-32 overflow-auto text-paragraph-xs text-error-base">{result.failed.map((failure) => <li key={`${failure.row}:${failure.identity}`}>Row {failure.row} ({failure.identity}): {failure.error}</li>)}</ul>}
              {!!result.warnings?.length && <ul className="mt-2 max-h-32 overflow-auto text-paragraph-xs text-warning-base">{result.warnings.map((warning) => <li key={`${warning.row}:${warning.identity}`}>Row {warning.row} ({warning.identity}): {warning.message}</li>)}</ul>}
            </div>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button.Root variant="neutral" mode="stroke" size="small" onClick={onClose}>{result ? "Done" : "Cancel"}</Button.Root>
          {!result && <Button.Root variant="primary" mode="filled" size="small" disabled={!fileName || submitting} onClick={submit}>{submitting ? "Importing…" : "Import"}</Button.Root>}
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
