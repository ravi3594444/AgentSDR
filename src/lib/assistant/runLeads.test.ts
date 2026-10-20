import { describe, expect, test } from "bun:test";
import { leadOpen, leadProgress, leadReach, type LeadProgressInput } from "./runLeads";

const base: LeadProgressInput = { channel: "whatsapp", runStatus: "active", emailStatus: null, whatsappStatus: null, whatsappSentAt: null, whatsappError: null, linkedinStatus: null, category: null, subcategory: null };

describe("leadProgress", () => {
  test("Instagram outbound and inquiries keep distinct delivery states", () => {
    const input = { ...base, channel: "instagram" };
    expect(leadProgress(input).text).toBe("Wrote in on Instagram");
    expect(leadProgress({ ...input, instagramStatus: "queued" }).tone).toBe("waiting");
    expect(leadProgress({ ...input, instagramStatus: "sent" }).tone).toBe("sent");
    expect(leadProgress({ ...input, instagramStatus: "replied" }).text).toBe("Replied");
    expect(leadProgress({ ...input, instagramStatus: "uncertain" }).text).toContain("no automatic resend");
    expect(leadProgress({ ...input, instagramStatus: "failed", instagramError: "Recipient restricted" }).text).toContain("Recipient restricted");
    expect(leadProgress({ ...input, instagramStatus: "sent", category: "interested" }).tone).toBe("good");
  });
  test("says where each lead stands, per channel", () => {
    expect(leadProgress({ ...base, whatsappStatus: "queued" })).toEqual({ tone: "waiting", text: "Waiting to send" });
    expect(leadProgress({ ...base, whatsappStatus: "in_sequence", whatsappSentAt: "2026-10-15" })).toMatchObject({ tone: "sent" });
    expect(leadProgress({ ...base, whatsappStatus: "failed", whatsappError: "number not on WhatsApp" }).text).toBe("Could not send: number not on WhatsApp");
    expect(leadProgress({ ...base, channel: "email", emailStatus: "sequence_completed" }).text).toBe("All messages sent, no reply");
    expect(leadProgress({ ...base, channel: "email", emailStatus: "bounced" })).toMatchObject({ tone: "failed" });
    expect(leadProgress({ ...base, channel: "linkedin", linkedinStatus: "REQUEST_SENT" }).text).toBe("Invitation sent");
  });

  test("a reply shows how the AI classified it; an opt-out wins over everything", () => {
    expect(leadProgress({ ...base, whatsappStatus: "replied", category: "interested", subcategory: "Meeting Requested" })).toEqual({ tone: "good", text: "Replied · Interested (Meeting Requested)" });
    expect(leadProgress({ ...base, whatsappStatus: "replied", category: "not_interested", subcategory: "Not Required Right Now" })).toMatchObject({ tone: "replied", text: "Replied · Not interested (Not Required Right Now)" });
    expect(leadProgress({ ...base, whatsappStatus: "replied" }).text).toBe("Replied");
    expect(leadProgress({ ...base, runStatus: "opted_out", category: "interested" }).text).toBe("Asked not to be contacted");
  });

  test("WhatsApp says how far the message got, never that the person saw it", () => {
    const sent = { ...base, whatsappStatus: "in_sequence", whatsappSentAt: "2026-10-15T10:00:00Z" };
    expect(leadProgress(sent).text).toBe("Accepted for sending, waiting for a reply");
    expect(leadProgress({ ...sent, whatsappDeliveredAt: "2026-10-15T10:00:05Z" }).text).toBe("Delivered (WhatsApp reported), waiting for a reply");
    expect(leadProgress({ ...sent, whatsappDeliveredAt: "2026-10-15T10:00:05Z", whatsappReadAt: "2026-10-15T11:00:00Z" }).text).toBe("Read receipt received, waiting for a reply");
    expect(leadProgress({ ...base, whatsappStatus: "completed", whatsappDeliveredAt: "2026-10-15T10:00:05Z" }).text).toBe("All messages sent, no reply · last one delivered (WhatsApp reported)");
    for (const lead of [sent, { ...sent, whatsappReadAt: "x" }, { ...base, whatsappStatus: "completed" }]) expect(leadProgress(lead).text).not.toMatch(/\bseen\b/i);
  });

  test("an uncertain send is shown as uncertain and never resent", () => {
    const progress = leadProgress({ ...base, whatsappStatus: "failed", whatsappError: "Delivery of message 2 is uncertain — check Messages before resuming" });
    expect(progress.tone).toBe("failed");
    expect(progress.text).toContain("no automatic resend");
  });
});

