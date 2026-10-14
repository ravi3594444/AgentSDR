import { describe, expect, test } from "bun:test";
import {
  plainTextHtml,
  rfcMessageId,
  unipileReplyId,
  unipileStoredMessageId,
  unipileEmailAccount,
  unipileEmailAccountStatus,
  unipileEmailEventKey,
  unipileMailToInbound,
  unipileReplyTarget,
} from "./unipileMail";

describe("unipileEmailAccount", () => {
  test("a Gmail account linked by OAuth reports its address at connection_params.mail.username", () => {
    expect(unipileEmailAccount({
      object: "Account",
      type: "GOOGLE_OAUTH",
      id: "acc_1",
      name: "Ravi Kumar",
      connection_params: { mail: { id: "1234567890", username: "Ravi.Kumar@gmail.com" } },
      sources: [{ id: "acc_1_MAILS", status: "OK" }],
    })).toEqual({
      unipileAccountId: "acc_1",
      type: "GOOGLE_OAUTH",
      typeLabel: "Gmail",
      emailAddress: "ravi.kumar@gmail.com",
      name: "Ravi Kumar",
      status: "connected",
      problem: null,
    });
  });

  test("an IMAP account reports it as imap_user, and a name equal to the address is no display name", () => {
    const account = unipileEmailAccount({
      type: "MAIL",
      id: "acc_2",
      name: "sales@example.com",
      connection_params: { mail: { imap_host: "imap.example.com", imap_port: 993, imap_user: "sales@example.com", smtp_host: "smtp.example.com", smtp_port: 465, smtp_user: "sales@example.com" } },
      sources: [{ status: "CREDENTIALS" }],
    });
    expect(account?.emailAddress).toBe("sales@example.com");
    expect(account?.name).toBeNull();
    expect(account?.status).toBe("failed");
    expect(account?.problem).toContain("reconnect");
  });

  test("LinkedIn, WhatsApp and calendars are not inboxes", () => {
    for (const type of ["LINKEDIN", "WHATSAPP", "GOOGLE_CALENDAR"]) {
      expect(unipileEmailAccount({ type, id: "x", name: "x@example.com", sources: [{ status: "OK" }] })).toBeNull();
    }
  });

  test("an inbox without any address is kept with a null address, for the sync to report", () => {
    expect(unipileEmailAccount({ type: "OUTLOOK", id: "acc_3", connection_params: { mail: { id: "abc" } }, sources: [] })?.emailAddress).toBeNull();
  });
});

describe("unipileEmailAccountStatus", () => {
  test("only OK sends; connecting is not a failure", () => {
    expect(unipileEmailAccountStatus("OK").status).toBe("connected");
    expect(unipileEmailAccountStatus("CONNECTING").status).toBe("connecting");
    for (const status of ["STOPPED", "ERROR", "PERMISSIONS", undefined]) {
      expect(unipileEmailAccountStatus(status).status).toBe("failed");
    }
  });
});

const webhook = {
  email_id: "uni_email_1",
  account_id: "acc_1",
  event: "mail_received",
  webhook_name: "AgentSDR · Email replies",
  date: "2026-10-14T09:30:00.000Z",
  from_attendee: { display_name: "Ada Lovelace", identifier: "Ada@Example.com", identifier_type: "EMAIL_ADDRESS" },
  to_attendees: [{ display_name: "ravi.kumar@gmail.com", identifier: "ravi.kumar@gmail.com" }],
  cc_attendees: [{ display_name: "Grace", identifier: "grace@example.com" }, { identifier: "not an address" }],
  bcc_attendees: [],
  reply_to_attendees: [],
  subject: "Re: Quick question",
  body: "<p>Sounds good, <b>call me</b> Tuesday.</p>",
  body_plain: "Sounds good, call me Tuesday.",
  message_id: "CAF123@mail.gmail.com",
  provider_id: "18f0c0ffee",
  tracking_id: null,
  in_reply_to: { message_id: "<abc@mail.gmail.com>", id: "uni_email_0" },
  folders: ["INBOX"],
  role: "inbox",
  origin: "external",
  has_attachments: false,
  attachments: [],
};

