import { APP_EVENTS, emitAppEvent, isTauri } from '$lib/native';

export type SyncDirection = 'two-way' | 'download' | 'upload';

export const DIRECTION_LABELS: Record<SyncDirection, string> = {
	'two-way': 'Two-way',
	download: 'Download only (Drive → PC)',
	upload: 'Upload only (PC → Drive)'
};

export interface SyncPair {
	id: string;
	driveFolderId: string;
	driveFolderName: string;
	/** Human-readable Drive location, e.g. "Shared with me / Games / Dev files". */
	drivePath: string;
	/** Shared drive id when the folder lives in a shared drive. */
	driveId: string | null;
	localPath: string;
	direction: SyncDirection;
	createdAt: string;
	lastSyncAt: string | null;
	lastError: string | null;
	lastSummary: string | null;
}

/** What both sides looked like after the last successful sync of a file. */
export interface SyncedFile {
	driveFileId: string;
	driveModified: number;
	localModified: number;
	size: number;
}

export type SyncState = Record<string, SyncedFile>;

const PAIRS_KEY = 'pairs';
const SETTINGS_KEY = 'settings';
const STORE_FILE = 'sync.json';
const STATE_FILE = 'sync-state.json';
const LOCAL_PAIRS_KEY = 'drive-watch-sync-pairs';
const LOCAL_SETTINGS_KEY = 'drive-watch-sync-settings';

export const DEFAULT_SYNC_INTERVAL_MINUTES = 5;
export const MIN_SYNC_INTERVAL_MINUTES = 1;
export const MAX_SYNC_INTERVAL_MINUTES = 24 * 60;

export interface SyncSettings {
	paused: boolean;
	intervalMinutes: number;
}

export function clampIntervalMinutes(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_SYNC_INTERVAL_MINUTES;
	return Math.min(
		MAX_SYNC_INTERVAL_MINUTES,
		Math.max(MIN_SYNC_INTERVAL_MINUTES, Math.round(value))
	);
}

type Store = import('@tauri-apps/plugin-store').Store;
let storeHandle: Promise<Store> | null = null;
let stateHandle: Promise<Store> | null = null;

async function openStore(file: string): Promise<Store> {
	const { load } = await import('@tauri-apps/plugin-store');
	return load(file, { autoSave: false, defaults: {} });
}

function isMissingFile(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes('os error 2') || /not found/i.test(message);
}

function pairsStore() {
	storeHandle ??= openStore(STORE_FILE);
	return storeHandle;
}

function stateStore() {
	stateHandle ??= openStore(STATE_FILE);
	return stateHandle;
}

function defaultSettings(): SyncSettings {
	return { paused: false, intervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES };
}

export async function loadSyncSettings(): Promise<SyncSettings> {
	const fallback = defaultSettings();
	if (!isTauri()) {
		const raw = localStorage.getItem(LOCAL_SETTINGS_KEY);
		if (!raw) return fallback;
		const parsed = JSON.parse(raw) as Partial<SyncSettings>;
		return {
			paused: parsed.paused === true,
			intervalMinutes: clampIntervalMinutes(Number(parsed.intervalMinutes))
		};
	}
	const store = await pairsStore();
	await store.reload().catch((error: unknown) => {
		if (!isMissingFile(error)) throw error;
	});
	const saved = await store.get<Partial<SyncSettings>>(SETTINGS_KEY);
	return {
		paused: saved?.paused === true,
		intervalMinutes: clampIntervalMinutes(Number(saved?.intervalMinutes))
	};
}

export async function saveSyncSettings(patch: Partial<SyncSettings>): Promise<SyncSettings> {
	const current = await loadSyncSettings();
	const next: SyncSettings = {
		...current,
		...patch,
		intervalMinutes: clampIntervalMinutes(patch.intervalMinutes ?? current.intervalMinutes)
	};
	if (!isTauri()) {
		localStorage.setItem(LOCAL_SETTINGS_KEY, JSON.stringify(next));
	} else {
		const store = await pairsStore();
		await store.set(SETTINGS_KEY, next);
		await store.save();
	}
	return next;
}

