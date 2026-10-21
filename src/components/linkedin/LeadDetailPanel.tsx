"use client";

import { useEffect, useState } from "react";
import {
  X,
  ExternalLink,
  Loader2,
  MapPin,
  Megaphone,
  MessageSquare,
  Save,
  AlertCircle,
} from "lucide-react";
import { Badge } from "@/components/linkedin/ui/badge";
import { Button } from "@/components/linkedin/ui/button";
import {
  invitationMessageLength,
  isInvitationMessageTooLong,
  MAX_INVITATION_MESSAGE_LENGTH,
} from "@/lib/linkedin/invitationMessage";
import { MAX_LEAD_RETRIES } from "@/lib/linkedin/inviteRetry";
import { LinkedInAccountTag, LinkedInAccountTags } from "@/components/linkedin/LinkedInAccountTag";
import {
  isMessageEditable,
  LEAD_MESSAGE_FIELDS,
  sentAtForField,
  type LeadMessageField,
} from "@/lib/linkedin/leadMessages";

export const LEAD_STATUS_VARIANTS: Record<
  string,
  "default" | "secondary" | "success" | "warning" | "destructive" | "muted" | "blue" | "purple"
> = {
  PENDING: "muted",
  REQUEST_SENT: "warning",
  ACCEPT_MESSAGE_SENT: "success",
  FOLLOW_UP_1_SENT: "blue",
  FOLLOW_UP_2_SENT: "blue",
  FOLLOW_UP_3_SENT: "blue",
  COMPLETED: "secondary",
  REPLIED: "purple",
  FAILED: "destructive",
};

export const LEAD_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pending",
  REQUEST_SENT: "Request Sent",
  ACCEPT_MESSAGE_SENT: "Accepted",
  FOLLOW_UP_1_SENT: "Follow-up 1",
  FOLLOW_UP_2_SENT: "Follow-up 2",
  FOLLOW_UP_3_SENT: "Follow-up 3",
  COMPLETED: "Completed",
  REPLIED: "Replied",
  FAILED: "Failed",
};

const MESSAGE_TYPE_LABEL: Record<string, string> = {
  INVITATION: "Invitation",
  ACCEPTANCE: "Acceptance",
  FOLLOW_UP_1: "Follow-up 1",
  FOLLOW_UP_2: "Follow-up 2",
  FOLLOW_UP_3: "Follow-up 3",
  RECEIVED: "Received",
  CUSTOM_SENT: "Sent",
};

const SENT_TYPES = new Set(["INVITATION", "ACCEPTANCE", "FOLLOW_UP_1", "FOLLOW_UP_2", "FOLLOW_UP_3", "CUSTOM_SENT"]);

const MESSAGE_TYPE_FOR_FIELD: Record<LeadMessageField, string> = {
  invitationMessage: "INVITATION",
  acceptanceMessage: "ACCEPTANCE",
  followUp1Message: "FOLLOW_UP_1",
  followUp2Message: "FOLLOW_UP_2",
  followUp3Message: "FOLLOW_UP_3",
};

export type LeadDetail = {
  id: string;
  linkedinUrl: string;
  providerId: string | null;
  name: string | null;
  profilePictureUrl: string | null;
  headline: string | null;
  location: string | null;
  status: string;
  inviteRetryCount: number;
  invitationMessage: string | null;
  acceptanceMessage: string | null;
  followUp1Message: string | null;
  followUp2Message: string | null;
  followUp3Message: string | null;
  renderedTemplates: Record<LeadMessageField, string | null>;
  requestSentAt: string | null;
  acceptMessageSentAt: string | null;
  followUp1SentAt: string | null;
  followUp2SentAt: string | null;
  followUp3SentAt: string | null;
  createdAt: string;
  campaign: { id: string; name: string } | null;
  linkedInAccount: {
    id: string;
    username: string;
    name: string | null;
    profilePictureUrl: string | null;
  } | null;
  connection: { id: string; chatId: string | null; connectedAt: string | null } | null;
  messages: { id: string; type: string; text: string; seen: boolean; createdAt: string }[];
  alsoInCampaigns: { id: string; name: string }[];
  excludedAccounts: { id: string; username: string; name: string | null; profilePictureUrl: string | null }[];
};

