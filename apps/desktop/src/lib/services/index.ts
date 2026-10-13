import { dev } from '$app/environment';
import type { DriveNotifierBackend } from './backend';
import { createFirebaseBackend, firebaseConfigured } from './firebase-backend';
import { createMockBackend } from './mock-backend';

export type * from './backend';

function demoRequested(): boolean {
	return dev && typeof location !== 'undefined' && new URLSearchParams(location.search).has('demo');
}

/** Uses Firebase when the desktop environment is configured, otherwise the local demo backend. */
export function createBackend(): DriveNotifierBackend {
	return !demoRequested() && firebaseConfigured() ? createFirebaseBackend() : createMockBackend();
}
