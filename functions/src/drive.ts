import type { Request, Response } from "express";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { google, type drive_v3 } from "googleapis";
import { z } from "zod";
import {
  googleClientId,
  googleClientSecret,
  tokenEncryptionKey,
  webhookUrl,
} from "./config.js";
import {
  decryptSecret,
  randomToken,
  sha256,
  type EncryptedValue,
} from "./crypto.js";
import { db } from "./firebase.js";
import { publishActiveChannels } from "./status.js";
import { needsRenewal } from "./watch-policy.js";
import {
  applyCors,
  HttpError,
  requireUserId,
  sendError,
} from "./http.js";

const foldersQuery = z.object({
  sourceId: z.string().min(1).default("my-drive"),
  parentId: z.string().min(1).optional(),
  query: z.string().trim().min(1).max(200).optional(),
});

const SHARED_WITH_ME = "shared-with-me";

function driveLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function isSharedDrive(sourceId: string): boolean {
  return sourceId !== "my-drive" && sourceId !== SHARED_WITH_ME;
}

async function listSharedWithMeFolders(
  drive: drive_v3.Drive,
  nameQuery: string,
): Promise<Array<{ id: string; name: string; parentIds: string[]; driveId: string }>> {
  const needle = nameQuery.toLowerCase();
  const folders: Array<{ id: string; name: string; parentIds: string[]; driveId: string }> = [];
  let pageToken: string | undefined;
  do {
    const result = await drive.files.list({
      q: "sharedWithMe = true and mimeType='application/vnd.google-apps.folder' and trashed=false",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields: "nextPageToken,files(id,name,parents)",
    });
    for (const file of result.data.files ?? []) {
      if (!file.id || !file.name || !file.name.toLowerCase().includes(needle)) continue;
      folders.push({
        id: file.id,
        name: file.name,
        parentIds: file.parents ?? [],
        driveId: SHARED_WITH_ME,
      });
    }
    pageToken = result.data.nextPageToken ?? undefined;
  } while (pageToken);
  return folders;
}

function isInsufficientScope(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const details = error as { status?: number; message?: string };
  return details.status === 403 && (details.message ?? "").includes("insufficient");
}

export async function driveForUser(uid: string): Promise<drive_v3.Drive> {
  const snapshot = await db.collection("users").doc(uid).get();
  const encrypted = snapshot.data()?.googleRefreshToken as
    | EncryptedValue
    | undefined;
  if (!encrypted) {
    throw new HttpError(401, "google_disconnected", "Google Drive is not connected");
  }
  const oauth = new google.auth.OAuth2(
    googleClientId.value(),
    googleClientSecret.value(),
  );
  oauth.setCredentials({
    refresh_token: decryptSecret(encrypted, tokenEncryptionKey.value()),
  });
  return google.drive({ version: "v3", auth: oauth });
}

export async function handleDriveSources(
  request: Request,
  response: Response,
): Promise<void> {
  if (applyCors(request, response)) return;
  try {
    const uid = await requireUserId(request);
    const drive = await driveForUser(uid);
    const sources: Array<{ kind: string; id: string; name: string }> = [
      { kind: "user", id: "my-drive", name: "My Drive" },
      { kind: "shared-with-me", id: SHARED_WITH_ME, name: "Shared with me" },
    ];
    try {
      let pageToken: string | undefined;
      do {
        const result = await drive.drives.list({
          pageSize: 100,
          pageToken,
          fields: "nextPageToken,drives(id,name)",
        });
        for (const item of result.data.drives ?? []) {
          if (item.id && item.name) {
            sources.push({ kind: "shared-drive", id: item.id, name: item.name });
          }
        }
        pageToken = result.data.nextPageToken ?? undefined;
      } while (pageToken);
    } catch (error) {
      if (!isInsufficientScope(error)) throw error;
      console.warn("Shared drives are hidden until Drive read scope is granted");
    }
    response.json({ sources });
  } catch (error) {
    sendError(response, error);
  }
}

export async function handleDriveFolders(
  request: Request,
  response: Response,
): Promise<void> {
  if (applyCors(request, response)) return;
  try {
    const uid = await requireUserId(request);
    const input = foldersQuery.parse(request.query);
    const sharedDrive = isSharedDrive(input.sourceId);
    const sharedRoot = input.sourceId === SHARED_WITH_ME && !input.parentId && !input.query;
    const parentId = input.parentId ?? (sharedDrive ? input.sourceId : "root");
    const drive = await driveForUser(uid);
    const query = input.query
      ? `name contains '${driveLiteral(input.query)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
      : sharedRoot
        ? "sharedWithMe = true and mimeType='application/vnd.google-apps.folder' and trashed=false"
        : `'${driveLiteral(parentId)}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const result = await drive.files.list({
      q: query,
      corpora: input.query ? "allDrives" : sharedDrive ? "drive" : "user",
      driveId: input.query || !sharedDrive ? undefined : input.sourceId,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      orderBy: sharedRoot ? undefined : "name_natural",
      pageSize: 1000,
      fields: "files(id,name,parents,driveId)",
    });
    const folders = (result.data.files ?? []).map((file) => ({
      id: file.id,
      name: file.name,
      parentIds: file.parents ?? [],
      driveId: input.sourceId === SHARED_WITH_ME ? SHARED_WITH_ME : file.driveId,
    }));
    if (input.query) {
      const seen = new Set(folders.map((folder) => folder.id));
      for (const folder of await listSharedWithMeFolders(drive, input.query)) {
        if (folder.id && !seen.has(folder.id)) folders.push(folder);
      }
    }
    response.json({ folders });
  } catch (error) {
    sendError(response, error);
  }
}

