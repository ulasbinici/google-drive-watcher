import { defineSecret, defineString } from "firebase-functions/params";

export const googleClientId = defineSecret("GOOGLE_CLIENT_ID");
export const googleClientSecret = defineSecret("GOOGLE_CLIENT_SECRET");
export const tokenEncryptionKey = defineSecret("TOKEN_ENCRYPTION_KEY");
export const publicBaseUrl = defineString("PUBLIC_BASE_URL");
export const desktopRedirectScheme = defineString("DESKTOP_REDIRECT_SCHEME", {
  default: "drivewatch://oauth/callback",
});

export const functionRegion = "us-central1";

export function oauthCallbackUrl(): string {
  return `${publicBaseUrl.value()}/oauthCallback`;
}

export function webhookUrl(): string {
  return `${publicBaseUrl.value()}/driveWebhook`;
}
