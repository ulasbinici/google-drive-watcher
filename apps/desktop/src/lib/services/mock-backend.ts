import type {
	ChangeType,
	DriveFolder,
	DriveNotification,
	DriveRoot,
	MonitoringSettings,
	SyncStatus,
	UserProfile,
	WatchChannel,
	WatchedFolder
} from '$lib/types';
import type { DriveNotifierBackend, RequestOptions, Unsubscribe } from './backend';
import { notifyNative } from './native-notify';

interface SeedFolder {
	name: string;
	children?: SeedFolder[];
	/** Simulates a permission error when listing children. */
	restricted?: boolean;
}

interface SeedDrive {
	drive: DriveRoot;
	folders: SeedFolder[];
}

const SEED: SeedDrive[] = [
	{
		drive: { id: 'my-drive', name: 'My Drive', kind: 'my-drive' },
		folders: [
			{
				name: 'Projects',
				children: [
					{ name: 'Q4 Launch', children: [{ name: 'Assets' }, { name: 'Copy drafts' }] },
					{ name: 'Design reviews' },
					{
						name: 'Engineering',
						children: [{ name: 'Specs' }, { name: 'Release notes' }, { name: 'Postmortems' }]
					}
				]
			},
			{ name: 'Finance', children: [{ name: 'Invoices 2026' }, { name: 'Receipts' }, { name: 'Taxes' }] },
			{ name: 'Photos', children: [{ name: 'Team offsite' }] },
			{ name: 'Archive (restricted)', restricted: true, children: [{ name: 'Old' }] },
			{ name: 'Scratch' }
		]
	},
	{
		drive: { id: 'sd-marketing', name: 'Marketing Team', kind: 'shared-drive' },
		folders: [
			{ name: 'Campaigns', children: [{ name: 'Fall 2026' }, { name: 'Holiday 2026' }] },
			{ name: 'Brand assets', children: [{ name: 'Logos' }, { name: 'Templates' }] },
			{ name: 'Reports' }
		]
	},
	{
		drive: { id: 'sd-engineering', name: 'Engineering', kind: 'shared-drive' },
		folders: [
			{ name: 'RFCs', children: [{ name: 'Accepted' }, { name: 'Drafts' }] },
			{ name: 'Incident reports' },
			{ name: 'On-call', children: [{ name: 'Runbooks' }] }
		]
	},
	{
		drive: { id: 'sd-legal', name: 'Legal', kind: 'shared-drive' },
		folders: [{ name: 'Contracts', children: [{ name: 'Vendors' }, { name: 'Customers' }] }]
	}
];

const DEMO_USER: UserProfile = {
	uid: 'dev-user-1',
	email: 'alex.morgan@example.com',
	displayName: 'Alex Morgan',
	photoUrl: null
};

const ACTORS = ['Priya Shah', 'Jordan Lee', 'Sam Okafor', 'Mia Chen', null];
const CHANGE_TYPES: ChangeType[] = ['created', 'modified', 'modified', 'renamed', 'moved', 'shared', 'deleted'];
const FILES = [
	{ name: 'Roadmap.gdoc', mimeType: 'application/vnd.google-apps.document' },
	{ name: 'Budget forecast.gsheet', mimeType: 'application/vnd.google-apps.spreadsheet' },
	{ name: 'Kickoff deck.gslides', mimeType: 'application/vnd.google-apps.presentation' },
	{ name: 'hero-banner.png', mimeType: 'image/png' },
	{ name: 'contract-v3.pdf', mimeType: 'application/pdf' },
	{ name: 'meeting-notes.md', mimeType: 'text/markdown' }
];

const LATENCY_MS = { min: 250, max: 700 };
const NOTIFICATION_INTERVAL_MS = 20_000;
const CHANNEL_TTL_MS = 6 * 24 * 60 * 60 * 1000;

interface IndexedFolder {
	folder: DriveFolder;
	restricted: boolean;
}

function slug(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
}

function childKey(driveId: string, parentId: string | null) {
	return `${driveId}/${parentId ?? ''}`;
}

