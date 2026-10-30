import { describe, expect, test } from "bun:test";
import { contactChannels, countReasons } from "./audiences";
import { mergeProfile, missingForDiscovery, missingForOutreach, PROFILE_FIELD_MAX, profileKnowledgeText, profilePatchProblems } from "./profile";

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

describe("profilePatchProblems (Settings → Your business)", () => {
  test("accepts profile fields as text, an empty string to clear, a language code and known channels", () => {
    expect(profilePatchProblems({ businessName: "Bright Path", offer: "", language: "EN", preferredChannels: ["email", "instagram"] })).toEqual([]);
    expect(mergeProfile({ offer: "Old" }, { businessName: "Bright Path", offer: "" }).profile).toEqual({ businessName: "Bright Path" });
  });

  test("names each problem in plain words and saves nothing it would change", () => {
    expect(profilePatchProblems({ favouriteColour: "blue", offer: 5, language: "English", preferredChannels: ["fax"] })).toEqual([
      "favouriteColour is not part of the business profile",
      "Offer must be text",
      "Language must be a two-letter code such as en",
      "Preferred channels must be a list of email, whatsapp, linkedin, instagram",
    ]);
    expect(profilePatchProblems({ notes: "x".repeat(PROFILE_FIELD_MAX + 1) })).toEqual(["Notes is too long: keep it under 4,000 characters"]);
    expect(profilePatchProblems({ notes: "x".repeat(PROFILE_FIELD_MAX) })).toEqual([]);
  });

  test("refuses a body that is not an object of fields, or is empty", () => {
    expect(profilePatchProblems(null)).toHaveLength(1);
    expect(profilePatchProblems(["offer"])).toHaveLength(1);
    expect(profilePatchProblems({})).toEqual(["Nothing to save"]);
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
    expect(contactChannels({ ...none, phone: "98765" })).toEqual({ channels: [], reason: "no email, phone, LinkedIn, Instagram or other social profile" });
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