type MessageDraft = Record<LeadMessageField, string>;

const draftFromLead = (lead: LeadDetail): MessageDraft => ({
  invitationMessage: lead.invitationMessage ?? "",
  acceptanceMessage: lead.acceptanceMessage ?? "",
  followUp1Message: lead.followUp1Message ?? "",
  followUp2Message: lead.followUp2Message ?? "",
  followUp3Message: lead.followUp3Message ?? "",
});

function Avatar({ src, name, size = "lg" }: { src: string | null; name: string; size?: "lg" | "md" }) {
  const [err, setErr] = useState(false);
  const initials = name.split(/[\s/]/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
  const cls = size === "lg" ? "h-16 w-16 text-lg" : "h-10 w-10 text-xs";
  if (src && !err) {
    return (
      <img
        src={src}
        alt={name}
        className={`${cls} rounded-full object-cover shrink-0 bg-bg-weak-50 ring-2 ring-stroke-white-0 shadow-sm`}
        onError={() => setErr(true)}
      />
    );
  }
  return (
    <div
      className={`${cls} rounded-full bg-blue-100 dark:bg-blue-500/15 text-blue-600 dark:text-blue-400 flex items-center justify-center font-semibold shrink-0 ring-2 ring-stroke-white-0 shadow-sm`}
    >
      {initials || "?"}
    </div>
  );
}

function fmt(iso: string | null) {
  if (!iso) return null;
  if (iso === "sent") return "Sent";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  if (value == null || value === "") return null;
  return (
    <div className="flex gap-2 text-sm">
      <span className="text-text-soft-400 shrink-0 w-28">{label}</span>
      <span className="text-text-strong-950 min-w-0">{value}</span>
    </div>
  );
}

function MessageBubble({ type, text, createdAt }: { type: string; text: string; createdAt: string }) {
  const sent = SENT_TYPES.has(type);
  return (
    <div className={`flex ${sent ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[90%] rounded-xl px-3 py-2 text-sm ${
          sent ? "bg-blue-600 text-white" : "bg-bg-weak-50 text-text-strong-950"
        }`}
      >
        <p className="text-[12px] font-medium opacity-80 mb-0.5">
          {MESSAGE_TYPE_LABEL[type] ?? type}
          <span className="mx-1">·</span>
          {new Date(createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
        </p>
        <p className="whitespace-pre-wrap break-words leading-relaxed">{text || "—"}</p>
      </div>
    </div>
  );
}

function OutreachTemplatesEditor({
  lead,
  onSaved,
}: {
  lead: LeadDetail;
  onSaved: (updated: LeadDetail) => void;
}) {
  const [draft, setDraft] = useState<MessageDraft>(() => draftFromLead(lead));
  const [editingFields, setEditingFields] = useState<Set<LeadMessageField>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: effect resets/seeds local state when props or open state change; deriving during render would change timing
    setDraft(draftFromLead(lead));
    setEditingFields(new Set());
    setSaveError(null);
  }, [lead.id, lead.invitationMessage, lead.acceptanceMessage, lead.followUp1Message, lead.followUp2Message, lead.followUp3Message, lead.status]);

  const editableFields = LEAD_MESSAGE_FIELDS.filter(({ key }) => isMessageEditable(key, lead.status));
  const hasEditable = editableFields.length > 0;

  const toggleFieldEditor = (key: LeadMessageField) => {
    if (editingFields.has(key)) {
      setDraft((current) => ({ ...current, [key]: draftFromLead(lead)[key] }));
    }
    setEditingFields((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleSave = async () => {
    const payload: Partial<MessageDraft> = {};
    for (const { key } of editableFields) {
      payload[key] = draft[key];
    }
    if (Object.keys(payload).length === 0) return;

    if (
      payload.invitationMessage != null &&
      isInvitationMessageTooLong(payload.invitationMessage)
    ) {
      setSaveError(
        `Invitation message must be ${MAX_INVITATION_MESSAGE_LENGTH} characters or fewer (currently ${invitationMessageLength(payload.invitationMessage)}).`
      );
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/linkedin/leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.ok) {
        setSaveError(data.error ?? "Save failed");
        return;
      }
      let updated: LeadDetail = {
        ...lead,
        invitationMessage: payload.invitationMessage ?? lead.invitationMessage,
        acceptanceMessage: payload.acceptanceMessage ?? lead.acceptanceMessage,
        followUp1Message: payload.followUp1Message ?? lead.followUp1Message,
        followUp2Message: payload.followUp2Message ?? lead.followUp2Message,
        followUp3Message: payload.followUp3Message ?? lead.followUp3Message,
      };
      const refreshedResponse = await fetch(`/api/linkedin/leads/${lead.id}`);
      const refreshed = await refreshedResponse.json().catch(() => null);
      if (refreshedResponse.ok && refreshed?.ok && refreshed.lead) {
        updated = refreshed.lead as LeadDetail;
      }
      setEditingFields(new Set());
      onSaved(updated);
    } catch {
      setSaveError("Network error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      {LEAD_MESSAGE_FIELDS.map(({ key, label }) => {
        const editable = isMessageEditable(key, lead.status);
        const editing = editable && editingFields.has(key);
        const sentAt = sentAtForField(key, lead);
        const sent = !!sentAt;
        const value = draft[key];
        const sentMessage = sent
          ? lead.messages.find((message) => message.type === MESSAGE_TYPE_FOR_FIELD[key])
          : null;
        const previewValue = sentMessage?.text ?? lead.renderedTemplates[key] ?? value;

        if (!editable && !value && !sent) return null;

        return (
          <div
            key={key}
            className={`rounded-lg border p-3 ${
              editable ? "border-blue-100 dark:border-blue-500/20 bg-blue-50/40 dark:bg-blue-500/10" : "border-stroke-soft-200 bg-bg-weak-50/80"
            }`}
          >
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <p className="text-xs font-medium text-text-sub-600">{label}</p>
              {sent ? (
                <span className="text-[12px] text-green-600 dark:text-green-400 font-medium">
                  Sent{sentAt !== "sent" ? ` ${fmt(sentAt)}` : ""}
                </span>
              ) : editable ? (
                <button
                  type="button"
                  className="text-[12px] font-medium text-blue-600 dark:text-blue-400 hover:underline"
                  onClick={() => toggleFieldEditor(key)}
                >
                  {editing ? "Cancel edit" : "Edit template"}
                </button>
              ) : (
                <span className="text-[12px] text-text-soft-400">Locked</span>
              )}
            </div>
            {editing ? (
              <>
                <textarea
                  value={value}
                  onChange={(e) => setDraft((p) => ({ ...p, [key]: e.target.value }))}
                  rows={3}
                  maxLength={key === "invitationMessage" ? MAX_INVITATION_MESSAGE_LENGTH : undefined}
                  placeholder={`Write your ${label.toLowerCase()}…`}
                  className="w-full resize-none rounded-lg border border-stroke-soft-200 bg-bg-white-0 px-3 py-2 text-sm text-text-strong-950 leading-relaxed placeholder:text-text-soft-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                {key === "invitationMessage" && (
                  <p
                    className={`mt-1 text-[12px] text-right ${
                      isInvitationMessageTooLong(value) ? "text-red-600 dark:text-red-400 font-medium" : "text-text-soft-400"
                    }`}
                  >
                    {invitationMessageLength(value)}/{MAX_INVITATION_MESSAGE_LENGTH}
                  </p>
                )}
              </>
            ) : previewValue ? (
              <p className="text-sm text-text-strong-950 whitespace-pre-wrap leading-relaxed">{previewValue}</p>
            ) : (
              <p className="text-sm text-text-soft-400 italic">No message</p>
            )}
          </div>
        );
      })}

      {saveError && (
        <div className="flex items-center gap-1.5 text-sm text-red-500">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {saveError}
        </div>
      )}

      {hasEditable && editingFields.size > 0 && (
        <Button size="sm" className="w-full" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save message templates
        </Button>
      )}
    </div>
  );
}

