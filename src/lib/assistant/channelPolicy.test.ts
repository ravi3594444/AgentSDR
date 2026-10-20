import { describe, expect, test } from "bun:test";
import { channelPolicy, ownerChannels, planChannelsLine, unreachableReason } from "./channelPolicy";

describe("the channels the owner's own words name", () => {
  test("a general request names none, even when it names where to search", () => {
    expect(ownerChannels("start outreach find B2B business owners, real estate founders, etc., and people who do not have a website; outreach them")).toEqual({ only: [], excluded: [] });
    expect(ownerChannels("find real estate founders on LinkedIn and contact them")).toEqual({ only: [], excluded: [] });
    expect(ownerChannels("find dentists in Pune on Google Maps and Instagram, reach out to them")).toEqual({ only: [], excluded: [] });
  });

  test("how to contact them, in the owner's words", () => {
    expect(ownerChannels("find dentists in Pune and message them on WhatsApp").only).toEqual(["whatsapp"]);
    expect(ownerChannels("WhatsApp only please").only).toEqual(["whatsapp"]);
    expect(ownerChannels("only email").only).toEqual(["email"]);
    expect(ownerChannels("email them").only).toEqual(["email"]);
    expect(ownerChannels("send them an email and a LinkedIn invite").only).toEqual(["email", "linkedin"]);
    expect(ownerChannels("reach out via e-mail or whatsapp").only).toEqual(["email", "whatsapp"]);
    expect(ownerChannels("contact them on LinkedIn").only).toEqual(["linkedin"]);
    expect(ownerChannels("DM them on Instagram").only).toEqual(["instagram"]);
  });

  test("a channel the owner rules out", () => {
    expect(ownerChannels("contact them, but don't email them").excluded).toEqual(["email"]);
    expect(ownerChannels("no WhatsApp please, reach out to them").excluded).toEqual(["whatsapp"]);
  });
});

describe("the channel order a plan uses", () => {
  test("a general request keeps every route: the model's choice only goes first", () => {
    const policy = channelPolicy({ requested: ["whatsapp"], ownerText: "find B2B business owners and outreach them" });
    expect(policy.order).toEqual(["whatsapp", "email", "linkedin", "instagram"]);
    expect(policy.restricted).toBe(false);
  });

  test("with nothing chosen, the saved preference then the default order", () => {
    expect(channelPolicy({ requested: [], ownerText: "contact them" }).order).toEqual(["email", "whatsapp", "linkedin", "instagram"]);
    expect(channelPolicy({ requested: [], ownerText: "contact them", preferred: ["linkedin"] }).order).toEqual(["linkedin", "email", "whatsapp", "instagram"]);
    expect(channelPolicy({ requested: [], ownerText: "contact them", preferred: ["whatsapp"] }).restricted).toBe(false);
  });

  test("an owner who names channels restricts the plan to them, whatever the model passed", () => {
    const named = channelPolicy({ requested: ["whatsapp", "email"], ownerText: "message them on WhatsApp" });
    expect(named.order).toEqual(["whatsapp"]);
    expect(named.restricted).toBe(true);
    expect(named.note).toMatch(/you asked for WhatsApp/);
    expect(channelPolicy({ requested: ["linkedin", "email"], ownerText: "email or LinkedIn them" }).order).toEqual(["linkedin", "email"]);
  });

  test("a channel the owner ruled out is never used", () => {
    const policy = channelPolicy({ requested: ["email"], ownerText: "contact them, but don't email them" });
    expect(policy.order).toEqual(["whatsapp", "linkedin", "instagram"]);
    expect(policy.restricted).toBe(true);
    expect(policy.note).toBe("you asked not to use email");
  });

  test("an earlier run's channels lead a follow-on plan without restricting it", () => {
    expect(channelPolicy({ requested: [], ownerText: "contact more of them", base: ["whatsapp"] }).order).toEqual(["whatsapp", "email", "linkedin", "instagram"]);
  });
});

test("a word that only contains a channel's name is not one", () => {
  expect(ownerChannels("leave them a voicemail, reach out to them")).toEqual({ only: [], excluded: [] });
  expect(ownerChannels("for instance, contact them")).toEqual({ only: [], excluded: [] });
});

describe("why a lead gets no channel", () => {
  const ready = { available: true, reason: null };
  const availability = { email: { available: false, reason: "no connected mailbox" }, whatsapp: ready, linkedin: ready, instagram: { available: false, reason: "no Instagram account linked" } };

  test("the owner left its only route out", () => {
    const policy = channelPolicy({ requested: [], ownerText: "message them on WhatsApp" });
    expect(unreachableReason(["email"], policy, availability)).toBe("reachable only by email, which is not used in this run (you asked for WhatsApp)");
  });

  test("its only route's sender cannot send yet", () => {
    const policy = channelPolicy({ requested: [], ownerText: "reach out to them" });
    expect(unreachableReason(["email"], policy, availability)).toBe("reachable only by email, which cannot send yet (no connected mailbox)");
  });

  test("both at once, named separately", () => {
    const policy = channelPolicy({ requested: [], ownerText: "contact them, but don't use WhatsApp or LinkedIn" });
    expect(policy.order).toEqual(["email", "instagram"]);
    expect(unreachableReason(["whatsapp", "email"], policy, availability)).toBe("reachable only by WhatsApp or email: WhatsApp is not used in this run (you asked not to use WhatsApp or LinkedIn); email cannot send yet (no connected mailbox)");
  });
});

test("the plan line names the channels used and the main reasons people were left out", () => {
  const plan = {
    assignments: [{ personId: "a", channel: "whatsapp" as const }, { personId: "b", channel: "whatsapp" as const }, { personId: "c", channel: "email" as const }],
    excluded: [{ reason: "on Do Not Contact", count: 1 }, { reason: "reachable only by LinkedIn, which cannot send yet (no LinkedIn account connected)", count: 4 }],
    channelNote: null,
  };
  expect(planChannelsLine(plan)).toBe("3 leads (WhatsApp 2, email 1), each on its best ready channel; left out: 4 reachable only by LinkedIn, which cannot send yet (no LinkedIn account connected); 1 on Do Not Contact");
  expect(planChannelsLine({ assignments: plan.assignments.slice(0, 1), excluded: [{ reason: "reachable only by email, which is not used in this run (you asked for WhatsApp)", count: 22 }], channelNote: "you asked for WhatsApp" }))
    .toBe("1 lead (WhatsApp 1), only the channels you named (you asked for WhatsApp); left out: 22 reachable only by email, which is not used in this run (you asked for WhatsApp)");
});
