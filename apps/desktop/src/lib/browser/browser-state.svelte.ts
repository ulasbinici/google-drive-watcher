import { createContext } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import {
	createFolder,
	downloadBytes,
	downloadName,
	driveAvailable,
	driveToken,
	getItem,
	invalidateDriveToken,
	listChildren,
	listSharedDrives,
	listSpecial,
	listTree,
	moveItem,
	renameItem,
	restoreItem,
	rootFolderId,
	searchDrive,
	setStarred,
	trashItem,
	uploadBlob,
	type DriveItem,
	type SharedDrive,
	type SpecialView
} from '$lib/drive/drive-api';
import { errorMessage } from '$lib/format';
import {
	APP_EVENTS,
	joinLocalPath,
	listenAppEvent,
	makeLocalDir,
	openExternalUrl,
	pickLocalFolder,
	revealLocalPath,
	safeLocalName,
	writeLocalFile
} from '$lib/native';
import { signedInUser } from '$lib/services/firebase-backend';
import { loadPairs, type SyncPair } from '$lib/sync/sync-store';
import type { Loadable } from '$lib/types';
import type { PickedFile } from './drop';

export type Place =
	| { kind: 'folder'; id: string; driveId: string | null }
	| { kind: SpecialView }
	| { kind: 'search'; query: string };

export interface Crumb {
	id: string;
	name: string;
	place: Place;
}

export type ViewMode = 'list' | 'grid';
export type SortKey = 'name' | 'modified' | 'size' | 'owner';

export type TransferStatus = 'queued' | 'active' | 'done' | 'error' | 'cancelled';

export interface Transfer {
	id: string;
	kind: 'upload' | 'download';
	name: string;
	loaded: number;
	total: number;
	status: TransferStatus;
	error: string | null;
	localPath: string | null;
	run: (transfer: Transfer, signal: AbortSignal) => Promise<void>;
	controller: AbortController;
}

export interface Toast {
	id: number;
	message: string;
	actionLabel?: string;
	action?: () => void;
}

export type Dialog =
	| { kind: 'new-folder' }
	| { kind: 'rename'; item: DriveItem }
	| { kind: 'sync'; item: DriveItem; path: string };

export interface ContextMenuState {
	x: number;
	y: number;
	items: DriveItem[];
}

interface HistoryEntry {
	place: Place;
	crumbs: Crumb[];
	writable: boolean;
}

const PARALLEL_TRANSFERS = 3;
const SEARCH_DEBOUNCE_MS = 300;
const VIEW_KEY = 'drive-watch-browse-view';
const SORT_KEY = 'drive-watch-browse-sort';

const SPECIAL_NAMES: Record<SpecialView, string> = {
	'shared-with-me': 'Shared with me',
	recent: 'Recent',
	starred: 'Starred',
	trash: 'Trash'
};

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
	const value = typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
	return allowed.includes(value as T) ? (value as T) : fallback;
}

export class BrowserState {
	session = $state<'checking' | 'signed-in' | 'signed-out' | 'unavailable'>('checking');
	canEdit = $state(false);
	sharedDrives = $state<SharedDrive[]>([]);

	place = $state<Place>({ kind: 'folder', id: 'root', driveId: null });
	crumbs = $state<Crumb[]>([]);
	/** Whether the current folder accepts new files (false for views like Recent or Trash). */
	writable = $state(true);
	items = $state<Loadable<DriveItem[]>>({ status: 'idle' });

	view = $state<ViewMode>(readPref(VIEW_KEY, ['list', 'grid'] as const, 'list'));
	sortKey = $state<SortKey>(readPref(SORT_KEY, ['name', 'modified', 'size', 'owner'] as const, 'name'));
	sortAscending = $state(true);

	searchText = $state('');
	readonly selection = new SvelteSet<string>();
	anchorId = $state<string | null>(null);

