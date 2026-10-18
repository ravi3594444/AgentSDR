import { describe, expect, test } from "bun:test";
import { contactDisplayName } from "./contactName";

describe("contactDisplayName", () => {
  test("a known name wins", () => {
    expect(contactDisplayName({ fullName: "Priya Shah", company: "Shah Homes", phone: "+919800000001" })).toBe("Priya Shah");
    expect(contactDisplayName({ firstName: "Priya", lastName: "Shah" })).toBe("Priya Shah");
  });

  test("an unknown name shows the business and the conversation's route", () => {
    const parts = { company: "Bright Path Dental", phone: "+919800000001", email: "desk@brightpath.in", instagram: "brightpath" };
    expect(contactDisplayName({ ...parts, channel: "whatsapp" })).toBe("Bright Path Dental · +919800000001");
    expect(contactDisplayName({ ...parts, channel: "email" })).toBe("Bright Path Dental · desk@brightpath.in");
    expect(contactDisplayName({ ...parts, channel: "instagram" })).toBe("Bright Path Dental · @brightpath");
  });

  test("a route alone, a business alone, and nothing at all", () => {
    expect(contactDisplayName({ email: "desk@brightpath.in" })).toBe("desk@brightpath.in");
    expect(contactDisplayName({ linkedin: "https://www.linkedin.com/in/janedoe42/" })).toBe("LinkedIn · janedoe42");
    expect(contactDisplayName({ company: "Bright Path Dental" })).toBe("Bright Path Dental");
    expect(contactDisplayName({ fullName: "  ", phone: "" })).toBe("Unknown contact");
  });
});
