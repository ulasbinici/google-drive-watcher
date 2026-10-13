import { callFunction, firebaseConfigured } from '$lib/services/firebase-backend';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

const ITEM_FIELDS = [
	'id',
	'name',
	'mimeType',
	'size',
	'modifiedTime',
	'owners(displayName,emailAddress,me)',
	'ownedByMe',
	'iconLink',
	'thumbnailLink',
	'hasThumbnail',
	'webViewLink',
	'starred',
	'trashed',
	'parents',
	'driveId',
	'md5Checksum',
	'capabilities(canEdit,canTrash,canRename,canAddChildren,canDownload,canUntrash)'
].join(',');

export interface DriveItem {
	id: string;
	name: string;
	mimeType: string;
	isFolder: boolean;
	size: number | null;
	modifiedTime: string | null;
	ownerName: string | null;
	ownedByMe: boolean;
	iconLink: string | null;
	thumbnailLink: string | null;
	webViewLink: string | null;
	starred: boolean;
	trashed: boolean;
	parents: string[];
	driveId: string | null;
	md5: string | null;
	canEdit: boolean;
	canTrash: boolean;
	canRename: boolean;
	canAddChildren: boolean;
	canDownload: boolean;
	canUntrash: boolean;
}

export interface SharedDrive {
	id: string;
	name: string;
}

interface RawItem {
	id: string;
	name: string;
	mimeType: string;
	size?: string;
	modifiedTime?: string;
	owners?: Array<{ displayName?: string; emailAddress?: string; me?: boolean }>;
	ownedByMe?: boolean;
	iconLink?: string;
	thumbnailLink?: string;
	hasThumbnail?: boolean;
	webViewLink?: string;
	starred?: boolean;
	trashed?: boolean;
	parents?: string[];
	driveId?: string;
	md5Checksum?: string;
	capabilities?: Partial<
		Record<
			'canEdit' | 'canTrash' | 'canRename' | 'canAddChildren' | 'canDownload' | 'canUntrash',
			boolean
		>
	>;
}

function toItem(raw: RawItem): DriveItem {
	const owner = raw.owners?.[0];
	const caps = raw.capabilities ?? {};
	return {
		id: raw.id,
		name: raw.name,
		mimeType: raw.mimeType,
		isFolder: raw.mimeType === FOLDER_MIME,
		size: raw.size ? Number(raw.size) : null,
		modifiedTime: raw.modifiedTime ?? null,
		ownerName: raw.ownedByMe ? 'me' : (owner?.displayName ?? owner?.emailAddress ?? null),
		ownedByMe: raw.ownedByMe === true,
		iconLink: raw.iconLink ?? null,
		thumbnailLink: raw.hasThumbnail ? (raw.thumbnailLink ?? null) : null,
		webViewLink: raw.webViewLink ?? null,
		starred: raw.starred === true,
		trashed: raw.trashed === true,
		parents: raw.parents ?? [],
		driveId: raw.driveId ?? null,
		md5: raw.md5Checksum ?? null,
		canEdit: caps.canEdit === true,
		canTrash: caps.canTrash === true,
		canRename: caps.canRename === true,
		canAddChildren: caps.canAddChildren === true,
		canDownload: caps.canDownload !== false,
		canUntrash: caps.canUntrash === true
	};
}

// ---- Token -----------------------------------------------------------------

interface DriveToken {
	accessToken: string;
	expiresAt: number;
	canEdit: boolean;
}

let cachedToken: DriveToken | null = null;
let pendingToken: Promise<DriveToken> | null = null;

export function driveAvailable(): boolean {
	return firebaseConfigured();
}

export function invalidateDriveToken(): void {
	cachedToken = null;
}

export async function driveToken(): Promise<DriveToken> {
	if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) return cachedToken;
	pendingToken ??= callFunction<DriveToken>('/driveToken', { method: 'POST' })
		.then((token) => {
			cachedToken = token;
			return token;
		})
		.finally(() => {
			pendingToken = null;
		});
	return pendingToken;
}

export async function canEditDrive(): Promise<boolean> {
	return (await driveToken()).canEdit;
}

