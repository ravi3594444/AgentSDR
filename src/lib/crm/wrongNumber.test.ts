import { describe, expect, test } from "bun:test";
import {
  acknowledgementProblems,
  candidateRoutes,
  closingAcknowledgement,
  detectsOptOutWording,
  detectsWrongNumber,
  fallbackAcknowledgement,
  normalizeRoute,
  wrongRouteAckLabel,
} from "./wrongNumber";

describe("routes", () => {
  test("are one comparable value per channel", () => {
    expect(normalizeRoute("whatsapp", "919876543210@s.whatsapp.net")).toBe("919876543210");
    expect(normalizeRoute("whatsapp", "+91 98765-43210")).toBe("919876543210");
    expect(normalizeRoute("whatsapp", "12")).toBeNull();
    expect(normalizeRoute("email", " Dr.Rao@Clinic.TEST ")).toBe("dr.rao@clinic.test");
    expect(normalizeRoute("email", "not an address")).toBeNull();
    expect(normalizeRoute("linkedin", "https://www.linkedin.com/in/Rao/")).toBe("https://www.linkedin.com/in/rao");
  });

  test("a conversation reaches its contact and the Person's own address on the channel", () => {
    expect(candidateRoutes("whatsapp", { providerContactId: "919876543210@s.whatsapp.net", phone: "+919876543210" })).toEqual(["919876543210"]);
    expect(candidateRoutes("whatsapp", { providerContactId: "919876543210@s.whatsapp.net", phone: "+919800000000" })).toEqual(["919876543210", "919800000000"]);
    expect(candidateRoutes("email", { email: "Lead@Clinic.test", phone: "+919876543210" })).toEqual(["lead@clinic.test"]);
    expect(candidateRoutes("sms", { phone: "+919876543210" })).toEqual([]);
  });
});

describe("reading the message", () => {
  test("finds a wrong number in plain words, in the languages leads write", () => {
    for (const text of ["Wrong number", "Sorry, wrong no.", "you have the wrong person", "This is not the right number", "galat number hai", "गलत नंबर", "Número equivocado", "numero errado", "Mauvais numéro"]) {
      expect(detectsWrongNumber(text)).toBe(true);
    }
    for (const text of ["What is the number for the service?", "Wrong time, call me later", "Is this the right price?"]) {
      expect(detectsWrongNumber(text)).toBe(false);
    }
  });

  test("an explicit stop, unsubscribe or don't-contact wins, however it is put", () => {
    for (const text of ["Wrong number, stop messaging me", "wrong number. STOP", "Unsubscribe", "don't text me again", "Do not contact me", "leave me alone", "I'll block you", "remove this number", "message mat karo", "मत भेजो"]) {
      expect(detectsOptOutWording(text)).toBe(true);
    }
    for (const text of ["Wrong number", "Sorry, you have the wrong person", "not me"]) {
      expect(detectsOptOutWording(text)).toBe(false);
    }
  });
});

describe("the closing acknowledgement", () => {
  test("the fixed line is in the recipient's language and passes its own check", () => {
    const lines = [
      fallbackAcknowledgement("Wrong number", "whatsapp"),
      fallbackAcknowledgement("Wrong person", "email"),
      fallbackAcknowledgement("wrong person", "linkedin"),
      fallbackAcknowledgement("गलत नंबर है", "whatsapp"),
      fallbackAcknowledgement("galat number hai bhai", "whatsapp"),
      fallbackAcknowledgement("Número equivocado", "whatsapp"),
      fallbackAcknowledgement("Número errado", "whatsapp"),
      fallbackAcknowledgement("Mauvais numéro", "whatsapp"),
      fallbackAcknowledgement("Falsche Nummer", "whatsapp"),
    ];
    expect(lines[0]).toBe("Sorry about that—we won't message this number again.");
    expect(lines[1]).toBe("Sorry about that—we won't email this address again.");
    expect(lines[3]).toContain("नंबर");
    expect(lines[4]).toContain("galti");
    expect(lines[5]).toContain("número");
    for (const line of lines) expect(acknowledgementProblems(line)).toEqual([]);
  });

  test("never asks, offers, pitches, links or asks for the right number", () => {
    expect(acknowledgementProblems("Sorry! Is this Dr Rao?")).toContain("it asks a question");
    expect(acknowledgementProblems("Sorry about that. Do check our free trial.").join(" ")).toContain("pitches");
    expect(acknowledgementProblems("Sorry, see https://example.test").join(" ")).toContain("link");
    expect(acknowledgementProblems("Sorry, we'll stop. Call 98765 43210 anytime").join(" ")).toContain("number");
    expect(acknowledgementProblems("Sorry! Please share the right number for Dr Rao.").join(" ")).toContain("asks for something");
    expect(acknowledgementProblems("Sorry, let us know who handles this.").join(" ")).toContain("asks for something");
    expect(acknowledgementProblems("x".repeat(250)).join(" ")).toContain("characters");
    expect(acknowledgementProblems("")).toEqual(["it is empty"]);
    expect(acknowledgementProblems("Apologies for the mix-up — you won't hear from us again.")).toEqual([]);
  });

  test("the model's line is used when it passes, the fixed one when it does not", () => {
    expect(closingAcknowledgement("Apologies — we won't message this number again.", "Wrong number", "whatsapp")).toEqual({ text: "Apologies — we won't message this number again.", problems: [] });
    const replaced = closingAcknowledgement("Sorry! Could you share the right number?", "Wrong number", "whatsapp");
    expect(replaced.text).toBe("Sorry about that—we won't message this number again.");
    expect(replaced.problems.length).toBeGreaterThan(0);
    expect(closingAcknowledgement(null, "गलत नंबर", "whatsapp").text).toContain("नंबर");
  });

  test("the record page names where it stands", () => {
    expect(wrongRouteAckLabel("sent").label).toBe("Apology sent");
    expect(wrongRouteAckLabel("drafted").label).toBe("Apology awaiting review");
    expect(wrongRouteAckLabel("blocked", "the lead is marked Do Not Contact").label).toBe("No apology sent: the lead is marked Do Not Contact");
    expect(wrongRouteAckLabel("failed", "refused").tone).toBe("failed");
    expect(wrongRouteAckLabel("uncertain").label).toContain("uncertain");
  });
});
