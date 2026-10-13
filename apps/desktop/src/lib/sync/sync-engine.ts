import {
	createFolder,
	downloadBytes,
	driveToken,
	isExpiredCursor,
	isGoogleNative,
	listChanges,
	listTree,
	uploadBlob,
	type DriveChange,
	type DriveItem
} from '$lib/drive/drive-api';
import {
	joinLocalPath,
	makeLocalDir,
	readLocalFile,
	safeLocalName,
	scanLocalDir,
	statLocal,
	writeLocalFile,
	type LocalEntry
} from '$lib/native';
import {
	loadDriveCursor,
	loadPairIndex,
	loadSyncState,
	saveDriveCursor,
	savePairIndex,
	saveSyncState,
	type SyncPair,
	type SyncState
} from './sync-store';

/** A full walk is the safety net when the watcher misses an event or the cursor expires. */
const FULL_EVERY_MS = 24 * 60 * 60 * 1000;

/** FAT and some network shares only keep 2-second timestamps. */
const CLOCK_SLACK_MS = 2000;
const PARALLEL_TRANSFERS = 4;

export interface SyncResult {
	uploaded: number;
	downloaded: number;
	skipped: number;
	failed: number;
	firstError: string | null;
	needsEditAccess: boolean;
	/** True when pause stopped the run before every file was visited. */
	stopped: boolean;
	/** Files copied in this run, newest last. Prefixed with ↓ or ↑. */
	files: string[];
}

function same(a: number, b: number): boolean {
	return Math.abs(a - b) < CLOCK_SLACK_MS;
}

function parentKey(key: string): string {
	const slash = key.lastIndexOf('/');
	return slash < 0 ? '' : key.slice(0, slash);
}

function baseName(key: string): string {
	return key.slice(key.lastIndexOf('/') + 1);
}

async function pool<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const item = items[next++]!;
			await run(item);
		}
	});
	await Promise.all(workers);
}