export async function loadPairs(): Promise<SyncPair[]> {
	if (!isTauri()) {
		return JSON.parse(localStorage.getItem(LOCAL_PAIRS_KEY) ?? '[]') as SyncPair[];
	}
	const store = await pairsStore();
	// The file does not exist until the first pair is saved. reload() reports that as os error 2.
	await store.reload().catch((error: unknown) => {
		if (!isMissingFile(error)) throw error;
	});
	return (await store.get<SyncPair[]>(PAIRS_KEY)) ?? [];
}

async function writePairs(pairs: SyncPair[]): Promise<void> {
	if (!isTauri()) {
		localStorage.setItem(LOCAL_PAIRS_KEY, JSON.stringify(pairs));
	} else {
		const store = await pairsStore();
		await store.set(PAIRS_KEY, pairs);
		await store.save();
	}
	await emitAppEvent(APP_EVENTS.syncPairsChanged);
}

export async function upsertPair(
	input: Omit<SyncPair, 'id' | 'createdAt' | 'lastSyncAt' | 'lastError' | 'lastSummary'> & {
		id?: string;
	}
): Promise<SyncPair> {
	const pairs = await loadPairs();
	const existing = pairs.find((p) => p.id === input.id || p.driveFolderId === input.driveFolderId);
	const pair: SyncPair = existing
		? { ...existing, ...input, id: existing.id }
		: {
				...input,
				id: crypto.randomUUID(),
				createdAt: new Date().toISOString(),
				lastSyncAt: null,
				lastError: null,
				lastSummary: null
			};
	if (existing && existing.localPath !== pair.localPath) await clearSyncState(existing.id);
	await writePairs(existing ? pairs.map((p) => (p.id === pair.id ? pair : p)) : [...pairs, pair]);
	return pair;
}

export async function updatePairStatus(
	id: string,
	patch: Pick<Partial<SyncPair>, 'lastSyncAt' | 'lastError' | 'lastSummary' | 'direction'>
): Promise<void> {
	const pairs = await loadPairs();
	if (!pairs.some((p) => p.id === id)) return;
	await writePairs(pairs.map((p) => (p.id === id ? { ...p, ...patch } : p)));
}

export async function removePair(id: string): Promise<void> {
	const pairs = await loadPairs();
	await writePairs(pairs.filter((p) => p.id !== id));
	await clearSyncState(id);
}

export async function loadSyncState(id: string): Promise<SyncState> {
	if (!isTauri()) return {};
	const store = await stateStore();
	return (await store.get<SyncState>(id)) ?? {};
}

export async function saveSyncState(id: string, state: SyncState): Promise<void> {
	if (!isTauri()) return;
	const store = await stateStore();
	await store.set(id, state);
	await store.save();
}

async function clearSyncState(id: string): Promise<void> {
	if (!isTauri()) return;
	const store = await stateStore();
	await store.delete(id);
	await store.delete(pairIndexKey(id));
	await store.save();
}

/** Drive folder id to relative path. The synced root maps to "". */
export interface PairIndex {
	fullAt: string;
	folders: Record<string, string>;
}

export interface DriveCursor {
	pageToken: string;
}

function driveCursorKey(driveId: string | null): string {
	return `cursor:${driveId ?? 'my-drive'}`;
}

function pairIndexKey(id: string): string {
	return `index:${id}`;
}

export async function loadPairIndex(id: string): Promise<PairIndex | null> {
	if (!isTauri()) return null;
	const store = await stateStore();
	return (await store.get<PairIndex>(pairIndexKey(id))) ?? null;
}

export async function savePairIndex(id: string, index: PairIndex): Promise<void> {
	if (!isTauri()) return;
	const store = await stateStore();
	await store.set(pairIndexKey(id), index);
	await store.save();
}

export async function loadDriveCursor(driveId: string | null): Promise<DriveCursor | null> {
	if (!isTauri()) return null;
	const store = await stateStore();
	return (await store.get<DriveCursor>(driveCursorKey(driveId))) ?? null;
}

export async function saveDriveCursor(driveId: string | null, cursor: DriveCursor): Promise<void> {
	if (!isTauri()) return;
	const store = await stateStore();
	await store.set(driveCursorKey(driveId), cursor);
	await store.save();
}

export async function clearDriveCursor(driveId: string | null): Promise<void> {
	if (!isTauri()) return;
	const store = await stateStore();
	await store.delete(driveCursorKey(driveId));
	await store.save();
}

export async function requestSyncRun(id?: string): Promise<void> {
	await emitAppEvent(APP_EVENTS.syncRun, { id: id ?? null });
}
