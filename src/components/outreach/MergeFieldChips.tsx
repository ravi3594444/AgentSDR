"use client";

import { useEffect, useMemo, useState } from "react";
import { RiArrowDownSLine, RiBracesLine, RiQuillPenLine, RiSearchLine } from "@remixicon/react";

import * as Button from "@/components/alignui/button";
import * as Popover from "@/components/alignui/popover";

type MergeField = { token: string; label: string };

/** Shown until the campaign's own columns load, and if it has no leads yet. */
const DEFAULT_FIELDS: MergeField[] = [
  { token: "firstName", label: "First name" },
  { token: "lastName", label: "Last name" },
  { token: "company", label: "Company" },
];

/**
 * The toolbar above a subject/body field: "Insert field" opens a searchable
 * list of {{mergeFields}}, "Signature" inserts %signature%, and a hint for
 * {A|B} spin text. Inserts at the field's cursor (or over a selection) rather
 * than appending.
 *
 * The field list comes from the campaign's imported leads, so every column of
 * the uploaded CSV/XLSX is offered — a long list, hence a picker, not chips.
 */
export default function MergeFieldChips({
  campaignId,
  targetRef,
  value,
  onChange,
}: {
  campaignId: string;
  targetRef: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  value: string;
  onChange: (next: string) => void;
}) {
  const [fields, setFields] = useState<MergeField[]>(DEFAULT_FIELDS);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/outreach/campaigns/${campaignId}/merge-fields`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        // Keep the defaults if the campaign has no leads imported yet — an
        // empty list would read as "merge fields aren't supported".
        if (cancelled || !data?.fields?.length) return;
        setFields(data.fields as MergeField[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  const matches = useMemo(() => {
    const term = query.trim().toLowerCase();
    return term ? fields.filter((f) => f.token.toLowerCase().includes(term) || f.label.toLowerCase().includes(term)) : fields;
  }, [fields, query]);

  function insert(token: string) {
    const el = targetRef.current;
    if (!el) {
      onChange(value + token);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(next);
    // Restore focus + caret after the inserted token once React re-renders.
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}>
        <Popover.Trigger asChild>
          <Button.Root variant="neutral" mode="stroke" size="xsmall">
            <Button.Icon as={RiBracesLine} />
            Insert field
            <span className="tabular-nums text-text-soft-400">{fields.length}</span>
            <Button.Icon as={RiArrowDownSLine} />
          </Button.Root>
        </Popover.Trigger>
        {/* Keep focus in the email field after inserting, not on the trigger. */}
        <Popover.Content align="start" sideOffset={6} showArrow={false} className="w-72 p-1.5" onCloseAutoFocus={(e) => e.preventDefault()}>
          <div className="flex items-center gap-2 border-b border-stroke-soft-200 px-2 pb-2 pt-1">
            <RiSearchLine className="size-4 shrink-0 text-text-soft-400" aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search fields…"
              aria-label="Search merge fields"
              className="min-w-0 flex-1 bg-transparent text-paragraph-sm text-text-strong-950 outline-none placeholder:text-text-soft-400"
            />
          </div>
          <ul className="mt-1 max-h-72 overflow-y-auto">
            {matches.length === 0 ? (
              <li className="px-2 py-6 text-center text-paragraph-xs text-text-sub-600">No field matches “{query}”.</li>
            ) : (
              matches.map((f) => (
                <li key={f.token}>
                  <button
                    type="button"
                    onClick={() => {
                      insert(`{{${f.token}}}`);
                      setOpen(false);
                      setQuery("");
                    }}
                    className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left outline-none transition hover:bg-bg-weak-50 focus-visible:bg-bg-weak-50"
                  >
                    <span className="min-w-0 truncate text-paragraph-sm text-text-strong-950">{f.label}</span>
                    <span className="max-w-36 shrink-0 truncate font-mono text-[13px] text-text-soft-400">{`{{${f.token}}}`}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </Popover.Content>
      </Popover.Root>

      <Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={() => insert("%signature%")} title="Replaced with the sending mailbox's signature">
        <Button.Icon as={RiQuillPenLine} />
        Signature
      </Button.Root>

      <span className="text-paragraph-xs text-text-soft-400">
        <span className="font-mono">{"{A|B}"}</span> picks one variant per lead
      </span>
    </div>
  );
}
