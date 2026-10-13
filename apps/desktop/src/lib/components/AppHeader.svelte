<script lang="ts">
	import { initials } from '$lib/format';
	import { openBrowseWindow, openFoldersWindow } from '$lib/native';
	import { getAppState } from '$lib/state/app-state.svelte';
	import Icon from './Icon.svelte';
	import SettingsDialog from './SettingsDialog.svelte';
	import Spinner from './Spinner.svelte';

	const app = getAppState();

	const connection = $derived.by(() => {
		switch (app.authStatus) {
			case 'initializing':
				return { tone: 'neutral', label: 'Checking session…' };
			case 'signing-in':
				return { tone: 'accent', label: 'Connecting…' };
			case 'signing-out':
				return { tone: 'neutral', label: 'Signing out…' };
			case 'signed-in':
				return app.isPaused
					? { tone: 'warning', label: 'Connected · paused' }
					: { tone: 'success', label: 'Connected' };
			default:
				return { tone: 'danger', label: 'Not connected' };
		}
	});
</script>

<header class="header">
	<div class="brand">
		<span class="logo"><Icon name="bell" size={20} /></span>
		<div>
			<h1>Drive Watch</h1>
			<p class="muted">Desktop alerts for changes in your Google Drive folders</p>
		</div>
	</div>

	<div class="account">
		<span class="badge connection" data-tone={connection.tone} role="status" aria-live="polite">
			<span class="dot" aria-hidden="true"></span>
			{connection.label}
		</span>
		<span class="badge adapter" title="Active backend adapter">{app.backend.name}</span>

		{#if app.user}
			<div class="user">
				{#if app.user.photoUrl}
					<img class="avatar" src={app.user.photoUrl} alt="" referrerpolicy="no-referrer" />
				{:else}
					<span class="avatar" aria-hidden="true">{initials(app.user.displayName)}</span>
				{/if}
				<div class="who">
					<span class="name">{app.user.displayName}</span>
					<span class="email muted">{app.user.email}</span>
				</div>
			</div>
			<button type="button" class="btn btn-sm btn-primary" onclick={() => void openBrowseWindow()}>
				<Icon name="folder" size={15} />
				Browse
			</button>
			<button
				type="button"
				class="btn btn-sm"
				title="Choose which Drive folders to watch"
				onclick={() => void openFoldersWindow()}
			>
				<Icon name="eye" size={15} />
				Watch
			</button>
			<button type="button" class="btn btn-sm" onclick={() => (app.settingsOpen = true)}>
				<Icon name="settings" size={15} />
				Settings
			</button>
			<SettingsDialog />
			<button
				type="button"
				class="btn btn-sm"
				onclick={() => app.signOut()}
				disabled={app.authStatus === 'signing-out'}
			>
				{#if app.authStatus === 'signing-out'}
					<Spinner size={14} />
				{:else}
					<Icon name="logout" size={15} />
				{/if}
				Sign out
			</button>
		{/if}
	</div>
</header>

<style>
	.header {
		display: flex;
		flex-shrink: 0;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.85rem 1.25rem;
		background: var(--surface);
		border-bottom: 1px solid var(--border);
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-width: 0;
	}

	.brand h1 {
		font-size: 1.125rem;
		font-weight: 700;
		letter-spacing: -0.01em;
	}

	.brand p {
		font-size: 0.85rem;
	}

	.logo {
		display: grid;
		place-items: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 12px;
		background: var(--accent);
		color: #fff;
	}

	.account {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
	}

	.connection .dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: currentColor;
	}

	.user {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		min-width: 0;
	}

	.avatar {
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		background: var(--accent-soft);
		color: var(--accent);
		font-size: 0.8rem;
		font-weight: 700;
		object-fit: cover;
	}

	.who {
		display: flex;
		flex-direction: column;
		line-height: 1.2;
		min-width: 0;
	}

	.name {
		font-weight: 600;
		font-size: 0.9rem;
	}

	.email {
		font-size: 0.78rem;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	@media (max-width: 640px) {
		.header {
			padding: 0.875rem 1rem;
		}

		.adapter,
		.who {
			display: none;
		}
	}
</style>
