import { FieldValue } from "firebase-admin/firestore";
import { db } from "./firebase.js";

export async function publishSyncState(
  uid: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await db
    .collection("users")
    .doc(uid)
    .collection("status")
    .doc("sync")
    .set({ ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

export async function publishActiveChannels(uid: string): Promise<void> {
  const active = await db
    .collection("watchChannels")
    .where("uid", "==", uid)
    .where("active", "==", true)
    .get();
  await publishSyncState(uid, {
    channels: active.docs.map((doc) => ({
      id: doc.id,
      driveId: doc.get("sourceId"),
      driveName: doc.get("sourceId") === "my-drive" ? "My Drive" : doc.get("sourceId"),
      state: "active",
      expiresAt: new Date(doc.get("expiresAt").toMillis()).toISOString(),
      lastEventAt: null,
      error: null,
    })),
  });
}