describe("leadReach: whether a lead was contacted and replied, whatever its status now", () => {
  const lead = (over: Partial<LeadProgressInput>): LeadProgressInput => ({ channel: "whatsapp", runStatus: "active", emailStatus: null, whatsappStatus: null, whatsappSentAt: null, whatsappError: null, linkedinStatus: null, category: null, subcategory: null, ...over });
  test("a plan stopped after its first messages: those leads were still contacted", () => {
    expect(leadReach(lead({ whatsappStatus: "stopped", whatsappSentAt: "2026-10-18T10:00:00Z" }))).toEqual({ contacted: true, replied: false });
    expect(leadReach(lead({ channel: "linkedin", linkedinStatus: "CANCELLED", linkedinRequestSentAt: "2026-10-18T10:00:00Z" }))).toEqual({ contacted: true, replied: false });
    expect(leadReach(lead({ channel: "email", emailStatus: "initial_sent" }))).toEqual({ contacted: true, replied: false });
  });
  test("stopped before anything went out, or a send that failed or is uncertain, is not contacted", () => {
    expect(leadReach(lead({ whatsappStatus: "stopped" }))).toEqual({ contacted: false, replied: false });
    expect(leadReach(lead({ channel: "linkedin", linkedinStatus: "CANCELLED" }))).toEqual({ contacted: false, replied: false });
    expect(leadReach(lead({ channel: "instagram", instagramStatus: "uncertain" }))).toEqual({ contacted: false, replied: false });
    expect(leadReach(lead({ channel: "email", emailStatus: "pending" }))).toEqual({ contacted: false, replied: false });
  });
  test("an opt-out is a reply to a message that was sent; a classified reply is a reply", () => {
    expect(leadReach(lead({ runStatus: "opted_out", whatsappStatus: "stopped", whatsappSentAt: "2026-10-18T10:00:00Z" }))).toEqual({ contacted: true, replied: true });
    expect(leadReach(lead({ channel: "email", emailStatus: "reply_received", category: "interested" }))).toEqual({ contacted: true, replied: true });
    expect(leadReach(lead({ channel: "instagram", instagramStatus: "replied" }))).toEqual({ contacted: true, replied: true });
  });
});

describe("leadOpen: whether the channel engine may still send the lead something", () => {
  test("waiting for a first message or a follow-up, or an invitation awaiting acceptance, is open", () => {
    expect(leadOpen({ ...base, whatsappStatus: "queued" })).toBe(true);
    expect(leadOpen({ ...base, whatsappStatus: "in_sequence", whatsappSentAt: "2026-10-19T10:00:00Z" })).toBe(true);
    expect(leadOpen({ ...base, channel: "email", emailStatus: "initial_sent" })).toBe(true);
    expect(leadOpen({ ...base, channel: "linkedin", linkedinStatus: "REQUEST_SENT" })).toBe(true);
    expect(leadOpen({ ...base, channel: "instagram", instagramStatus: "queued" })).toBe(true);
  });

  test("failed, stopped, finished, replied or opted out is closed", () => {
    for (const status of ["failed", "stopped", "completed", "replied"]) expect(leadOpen({ ...base, whatsappStatus: status })).toBe(false);
    for (const status of ["sequence_completed", "bounced", "suppressed", "reply_received"]) expect(leadOpen({ ...base, channel: "email", emailStatus: status })).toBe(false);
    for (const status of ["FAILED", "CANCELLED", "COMPLETED", "REPLIED", "FOLLOW_UP_3_SENT"]) expect(leadOpen({ ...base, channel: "linkedin", linkedinStatus: status })).toBe(false);
    expect(leadOpen({ ...base, whatsappStatus: "queued", runStatus: "opted_out" })).toBe(false);
  });

  test("no engine row yet is open: a plan is never taken as finished without a record saying so", () => {
    expect(leadOpen(base)).toBe(true);
    expect(leadOpen({ ...base, channel: "instagram" })).toBe(true);
  });
});
