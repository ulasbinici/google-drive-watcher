import type {
	DriveFolder,
	DriveNotification,
	DriveRoot,
	MonitoringSettings,
	SyncStatus,
	UserProfile,
	WatchedFolder
} from '$lib/types';

export type Unsubscribe = () => void;

export interface RequestOptions {
	signal?: AbortSignal;
}

/** Google sign-in, e.g. backed by Firebase Auth with the Google provider. */
export interface AuthAdapter {
	getCurrentUser(): Promise<UserProfile | null>;
	signIn(options?: { write?: boolean }): Promise<UserProfile>;
	fileEditsAllowed(): Promise<boolean>;
	setFileEdits(enabled: boolean): Promise<void>;
	signOut(): Promise<void>;
	onAuthChanged(listener: (user: UserProfile | null) => void): Unsubscribe;
}

/** Folder browsing, e.g. a backend proxy over the Drive `files.list` / `drives.list` APIs. */
export interface DriveAdapter {
	listDrives(options?: RequestOptions): Promise<DriveRoot[]>;
	/** `parentId === null` lists the top-level folders of the drive. */
	listChildFolders(
		driveId: string,
		parentId: string | null,
		options?: RequestOptions
	): Promise<DriveFolder[]>;
	searchFolders(query: string, options?: RequestOptions): Promise<DriveFolder[]>;
}

/** Watch list, pause state and push-channel health, e.g. Firestore documents + Cloud Functions. */
export interface WatchAdapter {
	getWatchedFolders(): Promise<WatchedFolder[]>;
	setWatchedFolders(folders: DriveFolder[]): Promise<WatchedFolder[]>;
	getMonitoring(): Promise<MonitoringSettings>;
	setMonitoringPaused(paused: boolean): Promise<MonitoringSettings>;
	getSyncStatus(): Promise<SyncStatus>;
	requestSync(): Promise<SyncStatus>;
	onSyncStatus(listener: (status: SyncStatus) => void): Unsubscribe;
}

/** Change notifications, e.g. a Firestore collection fed by Drive `changes.watch` webhooks. */
export interface NotificationAdapter {
	listRecent(limit: number): Promise<DriveNotification[]>;
	markRead(ids: string[]): Promise<void>;
	markAllRead(): Promise<void>;
	clearRead(): Promise<void>;
	onNotification(listener: (notification: DriveNotification) => void): Unsubscribe;
}

export interface DriveNotifierBackend {
	readonly name: string;
	readonly auth: AuthAdapter;
	readonly drive: DriveAdapter;
	readonly watch: WatchAdapter;
	readonly notifications: NotificationAdapter;
}
