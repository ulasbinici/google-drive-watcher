import { createContext } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { invalidateDriveToken } from '$lib/drive/drive-api';
import { errorMessage } from '$lib/format';
import { APP_EVENTS, emitAppEvent, openBrowseWindow, setTrayMonitoring, setTrayShortcuts } from '$lib/native';
import { requestIncrementalSync } from '$lib/sync/sync-store';
import type { DriveNotifierBackend, Unsubscribe } from '$lib/services';
import {
	loadNotificationMeta,
	mergeNotifications,
	notificationSnapshot,
	sameNotificationSnapshot,
	saveNotificationMeta,
	type NotificationMetaEntry
} from '$lib/state/notification-meta';
import {
	listenFolderShortcuts,
	loadFolderShortcuts,
	removeFolderShortcut,
	setShortcutInTray,
	stageShortcutOpen,
	type FolderShortcut
} from '$lib/state/folder-shortcuts';
import type {
	AuthStatus,
	DriveFolder,
	DriveNotification,
	DriveRoot,
	Loadable,
	MonitoringSettings,
	NotificationView,
	SyncStatus,
	UserProfile,
	WatchedFolder
} from '$lib/types';

const SEARCH_DEBOUNCE_MS = 250;
const NOTIFICATION_LIMIT = 50;
const CLOCK_INTERVAL_MS = 30_000;

export function branchKey(driveId: string, parentId: string | null) {
	return `${driveId}/${parentId ?? 'root'}`;
}

export function driveNodeKey(driveId: string) {
	return `drive:${driveId}`;
}

function dataOf<T>(value: Loadable<T>): T | undefined {
	return value.status === 'idle' ? undefined : value.data;
}

export class AppState {
	readonly backend: DriveNotifierBackend;
	#sessionCleanup: Unsubscribe[] = [];
	#searchTimer: ReturnType<typeof setTimeout> | undefined;
	#searchAbort: AbortController | undefined;
	#branchAborts = new SvelteMap<string, AbortController>();

	authStatus = $state<AuthStatus>('initializing');
	user = $state<UserProfile | null>(null);
	authError = $state<string | null>(null);
	allowFileEdits = $state(false);
	settingsOpen = $state(false);
	settingsBusy = $state(false);
	settingsError = $state<string | null>(null);

	drives = $state<Loadable<DriveRoot[]>>({ status: 'idle' });
	readonly branches = new SvelteMap<string, Loadable<DriveFolder[]>>();
	readonly expanded = new SvelteSet<string>();

	searchQuery = $state('');
	searchResults = $state<Loadable<DriveFolder[]>>({ status: 'idle' });

	readonly selection = new SvelteMap<string, DriveFolder>();
	watched = $state<Loadable<WatchedFolder[]>>({ status: 'idle' });
	saving = $state(false);
	saveError = $state<string | null>(null);

	monitoring = $state<Loadable<MonitoringSettings>>({ status: 'idle' });
	monitoringBusy = $state(false);
	monitoringError = $state<string | null>(null);

	sync = $state<Loadable<SyncStatus>>({ status: 'idle' });
	syncError = $state<string | null>(null);

	notifications = $state<Loadable<NotificationView[]>>({ status: 'idle' });
	shortcuts = $state<FolderShortcut[]>([]);
	#meta: Record<string, NotificationMetaEntry> = {};
	#metaUid: string | null = null;
	#metaReady = false;
	/** Ids that came from the server list or a live event. Snapshot-only pins are not included. */
	#liveIds = new SvelteSet<string>();

	now = $state(Date.now());
	/** Live notification listener, native toasts, and incremental sync. Folders leaves this off. */
	#listenNotifications = true;

	myDrives = $derived((dataOf(this.drives) ?? []).filter((d) => d.kind === 'my-drive'));
	sharedWithMe = $derived((dataOf(this.drives) ?? []).filter((d) => d.kind === 'shared-with-me'));
	sharedDrives = $derived((dataOf(this.drives) ?? []).filter((d) => d.kind === 'shared-drive'));

	watchedIds = $derived(new SvelteSet((dataOf(this.watched) ?? []).map((f) => f.id)));

	isDirty = $derived.by(() => {
		if (this.watched.status !== 'ready') return false;
		if (this.selection.size !== this.watchedIds.size) return true;
		for (const id of this.selection.keys()) if (!this.watchedIds.has(id)) return true;
		return false;
	});

