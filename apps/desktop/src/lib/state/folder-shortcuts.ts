import { APP_EVENTS, emitAppEvent, isTauri } from '$lib/native';

/** A folder pinned locally so it can be opened from the main window or Browse. */
export interface FolderShortcut {
	id: string;
	name: string;
	driveId: string | null;
	webViewLink: string | null;
	/** Breadcrumb text, for example "Shared with me / Games / Dev files". */
	location: string;
}

interface ShortcutFile {
	shortcuts: Record<string, FolderShortcut[]>;
	pending: Record<string, string>;
}

const STORE_FILE = 'folder-shortcuts.json';
const LOCAL_KEY = 'drive-watch-folder-shortcuts';
const EMPTY: ShortcutFile = { shortcuts: {}, pending: {} };

type Store = import('@tauri-apps/plugin-store').Store;
let storeHandle: Promise<Store> | null = null;
let pendingWrite: Promise<void> = Promise.resolve();

function isUid(uid: string): boolean {
	return uid.length > 0 && uid.length <= 128 && !/[\u0000-\u001f]/.test(uid);
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
	const run = pendingWrite.then(task, task);
	pendingWrite = run.then(
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

function cleanShortcut(value: unknown): FolderShortcut | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Partial<FolderShortcut>;
	if (typeof raw.id !== 'string' || !raw.id || typeof raw.name !== 'string' || !raw.name.trim()) return null;
	return {
		id: raw.id,
		name: raw.name.trim(),
		driveId: typeof raw.driveId === 'string' ? raw.driveId : null,
		webViewLink: typeof raw.webViewLink === 'string' ? raw.webViewLink : null,
		location: typeof raw.location === 'string' ? raw.location.trim() : raw.name.trim()
	};
}

function normalize(value: unknown): ShortcutFile {
	if (!value || typeof value !== 'object') return { shortcuts: {}, pending: {} };
	const raw = value as Partial<ShortcutFile>;
	const shortcuts: Record<string, FolderShortcut[]> = {};
	for (const [uid, list] of Object.entries(raw.shortcuts ?? {})) {
		if (!isUid(uid) || !Array.isArray(list)) continue;
		const seen = new Set<string>();
		const cleaned: FolderShortcut[] = [];
		for (const item of list) {
			const shortcut = cleanShortcut(item);
			if (!shortcut || seen.has(shortcut.id)) continue;
			seen.add(shortcut.id);
			cleaned.push(shortcut);
		}
		if (cleaned.length) shortcuts[uid] = cleaned;
	}
	const pending: Record<string, string> = {};
	for (const [uid, id] of Object.entries(raw.pending ?? {})) {
		if (isUid(uid) && typeof id === 'string' && id) pending[uid] = id;
	}
	return { shortcuts, pending };
}

async function readFile(): Promise<ShortcutFile> {
	if (!isTauri()) {
		if (typeof localStorage === 'undefined') return { ...EMPTY, shortcuts: {}, pending: {} };
		const raw = localStorage.getItem(LOCAL_KEY);
		if (!raw) return { shortcuts: {}, pending: {} };
		try {
			return normalize(JSON.parse(raw) as unknown);
		} catch {
			return { shortcuts: {}, pending: {} };
		}
	}
	const store = await openStore();
	await store.reload().catch((error: unknown) => {
		if (!isMissingFile(error)) throw error;
	});
	return normalize((await store.get<unknown>('data')) ?? null);
}

async function writeFile(value: ShortcutFile): Promise<void> {
	const cleaned = normalize(value);
	if (!isTauri()) {
		if (typeof localStorage === 'undefined') return;
		localStorage.setItem(LOCAL_KEY, JSON.stringify(cleaned));
		return;
	}
	const store = await openStore();
	await store.set('data', cleaned);
	await store.save();
}

function announce() {
	void emitAppEvent(APP_EVENTS.folderShortcutsChanged);
	if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(APP_EVENTS.folderShortcutsChanged));
}

export function shortcutDriveUrl(shortcut: FolderShortcut): string {
	return shortcut.webViewLink ?? `https://drive.google.com/drive/folders/${encodeURIComponent(shortcut.id)}`;
}

