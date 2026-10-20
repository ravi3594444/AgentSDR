import { describe, expect, test } from "bun:test";
import { campaignFunnel, leadsProgressText } from "./metrics";

describe("a LinkedIn campaign's invited count and lead helper", () => {
  test("after Stop, invitations already sent still count as invited (their requestSentAt is kept)", () => {
    // Stop cancelled 2 invited leads and 1 still pending; the API counts the 2 invitations from requestSentAt.
    const f = campaignFunnel({ CANCELLED: 3 }, 3, { invited: 2 });
    expect(f.invited).toBe(2);
    expect(f.cancelled).toBe(3);
    expect(leadsProgressText(f)).toBe("No leads waiting for an invitation; 2 invited, 3 cancelled");
    expect(f.complete).toBe(false);
  });

  test("without the evidence count it reads the statuses, as before", () => {
    expect(campaignFunnel({ REQUEST_SENT: 2, CONNECTED: 1, PENDING: 4 }).invited).toBe(3);
  });

  test("never \"Everyone has been invited\" when invitations failed", () => {
    const failed = campaignFunnel({ FAILED: 1 }, 1, { invited: 0 });
    expect(leadsProgressText(failed)).toBe("No leads waiting for an invitation; 1 failed, 0 invited");
    expect(failed.progress).toBe(0);
    const all = campaignFunnel({ REQUEST_SENT: 2, REPLIED: 1 }, 3, { invited: 3 });
    expect(leadsProgressText(all)).toBe("Everyone has been invited");
    expect(all.complete).toBe(true);
    expect(leadsProgressText(campaignFunnel({ PENDING: 2, REQUEST_SENT: 1 }, 3, { invited: 1 }))).toBe("2 not invited yet");
  });
});
