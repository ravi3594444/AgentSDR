import { describe, expect, test } from "bun:test";
import { companyName, firstRoute, leadLabel, memberName, NO_CONTACT_PERSON, prospectName, UNNAMED_PERSON } from "./displayName";

// Leads showed "Unnamed person" for businesses that discovery saved with
// their published name: a Maps listing with a website gets a companies row,
// one without gets raw.company / raw.companyName (records.ts), and neither
// sets people.full_name. The label uses that association and never invents
// a person.

describe("leadLabel", () => {
  test("a person's own name wins, from full name or first and last", () => {
    expect(leadLabel({ fullName: "Priya Shah", email: "priya@lotus.in" }, { name: "Lotus Dental", domain: "lotus.in" })).toEqual({ kind: "person", name: "Priya Shah", secondary: null });
    expect(leadLabel({ fullName: "  ", firstName: "Priya", lastName: "Shah" }, null)).toEqual({ kind: "person", name: "Priya Shah", secondary: null });
  });

  test("no name but a companies row: the company's name, and no person is claimed", () => {
    expect(leadLabel({ fullName: null, email: "info@lotus.in" }, { name: "Lotus Dental Care", domain: "lotus.in" })).toEqual({ kind: "company", name: "Lotus Dental Care", secondary: NO_CONTACT_PERSON });
    expect(NO_CONTACT_PERSON).toBe("No contact person named");
  });

  test("a companies row without a name falls back to its domain", () => {
    expect(leadLabel({ fullName: null }, { name: null, domain: "lotus.in" })).toEqual({ kind: "company", name: "lotus.in", secondary: NO_CONTACT_PERSON });
  });

  test("no companies row: the company the save path kept in raw (a Maps business without a website)", () => {
    expect(leadLabel({ fullName: null, phone: "+919876543210", raw: { company: "Smile Clinic", companyName: "Smile Clinic", businessName: "Smile Clinic" } }, null)).toEqual({ kind: "company", name: "Smile Clinic", secondary: NO_CONTACT_PERSON });
    expect(leadLabel({ raw: { companyName: "Smile Clinic" } }, null).name).toBe("Smile Clinic");
  });

  test("raw.businessName alone never names a lead: directory pseudo-names and social usernames stay unnamed", () => {
    const directory = leadLabel({ phone: "+919876543210", raw: { businessName: "+919876543210 (listed on pune-guide.example)" } }, null);
    expect(directory).toEqual({ kind: "unknown", name: UNNAMED_PERSON, secondary: "+919876543210" });
    const reddit = leadLabel({ email: "fran@example.com", raw: { businessName: "fran_the_dentist" } }, null);
    expect(reddit).toEqual({ kind: "unknown", name: "Unnamed person", secondary: "fran@example.com" });
  });

  test("an unnamed lead shows its first contact route: email, phone, LinkedIn, then Instagram", () => {
    expect(leadLabel({ email: "a@b.co", phone: "+1415" }, null).secondary).toBe("a@b.co");
    expect(leadLabel({ phone: "+14155550100" }, null).secondary).toBe("+14155550100");
    expect(leadLabel({ linkedinUrl: "https://www.linkedin.com/in/priya-shah/" }, null).secondary).toBe("linkedin.com/in/priya-shah");
    expect(leadLabel({ linkedinUrl: "priya-shah" }, null).secondary).toBe("linkedin.com/in/priya-shah");
    expect(leadLabel({ raw: { instagram: { username: "punesmiles" } } }, null).secondary).toBe("@punesmiles");
    expect(leadLabel({}, null)).toEqual({ kind: "unknown", name: "Unnamed person", secondary: null });
  });

  test("blank and non-string values are ignored", () => {
    expect(leadLabel({ fullName: " ", raw: { company: "  ", companyName: 42 } }, { name: "", domain: "" })).toEqual({ kind: "unknown", name: "Unnamed person", secondary: null });
  });
});

describe("companyName and firstRoute", () => {
  test("the companies row comes before what raw kept", () => {
    expect(companyName({ raw: { company: "Old name" } }, { name: "Lotus Dental", domain: "lotus.in" })).toBe("Lotus Dental");
    expect(companyName({ raw: { company: "Old name" } }, null)).toBe("Old name");
    expect(companyName({ raw: { businessName: "Only a label" } }, null)).toBeNull();
  });

  test("firstRoute trims and skips empty routes", () => {
    expect(firstRoute({ email: " ", phone: " +1415 " })).toBe("+1415");
  });
});

describe("memberName: what a new lead-list member is called", () => {
  test("own name, then the business, then email and phone", () => {
    expect(memberName({ fullName: "Priya Shah", email: "p@x.in" }, { name: "Lotus", domain: "lotus.in" })).toBe("Priya Shah");
    expect(memberName({ email: "info@lotus.in", phone: "+91" }, { name: "Lotus Dental", domain: "lotus.in" })).toBe("Lotus Dental");
    expect(memberName({ phone: "+919876543210", raw: { company: "Smile Clinic", businessName: "Smile Clinic" } }, null)).toBe("Smile Clinic");
  });

  test("without a business: email, phone, then the save path's own label, then the Instagram username", () => {
    expect(memberName({ email: "a@b.co", raw: { businessName: "fran_the_dentist" } }, null)).toBe("a@b.co");
    expect(memberName({ phone: "+919876543210", raw: { businessName: "+919876543210 (listed on x.example)" } }, null)).toBe("+919876543210");
    expect(memberName({ raw: { businessName: "fran_the_dentist" } }, null)).toBe("fran_the_dentist");
    expect(memberName({ raw: { instagram: { username: "@PuneSmiles" } } }, null)).toBe("PuneSmiles");
    expect(memberName({ raw: {} }, null, "punesmiles")).toBe("punesmiles");
    expect(memberName({}, null)).toBe("Unnamed lead");
  });

  test("a company domain alone does not name a member (an address is more useful than a bare domain)", () => {
    expect(memberName({ email: "info@lotus.in" }, { name: null, domain: "lotus.in" })).toBe("info@lotus.in");
  });
});

describe("prospectName: an already stored member at read time", () => {
  const smile = { phone: "+919876543210", email: null, raw: { company: "Smile Clinic" } };

  test("a name that was only a route fallback is named as a new member would be", () => {
    expect(prospectName("+919876543210", smile, null)).toBe("Smile Clinic");
    expect(prospectName("INFO@lotus.in", { email: "info@lotus.in" }, { name: "Lotus Dental", domain: "lotus.in" })).toBe("Lotus Dental");
    expect(prospectName("Unnamed lead", { raw: { companyName: "Smile Clinic" } }, null)).toBe("Smile Clinic");
  });

  test("a real stored name is kept as it was stored", () => {
    expect(prospectName("Lotus Dental Care", { email: "info@lotus.in" }, { name: "Another name", domain: "lotus.in" })).toBe("Lotus Dental Care");
    expect(prospectName("fran_the_dentist", { raw: { businessName: "fran_the_dentist" } }, null)).toBe("fran_the_dentist");
  });

  test("a directory contact with no business stays its route", () => {
    expect(prospectName("+919876543210", { phone: "+919876543210", raw: { businessName: "+919876543210 (listed on x.example)" } }, null)).toBe("+919876543210");
  });

  test("a member whose person is gone keeps its stored name", () => {
    expect(prospectName("+919876543210", null, null)).toBe("+919876543210");
  });
});
