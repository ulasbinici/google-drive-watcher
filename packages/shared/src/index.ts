export const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

export type DriveSource =
  | { kind: "user"; id: "my-drive"; name: "My Drive" }
  | { kind: "shared-with-me"; id: "shared-with-me"; name: "Shared with me" }
  | { kind: "shared-drive"; id: string; name: string };

export interface FolderNode {
  id: string;
  name: string;
  parentIds: string[];
  driveId?: string;
  hasChildren?: boolean;
}

export interface FolderSelection {
  folderId: string;
  name: string;
  sourceId: string;
  sourceKind: DriveSource["kind"];
  recursive: true;
  createdAt: string;
}

export type ChangeKind =
  | "created"
  | "updated"
  | "moved"
  | "deleted"
  | "permission";

export interface DriveChangeEvent {
  id: string;
  userId: string;
  fileId: string;
  fileName: string;
  mimeType?: string;
  kind: ChangeKind;
  sourceId: string;
  selectedFolderId: string;
  occurredAt: string;
  parentIds: string[];
  previousParentIds?: string[];
  removed: boolean;
}

export interface WatchChannel {
  id: string;
  resourceId: string;
  resourceUri: string;
  userId: string;
  sourceId: string;
  driveId?: string;
  tokenHash: string;
  pageToken: string;
  expiration: string;
  active: boolean;
}

export interface OAuthStartRequest {
  installationId: string;
  codeChallenge: string;
  redirectUri: string;
}

export interface OAuthSession {
  uid: string;
  customToken: string;
  displayName: string;
  email: string;
  picture?: string;
}

export interface ApiErrorBody {
  error: string;
  message: string;
}