export async function syncPair(
	pair: SyncPair,
	onProgress?: (message: string) => void,
	shouldStop?: () => boolean
): Promise<SyncResult> {
	const { canEdit } = await driveToken();
	onProgress?.('Comparing files…');
	const [localEntries, remoteEntries, previous] = await Promise.all([
		scanLocalDir(pair.localPath),
		listTree(pair.driveFolderId, pair.driveId),
		loadSyncState(pair.id)
	]);

	const result: SyncResult = {
		uploaded: 0,
		downloaded: 0,
		skipped: 0,
		failed: 0,
		firstError: null,
		needsEditAccess: false,
		stopped: false,
		files: []
	};

	const localFiles = new Map<string, LocalEntry>();
	const localDirs: string[] = [];
	for (const entry of localEntries) {
		if (entry.isDir) localDirs.push(entry.path);
		else localFiles.set(entry.path, entry);
	}

	const remoteFiles = new Map<string, DriveItem>();
	const remoteFolders = new Map<string, Promise<string>>([['', Promise.resolve(pair.driveFolderId)]]);
	for (const { path, item } of remoteEntries) {
		const key = path.split('/').map(safeLocalName).join('/');
		if (item.isFolder) remoteFolders.set(key, Promise.resolve(item.id));
		else if (isGoogleNative(item)) result.skipped++;
		else remoteFiles.set(key, item);
	}

	const allowUpload = pair.direction !== 'download';
	const allowDownload = pair.direction !== 'upload';
	const next: SyncState = {};

	const ensureRemoteFolder = (key: string): Promise<string> => {
		const known = remoteFolders.get(key);
		if (known) return known;
		const created = ensureRemoteFolder(parentKey(key)).then(
			async (parentId) => (await createFolder(baseName(key), parentId)).id
		);
		remoteFolders.set(key, created);
		return created;
	};

	const upload = async (key: string, local: LocalEntry, existing?: DriveItem) => {
		if (!canEdit) {
			result.needsEditAccess = true;
			return false;
		}
		onProgress?.(`Uploading ${key}`);
		const bytes = await readLocalFile(joinLocalPath(pair.localPath, key));
		const item = await uploadBlob(new Blob([bytes]), {
			name: existing?.name ?? baseName(key),
			parentId: existing ? undefined : await ensureRemoteFolder(parentKey(key)),
			fileId: existing?.id,
			modified: local.modified
		});
		next[key] = {
			driveFileId: item.id,
			driveModified: Date.parse(item.modifiedTime ?? '') || local.modified,
			localModified: local.modified,
			size: local.size
		};
		result.uploaded++;
		result.files.push(`↑ ${key}`);
		return true;
	};

	const download = async (key: string, remote: DriveItem) => {
		onProgress?.(`Downloading ${key}`);
		const driveModified = Date.parse(remote.modifiedTime ?? '') || Date.now();
		const bytes = await downloadBytes(remote);
		const localModified = await writeLocalFile(
			joinLocalPath(pair.localPath, key),
			bytes,
			driveModified
		);
		next[key] = {
			driveFileId: remote.id,
			driveModified,
			localModified,
			size: bytes.byteLength
		};
		result.downloaded++;
		result.files.push(`↓ ${key}`);
	};

	const keys = [...new Set([...localFiles.keys(), ...remoteFiles.keys()])];
	await pool(keys, PARALLEL_TRANSFERS, async (key) => {
		if (shouldStop?.()) {
			result.stopped = true;
			return;
		}
		const local = localFiles.get(key);
		const remote = remoteFiles.get(key);
		const before = previous[key];
		try {
			if (local && !remote) {
				// Unchanged since the last sync, so it was removed on Drive on purpose: leave it alone.
				if (before && same(local.modified, before.localModified)) next[key] = before;
				else if (allowUpload) await upload(key, local);
				return;
			}
			if (remote && !local) {
				const driveModified = Date.parse(remote.modifiedTime ?? '');
				if (before && same(driveModified, before.driveModified)) next[key] = before;
				else if (allowDownload) await download(key, remote);
				return;
			}
			if (!local || !remote) return;

			const driveModified = Date.parse(remote.modifiedTime ?? '');
			const record = () => {
				next[key] = {
					driveFileId: remote.id,
					driveModified,
					localModified: local.modified,
					size: local.size
				};
			};
			const localChanged = !before || !same(local.modified, before.localModified);
			const remoteChanged = !before || !same(driveModified, before.driveModified);

			if (!before && remote.size === local.size && same(local.modified, driveModified)) {
				record();
				return;
			}
			if (before && !localChanged && !remoteChanged) {
				next[key] = before;
				return;
			}

			let winner: 'local' | 'remote';
			if (pair.direction === 'upload') winner = 'local';
			else if (pair.direction === 'download') winner = 'remote';
			else if (localChanged && !remoteChanged) winner = 'local';
			else if (remoteChanged && !localChanged) winner = 'remote';
			else winner = local.modified >= driveModified ? 'local' : 'remote';

			if (winner === 'local') {
				if (!localChanged && before) next[key] = before;
				else if (!(await upload(key, local, remote)) && before) next[key] = before;
			} else if (!remoteChanged && before) {
				next[key] = before;
			} else {
				await download(key, remote);
			}
		} catch (error) {
			result.failed++;
			result.firstError ??= `${key}: ${error instanceof Error ? error.message : String(error)}`;
			if (before) next[key] = before;
		}
	});

	if (result.stopped) {
		for (const [key, record] of Object.entries(previous)) {
			if (!(key in next)) next[key] = record;
		}
	} else {
		if (allowDownload) {
			for (const key of remoteFolders.keys()) {
				if (key) await makeLocalDir(joinLocalPath(pair.localPath, key)).catch(() => undefined);
			}
		}
		if (allowUpload && canEdit) {
			for (const key of localDirs) await ensureRemoteFolder(key).catch(() => undefined);
		}
		const folders: Record<string, string> = { [pair.driveFolderId]: '' };
		for (const [key, idPromise] of remoteFolders) {
			if (!key) continue;
			folders[await idPromise] = key;
		}
		await savePairIndex(pair.id, { fullAt: new Date().toISOString(), folders });
	}

	await saveSyncState(pair.id, next);
	return result;
}

export async function pairNeedsFullSync(pair: SyncPair): Promise<boolean> {
	const [cursor, index] = await Promise.all([loadDriveCursor(pair.driveId), loadPairIndex(pair.id)]);
	if (!cursor?.pageToken || !index?.fullAt) return true;
	const at = Date.parse(index.fullAt);
	return !Number.isFinite(at) || Date.now() - at >= FULL_EVERY_MS;
}

export interface DriveSyncOutcome {
	/** The stored page token was rejected. The caller runs a full sync and takes a new token. */
	expired: boolean;
	results: Array<{ pair: SyncPair; result: SyncResult }>;
}

/**
 * One `changes.list` for a drive, applied to every pair on that drive.
 * `dirty` holds relative paths the local watcher reported.
 */
