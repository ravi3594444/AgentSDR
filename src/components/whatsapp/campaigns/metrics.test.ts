import { describe, expect, test } from "bun:test";
import type { WhatsappCampaignStats } from "@/lib/whatsapp/campaigns/contract";
import { campaignFunnel, leadsProgressText } from "./metrics";

const stats = (counts: Partial<WhatsappCampaignStats>): WhatsappCampaignStats => {
  const s = { queued: 0, in_sequence: 0, completed: 0, replied: 0, stopped: 0, failed: 0, contacted: 0, messagesSent: 0, ...counts };
  return { ...s, total: counts.total ?? s.queued + s.in_sequence + s.completed + s.replied + s.stopped + s.failed };
};

describe("a WhatsApp campaign's lead helper says what the counts say", () => {
  test("its only lead rejected by WhatsApp: 1 failed, 0 contacted, never \"Everyone has been messaged\"", () => {
    const f = campaignFunnel(stats({ failed: 1 }));
    expect(leadsProgressText(f)).toBe("No leads waiting for a first message; 1 failed, 0 contacted");
    expect(f.messaged).toBe(0);
    expect(f.progress).toBe(0);
    expect(f.complete).toBe(false);
  });

  test("6 messaged and in sequence, 6 failed: both outcomes, follow-ups still to come", () => {
    const f = campaignFunnel(stats({ in_sequence: 6, failed: 6, contacted: 6, messagesSent: 6 }));
    expect(leadsProgressText(f)).toBe("No leads waiting for a first message; 6 failed, 6 contacted");
    expect(f.progress).toBe(0.5);
    expect(f.complete).toBe(false);
  });

  test("all queued, some queued, all sent", () => {
    expect(leadsProgressText(campaignFunnel(stats({ queued: 3 })))).toBe("3 not messaged yet");
    expect(leadsProgressText(campaignFunnel(stats({ queued: 2, in_sequence: 1, failed: 1, contacted: 1 })))).toBe("2 not messaged yet; 1 failed");
    const sent = campaignFunnel(stats({ in_sequence: 2, completed: 1, contacted: 3, messagesSent: 4 }));
    expect(leadsProgressText(sent)).toBe("Everyone has been messaged");
    expect(sent.complete).toBe(true);
    expect(leadsProgressText(campaignFunnel(stats({})))).toBeUndefined();
  });

  test("after Stop, the people messaged before it still count as messaged; current work shows as stopped", () => {
    // 46 leads stopped, 9 of them messaged first (last_sent_at kept); 9 messages sent.
    const f = campaignFunnel(stats({ stopped: 46, contacted: 9, messagesSent: 9 }));
    expect(f.messaged).toBe(9);
    expect(f.messagesSent).toBe(9);
    expect(f.stopped).toBe(46);
    expect(leadsProgressText(f)).toBe("No leads waiting for a first message; 9 contacted, 46 stopped");
  });

  test("an older payload without the evidence count falls back to the statuses that imply a message", () => {
    const legacy: Partial<WhatsappCampaignStats> = stats({ in_sequence: 2, replied: 1 });
    delete legacy.contacted;
    expect(campaignFunnel(legacy as WhatsappCampaignStats).messaged).toBe(3);
  });
});
