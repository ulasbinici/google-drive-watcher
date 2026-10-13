import { env } from "$env/dynamic/public";
import { initializeApp } from "firebase/app";
import {
	getAuth,
	onAuthStateChanged,
	signInWithCustomToken,
	signOut,
	type User,
} from "firebase/auth";
import {
	collection,
	doc,
	getDoc,
	getDocFromServer,
	getDocs,
	getFirestore,
	limit,
	onSnapshot,
	orderBy,
	query,
	updateDoc,
	where,
	writeBatch,
	type Timestamp,
} from "firebase/firestore";
import type {
	ChangeType,
	DriveFolder,
	DriveKind,
	DriveNotification,
	DriveRoot,
	MonitoringSettings,
	SyncStatus,
	UserProfile,
	WatchChannel,
	WatchedFolder,
} from "$lib/types";
import { formatDateTime } from "$lib/format";
import type { DriveNotifierBackend, Unsubscribe } from "./backend";
import { notifyNative } from "./native-notify";

const BROWSER_VERIFIER_KEY = "drive-watch-oauth-verifier";

const CHANGE_TYPES: Record<string, ChangeType> = {
	created: "created",
	updated: "modified",
	modified: "modified",
	moved: "moved",
	deleted: "deleted",
	renamed: "renamed",
	permission: "shared",
	shared: "shared",
};

export function firebaseConfigured(): boolean {
	return Boolean(
		env.PUBLIC_FIREBASE_API_KEY &&
			env.PUBLIC_FIREBASE_PROJECT_ID &&
			env.PUBLIC_FUNCTIONS_BASE_URL,
	);
}

const firebaseApp = firebaseConfigured()
	? initializeApp({
			apiKey: env.PUBLIC_FIREBASE_API_KEY,
			authDomain: env.PUBLIC_FIREBASE_AUTH_DOMAIN,
			projectId: env.PUBLIC_FIREBASE_PROJECT_ID,
			appId: env.PUBLIC_FIREBASE_APP_ID,
		})
	: null;
const auth = firebaseApp ? getAuth(firebaseApp) : null;
const db = firebaseApp ? getFirestore(firebaseApp) : null;

function requireFirebase(): { auth: NonNullable<typeof auth>; db: NonNullable<typeof db> } {
	if (!auth || !db) throw new Error("Firebase is not configured.");
	return { auth, db };
}

function database(): NonNullable<typeof db> {
	return requireFirebase().db;
}

function baseUrl(): string {
	const url = env.PUBLIC_FUNCTIONS_BASE_URL;
	if (!url) throw new Error("Firebase functions URL is not configured.");
	return url.replace(/\/$/, "");
}

function profileFrom(user: User): UserProfile {
	return {
		uid: user.uid,
		email: user.email ?? "",
		displayName: user.displayName ?? user.email ?? "Google user",
		photoUrl: user.photoURL,
	};
}

async function requireUser(): Promise<User> {
	const current = await signedInUser();
	if (current) return current;
	throw new Error("Sign in with Google before using Drive.");
}

export async function signedInUser(): Promise<User | null> {
	const { auth } = requireFirebase();
	await auth.authStateReady();
	return auth.currentUser;
}

export function callFunction<T>(path: string, init: RequestInit = {}): Promise<T> {
	return api<T>(path, init);
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
	const user = await requireUser();
	const response = await fetch(`${baseUrl()}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${await user.getIdToken()}`,
			"Content-Type": "application/json",
			...init.headers,
		},
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as { message?: string } | null;
		throw new Error(body?.message ?? `Request failed (${response.status})`);
	}
	return (await response.json()) as T;
}

function randomVerifier(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

async function codeChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

async function installationId(): Promise<string> {
	const key = "installation-id";
	if ("__TAURI_INTERNALS__" in window) {
		const { LazyStore } = await import("@tauri-apps/plugin-store");
		const store = new LazyStore("drive-watch.json");
		const existing = await store.get<string>(key);
		if (existing) return existing;
		const created = crypto.randomUUID();
		await store.set(key, created);
		await store.save();
		return created;
	}
	const existing = localStorage.getItem(key);
	if (existing) return existing;
	const created = crypto.randomUUID();
	localStorage.setItem(key, created);
	return created;
}

function folderFromApi(
	file: { id: string; name: string; parentIds?: string[]; driveId?: string | null },
	source: DriveRoot,
): DriveFolder {
	const inSharedDrive = source.kind !== "shared-with-me" && Boolean(file.driveId) && file.driveId !== source.id;
	return {
		id: file.id,
		name: file.name,
		driveId: inSharedDrive ? file.driveId! : source.id,
		driveName: source.name,
		driveKind: inSharedDrive ? "shared-drive" : source.kind,
		parentId: file.parentIds?.[0] ?? null,
		path: [],
		hasChildren: true,
	};
}

function iso(value: unknown): string {
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && "toDate" in value) {
		return (value as Timestamp).toDate().toISOString();
	}
	return new Date().toISOString();
}

