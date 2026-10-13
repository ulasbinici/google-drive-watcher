import {
	createFolder,
	downloadBytes,
	DriveStatusError,
	driveToken,
	isExpiredCursor,
	isGoogleNative,
	listChanges,
	listTree,
	trashItem,
	uploadBlob,
	type DriveChange,
	type DriveItem
} from '$lib/drive/drive-api';
import {
	joinLocalPath,
	localPathExists,
	makeLocalDir,
	readLocalFile,
	removeLocal,
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
	/** Files or folders removed on the other side because mirror deletions is on. */
	removed: number;
	skipped: number;
	failed: number;
	firstError: string | null;
	needsEditAccess: boolean;
	/** True when pause stopped the run before every file was visited. */
	stopped: boolean;
	/** Files copied or deleted in this run, newest last. Prefixed with ↓, ↑, or ✕. */
	files: string[];
}

export interface SyncRunOptions {
	/** Delete the other copy when a previously synced file disappears. Default off. */
	mirrorDeletes?: boolean;
}

function emptyResult(): SyncResult {
	return {
		uploaded: 0,
		downloaded: 0,
		removed: 0,
		skipped: 0,
		failed: 0,
		firstError: null,
		needsEditAccess: false,
		stopped: false,
		files: []
	};
}

function under(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(`${prefix}/`);
}

