<script lang="ts">
	import { formatRelative } from '$lib/format';
	import { getAppState } from '$lib/state/app-state.svelte';
	import type { ChannelState, SyncState } from '$lib/types';
	import Icon from './Icon.svelte';
	import Spinner from './Spinner.svelte';
	import StatusBlock from './StatusBlock.svelte';

	const app = getAppState();
	const syncData = $derived(app.sync.status === 'idle' ? undefined : app.sync.data);
	const syncing = $derived(syncData?.state === 'syncing');

	const syncLabel: Record<SyncState, string> = {
		idle: 'Up to date',
		syncing: 'Syncing',
		paused: 'Paused',
		error: 'Needs attention'
	};

	const channelLabel: Record<ChannelState, string> = {
		active: 'Active',
		renewing: 'Renewing',
		expired: 'Expired',
		error: 'Error'
	};

	function syncTone(state: SyncState) {
		if (state === 'idle') return 'success';
		if (state === 'syncing') return 'accent';
		if (state === 'paused') return 'warning';
		return 'danger';
	}

	function channelTone(state: ChannelState) {
		if (state === 'active') return 'success';
		if (state === 'renewing') return 'warning';
		return 'danger';
	}
</script>

<section class="card pin" aria-labelledby="sync-heading">
	<div class="card-header">
		<h2 id="sync-heading">Monitoring</h2>
		{#if syncData}
			<span class="badge" data-tone={syncTone(syncData.state)} role="status">
				{#if syncing}
					<Spinner size={12} />
				{/if}
				{syncLabel[syncData.state]}
			</span>
		{/if}
	</div>
	<div class="card-body">
		<div class="controls">
			<button
				type="button"
				class="btn btn-sm"
				onclick={() => app.setPaused(!app.isPaused)}
				disabled={app.monitoringBusy}
				aria-busy={app.monitoringBusy}
			>
				{#if app.monitoringBusy}
					<Spinner size={14} />
					Updating…
				{:else if app.isPaused}
					<Icon name="play" size={15} />
					Resume
				{:else}
					<Icon name="pause" size={15} />
					Pause
				{/if}
			</button>
			<button
				type="button"
				class="btn btn-sm"
				onclick={() => app.requestSync()}
				disabled={syncing}
				aria-busy={syncing}
			>
				{#if syncing}
					<Spinner size={14} />
					Syncing…
				{:else}
					<Icon name="refresh" size={15} />
					Sync now
				{/if}
			</button>
		</div>

		{#if app.monitoringError}
			<p class="alert" role="alert">{app.monitoringError}</p>
		{/if}
		{#if app.syncError}
			<p class="alert" role="alert">{app.syncError}</p>
		{/if}

		{#if app.monitoring.status === 'error'}
			<StatusBlock
				compact
				kind="error"
				title="Couldn't load pause state"
				message={app.monitoring.error}
				onretry={() => app.loadMonitoring()}
			/>
		{/if}

		{#if app.sync.status === 'error'}
			<StatusBlock
				kind="error"
				title="Couldn't load sync status"
				message={app.sync.error}
				onretry={() => app.loadSync()}
			/>
		{:else if !syncData}
			<StatusBlock kind="loading" title="Checking channels" />
		{:else}
			<p class="muted meta">
				Last sync {formatRelative(syncData.lastSyncAt, app.now)}
				{#if syncData.error}
					<span class="problem"> · {syncData.error}</span>
				{/if}
			</p>

			<h3 class="channels-heading">Watch channels</h3>
			{#if syncData.channels.length === 0}
				<StatusBlock
					compact
					kind="empty"
					icon="drive"
					title="No channels yet"
					message="Save a folder selection to open a watch channel for each drive."
				/>
			{:else}
				<ul class="channels">
					{#each syncData.channels as channel (channel.id)}
						<li>
							<div class="channel-top">
								<span class="channel-name">{channel.driveName}</span>
								<span class="badge" data-tone={channelTone(channel.state)}>
									{channelLabel[channel.state]}
								</span>
							</div>
							<p class="muted channel-meta">
								Expires {formatRelative(channel.expiresAt, app.now)}
								<span aria-hidden="true"> · </span>
								Last event {formatRelative(channel.lastEventAt, app.now)}
							</p>
							{#if channel.error}
								<p class="problem">{channel.error}</p>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</div>
</section>

<style>
	.pin {
		flex-shrink: 0;
	}

	.controls {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
		margin-bottom: 0.75rem;
	}

	.alert,
	.problem {
		color: var(--danger);
	}

	.alert {
		margin: 0 0 0.65rem;
		padding: 0.55rem 0.7rem;
		border-radius: var(--radius-sm);
		background: var(--danger-soft);
		font-size: 0.875rem;
	}

	.meta {
		margin: 0 0 0.85rem;
		font-size: 0.85rem;
	}

	.channels-heading {
		margin: 0 0 0.4rem;
		font-size: 0.75rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.channels {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.channels li {
		padding: 0.55rem 0.65rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
	}

	.channel-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.channel-name {
		font-weight: 600;
		font-size: 0.9rem;
	}

	.channel-meta,
	.problem {
		margin: 0.15rem 0 0;
		font-size: 0.78rem;
	}
</style>
