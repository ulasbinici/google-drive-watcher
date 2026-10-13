<script lang="ts">
	import { getAppState } from '$lib/state/app-state.svelte';
	import Icon, { type IconName } from './Icon.svelte';
	import Spinner from './Spinner.svelte';

	const app = getAppState();
	const signingIn = $derived(app.authStatus === 'signing-in');

	const features: { icon: IconName; title: string; text: string }[] = [
		{ icon: 'folder', title: 'Pick folders', text: 'Watch folders in My Drive and Shared drives.' },
		{ icon: 'bell', title: 'Get notified', text: 'Tray alerts when files are added, edited or shared.' },
		{ icon: 'pause', title: 'Stay in control', text: 'Pause monitoring any time without losing setup.' }
	];
</script>

<section class="card panel" aria-labelledby="sign-in-title">
	<div class="hero">
		<span class="hero-icon"><Icon name="drive" size={28} /></span>
		<h2 id="sign-in-title">Connect your Google Drive</h2>
		<p class="muted">
			Sign in with Google to choose folders to monitor. We only request read-only access to folder
			metadata and change events.
		</p>
	</div>

	<ul class="features">
		{#each features as feature (feature.title)}
			<li>
				<span class="feature-icon"><Icon name={feature.icon} size={18} /></span>
				<div>
					<p class="feature-title">{feature.title}</p>
					<p class="muted">{feature.text}</p>
				</div>
			</li>
		{/each}
	</ul>

	{#if app.authError}
		<p class="error" role="alert"><Icon name="warning" size={16} /> {app.authError}</p>
	{/if}

	<button
		type="button"
		class="btn google"
		onclick={() => app.signIn()}
		disabled={signingIn}
		aria-busy={signingIn}
	>
		{#if signingIn}
			<Spinner size={16} />
			Waiting for Google…
		{:else}
			<Icon name="google" size={18} />
			Sign in with Google
		{/if}
	</button>
</section>

<style>
	.panel {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1.5rem;
		max-width: 34rem;
		margin: 3rem auto;
		padding: 2rem;
		text-align: center;
	}

	.hero {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.6rem;
	}

	.hero h2 {
		font-size: 1.35rem;
	}

	.hero-icon {
		display: grid;
		place-items: center;
		width: 3.5rem;
		height: 3.5rem;
		border-radius: 16px;
		background: var(--accent-soft);
		color: var(--accent);
	}

	.features {
		display: grid;
		gap: 0.75rem;
		width: 100%;
		margin: 0;
		padding: 0;
		list-style: none;
		text-align: left;
	}

	.features li {
		display: flex;
		gap: 0.75rem;
		padding: 0.75rem;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		font-size: 0.875rem;
	}

	.feature-icon {
		color: var(--accent);
		padding-top: 0.1rem;
	}

	.feature-title {
		font-weight: 600;
	}

	.error {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.6rem 0.8rem;
		border-radius: var(--radius-sm);
		background: var(--danger-soft);
		color: var(--danger);
		font-size: 0.875rem;
	}

	.google {
		min-height: 2.75rem;
		padding-inline: 1.4rem;
		font-size: 0.95rem;
	}

	@media (max-width: 640px) {
		.panel {
			margin: 1rem;
			padding: 1.25rem;
		}
	}
</style>
