import { describe, expect, test } from "bun:test";
import { cleanEmail, cleanLinkedinUrl, contactPageLinks, emailMatchesDomain, extractContacts, MAX_TEXT_SCAN, ownWebsite, visibleText, websiteDomain, withoutElements } from "./contacts";
import { directoryBusinessLinks } from "./webDiscovery";

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

  test("a local part longer than 64 characters is no address, not cut down to one", () => {
    expect(extractContacts(`<p>${"x".repeat(70)}@acme.com</p>`, "https://acme.com/")).toEqual([]);
    expect(cleanEmail(`${"x".repeat(65)}@acme.com`)).toBeNull();
  });
});

describe("hidden addresses", () => {
  const emailsOf = (text: string) => extractContacts(`<p>${text}</p>`, "https://x.example/").filter((c) => c.kind === "email").map((c) => c.value);

  test("decodes the clear forms", () => {
    // name [at] domain [dot] com, name(at)domain.com, name at domain dot com
    expect(emailsOf("Write to sara [at] lotusdental [dot] com")).toEqual(["sara@lotusdental.com"]);
    expect(emailsOf("Write to sara(at)lotusdental.com today")).toEqual(["sara@lotusdental.com"]);
    expect(emailsOf("Write to sara at lotusdental dot com")).toEqual(["sara@lotusdental.com"]);
    expect(emailsOf("Owner: dr.rao {at} smile-clinic (dot) co (dot) in")).toEqual(["dr.rao@smile-clinic.co.in"]);
    expect(emailsOf("INFO [AT] ACME [DOT] COM")).toEqual(["info@acme.com"]);
    expect(emailsOf("Mail: hello (at) Acme.com.")).toEqual(["hello@acme.com"]);
    expect(emailsOf("curator [at] city-museum [dot] museum")).toEqual(["curator@city-museum.museum"]);
    expect(emailsOf("dean (at) mail.dept.uni.ac.co.uk")).toEqual(["dean@mail.dept.uni.ac.co.uk"]);
  });

  test("does not turn sentences into addresses", () => {
    expect(emailsOf("Join our team (at) Pune. Com… we are hiring")).toEqual([]);
    expect(emailsOf("Visit us (at) Mumbai. In 2024 we moved")).toEqual([]);
    expect(emailsOf("Visit us (at) Mumbai.In 2024")).toEqual([]);
    expect(emailsOf("Join our team (at) Pune.Com")).toEqual([]);
    expect(emailsOf("We are at Baner. Come by")).toEqual([]);
    expect(emailsOf("Find us at smileclinic.in")).toEqual([]);
    expect(emailsOf("sara [at] lotusdental . com")).toEqual([]);
    // Never cut short into another address.
    expect(emailsOf("x (at) a.b.c.d.e.f.g.h.i.com")).toEqual([]);
  });
});

describe("hostile pages", () => {
  const SIZE = 1_500_000;
  const pages: Record<string, string> = {
    "one long word": "a".repeat(SIZE),
    "a run of dots": `a${".".repeat(SIZE)}`,
    "a run of hyphens after an @": `a@${"-".repeat(SIZE)}`,
    "many @": "a@".repeat(SIZE / 2),
    "dotted labels after many @": `x@${"a.".repeat(SIZE / 2)}`,
    "obfuscation tokens": "a (at) b ".repeat(SIZE / 9),
    "unclosed scripts": "<script>".repeat(SIZE / 8),
    "unclosed tags": "<a b".repeat(SIZE / 4),
    "unclosed anchors with a close at the end": `${"<a href=x>".repeat(SIZE / 10)}</a>`,
    "hrefs without closing quotes": "href=\"x ".repeat(SIZE / 8),
    "a long mailto": `<a href="mailto:${".".repeat(SIZE)}">x</a>`,
  };

  for (const [label, html] of Object.entries(pages)) {
    test(`${label} (1.5 MB) is read in well under a second`, () => {
      const started = performance.now();
      extractContacts(html, "https://hostile.example/");
      contactPageLinks(html, "https://hostile.example/");
      directoryBusinessLinks(html, "https://hostile.example/list/");
      expect(performance.now() - started).toBeLessThan(500);
    });
  }

  test("text addresses are read from the first MAX_TEXT_SCAN characters of text; links from the whole page", () => {
    const filler = `<p>${"word ".repeat(MAX_TEXT_SCAN / 5)}</p>`;
    const contacts = extractContacts(`${filler}<p>late@acme.com</p><a href="mailto:link@acme.com">x</a>`, "https://acme.com/");
    expect(contacts.map((c) => c.value)).toEqual(["link@acme.com"]);
  });

  test("visibleText drops scripts, styles and tags as before", () => {
    expect(visibleText("<p>Hi <b>there</b></p><script>var a = '<b>x</b>';</script><style>p{}</style><noscript>n</noscript> &amp; <> x")).toBe(" Hi there & <> x");
    // An element never closed keeps its text, as the regexes left it.
    expect(visibleText("<script>a@b.com")).toBe(" a@b.com");
    expect(withoutElements("<header>Call 1800</header><main>x</main><footer>y</footer>", ["header", "footer", "nav"])).toBe(" <main>x</main> ");
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
