import Link from "next/link";
import { headers } from "next/headers";
import { InquiriesSettings } from "@/components/settings/inquiries/InquiriesSettings";
import { Callout } from "@/components/settings/SettingsKit";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { can, requirePageOrgContext } from "@/lib/auth/context";
import { FEATURES } from "@/lib/features/catalog";
import { featureEnabled } from "@/lib/features/flags.server";
import { publicAppUrl } from "@/lib/http/publicAppUrl";
import { listInquiries, listIntakeEndpoints } from "@/lib/intake/endpoints.server";
import { INTAKE_FIELDS } from "@/lib/intake/fields";
import { INTAKE_NEW_CONTACTS_PER_DAY, INTAKE_SUBMISSIONS_PER_HOUR } from "@/lib/intake/inquiries.server";
import { runInOrganization } from "@/lib/tenancy/scope";

export const metadata = { title: "Inquiries" };
export const dynamic = "force-dynamic";

/** The address form tools post to: the configured public origin, else the one this page was reached on. */
async function webhookUrl(): Promise<string> {
  const configured = publicAppUrl();
  if (configured) return `${configured}/api/intake/form`;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}/api/intake/form`;
}

/**
 * Settings → Inquiries: the website-form webhooks an owner adds to their
 * form tool, and the inquiries they (and Instagram) brought in. Listed in the
 * rail only while the organization's Inquiry intake feature is on. Reached
 * directly with it off, the page says so; webhooks made earlier are still
 * listed so they can be turned off, rotated or deleted, but none is made.
 */
export default async function InquiriesSettingsPage() {
  const ctx = await requirePageOrgContext();
  const data = await runInOrganization(ctx.organizationId, async () => {
    const enabled = await featureEnabled("inquiry_intake");
    const [endpoints, inquiries] = await Promise.all([
      listIntakeEndpoints(),
      enabled ? listInquiries({ limit: 50, includeHistorical: true }) : Promise.resolve([]),
    ]);
    return { enabled, endpoints, inquiries };
  });

  const off = (
    <Callout tone="info" title={`${FEATURES.inquiry_intake.label} is off`}>
      An owner or admin can turn it on in{" "}
      <Link href="/settings/organization" className="underline underline-offset-2">Settings → Organization</Link>
      {" "}(Optional features). Nothing is received until then.
    </Callout>
  );

  return (
    <SettingsPage
      title="Inquiries"
      description="Messages people send through your website's forms, kept as contacts with what they asked for."
    >
      {data.enabled || data.endpoints.length ? (
        <div className="flex flex-col gap-6">
          {!data.enabled && off}
          <InquiriesSettings
            featureOn={data.enabled}
            webhookUrl={await webhookUrl()}
            canManage={can(ctx, { integrations: ["manage"] })}
            fields={INTAKE_FIELDS}
            limits={{ perHour: INTAKE_SUBMISSIONS_PER_HOUR, newContactsPerDay: INTAKE_NEW_CONTACTS_PER_DAY }}
            initialEndpoints={data.endpoints}
            initialInquiries={data.inquiries}
          />
        </div>
      ) : off}
    </SettingsPage>
  );
}
