import type { Request, Response } from "express";
import {
  googleClientId,
  googleClientSecret,
  tokenEncryptionKey,
} from "./config.js";
import { decryptSecret, type EncryptedValue } from "./crypto.js";
import { db } from "./firebase.js";
import { applyCors, HttpError, requireUserId, sendError } from "./http.js";

const DRIVE_READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function refreshAccessToken(
  refreshToken: string,
  scope?: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: googleClientId.value(),
    client_secret: googleClientSecret.value(),
  });
  if (scope) body.set("scope", scope);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return (await response.json()) as TokenResponse;
}

export async function handleDriveToken(
  request: Request,
  response: Response,
): Promise<void> {
  if (applyCors(request, response)) return;
  try {
    if (request.method !== "POST") {
      throw new HttpError(405, "method_not_allowed", "POST is required");
    }
    const uid = await requireUserId(request);
    const user = await db.collection("users").doc(uid).get();
    const encrypted = user.get("googleRefreshToken") as EncryptedValue | undefined;
    if (!encrypted) {
      throw new HttpError(401, "google_disconnected", "Google Drive is not connected");
    }
    const refreshToken = decryptSecret(encrypted, tokenEncryptionKey.value());
    const canEdit = user.get("allowFileEdits") === true;

    let token = canEdit
      ? await refreshAccessToken(refreshToken)
      : await refreshAccessToken(refreshToken, DRIVE_READ_SCOPE);
    if (!token.access_token && !canEdit) {
      token = await refreshAccessToken(refreshToken);
    }
    if (!token.access_token) {
      console.error("Drive token refresh failed", token.error, token.error_description);
      throw new HttpError(
        401,
        "google_token",
        "Google access expired. Sign out and sign in again.",
      );
    }

    response.json({
      accessToken: token.access_token,
      expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
      canEdit,
    });
  } catch (error) {
    sendError(response, error);
  }
}
