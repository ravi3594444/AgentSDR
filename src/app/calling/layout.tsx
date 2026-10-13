import type { Metadata } from "next";
import { RequiresPlatform } from "@/components/settings/RequiresPlatform";
import { docsPageUrl } from "@/lib/support";
import { brandTitle } from "@/lib/brand";

/**
 * WhatsApp Calling pages share the LinkedIn section's padded, scrolling
 * content surface, and — unlike the CRM pages they used to borrow — carry no
 * CRM tabs. The global app shell supplies the sidebar.
 */
export const metadata: Metadata = {
  title: {
    default: brandTitle("WhatsApp Calling"),
    template: brandTitle("%s", "WhatsApp Calling"),
  },
  description: "Call leads over WhatsApp and follow up",
};

// Reads the database (is Unipile connected?), so the segment renders per request.
export const dynamic = "force-dynamic";

export default function CallingLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative h-full overflow-auto bg-bg-white-0 px-4 py-5 text-text-strong-950 sm:px-6 sm:py-6 lg:px-8">
      <RequiresPlatform platform="unipile" settingsHref="/settings/whatsapp-connection" guideHref={docsPageUrl("whatsapp/calling#what-you-need")}>
        {children}
      </RequiresPlatform>
    </main>
  );
}
