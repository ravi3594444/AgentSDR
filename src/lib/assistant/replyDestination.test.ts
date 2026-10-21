import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Review of pilot L05: what waits for a person is in the Inbox, under Needs
// you. The texts the owner reads (chat events, decision cards, reply
// reasons) and the tool descriptions the assistant repeats to them still
// sent people to "Action required", a place no page is called any more.
// Comments keep the queue's internal name; only the code is checked.
describe("owner-facing texts name the Inbox (Needs you), not Action required", () => {
  const files = [
    ["app", "api", "assistant", "runs", "[id]", "route.ts"],
    ["lib", "assistant", "autopilotRun.server.ts"],
    ["lib", "assistant", "replyAgent", "agent.server.ts"],
    ["lib", "assistant", "runReplies.ts"],
    ["lib", "assistant", "tools.server.ts"],
    ["lib", "assistant", "agent.server.ts"],
    ["lib", "crm", "wrongNumberAck.server.ts"],
  ];

  test.each(files.map((parts) => [parts.join("/"), parts] as const))("%s", (_path, parts) => {
    const source = readFileSync(join(import.meta.dir, "..", "..", ...parts), "utf8");
    const code = source.split("\n").filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line));
    expect(code.filter((line) => line.includes("Action required"))).toEqual([]);
  });

  test("a plan started in Review mode says where its replies wait", () => {
    const route = readFileSync(join(import.meta.dir, "..", "..", "app", "api", "assistant", "runs", "[id]", "route.ts"), "utf8");
    expect(route).not.toContain("Every reply waits for you");
    expect(route).toContain("the Inbox (Needs you)");
  });
});
