import { FieldValue } from "firebase-admin/firestore";
import type { drive_v3 } from "googleapis";
import { driveForUser } from "./drive.js";
import { db } from "./firebase.js";
import { publishSyncState } from "./status.js";
import { advanceChangeCursor } from "./watch-policy.js";

type ChangeKind = "created" | "updated" | "moved" | "deleted" | "permission";

export interface FileSnapshot {
  id: string;
  name: string;
  mimeType?: string;
  parentIds: string[];
  modifiedTime?: string;
  trashed?: boolean;
}

export function classifyChange(
  current: FileSnapshot | undefined,
  previous: FileSnapshot | undefined,
  removed: boolean,
): ChangeKind {
  if (removed || current?.trashed) return "deleted";
  if (!previous) return "created";
  if (!sameStringSet(current?.parentIds ?? [], previous.parentIds)) return "moved";
  return "updated";
}

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

export function foldersTouchedByChildren(
  changes: ReadonlyArray<{ file?: { parents?: string[] | null } | null }>,
): Set<string> {
  const parents = new Set<string>();
  for (const change of changes) {
    for (const parentId of change.file?.parents ?? []) {
      if (parentId) parents.add(parentId);
    }
  }
  return parents;
}

/**
 * Drive often emits a second record for one action: a create is echoed again, and a
 * trash is followed by a `removed` record that no longer has the file's actor.
 */
export function shouldReportChange(
  kind: ChangeKind,
  removed: boolean,
  previous: FileSnapshot | undefined,
  current: FileSnapshot | undefined,
): boolean {
  if (kind === "deleted" && removed && !previous) return false;
  if (
    kind === "updated" &&
    previous &&
    current &&
    previous.name === current.name &&
    previous.modifiedTime === current.modifiedTime &&
    sameStringSet(previous.parentIds, current.parentIds)
  ) {
    return false;
  }
  return true;
}

/** A folder "edit" that only reflects a child change already reported in the same batch. */
export function isRedundantParentUpdate(
  fileId: string,
  kind: ChangeKind,
  current: FileSnapshot | undefined,
  previous: FileSnapshot | undefined,
  touchedParents: ReadonlySet<string>,
): boolean {
  if (kind !== "updated" || !touchedParents.has(fileId)) return false;
  const mimeType = current?.mimeType ?? previous?.mimeType;
  if (mimeType && mimeType !== FOLDER_MIME_TYPE) return false;
  if (previous && current && previous.name !== current.name) return false;
  return true;
}

function sameStringSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value) => right.includes(value))
  );
}

export function isInsideSelection(
  itemId: string,
  parentIds: string[],
  selectedFolderId: string,
  parentIndex: ReadonlyMap<string, string[]>,
): boolean {
  if (itemId === selectedFolderId) return true;
  const queue = [...parentIds];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const candidate = queue.shift()!;
    if (candidate === selectedFolderId) return true;
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    queue.push(...(parentIndex.get(candidate) ?? []));
  }
  return false;
}

async function loadParentIndex(
  uid: string,
  initialParents: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  let frontier = [...initialParents];
  const snapshots = db
    .collection("users")
    .doc(uid)
    .collection("fileSnapshots");
  while (frontier.length > 0) {
    const ids = [...new Set(frontier)].filter((id) => !result.has(id));
    frontier = [];
    for (let offset = 0; offset < ids.length; offset += 30) {
      const chunk = ids.slice(offset, offset + 30);
      const docs = await snapshots.where("__name__", "in", chunk).get();
      for (const doc of docs.docs) {
        const parents = (doc.get("parentIds") as string[] | undefined) ?? [];
        result.set(doc.id, parents);
        frontier.push(...parents);
      }
    }
  }
  return result;
}

function toSnapshot(file: drive_v3.Schema$File): FileSnapshot | undefined {
  if (!file.id || !file.name) return undefined;
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType ?? undefined,
    parentIds: file.parents ?? [],
    modifiedTime: file.modifiedTime ?? undefined,
    trashed: file.trashed ?? false,
  };
}

