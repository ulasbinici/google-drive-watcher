<script lang="ts">
	import { page } from '$app/state';
	import BrowseApp from '$lib/browser/BrowseApp.svelte';
	import FoldersApp from '$lib/components/FoldersApp.svelte';
	import { isBrowseShell, isFoldersShell } from '$lib/native';
	import { createBackend } from '$lib/services';
	import { AppState, setAppState } from '$lib/state/app-state.svelte';
	import { SyncManager, setSyncManager } from '$lib/sync/sync-manager.svelte';
	import type { Snippet } from 'svelte';
	import '../app.css';

	let { children }: { children: Snippet } = $props();

	// Desktop Browse and Folders windows load index.html and mark themselves before scripts run.
	// Opening /browse or /folders directly (the dev server) still uses the route.
	const embedBrowse = isBrowseShell();
	const embedFolders = isFoldersShell();
	const browseWindow = embedBrowse || page.url.pathname.startsWith('/browse');
	const foldersWindow = embedFolders || page.url.pathname.startsWith('/folders');

	// Folders builds its own AppState inside FoldersApp. Only the main window watches Drive and runs syncs.
	if (!browseWindow && !foldersWindow) {
		const app = new AppState(createBackend());
		setAppState(app);
		const sync = new SyncManager();
		setSyncManager(sync);

		// Subscribe during init. start() writes state, so it must not run inside an effect.
		const stop = app.start();
		const stopSync = sync.start();
		const stopTray = listenForTray(app, sync);

		$effect(() => stop);
		$effect(() => stopSync);
		$effect(() => stopTray);
	}

	function listenForTray(state: AppState, sync: SyncManager): () => void {
		const unlistens: Array<() => void> = [];
		let cancelled = false;

		void (async () => {
			try {
				const { listen } = await import('@tauri-apps/api/event');
				if (cancelled) return;
				const offs = await Promise.all([
					listen('tray-toggle-monitoring', () => {
						void state.setPaused(!state.isPaused);
					}),
					listen('tray-toggle-sync', () => {
						void sync.setPaused(!sync.paused);
					}),
					listen('tray-sync-now', () => {
						sync.request(null, true);
					})
				]);
				if (cancelled) {
					for (const off of offs) off();
					return;
				}
				unlistens.push(...offs);
			} catch {
				// Browser dev, or the Tauri event API failed to load.
			}
		})();

		return () => {
			cancelled = true;
			for (const off of unlistens) off();
			unlistens.length = 0;
		};
	}
</script>

<svelte:head>
	<title
		>{browseWindow
			? 'Drive Watch – Browse'
			: foldersWindow
				? 'Drive Watch – Folders'
				: 'Drive Watch'}</title
	>
</svelte:head>

{#if embedBrowse}
	<BrowseApp />
{:else if embedFolders}
	<FoldersApp />
{:else}
	{@render children()}
{/if}