export async function syncDriveChanges(
	pairs: SyncPair[],
	dirty: Readonly<Record<string, readonly string[]>>,
	onProgress?: (pair: SyncPair, message: string) => void,
	shouldStop?: () => boolean
): Promise<DriveSyncOutcome> {
	if (!pairs.length) return { expired: false, results: [] };
	const driveId = pairs[0]?.driveId ?? null;
	const cursor = await loadDriveCursor(driveId);
	if (!cursor?.pageToken) return { expired: true, results: [] };

	let changes: DriveChange[];
	let pageToken: string;
	try {
		if (pairs[0]) onProgress?.(pairs[0], 'Checking Drive changes…');
		const page = await listChanges(cursor.pageToken, driveId);
		changes = page.changes;
		pageToken = page.pageToken;
	} catch (error) {
		if (isExpiredCursor(error)) return { expired: true, results: [] };
		throw error;
	}

	const { canEdit } = await driveToken();
	const results: Array<{ pair: SyncPair; result: SyncResult }> = [];
	let stopped = false;
	for (const pair of pairs) {
		if (shouldStop?.()) {
			stopped = true;
			break;
		}
		const result = await applyIncremental(
			pair,
			changes,
			dirty[pair.id] ?? [],
			canEdit,
			(message) => onProgress?.(pair, message),
			shouldStop
		);
		results.push({ pair, result });
		if (result.stopped) {
			stopped = true;
			break;
		}
	}
	const failed = results.some((entry) => entry.result.failed > 0);
	if (!stopped && !failed) await saveDriveCursor(driveId, { pageToken });
	return { expired: false, results };
}

function knownParent(folders: Record<string, string>, parentIds: string[]): string | null {
	for (const id of parentIds) {
		if (Object.hasOwn(folders, id)) return folders[id] ?? '';
	}
	return null;
}

function childKey(parent: string, name: string): string {
	const safe = safeLocalName(name);
	return parent ? `${parent}/${safe}` : safe;
}

