import { CrmLayout } from "@/components/crm/CrmLayout";
import { CrmActionsClient } from "@/components/crm/CrmActionsClient";

export const metadata = { title: "Inbox" };

/** Every channel's replies in one place: Needs you and All conversations (old /crm/actions links redirect here). */
export default function InboxPage() {
  return <CrmLayout><CrmActionsClient /></CrmLayout>;
}
