import { createContext } from 'svelte';
import { driveAvailable, startChangeToken } from '$lib/drive/drive-api';
import { errorMessage } from '$lib/format';
import { APP_EVENTS, listenAppEvent, setTrayControls, setTrayStatus, watchSyncRoots } from '$lib/native';
import { notifyNative } from '$lib/services/native-notify';
import { signedInUser } from '$lib/services/firebase-backend';
import { describeResult, pairNeedsFullSync, syncDriveChanges, syncPair, type SyncResult } from './sync-engine';
import {
	clearDriveCursor,
	DEFAULT_SYNC_INTERVAL_MINUTES,
	loadDriveCursor,
	loadPairs,
	loadSyncSettings,
	removePair,
	saveDriveCursor,
	saveSyncSettings,
	updatePairStatus,
	upsertPair,
	type SyncDirection,
	type SyncPair
} from './sync-store';

const FIRST_RUN_DELAY_MS = 15_000;

/** Runs folder syncs in the main window, which stays alive in the tray. */
export class SyncManager {
	pairs = $state<SyncPair[]>([]);
	runningId = $state<string | null>(null);
	progress = $state<string | null>(null);
	paused = $state(false);
	intervalMinutes = $state(DEFAULT_SYNC_INTERVAL_MINUTES);
	mirrorDeletes = $state(false);
	#queue: Array<{ id: string | null; full: boolean }> = [];
	#dirty: Record<string, string[]> = {};
	#draining = false;
	#cancel = false;
	#timer: ReturnType<typeof setInterval> | null = null;
	#first: ReturnType<typeof setTimeout> | null = null;

