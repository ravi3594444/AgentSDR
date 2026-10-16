import { readCrmJson } from "@/lib/crm/categories";
import { requireFeature } from "@/lib/features/flags.server";
import { setInstagramInquiryIntake } from "@/lib/instagram/accounts";
import { assertIdParam, instagramRoute, parseAccountUpdateRequest } from "@/lib/instagram/http";

/**
 * PATCH /api/instagram/accounts/:id — { inquiryIntake } (owners and admins):
 * whether new messages from people AgentSDR does not know become inquiries
 * on this account. Turning it on needs the organization's Inquiry intake
 * feature too (409 without it); turning it off never does.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return instagramRoute(request, async () => {
    const id = assertIdParam((await params).id, "Instagram account");
    const { inquiryIntake } = parseAccountUpdateRequest(await readCrmJson(request));
    if (inquiryIntake) await requireFeature("inquiry_intake");
    return Response.json(await setInstagramInquiryIntake(id, inquiryIntake));
  }, { manage: true });
}
