export type DriveKind = 'my-drive' | 'shared-with-me' | 'shared-drive';

export interface DriveRoot {
	id: string;
	name: string;
	kind: DriveKind;
}

export interface DriveFolder {
	id: string;
	name: string;
	driveId: string;
	driveName: string;
	driveKind: DriveKind;
	parentId: string | null;
	/** Ancestor folder names, excluding the drive root and the folder itself. */
	path: string[];
	hasChildren: boolean;
}

export interface WatchedFolder extends DriveFolder {
	addedAt: string;
}

export interface UserProfile {
	uid: string;
	email: string;
	displayName: string;
	photoUrl: string | null;
}

export type AuthStatus = 'initializing' | 'signed-out' | 'signing-in' | 'signed-in' | 'signing-out';

export type ChannelState = 'active' | 'renewing' | 'expired' | 'error';

export interface WatchChannel {
	id: string;
	driveId: string;
	driveName: string;
	state: ChannelState;
	expiresAt: string;
	lastEventAt: string | null;
	error: string | null;
}

export type SyncState = 'idle' | 'syncing' | 'paused' | 'error';

export interface SyncStatus {
	state: SyncState;
	lastSyncAt: string | null;
	error: string | null;
	channels: WatchChannel[];
}

export interface MonitoringSettings {
	paused: boolean;
	updatedAt: string;
}

export type ChangeType = 'created' | 'modified' | 'deleted' | 'moved' | 'renamed' | 'shared';

export interface DriveNotification {
	id: string;
	fileId: string;
	fileName: string;
	mimeType: string;
	folderId: string;
	folderName: string;
	driveName: string;
	changeType: ChangeType;
	actorName: string | null;
	ownerName: string | null;
	occurredAt: string;
	read: boolean;
	webViewLink: string | null;
}

/** Server notification plus local-only pin and note. Those two fields are never written to Firestore. */
export interface NotificationView extends DriveNotification {
	pinned: boolean;
	note: string;
}

export type Loadable<T> =
	| { status: 'idle' }
	| { status: 'loading'; data?: T }
	| { status: 'ready'; data: T }
	| { status: 'error'; error: string; data?: T };
