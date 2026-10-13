import type { Request, Response } from "express";
import { z } from "zod";
import { processChannelChanges } from "./change-processor.js";
import { db } from "./firebase.js";
import { applyCors, HttpError, requireUserId, sendError } from "./http.js";
import { publishSyncState } from "./status.js";

const bodySchema = z.object({ paused: z.boolean() });

export async function handleSetMonitoring(
  request: Request,
  response: Response,
): Promise<void> {
  if (applyCors(request, response)) return;
  try {
    if (request.method !== "POST") {
      throw new HttpError(405, "method_not_allowed", "POST is required");
    }
    const uid = await requireUserId(request);
    const { paused } = bodySchema.parse(request.body);
    const updatedAt = new Date().toISOString();
    await db.collection("users").doc(uid).set(
      { monitoringPaused: paused, monitoringUpdatedAt: updatedAt },
      { merge: true },
    );
    await publishSyncState(uid, { state: paused ? "paused" : "syncing" });
    if (!paused) {
      const channels = await db
        .collection("watchChannels")
        .where("uid", "==", uid)
        .where("active", "==", true)
        .get();
      for (const channel of channels.docs) {
        await processChannelChanges(channel.id);
      }
    }
    response.json({ paused, updatedAt });
  } catch (error) {
    sendError(response, error);
  }
}
