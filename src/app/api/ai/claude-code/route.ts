import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, withOrgContext, type OrgContext } from "@/lib/auth/context";
import { isClaudeCodeLoginMethod, isClaudeCodeModel } from "@/lib/ai/claudeCode/contract";
import { accountAuthStatus, type ClaudeAccount } from "@/lib/ai/claudeCode/cli.server";
import { checkClaudeModel, claudeCodeAccess, claudeCodeStatus, getClaudeEngine, saveClaudeEngine } from "@/lib/ai/claudeCode/engine.server";
import { loginController } from "@/lib/ai/claudeCode/login.server";
import { runningOn } from "@/lib/ai/claudeCode/runner.server";

/**
 * Settings → AI provider → Claude Code: the signed-in person's own Claude
 * login in this organization (sign in, the code, cancel, sign out, model
 * checks) and whether the organization's AI steps use it. Owner-only pilot
 * (engine.server.ts claudeCodeAccess). The pasted code goes straight to the
 * waiting CLI process and is neither stored nor logged.
 */

function accountOf(ctx: OrgContext): ClaudeAccount {
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

function controllerOf(ctx: OrgContext) {
  const account = accountOf(ctx);
  return loginController(account, () => runningOn(account));
}

function refused(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

async function handle(request: NextRequest, fn: (ctx: OrgContext) => Promise<NextResponse>) {
  try {
    return await withOrgContext(request, fn);
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export async function GET(request: NextRequest) {
  return handle(request, async (ctx) => {
    const flowId = request.nextUrl.searchParams.get("flow");
    if (flowId) {
      // The page polls this while a sign-in waits; it starts no CLI process.
      if (!(await claudeCodeAccess(ctx)).allowed) return refused("Not available", 403);
      const flow = controllerOf(ctx).current();
      return flow?.flowId === flowId ? NextResponse.json({ signIn: flow }) : refused("This sign-in is no longer available. Start sign-in again.", 404);
    }
    return NextResponse.json(await claudeCodeStatus(ctx));
  });
}

export async function POST(request: NextRequest) {
  return handle(request, async (ctx) => {
    const access = await claudeCodeAccess(ctx);
    if (!access.allowed) return refused(access.reason ?? "Not available", 403);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const action = body?.action;
    const controller = controllerOf(ctx);
    const account = accountOf(ctx);
    try {
      switch (action) {
        case "sign_in": {
          const method = body?.method ?? "claudeai";
          if (!isClaudeCodeLoginMethod(method)) return refused("Choose how to sign in");
          const signIn = await controller.start(method);
          return NextResponse.json({ signIn });
        }
        case "submit_code": {
          if (typeof body?.flowId !== "string" || typeof body.code !== "string") return refused("Paste the code Anthropic's page shows");
          const signIn = await controller.complete(body.flowId, body.code);
          return NextResponse.json({ signIn, status: await claudeCodeStatus(ctx) });
        }
        case "cancel": {
          await controller.cancel();
          return NextResponse.json(await claudeCodeStatus(ctx));
        }
        case "sign_out": {
          const engine = await getClaudeEngine();
          if (engine.selected && engine.ownerUserId === ctx.userId) {
            return refused("Your Claude login answers this organization's AI steps. Stop using Claude Code first, then sign out.", 409);
          }
          await controller.signOut();
          return NextResponse.json(await claudeCodeStatus(ctx));
        }
        case "check_model": {
          if (!isClaudeCodeModel(body?.model)) return refused("Choose a model");
          if ((await accountAuthStatus(account)).state !== "in") return refused("Sign in to Claude Code first", 409);
          const check = await checkClaudeModel(account, body.model);
          const engine = await getClaudeEngine();
          await saveClaudeEngine({ ...engine, checks: { ...engine.checks, [ctx.userId]: { ...engine.checks[ctx.userId], [body.model]: check } } });
          return NextResponse.json(await claudeCodeStatus(ctx));
        }
        case "use": {
          if (!isClaudeCodeModel(body?.model)) return refused("Choose a model");
          if ((await accountAuthStatus(account)).state !== "in") return refused("Sign in to Claude Code first", 409);
          const engine = await getClaudeEngine();
          if (!engine.checks[ctx.userId]?.[body.model]?.ok) return refused("Check this model on your account before using it");
          if (engine.selected && engine.ownerUserId && engine.ownerUserId !== ctx.userId) {
            const busy = runningOn({ organizationId: ctx.organizationId, userId: engine.ownerUserId });
            if (busy > 0) return refused(`${busy} AI ${busy === 1 ? "step is" : "steps are"} running on another owner's Claude login. Switch when ${busy === 1 ? "it finishes" : "they finish"}.`, 409);
          }
          await saveClaudeEngine({ ...engine, selected: true, ownerUserId: ctx.userId, model: body.model });
          return NextResponse.json(await claudeCodeStatus(ctx));
        }
        case "stop_using": {
          const engine = await getClaudeEngine();
          await saveClaudeEngine({ ...engine, selected: false });
          return NextResponse.json(await claudeCodeStatus(ctx));
        }
        default:
          return refused("Unknown action");
      }
    } catch (error) {
      return refused(error instanceof Error ? error.message : String(error), 409);
    }
  });
}
