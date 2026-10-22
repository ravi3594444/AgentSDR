import { withOperator } from "@/lib/auth/operatorAccess.server";
import { privateClaudeStatus } from "@/lib/ai/claudeCode/shared.server";

export async function GET(request: Request) {
  return withOperator(request, async (operator) => Response.json(await privateClaudeStatus(operator.userId), { headers: { "Cache-Control": "no-store" } }));
}
