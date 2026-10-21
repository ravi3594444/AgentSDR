"use client";
/* eslint-disable react-hooks/set-state-in-effect */

// Renders its own SettingsPage so "Add document", which opens the editor held here, sits in the section header.
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RiAddLine,
  RiArchiveLine,
  RiArrowGoBackLine,
  RiBookOpenLine,
  RiBox3Line,
  RiBuilding2Line,
  RiCalendarLine,
  RiEyeLine,
  RiFileTextLine,
  RiMoreLine,
  RiPencilLine,
  RiPriceTag3Line,
  RiQuestionLine,
  RiSearchLine,
  RiShieldCheckLine,
  RiTrophyLine,
} from "@remixicon/react";
import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Checkbox from "@/components/alignui/checkbox";
import * as Dropdown from "@/components/alignui/dropdown";
import * as Input from "@/components/alignui/input";
import * as Modal from "@/components/alignui/modal";
import * as SegmentedControl from "@/components/alignui/segmented-control";
import * as Select from "@/components/alignui/select";
import * as Textarea from "@/components/alignui/textarea";
import { Frame, FramePanel } from "@/components/analytics/kit/Frame";
import { EmptyState } from "@/components/page/EmptyState";
import { Callout, Field } from "@/components/settings/SettingsKit";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { ListSkeleton } from "@/components/settings/SettingsSkeletons";
import { BUSINESS_PROFILE_HREF, PROFILE_DOCUMENT_READ_ONLY } from "@/lib/assistant/profile";
import { cn } from "@/utils/cn";
import { asList, asObject, crmFetch, errorMessage, formatDate } from "./crm-utils";

type Document = Record<string, unknown>;
type View = "active" | "archived";

const KINDS: { value: string; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: "custom", label: "Custom", icon: RiFileTextLine },
  { value: "company", label: "Company", icon: RiBuilding2Line },
  { value: "product", label: "Product", icon: RiBox3Line },
  { value: "pricing", label: "Pricing", icon: RiPriceTag3Line },
  { value: "faq", label: "FAQ", icon: RiQuestionLine },
  { value: "scheduling", label: "Scheduling", icon: RiCalendarLine },
  { value: "objection", label: "Objection", icon: RiShieldCheckLine },
  { value: "case_study", label: "Case study", icon: RiTrophyLine },
];

function kindMeta(kind: unknown) {
  return KINDS.find((k) => k.value === kind) ?? KINDS[0];
}

function contentOf(document: Document): string {
  return String(asObject(document.latest).content ?? document.content ?? "");
}

function alwaysIncluded(document: Document): boolean {
  return Boolean(document.alwaysInclude ?? document.always_include);
}

/** The business profile's copy: read-only here, edited in Settings → Your business (the server refuses edits). */
function fromBusinessProfile(document: Document): boolean {
  return document.businessProfile === true;
}

