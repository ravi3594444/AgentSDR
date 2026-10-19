import { describe, expect, test } from "bun:test";
import { instagramCommenterHold, instagramResearchHold } from "./instagramEligibility";

describe("instagramResearchHold", () => {
  test("an Instagram-only account whose profile was read and names the place is a qualified lead", () => {
    expect(instagramResearchHold({ profileRead: true, placeNamed: true, where: "Pune, India" })).toBeNull();
  });
  test("with no place asked, a read profile is enough", () => {
    expect(instagramResearchHold({ profileRead: true, placeNamed: false, where: "" })).toBeNull();
    expect(instagramResearchHold({ profileRead: true, placeNamed: false, where: null })).toBeNull();
  });
  test("an unread profile is kept for research, never called uncontactable", () => {
    const hold = instagramResearchHold({ profileRead: false, placeNamed: true, where: "Pune" });
    expect(hold).toContain("not verified");
    expect(hold).toContain("kept for research");
    expect(hold).not.toMatch(/cannot|no supported channel/);
  });
  test("an account that does not name the place is kept for research with the place named", () => {
    const hold = instagramResearchHold({ profileRead: true, placeNamed: false, where: "Los Angeles, CA" });
    expect(hold).toContain("location is not verified");
    expect(hold).toContain("Los Angeles");
    expect(hold).not.toContain("CA");
  });
  test("a commenter is kept for research with the post it commented on", () => {
    expect(instagramCommenterHold("https://www.instagram.com/p/abc/")).toContain("https://www.instagram.com/p/abc/");
  });
});
