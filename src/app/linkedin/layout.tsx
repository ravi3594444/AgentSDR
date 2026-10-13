import type { Metadata } from "next";
import { RequiresPlatform } from "@/components/settings/RequiresPlatform";
import { brandTitle } from "@/lib/brand";

/**
 * LinkedIn pages share their own padded, scrolling content surface. The global
 * app shell supplies the persistent navigation sidebar.
 */
export const metadata: Metadata = {
  title: {
    default: brandTitle("LinkedIn"),
    template: brandTitle("%s", "LinkedIn"),
  },
  description: "LinkedIn outreach automation",
};

// Reads the database (is Unipile connected?), so the segment renders per request.
export const dynamic = "force-dynamic";

export default function LinkedInLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative h-full overflow-auto bg-bg-white-0 px-4 py-5 text-text-strong-950 sm:px-6 sm:py-6 lg:px-8">
      <RequiresPlatform platform="unipile">{children}</RequiresPlatform>
    </main>
  );
}
