import { redirect } from "next/navigation";

/**
 * The app has no landing page: "/" opens the owner's assistant (proxy.ts
 * sends a visitor without a session to sign-in first). The website lives in
 * its own repository and is not part of a self-hosted install.
 */
export default function Home() {
  redirect("/assistant");
}
