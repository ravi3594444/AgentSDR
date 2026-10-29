import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { getOrgContext } from "@/lib/auth/context";
import { LATEST_RECORDER_VERSION, RECORDER_DOWNLOAD_PATH } from "@/lib/calls/recorderRelease";

export const dynamic = "force-dynamic";

/** Built by `bun run build` (extensions/whatsapp-recorder/package.ts); traced into the standalone output in next.config.ts. */
const ZIP_PATH = join(process.cwd(), "extensions", "whatsapp-recorder", "release", "agentsdr-call-recorder.zip");

/**
 * The Call Recorder extension as a zip, for anyone signed in. Opening the
 * link downloads it; signed out, it goes through sign-in and back here.
 */
export async function GET(request: NextRequest) {
  if (!(await getOrgContext(request))) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = "";
    url.searchParams.set("from", RECORDER_DOWNLOAD_PATH);
    return NextResponse.redirect(url);
  }

  let zip: Buffer;
  try {
    zip = await readFile(ZIP_PATH);
  } catch {
    return new NextResponse("The browser extension download isn't built on this server. Run `bun run package:recorder`.", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  return new NextResponse(new Uint8Array(zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="agentsdr-call-recorder-${LATEST_RECORDER_VERSION}.zip"`,
      "Content-Length": String(zip.length),
      "Cache-Control": "no-store",
    },
  });
}