export function LeadDetailPanel({
  leadId,
  onClose,
  refreshKey = 0,
  onMessagesSaved,
}: {
  leadId: string | null;
  onClose: () => void;
  refreshKey?: number;
  onMessagesSaved?: (leadId: string, updates: Pick<LeadDetail, LeadMessageField>) => void;
}) {
  const [lead, setLead] = useState<LeadDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!leadId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: effect resets/seeds local state when props or open state change; deriving during render would change timing
      setLead(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/linkedin/leads/${leadId}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (!data.ok) {
          setError(data.error ?? "Failed to load lead");
          setLead(null);
          return;
        }
        setLead(data.lead);
      })
      .catch(() => {
        if (!cancelled) setError("Network error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [leadId, refreshKey]);

  if (!leadId) return null;

  const displayName = lead?.name ?? lead?.linkedinUrl ?? "Lead";
  const profileUrl = lead
    ? lead.linkedinUrl.startsWith("http")
      ? lead.linkedinUrl
      : `https://www.linkedin.com/in/${lead.linkedinUrl}`
    : null;

  const handleTemplatesSaved = (updated: LeadDetail) => {
    setLead(updated);
    onMessagesSaved?.(updated.id, {
      invitationMessage: updated.invitationMessage,
      acceptanceMessage: updated.acceptanceMessage,
      followUp1Message: updated.followUp1Message,
      followUp2Message: updated.followUp2Message,
      followUp3Message: updated.followUp3Message,
    });
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close lead details"
        className="fixed inset-0 z-40 bg-black/25 lg:bg-transparent"
        onClick={onClose}
      />

      <aside
        className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-stroke-soft-200 bg-bg-white-0 shadow-xl"
        role="dialog"
        aria-label="Lead details"
      >
        <div className="flex items-center justify-between gap-2 border-b border-stroke-soft-200 px-4 py-3 shrink-0">
          <h2 className="text-sm font-semibold text-text-strong-950">Lead details</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-text-soft-400 hover:bg-bg-weak-50 hover:text-text-sub-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-24">
              <Loader2 className="h-6 w-6 animate-spin text-text-soft-400" />
            </div>
          )}

          {error && !loading && <div className="p-6 text-sm text-red-600 dark:text-red-400">{error}</div>}

          {lead && !loading && (
            <div className="p-5 space-y-6">
              <div className="flex gap-4">
                <Avatar src={lead.profilePictureUrl} name={displayName} size="lg" />
                <div className="min-w-0 flex-1 pt-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold text-text-strong-950 truncate">{displayName}</h3>
                    <Badge variant={LEAD_STATUS_VARIANTS[lead.status] ?? "secondary"}>
                      {LEAD_STATUS_LABELS[lead.status] ?? lead.status}
                    </Badge>
                    {lead.inviteRetryCount > 0 && lead.status !== "FAILED" && (
                      <span className="text-xs text-amber-600 dark:text-amber-400">
                        Retries: {lead.inviteRetryCount}/{MAX_LEAD_RETRIES}
                      </span>
                    )}
                  </div>
                  {lead.headline && (
                    <p className="text-sm text-text-sub-600 mt-1 leading-snug">{lead.headline}</p>
                  )}
                  {lead.location && (
                    <p className="flex items-center gap-1 text-xs text-text-soft-400 mt-1">
                      <MapPin className="h-3 w-3 shrink-0" />
                      {lead.location}
                    </p>
                  )}
                  {profileUrl && (
                    <a
                      href={profileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline mt-2"
                    >
                      View on LinkedIn
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </div>

              <section className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-text-soft-400">Overview</h4>
                <div className="space-y-2 rounded-xl border border-stroke-soft-200 bg-bg-weak-50/50 p-3">
                  <DetailRow
                    label="Campaign"
                    value={
                      lead.campaign ? (
                        <span className="inline-flex items-center gap-1">
                          <Megaphone className="h-3.5 w-3.5 text-text-soft-400" />
                          {lead.campaign.name}
                        </span>
                      ) : (
                        "—"
                      )
                    }
                  />
                  <DetailRow
                    label="Sender"
                    value={
                      lead.linkedInAccount ? (
                        <LinkedInAccountTag account={lead.linkedInAccount} size="sm" />
                      ) : (
                        "—"
                      )
                    }
                  />
                  <DetailRow label="Added" value={fmt(lead.createdAt)} />
                  <DetailRow label="Invite sent" value={fmt(lead.requestSentAt)} />
                  <DetailRow
                    label="Accepted"
                    value={fmt(lead.acceptMessageSentAt ?? lead.connection?.connectedAt ?? null)}
                  />
                  <DetailRow label="Follow-up 1" value={fmt(lead.followUp1SentAt)} />
                  <DetailRow label="Follow-up 2" value={fmt(lead.followUp2SentAt)} />
                  <DetailRow label="Follow-up 3" value={fmt(lead.followUp3SentAt)} />
                  {lead.providerId && (
                    <DetailRow
                      label="Provider ID"
                      value={<span className="font-mono text-[12px] break-all">{lead.providerId}</span>}
                    />
                  )}
                </div>
              </section>

              {(lead.alsoInCampaigns.length > 0 || lead.excludedAccounts.length > 0) && (
                <section className="space-y-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-text-soft-400">
                    Cross-campaign outreach
                  </h4>
                  <div className="space-y-2 rounded-xl border border-amber-100 dark:border-amber-500/20 bg-amber-50/50 dark:bg-amber-500/10 p-3">
                    {lead.alsoInCampaigns.length > 0 && (
                      <DetailRow
                        label="Also in"
                        value={
                          <span className="inline-flex flex-wrap items-center gap-1">
                            {lead.alsoInCampaigns.map((c) => (
                              <span
                                key={c.id}
                                className="inline-flex items-center gap-1 rounded-full bg-bg-white-0 border border-stroke-soft-200 px-2 py-0.5 text-xs font-medium text-text-strong-950"
                              >
                                <Megaphone className="h-3 w-3 text-text-soft-400" />
                                {c.name}
                              </span>
                            ))}
                          </span>
                        }
                      />
                    )}
                    {lead.excludedAccounts.length > 0 && (
                      <DetailRow
                        label="Do not reach via"
                        value={<LinkedInAccountTags accounts={lead.excludedAccounts} size="sm" maxVisible={4} />}
                      />
                    )}
                  </div>
                </section>
              )}

              <section className="space-y-2">
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-text-soft-400">Outreach preview</h4>
                  <p className="mt-1 text-[13px] text-text-soft-400">Rendered for {displayName}. Edit a template to view its variables.</p>
                </div>
                <OutreachTemplatesEditor lead={lead} onSaved={handleTemplatesSaved} />
              </section>

              <section className="space-y-3">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-text-soft-400 flex items-center gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5" />
                  Conversation ({lead.messages.length})
                </h4>
                {lead.messages.length === 0 ? (
                  <p className="text-sm text-text-soft-400 py-4 text-center rounded-lg border border-dashed border-stroke-soft-200">
                    No messages recorded yet
                  </p>
                ) : (
                  <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                    {lead.messages.map((m) => (
                      <MessageBubble key={m.id} type={m.type} text={m.text} createdAt={m.createdAt} />
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
