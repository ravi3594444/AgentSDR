import { withOperator } from "@/lib/auth/operatorAccess.server";
import { platformUsageReport } from "@/lib/managed/report.server";

/**
 * GET /api/platform/usage?month=YYYY-MM — use and estimated cost by
 * workspace and provider, Included and own, and the platform budgets.
 * Platform operators only.
 */
export async function GET(request: Request) {
  return withOperator(request, async () => {
    const param = new URL(request.url).searchParams.get("month");
    const match = param ? /^(\d{4})-(\d{2})$/.exec(param) : null;
    const month = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 15)) : new Date();
    return Response.json(await platformUsageReport(month), { headers: { "Cache-Control": "no-store" } });
  });
}
