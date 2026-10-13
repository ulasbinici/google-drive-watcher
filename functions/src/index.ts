import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import {
  onDocumentCreated,
  onDocumentWritten,
} from "firebase-functions/v2/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import {
  functionRegion,
  googleClientId,
  googleClientSecret,
  tokenEncryptionKey,
} from "./config.js";
import { sha256 } from "./crypto.js";
import { handleSetMonitoring } from "./monitoring.js";
import { isNewerMessage, RENEW_LEAD_MS } from "./watch-policy.js";
import { db } from "./firebase.js";
import {
  handleOAuthCallback,
  handleOAuthExchange,
  handleOAuthStart,
  handleSetDriveAccess,
} from "./auth.js";
import {
  createWatch,
  handleDriveFolders,
  handleDriveSources,
  handleSyncWatches,
  indexSelectedFolderTree,
  syncUserWatches,
} from "./drive.js";
import { processChannelChanges } from "./change-processor.js";
import { handleDriveToken } from "./drive-token.js";

const googleSecrets = [
  googleClientId,
  googleClientSecret,
  tokenEncryptionKey,
];

const publicHttps = { region: functionRegion, invoker: "public" as const };

export const oauthStart = onRequest(
  { ...publicHttps, secrets: googleSecrets },
  handleOAuthStart,
);

export const oauthCallback = onRequest(
  { ...publicHttps, secrets: googleSecrets },
  handleOAuthCallback,
);

export const oauthExchange = onRequest(publicHttps, handleOAuthExchange);

export const setDriveAccess = onRequest(publicHttps, handleSetDriveAccess);

export const driveSources = onRequest(
  { ...publicHttps, secrets: googleSecrets },
  handleDriveSources,
);

export const driveFolders = onRequest(
  { ...publicHttps, secrets: googleSecrets },
  handleDriveFolders,
);

export const driveToken = onRequest(
  { ...publicHttps, secrets: googleSecrets },
  handleDriveToken,
);

export const setMonitoring = onRequest(
  { ...publicHttps, secrets: googleSecrets, timeoutSeconds: 540 },
  handleSetMonitoring,
);

export const syncWatches = onRequest(
  { ...publicHttps, secrets: googleSecrets, timeoutSeconds: 120 },
  handleSyncWatches,
);

export const driveWebhook = onRequest(publicHttps,
  async (request, response) => {
    if (request.method !== "POST") {
      response.status(405).send("POST required");
      return;
    }
    const channelId = request.get("x-goog-channel-id");
    const channelToken = request.get("x-goog-channel-token");
    const resourceId = request.get("x-goog-resource-id");
    const messageNumber = request.get("x-goog-message-number");
    if (!channelId || !channelToken || !resourceId || !messageNumber) {
      response.status(400).send("Missing Google channel headers");
      return;
    }

    try {
      await db.runTransaction(async (transaction) => {
        const channelRef = db.collection("watchChannels").doc(channelId);
        const channel = await transaction.get(channelRef);
        if (
          !channel.exists ||
          !channel.get("active") ||
          channel.get("resourceId") !== resourceId ||
          channel.get("tokenHash") !== sha256(channelToken)
        ) {
          throw new Error("Invalid channel");
        }

        if (!isNewerMessage(channel.get("lastMessageNumber") ?? "0", messageNumber)) {
          return;
        }
        transaction.update(channelRef, {
          lastMessageNumber: messageNumber,
          lastWebhookAt: FieldValue.serverTimestamp(),
        });
        transaction.create(
          db.collection("changeQueue").doc(`${channelId}-${messageNumber}`),
          {
            channelId,
            messageNumber,
            resourceState: request.get("x-goog-resource-state") ?? null,
            createdAt: FieldValue.serverTimestamp(),
          },
        );
      });
      response.status(204).send("");
    } catch (error) {
      logger.warn("Rejected Drive webhook", { channelId, error });
      response.status(404).send("Unknown channel");
    }
  },
);

export const consumeDriveChange = onDocumentCreated(
  {
    region: functionRegion,
    document: "changeQueue/{queueId}",
    secrets: googleSecrets,
    retry: true,
    timeoutSeconds: 540,
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;
    await processChannelChanges(snapshot.get("channelId"));
    await snapshot.ref.update({
      processedAt: FieldValue.serverTimestamp(),
    });
  },
);

export const reconcileFolderSelection = onDocumentWritten(
  {
    region: functionRegion,
    document: "users/{uid}/selections/{selectionId}",
    secrets: googleSecrets,
    retry: true,
    timeoutSeconds: 540,
  },
  async (event) => {
    const uid = event.params.uid;
    const after = event.data?.after;
    if (after?.exists) {
      await indexSelectedFolderTree(uid, {
        folderId: after.get("folderId"),
        sourceId: after.get("sourceId"),
      });
    }
    await syncUserWatches(uid);
  },
);

export const renewDriveChannels = onSchedule(
  {
    region: functionRegion,
    schedule: "every 6 hours",
    secrets: googleSecrets,
    timeoutSeconds: 540,
  },
  async () => {
    const expiring = await db
      .collection("watchChannels")
      .where("active", "==", true)
      .where(
        "expiresAt",
        "<=",
        Timestamp.fromMillis(Date.now() + RENEW_LEAD_MS),
      )
      .get();
    const watches = new Map<
      string,
      { uid: string; sourceId: string; driveId?: string }
    >();
    for (const doc of expiring.docs) {
      const data = doc.data();
      watches.set(`${data.uid}:${data.sourceId}`, {
        uid: data.uid,
        sourceId: data.sourceId,
        driveId: data.driveId ?? undefined,
      });
    }
    await Promise.all(
      [...watches.values()].map((watch) =>
        createWatch(watch.uid, watch.sourceId, watch.driveId),
      ),
    );
  },
);

export const cleanupEphemeralAuth = onSchedule(
  {
    region: functionRegion,
    schedule: "every 24 hours",
  },
  async () => {
    const now = Timestamp.now();
    for (const collection of ["oauthStates", "oauthExchanges"]) {
      const expired = await db
        .collection(collection)
        .where("expiresAt", "<=", now)
        .limit(500)
        .get();
      const batch = db.batch();
      expired.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
    }
  },
);