	start(): () => void {
		let cancelled = false;
		void this.#boot().then(() => {
			if (cancelled) return;
			this.#first = setTimeout(() => this.request(null), FIRST_RUN_DELAY_MS);
			this.#arm();
		});
		const offPairs = listenAppEvent(APP_EVENTS.syncPairsChanged, () => void this.reload());
		const offRun = listenAppEvent<{ id: string | null; full?: boolean } | null>(
			APP_EVENTS.syncRun,
			(payload) => this.request(payload?.id ?? null, payload?.full === true)
		);
		const offDirty = listenAppEvent<{ id: string; paths: string[] }>(APP_EVENTS.localSyncDirty, (payload) => {
			if (!payload?.id || this.paused) return;
			this.#noteDirty(payload.id, payload.paths ?? []);
			this.request(payload.id);
		});
		return () => {
			cancelled = true;
			offPairs();
			offRun();
			offDirty();
			if (this.#first) clearTimeout(this.#first);
			if (this.#timer) clearInterval(this.#timer);
		};
	}

	async setPaused(paused: boolean) {
		this.paused = paused;
		this.#cancel = paused;
		this.paused = (await saveSyncSettings({ paused })).paused;
		await this.#refreshTray();
		await setTrayStatus(this.paused ? 'Sync paused' : 'Drive Watch').catch(() => undefined);
	}

	async setIntervalMinutes(minutes: number) {
		this.intervalMinutes = (await saveSyncSettings({ intervalMinutes: minutes })).intervalMinutes;
		this.#arm();
	}

	async setMirrorDeletes(enabled: boolean) {
		this.mirrorDeletes = (await saveSyncSettings({ mirrorDeletes: enabled })).mirrorDeletes;
	}

	async reload() {
		this.pairs = await loadPairs().catch(() => this.pairs);
		await this.#refreshTray();
		await watchSyncRoots(this.pairs.map((pair) => ({ id: pair.id, path: pair.localPath }))).catch(
			() => undefined
		);
	}

	/** `manual` runs a full compare even while the schedule is paused. Pause still stops a run already in progress. */
	request(id: string | null, manual = false) {
		if (!manual && this.paused) return;
		if (manual) this.#cancel = false;
		const full = manual;
		if (this.#queue.some((item) => item.full === full && item.id === null)) return;
		if (id === null) this.#queue = this.#queue.filter((item) => item.full !== full);
		else if (this.#queue.some((item) => item.full === full && item.id === id)) return;
		this.#queue.push({ id, full });
		void this.#drain();
	}

	async remove(id: string) {
		await removePair(id);
		await this.reload();
	}

	async setDirection(pair: SyncPair, direction: SyncDirection) {
		await upsertPair({ ...pair, direction });
		await this.reload();
		this.request(pair.id, true);
	}

	async #drain() {
		if (this.#draining) return;
		this.#draining = true;
		try {
			while (this.#queue.length) {
				const item = this.#queue.shift()!;
				if (!driveAvailable() || !(await signedInUser().catch(() => null))) continue;
				await this.reload();
				const selected = item.id ? this.pairs.filter((pair) => pair.id === item.id) : this.pairs;
				if (item.full) {
					for (const pair of selected) await this.#run(pair);
					continue;
				}
				const driveKeys: Record<string, true> = {};
				for (const pair of selected) driveKeys[pair.driveId ?? ''] = true;
				const groups: Record<string, SyncPair[]> = {};
				for (const pair of this.pairs) {
					const key = pair.driveId ?? '';
					if (!driveKeys[key]) continue;
					(groups[key] ??= []).push(pair);
				}
				for (const group of Object.values(groups)) await this.#runIncremental(group);
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
			if (!(await loadDriveCursor(pair.driveId))) {
				await saveDriveCursor(pair.driveId, { pageToken: await startChangeToken(pair.driveId) });
			}
			const result = await syncPair(
				pair,
				(message) => {
					this.progress = message;
					void setTrayStatus(`${pair.driveFolderName}: ${message}`).catch(() => undefined);
				},
				() => this.#cancel,
				{ mirrorDeletes: this.mirrorDeletes }
			);
			if (result.stopped && result.uploaded + result.downloaded + result.removed + result.failed === 0) {
				await setTrayStatus('Sync paused').catch(() => undefined);
				return;
			}
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
			await setTrayStatus(
				result.stopped ? 'Sync paused' : `Drive Watch — ${summary}`
			).catch(() => undefined);
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

	async #runIncremental(group: SyncPair[]) {
		const due: SyncPair[] = [];
		for (const pair of group) {
			if (await pairNeedsFullSync(pair)) due.push(pair);
		}
		for (const pair of due) {
			this.#takeDirty(pair.id);
			await this.#run(pair);
			if (this.#cancel) return;
		}
		const dirty: Record<string, string[]> = {};
		for (const pair of group) dirty[pair.id] = this.#takeDirty(pair.id);
		const driveId = group[0]?.driveId ?? null;
		try {
			const outcome = await syncDriveChanges(
				group,
				dirty,
				(pair, message) => {
					this.runningId = pair.id;
					this.progress = message;
					void setTrayStatus(`${pair.driveFolderName}: ${message}`).catch(() => undefined);
				},
				() => this.#cancel,
				{ mirrorDeletes: this.mirrorDeletes }
			);
			if (outcome.expired) {
				await clearDriveCursor(driveId);
				for (const pair of group) await this.#run(pair);
				return;
			}
			for (const { pair, result } of outcome.results) await this.#publish(pair, result);
		} catch (error) {
			const message = errorMessage(error);
			await setTrayStatus(`Sync failed: ${message}`).catch(() => undefined);
			const pair = group[0];
			if (pair) await notifyNative(`${pair.driveFolderName}: sync failed`, message);
		} finally {
			this.runningId = null;
			this.progress = null;
			await this.reload();
		}
	}

	async #publish(pair: SyncPair, result: SyncResult) {
		if (result.stopped && result.uploaded + result.downloaded + result.removed + result.failed === 0) {
			await setTrayStatus('Sync paused').catch(() => undefined);
			return;
		}
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
		await setTrayStatus(result.stopped ? 'Sync paused' : `Drive Watch — ${summary}`).catch(() => undefined);
		const notice = syncNotice(pair.driveFolderName, result);
		if (notice) await notifyNative(notice.title, notice.body);
	}

	#noteDirty(id: string, paths: string[]) {
		const list = this.#dirty[id] ?? [];
		for (const path of paths) {
			if (!list.includes(path)) list.push(path);
		}
		this.#dirty[id] = list;
	}

	#takeDirty(id: string): string[] {
		const list = this.#dirty[id] ?? [];
		delete this.#dirty[id];
		return list;
	}

	async #boot() {
		const settings = await loadSyncSettings().catch(() => null);
		if (settings) {
			this.paused = settings.paused;
			this.#cancel = settings.paused;
			this.intervalMinutes = settings.intervalMinutes;
			this.mirrorDeletes = settings.mirrorDeletes;
		}
		await this.reload();
	}

	#arm() {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = setInterval(() => this.request(null), this.intervalMinutes * 60_000);
	}

	async #refreshTray() {
		await setTrayControls(this.paused, this.pairs.length > 0).catch(() => undefined);
	}
}

const NOTICE_FILES = 8;

/** One toast when a run actually copied or failed. An unchanged folder stays quiet. */
function syncNotice(
	folderName: string,
	result: SyncResult
): { title: string; body: string } | null {
	const changed = result.uploaded + result.downloaded + result.removed;
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
