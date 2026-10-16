import { NextRequest, NextResponse } from "next/server";
import { withOrgContext } from "@/lib/auth/context";
import { listInquiries } from "@/lib/intake/endpoints.server";
import { intakeFailure } from "@/lib/intake/http";
import type { InquirySource } from "@/lib/intake/schema";

// Recent inquiries (Settings → Inquiries). Every member can read them.

const SOURCES: InquirySource[] = ["website_form", "instagram"];

// GET /api/intake/inquiries?source=website_form|instagram&limit=50&historical=1 — { inquiries }, newest first;
// historical (backfilled) inquiries only with historical=1
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const source = params.get("source");
  if (source && !SOURCES.includes(source as InquirySource)) {
    return NextResponse.json({ error: `source is one of ${SOURCES.join(", ")}` }, { status: 400 });
  }
  const limit = Number(params.get("limit") ?? 50);
  try {
    return await withOrgContext(req, async () => NextResponse.json({
      inquiries: await listInquiries({
        source: (source as InquirySource | null) ?? undefined,
        limit: Number.isFinite(limit) ? limit : 50,
        includeHistorical: ["1", "true"].includes(params.get("historical") ?? ""),
      }),
    }));
  } catch (error) {
    return intakeFailure(error, "Could not read the inquiries");
  }
}