function optionalString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function notificationFrom(id: string, data: Record<string, unknown>): DriveNotification {
	return {
		id,
		fileId: String(data.fileId ?? ""),
		fileName: String(data.fileName ?? "Untitled"),
		mimeType: String(data.mimeType ?? ""),
		folderId: String(data.selectedFolderId ?? ""),
		folderName: String(data.selectedFolderName ?? "Folder"),
		driveName: data.sourceId === "my-drive" ? "My Drive" : String(data.sourceId ?? ""),
		changeType: CHANGE_TYPES[String(data.kind ?? data.changeType ?? "updated")] ?? "modified",
		actorName: optionalString(data.actorName ?? data.actorEmail),
		ownerName: optionalString(data.ownerName ?? data.ownerEmail),
		occurredAt: iso(data.occurredAt),
		read: data.read === true,
		webViewLink: optionalString(data.webViewLink),
	};
}

export function createFirebaseBackend(): DriveNotifierBackend {
	let pendingCode: ((code: string) => void) | undefined;
	const drives = new Map<string, DriveRoot>();

	async function ensureDeepLinks(): Promise<void> {
		if (!("__TAURI_INTERNALS__" in window)) return;
		const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
		const deliver = (url: string) => {
			const code = new URL(url).searchParams.get("code");
			if (code) pendingCode?.(code);
		};
		for (const url of (await getCurrent()) ?? []) deliver(url);
		await onOpenUrl((urls) => urls.forEach(deliver));
	}
	void ensureDeepLinks().catch((error) => console.error(error));

	async function exchangeCode(code: string, verifier: string): Promise<UserProfile> {
		const response = await fetch(`${baseUrl()}/oauthExchange`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code, codeVerifier: verifier }),
		});
		if (!response.ok) throw new Error("Could not complete Google sign-in.");
		const session = (await response.json()) as { customToken: string };
		const credential = await signInWithCustomToken(requireFirebase().auth, session.customToken);
		return profileFrom(credential.user);
	}

	// Browser dev: Google sends the user back to this page with ?code= instead of the deep link.
	async function finishBrowserSignIn(): Promise<void> {
		if (typeof window === "undefined" || "__TAURI_INTERNALS__" in window) return;
		const url = new URL(window.location.href);
		const code = url.searchParams.get("code");
		const verifier = sessionStorage.getItem(BROWSER_VERIFIER_KEY);
		if (!code || !verifier) return;
		sessionStorage.removeItem(BROWSER_VERIFIER_KEY);
		url.searchParams.delete("code");
		history.replaceState(history.state, "", url);
		await exchangeCode(code, verifier);
	}
	void finishBrowserSignIn().catch((error) => console.error(error));

	return {
		name: "Firebase",
		auth: {
			getCurrentUser: async () => {
				const current = requireFirebase().auth.currentUser;
				return current ? profileFrom(current) : null;
			},
			async fileEditsAllowed() {
				const user = await requireUser();
				const snapshot = await getDocFromServer(doc(database(), "users", user.uid));
				return snapshot.data()?.allowFileEdits === true;
			},
			async setFileEdits(enabled) {
				if (enabled) {
					throw new Error("Turn this on from Settings so Google can ask for edit access.");
				}
				await api("/setDriveAccess", {
					method: "POST",
					body: JSON.stringify({ allowFileEdits: false }),
				});
			},
			async signIn(options) {
				const verifier = randomVerifier();
				const challenge = await codeChallenge(verifier);
				const installed = await installationId();
				const access = options?.write ? "write" : "readonly";
				const start = `${baseUrl()}/oauthStart?installation_id=${encodeURIComponent(installed)}&code_challenge=${encodeURIComponent(challenge)}&access=${access}`;
				if (!("__TAURI_INTERNALS__" in window)) {
					sessionStorage.setItem(BROWSER_VERIFIER_KEY, verifier);
					const returnTo = `${window.location.origin}${window.location.pathname}`;
					window.location.assign(`${start}&return_to=${encodeURIComponent(returnTo)}`);
					return new Promise<UserProfile>(() => {});
				}
				const code = new Promise<string>((resolve, reject) => {
					const timer = setTimeout(() => {
						pendingCode = undefined;
						reject(new Error("Google sign-in timed out."));
					}, 120_000);
					pendingCode = (value) => {
						clearTimeout(timer);
						pendingCode = undefined;
						resolve(value);
					};
				});
				const { openUrl } = await import("@tauri-apps/plugin-opener");
				await openUrl(start);
				return exchangeCode(await code, verifier);
			},
			signOut: () => signOut(requireFirebase().auth),
			onAuthChanged(listener) {
				return onAuthStateChanged(requireFirebase().auth, (user) =>
					listener(user ? profileFrom(user) : null),
				);
			},
		},
		drive: {
			async listDrives() {
				const result = await api<{ sources: Array<{ id: string; name: string; kind: string }> }>(
					"/driveSources",
				);
				const mapped = result.sources.map((source) => ({
					id: source.id,
					name: source.name,
					kind: (source.kind === "shared-drive"
						? "shared-drive"
						: source.kind === "shared-with-me"
							? "shared-with-me"
							: "my-drive") as DriveKind,
				}));
				drives.clear();
				for (const drive of mapped) drives.set(drive.id, drive);
				return mapped;
			},
			async listChildFolders(driveId, parentId) {
				const source = drives.get(driveId) ?? {
					id: driveId,
					name: driveId === "my-drive" ? "My Drive" : driveId,
					kind: driveId === "my-drive" ? "my-drive" : "shared-drive",
				} as DriveRoot;
				const params = new URLSearchParams({ sourceId: driveId });
				if (parentId) params.set("parentId", parentId);
				const result = await api<{
					folders: Array<{ id: string; name: string; parentIds?: string[]; driveId?: string }>;
				}>(`/driveFolders?${params}`);
				return result.folders.map((folder) => folderFromApi(folder, source));
			},
			async searchFolders(term) {
				const params = new URLSearchParams({ query: term });
				const result = await api<{
					folders: Array<{ id: string; name: string; parentIds?: string[]; driveId?: string }>;
				}>(`/driveFolders?${params}`);
				return result.folders.map((folder) =>
					folderFromApi(
						folder,
						drives.get(folder.driveId ?? "my-drive") ?? {
							id: folder.driveId ?? "my-drive",
							name:
								folder.driveId === "shared-with-me"
									? "Shared with me"
									: folder.driveId
										? "Shared drive"
										: "My Drive",
							kind:
								folder.driveId === "shared-with-me"
									? "shared-with-me"
									: folder.driveId
										? "shared-drive"
										: "my-drive",
						},
					),
				);
			},
		},
		watch: {
			async getWatchedFolders() {
				const user = await requireUser();
				const snapshot = await getDocs(collection(database(), "users", user.uid, "selections"));
				return snapshot.docs.map((item) => watchedFrom(item.id, item.data()));
			},
			async setWatchedFolders(folders) {
				const user = await requireUser();
				const current = await getDocs(collection(database(), "users", user.uid, "selections"));
				const batch = writeBatch(database());
				const keep = new Set(folders.map((folder) => folder.id));
				for (const item of current.docs) if (!keep.has(item.id)) batch.delete(item.ref);
				const now = new Date().toISOString();
				for (const folder of folders) {
					batch.set(doc(database(), "users", user.uid, "selections", folder.id), {
						folderId: folder.id,
						name: folder.name,
						sourceId: folder.driveId,
						sourceKind:
							folder.driveKind === "my-drive"
								? "user"
								: folder.driveKind === "shared-with-me"
									? "shared-with-me"
									: "shared-drive",
						driveName: folder.driveName,
						parentId: folder.parentId,
						path: folder.path,
						recursive: true,
						createdAt: now,
					});
				}
				await batch.commit();
				return folders.map((folder) => ({ ...folder, addedAt: now }));
			},
			async getMonitoring() {
				const user = await requireUser();
				const snapshot = await getDoc(doc(database(), "users", user.uid));
				return {
					paused: snapshot.get("monitoringPaused") === true,
					updatedAt: iso(snapshot.get("monitoringUpdatedAt")),
				} satisfies MonitoringSettings;
			},
			async setMonitoringPaused(paused) {
				const updatedAt = new Date().toISOString();
				await api("/setMonitoring", {
					method: "POST",
					body: JSON.stringify({ paused }),
				});
				return { paused, updatedAt };
			},
			async getSyncStatus() {
				const user = await requireUser();
				const snapshot = await getDoc(doc(database(), "users", user.uid, "status", "sync"));
				return syncFrom(snapshot.data());
			},
			async requestSync() {
				await api("/syncWatches", { method: "POST" });
				const user = await requireUser();
				const snapshot = await getDoc(doc(database(), "users", user.uid, "status", "sync"));
				return syncFrom(snapshot.data());
			},
			onSyncStatus(listener) {
				return listenWhenSignedIn((user, done) =>
					onSnapshot(doc(database(), "users", user.uid, "status", "sync"), (snapshot) => {
						done();
						listener(syncFrom(snapshot.data()));
					}),
				);
			},
		},
		notifications: {
			async listRecent(count) {
				const user = await requireUser();
				const snapshot = await getDocs(
					query(
						collection(database(), "users", user.uid, "notifications"),
						orderBy("createdAt", "desc"),
						limit(count),
					),
				);
				return snapshot.docs.map((item) => notificationFrom(item.id, item.data()));
			},
			async markRead(ids) {
				const user = await requireUser();
				await Promise.all(
					ids.map((id) =>
						updateDoc(doc(database(), "users", user.uid, "notifications", id), { read: true }),
					),
				);
			},
			async markAllRead() {
				const user = await requireUser();
				const snapshot = await getDocs(
					query(collection(database(), "users", user.uid, "notifications"), limit(50)),
				);
				await Promise.all(
					snapshot.docs.map((item) => updateDoc(item.ref, { read: true })),
				);
			},
			async clearRead() {
				const user = await requireUser();
				const snapshot = await getDocs(
					query(
						collection(database(), "users", user.uid, "notifications"),
						where("read", "==", true),
						limit(50),
					),
				);
				if (snapshot.empty) return;
				const batch = writeBatch(database());
				for (const item of snapshot.docs) batch.delete(item.ref);
				await batch.commit();
			},
			onNotification(listener): Unsubscribe {
				let primed = false;
				return listenWhenSignedIn((user) =>
					onSnapshot(
						query(
							collection(database(), "users", user.uid, "notifications"),
							orderBy("createdAt", "desc"),
							limit(50),
						),
						(snapshot) => {
							if (!primed) {
								primed = true;
								return;
							}
							for (const change of snapshot.docChanges()) {
								if (change.type !== "added") continue;
								const notification = notificationFrom(change.doc.id, change.doc.data());
								listener(notification);
								void notifyNative(
									`${label(notification.changeType)}: ${notification.fileName}`,
									[
										notification.actorName && `By ${notification.actorName}`,
										notification.ownerName && `Owner: ${notification.ownerName}`,
										`${notification.folderName} · ${formatDateTime(notification.occurredAt)}`,
									]
										.filter(Boolean)
										.join("\n"),
								);
							}
						},
					),
				);
			},
		},
	};
}

