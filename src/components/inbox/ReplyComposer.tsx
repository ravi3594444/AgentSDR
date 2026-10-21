"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Highlight from "@tiptap/extension-highlight";
import { useEffect, useState, type ComponentType } from "react";
import {
  RiBold,
  RiCloseLine,
  RiItalic,
  RiLink,
  RiListUnordered,
  RiMarkPenLine,
  RiReplyLine,
  RiSparkling2Line,
} from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import { cn } from "@/utils/cn";

type Recipient = string;

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Plain text → one <p> per paragraph, single newlines as <br/>. */
function textToHtml(text: string): string {
  const paragraphs = text.replace(/\r\n?/g, "\n").trim().split(/\n{2,}/);
  return paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`).join("");
}

const fieldRow = "flex items-start gap-2 border-b border-stroke-soft-200 px-3 py-1.5";
const fieldLabel = "w-9 shrink-0 pt-0.5 text-paragraph-xs text-text-soft-400";

function RecipientChips({
  label,
  values,
  onChange,
  trailing,
}: {
  label: string;
  values: Recipient[];
  onChange: (next: Recipient[]) => void;
  /** Right-hand slot of the row — the Cc/Bcc toggles on To, a remove button on Cc/Bcc. */
  trailing?: React.ReactNode;
}) {
  const [input, setInput] = useState("");

  function addFromInput() {
    const email = input.trim();
    if (email && email.includes("@") && !values.includes(email)) {
      onChange([...values, email]);
    }
    setInput("");
  }

  return (
    <div className={fieldRow}>
      <span className={fieldLabel}>{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {values.map((v) => (
          <span key={v} className="inline-flex max-w-full items-center gap-1 rounded-md bg-bg-weak-50 py-0.5 pl-2 pr-1 text-paragraph-xs text-text-strong-950 ring-1 ring-inset ring-stroke-soft-200">
            <span className="truncate">{v}</span>
            <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} aria-label={`Remove ${v}`} className="rounded text-text-soft-400 outline-none hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-primary-base">
              <RiCloseLine className="size-3.5" />
            </button>
          </span>
        ))}
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              addFromInput();
            }
          }}
          onBlur={addFromInput}
          aria-label={`${label} recipients`}
          placeholder={values.length === 0 ? "Add recipient…" : ""}
          className="min-w-24 flex-1 bg-transparent py-0.5 text-paragraph-sm text-text-strong-950 outline-none placeholder:text-text-soft-400"
        />
      </div>
      {trailing && <div className="flex shrink-0 items-center gap-1.5 pt-0.5">{trailing}</div>}
    </div>
  );
}

function ToolbarButton({
  onClick,
  active,
  icon: Icon,
  title,
}: {
  onClick: () => void;
  active?: boolean;
  icon: ComponentType<{ className?: string }>;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        "flex size-7 items-center justify-center rounded-md outline-none transition focus-visible:ring-2 focus-visible:ring-primary-base",
        active ? "bg-bg-weak-50 text-text-strong-950" : "text-text-soft-400 hover:bg-bg-weak-50 hover:text-text-sub-600",
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

const linkish = "text-paragraph-xs text-text-soft-400 outline-none hover:text-text-strong-950 focus-visible:text-text-strong-950";

export type ReplyComposerProps = {
  from: string;
  initialTo: string[];
  /** Reply-all: addresses to open the Cc row with. */
  initialCc?: string[];
  initialBcc?: string[];
  initialSubject?: string;
  quotedText?: string;
  quotedFrom?: string;
  quotedDate?: string;
  /** Plain-text body to open with (a CRM draft); blank lines split paragraphs. */
  initialBody?: string;
  /** AI-draft-approval mode: pre-seeded body, draft banner, "Approve & send" label. */
  isDraftApproval?: boolean;
  /** Who the reply goes to, for the collapsed "Reply to …" prompt. */
  replyToName?: string;
  /** Rejecting keeps the composer open with its text so the caller's error can be acted on. */
  onSend: (payload: { to: string[]; cc: string[]; bcc: string[]; subject: string; html: string; text: string }) => Promise<void>;
  onCancel?: () => void;
};

export default function ReplyComposer({
  from,
  initialTo,
  initialCc,
  initialBcc,
  initialSubject = "",
  quotedText,
  quotedFrom,
  quotedDate,
  initialBody,
  isDraftApproval = false,
  replyToName,
  onSend,
  onCancel,
}: ReplyComposerProps) {
  const [expanded, setExpanded] = useState(isDraftApproval);
  const [to, setTo] = useState<Recipient[]>(initialTo);
  const [cc, setCc] = useState<Recipient[]>(initialCc ?? []);
  const [bcc, setBcc] = useState<Recipient[]>(initialBcc ?? []);
  const [showCc, setShowCc] = useState((initialCc?.length ?? 0) > 0);
  const [showBcc, setShowBcc] = useState((initialBcc?.length ?? 0) > 0);
  const [subject, setSubject] = useState(initialSubject);
  const [sending, setSending] = useState(false);
  const [linkPromptOpen, setLinkPromptOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [showQuote, setShowQuote] = useState(false);

  // The quoted message stays out of the editor: the editor has no collapsible
  // block, so inside it the quote showed in full and its "Show quoted text"
  // label went out with the reply. It is shown collapsed under the editor and
  // appended to what is sent.
  const quoteHeader = quotedText != null && quotedFrom ? `On ${quotedDate ?? ""}, ${quotedFrom} wrote:` : "";
  const quoteHtml =
    quotedText != null
      ? `<blockquote>${quoteHeader ? `${escapeHtml(quoteHeader)}<br/>` : ""}${escapeHtml(quotedText).replace(/\n/g, "<br/>")}</blockquote>`
      : "";
  const quoteText =
    quotedText != null
      ? `\n\n${quoteHeader ? `${quoteHeader}\n` : ""}${quotedText.split("\n").map((line) => `> ${line}`).join("\n")}`
      : "";

  const bodyHtml = initialBody ? textToHtml(initialBody) : "<p></p>";

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [StarterKit, Link.configure({ openOnClick: false }), Highlight],
    content: bodyHtml,
  });

  useEffect(() => {
    if (editor && initialBody) {
      editor.commands.setContent(bodyHtml);
      editor.commands.focus("start");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // "r" opens the reply box from anywhere in the thread that is not a text field.
  useEffect(() => {
    if (expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "r" || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (target?.closest?.('[role="dialog"],[role="menu"],[role="listbox"]')) return;
      event.preventDefault();
      setExpanded(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  // Opening the box puts the cursor in it.
  useEffect(() => {
    if (expanded && editor) editor.commands.focus("start");
  }, [expanded, editor]);

  const canSend = !sending && to.length > 0;

  async function handleSend() {
    if (!editor || !canSend) return;
    setSending(true);
    try {
      const html = `${editor.getHTML()}${quoteHtml}`;
      const text = `${editor.getText()}${quoteText}`;
      try {
        await onSend({ to, cc, bcc, subject, html, text });
      } catch {
        return; // the caller surfaced the error; keep the text for a retry
      }
      editor.commands.clearContent();
      setExpanded(false);
    } finally {
      setSending(false);
    }
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="flex h-11 w-full items-center gap-2.5 rounded-xl bg-bg-white-0 px-3.5 text-left text-paragraph-sm text-text-soft-400 shadow-regular-xs outline-none ring-1 ring-inset ring-stroke-soft-200 transition hover:ring-stroke-sub-300 focus-visible:ring-2 focus-visible:ring-primary-base"
      >
        <RiReplyLine className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          {replyToName ? `Reply to ${replyToName}…` : "Reply…"}
          <span className="ml-2 hidden text-paragraph-xs sm:inline">from {from}</span>
        </span>
        <kbd className="hidden shrink-0 rounded-md bg-bg-weak-50 px-1.5 py-0.5 font-sans text-[13px] text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200 sm:inline">R</kbd>
      </button>
    );
  }

  return (
    <div
      // The Send button advertises ⌘⏎ (Ctrl+Enter elsewhere). Capture phase,
      // so the editor never sees the keystroke and adds its hard break first.
      onKeyDownCapture={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.stopPropagation();
          void handleSend();
        }
      }}
      className={cn(
        // A column whose body is the only part that gives way, so the footer
        // with Send stays in view however little room the dock leaves.
        // min-h-0 lets it shrink inside the capped dock; without it a long
        // body pushes the footer past the dock and the pane clips it.
        "flex min-h-0 flex-col rounded-2xl bg-bg-white-0 shadow-regular-md ring-1 ring-inset",
        isDraftApproval ? "ring-primary-alpha-24" : "ring-stroke-soft-200",
      )}
    >
      {(isDraftApproval || onCancel) && (
        <div className={cn("flex items-center gap-2 rounded-t-2xl border-b px-3 py-1.5", isDraftApproval ? "border-primary-alpha-16 bg-primary-alpha-10" : "border-stroke-soft-200 bg-bg-weak-50")}>
          {isDraftApproval && (
            <>
              <RiSparkling2Line className="size-4 shrink-0 text-primary-base" aria-hidden="true" />
              <span className="text-label-xs text-text-strong-950">AI-generated draft</span>
              <span className="truncate text-paragraph-xs text-text-sub-600">Review, edit and approve to send</span>
            </>
          )}
          <span className="flex-1" />
          {onCancel && (
            <button type="button" onClick={onCancel} className="flex size-6 items-center justify-center rounded-md text-text-soft-400 outline-none hover:bg-bg-white-0 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-primary-base" aria-label="Close composer">
              <RiCloseLine className="size-4" />
            </button>
          )}
        </div>
      )}

      <div className={fieldRow}>
        <span className={fieldLabel}>From</span>
        <span className="min-w-0 flex-1 truncate py-0.5 text-paragraph-sm text-text-sub-600">{from}</span>
      </div>

      <RecipientChips
        label="To"
        values={to}
        onChange={setTo}
        trailing={
          <>
            {!showCc && (
              <button type="button" onClick={() => setShowCc(true)} className={linkish}>
                Cc
              </button>
            )}
            {!showBcc && (
              <button type="button" onClick={() => setShowBcc(true)} className={linkish}>
                Bcc
              </button>
            )}
          </>
        }
      />
      {showCc && (
        <RecipientChips
          label="Cc"
          values={cc}
          onChange={setCc}
          trailing={
            <button
              type="button"
              // Closing the row drops its recipients too — leaving them staged
              // but invisible would silently Cc someone on send.
              onClick={() => {
                setCc([]);
                setShowCc(false);
              }}
              className={linkish}
              aria-label="Remove Cc"
            >
              <RiCloseLine className="size-3.5" />
            </button>
          }
        />
      )}
      {showBcc && (
        <RecipientChips
          label="Bcc"
          values={bcc}
          onChange={setBcc}
          trailing={
            <button
              type="button"
              onClick={() => {
                setBcc([]);
                setShowBcc(false);
              }}
              className={linkish}
              aria-label="Remove Bcc"
            >
              <RiCloseLine className="size-3.5" />
            </button>
          }
        />
      )}

      <div className={fieldRow}>
        <span className={fieldLabel}>Subject</span>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          aria-label="Subject"
          placeholder="Subject"
          className="min-w-0 flex-1 bg-transparent py-0.5 text-paragraph-sm text-text-strong-950 outline-none placeholder:text-text-soft-400"
        />
      </div>

      {editor && (
        <div className="flex items-center gap-0.5 border-b border-stroke-soft-200 px-2 py-1">
          <ToolbarButton title="Bold" icon={RiBold} active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()} />
          <ToolbarButton title="Italic" icon={RiItalic} active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()} />
          <ToolbarButton title="Bullet list" icon={RiListUnordered} active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()} />
          <ToolbarButton title="Highlight" icon={RiMarkPenLine} active={editor.isActive("highlight")} onClick={() => editor.chain().focus().toggleHighlight().run()} />
          <div className="relative">
            <ToolbarButton title="Link" icon={RiLink} active={editor.isActive("link")} onClick={() => setLinkPromptOpen((o) => !o)} />
            {linkPromptOpen && (
              <div className="absolute bottom-full left-0 z-10 mb-1 flex items-center gap-1 rounded-lg bg-bg-white-0 p-1.5 shadow-regular-md ring-1 ring-inset ring-stroke-soft-200">
                <input
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  placeholder="https://…"
                  aria-label="Link URL"
                  className="w-40 bg-transparent px-1.5 text-paragraph-xs text-text-strong-950 outline-none placeholder:text-text-soft-400"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => {
                    if (linkUrl) editor.chain().focus().setLink({ href: linkUrl }).run();
                    setLinkUrl("");
                    setLinkPromptOpen(false);
                  }}
                  className="rounded px-1.5 text-label-xs text-primary-base outline-none hover:underline focus-visible:underline"
                >
                  Add
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="max-h-[40vh] min-h-24 overflow-y-auto px-4 py-3">
        <EditorContent
          editor={editor}
          className="prose prose-sm max-w-none text-text-strong-950 [&_.ProseMirror]:min-h-16 [&_.ProseMirror]:outline-none [&_blockquote]:border-l-2 [&_blockquote]:border-stroke-soft-200 [&_blockquote]:pl-3 [&_blockquote]:text-text-sub-600"
        />
        {quotedText != null && (
          <div className="mt-2">
            <button type="button" onClick={() => setShowQuote((v) => !v)} aria-expanded={showQuote} className={linkish}>
              {showQuote ? "Hide quoted text" : "Show quoted text"}
            </button>
            {showQuote && (
              <blockquote className="mt-1.5 whitespace-pre-wrap border-l-2 border-stroke-soft-200 pl-3 text-paragraph-xs text-text-sub-600">
                {quoteHeader && <span className="block">{quoteHeader}</span>}
                {quotedText}
              </blockquote>
            )}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 rounded-b-2xl border-t border-stroke-soft-200 bg-bg-weak-50 px-3 py-2">
        <Button.Root variant="neutral" mode="ghost" size="xsmall" onClick={onCancel ?? (() => setExpanded(false))}>
          {isDraftApproval ? "Don't use draft" : "Close"}
        </Button.Root>
        <Button.Root variant="primary" mode="filled" size="xsmall" onClick={() => void handleSend()} disabled={!canSend} title="⌘⏎ / Ctrl+Enter">
          {sending ? "Sending…" : isDraftApproval ? "Approve & send" : "Send"}
          {!sending && <kbd className="font-sans text-paragraph-xs opacity-70">⌘⏎</kbd>}
        </Button.Root>
      </div>
    </div>
  );
}
