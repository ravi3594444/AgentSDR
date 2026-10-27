/** Preload only in disposable UI tests: provider traffic must never leave localhost. */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

if (process.env.UI_AUDIT_LOCAL_ONLY !== "1" || !/^postgres(?:ql)?:\/\/[^/]+@(localhost|127\.0\.0\.1):55479\/agentsdr_review$/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error("The local-only network guard requires the disposable UI test database");
}
const blocked = () => { throw new Error("UI test network policy: external traffic is disabled"); };
const localHost = (host: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host.toLowerCase());
function localUrl(value: string | URL): URL {
  const url = new URL(value);
  if (!localHost(url.hostname)) blocked();
  return url;
}

const originalFetch = globalThis.fetch;
const guardedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  let request = new Request(input, init);
  for (let redirect = 0; redirect < 10; redirect++) {
    localUrl(request.url);
    const response = await originalFetch(request.clone(), { redirect: "manual" });
    const location = response.headers.get("location");
    if (request.redirect === "manual" || ![301, 302, 303, 307, 308].includes(response.status) || !location) return response;
    if (request.redirect === "error") blocked();
    const next = localUrl(new URL(location, request.url));
    request = response.status === 303 || ([301, 302].includes(response.status) && request.method === "POST")
      ? new Request(next, { method: "GET", headers: request.headers, redirect: request.redirect })
      : new Request(next, request.clone());
  }
  throw new Error("UI test network policy: too many local redirects");
};
globalThis.fetch = Object.assign(guardedFetch, originalFetch) as typeof fetch;
if ("preconnect" in originalFetch) {
  Reflect.set(globalThis.fetch, "preconnect", (url: string | URL) => { localUrl(url); });
}

type Method = (...args: unknown[]) => unknown;
function httpTarget(input: unknown, fallback: string) {
  if (typeof input === "string" || input instanceof URL) { localUrl(input); return; }
  if (!input || typeof input !== "object") return;
  const options = input as Record<string, unknown>;
  const host = String(options.hostname ?? options.host ?? "localhost");
  localUrl(`${String(options.protocol ?? fallback)}//${host}`);
  // A localhost HTTP proxy must not be a route to an external destination.
  if (typeof options.path === "string" && /^https?:\/\//i.test(options.path)) localUrl(options.path);
  if (String(options.method ?? "").toUpperCase() === "CONNECT") localUrl(`https://${String(options.path ?? "")}`);
}
for (const [module, protocol] of [[http, "http:"], [https, "https:"]] as const) {
  const methods = module as unknown as Record<string, Method>;
  for (const name of ["request", "get"]) {
    const original = methods[name]!;
    methods[name] = function (...args: unknown[]) {
      httpTarget(args[0], protocol);
      if (args[1] && typeof args[1] === "object") httpTarget(args[1], protocol);
      return original.apply(module, args);
    };
  }
}
const socket = net.Socket.prototype as unknown as Record<string, Method>;
const connect = socket.connect!;
socket.connect = function (this: unknown, ...raw: unknown[]) {
  const args = Array.isArray(raw[0]) ? raw[0] as unknown[] : raw;
  const options = args[0];
  if (options && typeof options === "object") {
    const value = options as Record<string, unknown>;
    if (!value.path && !localHost(String(value.host ?? "localhost"))) blocked();
  } else if (typeof options === "number" && typeof args[1] === "string" && !localHost(args[1])) blocked();
  return connect.apply(this, raw);
};
if (typeof globalThis.WebSocket !== "undefined") {
  globalThis.WebSocket = new Proxy(globalThis.WebSocket, {
    construct(target, args, next) { localUrl(String(args[0])); return Reflect.construct(target, args, next); },
  });
}
try { syncBuiltinESMExports(); } catch { /* Bun already shares these built-ins. */ }
console.log("[ui-test] Local-only HTTP and socket policy active");
