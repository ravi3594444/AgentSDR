import type { Metadata } from "next";
import { RequiresPlatform } from "@/components/settings/RequiresPlatform";
import { brandTitle } from "@/lib/brand";

/** Instagram pages share the padded surface of the WhatsApp ones; the global app shell supplies the sidebar. */
export const metadata: Metadata = {
  title: {
    default: brandTitle("Instagram"),
    template: brandTitle("%s", "Instagram"),
  },
  description: "Instagram direct messages on your linked accounts",
};

// Reads the database (is Unipile connected?), so the segment renders per request.
export const dynamic = "force-dynamic";

export default function InstagramLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="workspace-surface relative h-full overflow-auto bg-bg-white-0 px-4 py-5 text-text-strong-950 sm:px-6 sm:py-6 lg:px-8">
      <RequiresPlatform platform="unipile">{children}</RequiresPlatform>
    </main>
  );
}
