"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { RiExternalLinkLine, RiGlobalLine, RiLoader4Line, RiSearchEyeLine } from "@remixicon/react";
import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Modal from "@/components/alignui/modal";
import * as Select from "@/components/alignui/select";
import * as Textarea from "@/components/alignui/textarea";
import { MAX_CUSTOM_QUESTION_LENGTH, RESEARCH_KIND_LABELS } from "@/lib/research/research";
import type { ResearchKind, ResearchSource, ResearchStatus } from "@/lib/research/schema";
import type { CompanyRow } from "./leadTypes";

type Research = {
  id: string;
  kind: ResearchKind;
  question: string;
  status: ResearchStatus;
  answer: string | null;
  sources: ResearchSource[];
  model: string | null;
  costUsd: number | null;
  error: string | null;
  createdAt: string;
};

const STATUS_BADGE: Record<ResearchStatus, { label: string; color: "green" | "gray" | "red" }> = {
  succeeded: { label: "Answered", color: "green" },
  not_found: { label: "Not found", color: "gray" },
  failed: { label: "Failed", color: "red" },
};

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Search models answer in light Markdown; show it as plain text ([n] markers stay, they point at the sources). */
function plainAnswer(answer: string) {
  return answer.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/^#{1,6}\s+/gm, "");
}

function ResearchEntry({ entry }: { entry: Research }) {
  const badge = STATUS_BADGE[entry.status];
  return (
    <li className="rounded-xl border border-stroke-soft-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge.Root size="small" variant="lighter" color={badge.color}>{badge.label}</Badge.Root>
        <span className="text-label-xs text-text-sub-600">{RESEARCH_KIND_LABELS[entry.kind]}</span>
        <span className="ml-auto text-paragraph-xs text-text-soft-400">
          {new Date(entry.createdAt).toLocaleString()}{entry.model ? ` · ${entry.model}` : ""}{entry.costUsd !== null ? ` · $${entry.costUsd.toFixed(4)}` : ""}
        </span>
      </div>
      <p className="mt-2 text-paragraph-xs text-text-soft-400">{entry.question}</p>
      {entry.answer && <p className="mt-2 whitespace-pre-wrap text-paragraph-sm text-text-strong-950">{plainAnswer(entry.answer)}</p>}
      {entry.status === "not_found" && <p className="mt-2 text-paragraph-sm text-text-sub-600">The search results did not answer this question.</p>}
      {entry.error && <p role="alert" className="mt-2 text-paragraph-sm text-error-base">{entry.error}</p>}
      {entry.sources.length > 0 && (
        <ol className="mt-3 space-y-1 text-paragraph-xs">
          {entry.sources.map((source, index) => (
            <li key={source.url} className="flex min-w-0 gap-1.5">
              <span className="shrink-0 tabular-nums text-text-soft-400">[{index + 1}]</span>
              <a href={source.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1 text-primary-base hover:underline">
                <span className="truncate">{source.title ?? hostOf(source.url)}</span>
                <RiExternalLinkLine className="size-3 shrink-0" aria-hidden="true" />
              </a>
              {source.title && <span className="hidden shrink-0 text-text-soft-400 sm:inline">{hostOf(source.url)}</span>}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

/**
 * Web research about one company: ask, see the answer with its numbered
 * sources, and the company's earlier research. The scope line is deliberate:
 * this answers a question about a company already imported; it does not find
 * leads or read social media.
 */
export function CompanyResearchModal({ row, onClose }: { row: CompanyRow; onClose: () => void }) {
  const company = row.company;
  const name = company.name || company.domain;
  const [kind, setKind] = useState<ResearchKind>("company");
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<Research[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/leads/companies/${company.id}/research`)
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { research?: Research[]; error?: string };
        if (!response.ok) throw new Error(data.error ?? `Could not load research (HTTP ${response.status})`);
        if (!cancelled) setHistory(data.research ?? []);
      })
      .catch((cause) => { if (!cancelled) { setLoadError(cause instanceof Error ? cause.message : "Could not load research"); setHistory([]); } });
    return () => { cancelled = true; };
  }, [company.id]);

  async function run() {
    setRunning(true);
    setRunError("");
    try {
      const response = await fetch(`/api/leads/companies/${company.id}/research`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, question: kind === "question" ? question : undefined }),
      });
      const data = await response.json().catch(() => ({})) as { research?: Research; error?: string };
      if (!response.ok || !data.research) throw new Error(data.error ?? `Research failed (HTTP ${response.status})`);
      setHistory((previous) => [data.research!, ...(previous ?? [])]);
    } catch (cause) {
      setRunError(cause instanceof Error ? cause.message : "Research failed");
    } finally {
      setRunning(false);
    }
  }

  const needsSettings = /Settings → AI provider/.test(runError) || /Settings → AI provider/.test(loadError);

  return (
    <Modal.Root open onOpenChange={(open) => { if (!open && !running) onClose(); }}>
      <Modal.Content size="max-w-2xl">
        <Modal.Header icon={RiSearchEyeLine}>
          <Modal.Title>Research {name}</Modal.Title>
          <Modal.Description>
            Answers one question about this company from public web pages and saves the answer with its sources. It does not find new leads or read social media.
          </Modal.Description>
        </Modal.Header>
        <Modal.Body>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <Select.Root size="small" value={kind} onValueChange={(value) => setKind(value as ResearchKind)} disabled={running}>
              <Select.Trigger aria-label="What to research" className="sm:w-48">
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {(Object.keys(RESEARCH_KIND_LABELS) as ResearchKind[]).map((key) => (
                  <Select.Item key={key} value={key}>{RESEARCH_KIND_LABELS[key]}</Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
            {kind === "question" ? (
              <Textarea.Root
                simple
                rows={2}
                maxLength={MAX_CUSTOM_QUESTION_LENGTH}
                aria-label="Your question"
                placeholder={`e.g. Does ${name} sell in Germany?`}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                disabled={running}
                className="min-w-0 flex-1"
              />
            ) : (
              <p className="flex min-w-0 flex-1 items-center gap-1.5 self-center text-paragraph-xs text-text-sub-600">
                <RiGlobalLine className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{company.domain}</span>
              </p>
            )}
            <Button.Root variant="primary" mode="filled" size="small" onClick={() => void run()} disabled={running || (kind === "question" && !question.trim())}>
              {running && <Button.Icon as={RiLoader4Line} className="animate-spin" />}
              {running ? "Researching…" : "Research"}
            </Button.Root>
          </div>
          {running && <p role="status" className="mt-2 text-paragraph-xs text-text-sub-600">Searching the web; this usually takes 5–30 seconds.</p>}
          {runError && (
            <p role="alert" className="mt-3 text-paragraph-sm text-error-base">
              {runError}{needsSettings && <> <Link href="/settings/ai" className="underline">Open AI settings</Link></>}
            </p>
          )}

          <div className="mt-5">
            {history === null ? (
              <p role="status" className="flex items-center gap-2 text-paragraph-sm text-text-sub-600"><RiLoader4Line className="size-4 animate-spin" aria-hidden="true" />Loading earlier research…</p>
            ) : loadError ? (
              <p role="alert" className="text-paragraph-sm text-error-base">{loadError}</p>
            ) : history.length === 0 ? (
              <p className="text-paragraph-sm text-text-soft-400">No research on this company yet.</p>
            ) : (
              <ul className="max-h-[50vh] space-y-3 overflow-y-auto">
                {history.map((entry) => <ResearchEntry key={entry.id} entry={entry} />)}
              </ul>
            )}
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button.Root variant="neutral" mode="stroke" size="small" onClick={onClose} disabled={running}>Close</Button.Root>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
