import { NextRequest, NextResponse } from "next/server";
import { withLinkedinOrg } from "@/lib/linkedin/organizations.server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { inOrg } from "@/lib/tenancy/scope";
import { linkedInAccounts } from "@/lib/linkedin/schema";
import { numberRule, RETIRED_RULE_ERROR, ruleError } from "@/lib/channels/rules";

/** The old per-account working hours: sending is always on, so none of them may be set any more. */
const RETIRED_HOURS_FIELDS = ["workHoursEnabled", "workTimezone", "workStartTime", "workEndTime", "workDays"];

type AccountUpdate = {
  dailyInviteLimit?: number | null;
};

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withLinkedinOrg(req, async () => {
    const { id } = await params;

    try {
      const body = await req.json();
      const data: AccountUpdate = {};

      if (body && typeof body === "object" && RETIRED_HOURS_FIELDS.some((field) => field in body)) {
        return NextResponse.json({ ok: false, error: RETIRED_RULE_ERROR }, { status: 400 });
      }

      // The account's own invitations a day (null = the organization's rule),
      // within the hard ceilings of the rule for its plan.
      if ("dailyInviteLimit" in body) {
        if (body.dailyInviteLimit === null) {
          data.dailyInviteLimit = null;
        } else {
          const [current] = await db
            .select({ isPremium: linkedInAccounts.isPremium })
            .from(linkedInAccounts)
            .where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.id, id)))
            .limit(1);
          if (!current) return NextResponse.json({ ok: false, error: "Account not found" }, { status: 404 });
          const error = ruleError(numberRule("linkedin", current.isPremium ? "invitesPerDayPremium" : "invitesPerDayFree"), body.dailyInviteLimit);
          if (error) return NextResponse.json({ ok: false, error }, { status: 400 });
          data.dailyInviteLimit = body.dailyInviteLimit as number;
        }
      }

      if (Object.keys(data).length === 0) {
        return NextResponse.json({ ok: false, error: "Nothing to update" }, { status: 400 });
      }

      const [account] = await db
        .update(linkedInAccounts)
        .set(data)
        .where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.id, id)))
        .returning();

      // Prisma's update threw (→ 500) when the id did not exist; Drizzle just
      // returns no rows, so keep the same outward behaviour.
      if (!account) {
        return NextResponse.json({ ok: false, error: "Account not found" }, { status: 404 });
      }

      return NextResponse.json({ ok: true, account });
    } catch (err) {
      return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
    }
  });
}
