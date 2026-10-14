import AddMailboxButton from "@/components/outreach/AddMailboxButton";
import MailboxesPageClient from "@/components/outreach/MailboxesPageClient";
import SyncUnipileMailboxesButton from "@/components/outreach/SyncUnipileMailboxesButton";
import { RequiresPlatform } from "@/components/settings/RequiresPlatform";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { requirePageOrgContext } from "@/lib/auth/context";
import { isPlatformConnected } from "@/lib/platform/credentials";
import { runInOrganization } from "@/lib/tenancy/scope";
import { listMailboxes } from "@/lib/outreach/mailboxes";
import { EMAIL_PROVIDERS_DESCRIPTION } from "@/lib/outreach/unipileMail";

export const dynamic = "force-dynamic";

export const metadata = { title: "Email accounts" };

async function Mailboxes() {
  const ctx = await requirePageOrgContext();
  const [mailboxes, google, unipile] = await runInOrganization(ctx.organizationId, () =>
    Promise.all([listMailboxes(), isPlatformConnected("google"), isPlatformConnected("unipile")]));
  return <MailboxesPageClient mailboxes={mailboxes} providers={{ google, unipile }} />;
}

export default function EmailAccountsPage() {
  return (
    <SettingsPage
      title="Email accounts"
      description="The mailboxes outreach campaigns send from: Google Workspace addresses, or inboxes linked in Unipile."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <RequiresPlatform platform="unipile" fallback={null}>
            <SyncUnipileMailboxesButton />
          </RequiresPlatform>
          <RequiresPlatform platform="google" fallback={null}>
            <AddMailboxButton />
          </RequiresPlatform>
        </div>
      }
    >
      <RequiresPlatform platform={["google", "unipile"]} description={EMAIL_PROVIDERS_DESCRIPTION} settingsHref="/settings/email-connection">
        <Mailboxes />
      </RequiresPlatform>
    </SettingsPage>
  );
}
