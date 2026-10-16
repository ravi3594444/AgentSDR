import "server-only";

import { NextResponse } from "next/server";
import { authContextErrorResponse } from "@/lib/auth/context";
import { FeatureDisabledError } from "@/lib/features/flags.server";
import { IntakeInputError } from "./endpoints.server";

/**
 * Error answers for the Inquiries management API (/api/intake/endpoints,
 * /api/intake/inquiries): auth failures as they are, the feature being off as
 * 409, bad input as 400, anything else as 500.
 */
export function intakeFailure(error: unknown, fallback: string): Response {
  const denied = authContextErrorResponse(error);
  if (denied) return denied;
  if (error instanceof FeatureDisabledError) return NextResponse.json({ error: error.message, code: "FEATURE_DISABLED" }, { status: 409 });
  if (error instanceof IntakeInputError) return NextResponse.json({ error: error.message }, { status: 400 });
  console.error(`[intake] ${fallback}`, error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}

export function notFound(): Response {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
