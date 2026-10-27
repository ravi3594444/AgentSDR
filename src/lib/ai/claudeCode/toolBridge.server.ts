import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type NativeTool = { name: string; description: string; inputSchema: { type: "object"; properties: Record<string, unknown>; additionalProperties: boolean } };

/**
 * One authenticated loopback MCP endpoint per running Claude turn. No route is
 * published by Next, no provider key reaches the CLI, and no caller supplies
 * an organization/user/thread. The owner scope is captured by execute.
 */
export async function startToolBridge(input: {
  tools: NativeTool[];
  signal: AbortSignal;
  maxCalls: number;
  execute: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
}) {
  const token = randomBytes(32).toString("hex");
  const authorization = Buffer.from(`Bearer ${token}`);
  const names = new Set(input.tools.map((tool) => tool.name));
  const transports = new Set<Server>();
  let closed = false;
  let calls = 0;
  let tail: Promise<unknown> = Promise.resolve();
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
          if (++calls > input.maxCalls) return { isError: true, content: [{ type: "text" as const, text: "This turn has reached its tool-call allowance. Return a final status; saved work is kept." }] };
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
    if (size > 64 * 1024) throw new Error("MCP request too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
