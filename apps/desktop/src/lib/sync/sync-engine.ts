import {
	createFolder,
	downloadBytes,
	driveToken,
	isGoogleNative,
	listTree,
	uploadBlob,
	type DriveItem
} from '$lib/drive/drive-api';
import {
	joinLocalPath,
	makeLocalDir,
	readLocalFile,
	safeLocalName,
	scanLocalDir,
	writeLocalFile,
	type LocalEntry
} from '$lib/native';
import { loadSyncState, saveSyncState, type SyncPair, type SyncState } from './sync-store';

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
	onProgress?: (message: string) => void
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

	if (allowDownload) {
		for (const key of remoteFolders.keys()) {
			if (key) await makeLocalDir(joinLocalPath(pair.localPath, key)).catch(() => undefined);
		}
	}
	if (allowUpload && canEdit) {
		for (const key of localDirs) await ensureRemoteFolder(key).catch(() => undefined);
	}

	await saveSyncState(pair.id, next);
	return result;
}

export function describeResult(result: SyncResult): string {
	const parts: string[] = [];
	if (result.uploaded) parts.push(`${result.uploaded} uploaded`);
	if (result.downloaded) parts.push(`${result.downloaded} downloaded`);
	if (result.failed) parts.push(`${result.failed} failed`);
	if (result.skipped) parts.push(`${result.skipped} Google Docs skipped`);
	return parts.length ? parts.join(', ') : 'Up to date';
}
