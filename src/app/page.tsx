import type { Metadata } from "next";
import LandingPage from "@/components/landing/LandingPage";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = {
  title: { absolute: `${BRAND.name} — Make the next connection` },
  description: "Find the right leads, shape your outreach, and keep the conversation moving. Your AI outreach workspace for email, LinkedIn, and WhatsApp.",
};

export default function Home() {
  return <LandingPage />;
}
