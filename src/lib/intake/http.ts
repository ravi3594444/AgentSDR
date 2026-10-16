import "server-only";

import { NextResponse } from "next/server";
import { authContextErrorResponse } from "@/lib/auth/context";
import { FeatureDisabledError } from "@/lib/features/flags.server";
import { IntakeInputError } from "./endpoints.server";

/**
 * What may be logged about an error: its name and, from it or its causes, a
 * database error code. Never its message: a failed query's message carries
 * its parameters — the visitor's email, phone and message.
 */
export function errorSummary(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  let code: string | null = null;
  for (let current: unknown = error; current && typeof current === "object" && !code; current = (current as { cause?: unknown }).cause) {
    const value = (current as { code?: unknown }).code;
    if (typeof value === "string" && /^[\w.-]{1,40}$/.test(value)) code = value;
  }
  return code ? `${name} (${code})` : name;
}

/**
 * Error answers for the Inquiries management API (/api/intake/endpoints,
 * /api/intake/inquiries): auth failures as they are, the feature being off as
 * 409, bad input as 400, anything else as 500 (logged by name and code only).
 */
export function intakeFailure(error: unknown, fallback: string): Response {
  const denied = authContextErrorResponse(error);
  if (denied) return denied;
  if (error instanceof FeatureDisabledError) return NextResponse.json({ error: error.message, code: "FEATURE_DISABLED" }, { status: 409 });
  if (error instanceof IntakeInputError) return NextResponse.json({ error: error.message }, { status: 400 });
  console.error(`[intake] ${fallback}: ${errorSummary(error)}`);
  return NextResponse.json({ error: fallback }, { status: 500 });
}

export function notFound(): Response {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
