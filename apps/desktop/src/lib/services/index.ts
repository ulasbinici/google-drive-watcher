import type { DriveNotifierBackend } from './backend';
import { createFirebaseBackend, firebaseConfigured } from './firebase-backend';
import { createMockBackend } from './mock-backend';

export type * from './backend';

/** Uses Firebase when the desktop environment is configured, otherwise the local demo backend. */
export function createBackend(): DriveNotifierBackend {
	return firebaseConfigured() ? createFirebaseBackend() : createMockBackend();
}
