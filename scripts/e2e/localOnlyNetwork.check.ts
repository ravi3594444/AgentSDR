/** Run with Bun --preload ./scripts/e2e/localOnlyNetwork.ts and the disposable DB env. */
import http from "node:http";
import net from "node:net";
const expectBlocked = async (name: string, action: () => unknown) => {
  try { await action(); } catch (cause) {
    if (String(cause).includes("external traffic is disabled")) { console.log(`PASS ${name} blocked before transport`); return; }
    throw cause;
  }
  throw new Error(`${name} was not blocked`);
};
await expectBlocked("HTTPS fetch", () => fetch("https://ui-network-test.invalid/"));
await expectBlocked("HTTP fetch", () => fetch("http://ui-network-test.invalid/"));
await expectBlocked("Node HTTP", () => http.get("http://ui-network-test.invalid/"));
await expectBlocked("socket", () => net.connect({ host: "ui-network-test.invalid", port: 443 }));
await expectBlocked("WebSocket", () => new WebSocket("wss://ui-network-test.invalid/"));
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/redirect" ? Response.redirect("https://ui-network-test.invalid/") : new Response("local-ok") });
try {
  if (await fetch(server.url).then(response => response.text()) !== "local-ok") throw new Error("Local HTTP failed");
  console.log("PASS localhost HTTP allowed");
  await expectBlocked("external redirect", () => fetch(new URL("/redirect", server.url)));
} finally { server.stop(true); }
console.log("Local-only network policy verified");