	isPaused = $derived(dataOf(this.monitoring)?.paused ?? false);

	unreadCount = $derived((dataOf(this.notifications) ?? []).filter((n) => !n.read).length);

	constructor(backend: DriveNotifierBackend) {
		this.backend = backend;
	}

	/**
	 * Wires up subscriptions and returns a teardown function.
	 * `notifications: false` skips the live listener, so this window does not
	 * raise native toasts or request incremental sync. Auth, folders, and watch state still load.
	 */
	start(options?: { notifications?: boolean }): Unsubscribe {
		this.#listenNotifications = options?.notifications !== false;
		const offAuth = this.backend.auth.onAuthChanged((user) => this.#applyUser(user));
		const clock = setInterval(() => (this.now = Date.now()), CLOCK_INTERVAL_MS);

		this.backend.auth
			.getCurrentUser()
			.then((user) => this.#applyUser(user))
			.catch((error) => {
				this.authError = errorMessage(error);
				this.authStatus = 'signed-out';
			});

		return () => {
			offAuth();
			clearInterval(clock);
			this.#endSession();
		};
	}

	// ---- Auth ---------------------------------------------------------------

	async signIn() {
		if (this.authStatus === 'signing-in') return;
		this.authStatus = 'signing-in';
		this.authError = null;
		try {
			this.#applyUser(await this.backend.auth.signIn());
		} catch (error) {
			this.authError = errorMessage(error);
			this.authStatus = 'signed-out';
		}
	}

	async signOut() {
		this.authStatus = 'signing-out';
		this.authError = null;
		try {
			await this.backend.auth.signOut();
			this.#applyUser(null);
		} catch (error) {
			this.authError = errorMessage(error);
			this.authStatus = 'signed-in';
		}
	}

	#applyUser(user: UserProfile | null) {
		if (user) {
			if (this.authStatus === 'signed-in' && this.user?.uid === user.uid) return;
			this.user = user;
			this.authStatus = 'signed-in';
			this.#beginSession();
		} else {
			if (this.authStatus === 'signed-out') return;
			this.#endSession();
			this.user = null;
			this.authStatus = 'signed-out';
		}
	}

	#beginSession() {
		this.#endSession();
		const cleanup: Unsubscribe[] = [
			this.backend.watch.onSyncStatus((status) => {
				this.sync = { status: 'ready', data: status };
			})
		];
		if (this.#listenNotifications) {
			cleanup.push(
				this.backend.notifications.onNotification((notification) => this.#receive(notification))
			);
		}
		this.#sessionCleanup.push(...cleanup);
		void this.loadDrives();
		void this.loadFileEdits();
		void this.loadWatched();
		void this.loadMonitoring();
		void this.loadSync();
		if (this.#listenNotifications) void this.loadNotifications();
		this.#sessionCleanup.push(listenFolderShortcuts(() => void this.loadShortcuts()));
		void this.loadShortcuts();
	}

	#endSession() {
		for (const off of this.#sessionCleanup) off();
		this.#sessionCleanup = [];
		clearTimeout(this.#searchTimer);
		this.#searchAbort?.abort();
		for (const controller of this.#branchAborts.values()) controller.abort();
		this.#branchAborts.clear();

		this.drives = { status: 'idle' };
		this.branches.clear();
		this.expanded.clear();
		this.searchQuery = '';
		this.searchResults = { status: 'idle' };
		this.selection.clear();
		this.watched = { status: 'idle' };
		this.saving = false;
		this.saveError = null;
		this.monitoring = { status: 'idle' };
		this.monitoringError = null;
		this.sync = { status: 'idle' };
		this.syncError = null;
		this.notifications = { status: 'idle' };
		this.shortcuts = [];
		void setTrayShortcuts([]);
		this.#meta = {};
		this.#metaUid = null;
		this.#metaReady = false;
		this.#liveIds.clear();
		this.allowFileEdits = false;
		this.settingsOpen = false;
		this.settingsBusy = false;
		this.settingsError = null;
	}

	async loadFileEdits() {
		try {
			this.allowFileEdits = await this.backend.auth.fileEditsAllowed();
		} catch (error) {
			this.settingsError = errorMessage(error);
		}
	}

	async setFileEdits(enabled: boolean) {
		if (this.settingsBusy) return;
		this.settingsBusy = true;
		this.settingsError = null;
		try {
			if (enabled) {
				await this.backend.auth.signIn({ write: true });
				this.allowFileEdits = await this.backend.auth.fileEditsAllowed();
				if (!this.allowFileEdits) {
					throw new Error('Google did not grant permission to upload and edit files.');
				}
			} else {
				await this.backend.auth.setFileEdits(false);
				this.allowFileEdits = false;
			}
		} catch (error) {
			this.settingsError = errorMessage(error);
			this.allowFileEdits = await this.backend.auth.fileEditsAllowed().catch(() => this.allowFileEdits);
		} finally {
			this.settingsBusy = false;
			invalidateDriveToken();
			void emitAppEvent(APP_EVENTS.fileEditsChanged, this.allowFileEdits);
		}
	}

	// ---- Folder tree --------------------------------------------------------

	async loadDrives() {
		this.drives = { status: 'loading', data: dataOf(this.drives) };
		try {
			this.drives = { status: 'ready', data: await this.backend.drive.listDrives() };
		} catch (error) {
			this.drives = { status: 'error', error: errorMessage(error) };
		}
	}

	async refreshFolders() {
		const loaded = [...this.branches.keys()].map((key) => {
			const [driveId, parentId] = key.split('/') as [string, string];
			return { driveId, parentId: parentId === 'root' ? null : parentId };
		});
		await Promise.all([
			this.loadDrives(),
			...loaded.map(({ driveId, parentId }) => this.loadBranch(driveId, parentId))
		]);
	}

	isExpanded(nodeKey: string) {
		return this.expanded.has(nodeKey);
	}

	toggleExpanded(nodeKey: string, driveId: string, parentId: string | null) {
		if (this.expanded.has(nodeKey)) {
			this.expanded.delete(nodeKey);
			return;
		}
		this.expanded.add(nodeKey);
		const branch = this.branches.get(branchKey(driveId, parentId));
		if (!branch || branch.status === 'error') void this.loadBranch(driveId, parentId);
	}

	branch(driveId: string, parentId: string | null): Loadable<DriveFolder[]> {
		return this.branches.get(branchKey(driveId, parentId)) ?? { status: 'idle' };
	}

	async loadBranch(driveId: string, parentId: string | null) {
		const key = branchKey(driveId, parentId);
		this.#branchAborts.get(key)?.abort();
		const controller = new AbortController();
		this.#branchAborts.set(key, controller);

		this.branches.set(key, { status: 'loading' });
		try {
			const data = await this.backend.drive.listChildFolders(driveId, parentId, {
				signal: controller.signal
			});
			this.branches.set(key, { status: 'ready', data });
		} catch (error) {
			if (controller.signal.aborted) return;
			this.branches.set(key, { status: 'error', error: errorMessage(error) });
		} finally {
			if (this.#branchAborts.get(key) === controller) this.#branchAborts.delete(key);
		}
	}

	// ---- Search -------------------------------------------------------------

	setSearchQuery(query: string) {
		this.searchQuery = query;
		clearTimeout(this.#searchTimer);
		this.#searchAbort?.abort();

		if (!query.trim()) {
			this.searchResults = { status: 'idle' };
			return;
		}
		this.searchResults = { status: 'loading', data: dataOf(this.searchResults) };
		this.#searchTimer = setTimeout(() => void this.#runSearch(query), SEARCH_DEBOUNCE_MS);
	}

	retrySearch() {
		this.setSearchQuery(this.searchQuery);
	}

	async #runSearch(query: string) {
		const controller = new AbortController();
		this.#searchAbort = controller;
		try {
			const data = await this.backend.drive.searchFolders(query, { signal: controller.signal });
			if (!controller.signal.aborted) this.searchResults = { status: 'ready', data };
		} catch (error) {
			if (!controller.signal.aborted) {
				this.searchResults = { status: 'error', error: errorMessage(error) };
			}
		}
	}

	// ---- Selection / watch list --------------------------------------------

	isSelected(folderId: string) {
		return this.selection.has(folderId);
	}

	toggleSelected(folder: DriveFolder) {
		if (this.selection.has(folder.id)) this.selection.delete(folder.id);
		else this.selection.set(folder.id, folder);
	}

	removeSelected(folderId: string) {
		this.selection.delete(folderId);
	}

	clearSelection() {
		this.selection.clear();
	}

	discardChanges() {
		this.selection.clear();
		for (const folder of dataOf(this.watched) ?? []) this.selection.set(folder.id, folder);
		this.saveError = null;
	}

	async loadWatched() {
		this.watched = { status: 'loading', data: dataOf(this.watched) };
		try {
			this.watched = { status: 'ready', data: await this.backend.watch.getWatchedFolders() };
			this.discardChanges();
		} catch (error) {
			this.watched = { status: 'error', error: errorMessage(error) };
		}
	}

	async saveSelection() {
		if (this.saving) return;
		this.saving = true;
		this.saveError = null;
		try {
			const data = await this.backend.watch.setWatchedFolders([...this.selection.values()]);
			this.watched = { status: 'ready', data };
			this.discardChanges();
		} catch (error) {
			this.saveError = errorMessage(error);
		} finally {
			this.saving = false;
		}
	}

	// ---- Monitoring & sync --------------------------------------------------

	async loadMonitoring() {
		this.monitoring = { status: 'loading', data: dataOf(this.monitoring) };
		try {
			this.monitoring = { status: 'ready', data: await this.backend.watch.getMonitoring() };
			await setTrayMonitoring(this.monitoring.data?.paused === true);
		} catch (error) {
			this.monitoring = { status: 'error', error: errorMessage(error) };
		}
	}

	async setPaused(paused: boolean) {
		if (this.monitoringBusy) return;
		this.monitoringBusy = true;
		this.monitoringError = null;
		try {
			this.monitoring = {
				status: 'ready',
				data: await this.backend.watch.setMonitoringPaused(paused)
			};
			await setTrayMonitoring(paused);
		} catch (error) {
			this.monitoringError = errorMessage(error);
		} finally {
			this.monitoringBusy = false;
		}
	}

	async loadSync() {
		this.sync = { status: 'loading', data: dataOf(this.sync) };
		try {
			this.sync = { status: 'ready', data: await this.backend.watch.getSyncStatus() };
		} catch (error) {
			this.sync = { status: 'error', error: errorMessage(error) };
		}
	}

	async requestSync() {
		this.syncError = null;
		try {
			this.sync = { status: 'ready', data: await this.backend.watch.requestSync() };
		} catch (error) {
			this.syncError = errorMessage(error);
		}
	}

	// ---- Notifications ------------------------------------------------------

	async #ensureMeta() {
		const uid = this.user?.uid;
		if (!uid) return;
		if (this.#metaReady && this.#metaUid === uid) return;
		try {
			const loaded = await loadNotificationMeta(uid);
			if (this.user?.uid !== uid || (this.#metaReady && this.#metaUid === uid)) return;
			this.#meta = loaded;
			this.#metaUid = uid;
			this.#metaReady = true;
		} catch {
			// Leave metadata unloaded so the next refresh can try again.
		}
	}

	#commitMeta(): Promise<void> {
		const uid = this.#metaUid;
		if (!uid || uid !== this.user?.uid) return Promise.resolve();
		return saveNotificationMeta(uid, this.#meta).catch(() => undefined);
	}

	#publish(incoming: DriveNotification[]) {
		this.notifications = {
			status: 'ready',
			data: mergeNotifications(incoming, this.#meta, NOTIFICATION_LIMIT)
		};
	}

	#liveIncoming(): DriveNotification[] {
		return (dataOf(this.notifications) ?? [])
			.filter((item) => this.#liveIds.has(item.id))
			.map((item) => notificationSnapshot(item));
	}

	#syncPinnedSnapshots() {
		if (this.notifications.status !== 'ready' || this.#metaUid !== this.user?.uid) return;
		let changed = false;
		for (const item of this.notifications.data) {
			if (!item.pinned) continue;
			const snapshot = notificationSnapshot(item);
			const current = this.#meta[item.id];
			if (
				current?.pinned === true &&
				current.note === item.note &&
				sameNotificationSnapshot(current.snapshot, snapshot)
			) {
				continue;
			}
			this.#meta[item.id] = { pinned: true, note: item.note, snapshot };
			changed = true;
		}
		if (changed) void this.#commitMeta();
	}

	async loadShortcuts() {
		const uid = this.user?.uid;
		if (!uid) return;
		const list = await loadFolderShortcuts(uid).catch(() => null);
		if (!list || this.user?.uid !== uid) return;
		this.shortcuts = list;
		await this.#syncTrayShortcuts();
	}

	async setShortcutInTray(id: string, inTray: boolean) {
		const uid = this.user?.uid;
		if (!uid) return;
		this.shortcuts = await setShortcutInTray(uid, id, inTray);
		await this.#syncTrayShortcuts();
	}

	async removeShortcut(id: string) {
		const uid = this.user?.uid;
		if (!uid) return;
		this.shortcuts = await removeFolderShortcut(uid, id);
		await this.#syncTrayShortcuts();
	}

	async #syncTrayShortcuts() {
		await setTrayShortcuts(
			this.shortcuts.filter((shortcut) => shortcut.inTray).map((shortcut) => ({
				id: shortcut.id,
				name: shortcut.name
			}))
		).catch(() => undefined);
	}

	async openShortcut(shortcut: FolderShortcut) {
		const uid = this.user?.uid;
		if (!uid) return;
		await stageShortcutOpen(uid, shortcut.id);
		await openBrowseWindow();
	}

	async loadNotifications() {
		const uid = this.user?.uid ?? null;
		this.notifications = { status: 'loading', data: dataOf(this.notifications) };
		try {
			await this.#ensureMeta();
			const server = await this.backend.notifications.listRecent(NOTIFICATION_LIMIT);
			if ((this.user?.uid ?? null) !== uid) return;
			this.#liveIds = new SvelteSet(server.map((item) => item.id));
			this.#publish(server);
			this.#syncPinnedSnapshots();
		} catch (error) {
			if ((this.user?.uid ?? null) !== uid) return;
			this.notifications = { status: 'error', error: errorMessage(error) };
		}
	}

	#receive(notification: DriveNotification) {
		const current = dataOf(this.notifications) ?? [];
		if (current.some((item) => item.id === notification.id)) return;
		this.#liveIds.add(notification.id);
		this.#publish([notification, ...this.#liveIncoming().filter((item) => item.id !== notification.id)]);
		void requestIncrementalSync();
	}

	#setRead(predicate: (notification: NotificationView) => boolean) {
		if (this.notifications.status !== 'ready') return;
		let changed = false;
		for (const item of this.notifications.data) {
			if (!predicate(item) || item.read) continue;
			item.read = true;
			const entry = this.#meta[item.id];
			if (entry?.pinned) {
				entry.snapshot = notificationSnapshot(item);
				changed = true;
			}
		}
		if (changed) void this.#commitMeta();
	}

	async markRead(id: string) {
		this.#setRead((item) => item.id === id);
		await this.backend.notifications.markRead([id]).catch(() => this.loadNotifications());
	}

	async markAllRead() {
		this.#setRead(() => true);
		await this.backend.notifications.markAllRead().catch(() => this.loadNotifications());
	}

	async clearRead() {
		const current = dataOf(this.notifications);
		if (current) {
			this.notifications = {
				status: 'ready',
				data: current.filter((item) => !item.read || item.pinned)
			};
		}
		await this.backend.notifications.clearRead().catch(() => this.loadNotifications());
	}

	async setNotificationPinned(id: string, pinned: boolean) {
		await this.#ensureMeta();
		if (!this.#metaReady || this.#metaUid !== this.user?.uid) return;
		const item = (dataOf(this.notifications) ?? []).find((entry) => entry.id === id);
		if (!item) return;
		const note = (this.#meta[id]?.note ?? item.note).trim();
		if (pinned) {
			this.#meta[id] = { pinned: true, note, snapshot: notificationSnapshot(item) };
		} else if (note) {
			this.#meta[id] = { pinned: false, note };
		} else {
			delete this.#meta[id];
		}
		this.#publish(this.#liveIncoming());
		await this.#commitMeta();
	}

	async saveNotificationNote(id: string, note: string) {
		await this.#ensureMeta();
		if (!this.#metaReady || this.#metaUid !== this.user?.uid) return;
		const item = (dataOf(this.notifications) ?? []).find((entry) => entry.id === id);
		if (!item) return;
		const trimmed = note.trim();
		const pinned = this.#meta[id]?.pinned === true || item.pinned;
		if (pinned) {
			this.#meta[id] = { pinned: true, note: trimmed, snapshot: notificationSnapshot(item) };
		} else if (trimmed) {
			this.#meta[id] = { pinned: false, note: trimmed };
		} else {
			delete this.#meta[id];
		}
		this.#publish(this.#liveIncoming());
		await this.#commitMeta();
	}
}

export const [getAppState, setAppState] = createContext<AppState>();