async function applyIncremental(
	pair: SyncPair,
	changes: DriveChange[],
	dirty: readonly string[],
	canEdit: boolean,
	onProgress?: (message: string) => void,
	shouldStop?: () => boolean
): Promise<SyncResult> {
	const result: SyncResult = {
		uploaded: 0,
		downloaded: 0,
		skipped: 0,
		failed: 0,
		firstError: null,
		needsEditAccess: false,
		stopped: false,
		files: []
	};
	const index = await loadPairIndex(pair.id);
	const previous = await loadSyncState(pair.id);
	if (!index) return result;

	const next: SyncState = { ...previous };
	const folders: Record<string, string> = { ...index.folders, [pair.driveFolderId]: '' };
	const idByPath = new Map<string, string>();
	for (const [id, path] of Object.entries(folders)) idByPath.set(path, id);
	const allowUpload = pair.direction !== 'download';
	const allowDownload = pair.direction !== 'upload';
	const touched = new Set<string>();

	const ensureRemoteFolder = (key: string): Promise<string> => {
		const known = idByPath.get(key);
		if (known) return Promise.resolve(known);
		if (!key) return Promise.resolve(pair.driveFolderId);
		return ensureRemoteFolder(parentKey(key)).then(async (parentId) => {
			const created = await createFolder(baseName(key), parentId);
			idByPath.set(key, created.id);
			folders[created.id] = key;
			return created.id;
		});
	};

	const upload = async (key: string, local: LocalEntry, existingId?: string) => {
		if (!canEdit) {
			result.needsEditAccess = true;
			return false;
		}
		onProgress?.(`Uploading ${key}`);
		const bytes = await readLocalFile(joinLocalPath(pair.localPath, key));
		const item = await uploadBlob(new Blob([bytes]), {
			name: baseName(key),
			parentId: existingId ? undefined : await ensureRemoteFolder(parentKey(key)),
			fileId: existingId,
			modified: local.modified
		});
		next[key] = {
			driveFileId: item.id,
			driveModified: Date.parse(item.modifiedTime ?? '') || local.modified,
			localModified: local.modified,
			size: local.size
		};
		result.uploaded++;
		result.files.push(`↑ ${key}`);
		return true;
	};

	const download = async (key: string, remote: DriveItem) => {
		onProgress?.(`Downloading ${key}`);
		await makeLocalDir(joinLocalPath(pair.localPath, parentKey(key))).catch(() => undefined);
		const driveModified = Date.parse(remote.modifiedTime ?? '') || Date.now();
		const bytes = await downloadBytes(remote);
		const localModified = await writeLocalFile(
			joinLocalPath(pair.localPath, key),
			bytes,
			driveModified
		);
		next[key] = {
			driveFileId: remote.id,
			driveModified,
			localModified,
			size: bytes.byteLength
		};
		result.downloaded++;
		result.files.push(`↓ ${key}`);
	};

	const placeFolders = (incoming: DriveChange[]) => {
		let pending = incoming.filter((change) => change.file?.isFolder && !change.removed);
		for (let guard = pending.length + 1; pending.length && guard > 0; guard--) {
			const later: DriveChange[] = [];
			for (const change of pending) {
				const file = change.file;
				if (!file) continue;
				const parent = knownParent(folders, file.parents);
				if (parent === null) {
					later.push(change);
					continue;
				}
				folders[file.id] = childKey(parent, file.name);
				idByPath.set(folders[file.id]!, file.id);
			}
			if (later.length === pending.length) break;
			pending = later;
		}
	};

	placeFolders(changes);

	for (const change of changes) {
		if (shouldStop?.()) {
			result.stopped = true;
			break;
		}
		const file = change.file;
		if (change.removed || !file || file.isFolder) continue;
		if (isGoogleNative(file)) {
			result.skipped++;
			continue;
		}
		const parent = knownParent(folders, file.parents);
		if (parent === null) continue;
		const key = childKey(parent, file.name);
		touched.add(key);
		try {
			const local = await statLocal(pair.localPath, key);
			const before = previous[key];
			if (local?.isDir) continue;
			if (!local) {
				const driveModified = Date.parse(file.modifiedTime ?? '');
				if (before && same(driveModified, before.driveModified)) next[key] = before;
				else if (allowDownload) await download(key, file);
				continue;
			}
			const driveModified = Date.parse(file.modifiedTime ?? '');
			const localChanged = !before || !same(local.modified, before.localModified);
			const remoteChanged = !before || !same(driveModified, before.driveModified);
			if (!before && file.size === local.size && same(local.modified, driveModified)) {
				next[key] = {
					driveFileId: file.id,
					driveModified,
					localModified: local.modified,
					size: local.size
				};
				continue;
			}
			if (before && !localChanged && !remoteChanged) {
				next[key] = before;
				continue;
			}
			let winner: 'local' | 'remote';
			if (pair.direction === 'upload') winner = 'local';
			else if (pair.direction === 'download') winner = 'remote';
			else if (localChanged && !remoteChanged) winner = 'local';
			else if (remoteChanged && !localChanged) winner = 'remote';
			else winner = local.modified >= driveModified ? 'local' : 'remote';
			if (winner === 'local') {
				if (!localChanged && before) next[key] = before;
				else if (!(await upload(key, local, file.id)) && before) next[key] = before;
			} else if (!remoteChanged && before) {
				next[key] = before;
			} else {
				await download(key, file);
			}
		} catch (error) {
			result.failed++;
			result.firstError ??= `${key}: ${error instanceof Error ? error.message : String(error)}`;
			if (previous[key]) next[key] = previous[key];
		}
	}

	if (!result.stopped && allowUpload) {
		for (const relative of dirty) {
			if (shouldStop?.()) {
				result.stopped = true;
				break;
			}
			const files = await expandDirty(pair.localPath, relative);
			for (const local of files) {
				if (touched.has(local.path)) continue;
				const before = next[local.path];
				const changed =
					!before || !same(local.modified, before.localModified) || local.size !== before.size;
				if (!changed) continue;
				try {
					await upload(local.path, local, before?.driveFileId);
				} catch (error) {
					result.failed++;
					result.firstError ??= `${local.path}: ${error instanceof Error ? error.message : String(error)}`;
					if (before) next[local.path] = before;
				}
			}
		}
	}

	await saveSyncState(pair.id, next);
	if (!result.stopped) await savePairIndex(pair.id, { fullAt: index.fullAt, folders });
	return result;
}

async function expandDirty(root: string, relative: string): Promise<LocalEntry[]> {
	const stat = await statLocal(root, relative).catch(() => null);
	if (!stat) return [];
	if (!stat.isDir) return [stat];
	const nested = await scanLocalDir(joinLocalPath(root, relative));
	return nested
		.filter((entry) => !entry.isDir)
		.map((entry) => ({ ...entry, path: `${relative}/${entry.path}` }));
}

export function describeResult(result: SyncResult): string {
	const parts: string[] = [];
	if (result.uploaded) parts.push(`${result.uploaded} uploaded`);
	if (result.downloaded) parts.push(`${result.downloaded} downloaded`);
	if (result.failed) parts.push(`${result.failed} failed`);
	if (result.skipped) parts.push(`${result.skipped} Google Docs skipped`);
	return parts.length ? parts.join(', ') : 'Up to date';
}
