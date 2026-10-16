import { hostedAuthCallbackUrls } from "@/lib/linkedin/hostedAuthUrls";

/** Where Unipile's Instagram sign-in returns the member: the Instagram accounts page, which syncs on arrival. */
export const INSTAGRAM_HOSTED_AUTH_RETURN_PATH = "/settings/instagram-accounts";

/**
 * The hosted sign-in URLs for an Instagram link: the same notify_url as every
 * other hosted link (the account-status webhook, carrying the organization
 * and its notify secret — hostedAuthCallbackUrls), with the redirects
 * pointed at the Instagram accounts page instead of LinkedIn's.
 */
export function instagramHostedAuthCallbackUrls(
  requestOrigin: string | null,
  notifySecret: string | null,
  organizationId: string,
): { successRedirectUrl: string; failureRedirectUrl: string; notifyUrl?: string } {
  const urls = hostedAuthCallbackUrls(requestOrigin, notifySecret, organizationId);
  const returnTo = (url: string) => {
    const next = new URL(url);
    next.pathname = INSTAGRAM_HOSTED_AUTH_RETURN_PATH;
    return next.toString();
  };
  return { ...urls, successRedirectUrl: returnTo(urls.successRedirectUrl), failureRedirectUrl: returnTo(urls.failureRedirectUrl) };
}
