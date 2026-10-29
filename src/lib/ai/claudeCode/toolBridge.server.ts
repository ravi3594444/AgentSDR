import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** One app tool as MCP lists it: its JSON Schema (src/lib/assistant/toolSchemas.ts) types every argument. */
export type NativeTool = { name: string; description: string; inputSchema: { type: "object"; properties: Readonly<Record<string, unknown>>; required?: readonly string[]; additionalProperties?: boolean } };

/**
 * One authenticated loopback MCP endpoint per running Claude turn. No route is
 * published by Next, no provider key reaches the CLI, and no caller supplies
 * an organization/user/thread. The owner scope is captured by execute.
 */
export async function startToolBridge(input: {
  tools: NativeTool[];
  signal: AbortSignal;
  /** Calls this process may run; past it the run pauses at a checkpoint (the turn resumes in a new process). */
  maxCalls: number;
  execute: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  /** A call met the allowance or a drain: nothing more runs in this process, and every earlier result was delivered. */
  onCheckpoint?: (why: "allowance" | "drained") => void;
}) {
  const token = randomBytes(32).toString("hex");
  const authorization = Buffer.from(`Bearer ${token}`);
  const names = new Set(input.tools.map((tool) => tool.name));
  const transports = new Set<Server>();
  let closed = false;
  let calls = 0;
  let draining: string | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  const notRun = (why: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: `Not run: ${why}. Nothing was done for this call. The turn continues in a moment from the record of what ran; call it again then if it is still needed.` }] });
  const executions = new Map<string, { fingerprint: string; result: Promise<CallToolResult> }>();
  let host = "";
  const http = createServer((request, response) => {
    const header = Buffer.from(request.headers.authorization ?? "");
    if (closed || input.signal.aborted || header.length !== authorization.length || !timingSafeEqual(header, authorization)
      || request.headers.host !== host || request.headers.origin !== undefined || request.url !== "/mcp") {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== "POST") { response.writeHead(405, { Allow: "POST" }).end(); return; }
    void (async () => {
      const body = await readBody(request);
      if (closed || input.signal.aborted) throw new Error("This turn has ended");
      const server = new Server({ name: "22nd-x-ai", version: "1.0.0" }, { capabilities: { tools: {} } });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      transports.add(server);
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: input.tools }));
      server.setRequestHandler(CallToolRequestSchema, async (message, extra) => {
        const { name, arguments: args = {} } = message.params;
        if (!names.has(name)) return { isError: true, content: [{ type: "text", text: "This tool is not available in this turn." }] };
        const id = JSON.stringify(extra.requestId);
        const fingerprint = JSON.stringify([name, args]);
        const previous = executions.get(id);
        if (previous) return previous.fingerprint === fingerprint ? previous.result
          : { isError: true, content: [{ type: "text", text: "This MCP request ID was already used with different arguments." }] };
        // Serialize effects even if Claude batches calls. Each sees the last call's committed evidence and request.
        const work: Promise<CallToolResult> = tail.then(async () => {
          if (closed || input.signal.aborted) throw input.signal.reason ?? new Error("This Claude turn has ended.");
          if (draining) { input.onCheckpoint?.("drained"); return notRun(draining); }
          if (++calls > input.maxCalls) {
            draining = "this run used its tool-call allowance and pauses at a checkpoint";
            input.onCheckpoint?.("allowance");
            return notRun(draining);
          }
          return input.execute(name, args);
        });
        executions.set(id, { fingerprint, result: work });
        tail = work.catch(() => undefined);
        return work;
      });
      response.once("close", () => { transports.delete(server); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    })().catch(() => {
      // Never return a stack, prompt, credential or provider error from the bridge's infrastructure.
      if (!response.headersSent) response.writeHead(400);
      response.end();
    });
  });
  http.requestTimeout = 15_000;
  http.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => { http.removeListener("error", reject); resolve(); });
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Could not open the local tool bridge");
  host = `127.0.0.1:${address.port}`;
  return {
    config: { mcpServers: { agentsdr: { type: "http", url: `http://${host}/mcp`, headers: { Authorization: `Bearer ${token}` }, alwaysLoad: true } } },
    /** From now on no call runs here: each is answered "not run", so the process can stop between calls. */
    drain: (why: string) => { draining ??= why; },
    /** Settles once no call is running or queued (an effect already started always finishes). */
    idle: async () => {
      let seen: Promise<unknown>;
      do { seen = tail; await seen; } while (seen !== tail);
    },
    close: async () => {
      closed = true;
      // Finish an already-started app operation before releasing the chat. Never retry it here.
      await tail;
      await Promise.allSettled([...transports].map((server) => server.close()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    // A full add_contacts (200 contacts, each with its source and quote) must fit; still bounded.
    if (size > 1024 * 1024) throw new Error("MCP request too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
