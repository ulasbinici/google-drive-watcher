<script lang="ts">
	import { getAppState } from '$lib/state/app-state.svelte';
	import type { DriveFolder } from '$lib/types';
	import Icon from './Icon.svelte';
	import Spinner from './Spinner.svelte';
	import StatusBlock from './StatusBlock.svelte';

	const app = getAppState();
	const selected = $derived([...app.selection.values()]);

	function location(folder: DriveFolder) {
		return [folder.driveName, ...folder.path].filter(Boolean).join(' / ');
	}
</script>

<section class="card pin" aria-labelledby="selection-heading">
	<div class="card-header">
		<h2 id="selection-heading">Watched folders</h2>
		<div class="actions">
			{#if app.isDirty}
				<span class="badge" data-tone="warning">Unsaved</span>
			{/if}
			<button
				type="button"
				class="btn btn-sm"
				onclick={() => app.discardChanges()}
				disabled={!app.isDirty || app.saving}
			>
				Discard
			</button>
			<button
				type="button"
				class="btn btn-sm btn-primary"
				onclick={() => app.saveSelection()}
				disabled={!app.isDirty || app.saving}
				aria-busy={app.saving}
			>
				{#if app.saving}
					<Spinner size={14} />
					Saving…
				{:else}
					<Icon name="check" size={15} />
					Save
				{/if}
			</button>
		</div>
	</div>
	<div class="card-body">
		{#if app.saveError}
			<p class="alert" role="alert"><Icon name="warning" size={16} /> {app.saveError}</p>
		{/if}

		{#if app.watched.status === 'error'}
			<StatusBlock
				compact
				kind="error"
				title="Couldn't load watched folders"
				message={app.watched.error}
				onretry={() => app.loadWatched()}
			/>
		{/if}

		{#if app.watched.status === 'loading' && selected.length === 0}
			<StatusBlock kind="loading" title="Loading your selection" />
		{:else if selected.length === 0 && app.watched.status !== 'error'}
			<StatusBlock
				kind="empty"
				icon="folder"
				title="No folders selected"
				message="Choose folders in My Drive or a shared drive. Save to start watching them."
			/>
		{:else if selected.length > 0}
			<ul class="chips" aria-label="Selected folders">
				{#each selected as folder (folder.id)}
					<li>
						<span class="chip">
							<Icon name="folder" size={14} />
							<span class="chip-text">
								<span class="chip-name">{folder.name}</span>
								<span class="muted chip-path">{location(folder) || folder.driveName}</span>
							</span>
							<button
								type="button"
								class="icon-btn"
								aria-label={`Remove ${folder.name}`}
								onclick={() => app.removeSelected(folder.id)}
								disabled={app.saving}
							>
								<Icon name="close" size={14} />
							</button>
						</span>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</section>

<style>
	.pin {
		flex-shrink: 0;
	}

	.pin .card-body {
		max-height: 9.5rem;
		overflow: auto;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: 0.4rem;
	}

	.alert {
		display: flex;
		align-items: flex-start;
		gap: 0.4rem;
		margin: 0 0 0.75rem;
		padding: 0.6rem 0.75rem;
		border-radius: var(--radius-sm);
		background: var(--danger-soft);
		color: var(--danger);
		font-size: 0.875rem;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.chip {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		max-width: 100%;
		padding: 0.3rem 0.3rem 0.3rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface-2);
	}

	.chip-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
		line-height: 1.2;
	}

	.chip-name {
		font-size: 0.85rem;
		font-weight: 600;
	}

	.chip-path {
		overflow: hidden;
		max-width: 16rem;
		font-size: 0.72rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