function buildIndex() {
	const folders = new Map<string, IndexedFolder>();
	const children = new Map<string, string[]>();

	function visit(drive: DriveRoot, nodes: SeedFolder[], parent: DriveFolder | null) {
		const ids: string[] = [];
		for (const node of nodes) {
			const id = parent ? `${parent.id}.${slug(node.name)}` : `${drive.id}.${slug(node.name)}`;
			const folder: DriveFolder = {
				id,
				name: node.name,
				driveId: drive.id,
				driveName: drive.name,
				driveKind: drive.kind,
				parentId: parent?.id ?? null,
				path: parent ? [...parent.path, parent.name] : [],
				hasChildren: (node.children?.length ?? 0) > 0
			};
			folders.set(id, { folder, restricted: node.restricted ?? false });
			ids.push(id);
			if (node.children) visit(drive, node.children, folder);
		}
		children.set(childKey(drive.id, parent?.id ?? null), ids);
	}

	for (const { drive, folders: nodes } of SEED) visit(drive, nodes, null);
	return { folders, children };
}

function delay(ms: number, signal?: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true }
		);
	});
}

function latency(signal?: AbortSignal) {
	return delay(LATENCY_MS.min + Math.random() * (LATENCY_MS.max - LATENCY_MS.min), signal);
}

function pick<T>(items: readonly T[]): T {
	return items[Math.floor(Math.random() * items.length)];
}

class Emitter<T> {
	#listeners = new Set<(value: T) => void>();

	get size() {
		return this.#listeners.size;
	}

