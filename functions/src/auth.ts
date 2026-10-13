import type { Request, Response } from "express";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { google } from "googleapis";
import { z } from "zod";
import {
  desktopRedirectScheme,
  googleClientId,
  googleClientSecret,
  oauthCallbackUrl,
  tokenEncryptionKey,
} from "./config.js";
import { encryptSecret, randomToken, sha256 } from "./crypto.js";
import { auth, db } from "./firebase.js";
import { applyCors, HttpError, requireUserId, sendError } from "./http.js";

const DRIVE_WRITE_SCOPE = "https://www.googleapis.com/auth/drive";
const DRIVE_READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

const startQuery = z.object({
  installation_id: z.string().min(16).max(200),
  code_challenge: z.string().min(43).max(128),
  access: z.enum(["readonly", "write"]).optional(),
  return_to: z.string().url().optional(),
});

// Only the local dev server may receive the exchange code over http; the desktop app uses the deep link.
const DEV_RETURN_ORIGINS = new Set(["http://localhost:1420", "http://127.0.0.1:1420"]);

function devReturnUrl(value: string | undefined): string | null {
  if (!value) return null;
  const url = new URL(value);
  if (!DEV_RETURN_ORIGINS.has(url.origin)) {
    throw new HttpError(400, "invalid_return_to", "return_to must be the local dev server");
  }
  return `${url.origin}${url.pathname}`;
}

const exchangeBody = z.object({
  code: z.string().min(20),
  codeVerifier: z.string().min(43).max(128),
});

function oauthClient() {
  return new google.auth.OAuth2(
    googleClientId.value(),
    googleClientSecret.value(),
    oauthCallbackUrl(),
  );
}

export async function handleOAuthStart(
  request: Request,
  response: Response,
): Promise<void> {
  try {
    const input = startQuery.parse(request.query);
    const state = randomToken();
    const access = input.access ?? "readonly";
    await db.collection("oauthStates").doc(state).set({
      installationId: input.installation_id,
      codeChallenge: input.code_challenge,
      access,
      returnTo: devReturnUrl(input.return_to),
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + 10 * 60_000),
    });

    const url = oauthClient().generateAuthUrl({
      access_type: "offline",
      include_granted_scopes: true,
      prompt: "consent",
      state,
      scope: [
        "openid",
        "email",
        "profile",
        access === "write" ? DRIVE_WRITE_SCOPE : DRIVE_READ_SCOPE,
      ],
    });
    response.redirect(url);
  } catch (error) {
    sendError(response, error);
  }
}

export async function handleOAuthCallback(
  request: Request,
  response: Response,
): Promise<void> {
  try {
    const code = z.string().min(1).parse(request.query.code);
    const state = z.string().min(20).parse(request.query.state);
    const stateRef = db.collection("oauthStates").doc(state);
    const stateSnapshot = await stateRef.get();
    if (!stateSnapshot.exists) {
      throw new HttpError(400, "invalid_state", "OAuth state is invalid or expired");
    }
    const stateData = stateSnapshot.data()!;
    if ((stateData.expiresAt as Timestamp).toMillis() < Date.now()) {
      await stateRef.delete();
      throw new HttpError(400, "expired_state", "OAuth state has expired");
    }

    const client = oauthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const { data: profile } = await oauth2.userinfo.get();
    if (!profile.id || !profile.email) {
      throw new HttpError(400, "missing_profile", "Google profile is incomplete");
    }

    const uid = `google-${profile.id}`;
    await auth
      .updateUser(uid, {
        email: profile.email,
        displayName: profile.name ?? profile.email,
        photoURL: profile.picture ?? undefined,
      })
      .catch(async (error: { code?: string }) => {
        if (error.code !== "auth/user-not-found") throw error;
        await auth.createUser({
          uid,
          email: profile.email!,
          displayName: profile.name ?? profile.email!,
          photoURL: profile.picture ?? undefined,
        });
      });

    const userRef = db.collection("users").doc(uid);
    const existing = await userRef.get();
    const refreshToken = tokens.refresh_token
      ? encryptSecret(tokens.refresh_token, tokenEncryptionKey.value())
      : existing.data()?.googleRefreshToken;
    if (!refreshToken) {
      throw new HttpError(
        400,
        "missing_refresh_token",
        "Google did not return a refresh token; revoke access and try again",
      );
    }

    await userRef.set(
      {
        email: profile.email,
        displayName: profile.name ?? profile.email,
        picture: profile.picture ?? null,
        googleRefreshToken: refreshToken,
        googleScope: tokens.scope ?? null,
        allowFileEdits: allowFileEdits(stateData.access, tokens.scope, existing.data()?.allowFileEdits),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    const exchangeCode = randomToken();
    await db.collection("oauthExchanges").doc(sha256(exchangeCode)).set({
      uid,
      installationId: stateData.installationId,
      codeChallenge: stateData.codeChallenge,
      profile: {
        displayName: profile.name ?? profile.email,
        email: profile.email,
        picture: profile.picture ?? null,
      },
      expiresAt: Timestamp.fromMillis(Date.now() + 2 * 60_000),
    });
    await stateRef.delete();

    const redirect = new URL(
      typeof stateData.returnTo === "string" ? stateData.returnTo : desktopRedirectScheme.value(),
    );
    redirect.searchParams.set("code", exchangeCode);
    response.redirect(redirect.toString());
  } catch (error) {
    sendError(response, error);
  }
}

function scopeIncludes(scope: string | null | undefined, expected: string): boolean {
  return (scope ?? "").split(/\s+/).includes(expected);
}

function allowFileEdits(
  requested: unknown,
  grantedScope: string | null | undefined,
  previous: unknown,
): boolean {
  const grantedWrite = scopeIncludes(grantedScope, DRIVE_WRITE_SCOPE);
  if (requested === "write") return grantedWrite;
  return previous === true && grantedWrite;
}

export async function handleSetDriveAccess(
  request: Request,
  response: Response,
): Promise<void> {
  if (applyCors(request, response)) return;
  try {
    if (request.method !== "POST") {
      throw new HttpError(405, "method_not_allowed", "POST is required");
    }
    const uid = await requireUserId(request);
    z.object({ allowFileEdits: z.literal(false) }).parse(request.body);    await db.collection("users").doc(uid).set(
      {
        allowFileEdits: false,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    response.json({ allowFileEdits: false });
  } catch (error) {
    sendError(response, error);
  }
}

export async function handleOAuthExchange(
  request: Request,
  response: Response,
): Promise<void> {
  if (applyCors(request, response)) return;
  try {
    if (request.method !== "POST") {
      throw new HttpError(405, "method_not_allowed", "POST is required");
    }
    const input = exchangeBody.parse(request.body);
    const ref = db.collection("oauthExchanges").doc(sha256(input.code));
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      throw new HttpError(400, "invalid_code", "Exchange code is invalid");
    }
    const data = snapshot.data()!;
    if ((data.expiresAt as Timestamp).toMillis() < Date.now()) {
      await ref.delete();
      throw new HttpError(400, "expired_code", "Exchange code has expired");
    }
    if (sha256(input.codeVerifier) !== data.codeChallenge) {
      throw new HttpError(400, "invalid_verifier", "PKCE verifier does not match");
    }
    await ref.delete();
    const customToken = await auth.createCustomToken(data.uid, {
      installationId: data.installationId,
    });
    response.json({ uid: data.uid, customToken, ...data.profile });
  } catch (error) {
    sendError(response, error);
  }
}
