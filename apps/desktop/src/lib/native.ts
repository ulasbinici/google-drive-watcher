export interface LocalEntry {
	/** Relative to the scanned root, `/`-separated. */
	path: string;
	isDir: boolean;
	size: number;
	modified: number;
}

declare global {
	interface Window {
		/** Set by the Browse window before the page loads. */
		__DRIVE_WATCH_WINDOW__?: string;
	}
}

export function isTauri(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** True inside the separate Browse window, which loads the app shell rather than /browse. */
export function isBrowseShell(): boolean {
	return typeof window !== 'undefined' && window.__DRIVE_WATCH_WINDOW__ === 'browser';
}

async function invoke<T>(
	command: string,
	args?: Record<string, unknown> | ArrayBuffer | Uint8Array,
	headers?: Record<string, string>
): Promise<T> {
	if (!isTauri()) throw new Error('This action needs the Drive Watch desktop app.');
	const core = await import('@tauri-apps/api/core');
	return core.invoke<T>(command, args, headers ? { headers } : undefined);
}

/** Writes bytes to an absolute path, creating parent folders. Returns the file's mtime in ms. */
export function writeLocalFile(path: string, bytes: ArrayBuffer, modified?: number): Promise<number> {
	const headers: Record<string, string> = { 'x-path': encodeURIComponent(path) };
	if (modified) headers['x-modified'] = String(Math.round(modified));
	return invoke<number>('write_file', new Uint8Array(bytes), headers);
}

export function readLocalFile(path: string): Promise<ArrayBuffer> {
	return invoke<ArrayBuffer>('read_file', { path });
}

export function makeLocalDir(path: string): Promise<void> {
	return invoke('make_dir', { path });
}

export function localPathExists(path: string): Promise<boolean> {
	return invoke<boolean>('path_exists', { path });
}

export function scanLocalDir(path: string): Promise<LocalEntry[]> {
	return invoke<LocalEntry[]>('scan_dir', { path });
}

/** Tray tooltip and the first menu line. Hover or click the tray icon to read it. */
export async function setTrayStatus(text: string): Promise<void> {
	if (!isTauri()) return;
	await invoke('set_tray_status', { text });
}

export async function openBrowseWindow(): Promise<void> {
	if (!isTauri()) {
		window.open('/browse', '_blank');
		return;
	}
	await invoke('open_browser');
}

export async function pickLocalFolder(title: string): Promise<string | null> {
	if (!isTauri()) throw new Error('Choosing a local folder needs the Drive Watch desktop app.');
	const { open } = await import('@tauri-apps/plugin-dialog');
	const result = await open({ directory: true, multiple: false, title });
	return typeof result === 'string' ? result : null;
}

export async function revealLocalPath(path: string): Promise<void> {
	if (!isTauri()) return;
	const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
	await revealItemInDir(path);
}

export async function openExternalUrl(url: string): Promise<void> {
	if (!isTauri()) {
		window.open(url, '_blank', 'noopener');
		return;
	}
	const { openUrl } = await import('@tauri-apps/plugin-opener');
	await openUrl(url);
}

export async function emitAppEvent(name: string, payload?: unknown): Promise<void> {
	if (!isTauri()) return;
	const { emit } = await import('@tauri-apps/api/event');
	await emit(name, payload);
}

export function listenAppEvent<T>(name: string, handler: (payload: T) => void): () => void {
	let off: (() => void) | undefined;
	let cancelled = false;
	if (isTauri()) {
		void import('@tauri-apps/api/event').then(async ({ listen }) => {
			const unlisten = await listen<T>(name, (event) => handler(event.payload));
			if (cancelled) unlisten();
			else off = unlisten;
		});
	}
	return () => {
		cancelled = true;
		off?.();
	};
}

const INVALID_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

/** Makes a Drive name safe as a single local path segment. */
export function safeLocalName(name: string): string {
	const cleaned = name.replace(INVALID_NAME_CHARS, '_').replace(/[. ]+$/, '');
	return cleaned || '_';
}

export function joinLocalPath(base: string, relative: string): string {
	const separator = base.includes('\\') ? '\\' : '/';
	const trimmed = base.replace(/[\\/]+$/, '');
	const parts = relative.split('/').filter(Boolean);
	return [trimmed, ...parts].join(separator);
}

export const APP_EVENTS = {
	syncPairsChanged: 'sync-pairs-changed',
	syncRun: 'sync-run',
	fileEditsChanged: 'file-edits-changed'
} as const;
