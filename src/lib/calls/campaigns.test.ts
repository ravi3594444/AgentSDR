import { describe, expect, test } from "bun:test";
import { linkedinProfileUrl, nextStageAfterMessage, photoLink, resolveContactPersonUpdate, resolveImportRow } from "./campaigns";

describe("nextStageAfterMessage", () => {
  test("a Done contact stays Done", () => {
    expect(nextStageAfterMessage("done")).toBe("done");
  });

  test("to_call and follow_up both move to follow_up", () => {
    expect(nextStageAfterMessage("to_call")).toBe("follow_up");
    expect(nextStageAfterMessage("follow_up")).toBe("follow_up");
  });
});

describe("resolveImportRow", () => {
  const normalize = (input: string) => (input === "9876543210" ? "+919876543210" : null);

  test("skips a row with no phone at all", () => {
    const result = resolveImportRow({ fullName: "Jane Doe" }, 5, normalize);
    expect(result).toEqual({ ok: false, message: "row 5: no valid phone number" });
  });

  test("skips a row whose phone fails to normalize", () => {
    const result = resolveImportRow({ fullName: "Jane Doe", phone: "garbage" }, 7, normalize);
    expect(result).toEqual({ ok: false, message: "row 7: no valid phone number" });
  });

  test("an explainer turns the failure into the reason the number was refused", () => {
    const result = resolveImportRow({ phone: "12" }, 9, normalize, (input) => `“${input}” is too short to be a phone number`);
    expect(result).toEqual({ ok: false, message: "row 9: “12” is too short to be a phone number" });
  });

  test("accepts a row with a valid phone and no name at all", () => {
    const result = resolveImportRow({ phone: "9876543210" }, 3, normalize);
    expect(result).toEqual({
      ok: true,
      phone: "+919876543210",
      fullName: null,
      companyName: null,
      companyDomain: null,
      title: null,
      email: null,
      linkedinUrl: null,
    });
  });

  test("falls back to firstName + lastName when fullName is absent", () => {
    const result = resolveImportRow({ firstName: "Jane", lastName: "Doe", phone: "9876543210" }, 2, normalize);
    expect(result.ok).toBe(true);
    expect(result.ok && result.fullName).toBe("Jane Doe");
  });

  test("prefers an explicit fullName over firstName/lastName", () => {
    const result = resolveImportRow(
      { fullName: "Dr. Jane Doe", firstName: "Jane", lastName: "Doe", phone: "9876543210" },
      2,
      normalize,
    );
    expect(result.ok && result.fullName).toBe("Dr. Jane Doe");
  });

  test("drops a malformed email without failing the row — only phone is mandatory", () => {
    const result = resolveImportRow({ phone: "9876543210", email: "not-an-email" }, 2, normalize);
    expect(result).toEqual({
      ok: true,
      phone: "+919876543210",
      fullName: null,
      companyName: null,
      companyDomain: null,
      title: null,
      email: null,
      linkedinUrl: null,
    });
  });

  test("keeps a valid email, normalized", () => {
    const result = resolveImportRow({ phone: "9876543210", email: " Jane@Example.COM " }, 2, normalize);
    expect(result.ok && result.email).toBe("jane@example.com");
  });

  test("carries companyName and title through untouched", () => {
    const result = resolveImportRow({ phone: "9876543210", companyName: "Acme", title: "VP Sales" }, 2, normalize);
    expect(result.ok && result.companyName).toBe("Acme");
    expect(result.ok && result.title).toBe("VP Sales");
  });
});