async function googleError(response: Response): Promise<Error> {
	const body = (await response.json().catch(() => null)) as {
		error?: { message?: string; errors?: Array<{ reason?: string }> };
	} | null;
	const reason = body?.error?.errors?.[0]?.reason;
	if (response.status === 403 && reason === 'insufficientPermissions') {
		return new Error('Turn on “Allow file upload and edit” in Settings to change files.');
	}
	return new Error(body?.error?.message ?? `Google Drive request failed (${response.status})`);
}

async function driveFetch(url: string, init: RequestInit = {}, retry = true): Promise<Response> {
	const token = await driveToken();
	const response = await fetch(url, {
		...init,
		headers: { Authorization: `Bearer ${token.accessToken}`, ...init.headers }
	});
	if (response.status === 401 && retry) {
		invalidateDriveToken();
		return driveFetch(url, init, false);
	}
	if (!response.ok) throw await googleError(response);
	return response;
}

async function driveJson<T>(url: string, init: RequestInit = {}): Promise<T> {
	const response = await driveFetch(url, init);
	if (response.status === 204) return undefined as T;
	return (await response.json()) as T;
}

function literal(value: string): string {
	return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

// ---- Listing ---------------------------------------------------------------

interface ListOptions {
	q: string;
	orderBy?: string;
	driveId?: string | null;
	pageSize?: number;
	/** Stops after the first page (used for Recent and search). */
	singlePage?: boolean;
	signal?: AbortSignal;
}

async function listFiles(options: ListOptions): Promise<DriveItem[]> {
	const items: DriveItem[] = [];
	let pageToken: string | undefined;
	do {
		const params = new URLSearchParams({
			q: options.q,
			pageSize: String(options.pageSize ?? 1000),
			fields: `nextPageToken,files(${ITEM_FIELDS})`,
			supportsAllDrives: 'true',
			includeItemsFromAllDrives: 'true'
		});
		if (options.orderBy) params.set('orderBy', options.orderBy);
		if (options.driveId) {
			params.set('corpora', 'drive');
			params.set('driveId', options.driveId);
		} else {
			params.set('corpora', 'allDrives');
		}
		if (pageToken) params.set('pageToken', pageToken);
		const page = await driveJson<{ files?: RawItem[]; nextPageToken?: string }>(
			`${API}/files?${params}`,
			{ signal: options.signal }
		);
		for (const raw of page.files ?? []) items.push(toItem(raw));
		pageToken = options.singlePage ? undefined : page.nextPageToken;
	} while (pageToken);
	return items;
}

export function listChildren(
	parentId: string,
	driveId: string | null,
	signal?: AbortSignal
): Promise<DriveItem[]> {
	return listFiles({
		q: `'${literal(parentId)}' in parents and trashed = false`,
		driveId,
		signal
	});
}

export type SpecialView = 'shared-with-me' | 'recent' | 'starred' | 'trash';

export function listSpecial(view: SpecialView, signal?: AbortSignal): Promise<DriveItem[]> {
	switch (view) {
		case 'shared-with-me':
			return listFiles({ q: 'sharedWithMe = true and trashed = false', signal });
		case 'recent':
			return listFiles({
				q: `trashed = false and mimeType != '${FOLDER_MIME}'`,
				orderBy: 'viewedByMeTime desc',
				pageSize: 100,
				singlePage: true,
				signal
			});
		case 'starred':
			return listFiles({ q: 'starred = true and trashed = false', signal });
		case 'trash':
			return listFiles({ q: 'trashed = true', signal });
	}
}

export function searchDrive(text: string, signal?: AbortSignal): Promise<DriveItem[]> {
	const term = literal(text.trim());
	return listFiles({
		q: `(name contains '${term}' or fullText contains '${term}') and trashed = false`,
		pageSize: 200,
		singlePage: true,
		signal
	});
}

export async function listSharedDrives(): Promise<SharedDrive[]> {
	const drives: SharedDrive[] = [];
	let pageToken: string | undefined;
	do {
		const params = new URLSearchParams({ pageSize: '100', fields: 'nextPageToken,drives(id,name)' });
		if (pageToken) params.set('pageToken', pageToken);
		const page = await driveJson<{ drives?: SharedDrive[]; nextPageToken?: string }>(
			`${API}/drives?${params}`
		).catch(() => ({ drives: [], nextPageToken: undefined }));
		drives.push(...(page.drives ?? []));
		pageToken = page.nextPageToken;
	} while (pageToken);
	return drives;
}

export async function getItem(id: string): Promise<DriveItem> {
	const params = new URLSearchParams({ fields: ITEM_FIELDS, supportsAllDrives: 'true' });
	return toItem(await driveJson<RawItem>(`${API}/files/${encodeURIComponent(id)}?${params}`));
}

let myDriveRootId: Promise<string> | null = null;

export function rootFolderId(): Promise<string> {
	myDriveRootId ??= driveJson<{ id: string }>(`${API}/files/root?fields=id`).then((r) => r.id);
	return myDriveRootId;
}

export interface TreeEntry {
	/** Relative path from the listed folder, `/`-separated, using Drive names. */
	path: string;
	item: DriveItem;
}

/** Lists every file and folder under `folderId`, depth first. */
export async function listTree(folderId: string, driveId: string | null): Promise<TreeEntry[]> {
	const out: TreeEntry[] = [];
	const walk = async (id: string, prefix: string) => {
		const children = await listChildren(id, driveId);
		const used = new Map<string, number>();
		for (const item of children) {
			let name = item.name;
			const seen = used.get(name) ?? 0;
			used.set(name, seen + 1);
			if (seen > 0) name = withSuffix(name, seen);
			const path = prefix ? `${prefix}/${name}` : name;
			out.push({ path, item });
			if (item.isFolder) await walk(item.id, path);
		}
	};
	await walk(folderId, '');
	return out;
}

function withSuffix(name: string, n: number): string {
	const dot = name.lastIndexOf('.');
	return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

// ---- Changes ---------------------------------------------------------------

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function createFolder(name: string, parentId: string): Promise<DriveItem> {
	const params = new URLSearchParams({ fields: ITEM_FIELDS, supportsAllDrives: 'true' });
	return toItem(
		await driveJson<RawItem>(`${API}/files?${params}`, {
			method: 'POST',
			headers: JSON_HEADERS,
			body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] })
		})
	);
}