describe("unipileMailToInbound", () => {
  test("maps the mail_received webhook to the reply bridge's message", () => {
    expect(unipileMailToInbound(webhook)).toEqual({
      gmailMessageId: "18f0c0ffee",
      unipileEmailId: "uni_email_1",
      threadId: null,
      fromEmail: "ada@example.com",
      fromName: "Ada Lovelace",
      toEmail: "ravi.kumar@gmail.com",
      to: [{ email: "ravi.kumar@gmail.com", name: null }],
      cc: [{ email: "grace@example.com", name: "Grace" }],
      replyTo: [],
      ccEmails: ["grace@example.com"],
      subject: "Re: Quick question",
      bodyText: "Sounds good, call me Tuesday.",
      messageId: "<CAF123@mail.gmail.com>",
      inReplyTo: "<abc@mail.gmail.com>",
      internalDate: new Date("2026-10-14T09:30:00.000Z"),
    });
  });

  test("the email object from GET /emails/{id} maps the same way, HTML body when there is no plain text", () => {
    const message = unipileMailToInbound({ ...webhook, email_id: undefined, id: "uni_email_1", provider_id: null, body_plain: "", thread_id: "thr_9" });
    expect(message?.gmailMessageId).toBe("uni_email_1");
    expect(message?.threadId).toBe("thr_9");
    expect(message?.bodyText).toBe("<p>Sounds good, <b>call me</b> Tuesday.</p>");
  });

  test("no id, no message", () => {
    expect(unipileMailToInbound({ ...webhook, email_id: undefined })).toBeNull();
  });
});

describe("rfcMessageId", () => {
  test("adds the angle brackets the CRM's threading expects, refuses anything else", () => {
    expect(rfcMessageId("abc@x.com")).toBe("<abc@x.com>");
    expect(rfcMessageId("<abc@x.com>")).toBe("<abc@x.com>");
    expect(rfcMessageId("18f0c0ffee")).toBeNull();
    expect(rfcMessageId(null)).toBeNull();
  });
});

describe("unipileEmailEventKey", () => {
  test("one key per account and email, so a retry collapses", () => {
    expect(unipileEmailEventKey(webhook)).toBe("email:mail_received:v1:acc_1:uni_email_1");
    expect(unipileEmailEventKey({ ...webhook })).toBe(unipileEmailEventKey(webhook));
  });
});

describe("unipileReplyTarget", () => {
  test("the latest email Unipile can identify: an inbound one by its Unipile id", () => {
    expect(unipileReplyTarget([
      { raw: { unipileEmailId: "uni_old" }, providerMessageId: "<old@x.com>" },
      { raw: { provider: "unipile", messageId: null }, providerMessageId: "prov_sent" },
      { raw: { unipileEmailId: "uni_new" }, providerMessageId: "<new@x.com>" },
    ])).toBe("uni_new");
  });

  test("one sent through a Unipile mailbox by its provider id; never an RFC id or a Gmail send", () => {
    expect(unipileReplyTarget([
      { raw: { unipileEmailId: "uni_1" }, providerMessageId: null },
      { raw: { provider: "unipile" }, providerMessageId: "prov_2" },
    ])).toBe("prov_2");
    expect(unipileReplyTarget([{ raw: { provider: "gmail" }, providerMessageId: "gmail_1" }])).toBeNull();
    expect(unipileReplyTarget([{ raw: { provider: "unipile" }, providerMessageId: "<a@b.com>" }])).toBeNull();
    expect(unipileReplyTarget([])).toBeNull();
  });
});

describe("stored Unipile ids", () => {
  test("are prefixed with the account and give back the provider id for reply_to", () => {
    const stored = unipileStoredMessageId("acc_1", "18f0c0ffee");
    expect(stored).toBe("unipile:acc_1:18f0c0ffee");
    expect(unipileReplyId(stored)).toBe("18f0c0ffee");
    expect(unipileReplyId("uni_email_1")).toBe("uni_email_1");
  });

  test("a CRM message sent through Unipile is answered by its stored id", () => {
    expect(unipileReplyTarget([{ raw: { provider: "unipile" }, providerMessageId: "unipile:acc_1:prov_9" }])).toBe("unipile:acc_1:prov_9");
  });
});

describe("plainTextHtml", () => {
  test("escapes and keeps line breaks", () => {
    expect(plainTextHtml("Hi <Ada> & co\nThanks")).toBe("Hi &lt;Ada&gt; &amp; co<br>\nThanks");
  });
});
