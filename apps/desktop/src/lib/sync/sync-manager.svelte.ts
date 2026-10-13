import { createContext } from 'svelte';
import { driveAvailable } from '$lib/drive/drive-api';
import { errorMessage } from '$lib/format';
import { APP_EVENTS, listenAppEvent, setTrayStatus } from '$lib/native';
import { notifyNative } from '$lib/services/native-notify';
import { signedInUser } from '$lib/services/firebase-backend';
import { describeResult, syncPair, type SyncResult } from './sync-engine';
import {
	loadPairs,
	removePair,
	updatePairStatus,
	upsertPair,
	type SyncDirection,
	type SyncPair
} from './sync-store';

const SYNC_INTERVAL_MS = 5 * 60_000;
const FIRST_RUN_DELAY_MS = 15_000;

/** Runs folder syncs in the main window, which stays alive in the tray. */
export class SyncManager {
	pairs = $state<SyncPair[]>([]);
	runningId = $state<string | null>(null);
	progress = $state<string | null>(null);
	#queue: Array<string | null> = [];
	#draining = false;

	start(): () => void {
		void this.reload();
		const offPairs = listenAppEvent(APP_EVENTS.syncPairsChanged, () => void this.reload());
		const offRun = listenAppEvent<{ id: string | null } | null>(APP_EVENTS.syncRun, (payload) =>
			this.request(payload?.id ?? null)
		);
		const first = setTimeout(() => this.request(null), FIRST_RUN_DELAY_MS);
		const timer = setInterval(() => this.request(null), SYNC_INTERVAL_MS);
		return () => {
			offPairs();
			offRun();
			clearTimeout(first);
			clearInterval(timer);
		};
	}

	async reload() {
		this.pairs = await loadPairs().catch(() => this.pairs);
	}

	request(id: string | null) {
		if (this.#queue.includes(id) || this.#queue.includes(null)) return;
		this.#queue.push(id);
		void this.#drain();
	}

	async remove(id: string) {
		await removePair(id);
		await this.reload();
	}

	async setDirection(pair: SyncPair, direction: SyncDirection) {
		await upsertPair({ ...pair, direction });
		await this.reload();
		this.request(pair.id);
	}

	async #drain() {
		if (this.#draining) return;
		this.#draining = true;
		try {
			while (this.#queue.length) {
				const id = this.#queue.shift()!;
				if (!driveAvailable() || !(await signedInUser().catch(() => null))) continue;
				await this.reload();
				const targets = id ? this.pairs.filter((p) => p.id === id) : this.pairs;
				for (const pair of targets) await this.#run(pair);
			}
		} finally {
			this.#draining = false;
		}
	}

	async #run(pair: SyncPair) {
		this.runningId = pair.id;
		this.progress = 'Starting…';
		await setTrayStatus(`Syncing ${pair.driveFolderName}…`).catch(() => undefined);
		try {
			const result = await syncPair(pair, (message) => {
				this.progress = message;
				void setTrayStatus(`${pair.driveFolderName}: ${message}`).catch(() => undefined);
			});
			let lastError = result.firstError;
			if (result.needsEditAccess) {
				lastError ??= 'Local changes were not uploaded. Turn on “Allow file upload and edit”.';
			}
			const summary = describeResult(result);
			await updatePairStatus(pair.id, {
				lastSyncAt: new Date().toISOString(),
				lastSummary: summary,
				lastError
			});
			await setTrayStatus(`Drive Watch — ${summary}`).catch(() => undefined);
			const notice = syncNotice(pair.driveFolderName, result);
			if (notice) await notifyNative(notice.title, notice.body);
		} catch (error) {
			const message = errorMessage(error);
			await updatePairStatus(pair.id, {
				lastSyncAt: new Date().toISOString(),
				lastError: message
			});
			await setTrayStatus(`Sync failed: ${message}`).catch(() => undefined);
			await notifyNative(`${pair.driveFolderName}: sync failed`, message);
		} finally {
			this.runningId = null;
			this.progress = null;
			await this.reload();
		}
	}
}

const NOTICE_FILES = 8;

/** One toast when a run actually copied or failed. An unchanged folder stays quiet. */
function syncNotice(
	folderName: string,
	result: SyncResult
): { title: string; body: string } | null {
	const changed = result.uploaded + result.downloaded;
	if (changed === 0 && result.failed === 0) return null;
	const lines = result.files.slice(0, NOTICE_FILES);
	if (result.files.length > NOTICE_FILES) {
		lines.push(`and ${result.files.length - NOTICE_FILES} more`);
	}
	lines.push(describeResult(result));
	if (result.firstError) lines.push(result.firstError);
	return {
		title: result.failed ? `${folderName}: sync finished with errors` : `${folderName}: sync finished`,
		body: lines.join('\n')
	};
}

export const [getSyncManager, setSyncManager] = createContext<SyncManager>();