async function patchItem(id: string, body: Record<string, unknown>, query = ''): Promise<DriveItem> {
	const params = new URLSearchParams({ fields: ITEM_FIELDS, supportsAllDrives: 'true' });
	return toItem(
		await driveJson<RawItem>(`${API}/files/${encodeURIComponent(id)}?${params}${query}`, {
			method: 'PATCH',
			headers: JSON_HEADERS,
			body: JSON.stringify(body)
		})
	);
}

export const renameItem = (id: string, name: string) => patchItem(id, { name });
export const setStarred = (id: string, starred: boolean) => patchItem(id, { starred });
export const trashItem = (id: string) => patchItem(id, { trashed: true });
export const restoreItem = (id: string) => patchItem(id, { trashed: false });

export function moveItem(item: DriveItem, targetId: string): Promise<DriveItem> {
	const query = `&addParents=${encodeURIComponent(targetId)}&removeParents=${encodeURIComponent(item.parents.join(','))}`;
	return patchItem(item.id, {}, query);
}

// ---- Transfers -------------------------------------------------------------

export type Progress = (loaded: number, total: number) => void;

export interface UploadOptions {
	name: string;
	parentId?: string;
	/** Replaces the content of an existing file instead of creating a new one. */
	fileId?: string;
	modified?: number;
	onProgress?: Progress;
	signal?: AbortSignal;
}

function xhrUpload(
	method: string,
	url: string,
	body: Blob,
	headers: Record<string, string>,
	onProgress?: Progress,
	signal?: AbortSignal
): Promise<RawItem> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open(method, url);
		for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
		xhr.upload.onprogress = (event) => onProgress?.(event.loaded, event.total || body.size);
		xhr.onload = () => {
			if (xhr.status >= 200 && xhr.status < 300) {
				resolve(JSON.parse(xhr.responseText) as RawItem);
				return;
			}
			let message = `Upload failed (${xhr.status})`;
			try {
				message = (JSON.parse(xhr.responseText) as { error?: { message?: string } }).error?.message ?? message;
			} catch {
				// Non-JSON error body.
			}
			reject(new Error(xhr.status === 403 ? `${message}. Check “Allow file upload and edit” in Settings.` : message));
		};
		xhr.onerror = () => reject(new Error('Network error while uploading'));
		xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
		signal?.addEventListener('abort', () => xhr.abort(), { once: true });
		xhr.send(body);
	});
}

