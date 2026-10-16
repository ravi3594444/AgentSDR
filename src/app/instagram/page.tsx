import { redirect } from "next/navigation";

/** /instagram opens its one page, the messages. */
export default function InstagramPage() {
  redirect("/instagram/messages");
}