export function loadFolderShortcuts(uid: string): Promise<FolderShortcut[]> {
	if (!isUid(uid)) return Promise.resolve([]);
	return enqueue(async () => (await readFile()).shortcuts[uid] ?? []);
}

export function saveFolderShortcut(uid: string, shortcut: FolderShortcut): Promise<FolderShortcut[]> {
	if (!isUid(uid)) return Promise.resolve([]);
	const next = cleanShortcut(shortcut);
	if (!next) return loadFolderShortcuts(uid);
	return enqueue(async () => {
		const file = await readFile();
		const current = file.shortcuts[uid] ?? [];
		const index = current.findIndex((item) => item.id === next.id);
		if (index >= 0) {
			const updated = [...current];
			updated[index] = next;
			file.shortcuts[uid] = updated;
		} else {
			file.shortcuts[uid] = [...current, next];
		}
		await writeFile(file);
		announce();
		return file.shortcuts[uid] ?? [];
	});
}

export function removeFolderShortcut(uid: string, id: string): Promise<FolderShortcut[]> {
	if (!isUid(uid)) return Promise.resolve([]);
	return enqueue(async () => {
		const file = await readFile();
		const current = file.shortcuts[uid] ?? [];
		file.shortcuts[uid] = current.filter((item) => item.id !== id);
		if (!file.shortcuts[uid]?.length) delete file.shortcuts[uid];
		if (file.pending[uid] === id) delete file.pending[uid];
		await writeFile(file);
		announce();
		return file.shortcuts[uid] ?? [];
	});
}

/** Remember which shortcut the next Browse window should open. */
export function stageShortcutOpen(uid: string, id: string): Promise<void> {
	if (!isUid(uid) || !id) return Promise.resolve();
	return enqueue(async () => {
		const file = await readFile();
		file.pending[uid] = id;
		await writeFile(file);
		void emitAppEvent(APP_EVENTS.browseOpenFolder, { id });
		if (typeof window !== 'undefined') {
			window.dispatchEvent(new CustomEvent(APP_EVENTS.browseOpenFolder, { detail: { id } }));
		}
	});
}

/** Reads and clears the folder Browse should open after it starts. */
export function takeStagedShortcut(uid: string): Promise<string | null> {
	if (!isUid(uid)) return Promise.resolve(null);
	return enqueue(async () => {
		const file = await readFile();
		const id = file.pending[uid] ?? null;
		if (!id) return null;
		delete file.pending[uid];
		await writeFile(file);
		return id;
	});
}

export function listenFolderShortcuts(handler: () => void): () => void {
	const offApp = isTauri()
		? listenLocal(APP_EVENTS.folderShortcutsChanged, handler)
		: () => undefined;
	const onStorage = (event: StorageEvent) => {
		if (event.key === LOCAL_KEY) handler();
	};
	window.addEventListener(APP_EVENTS.folderShortcutsChanged, handler);
	window.addEventListener('storage', onStorage);
	return () => {
		offApp();
		window.removeEventListener(APP_EVENTS.folderShortcutsChanged, handler);
		window.removeEventListener('storage', onStorage);
	};
}

export function listenBrowseOpen(handler: (id: string) => void): () => void {
	const onCustom = (event: Event) => {
		const id = (event as CustomEvent<{ id?: string }>).detail?.id;
		if (id) handler(id);
	};
	window.addEventListener(APP_EVENTS.browseOpenFolder, onCustom);
	let offTauri: () => void = () => undefined;
	let cancelled = false;
	if (isTauri()) {
		void import('@tauri-apps/api/event').then(({ listen }) => {
			void listen<{ id?: string }>(APP_EVENTS.browseOpenFolder, (event) => {
				if (event.payload?.id) handler(event.payload.id);
			}).then((off) => {
				if (cancelled) off();
				else offTauri = off;
			});
		});
	}
	return () => {
		cancelled = true;
		window.removeEventListener(APP_EVENTS.browseOpenFolder, onCustom);
		offTauri();
	};
}

function listenLocal(name: string, handler: () => void): () => void {
	let off: () => void = () => undefined;
	let cancelled = false;
	void import('@tauri-apps/api/event').then(async ({ listen }) => {
		const unlisten = await listen(name, () => handler());
		if (cancelled) unlisten();
		else off = unlisten;
	});
	return () => {
		cancelled = true;
		off();
	};
}