export async function uploadBlob(blob: Blob, options: UploadOptions): Promise<DriveItem> {
	const token = await driveToken();
	const metadata: Record<string, unknown> = { name: options.name };
	if (!options.fileId && options.parentId) metadata.parents = [options.parentId];
	if (options.modified) metadata.modifiedTime = new Date(options.modified).toISOString();
	const params = new URLSearchParams({
		uploadType: 'resumable',
		supportsAllDrives: 'true',
		fields: ITEM_FIELDS
	});
	const target = options.fileId
		? `${UPLOAD}/files/${encodeURIComponent(options.fileId)}?${params}`
		: `${UPLOAD}/files?${params}`;
	const contentType = blob.type || 'application/octet-stream';
	const session = await driveFetch(target, {
		method: options.fileId ? 'PATCH' : 'POST',
		headers: {
			'Content-Type': 'application/json; charset=UTF-8',
			'X-Upload-Content-Type': contentType,
			'X-Upload-Content-Length': String(blob.size)
		},
		body: JSON.stringify(metadata),
		signal: options.signal
	});
	const location = session.headers.get('Location');
	if (location) {
		return toItem(
			await xhrUpload('PUT', location, blob, { 'Content-Type': contentType }, options.onProgress, options.signal)
		);
	}

	const boundary = `drivewatch${crypto.randomUUID().replaceAll('-', '')}`;
	const multipart = new Blob([
		`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
		`--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
		blob,
		`\r\n--${boundary}--`
	]);
	params.set('uploadType', 'multipart');
	const url = options.fileId
		? `${UPLOAD}/files/${encodeURIComponent(options.fileId)}?${params}`
		: `${UPLOAD}/files?${params}`;
	return toItem(
		await xhrUpload(
			options.fileId ? 'PATCH' : 'POST',
			url,
			multipart,
			{ Authorization: `Bearer ${token.accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
			options.onProgress,
			options.signal
		)
	);
}

const EXPORTS: Record<string, { mime: string; ext: string }> = {
	'application/vnd.google-apps.document': {
		mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		ext: '.docx'
	},
	'application/vnd.google-apps.spreadsheet': {
		mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		ext: '.xlsx'
	},
	'application/vnd.google-apps.presentation': {
		mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
		ext: '.pptx'
	},
	'application/vnd.google-apps.drawing': { mime: 'image/png', ext: '.png' }
};

export function isGoogleNative(item: DriveItem): boolean {
	return item.mimeType.startsWith('application/vnd.google-apps.') && !item.isFolder;
}

/** Local file name for a download, or null when the type can't be downloaded (forms, sites…). */
export function downloadName(item: DriveItem): string | null {
	if (!isGoogleNative(item)) return item.name;
	const exported = EXPORTS[item.mimeType];
	if (!exported) return null;
	return item.name.toLowerCase().endsWith(exported.ext) ? item.name : `${item.name}${exported.ext}`;
}

export async function downloadBytes(
	item: DriveItem,
	onProgress?: Progress,
	signal?: AbortSignal
): Promise<ArrayBuffer> {
	const exported = EXPORTS[item.mimeType];
	const id = encodeURIComponent(item.id);
	const url = exported
		? `${API}/files/${id}/export?mimeType=${encodeURIComponent(exported.mime)}`
		: `${API}/files/${id}?alt=media&supportsAllDrives=true&acknowledgeAbuse=false`;
	const response = await driveFetch(url, { signal });
	const total = Number(response.headers.get('Content-Length')) || item.size || 0;
	if (!response.body) return response.arrayBuffer();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let loaded = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		loaded += value.byteLength;
		onProgress?.(loaded, total);
	}
	const out = new Uint8Array(loaded);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out.buffer;
}

export function thumbnailUrl(item: DriveItem, size: number): string | null {
	if (!item.thumbnailLink) return null;
	return item.thumbnailLink.replace(/=s\d+$/, `=s${size}`);
}

export function iconUrl(item: DriveItem, size: 16 | 32 | 64 | 128 = 32): string | null {
	if (!item.iconLink) return null;
	return item.iconLink.replace(/\/\d+\/type\//, `/${size}/type/`);
}
