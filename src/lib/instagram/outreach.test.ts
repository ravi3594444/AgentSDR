import { describe, expect, test } from "bun:test";
import { contactChannels } from "@/lib/assistant/audiences";
import { sequenceProblem } from "@/lib/assistant/messages";
import {
  deliverInitialInstagramDm,
  instagramRecipient,
  type InitialDmEffects,
} from "./outreach";

const job = {
  id: "reservation",
  username: "example.shop",
  text: "Hello! Would you like a short introduction?",
  unipileAccountId: "sender",
};
function harness(overrides: Partial<InitialDmEffects> = {}) {
  const calls: unknown[][] = [];
  const effects: InitialDmEffects = {
    resolve: async (...args) => {
      calls.push(["resolve", ...args]);
      return { username: job.username, messagingId: "messaging-id" };
    },
    reserve: async (recipient) => {
      calls.push(["reserve", recipient]);
      return true;
    },
    send: async (...args) => {
      calls.push(["send", ...args]);
      return { chatId: "chat", messageId: "message" };
    },
    sent: async (...args) => {
      calls.push(["sent", ...args]);
    },
    failed: async (...args) => {
      calls.push(["failed", ...args]);
    },
    ...overrides,
  };
  return { calls, effects };
}

describe("Instagram initial DM", () => {
  test("requires the confirmed profile's messaging ID, never a scraped pk/provider_id", () => {
    expect(
      instagramRecipient(
        {
          provider: "INSTAGRAM",
          username: "Example.Shop",
          pk: 123,
          provider_id: "profile-id",
          provider_messaging_id: "dm-id",
        },
        "@example.shop",
      ),
    ).toEqual({ username: "example.shop", messagingId: "dm-id" });
    for (const profile of [
      null,
      {
        provider: "INSTAGRAM",
        username: job.username,
        pk: 123,
        provider_id: "profile-id",
      },
      {
        provider: "INSTAGRAM",
        username: "other",
        provider_messaging_id: "dm-id",
      },
      {
        provider: "LINKEDIN",
        username: job.username,
        provider_messaging_id: "dm-id",
      },
      {
        provider: "INSTAGRAM",
        username: job.username,
        provider_messaging_id: Number.MAX_SAFE_INTEGER + 1,
      },
    ]) {
      expect(() => instagramRecipient(profile, job.username)).toThrow();
    }
  });
  test("reserves before POST and records the returned IDs", async () => {
    const h = harness();
    await deliverInitialInstagramDm(job, h.effects);
    expect(h.calls.map((c) => c[0])).toEqual([
      "resolve",
      "reserve",
      "send",
      "sent",
    ]);
    expect(h.calls[2]).toEqual(["send", "sender", "messaging-id", job.text]);
  });
  test("a changed approval, DNC, reply, account or limit gate can cancel before POST", async () => {
    const h = harness({ reserve: async () => false });
    await deliverInitialInstagramDm(job, h.effects);
    expect(h.calls.map((c) => c[0])).toEqual(["resolve"]);
  });
  test("invalid/unfilled messages and unresolved profiles do not attempt a DM", async () => {
    for (const text of [" ", "x".repeat(601), "Hello {{missing}}"]) {
      const h = harness();
      await deliverInitialInstagramDm({ ...job, text }, h.effects);
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]?.[0]).toBe("failed");
      expect(h.calls[0]?.[2]).toBe(false);
    }
    const h = harness({
      resolve: async () => {
        throw new Error("No messaging identifier");
      },
    });
    await deliverInitialInstagramDm(job, h.effects);
    expect(h.calls).toEqual([["failed", "No messaging identifier", false]]);
  });
  test("a definite refusal fails; timeout, transport and 5xx remain uncertain without a retry", async () => {
    for (const status of [400, 401, 403, 404, 422, 429, 408, 500, 503, null]) {
      let posts = 0;
      const h = harness({
        send: async () => {
          posts++;
          throw Object.assign(new Error("provider result"), { status });
        },
      });
      await deliverInitialInstagramDm(job, h.effects);
      expect(posts).toBe(1);
      expect(h.calls.at(-1)).toEqual([
        "failed",
        "provider result",
        status === null || status === 408 || status >= 500,
      ]);
    }
  });
  test("a persistence failure after success stays uncertain; it does not send again", async () => {
    const h = harness({
      sent: async () => {
        throw new Error("database unavailable");
      },
    });
    await deliverInitialInstagramDm(job, h.effects);
    expect(h.calls.filter((c) => c[0] === "send")).toHaveLength(1);
    expect(h.calls.at(-1)).toEqual(["failed", "database unavailable", true]);
  });
  test("an Instagram-only contact is usable, DNC excludes it, and only one initial message is allowed", () => {
    const facts = {
      email: null,
      phone: null,
      linkedinUrl: null,
      instagramUsername: "example.shop",
      doNotContact: false,
      emailSuppressed: false,
    };
    expect(contactChannels(facts).channels).toEqual(["instagram"]);
    expect(contactChannels({ ...facts, doNotContact: true }).channels).toEqual(
      [],
    );
    expect(
      contactChannels({ ...facts, instagramUsername: "bad handle" }).channels,
    ).toEqual([]);
    const step = { subject: null, body: job.text, waitDays: 0 };
    expect(sequenceProblem("instagram", [step], [])).toBeNull();
    expect(sequenceProblem("instagram", [step, step], [])).not.toBeNull();
    expect(
      sequenceProblem("instagram", [{ ...step, subject: "Subject" }], []),
    ).not.toBeNull();
  });
});