async function processChange(
  uid: string,
  sourceId: string,
  change: drive_v3.Schema$Change,
  notify: boolean,
  touchedParents: ReadonlySet<string>,
  reported: Set<string>,
): Promise<void> {
  const fileId = change.fileId;
  if (!fileId) return;
  const snapshotRef = db
    .collection("users")
    .doc(uid)
    .collection("fileSnapshots")
    .doc(fileId);
  const oldDoc = await snapshotRef.get();
  const previous = oldDoc.exists ? (oldDoc.data() as FileSnapshot) : undefined;
  const current = toSnapshot(change.file ?? {});
  const removed = change.removed === true;
  const effective = current ?? previous;
  if (!effective) return;
  const actor = change.file?.lastModifyingUser;
  const owner = change.file?.owners?.[0];

  const selectionsSnapshot = await db
    .collection("users")
    .doc(uid)
    .collection("selections")
    .where("sourceId", "==", sourceId)
    .get();
  const parentIndex = await loadParentIndex(uid, effective.parentIds);
  const kind = classifyChange(current, previous, removed);
  const report =
    notify &&
    shouldReportChange(kind, removed, previous, current) &&
    !isRedundantParentUpdate(fileId, kind, current, previous, touchedParents);
  const batch = db.batch();
  const seenFolders = new Set<string>();

  for (const selection of selectionsSnapshot.docs) {
    const selectedFolderId = selection.get("folderId") as string;
    const reportKey = `${selectedFolderId}:${fileId}:${kind}`;
    if (
      report &&
      !seenFolders.has(selectedFolderId) &&
      !reported.has(reportKey) &&
      !(kind === "updated" && reported.has(`${selectedFolderId}:${fileId}:created`)) &&
      isInsideSelection(
        fileId,
        effective.parentIds,
        selectedFolderId,
        parentIndex,
      )
    ) {
      seenFolders.add(selectedFolderId);
      reported.add(reportKey);
      const eventRef = db
        .collection("users")
        .doc(uid)
        .collection("notifications")
        .doc();
      batch.set(eventRef, {
        fileId,
        fileName: effective.name,
        mimeType: effective.mimeType ?? null,
        kind,
        sourceId,
        selectedFolderId,
        selectedFolderName: selection.get("name") ?? "Folder",
        parentIds: effective.parentIds,
        previousParentIds: previous?.parentIds ?? null,
        removed,
        actorName: actor?.displayName ?? null,
        actorEmail: actor?.emailAddress ?? null,
        ownerName: owner?.displayName ?? null,
        ownerEmail: owner?.emailAddress ?? null,
        webViewLink: change.file?.webViewLink ?? null,
        occurredAt:
          change.time ?? current?.modifiedTime ?? new Date().toISOString(),
        read: false,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
  }

  if (removed) {
    batch.delete(snapshotRef);
  } else if (current) {
    batch.set(snapshotRef, {
      ...current,
      sourceId,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
}

const PROCESSING_LOCK_MS = 8 * 60_000;

/** One worker per channel. A second webhook waits its turn via `rerun` instead of double-reporting. */
async function claimChannel(
  channelRef: FirebaseFirestore.DocumentReference,
): Promise<boolean> {
  return db.runTransaction(async (transaction) => {
    const channel = await transaction.get(channelRef);
    if (!channel.exists || channel.get("active") !== true) return false;
    const until = channel.get("processingUntil");
    if (typeof until === "number" && until > Date.now()) {
      transaction.update(channelRef, { rerun: true });
      return false;
    }
    transaction.update(channelRef, {
      processingUntil: Date.now() + PROCESSING_LOCK_MS,
      rerun: false,
    });
    return true;
  });
}

export async function processChannelChanges(channelId: string): Promise<void> {
  const channelRef = db.collection("watchChannels").doc(channelId);
  if (!(await claimChannel(channelRef))) return;
  try {
    let pending = true;
    while (pending) {
      pending = false;
      await drainChannel(channelRef);
      const latest = await channelRef.get();
      if (latest.get("rerun") === true) {
        await channelRef.update({ rerun: false });
        pending = true;
      }
    }
  } finally {
    await channelRef.update({ processingUntil: 0 });
  }
}

async function drainChannel(
  channelRef: FirebaseFirestore.DocumentReference,
): Promise<void> {
  const channelSnapshot = await channelRef.get();
  if (!channelSnapshot.exists || !channelSnapshot.get("active")) return;
  const channel = channelSnapshot.data()!;
  const user = await db.collection("users").doc(channel.uid).get();
  if (user.get("monitoringPaused") === true) return;

  const drive = await driveForUser(channel.uid);
  let pageToken = channel.pageToken as string;
  const reported = new Set<string>();

  do {
    const result = await drive.changes.list({
      pageToken,
      driveId: channel.driveId ?? undefined,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      includeRemoved: true,
      pageSize: 1000,
      fields:
        "nextPageToken,newStartPageToken,changes(fileId,removed,time,file(id,name,mimeType,parents,modifiedTime,trashed,driveId,webViewLink,lastModifyingUser(displayName,emailAddress),owners(displayName,emailAddress)))",
    });
    const changes = result.data.changes ?? [];
    const touchedParents = foldersTouchedByChildren(changes);
    for (const change of changes) {
      await processChange(
        channel.uid,
        channel.sourceId,
        change,
        true,
        touchedParents,
        reported,
      );
    }

    const advanced = advanceChangeCursor(pageToken, result.data);
    pageToken = advanced.pageToken;
    await channelRef.update({
      pageToken,
      lastProcessedAt: FieldValue.serverTimestamp(),
    });
    if (advanced.done) break;
  } while (true);

  await publishSyncState(channel.uid, {
    state: "idle",
    lastSyncAt: new Date().toISOString(),
    error: null,
  });
}