	transfers = $state<Transfer[]>([]);
	toasts = $state<Toast[]>([]);
	menu = $state<ContextMenuState | null>(null);
	/** Folder under the pointer while dragging, or null when dropping into the current folder. */
	dropFolder = $state<DriveItem | null>(null);
	dragging = $state(false);
	dialog = $state<Dialog | null>(null);
	syncPairs = $state<SyncPair[]>([]);

	#back = $state<HistoryEntry[]>([]);
	#forward = $state<HistoryEntry[]>([]);
	#loadAbort: AbortController | undefined;
	#searchTimer: ReturnType<typeof setTimeout> | undefined;
	#toastId = 0;

	canGoBack = $derived(this.#back.length > 0);
	canGoForward = $derived(this.#forward.length > 0);

	sorted = $derived.by(() => {
		const list = this.items.status === 'idle' ? [] : [...(this.items.data ?? [])];
		const direction = this.sortAscending ? 1 : -1;
		const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
		const compare = (a: DriveItem, b: DriveItem) => {
			switch (this.sortKey) {
				case 'modified':
					return (Date.parse(a.modifiedTime ?? '') || 0) - (Date.parse(b.modifiedTime ?? '') || 0);
				case 'size':
					return (a.size ?? -1) - (b.size ?? -1);
				case 'owner':
					return collator.compare(a.ownerName ?? '', b.ownerName ?? '');
				default:
					return collator.compare(a.name, b.name);
			}
		};
		return list.sort((a, b) => {
			if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
			return compare(a, b) * direction || collator.compare(a.name, b.name);
		});
	});

	folders = $derived(this.sorted.filter((item) => item.isFolder));
	files = $derived(this.sorted.filter((item) => !item.isFolder));
	selectedItems = $derived(this.sorted.filter((item) => this.selection.has(item.id)));
	currentFolderId = $derived(this.place.kind === 'folder' ? this.place.id : null);
	canUploadHere = $derived(this.canEdit && this.writable && this.currentFolderId !== null);
	syncedFolderIds = $derived(new Set(this.syncPairs.map((pair) => pair.driveFolderId)));
	activeTransfers = $derived(
		this.transfers.filter((t) => t.status === 'queued' || t.status === 'active').length
	);
	title = $derived(this.crumbs.at(-1)?.name ?? 'Drive');

	start(): () => void {
		void this.#init();
		const offEdits = listenAppEvent(APP_EVENTS.fileEditsChanged, () => {
			invalidateDriveToken();
			void this.refreshAccess();
		});
		const offPairs = listenAppEvent(APP_EVENTS.syncPairsChanged, () => void this.loadSyncPairs());
		return () => {
			offEdits();
			offPairs();
			this.#loadAbort?.abort();
			clearTimeout(this.#searchTimer);
			for (const transfer of this.transfers) transfer.controller.abort();
		};
	}

	async #init() {
		if (!driveAvailable()) {
			this.session = 'unavailable';
			return;
		}
		const user = await signedInUser().catch(() => null);
		if (!user) {
			this.session = 'signed-out';
			return;
		}
		this.session = 'signed-in';
		await this.refreshAccess();
		void this.loadSyncPairs();
		listSharedDrives()
			.then((drives) => (this.sharedDrives = drives))
			.catch(() => undefined);
		this.goMyDrive();
	}

	async refreshAccess() {
		try {
			this.canEdit = (await driveToken()).canEdit;
		} catch (error) {
			this.notify(errorMessage(error));
		}
	}

	async loadSyncPairs() {
		this.syncPairs = await loadPairs().catch(() => this.syncPairs);
	}

	syncPairFor(folderId: string): SyncPair | undefined {
		return this.syncPairs.find((pair) => pair.driveFolderId === folderId);
	}

	// ---- Preferences ----------------------------------------------------------

	setView(view: ViewMode) {
		this.view = view;
		localStorage.setItem(VIEW_KEY, view);
	}

	sortBy(key: SortKey) {
		if (this.sortKey === key) this.sortAscending = !this.sortAscending;
		else {
			this.sortKey = key;
			this.sortAscending = key === 'name' || key === 'owner';
		}
		localStorage.setItem(SORT_KEY, key);
	}

	// ---- Navigation -----------------------------------------------------------

	#navigate(place: Place, crumbs: Crumb[], writable: boolean, record = true) {
		if (record && this.crumbs.length) {
			this.#back = [...this.#back, { place: this.place, crumbs: this.crumbs, writable: this.writable }];
			this.#forward = [];
		}
		this.place = place;
		this.crumbs = crumbs;
		this.writable = writable;
		this.selection.clear();
		this.anchorId = null;
		this.menu = null;
		if (place.kind !== 'search') {
			this.searchText = '';
			clearTimeout(this.#searchTimer);
		}
		void this.load();
	}

	goMyDrive() {
		const place: Place = { kind: 'folder', id: 'root', driveId: null };
		this.#navigate(place, [{ id: 'root', name: 'My Drive', place }], true);
	}

	goSharedDrive(drive: SharedDrive) {
		const place: Place = { kind: 'folder', id: drive.id, driveId: drive.id };
		this.#navigate(place, [{ id: drive.id, name: drive.name, place }], true);
	}

	goSpecial(view: SpecialView) {
		const place: Place = { kind: view };
		this.#navigate(place, [{ id: view, name: SPECIAL_NAMES[view], place }], false);
	}

	goCrumb(index: number) {
		const crumb = this.crumbs[index];
		if (!crumb || index === this.crumbs.length - 1) return;
		this.#navigate(crumb.place, this.crumbs.slice(0, index + 1), crumb.place.kind === 'folder');
	}

	back() {
		const entry = this.#back.at(-1);
		if (!entry) return;
		this.#back = this.#back.slice(0, -1);
		this.#forward = [...this.#forward, { place: this.place, crumbs: this.crumbs, writable: this.writable }];
		this.#navigate(entry.place, entry.crumbs, entry.writable, false);
	}

	forward() {
		const entry = this.#forward.at(-1);
		if (!entry) return;
		this.#forward = this.#forward.slice(0, -1);
		this.#back = [...this.#back, { place: this.place, crumbs: this.crumbs, writable: this.writable }];
		this.#navigate(entry.place, entry.crumbs, entry.writable, false);
	}

	async openFolder(folder: DriveItem) {
		const place: Place = { kind: 'folder', id: folder.id, driveId: folder.driveId };
		const crumb: Crumb = { id: folder.id, name: folder.name, place };
		if (this.place.kind === 'folder') {
			this.#navigate(place, [...this.crumbs, crumb], folder.canAddChildren);
			return;
		}
		const ancestors = await this.#ancestors(folder).catch(() => [] as Crumb[]);
		this.#navigate(place, [...ancestors, crumb], folder.canAddChildren);
	}

	async #ancestors(item: DriveItem): Promise<Crumb[]> {
		const chain: Crumb[] = [];
		const myRoot = await rootFolderId();
		let parentId = item.parents[0];
		while (parentId) {
			if (parentId === myRoot) {
				const place: Place = { kind: 'folder', id: 'root', driveId: null };
				return [{ id: 'root', name: 'My Drive', place }, ...chain];
			}
			if (item.driveId && parentId === item.driveId) {
				const drive = this.sharedDrives.find((d) => d.id === parentId);
				const place: Place = { kind: 'folder', id: parentId, driveId: parentId };
				return [{ id: parentId, name: drive?.name ?? 'Shared drive', place }, ...chain];
			}
			const parent = await getItem(parentId).catch(() => null);
			if (!parent) break;
			const place: Place = { kind: 'folder', id: parent.id, driveId: parent.driveId };
			chain.unshift({ id: parent.id, name: parent.name, place });
			parentId = parent.parents[0];
		}
		const shared: Place = { kind: 'shared-with-me' };
		return [{ id: 'shared-with-me', name: 'Shared with me', place: shared }, ...chain];
	}

	/** Breadcrumb-style location of a folder, used to label sync pairs. */
	locationOf(folder: DriveItem): string {
		const names = this.crumbs.map((c) => c.name);
		if (this.place.kind !== 'folder') return folder.name;
		return [...names, folder.name].join(' / ');
	}

	async load() {
		this.#loadAbort?.abort();
		const controller = new AbortController();
		this.#loadAbort = controller;
		const place = this.place;
		const previous = this.items.status === 'idle' ? undefined : this.items.data;
		this.items = { status: 'loading', data: previous };
		try {
			let data: DriveItem[];
			if (place.kind === 'folder') data = await listChildren(place.id, place.driveId, controller.signal);
			else if (place.kind === 'search') data = await searchDrive(place.query, controller.signal);
			else data = await listSpecial(place.kind, controller.signal);
			if (!controller.signal.aborted) this.items = { status: 'ready', data };
		} catch (error) {
			if (!controller.signal.aborted) this.items = { status: 'error', error: errorMessage(error) };
		}
	}

	setSearch(text: string) {
		this.searchText = text;
		clearTimeout(this.#searchTimer);
		if (!text.trim()) {
			if (this.place.kind === 'search') this.back();
			return;
		}
		this.#searchTimer = setTimeout(() => this.runSearch(), SEARCH_DEBOUNCE_MS);
	}

	runSearch() {
		clearTimeout(this.#searchTimer);
		const query = this.searchText.trim();
		if (!query) return;
		const place: Place = { kind: 'search', query };
		const crumbs = [{ id: 'search', name: `Search results for “${query}”`, place }];
		this.#navigate(place, crumbs, false, this.place.kind !== 'search');
	}

	// ---- Selection ------------------------------------------------------------

	select(item: DriveItem, modifiers: { ctrl: boolean; shift: boolean }) {
		if (modifiers.shift && this.anchorId) {
			const ids = this.sorted.map((i) => i.id);
			const from = ids.indexOf(this.anchorId);
			const to = ids.indexOf(item.id);
			if (from >= 0 && to >= 0) {
				if (!modifiers.ctrl) this.selection.clear();
				for (const id of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) this.selection.add(id);
				return;
			}
		}
		if (modifiers.ctrl) {
			if (this.selection.has(item.id)) this.selection.delete(item.id);
			else this.selection.add(item.id);
		} else {
			this.selection.clear();
			this.selection.add(item.id);
		}
		this.anchorId = item.id;
	}

	ensureSelected(item: DriveItem) {
		if (!this.selection.has(item.id)) this.select(item, { ctrl: false, shift: false });
	}

	selectAll() {
		for (const item of this.sorted) this.selection.add(item.id);
	}

	clearSelection() {
		this.selection.clear();
		this.anchorId = null;
	}

	openContextMenu(event: MouseEvent, item: DriveItem | null) {
		event.preventDefault();
		if (item) this.ensureSelected(item);
		else this.clearSelection();
		this.menu = { x: event.clientX, y: event.clientY, items: item ? this.selectedItems : [] };
	}

	// ---- Opening ----------------------------------------------------------------

	open(item: DriveItem) {
		if (item.isFolder && this.place.kind !== 'trash') void this.openFolder(item);
		else if (item.webViewLink) void openExternalUrl(item.webViewLink);
	}

	openInDrive(item: DriveItem) {
		const url =
			item.webViewLink ??
			(item.isFolder ? `https://drive.google.com/drive/folders/${item.id}` : null);
		if (url) void openExternalUrl(url);
	}

	// ---- Toasts -----------------------------------------------------------------

	notify(message: string, actionLabel?: string, action?: () => void) {
		const toast: Toast = { id: ++this.#toastId, message, actionLabel, action };
		this.toasts = [...this.toasts.slice(-2), toast];
		setTimeout(() => this.dismissToast(toast.id), action ? 8000 : 5000);
	}

	dismissToast(id: number) {
		this.toasts = this.toasts.filter((t) => t.id !== id);
	}

	#requireEdit(): boolean {
		if (this.canEdit) return true;
		this.notify('Turn on “Allow file upload and edit” in Drive Watch Settings first.');
		return false;
	}

	// ---- Changes ----------------------------------------------------------------

	async createFolder(name: string) {
		if (!this.#requireEdit() || !this.currentFolderId) return;
		try {
			await createFolder(name, this.currentFolderId);
			await this.load();
		} catch (error) {
			this.notify(errorMessage(error));
		}
	}

	async rename(item: DriveItem, name: string) {
		if (!this.#requireEdit() || name === item.name) return;
		try {
			await renameItem(item.id, name);
			await this.load();
		} catch (error) {
			this.notify(errorMessage(error));
		}
	}

	async toggleStar(items: DriveItem[]) {
		const starred = !items.every((item) => item.starred);
		try {
			await Promise.all(items.map((item) => setStarred(item.id, starred)));
			await this.load();
		} catch (error) {
			this.notify(errorMessage(error));
		}
	}

	async trash(items: DriveItem[]) {
		if (!this.#requireEdit() || items.length === 0) return;
		try {
			await Promise.all(items.map((item) => trashItem(item.id)));
			this.clearSelection();
			await this.load();
			const label = items.length === 1 ? `“${items[0]!.name}”` : `${items.length} items`;
			this.notify(`${label} moved to trash`, 'Undo', () => void this.restore(items, false));
		} catch (error) {
			this.notify(errorMessage(error));
		}
	}

	async restore(items: DriveItem[], announce = true) {
		if (!this.#requireEdit()) return;
		try {
			await Promise.all(items.map((item) => restoreItem(item.id)));
			this.clearSelection();
			await this.load();
			if (announce) {
				this.notify(items.length === 1 ? `“${items[0]!.name}” restored` : `${items.length} items restored`);
			}
		} catch (error) {
			this.notify(errorMessage(error));
		}
	}

	async move(items: DriveItem[], target: DriveItem) {
		const moving = items.filter((item) => item.id !== target.id && !item.parents.includes(target.id));
		if (!this.#requireEdit() || moving.length === 0) return;
		try {
			await Promise.all(moving.map((item) => moveItem(item, target.id)));
			this.clearSelection();
			await this.load();
			this.notify(`Moved ${moving.length === 1 ? `“${moving[0]!.name}”` : `${moving.length} items`} to ${target.name}`);
		} catch (error) {
			this.notify(errorMessage(error));
		}
	}

	// ---- Transfers --------------------------------------------------------------

	#enqueue(kind: Transfer['kind'], name: string, total: number, run: Transfer['run']) {
		const transfer: Transfer = {
			id: crypto.randomUUID(),
			kind,
			name,
			loaded: 0,
			total,
			status: 'queued',
			error: null,
			localPath: null,
			run,
			controller: new AbortController()
		};
		this.transfers = [...this.transfers, transfer];
		this.#pump();
	}

	#pump() {
		const active = this.transfers.filter((t) => t.status === 'active').length;
		const waiting = this.transfers.filter((t) => t.status === 'queued');
		for (const transfer of waiting.slice(0, Math.max(0, PARALLEL_TRANSFERS - active))) {
			void this.#execute(transfer);
		}
	}

	async #execute(entry: Transfer) {
		const transfer = this.transfers.find((t) => t.id === entry.id) ?? entry;
		transfer.status = 'active';
		try {
			await transfer.run(transfer, transfer.controller.signal);
			transfer.status = 'done';
			transfer.loaded = transfer.total || transfer.loaded;
		} catch (error) {
			if (transfer.controller.signal.aborted) transfer.status = 'cancelled';
			else {
				transfer.status = 'error';
				transfer.error = errorMessage(error);
			}
		} finally {
			this.#pump();
			if (this.activeTransfers === 0) void this.#afterTransfers();
		}
	}

	async #afterTransfers() {
		if (this.transfers.some((t) => t.kind === 'upload')) await this.load();
	}

	cancelTransfer(transfer: Transfer) {
		transfer.controller.abort();
		if (transfer.status === 'queued') transfer.status = 'cancelled';
	}

	clearFinishedTransfers() {
		this.transfers = this.transfers.filter((t) => t.status === 'queued' || t.status === 'active');
	}

	revealTransfer(transfer: Transfer) {
		if (transfer.localPath) void revealLocalPath(transfer.localPath);
	}

	/** Uploads picked or dropped files, recreating their folder structure under `targetId`. */
	async upload(picked: PickedFile[], targetId = this.currentFolderId, targetName = this.title) {
		if (!this.#requireEdit() || !targetId || picked.length === 0) return;
		const folders = new Map<string, Promise<string>>([['', Promise.resolve(targetId)]]);
		const folderFor = (dir: string): Promise<string> => {
			const known = folders.get(dir);
			if (known) return known;
			const slash = dir.lastIndexOf('/');
			const parent = slash < 0 ? '' : dir.slice(0, slash);
			const created = folderFor(parent).then(async (parentId) => (await createFolder(dir.slice(slash + 1), parentId)).id);
			folders.set(dir, created);
			return created;
		};
		for (const { file, path } of picked) {
			const slash = path.lastIndexOf('/');
			const dir = slash < 0 ? '' : path.slice(0, slash);
			this.#enqueue('upload', path, file.size, async (transfer, signal) => {
				const parentId = await folderFor(dir);
				await uploadBlob(file, {
					name: file.name,
					parentId,
					modified: file.lastModified,
					signal,
					onProgress: (loaded, total) => {
						transfer.loaded = loaded;
						transfer.total = total;
					}
				});
			});
		}
		this.notify(`Uploading ${picked.length} ${picked.length === 1 ? 'item' : 'items'} to ${targetName}`);
	}

	/** Asks for a local folder, then downloads the items (folders recursively) into it. */
	async download(items: DriveItem[]) {
		if (items.length === 0) return;
		let destination: string | null;
		try {
			destination = await pickLocalFolder('Download to…');
		} catch (error) {
			this.notify(errorMessage(error));
			return;
		}
		if (!destination) return;
		let skipped = 0;
		for (const item of items) {
			if (item.isFolder) {
				const root = joinLocalPath(destination, safeLocalName(item.name));
				try {
					await makeLocalDir(root);
					for (const { path, item: child } of await listTree(item.id, item.driveId)) {
						const relative = path.split('/').map(safeLocalName).join('/');
						if (child.isFolder) {
							await makeLocalDir(joinLocalPath(root, relative));
							continue;
						}
						if (!this.#queueDownload(child, joinLocalPath(root, relative), `${item.name}/${path}`)) skipped++;
					}
				} catch (error) {
					this.notify(errorMessage(error));
				}
			} else if (!this.#queueDownload(item, destination, item.name, true)) {
				skipped++;
			}
		}
		if (skipped) this.notify(`${skipped} item${skipped === 1 ? '' : 's'} can't be downloaded (Google Forms, Sites…)`);
	}

	#queueDownload(item: DriveItem, target: string, label: string, targetIsFolder = false): boolean {
		const name = downloadName(item);
		if (!name || !item.canDownload) return false;
		let localPath = target;
		if (targetIsFolder) localPath = joinLocalPath(target, safeLocalName(name));
		else if (name !== item.name) localPath = target.replace(/[^\\/]+$/, safeLocalName(name));
		this.#enqueue('download', label, item.size ?? 0, async (transfer, signal) => {
			const bytes = await downloadBytes(
				item,
				(loaded, total) => {
					transfer.loaded = loaded;
					transfer.total = total;
				},
				signal
			);
			await writeLocalFile(localPath, bytes, Date.parse(item.modifiedTime ?? '') || undefined);
			transfer.localPath = localPath;
		});
		return true;
	}
}

export const [getBrowserState, setBrowserState] = createContext<BrowserState>();
