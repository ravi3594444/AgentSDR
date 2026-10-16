import { beforeEach, describe, expect, test } from "bun:test";
import { clearMailDomainCache, emailDomainCheck, mailDomainCheck, type MailDns } from "./mailDomain.server";

const fail = (code: string) => Promise.reject(Object.assign(new Error(code), { code }));

/** A stand-in DNS: per domain, what each query answers (a list, or an error code), counting the queries. */
function dns(answers: Record<string, { mx?: string[] | string; a?: string[] | string; aaaa?: string[] | string }>): MailDns & { queries: number } {
  const answer = <T>(value: T[] | string | undefined, wrap: (item: T) => unknown) => {
    stub.queries += 1;
    if (value === undefined) return fail("ENODATA");
    return typeof value === "string" ? fail(value) : Promise.resolve(value.map(wrap));
  };
  const stub = {
    queries: 0,
    resolveMx: (domain: string) => answer(answers[domain]?.mx ?? (answers[domain] ? undefined : "ENOTFOUND"), (exchange: string) => ({ exchange, priority: 10 })),
    resolve4: (domain: string) => answer(answers[domain]?.a ?? (answers[domain] ? undefined : "ENOTFOUND"), (address: string) => address),
    resolve6: (domain: string) => answer(answers[domain]?.aaaa ?? (answers[domain] ? undefined : "ENOTFOUND"), (address: string) => address),
  } as MailDns & { queries: number };
  return stub;
}

beforeEach(() => {
  clearMailDomainCache();
  delete process.env.DISCOVERY_DNS_CHECK;
});

describe("mailDomainCheck", () => {
  test("says how the domain passed: mail servers, or only an address record", async () => {
    const stub = dns({ "lotus.example": { mx: ["mx1.lotus.example"] }, "glow.example": { a: ["93.184.216.34"] } });
    expect(await mailDomainCheck("lotus.example", stub)).toBe("mx");
    expect(await mailDomainCheck("glow.example", stub)).toBe("address");
    // Google Maps discovery reads the same answer (here from the cache) as accepts.
    expect(await emailDomainCheck("glow.example")).toBe("accepts");
  });

  test("a domain that does not exist, has neither record, or a null MX rejects mail", async () => {
    const stub = dns({ "empty.example": {}, "nullmx.example": { mx: ["."] } });
    expect(await mailDomainCheck("gone.example", stub)).toBe("rejects");
    expect(await mailDomainCheck("empty.example", stub)).toBe("rejects");
    expect(await mailDomainCheck("nullmx.example", stub)).toBe("rejects");
  });

  test("a timeout is unknown (the address is kept), and is not cached", async () => {
    const slow = dns({ "slow.example": { mx: "ETIMEOUT" }, "half.example": { a: "ETIMEOUT" } });
    expect(await mailDomainCheck("slow.example", slow)).toBe("unknown");
    // No MX, and the address lookup timed out: not a "rejects".
    expect(await mailDomainCheck("half.example", slow)).toBe("unknown");
    const before = slow.queries;
    expect(await mailDomainCheck("slow.example", slow)).toBe("unknown");
    expect(slow.queries).toBeGreaterThan(before);
  });

  test("a definite answer is cached", async () => {
    const stub = dns({ "lotus.example": { mx: ["mx1.lotus.example"] } });
    expect(await mailDomainCheck("lotus.example", stub)).toBe("mx");
    const before = stub.queries;
    expect(await mailDomainCheck("lotus.example", stub)).toBe("mx");
    expect(stub.queries).toBe(before);
  });
});
