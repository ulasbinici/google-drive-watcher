import { isTauri } from '$lib/native';
import type { ChangeType, DriveNotification, NotificationView } from '$lib/types';

/** Local-only pin and note for one notification. Snapshot is stored only while pinned. */
export interface NotificationMetaEntry {
	pinned: boolean;
	note: string;
	snapshot?: DriveNotification;
}

const STORE_FILE = 'notification-meta.json';
const LOCAL_PREFIX = 'drive-watch-notification-meta:';
const CHANGE_TYPES = new Set<ChangeType>([
	'created',
	'modified',
	'deleted',
	'moved',
	'renamed',
	'shared'
]);

type Store = import('@tauri-apps/plugin-store').Store;

let storeHandle: Promise<Store> | null = null;
let pending: Promise<void> = Promise.resolve();

function isMetaUid(uid: string): boolean {
	return uid.length > 0 && uid.length <= 128 && !/[\u0000-\u001f]/.test(uid);
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
	const run = pending.then(task, task);
	pending = run.then(
		() => undefined,
		() => undefined
	);
	return run;
}

function isMissingFile(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes('os error 2') || /not found/i.test(message);
}

async function openStore(): Promise<Store> {
	storeHandle ??= import('@tauri-apps/plugin-store')
		.then(({ load }) => load(STORE_FILE, { autoSave: false, defaults: {} }))
		.catch((error: unknown) => {
			storeHandle = null;
			throw error;
		});
	return storeHandle;
}

function localKey(uid: string): string {
	return LOCAL_PREFIX + encodeURIComponent(uid);
}

/** Plain Drive record safe to keep in the local snapshot. */
export function notificationSnapshot(item: DriveNotification): DriveNotification {
	return {
		id: item.id,
		fileId: item.fileId,
		fileName: item.fileName,
		mimeType: item.mimeType,
		folderId: item.folderId,
		folderName: item.folderName,
		driveName: item.driveName,
		changeType: CHANGE_TYPES.has(item.changeType) ? item.changeType : 'modified',
		actorName: typeof item.actorName === 'string' ? item.actorName : null,
		ownerName: typeof item.ownerName === 'string' ? item.ownerName : null,
		occurredAt: typeof item.occurredAt === 'string' ? item.occurredAt : '',
		read: item.read === true,
		webViewLink: typeof item.webViewLink === 'string' ? item.webViewLink : null
	};
}

export function sameNotificationSnapshot(
	left: DriveNotification | undefined,
	right: DriveNotification
): boolean {
	if (!left) return false;
	const keys = Object.keys(right) as (keyof DriveNotification)[];
	return keys.every((key) => left[key] === right[key]);
}

function snapshotFrom(id: string, value: unknown): DriveNotification | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const raw = value as Partial<DriveNotification>;
	if (raw.id !== id || typeof raw.occurredAt !== 'string' || !raw.occurredAt) return undefined;
	const changeType = CHANGE_TYPES.has(raw.changeType as ChangeType)
		? (raw.changeType as ChangeType)
		: 'modified';
	return notificationSnapshot({
		id,
		fileId: typeof raw.fileId === 'string' ? raw.fileId : '',
		fileName: typeof raw.fileName === 'string' ? raw.fileName : 'Untitled',
		mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : '',
		folderId: typeof raw.folderId === 'string' ? raw.folderId : '',
		folderName: typeof raw.folderName === 'string' ? raw.folderName : '',
		driveName: typeof raw.driveName === 'string' ? raw.driveName : '',
		changeType,
		actorName: typeof raw.actorName === 'string' ? raw.actorName : null,
		ownerName: typeof raw.ownerName === 'string' ? raw.ownerName : null,
		occurredAt: raw.occurredAt,
		read: raw.read === true,
		webViewLink: typeof raw.webViewLink === 'string' ? raw.webViewLink : null
	});
}

