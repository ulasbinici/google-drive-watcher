<script lang="ts">
	import { formatRelative } from '$lib/format';
	import { openBrowseWindow, revealLocalPath } from '$lib/native';
	import { getAppState } from '$lib/state/app-state.svelte';
	import { getSyncManager } from '$lib/sync/sync-manager.svelte';
	import { DIRECTION_LABELS, type SyncDirection } from '$lib/sync/sync-store';
	import Icon from './Icon.svelte';
	import Spinner from './Spinner.svelte';

	const app = getAppState();
	const sync = getSyncManager();
	const directions = Object.entries(DIRECTION_LABELS) as [SyncDirection, string][];
	const running = $derived(sync.runningId !== null);

	function arrow(direction: SyncDirection): string {
		if (direction === 'two-way') return '⇄';
		if (direction === 'download') return '→';
		return '←';
	}
</script>

<section class="card pin" aria-labelledby="folder-sync-heading">
	<div class="card-header">
		<h2 id="folder-sync-heading">Folder sync</h2>
		{#if sync.pairs.length > 0}
			<span class="badge" data-tone={sync.paused ? 'warning' : running ? 'accent' : 'neutral'} role="status">
				{#if running}
					<Spinner size={12} />
				{/if}
				{sync.paused ? 'Paused' : running ? 'Syncing' : `Every ${sync.intervalMinutes} min`}
			</span>
		{/if}
	</div>
	<div class="card-body">
		{#if sync.pairs.length > 0}
			<div class="controls">
				<button type="button" class="btn btn-sm" onclick={() => void sync.setPaused(!sync.paused)}>
					{#if sync.paused}
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
					disabled={running}
					onclick={() => sync.request(null, true)}
				>
					{#if running}
						<Spinner size={14} />
						Syncing…
					{:else}
						<Icon name="refresh" size={15} />
						Sync now
					{/if}
				</button>
			</div>
		{/if}

		{#if sync.pairs.length === 0}
			<p class="muted empty">
				No synced folders yet. In
				<button type="button" class="link" onclick={() => void openBrowseWindow()}>Browse</button>,
				right-click a folder and choose <strong>Sync with a local folder</strong>.
			</p>
		{:else}
			<ul class="pairs">
				{#each sync.pairs as pair (pair.id)}
					{@const active = sync.runningId === pair.id}
					<li>
						<p class="path" title={pair.drivePath}>{pair.drivePath}</p>
						<p class="path local" title={pair.localPath}>
							<span class="arrow" aria-hidden="true">{arrow(pair.direction)}</span>
							{pair.localPath}
						</p>
						<div class="pair-controls">
							<label class="visually-hidden" for="direction-{pair.id}">Sync direction</label>
							<select
								id="direction-{pair.id}"
								value={pair.direction}
								disabled={active}
								onchange={(event) =>
									void sync.setDirection(pair, event.currentTarget.value as SyncDirection)}
							>
								{#each directions as [value, label] (value)}
									<option {value}>{label}</option>
								{/each}
							</select>
							<button
								type="button"
								class="btn btn-sm"
								disabled={running}
								onclick={() => sync.request(pair.id, true)}
							>
								Sync now
							</button>
							<button
								type="button"
								class="btn btn-sm btn-ghost"
								onclick={() => void revealLocalPath(pair.localPath)}
							>
								Show folder
							</button>
							<button
								type="button"
								class="btn btn-sm btn-ghost danger"
								disabled={active}
								onclick={() => void sync.remove(pair.id)}
							>
								Remove
							</button>
						</div>
						<p class="muted pair-status">
							{#if active}
								<Spinner size={12} />
								{sync.progress ?? 'Syncing…'}
							{:else if pair.lastSyncAt}
								Last sync {formatRelative(pair.lastSyncAt, app.now)}
								{#if pair.lastSummary}· {pair.lastSummary}{/if}
							{:else}
								Waiting for first sync
							{/if}
						</p>
						{#if pair.lastError && !active}
							<p class="error">{pair.lastError}</p>
						{/if}
					</li>
				{/each}
			</ul>
			<p class="muted note">
				Deleting a file on one side does not delete it on the other. Google Docs, Sheets and Slides
				are skipped.
			</p>
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

	.empty,
	.note {
		margin: 0;
		font-size: 0.85rem;
	}

	.link {
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
		cursor: pointer;
		text-decoration: underline;
	}

	.pairs {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		max-height: 18rem;
		margin: 0;
		padding: 0;
		overflow: auto;
		list-style: none;
	}

	.pairs li {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		padding: 0.55rem 0.65rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
	}

	.path {
		margin: 0;
		overflow: hidden;
		font-size: 0.86rem;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.local {
		font-weight: 400;
	}

	.arrow {
		color: var(--accent);
	}

	.pair-controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.35rem;
	}

	select {
		min-height: 1.875rem;
		max-width: 100%;
		padding: 0.15rem 0.5rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--text);
		font: inherit;
		font-size: 0.82rem;
	}

	.danger {
		color: var(--danger);
	}

	.pair-status {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		margin: 0;
		font-size: 0.78rem;
	}

	.error {
		margin: 0;
		color: var(--danger);
		font-size: 0.78rem;
	}

	.note {
		margin-top: 0.7rem;
	}
</style>
