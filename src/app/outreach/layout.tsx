import { RequiresPlatform } from "@/components/settings/RequiresPlatform";
import { EMAIL_PROVIDERS_DESCRIPTION } from "@/lib/outreach/unipileMail";

/**
 * The Email section (campaigns, the Master Inbox and its notes and tasks)
 * sends through Google Workspace or through inboxes linked in Unipile, so all
 * of it waits behind either connection, the way /linkedin waits on Unipile.
 * Each page supplies its own padding, so only the Connect prompt gets it here.
 */

// Reads the database (is an email provider connected?), so the segment renders per request.
export const dynamic = "force-dynamic";

export default function OutreachLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequiresPlatform
      platform={["google", "unipile"]}
      description={EMAIL_PROVIDERS_DESCRIPTION}
      settingsHref="/settings/email-connection"
      className="h-full overflow-auto bg-bg-white-0 px-4 py-5 sm:px-6 sm:py-6 lg:px-8"
    >
      {children}
    </RequiresPlatform>
  );
}
