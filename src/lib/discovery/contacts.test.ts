import { describe, expect, test } from "bun:test";
import { cleanEmail, cleanLinkedinUrl, contactPageLinks, emailMatchesDomain, extractContacts, ownWebsite, websiteDomain } from "./contacts";

describe("cleanEmail", () => {
  test("normalizes a mailto address and strips query and punctuation", () => {
    expect(cleanEmail("mailto:Info@Acme-Dental.com?subject=Hi")).toBe("info@acme-dental.com");
    expect(cleanEmail("<hello@acme.in>.")).toBe("hello@acme.in");
  });

  test("rejects addresses that are never the business inbox", () => {
    expect(cleanEmail("noreply@acme.com")).toBeNull();
    expect(cleanEmail("you@example.com")).toBeNull();
    expect(cleanEmail("logo@2x.png")).toBeNull();
    expect(cleanEmail("605a7baede844d278b89dc95ae0a9123@sentry-next.wixpress.com")).toBeNull();
    expect(cleanEmail("0123456789abcdef0123456789abcdef@acme.com")).toBeNull();
    expect(cleanEmail("not an email")).toBeNull();
  });
});

describe("extractContacts", () => {
  const page = `
    <html><head><script>var x = "hidden@tracker.com";</script></head><body>
      <a href="mailto:Front.Desk@SmileClinic.in">Email us</a>
      <a href="tel:+91 98765 43210">Call</a>
      <a href="tel:12">bad</a>
      <a href="https://www.linkedin.com/company/smile-clinic/about/?trk=x">LinkedIn</a>
      <a href="https://www.linkedin.com/feed/">feed</a>
      <p>Billing: accounts@smileclinic.in &middot; Owner: dr.rao [at] smileclinic [dot] in</p>
      <p>Write to noreply@smileclinic.in</p>
    </body></html>`;
  const contacts = extractContacts(page, "https://smileclinic.in/contact");

  test("reads mailto, text and obfuscated emails, each tied to the page", () => {
    const emails = contacts.filter((c) => c.kind === "email").map((c) => c.value).sort();
    expect(emails).toEqual(["accounts@smileclinic.in", "dr.rao@smileclinic.in", "front.desk@smileclinic.in"]);
    expect(contacts.every((c) => c.sourceUrl === "https://smileclinic.in/contact")).toBe(true);
  });

  test("ignores addresses inside scripts and junk local parts", () => {
    expect(contacts.some((c) => c.value.includes("tracker.com"))).toBe(false);
    expect(contacts.some((c) => c.value.startsWith("noreply@"))).toBe(false);
  });

  test("keeps real tel: links and canonical LinkedIn company pages only", () => {
    expect(contacts.filter((c) => c.kind === "phone").map((c) => c.value)).toEqual(["+919876543210"]);
    expect(contacts.filter((c) => c.kind === "linkedin").map((c) => c.value)).toEqual(["https://www.linkedin.com/company/smile-clinic"]);
  });

  test("never invents an address the page does not publish", () => {
    expect(extractContacts("<p>Visit us at smileclinic.in</p>", "https://smileclinic.in/")).toEqual([]);
  });
});

describe("contactPageLinks", () => {
  test("returns same-site contact and about pages, resolved and capped", () => {
    const html = `
      <a href="/contact-us">Contact</a>
      <a href="https://www.acme.com/about#team">About</a>
      <a href="https://other.com/contact">Other site</a>
      <a href="mailto:contact@acme.com">mail</a>
      <a href="/impressum">Impressum</a>
      <a href="/team">Team</a>`;
    expect(contactPageLinks(html, "https://acme.com/", 3)).toEqual([
      "https://acme.com/contact-us",
      "https://www.acme.com/about",
      "https://acme.com/impressum",
    ]);
  });
});

describe("websites", () => {
  test("websiteDomain strips scheme and www", () => {
    expect(websiteDomain("https://www.Acme.com/path")).toBe("acme.com");
    expect(websiteDomain("acme.co.uk")).toBe("acme.co.uk");
    expect(websiteDomain("")).toBeNull();
    expect(websiteDomain("not a site")).toBeNull();
  });

  test("ownWebsite rejects social profiles and directories", () => {
    expect(ownWebsite("https://www.facebook.com/acme")).toBeNull();
    expect(ownWebsite("instagram.com/acme")).toBeNull();
    expect(ownWebsite("https://www.justdial.com/Pune/acme")).toBeNull();
    expect(ownWebsite("acme.com")).toBe("https://acme.com");
  });

  test("emailMatchesDomain accepts the domain and its subdomains", () => {
    expect(emailMatchesDomain("a@acme.com", "acme.com")).toBe(true);
    expect(emailMatchesDomain("a@mail.acme.com", "acme.com")).toBe(true);
    expect(emailMatchesDomain("a@gmail.com", "acme.com")).toBe(false);
    expect(emailMatchesDomain("a@acme.com", null)).toBe(false);
  });

  test("cleanLinkedinUrl keeps company, profile and school pages", () => {
    expect(cleanLinkedinUrl("https://in.linkedin.com/in/jane-doe-123?x=1")).toBe("https://www.linkedin.com/in/jane-doe-123");
    expect(cleanLinkedinUrl("https://linkedin.com/jobs/view/1")).toBeNull();
    expect(cleanLinkedinUrl("https://evil-linkedin.com/in/x")).toBeNull();
  });
});