function listenWhenSignedIn(
	attach: (user: User, markReady: () => void) => Unsubscribe,
): Unsubscribe {
	let stop = () => {};
	let cancelled = false;
	void requireUser().then((user) => {
		if (cancelled) return;
		stop = attach(user, () => undefined);
	});
	return () => {
		cancelled = true;
		stop();
	};
}

function watchedFrom(id: string, data: Record<string, unknown>): WatchedFolder {
	const sourceId = String(data.sourceId ?? "my-drive");
	return {
		id,
		name: String(data.name ?? "Folder"),
		driveId: sourceId,
		driveName: String(
			data.driveName ??
				(sourceId === "my-drive"
					? "My Drive"
					: sourceId === "shared-with-me"
						? "Shared with me"
						: sourceId),
		),
		driveKind:
			data.sourceKind === "shared-drive"
				? "shared-drive"
				: data.sourceKind === "shared-with-me" || sourceId === "shared-with-me"
					? "shared-with-me"
					: "my-drive",
		parentId: typeof data.parentId === "string" ? data.parentId : null,
		path: Array.isArray(data.path) ? data.path.map(String) : [],
		hasChildren: true,
		addedAt: iso(data.createdAt),
	};
}

function syncFrom(data: Record<string, unknown> | undefined): SyncStatus {
	const channels = Array.isArray(data?.channels) ? (data.channels as WatchChannel[]) : [];
	return {
		state: (data?.state as SyncStatus["state"]) ?? "idle",
		lastSyncAt: typeof data?.lastSyncAt === "string" ? data.lastSyncAt : null,
		error: typeof data?.error === "string" ? data.error : null,
		channels,
	};
}

function label(change: ChangeType): string {
	if (change === "created") return "Added";
	if (change === "deleted") return "Removed";
	if (change === "moved") return "Moved";
	return "Changed";
}
