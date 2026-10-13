<script lang="ts">
	import { isTauri } from '$lib/native';
	import { createBackend } from '$lib/services';
	import { AppState, setAppState } from '$lib/state/app-state.svelte';
	import FolderTree from './FolderTree.svelte';
	import Icon from './Icon.svelte';
	import SelectionBar from './SelectionBar.svelte';
	import SignInPanel from './SignInPanel.svelte';
	import StatusBlock from './StatusBlock.svelte';

	const app = new AppState(createBackend());
	setAppState(app);

	// Own session: auth and folder/watch state, without the notification listener.
	// start() writes state, so it runs during init rather than inside an effect.
	const stop = app.start({ notifications: false });
	$effect(() => stop);

	const signedIn = $derived(app.authStatus === 'signed-in' || app.authStatus === 'signing-out');

	async function closeWindow() {
		if (!isTauri()) {
			window.close();
			return;
		}
		const { getCurrentWindow } = await import('@tauri-apps/api/window');
		await getCurrentWindow().close();
	}
</script>

<div class="shell">
	<header class="header">
		<div>
			<h1>Watch</h1>
			<p class="muted">Choose which Drive folders to watch</p>
		</div>
		<button type="button" class="btn btn-sm" onclick={() => void closeWindow()}>
			<Icon name="close" size={15} />
			Close
		</button>
	</header>

	{#if app.authStatus === 'initializing'}
		<main class="gate">
			<StatusBlock
				kind="loading"
				title="Checking your session"
				message="Looking for an existing Google sign-in."
			/>
		</main>
	{:else if !signedIn}
		<main class="gate">
			<SignInPanel />
		</main>
	{:else}
		<main class="workspace">
			{#if app.authError}
				<p class="banner" role="alert">{app.authError}</p>
			{/if}
			<FolderTree />
			<SelectionBar />
		</main>
	{/if}
</div>

<style>
	.shell {
		display: flex;
		flex-direction: column;
		height: 100vh;
		height: 100dvh;
		min-height: 0;
	}

	.header {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.75rem 1.1rem;
		background: var(--surface);
		border-bottom: 1px solid var(--border);
	}

	.header h1 {
		font-size: 1.05rem;
		font-weight: 700;
		letter-spacing: -0.01em;
	}

	.header p {
		font-size: 0.82rem;
	}

	.gate {
		display: grid;
		flex: 1;
		place-items: center;
		min-height: 0;
		overflow: auto;
		padding: 1.5rem 1.1rem;
	}

	.gate :global(.panel) {
		margin: 0;
	}

	.workspace {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 1rem;
		min-height: 0;
		padding: 1rem 1.1rem 1.1rem;
		overflow: hidden;
	}

	.banner {
		flex-shrink: 0;
		margin: 0;
		padding: 0.65rem 0.85rem;
		border-radius: var(--radius-sm);
		background: var(--danger-soft);
		color: var(--danger);
		font-size: 0.875rem;
	}
</style>
