import { describe, expect, test } from "bun:test";
import { leadProgress, type LeadProgressInput } from "./runLeads";

const base: LeadProgressInput = { channel: "whatsapp", runStatus: "active", emailStatus: null, whatsappStatus: null, whatsappSentAt: null, whatsappError: null, linkedinStatus: null, category: null, subcategory: null };

describe("leadProgress", () => {
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
});