async function stopChannel(
  drive: drive_v3.Drive,
  channel: FirebaseFirestore.DocumentData,
): Promise<void> {
  if (!channel.id || !channel.resourceId) return;
  await drive.channels
    .stop({ requestBody: { id: channel.id, resourceId: channel.resourceId } })
    .catch((error: unknown) => console.warn("Unable to stop old channel", error));
}

export async function createWatch(
  uid: string,
  sourceId: string,
  driveId?: string,
): Promise<void> {
  const drive = await driveForUser(uid);
  const existingQuery = await db
    .collection("watchChannels")
    .where("uid", "==", uid)
    .where("sourceId", "==", sourceId)
    .where("active", "==", true)
    .get();
  const healthy = existingQuery.docs.find(
    (doc) => !needsRenewal(doc.get("expiresAt").toMillis()),
  );
  if (healthy) return;

  const tokenResult = await drive.changes.getStartPageToken({
    driveId,
    supportsAllDrives: true,
  });
  const pageToken = tokenResult.data.startPageToken;
  if (!pageToken) throw new Error("Drive did not return a start page token");

  const channelId = crypto.randomUUID();
  const channelToken = randomToken();
  const requestedExpiration = Date.now() + 6 * 24 * 60 * 60_000;
  const watched = await drive.changes.watch({
    pageToken,
    driveId,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    requestBody: {
      id: channelId,
      type: "web_hook",
      address: webhookUrl(),
      token: channelToken,
      expiration: String(requestedExpiration),
    },
  });

  const expiration = Number(watched.data.expiration ?? requestedExpiration);
  await db.collection("watchChannels").doc(channelId).set({
    id: channelId,
    uid,
    sourceId,
    driveId: driveId ?? null,
    resourceId: watched.data.resourceId,
    resourceUri: watched.data.resourceUri,
    tokenHash: sha256(channelToken),
    pageToken,
    expiration: String(expiration),
    expiresAt: Timestamp.fromMillis(expiration),
    active: true,
    lastMessageNumber: "0",
    createdAt: FieldValue.serverTimestamp(),
  });

  for (const old of existingQuery.docs) {
    await stopChannel(drive, old.data());
    await old.ref.update({
      active: false,
      replacedAt: FieldValue.serverTimestamp(),
    });
  }
}

export async function syncUserWatches(uid: string): Promise<void> {
  const selections = await db
    .collection("users")
    .doc(uid)
    .collection("selections")
    .get();
  const sourceIds = new Set(
    selections.docs.map((selection) => selection.get("sourceId") as string),
  );
  await Promise.all(
    [...sourceIds].map((sourceId) =>
      createWatch(uid, sourceId, isSharedDrive(sourceId) ? sourceId : undefined),
    ),
  );

  const active = await db
    .collection("watchChannels")
    .where("uid", "==", uid)
    .where("active", "==", true)
    .get();
  const obsolete = active.docs.filter(
    (channel) => !sourceIds.has(channel.get("sourceId")),
  );
  if (obsolete.length > 0) {
    const drive = await driveForUser(uid);
    await Promise.all(
      obsolete.map(async (channel) => {
        await stopChannel(drive, channel.data());
        await channel.ref.update({
          active: false,
          stoppedAt: FieldValue.serverTimestamp(),
        });
      }),
    );
  }
  await publishActiveChannels(uid);
}

export async function indexSelectedFolderTree(
  uid: string,
  selection: { folderId: string; sourceId: string },
): Promise<void> {
  const drive = await driveForUser(uid);
  const shared = isSharedDrive(selection.sourceId);
  const writer = db.bulkWriter();
  const queue = [selection.folderId];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const parentId = queue.shift()!;
    if (visited.has(parentId)) continue;
    visited.add(parentId);
    let pageToken: string | undefined;
    do {
      const result = await drive.files.list({
        q: `'${driveLiteral(parentId)}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        corpora: shared ? "drive" : "user",
        driveId: shared ? selection.sourceId : undefined,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        pageSize: 1000,
        pageToken,
        fields: "nextPageToken,files(id,name,mimeType,parents,modifiedTime,trashed)",
      });
      for (const folder of result.data.files ?? []) {
        if (!folder.id || !folder.name) continue;
        queue.push(folder.id);
        writer.set(
          db
            .collection("users")
            .doc(uid)
            .collection("fileSnapshots")
            .doc(folder.id),
          {
            id: folder.id,
            name: folder.name,
            mimeType: folder.mimeType,
            parentIds: folder.parents ?? [],
            modifiedTime: folder.modifiedTime ?? null,
            trashed: false,
            sourceId: selection.sourceId,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }
      pageToken = result.data.nextPageToken ?? undefined;
    } while (pageToken);
  }
  await writer.close();
}

export async function handleSyncWatches(
  request: Request,
  response: Response,
): Promise<void> {
  if (applyCors(request, response)) return;
  try {
    if (request.method !== "POST") {
      throw new HttpError(405, "method_not_allowed", "POST is required");
    }
    const uid = await requireUserId(request);
    await syncUserWatches(uid);
    response.json({ ok: true });
  } catch (error) {
    sendError(response, error);
  }
}
