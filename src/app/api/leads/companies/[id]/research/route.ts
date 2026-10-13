import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { listCompanyResearch, researchCompany, ResearchError } from "@/lib/research/research.server";
import { RESEARCH_KINDS, type ResearchKind } from "@/lib/research/schema";

export const dynamic = "force-dynamic";
// One search call (60 s deadline) and at most one retry.
export const maxDuration = 150;

type Params = { params: Promise<{ id: string }> };

function errorResponse(error: unknown) {
  const auth = authContextErrorResponse(error);
  if (auth) return auth;
  if (error instanceof ResearchError) return NextResponse.json({ error: error.message }, { status: error.status });
  throw error;
}

/** GET: this company's research, newest first. */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    return await withOrgContext(request, async () => NextResponse.json({ research: await listCompanyResearch(id) }));
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST { kind: "company" | "website" | "parent" | "question", question? }:
 * researches the company on the web now and stores the answer with its
 * sources. A run that found no sources is stored as failed (201 with
 * status "failed"); a refusal before any call (no research model, daily
 * limit) is an error status.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    return await withOrgContext(request, async (ctx) => {
      const body = await request.json().catch(() => null) as { kind?: unknown; question?: unknown } | null;
      const kind = body?.kind;
      if (typeof kind !== "string" || !RESEARCH_KINDS.includes(kind as ResearchKind)) {
        return NextResponse.json({ error: `kind must be one of ${RESEARCH_KINDS.join(", ")}` }, { status: 400 });
      }
      const record = await researchCompany({
        companyId: id,
        kind: kind as ResearchKind,
        question: typeof body?.question === "string" ? body.question : null,
        userId: ctx.userId,
      });
      return NextResponse.json({ research: record }, { status: 201 });
    });
  } catch (error) {
    return errorResponse(error);
  }
}