	on(listener: (value: T) => void): Unsubscribe {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	emit(value: T) {
		for (const listener of this.#listeners) listener(value);
	}
}

/**
 * In-memory development adapter. Simulates network latency, a restricted folder,
 * push channels per drive and periodic change notifications.
 */
export function createMockBackend(): DriveNotifierBackend {
	const index = buildIndex();
	const drives = SEED.map((s) => s.drive);

	let user: UserProfile | null = null;
	let allowFileEdits = false;
	let watched: WatchedFolder[] = [];
	let monitoring: MonitoringSettings = { paused: false, updatedAt: new Date().toISOString() };
	let channels: WatchChannel[] = [];
	let lastSyncAt: string | null = null;
	let syncing = false;
	let notifications: DriveNotification[] = [];
	let ticker: ReturnType<typeof setInterval> | undefined;

	const authChanged = new Emitter<UserProfile | null>();
	const syncChanged = new Emitter<SyncStatus>();
	const notified = new Emitter<DriveNotification>();

	function requireUser() {
		if (!user) throw new Error('You are signed out. Sign in with Google to continue.');
	}

	function syncStatus(): SyncStatus {
		return {
			state: syncing ? 'syncing' : monitoring.paused ? 'paused' : 'idle',
			lastSyncAt,
			error: null,
			channels: channels.map((c) => ({ ...c }))
		};
	}

	function rebuildChannels() {
		const now = Date.now();
		const byDrive = new Map<string, WatchedFolder>();
		for (const folder of watched) byDrive.set(folder.driveId, folder);
		channels = [...byDrive.values()].map((folder) => {
			const existing = channels.find((c) => c.driveId === folder.driveId);
			return (
				existing ?? {
					id: `channel-${folder.driveId}`,
					driveId: folder.driveId,
					driveName: folder.driveName,
					state: 'active',
					expiresAt: new Date(now + CHANNEL_TTL_MS).toISOString(),
					lastEventAt: null,
					error: null
				}
			);
		});
	}

	function makeNotification(folder: DriveFolder, occurredAt: Date): DriveNotification {
		const file = pick(FILES);
		return {
			id: crypto.randomUUID(),
			fileId: `file-${crypto.randomUUID().slice(0, 8)}`,
			fileName: file.name,
			mimeType: file.mimeType,
			folderId: folder.id,
			folderName: folder.name,
			driveName: folder.driveName,
			changeType: pick(CHANGE_TYPES),
			actorName: pick(ACTORS),
			ownerName: pick(ACTORS),
			occurredAt: occurredAt.toISOString(),
			read: false,
			webViewLink: null
		};
	}

	function seedSession() {
		const initial = ['my-drive.projects', 'my-drive.projects.q4-launch', 'sd-marketing.campaigns'];
		const now = new Date().toISOString();
		watched = initial
			.map((id) => index.folders.get(id)?.folder)
			.filter((f): f is DriveFolder => f !== undefined)
			.map((folder) => ({ ...folder, addedAt: now }));
		rebuildChannels();
		lastSyncAt = new Date(Date.now() - 4 * 60 * 1000).toISOString();
		notifications = Array.from({ length: 6 }, (_, i) =>
			makeNotification(pick(watched), new Date(Date.now() - (i + 1) * 37 * 60 * 1000))
		);
		notifications.slice(3).forEach((n) => (n.read = true));
	}

	function startTicker() {
		if (ticker) return;
		ticker = setInterval(() => {
			if (!user || monitoring.paused || watched.length === 0) return;
			const notification = makeNotification(pick(watched), new Date());
			notifications = [notification, ...notifications].slice(0, 100);
			const folder = watched.find((f) => f.id === notification.folderId);
			channels = channels.map((c) =>
				c.driveId === folder?.driveId ? { ...c, lastEventAt: notification.occurredAt } : c
			);
			notified.emit({ ...notification });
			void notifyNative(`${notification.changeType}: ${notification.fileName}`, notification.folderName);
			syncChanged.emit(syncStatus());
		}, NOTIFICATION_INTERVAL_MS);
	}

	function stopTicker() {
		clearInterval(ticker);
		ticker = undefined;
	}

	return {
		name: 'Mock (dev)',

		auth: {
			async getCurrentUser() {
				await latency();
				return user ? { ...user } : null;
			},
			async fileEditsAllowed() {
				await latency();
				requireUser();
				return allowFileEdits;
			},
			async setFileEdits(enabled) {
				await latency();
				requireUser();
				allowFileEdits = enabled;
			},
			async signIn(options) {
				await delay(900);
				user = { ...DEMO_USER };
				if (options?.write) allowFileEdits = true;
				seedSession();
				authChanged.emit({ ...user });
				return { ...user };
			},
			async signOut() {
				await latency();
				user = null;
				allowFileEdits = false;
				watched = [];
				channels = [];
				notifications = [];
				stopTicker();
				authChanged.emit(null);
			},
			onAuthChanged(listener) {
				return authChanged.on(listener);
			}
		},

		drive: {
			async listDrives(options?: RequestOptions) {
				await latency(options?.signal);
				requireUser();
				return drives.map((d) => ({ ...d }));
			},
			async listChildFolders(driveId, parentId, options?: RequestOptions) {
				await latency(options?.signal);
				requireUser();
				if (parentId && index.folders.get(parentId)?.restricted) {
					throw new Error("You don't have permission to list this folder's contents.");
				}
				const ids = index.children.get(childKey(driveId, parentId)) ?? [];
				return ids.map((id) => ({ ...index.folders.get(id)!.folder }));
			},
			async searchFolders(query, options?: RequestOptions) {
				await latency(options?.signal);
				requireUser();
				const needle = query.trim().toLowerCase();
				if (!needle) return [];
				return [...index.folders.values()]
					.filter(({ folder }) => folder.name.toLowerCase().includes(needle))
					.slice(0, 50)
					.map(({ folder }) => ({ ...folder }));
			}
		},

		watch: {
			async getWatchedFolders() {
				await latency();
				requireUser();
				return watched.map((f) => ({ ...f }));
			},
			async setWatchedFolders(folders) {
				await delay(800);
				requireUser();
				const now = new Date().toISOString();
				watched = folders.map((folder) => ({
					...folder,
					addedAt: watched.find((w) => w.id === folder.id)?.addedAt ?? now
				}));
				rebuildChannels();
				syncChanged.emit(syncStatus());
				return watched.map((f) => ({ ...f }));
			},
			async getMonitoring() {
				await latency();
				requireUser();
				return { ...monitoring };
			},
			async setMonitoringPaused(paused) {
				await latency();
				requireUser();
				monitoring = { paused, updatedAt: new Date().toISOString() };
				syncChanged.emit(syncStatus());
				return { ...monitoring };
			},
			async getSyncStatus() {
				await latency();
				requireUser();
				return syncStatus();
			},
			async requestSync() {
				requireUser();
				syncing = true;
				syncChanged.emit(syncStatus());
				await delay(1200);
				syncing = false;
				lastSyncAt = new Date().toISOString();
				const status = syncStatus();
				syncChanged.emit(status);
				return status;
			},
			onSyncStatus(listener) {
				return syncChanged.on(listener);
			}
		},

		notifications: {
			async listRecent(limit) {
				await latency();
				requireUser();
				return notifications.slice(0, limit).map((n) => ({ ...n }));
			},
			async markRead(ids) {
				const set = new Set(ids);
				notifications = notifications.map((n) => (set.has(n.id) ? { ...n, read: true } : n));
			},
			async markAllRead() {
				notifications = notifications.map((n) => ({ ...n, read: true }));
			},
			async clearRead() {
				notifications = notifications.filter((n) => !n.read);
			},
			onNotification(listener) {
				const off = notified.on(listener);
				startTicker();
				return () => {
					off();
					if (notified.size === 0) stopTicker();
				};
			}
		}
	};
}
