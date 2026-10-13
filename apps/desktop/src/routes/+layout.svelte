<script lang="ts">
	import { page } from '$app/state';
	import BrowseApp from '$lib/browser/BrowseApp.svelte';
	import { isBrowseShell } from '$lib/native';
	import { createBackend } from '$lib/services';
	import { AppState, setAppState } from '$lib/state/app-state.svelte';
	import { SyncManager, setSyncManager } from '$lib/sync/sync-manager.svelte';
	import type { Snippet } from 'svelte';
	import '../app.css';

	let { children }: { children: Snippet } = $props();

	// The desktop Browse window loads index.html and marks itself before scripts run.
	// Opening /browse directly (the dev server) still uses the route.
	const embedBrowse = isBrowseShell();
	const browseWindow = embedBrowse || page.url.pathname.startsWith('/browse');

	// The Browse window builds its own state; only the main window watches Drive and runs syncs.
	if (!browseWindow) {
		const app = new AppState(createBackend());
		setAppState(app);
		const sync = new SyncManager();
		setSyncManager(sync);

		// Subscribe during init. start() writes state, so it must not run inside an effect.
		const stop = app.start();
		const stopSync = sync.start();
		const stopTray = listenForTrayToggle(app);

		$effect(() => stop);
		$effect(() => stopSync);
		$effect(() => stopTray);
	}

	function listenForTrayToggle(state: AppState): () => void {
		let unlisten: (() => void) | undefined;
		let cancelled = false;

		void (async () => {
			try {
				const { listen } = await import('@tauri-apps/api/event');
				if (cancelled) return;
				const off = await listen('tray-toggle-monitoring', () => {
					void state.setPaused(!state.isPaused);
				});
				if (cancelled) off();
				else unlisten = off;
			} catch {
				// Browser dev, or the Tauri event API failed to load.
			}
		})();

		return () => {
			cancelled = true;
			unlisten?.();
			unlisten = undefined;
		};
	}
</script>

<svelte:head>
	<title>{browseWindow ? 'Drive Watch – Browse' : 'Drive Watch'}</title>
</svelte:head>

{#if embedBrowse}
	<BrowseApp />
{:else}
	{@render children()}
{/if}