async function trashSynced(id: string): Promise<void> {
	try {
		await trashItem(id);
	} catch (error) {
		if (error instanceof DriveStatusError && error.status === 404) return;
		throw error;
	}
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
	shouldStop?: () => boolean,
	options?: SyncRunOptions
): Promise<SyncResult> {
	const { canEdit } = await driveToken();
	onProgress?.('Comparing files…');
	const [localEntries, remoteEntries, previous, previousIndex] = await Promise.all([
		scanLocalDir(pair.localPath),
		listTree(pair.driveFolderId, pair.driveId),
		loadSyncState(pair.id),
		loadPairIndex(pair.id)
	]);

	const result = emptyResult();
	const mirrorDeletes = options?.mirrorDeletes === true;

	const localFiles = new Map<string, LocalEntry>();
	let localDirs: string[] = [];
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

	const noteRemoved = (key: string) => {
		result.removed++;
		result.files.push(`✕ ${key}`);
	};

	if (mirrorDeletes && (await localPathExists(pair.localPath))) {
		const covered: string[] = [];
		if (allowUpload && canEdit) {
			const missingLocal = Object.entries(previousIndex?.folders ?? {})
				.filter((entry): entry is [string, string] => Boolean(entry[1]) && !localDirs.includes(entry[1]))
				.sort((a, b) => a[1].length - b[1].length);
			for (const [id, path] of missingLocal) {
				if (shouldStop?.()) {
					result.stopped = true;
					break;
				}
				if (covered.some((prefix) => under(path, prefix))) continue;
				const remoteEdited = [...remoteFiles.entries()].some(([key, item]) => {
					if (!under(key, path)) return false;
					const before = previous[key];
					const modified = Date.parse(item.modifiedTime ?? '');
					return !before || !same(modified, before.driveModified);
				});
				if (remoteEdited) continue;
				try {
					onProgress?.(`Removing ${path} from Drive`);
					await trashSynced(id);
					covered.push(path);
					noteRemoved(path);
					for (const key of [...remoteFiles.keys()]) {
						if (under(key, path)) remoteFiles.delete(key);
					}
					for (const key of [...remoteFolders.keys()]) {
						if (under(key, path)) remoteFolders.delete(key);
					}
				} catch (error) {
					result.failed++;
					result.firstError ??= `${path}: ${error instanceof Error ? error.message : String(error)}`;
				}
			}
		}
		if (!result.stopped && allowDownload) {
			const remotePaths = new Set(remoteFolders.keys());
			const missingRemote = Object.values(previousIndex?.folders ?? {})
				.filter((path): path is string => Boolean(path) && !remotePaths.has(path))
				.sort((a, b) => a.length - b.length);
			for (const path of missingRemote) {
				if (shouldStop?.()) {
					result.stopped = true;
					break;
				}
				if (covered.some((prefix) => under(path, prefix))) continue;
				const localEdited = [...localFiles.entries()].some(([key, local]) => {
					if (!under(key, path)) return false;
					const before = previous[key];
					return !before || !same(local.modified, before.localModified) || local.size !== before.size;
				});
				if (localEdited) continue;
				try {
					onProgress?.(`Deleting ${path}`);
					await removeLocal(pair.localPath, path);
					covered.push(path);
					noteRemoved(path);
					for (const key of [...localFiles.keys()]) {
						if (under(key, path)) localFiles.delete(key);
					}
					localDirs = localDirs.filter((key) => !under(key, path));
				} catch (error) {
					result.failed++;
					result.firstError ??= `${path}: ${error instanceof Error ? error.message : String(error)}`;
				}
			}
		}
	}

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
				// Unchanged since the last sync, so it was removed on Drive on purpose.
				if (before && same(local.modified, before.localModified)) {
					if (mirrorDeletes && allowDownload) {
						onProgress?.(`Deleting ${key}`);
						await removeLocal(pair.localPath, key);
						noteRemoved(key);
					} else next[key] = before;
				} else if (allowUpload) await upload(key, local);
				return;
			}
			if (remote && !local) {
				const driveModified = Date.parse(remote.modifiedTime ?? '');
				if (before && same(driveModified, before.driveModified)) {
					if (mirrorDeletes && allowUpload) {
						if (!canEdit) {
							result.needsEditAccess = true;
							next[key] = before;
						} else {
							onProgress?.(`Removing ${key} from Drive`);
							await trashSynced(remote.id);
							noteRemoved(key);
						}
					} else next[key] = before;
				} else if (allowDownload) await download(key, remote);
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
	shouldStop?: () => boolean,
	options?: SyncRunOptions
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
			options?.mirrorDeletes === true,
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
	mirrorDeletes: boolean,
	onProgress?: (message: string) => void,
	shouldStop?: () => boolean
): Promise<SyncResult> {
	const result = emptyResult();
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

	const noteRemoved = (key: string) => {
		result.removed++;
		result.files.push(`✕ ${key}`);
	};

	const forgetTree = (prefix: string) => {
		for (const key of Object.keys(next)) {
			if (under(key, prefix)) delete next[key];
		}
		for (const [id, path] of Object.entries(folders)) {
			if (path && under(path, prefix)) {
				delete folders[id];
				idByPath.delete(path);
			}
		}
	};

	const placeFolders = async (incoming: DriveChange[]) => {
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
				const key = childKey(parent, file.name);
				folders[file.id] = key;
				idByPath.set(key, file.id);
				if (allowDownload && key) {
					await makeLocalDir(joinLocalPath(pair.localPath, key)).catch(() => undefined);
				}
			}
			if (later.length === pending.length) break;
			pending = later;
		}
	};

	await placeFolders(changes);

	for (const change of changes) {
		if (shouldStop?.()) {
			result.stopped = true;
			break;
		}
		if (change.removed) {
			if (!mirrorDeletes) continue;
			const folderPath = folders[change.fileId];
			const filePath = folderPath
				? null
				: Object.entries(next).find(([, record]) => record.driveFileId === change.fileId)?.[0];
			const key = folderPath || filePath;
			if (!key || !(await localPathExists(pair.localPath))) continue;
			try {
				if (folderPath) {
					if (!allowDownload) continue;
					const edited = dirty.some((path) => under(path, key));
					if (edited) continue;
					onProgress?.(`Deleting ${key}`);
					if (await localPathExists(pair.localPath)) await removeLocal(pair.localPath, key);
					forgetTree(key);
					noteRemoved(key);
				} else if (allowDownload) {
					const before = next[key];
					const local = await statLocal(pair.localPath, key);
					if (
						local &&
						!local.isDir &&
						before &&
						(!same(local.modified, before.localModified) || local.size !== before.size) &&
						allowUpload
					) {
						await upload(key, local);
					} else {
						if (local && (await localPathExists(pair.localPath))) {
							onProgress?.(`Deleting ${key}`);
							await removeLocal(pair.localPath, key);
							noteRemoved(key);
						}
						delete next[key];
					}
				}
			} catch (error) {
				result.failed++;
				result.firstError ??= `${key}: ${error instanceof Error ? error.message : String(error)}`;
			}
			continue;
		}
		const file = change.file;
		if (!file || file.isFolder) continue;
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

	if (!result.stopped && mirrorDeletes && allowUpload && (await localPathExists(pair.localPath))) {
		const missing = [...dirty].filter(Boolean).sort((a, b) => a.length - b.length);
		const covered: string[] = [];
		for (const relative of missing) {
			if (shouldStop?.()) {
				result.stopped = true;
				break;
			}
			if (covered.some((prefix) => under(relative, prefix))) continue;
			const stat = await statLocal(pair.localPath, relative).catch(() => null);
			if (stat?.isDir) {
				try {
					const nested = await scanLocalDir(joinLocalPath(pair.localPath, relative));
					const present = new Set(
						nested.filter((entry) => !entry.isDir).map((entry) => `${relative}/${entry.path}`)
					);
					const gone = Object.keys(next).filter(
						(key) => key.startsWith(`${relative}/`) && !present.has(key)
					);
					if (!gone.length) continue;
					if (!canEdit) {
						result.needsEditAccess = true;
						continue;
					}
					for (const key of gone) {
						const record = next[key];
						if (!record) continue;
						onProgress?.(`Removing ${key} from Drive`);
						await trashSynced(record.driveFileId);
						delete next[key];
						noteRemoved(key);
					}
				} catch (error) {
					result.failed++;
					result.firstError ??= `${relative}: ${error instanceof Error ? error.message : String(error)}`;
				}
				continue;
			}
			if (stat) continue;
			const folderId = idByPath.get(relative);
			try {
				if (folderId) {
					if (!canEdit) {
						result.needsEditAccess = true;
						continue;
					}
					onProgress?.(`Removing ${relative} from Drive`);
					await trashSynced(folderId);
					forgetTree(relative);
					covered.push(relative);
					noteRemoved(relative);
					continue;
				}
				const before = next[relative];
				if (before) {
					if (!canEdit) {
						result.needsEditAccess = true;
						continue;
					}
					onProgress?.(`Removing ${relative} from Drive`);
					await trashSynced(before.driveFileId);
					delete next[relative];
					covered.push(relative);
					noteRemoved(relative);
					continue;
				}
				const children = Object.keys(next).filter((key) => key.startsWith(`${relative}/`));
				if (!children.length) continue;
				if (!canEdit) {
					result.needsEditAccess = true;
					continue;
				}
				for (const key of children) {
					const record = next[key];
					if (!record) continue;
					onProgress?.(`Removing ${key} from Drive`);
					await trashSynced(record.driveFileId);
					delete next[key];
					noteRemoved(key);
				}
				covered.push(relative);
			} catch (error) {
				result.failed++;
				result.firstError ??= `${relative}: ${error instanceof Error ? error.message : String(error)}`;
			}
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
	if (result.removed) parts.push(`${result.removed} deleted`);
	if (result.failed) parts.push(`${result.failed} failed`);
	if (result.skipped) parts.push(`${result.skipped} Google Docs skipped`);
	return parts.length ? parts.join(', ') : 'Up to date';
}
