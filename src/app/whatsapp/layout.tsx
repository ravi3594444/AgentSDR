import type { Metadata } from "next";
import { RequiresPlatform } from "@/components/settings/RequiresPlatform";
import { docsPageUrl } from "@/lib/support";
import { brandTitle } from "@/lib/brand";

/** WhatsApp message campaigns share the padded, scrolling surface of the calling pages. */
export const metadata: Metadata = {
  title: {
    default: brandTitle("WhatsApp"),
    template: brandTitle("%s", "WhatsApp"),
  },
  description: "Message leads over WhatsApp and follow up",
};

// Reads the database (is Unipile connected?), so the segment renders per request.
export const dynamic = "force-dynamic";

export default function WhatsappLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="workspace-surface relative h-full overflow-auto bg-bg-white-0 px-4 py-5 text-text-strong-950 sm:px-6 sm:py-6 lg:px-8">
      <RequiresPlatform platform="unipile" settingsHref="/settings/whatsapp-connection" guideHref={docsPageUrl("whatsapp/accounts")}>
        {children}
      </RequiresPlatform>
    </main>
  );
}