describe("resolveContactPersonUpdate", () => {
  const normalize = (input: string) => (input === "9876543210" ? "+919876543210" : null);

  test("an empty request leaves every field absent", () => {
    const result = resolveContactPersonUpdate({}, normalize);
    expect(result).toEqual({ ok: true, fullName: undefined, phone: undefined, email: undefined, companyName: undefined, title: undefined });
  });

  test("trims a given fullName", () => {
    const result = resolveContactPersonUpdate({ fullName: "  Priya Nair  " }, normalize);
    expect(result.ok && result.fullName).toBe("Priya Nair");
  });

  test("rejects a fullName that is blank after trimming", () => {
    expect(resolveContactPersonUpdate({ fullName: "   " }, normalize)).toEqual({ ok: false, message: "Enter a name" });
  });

  test("normalizes a given phone", () => {
    const result = resolveContactPersonUpdate({ phone: "9876543210" }, normalize);
    expect(result.ok && result.phone).toBe("+919876543210");
  });

  test("rejects a phone the normalizer can't parse", () => {
    const result = resolveContactPersonUpdate({ phone: "garbage" }, normalize);
    expect(result).toEqual({ ok: false, message: "Enter the number with its country code, e.g. +91…" });
  });

  test("normalizes a given email", () => {
    const result = resolveContactPersonUpdate({ email: " Jane@Example.COM " }, normalize);
    expect(result.ok && result.email).toBe("jane@example.com");
  });

  test("rejects a malformed email rather than dropping it", () => {
    expect(resolveContactPersonUpdate({ email: "not-an-email" }, normalize)).toEqual({ ok: false, message: "Enter a valid email address" });
  });

  test("a null email clears it", () => {
    const result = resolveContactPersonUpdate({ email: null }, normalize);
    expect(result.ok && result.email).toBeNull();
  });

  test("companyName and title pass through untouched, including null", () => {
    const result = resolveContactPersonUpdate({ companyName: null, title: "VP Sales" }, normalize);
    expect(result.ok && result.companyName).toBeNull();
    expect(result.ok && result.title).toBe("VP Sales");
  });
});

describe("company website", () => {
  test("an import row's website becomes the company domain", () => {
    const result = resolveImportRow(
      { phone: "9876543210", companyName: "Acme", companyDomain: "https://www.Acme.com/about" },
      2,
      (value) => (value === "9876543210" ? "+919876543210" : null),
    );
    expect(result.ok && result.companyDomain).toBe("acme.com");
  });

  test("an edit normalizes the website, clears it on blank, and rejects a non-domain", () => {
    expect(resolveContactPersonUpdate({ companyWebsite: "https://Acme.com/" })).toMatchObject({ ok: true, companyDomain: "acme.com" });
    expect(resolveContactPersonUpdate({ companyWebsite: "  " })).toMatchObject({ ok: true, companyDomain: null });
    expect(resolveContactPersonUpdate({ companyWebsite: "not a website" })).toMatchObject({ ok: false });
    expect(resolveContactPersonUpdate({ fullName: "Jane" })).toMatchObject({ ok: true, companyDomain: undefined });
  });
});

describe("LinkedIn profile", () => {
  const normalize = (input: string) => (input === "9876543210" ? "+919876543210" : null);

  test("an import row's LinkedIn URL is kept as the slug people are keyed by; junk is dropped", () => {
    const kept = resolveImportRow({ phone: "9876543210", linkedinUrl: "https://www.linkedin.com/in/Priya-Nair/" }, 2, normalize);
    expect(kept.ok && kept.linkedinUrl).toBe("priya-nair");
    const dropped = resolveImportRow({ phone: "9876543210", linkedinUrl: "not a profile" }, 2, normalize);
    expect(dropped.ok && dropped.linkedinUrl).toBeNull();
  });

  test("a stored slug becomes a profile link", () => {
    expect(linkedinProfileUrl("priya-nair")).toBe("https://www.linkedin.com/in/priya-nair");
    expect(linkedinProfileUrl(null)).toBeNull();
  });
});

describe("photoLink", () => {
  test("accepts an https image link and an already-uploaded photo's path", () => {
    expect(photoLink(" https://media.licdn.com/p/abc.jpg ")).toBe("https://media.licdn.com/p/abc.jpg");
    const uploaded = "/api/calling/photos/0b6c4f0e-8f4e-4d5a-9a57-3c1f2f0d1e2a/1f0e2d3c-4b5a-4968-8776-655443322110.png";
    expect(photoLink(uploaded)).toBe(uploaded);
  });

  test("rejects anything else", () => {
    expect(photoLink("http://example.com/a.jpg")).toBeNull();
    expect(photoLink("javascript:alert(1)")).toBeNull();
    expect(photoLink("not a link")).toBeNull();
    expect(photoLink("/api/calls/other")).toBeNull();
  });

  test("the edit form sends it through resolveContactPersonUpdate; blank clears it", () => {
    expect(resolveContactPersonUpdate({ profilePictureUrl: "  " })).toMatchObject({ ok: true, profilePictureUrl: null });
    expect(resolveContactPersonUpdate({ profilePictureUrl: "ftp://x" })).toMatchObject({ ok: false });
  });
});
