<script lang="ts">
	import AppHeader from '$lib/components/AppHeader.svelte';
	import FolderTree from '$lib/components/FolderTree.svelte';
	import NotificationList from '$lib/components/NotificationList.svelte';
	import SelectionBar from '$lib/components/SelectionBar.svelte';
	import SignInPanel from '$lib/components/SignInPanel.svelte';
	import StatusBlock from '$lib/components/StatusBlock.svelte';
	import FolderSyncPanel from '$lib/components/FolderSyncPanel.svelte';
	import SyncStatus from '$lib/components/SyncStatus.svelte';
	import { getAppState } from '$lib/state/app-state.svelte';

	const app = getAppState();
	const signedIn = $derived(app.authStatus === 'signed-in' || app.authStatus === 'signing-out');
</script>

{#if app.authStatus === 'initializing'}
	<main class="gate">
		<StatusBlock
			kind="loading"
			title="Checking your session"
			message="Looking for an existing Google sign-in."
		/>
	</main>
{:else if !signedIn}
	<main>
		<SignInPanel />
	</main>
{:else}
	<div class="shell">
		<AppHeader />
		<main class="workspace">
			{#if app.authError}
				<p class="banner" role="alert">{app.authError}</p>
			{/if}
			<div class="primary">
				<FolderTree />
				<SelectionBar />
			</div>
			<div class="secondary">
				<SyncStatus />
				<FolderSyncPanel />
				<NotificationList />
			</div>
		</main>
	</div>
{/if}

<style>
	.gate {
		display: grid;
		min-height: 100vh;
		place-items: center;
		padding: 1.5rem;
	}

	.shell {
		display: flex;
		flex-direction: column;
		height: 100vh;
		height: 100dvh;
		min-height: 0;
	}

	.workspace {
		display: grid;
		grid-template-columns: minmax(0, 1.45fr) minmax(16rem, 0.85fr);
		gap: 1rem;
		align-items: stretch;
		flex: 1;
		width: 100%;
		min-height: 0;
		padding: 1rem 1.25rem 1.25rem;
	}

	.primary,
	.secondary {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
		min-height: 0;
	}

	.primary {
		overflow: hidden;
	}

	.secondary {
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	.secondary :global(.fill) {
		flex: none;
	}

	.banner {
		grid-column: 1 / -1;
		margin: 0;
		padding: 0.65rem 0.85rem;
		border-radius: var(--radius-sm);
		background: var(--danger-soft);
		color: var(--danger);
		font-size: 0.875rem;
	}

	@media (max-width: 900px) {
		.workspace {
			grid-template-columns: 1fr;
			grid-template-rows: minmax(0, 1.1fr) minmax(0, 1fr);
			padding: 0.875rem 1rem 1.5rem;
		}
	}
</style>
