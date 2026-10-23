import { describe, expect, test } from "bun:test";
import { sameWhatsappContact, whatsappContactPhone } from "./contactIdentity";

describe("WhatsApp contact aliases", () => {
  const phone = "+918084794983";
  const jid = "918084794983@s.whatsapp.net";
  const lid = "207716110643219@lid";
  const proof = { personPhone: phone, chatPhone: phone, chatProviderId: lid };
  test("matches phone-bearing formats, including device ids", () => {
    for (const alias of [phone, "91 8084794983", jid, "918084794983:17@s.whatsapp.net", "918084794983@c.us"]) {
      expect(sameWhatsappContact(jid, alias)).toBe(true);
    }
    expect(sameWhatsappContact(jid, "919999999999@s.whatsapp.net", proof)).toBe(false);
    expect(sameWhatsappContact("unknown:17@elsewhere", "unknown@elsewhere", proof)).toBe(false);
  });
  test("allows only a proven phone/privacy transition", () => {
    expect(sameWhatsappContact(jid, lid, proof)).toBe(true);
    expect(sameWhatsappContact(lid, jid, { ...proof, chatProviderId: jid })).toBe(true);
    expect(sameWhatsappContact(jid, lid)).toBe(false);
    expect(sameWhatsappContact(jid, lid, { ...proof, chatPhone: "+919999999999" })).toBe(false);
    expect(sameWhatsappContact(jid, lid, { ...proof, personPhone: "+919999999999" })).toBe(false);
    expect(sameWhatsappContact(jid, lid, { ...proof, chatProviderId: "123456789@lid" })).toBe(false);
    expect(sameWhatsappContact(lid, "123456789@lid", proof)).toBe(false);
  });
  test("never guesses a phone from privacy, group or arbitrary ids", () => {
    for (const id of [lid, "918084794983@g.us", "contact-918084794983", "08084794983", ""]) expect(whatsappContactPhone(id)).toBeNull();
  });
});