/** The first words of a markdown document as plain text, for the list. */
function snippet(content: string): string {
  return content
    .replace(/[#>*_`|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export default function CrmKnowledgeClient() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<Document | null>(null);
  const [viewer, setViewer] = useState<Document | null>(null);
  const [view, setView] = useState<View>("active");
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError("");
    try {
      setDocuments(asList(await crmFetch("/knowledge?includeArchived=true"), ["documents", "knowledge"]));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Returns an error message for the editor to show, or null once saved. */
  const save = async (document: Document): Promise<string | null> => {
    try {
      const id = document.id ? `/${String(document.id)}` : "";
      const payload = {
        title: document.title,
        kind: document.kind ?? "custom",
        tags: document.tags ?? [],
        alwaysInclude: Boolean(document.alwaysInclude),
        content: document.content ?? "",
      };
      await crmFetch(`/knowledge${id}`, { method: id ? "PATCH" : "POST", body: JSON.stringify(payload) });
      setEditor(null);
      await load(false);
      return null;
    } catch (cause) {
      return errorMessage(cause);
    }
  };

  const archive = async (document: Document) => {
    setBusyId(String(document.id));
    try {
      await crmFetch(`/knowledge/${String(document.id)}`, { method: "PATCH", body: JSON.stringify({ active: !document.active }) });
      await load(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  };

  const openEditor = (document: Document) =>
    fromBusinessProfile(document)
      ? setViewer(document)
      : setEditor({
          ...document,
          content: contentOf(document),
          tags: Array.isArray(document.tags) ? document.tags.join(", ") : document.tags,
        });

  const counts = useMemo(
    () => ({
      active: documents.filter((d) => d.active !== false).length,
      archived: documents.filter((d) => d.active === false).length,
    }),
    [documents],
  );

  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    return documents.filter((d) => {
      if ((view === "archived") !== (d.active === false)) return false;
      if (!term) return true;
      const tags = Array.isArray(d.tags) ? d.tags.join(" ") : "";
      return `${String(d.title ?? "")} ${tags} ${kindMeta(d.kind).label}`.toLowerCase().includes(term);
    });
  }, [documents, view, search]);

  const addDocument = () => setEditor({ title: "", kind: "custom", content: "", tags: [], alwaysInclude: false });
  const addButton = (
    <Button.Root variant="primary" mode="filled" size="small" onClick={addDocument}>
      <Button.Icon as={RiAddLine} />
      Add document
    </Button.Root>
  );

  return (
    <SettingsPage
      title="Knowledge"
      description="Product facts, pricing and policies the AI grounds its drafts in. Documents marked Always included go into every draft."
      actions={addButton}
    >
      <div className="space-y-5">
        {error && (
          <Callout
            tone="error"
            action={<Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={() => void load()}>Try again</Button.Root>}
          >
            {error}
          </Callout>
        )}

        {loading ? (
          <ListSkeleton rows={4} />
        ) : documents.length === 0 && error ? null : documents.length === 0 ? (
          <Frame>
            <FramePanel>
              <EmptyState
                icon={RiBookOpenLine}
                title="No knowledge yet"
                description="Add product, pricing, scheduling and company context, and the AI uses it when it drafts replies."
                action={addButton}
              />
            </FramePanel>
          </Frame>
        ) : (
          <Frame>
            <header className="flex flex-col gap-3 px-4 pb-3 pt-3 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <h3 className="text-label-sm text-text-strong-950">Documents</h3>
                <p className="mt-0.5 text-paragraph-xs text-text-sub-600">Every saved edit creates a new version. Archived documents are left out of drafts.</p>
              </div>
              <div className="flex flex-wrap items-center gap-2 md:shrink-0 md:flex-nowrap">
                <SegmentedControl.Root value={view} onValueChange={(v) => setView(v as View)}>
                  <SegmentedControl.List className="w-auto auto-cols-auto">
                    {(["active", "archived"] as const).map((v) => (
                      <SegmentedControl.Trigger key={v} value={v} className="gap-1.5 px-3">
                        {v === "active" ? "Active" : "Archived"}
                        <span className="tabular-nums text-text-soft-400">{counts[v]}</span>
                      </SegmentedControl.Trigger>
                    ))}
                  </SegmentedControl.List>
                </SegmentedControl.Root>
                <Input.Root size="small" className="w-full sm:w-48">
                  <Input.Wrapper>
                    <Input.Icon as={RiSearchLine} />
                    <Input.Input type="search" aria-label="Search documents" placeholder="Search documents…" value={search} onChange={(e) => setSearch(e.target.value)} />
                  </Input.Wrapper>
                </Input.Root>
              </div>
            </header>
            <FramePanel className="p-0 sm:p-0">
              {shown.length === 0 ? (
                <EmptyState
                  compact
                  icon={search.trim() ? RiSearchLine : RiArchiveLine}
                  title={search.trim() ? "No documents match" : view === "archived" ? "Nothing archived" : "No active documents"}
                  description={search.trim() ? "Try another search." : view === "archived" ? "Archived documents appear here and can be restored." : "Restore an archived document or add a new one."}
                />
              ) : (
                <ul className="divide-y divide-stroke-soft-200">
                  {shown.map((document, index) => {
                    const kind = kindMeta(document.kind);
                    const text = snippet(contentOf(document));
                    const tags = Array.isArray(document.tags) ? (document.tags as unknown[]).map(String) : [];
                    const archived = document.active === false;
                    const title = String(document.title ?? "Untitled document");
                    const busy = busyId === String(document.id);
                    const profileCopy = fromBusinessProfile(document);
                    return (
                      <li
                        key={String(document.id ?? index)}
                        tabIndex={0}
                        aria-busy={busy || undefined}
                        onClick={() => openEditor(document)}
                        onKeyDown={(e) => {
                          if (e.target === e.currentTarget && e.key === "Enter") openEditor(document);
                        }}
                        className={cn(
                          "flex cursor-pointer items-start gap-3 px-4 py-3.5 outline-none transition first:rounded-t-xl last:rounded-b-xl hover:bg-bg-weak-50 focus-visible:bg-bg-weak-50 sm:px-5",
                          busy && "opacity-60",
                        )}
                      >
                        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-bg-weak-50 ring-1 ring-inset ring-stroke-soft-200">
                          <kind.icon className="size-4 text-text-sub-600" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                            <p className={cn("min-w-0 truncate text-label-sm", archived ? "text-text-sub-600" : "text-text-strong-950")} title={title}>{title}</p>
                            {alwaysIncluded(document) && !archived && (
                              <Badge.Root size="small" variant="lighter" color="blue">Always included</Badge.Root>
                            )}
                            {archived && <Badge.Root size="small" variant="lighter" color="gray">Archived</Badge.Root>}
                            {profileCopy && <Badge.Root size="small" variant="lighter" color="gray">From Your business · read-only</Badge.Root>}
                          </div>
                          <p className="mt-1 line-clamp-2 text-paragraph-sm text-text-sub-600">{text || "No content"}</p>
                          <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-paragraph-xs text-text-soft-400" suppressHydrationWarning>
                            <span className="text-text-sub-600">{kind.label}</span>
                            <span aria-hidden="true">·</span>
                            <span>Updated {formatDate(document.updatedAt ?? document.updated_at)}</span>
                            {tags.length > 0 && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="truncate">{tags.map((t) => `#${t}`).join(" ")}</span>
                              </>
                            )}
                          </p>
                        </div>
                        <div className="shrink-0" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                          <Dropdown.Root>
                            <Dropdown.Trigger asChild>
                              <Button.Root variant="neutral" mode="ghost" size="xsmall" disabled={busy} aria-label={`Actions for ${title}`}>
                                <Button.Icon as={RiMoreLine} />
                              </Button.Root>
                            </Dropdown.Trigger>
                            <Dropdown.Content align="end">
                              {profileCopy ? (
                                <>
                                  <Dropdown.Item onSelect={() => setViewer(document)}>
                                    <Dropdown.ItemIcon as={RiEyeLine} />
                                    View
                                  </Dropdown.Item>
                                  <Dropdown.Item asChild>
                                    <Link href={BUSINESS_PROFILE_HREF}>
                                      <Dropdown.ItemIcon as={RiPencilLine} />
                                      Edit in Settings → Your business
                                    </Link>
                                  </Dropdown.Item>
                                </>
                              ) : (
                                <>
                                  <Dropdown.Item onSelect={() => openEditor(document)}>
                                    <Dropdown.ItemIcon as={RiPencilLine} />
                                    Edit
                                  </Dropdown.Item>
                                  <Dropdown.Item onSelect={() => void archive(document)}>
                                    <Dropdown.ItemIcon as={archived ? RiArrowGoBackLine : RiArchiveLine} />
                                    {archived ? "Restore" : "Archive"}
                                  </Dropdown.Item>
                                </>
                              )}
                            </Dropdown.Content>
                          </Dropdown.Root>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </FramePanel>
          </Frame>
        )}
      </div>

      {editor && <KnowledgeEditor document={editor} onCancel={() => setEditor(null)} onSave={save} />}
      {viewer && <ProfileCopyViewer document={viewer} onClose={() => setViewer(null)} />}
    </SettingsPage>
  );
}

/** The business profile's copy, read-only: it is rewritten from Settings → Your business, so it is edited there. */
function ProfileCopyViewer({ document, onClose }: { document: Document; onClose: () => void }) {
  const archived = document.active === false;
  return (
    <Modal.Root open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content size="max-w-2xl" className="max-h-[calc(100dvh-2rem)]">
        <Modal.Header icon={RiBookOpenLine}>
          <Modal.Title>{String(document.title ?? "Business profile")}</Modal.Title>
          <Modal.Description>{archived ? "Archived: the profile is empty, so drafts leave it out." : "Always included in reply drafts."}</Modal.Description>
        </Modal.Header>
        <Modal.Body className="space-y-4">
          <Callout tone="info">{PROFILE_DOCUMENT_READ_ONLY}</Callout>
          <div className="max-h-[50dvh] overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-bg-weak-50 p-4 text-paragraph-sm text-text-strong-950 ring-1 ring-inset ring-stroke-soft-200">
            {contentOf(document) || "No content"}
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button.Root type="button" variant="neutral" mode="stroke" size="small" onClick={onClose}>
            Close
          </Button.Root>
          <Button.Root asChild variant="primary" mode="filled" size="small">
            <Link href={BUSINESS_PROFILE_HREF}>Edit in Settings → Your business</Link>
          </Button.Root>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}

function KnowledgeEditor({
  document,
  onCancel,
  onSave,
}: {
  document: Document;
  onCancel: () => void;
  onSave: (document: Document) => Promise<string | null>;
}) {
  const [title, setTitle] = useState(String(document.title ?? ""));
  const [kind, setKind] = useState(String(document.kind ?? "custom"));
  const [content, setContent] = useState(String(document.content ?? ""));
  const [tags, setTags] = useState(Array.isArray(document.tags) ? document.tags.join(", ") : String(document.tags ?? ""));
  const [alwaysInclude, setAlwaysInclude] = useState(alwaysIncluded(document));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const missingTitle = touched && !title.trim();
  const missingContent = touched && !content.trim();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!title.trim() || !content.trim()) return;
    setSaving(true);
    setError(null);
    const problem = await onSave({
      ...document,
      title,
      kind,
      content,
      tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      alwaysInclude,
    });
    setSaving(false);
    if (problem) setError(problem);
  };

  return (
    <Modal.Root open onOpenChange={(open) => !open && !saving && onCancel()}>
      <Modal.Content size="max-w-2xl" className="max-h-[calc(100dvh-2rem)]">
        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <Modal.Header icon={RiBookOpenLine}>
            <Modal.Title>{document.id ? "Edit document" : "New document"}</Modal.Title>
            <Modal.Description>Every saved edit creates a new version.</Modal.Description>
          </Modal.Header>
          <Modal.Body className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
              <Field label="Title" htmlFor="knowledge-title" required error={missingTitle ? "Give the document a title." : undefined}>
                <Input.Root size="small" hasError={missingTitle}>
                  <Input.Wrapper>
                    <Input.Input id="knowledge-title" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Pricing and plans" />
                  </Input.Wrapper>
                </Input.Root>
              </Field>
              <Field label="Kind">
                <Select.Root size="small" value={kind} onValueChange={setKind}>
                  <Select.Trigger aria-label="Kind">
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Content>
                    {KINDS.map((k) => (
                      <Select.Item key={k.value} value={k.value}>{k.label}</Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              </Field>
            </div>
            <Field
              label="Content"
              htmlFor="knowledge-content"
              required
              description="Markdown. Headings and lists help the AI find the right part."
              error={missingContent ? "Add the content the AI should know." : undefined}
            >
              <Textarea.Root
                id="knowledge-content"
                simple
                hasError={missingContent}
                value={content}
                onChange={(event) => setContent(event.target.value)}
                rows={12}
                className="min-h-48 resize-y font-mono text-paragraph-xs"
                placeholder={"# Pricing\n\n- Starter: $49/month\n- Growth: $199/month"}
              />
            </Field>
            <Field label="Tags" htmlFor="knowledge-tags" optional description="Comma separated, e.g. pricing, onboarding.">
              <Input.Root size="small">
                <Input.Wrapper>
                  <Input.Input id="knowledge-tags" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="pricing, onboarding" />
                </Input.Wrapper>
              </Input.Root>
            </Field>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl p-3 ring-1 ring-inset ring-stroke-soft-200">
              <Checkbox.Root className="mt-0.5" checked={alwaysInclude} onCheckedChange={(checked) => setAlwaysInclude(checked === true)} />
              <span>
                <span className="block text-label-sm text-text-strong-950">Always include in draft context</span>
                <span className="mt-0.5 block text-paragraph-xs text-text-sub-600">Sent with every draft the AI writes, so keep these short.</span>
              </span>
            </label>
            {error && <Callout tone="error">{error}</Callout>}
          </Modal.Body>
          <Modal.Footer>
            <Button.Root type="button" variant="neutral" mode="stroke" size="small" disabled={saving} onClick={onCancel}>
              Cancel
            </Button.Root>
            <Button.Root type="submit" variant="primary" mode="filled" size="small" disabled={saving}>
              {saving ? "Saving…" : "Save document"}
            </Button.Root>
          </Modal.Footer>
        </form>
      </Modal.Content>
    </Modal.Root>
  );
}
