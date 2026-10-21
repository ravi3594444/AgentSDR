import { redirect } from "next/navigation";
import { withQuery } from "@/lib/nav/legacyRoutes";

// Campaigns lived at /calling/:id before WhatsApp Calling had its own
// Overview; keep old links working, query included. A page rather than a
// next.config redirect: `/calling/:id` there would also catch /calling/campaigns.
export default async function OldCallingCampaignPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(withQuery(`/calling/campaigns/${encodeURIComponent((await params).id)}`, await searchParams));
}
