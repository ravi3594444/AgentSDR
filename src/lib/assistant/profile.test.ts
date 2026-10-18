import { describe, expect, test } from "bun:test";
import { contactChannels, countReasons } from "./audiences";
import { mergeProfile, missingForDiscovery, missingForOutreach, profileKnowledgeText } from "./profile";

describe("mergeProfile", () => {
  test("replaces, clears and keeps fields; target customers stay free text", () => {
    const { profile, problems } = mergeProfile(
      { businessName: "Old", offer: "Cleaning", notes: "keep me" },
      { businessName: " Smile Co ", offer: "", targetCustomers: "independent veterinary clinics", language: "EN", preferredChannels: ["email", "whatsapp", "email"] },
    );
    expect(problems).toEqual([]);
    expect(profile).toEqual({ businessName: "Smile Co", targetCustomers: "independent veterinary clinics", language: "en", preferredChannels: ["email", "whatsapp"], notes: "keep me" });
  });

  test("reports unknown keys and bad values without storing them", () => {
    const { profile, problems } = mergeProfile({}, { favouriteColour: "blue", language: "English", preferredChannels: ["fax"], offer: 5 });
    expect(profile).toEqual({});
    expect(problems).toHaveLength(4);
  });
});

describe("what is missing", () => {
  test("outreach needs the business, offer and sender; discovery needs customers and place", () => {
    expect(missingForOutreach({})).toEqual(["the business name", "what you offer and why it helps", "the name messages are signed with"]);
    expect(missingForOutreach({ businessName: "A", offer: "B", senderName: "C" })).toEqual([]);
    expect(missingForDiscovery({ targetCustomers: "law firms" })).toEqual(["where to look"]);
  });

  test("profileKnowledgeText writes labelled fields", () => {
    expect(profileKnowledgeText({ businessName: "Acme", preferredChannels: ["email"] })).toBe("Business: Acme\n\nPreferred channels: email");
  });
});

describe("contactChannels", () => {
  const none = { email: null, phone: null, linkedinUrl: null, doNotContact: false, emailSuppressed: false };

  test("each usable contact opens its channel", () => {
    expect(contactChannels({ ...none, email: "a@acme.com", phone: "+919876543210", linkedinUrl: "https://www.linkedin.com/in/a" }))
      .toEqual({ channels: ["email", "whatsapp", "linkedin"], reason: null });
  });

  test("Do Not Contact, suppression and missing contacts give a reason", () => {
    expect(contactChannels({ ...none, email: "a@acme.com", doNotContact: true })).toEqual({ channels: [], reason: "marked Do Not Contact" });
    expect(contactChannels({ ...none, email: "a@acme.com", emailSuppressed: true })).toEqual({ channels: [], reason: "email unsubscribed or bounced" });
    expect(contactChannels({ ...none, phone: "98765" })).toEqual({ channels: [], reason: "no email, phone, LinkedIn or Instagram profile" });
    expect(contactChannels({ ...none, email: "a@acme.com", emailSuppressed: true, phone: "+14155550100" })).toEqual({ channels: ["whatsapp"], reason: null });
  });

  test("a wrong number closes that channel only", () => {
    expect(contactChannels({ ...none, email: "a@acme.com", phone: "+919876543210", wrongChannels: ["whatsapp"] })).toEqual({ channels: ["email"], reason: null });
    expect(contactChannels({ ...none, phone: "+919876543210", wrongChannels: ["whatsapp"] })).toEqual({ channels: [], reason: "wrong number" });
  });

  test("countReasons counts largest first", () => {
    expect(countReasons(["a", "b", "a", null])).toEqual([{ reason: "a", count: 2 }, { reason: "b", count: 1 }]);
  });
});

test("a list of places or customers is saved as one line of text", () => {
  const { profile, problems } = mergeProfile({}, { locations: ["Pune", " PCMC "], targetCustomers: ["dental clinics"], offer: { bad: true } });
  expect(profile.locations).toBe("Pune, PCMC");
  expect(profile.targetCustomers).toBe("dental clinics");
  expect(problems).toEqual(["offer must be text"]);
});
