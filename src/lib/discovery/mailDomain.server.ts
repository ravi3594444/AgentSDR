import "server-only";

import { resolve4, resolve6, resolveMx } from "node:dns/promises";

/**
 * Whether an email's domain can receive mail, from DNS (shared by Google
 * Maps and website discovery). It never proves that a mailbox exists: the
 * evidence a lead keeps says so.
 */

/** The DNS queries the check makes; tests stand them in. */
export type MailDns = {
  resolveMx: (domain: string) => Promise<{ exchange: string; priority: number }[]>;
  resolve4: (domain: string) => Promise<string[]>;
  resolve6: (domain: string) => Promise<string[]>;
};

const systemDns: MailDns = { resolveMx, resolve4, resolve6 };

type DomainCheck = "accepts" | "rejects" | "unknown";
/**
 * How a domain's mail check ended: "mx" (it publishes mail servers),
 * "address" (no MX records, but an A/AAAA record, which mail servers fall
 * back to), "rejects" (the domain does not exist, has neither, or publishes
 * a null MX) or "unknown" (DNS did not answer clearly: a timeout, a server
 * failure). Neither proves that a mailbox exists.
 */
export type MailDomainCheck = "mx" | "address" | "rejects" | "unknown";

/** Only definite answers are cached, and only for this long; a timeout is asked again next time. */
const DOMAIN_CACHE_TTL_MS = 6 * 60 * 60_000;
const DOMAIN_CACHE_MAX = 5_000;
const domainCache = new Map<string, { check: Exclude<MailDomainCheck, "unknown">; at: number }>();

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })), ms))]);
}

/** DNS said this name has no such records (or does not exist): a definite answer, unlike a timeout. */
const definitelyNone = (error: unknown) => {
  const code = (error as { code?: string }).code;
  return code === "ENOTFOUND" || code === "ENODATA";
};

/** Whether the domain has A or AAAA records: true, false, or null when DNS did not answer clearly. */
async function hasAddressRecord(domain: string, dns: MailDns): Promise<boolean | null> {
  const lookups = await Promise.allSettled([withTimeout(dns.resolve4(domain), 5_000), withTimeout(dns.resolve6(domain), 5_000)]);
  if (lookups.some((lookup) => lookup.status === "fulfilled" && lookup.value.length > 0)) return true;
  return lookups.every((lookup) => lookup.status === "fulfilled" || definitelyNone(lookup.reason)) ? false : null;
}

/**
 * MX records, or an address record (implicit MX), mean the domain can
 * receive mail; a domain that does not exist, or has neither, cannot. A
 * lookup that fails for another reason (a timeout) is "unknown" and the
 * address is kept.
 */
export async function mailDomainCheck(domain: string, dns: MailDns = systemDns): Promise<MailDomainCheck> {
  if (process.env.DISCOVERY_DNS_CHECK === "off") return "unknown";
  const cached = domainCache.get(domain);
  if (cached && Date.now() - cached.at < DOMAIN_CACHE_TTL_MS) return cached.check;
  let result: MailDomainCheck = "unknown";
  try {
    const mx = await withTimeout(dns.resolveMx(domain), 5_000);
    // Only a null MX (RFC 7505: exchange ".") answers without a usable server: the domain takes no mail.
    result = mx.some((record) => record.exchange && record.exchange !== ".") ? "mx" : "rejects";
  } catch (error) {
    if (definitelyNone(error)) {
      const address = await hasAddressRecord(domain, dns);
      result = address === true ? "address" : address === false ? "rejects" : "unknown";
    }
  }
  if (result !== "unknown") {
    domainCache.delete(domain);
    domainCache.set(domain, { check: result, at: Date.now() });
    if (domainCache.size > DOMAIN_CACHE_MAX) domainCache.delete(domainCache.keys().next().value!);
  }
  return result;
}

/** mailDomainCheck as accepts/rejects/unknown (Google Maps discovery). */
export async function emailDomainCheck(domain: string): Promise<DomainCheck> {
  const check = await mailDomainCheck(domain);
  return check === "mx" || check === "address" ? "accepts" : check;
}

/** Tests: forget every cached answer. */
export function clearMailDomainCache(): void {
  domainCache.clear();
}