function normalizeEntry(id: string, value: unknown): NotificationMetaEntry | undefined {
	if (!id || !value || typeof value !== 'object') return undefined;
	const raw = value as Partial<NotificationMetaEntry>;
	const note = typeof raw.note === 'string' ? raw.note.trim() : '';
	const pinned = raw.pinned === true;
	if (!pinned) return note ? { pinned: false, note } : undefined;
	const snapshot = snapshotFrom(id, raw.snapshot);
	if (!snapshot) return note ? { pinned: false, note } : undefined;
	return { pinned: true, note, snapshot };
}

/** Drops empty notes and keeps a snapshot only on pinned entries. */
export function normalizeNotificationMeta(value: unknown): Record<string, NotificationMetaEntry> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	const out: Record<string, NotificationMetaEntry> = {};
	for (const [id, raw] of Object.entries(value)) {
		const entry = normalizeEntry(id, raw);
		if (entry) out[id] = entry;
	}
	return out;
}

async function readRaw(uid: string): Promise<unknown> {
	if (!isTauri()) {
		if (typeof localStorage === 'undefined') return null;
		const raw = localStorage.getItem(localKey(uid));
		if (!raw) return null;
		try {
			return JSON.parse(raw) as unknown;
		} catch {
			return null;
		}
	}
	const store = await openStore();
	await store.reload().catch((error: unknown) => {
		if (!isMissingFile(error)) throw error;
	});
	return (await store.get<unknown>(uid)) ?? null;
}

async function writeRaw(uid: string, value: Record<string, NotificationMetaEntry>): Promise<void> {
	if (!isTauri()) {
		if (typeof localStorage === 'undefined') return;
		if (Object.keys(value).length === 0) localStorage.removeItem(localKey(uid));
		else localStorage.setItem(localKey(uid), JSON.stringify(value));
		return;
	}
	const store = await openStore();
	await store.set(uid, value);
	await store.save();
}

export function loadNotificationMeta(uid: string): Promise<Record<string, NotificationMetaEntry>> {
	if (!isMetaUid(uid)) return Promise.resolve({});
	return enqueue(async () => normalizeNotificationMeta(await readRaw(uid)));
}

export function saveNotificationMeta(
	uid: string,
	entries: Record<string, NotificationMetaEntry>
): Promise<void> {
	if (!isMetaUid(uid)) return Promise.resolve();
	const cleaned = normalizeNotificationMeta(entries);
	return enqueue(() => writeRaw(uid, cleaned));
}

function occurredAtMs(value: string): number {
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : 0;
}

function compareNotifications(a: DriveNotification, b: DriveNotification): number {
	const byTime = occurredAtMs(b.occurredAt) - occurredAtMs(a.occurredAt);
	if (byTime !== 0) return byTime;
	if (a.id === b.id) return 0;
	return a.id < b.id ? 1 : -1;
}

/**
 * Merges a server or live list with local metadata.
 * Pinned snapshots missing from `incoming` stay in the result.
 * The limit applies to unpinned rows only, and the whole list is ordered by occurredAt desc.
 */
export function mergeNotifications(
	incoming: DriveNotification[],
	meta: Record<string, NotificationMetaEntry>,
	limit: number
): NotificationView[] {
	const byId = new Map<string, DriveNotification>();
	for (const [id, entry] of Object.entries(meta)) {
		if (entry.pinned && entry.snapshot) byId.set(id, entry.snapshot);
	}
	for (const item of incoming) {
		if (!item.id) continue;
		byId.set(item.id, notificationSnapshot(item));
	}

	const sorted = [...byId.values()].sort(compareNotifications);
	const kept: NotificationView[] = [];
	let unpinned = 0;
	for (const item of sorted) {
		const entry = meta[item.id];
		const pinned = entry?.pinned === true;
		if (!pinned) {
			if (unpinned >= limit) continue;
			unpinned += 1;
		}
		kept.push({
			...item,
			pinned,
			note: entry?.note ?? ''
		});
	}
	return kept;
}
