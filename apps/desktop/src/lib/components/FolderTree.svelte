<script lang="ts">
	import { driveNodeKey, getAppState } from '$lib/state/app-state.svelte';
	import type { DriveFolder, DriveRoot } from '$lib/types';
	import Icon from './Icon.svelte';
	import StatusBlock from './StatusBlock.svelte';

	const app = getAppState();
	const searching = $derived(app.searchQuery.trim().length > 0);
	let refreshing = $state(false);

	async function refresh() {
		refreshing = true;
		try {
			await app.refreshFolders();
			if (searching) app.retrySearch();
		} finally {
			refreshing = false;
		}
	}

	function location(folder: DriveFolder) {
		return [folder.driveName, ...folder.path].join(' / ');
	}
</script>

{#snippet driveNode(drive: DriveRoot)}
	{@const nodeKey = driveNodeKey(drive.id)}
	{@const open = app.isExpanded(nodeKey)}
	<li>
		<div class="row">
			<button
				type="button"
				class="icon-btn disclosure"
				aria-expanded={open}
				aria-label={`${open ? 'Collapse' : 'Expand'} ${drive.name}`}
				onclick={() => app.toggleExpanded(nodeKey, drive.id, null)}
			>
				<span class="chevron" class:open><Icon name="chevron" size={16} /></span>
			</button>
			<span class="label">
				<Icon name={drive.kind === 'my-drive' ? 'drive' : 'shared'} size={16} />
				<span class="name">{drive.name}</span>
			</span>
		</div>
		{#if open}
			{@render branch(drive.id, null, 1)}
		{/if}
	</li>
{/snippet}

{#snippet folderNode(folder: DriveFolder, depth: number)}
	{@const open = app.isExpanded(folder.id)}
	<li>
		<div class="row" style:--depth={depth}>
			{#if folder.hasChildren}
				<button
					type="button"
					class="icon-btn disclosure"
					aria-expanded={open}
					aria-label={`${open ? 'Collapse' : 'Expand'} ${folder.name}`}
					onclick={() => app.toggleExpanded(folder.id, folder.driveId, folder.id)}
				>
					<span class="chevron" class:open><Icon name="chevron" size={16} /></span>
				</button>
			{:else}
				<span class="disclosure spacer" aria-hidden="true"></span>
			{/if}
			<label class="label">
				<input
					type="checkbox"
					checked={app.isSelected(folder.id)}
					disabled={app.saving}
					onchange={() => app.toggleSelected(folder)}
				/>
				<Icon name="folder" size={16} />
				<span class="name">{folder.name}</span>
			</label>
		</div>
		{#if folder.hasChildren && open}
			{@render branch(folder.driveId, folder.id, depth + 1)}
		{/if}
	</li>
{/snippet}

{#snippet branch(driveId: string, parentId: string | null, depth: number)}
	{@const node = app.branch(driveId, parentId)}
	{#if node.status === 'error'}
		<div class="branch">
			<StatusBlock
				compact
				kind="error"
				title="Couldn't load folders"
				message={node.error}
				onretry={() => app.loadBranch(driveId, parentId)}
			/>
		</div>
	{:else if node.status !== 'ready'}
		<div class="branch">
			<StatusBlock compact kind="loading" title="Loading folders" />
		</div>
	{:else if node.data.length === 0}
		<p class="muted leaf">No subfolders</p>
	{:else}
		<ul class="children">
			{#each node.data as folder (folder.id)}
				{@render folderNode(folder, depth)}
			{/each}
		</ul>
	{/if}
{/snippet}

{#snippet driveGroup(id: string, title: string, drives: DriveRoot[], empty: string)}
	<section class="group" aria-labelledby={id}>
		<h3 id={id}>{title}</h3>
		{#if drives.length === 0}
			<p class="muted leaf">{empty}</p>
		{:else}
			<ul class="roots">
				{#each drives as drive (drive.id)}
					{@render driveNode(drive)}
				{/each}
			</ul>
		{/if}
	</section>
{/snippet}

<section class="card fill" aria-labelledby="folders-heading">
	<div class="card-header">
		<h2 id="folders-heading">Folders</h2>
		<div class="header-actions">
			<span class="badge" data-tone="accent">{app.selection.size} selected</span>
			<button
				type="button"
				class="icon-btn"
				aria-label="Refresh folders"
				title="Refresh folders"
				disabled={refreshing}
				onclick={refresh}
			>
				<span class:spinning={refreshing}><Icon name="refresh" size={16} /></span>
			</button>
		</div>
	</div>
	<div class="card-body">
		<div class="search">
			<label class="search-field">
				<span class="visually-hidden">Search folders</span>
				<Icon name="search" size={16} />
				<input
					id="folder-search"
					type="search"
					placeholder="Search My Drive and shared drives"
					value={app.searchQuery}
					oninput={(event) => app.setSearchQuery(event.currentTarget.value)}
					autocomplete="off"
					spellcheck="false"
				/>
			</label>
			{#if searching}
				<button type="button" class="btn btn-sm btn-ghost" onclick={() => app.setSearchQuery('')}>
					Clear
				</button>
			{/if}
		</div>

		{#if searching}
			<div class="results" aria-live="polite">
				{#if app.searchResults.status === 'error'}
					<StatusBlock
						kind="error"
						title="Search failed"
						message={app.searchResults.error}
						onretry={() => app.retrySearch()}
					/>
				{:else if app.searchResults.status === 'loading' && !app.searchResults.data}
					<StatusBlock kind="loading" title="Searching folders" />
				{:else if app.searchResults.status === 'ready' && app.searchResults.data.length === 0}
					<StatusBlock
						kind="empty"
						icon="search"
						title="No matching folders"
						message={`Nothing matches “${app.searchQuery.trim()}”.`}
					/>
				{:else if (app.searchResults.status === 'ready' || app.searchResults.status === 'loading') && app.searchResults.data}
					<p class="muted count">
						{app.searchResults.data.length}
						{app.searchResults.data.length === 1 ? 'folder' : 'folders'}
					</p>
					<ul class="hits">
						{#each app.searchResults.data as folder (folder.id)}
							<li>
								<label class="hit">
									<input
										type="checkbox"
										checked={app.isSelected(folder.id)}
										disabled={app.saving}
										onchange={() => app.toggleSelected(folder)}
									/>
									<span class="hit-text">
										<span class="name">{folder.name}</span>
										<span class="muted path">{location(folder)}</span>
									</span>
								</label>
							</li>
						{/each}
					</ul>
					{#if app.searchResults.status === 'loading'}
						<StatusBlock compact kind="loading" title="Updating results" />
					{/if}
				{/if}
			</div>
		{:else if app.drives.status === 'error'}
			<StatusBlock
				kind="error"
				title="Couldn't load drives"
				message={app.drives.error}
				onretry={() => app.loadDrives()}
			/>
		{:else if app.drives.status !== 'ready'}
			<StatusBlock kind="loading" title="Loading drives" message="Fetching My Drive, shared folders, and shared drives." />
		{:else}
			<div class="tree">
				{@render driveGroup('my-drive-heading', 'My Drive', app.myDrives, 'No personal drive found.')}
				{@render driveGroup(
					'shared-with-me-heading',
					'Shared with me',
					app.sharedWithMe,
					'No folders have been shared with this account.'
				)}
				{@render driveGroup(
					'shared-drives-heading',
					'Shared drives',
					app.sharedDrives,
					'No shared drives on this account.'
				)}
			</div>
		{/if}
	</div>
</section>

<style>
	.header-actions {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.spinning {
		display: inline-flex;
		animation: spin 0.9s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.spinning {
			animation: none;
		}
	}

	.search {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.85rem;
	}

	.search-field {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 0.45rem;
		min-width: 0;
		padding: 0.35rem 0.7rem;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--text-muted);
	}

	.search-field:focus-within {
		box-shadow: var(--focus);
		color: var(--text);
	}

	.search-field input {
		flex: 1;
		min-width: 0;
		border: 0;
		background: transparent;
		padding: 0.2rem 0;
	}

	.search-field input:focus {
		outline: none;
		box-shadow: none;
	}

	.count {
		margin: 0 0 0.4rem;
		font-size: 0.8rem;
	}

	.hits,
	.roots,
	.children {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.hit {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
		padding: 0.55rem 0.45rem;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.hit:hover {
		background: var(--surface-hover);
	}

	.hit-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
		line-height: 1.3;
	}

	.path {
		overflow: hidden;
		font-size: 0.78rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.fill {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-height: 0;
	}

	.fill .card-body {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-height: 0;
		overflow: hidden;
	}

	.tree,
	.results {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.85rem;
		min-height: 0;
		overflow: auto;
		padding-right: 0.15rem;
	}

	.group h3 {
		margin: 0 0 0.25rem;
		font-size: 0.75rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.1rem;
		min-width: 0;
		padding-left: calc(var(--depth, 0) * 1.15rem);
		border-radius: var(--radius-sm);
	}

	.row:hover {
		background: var(--surface-hover);
	}

	.disclosure {
		flex-shrink: 0;
	}

	.spacer {
		width: 2rem;
		height: 2rem;
	}

	.chevron {
		display: grid;
		transition: transform 0.15s ease;
	}

	.chevron.open {
		transform: rotate(90deg);
	}

	.label {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 0.45rem;
		min-width: 0;
		padding: 0.35rem 0.35rem 0.35rem 0;
		color: var(--text);
		cursor: default;
	}

	.label:has(input) {
		cursor: pointer;
	}

	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	input[type='checkbox'] {
		width: 1rem;
		height: 1rem;
		margin: 0;
		accent-color: var(--accent);
	}

	.branch {
		padding-left: 2rem;
	}

	.leaf {
		margin: 0.15rem 0 0.35rem 2.15rem;
		font-size: 0.82rem;
	}
</style>
