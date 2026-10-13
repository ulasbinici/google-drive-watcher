<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import Icon from '$lib/components/Icon.svelte';
	import Spinner from '$lib/components/Spinner.svelte';
	import StatusBlock from '$lib/components/StatusBlock.svelte';
	import { thumbnailUrl, type DriveItem } from '$lib/drive/drive-api';
	import { DRIVE_ITEMS_MIME, filesFromDrop, hasDriveItems, hasExternalFiles } from './drop';
	import FileIcon from './FileIcon.svelte';
	import { formatBytes, formatFull, formatModified } from './format';
	import { getBrowserState, type SortKey } from './browser-state.svelte';

	const browser = getBrowserState();
	const loading = $derived(browser.items.status === 'loading' && !browser.items.data);
	const brokenThumbs = new SvelteSet<string>();

	const columns: { key: SortKey; label: string }[] = [
		{ key: 'name', label: 'Name' },
		{ key: 'owner', label: 'Owner' },
		{ key: 'modified', label: 'Last modified' },
		{ key: 'size', label: 'File size' }
	];

	function onItemClick(event: MouseEvent, item: DriveItem) {
		event.stopPropagation();
		browser.menu = null;
		browser.select(item, { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey });
	}

	function onItemKeydown(event: KeyboardEvent, item: DriveItem) {
		if (event.key === 'Enter') {
			event.preventDefault();
			browser.open(item);
		} else if (event.key === ' ') {
			event.preventDefault();
			browser.select(item, { ctrl: true, shift: false });
		}
	}

	function onDragStart(event: DragEvent, item: DriveItem) {
		if (!browser.canEdit || !event.dataTransfer) {
			event.preventDefault();
			return;
		}
		browser.ensureSelected(item);
		event.dataTransfer.setData(DRIVE_ITEMS_MIME, JSON.stringify([...browser.selection]));
		event.dataTransfer.effectAllowed = 'move';
	}

	function acceptsDrop(event: DragEvent, folder: DriveItem) {
		if (!folder.isFolder || browser.place.kind === 'trash') return false;
		if (hasDriveItems(event)) return !browser.selection.has(folder.id);
		return hasExternalFiles(event);
	}

	function onDragOver(event: DragEvent, folder: DriveItem) {
		if (!acceptsDrop(event, folder)) return;
		event.preventDefault();
		event.stopPropagation();
		if (event.dataTransfer) event.dataTransfer.dropEffect = hasDriveItems(event) ? 'move' : 'copy';
		browser.dropFolder = folder;
		browser.dragging = true;
	}

	function onDragLeave(event: DragEvent, folder: DriveItem) {
		const next = event.relatedTarget as Node | null;
		if (next && (event.currentTarget as Node).contains(next)) return;
		if (browser.dropFolder?.id === folder.id) browser.dropFolder = null;
	}

	async function onDrop(event: DragEvent, folder: DriveItem) {
		if (!acceptsDrop(event, folder) || !event.dataTransfer) return;
		event.preventDefault();
		event.stopPropagation();
		browser.dropFolder = null;
		browser.dragging = false;
		if (hasDriveItems(event)) {
			const ids = new Set(JSON.parse(event.dataTransfer.getData(DRIVE_ITEMS_MIME) || '[]') as string[]);
			await browser.move(browser.sorted.filter((item) => ids.has(item.id)), folder);
			return;
		}
		const picked = await filesFromDrop(event.dataTransfer);
		await browser.upload(picked, folder.id, folder.name);
	}

	function openMenuAt(event: MouseEvent, item: DriveItem) {
		event.stopPropagation();
		const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
		browser.ensureSelected(item);
		browser.menu = { x: rect.left, y: rect.bottom + 4, items: browser.selectedItems };
	}

	function thumbFor(item: DriveItem) {
		if (brokenThumbs.has(item.id)) return null;
		return thumbnailUrl(item, 400);
	}
</script>

{#snippet badges(item: DriveItem)}
	{#if browser.syncedFolderIds.has(item.id)}
		<span class="badge-icon synced" title="Synced with a local folder">
			<Icon name="sync" size={13} label="Synced" />
		</span>
	{/if}
	{#if item.starred}
		<span class="badge-icon starred" title="Starred"><Icon name="star" size={13} label="Starred" /></span>
	{/if}
{/snippet}

{#if browser.items.status === 'error'}
	<div class="state">
		<StatusBlock
			kind="error"
			title="Couldn't load this folder"
			message={browser.items.error}
			onretry={() => void browser.load()}
		/>
	</div>
{:else if loading}
	<div class="state"><Spinner size={28} /></div>
{:else if browser.sorted.length === 0}
	<div class="state empty">
		<span class="empty-icon"><Icon name={browser.place.kind === 'trash' ? 'trash' : 'folder'} size={56} /></span>
		{#if browser.place.kind === 'search'}
			<h3>No results</h3>
			<p class="muted">Try a different name or word from inside the file.</p>
		{:else if browser.place.kind === 'trash'}
			<h3>Trash is empty</h3>
		{:else if browser.canUploadHere}
			<h3>Drop files here</h3>
			<p class="muted">or use the “New” button.</p>
		{:else}
			<h3>Nothing here yet</h3>
		{/if}
	</div>
{:else if browser.view === 'list'}
	<div class="list" role="grid" aria-label={browser.title} aria-multiselectable="true">
		<div class="row head" role="row">
			{#each columns as column (column.key)}
				<button
					type="button"
					role="columnheader"
					class="col {column.key}"
					aria-sort={browser.sortKey === column.key
						? browser.sortAscending
							? 'ascending'
							: 'descending'
						: 'none'}
					onclick={() => browser.sortBy(column.key)}
				>
					{column.label}
					{#if browser.sortKey === column.key}
						<Icon name={browser.sortAscending ? 'arrow-up' : 'arrow-down'} size={14} />
					{/if}
				</button>
			{/each}
			<span class="col actions" role="columnheader" aria-label="Actions"></span>
		</div>
		{#each browser.sorted as item (item.id)}
			<div
				class="row item"
				class:selected={browser.selection.has(item.id)}
				class:drop={browser.dropFolder?.id === item.id}
				role="row"
				tabindex="0"
				aria-selected={browser.selection.has(item.id)}
				draggable={browser.canEdit}
				onclick={(event) => onItemClick(event, item)}
				ondblclick={() => browser.open(item)}
				onkeydown={(event) => onItemKeydown(event, item)}
				oncontextmenu={(event) => browser.openContextMenu(event, item)}
				ondragstart={(event) => onDragStart(event, item)}
				ondragover={(event) => onDragOver(event, item)}
				ondragleave={(event) => onDragLeave(event, item)}
				ondrop={(event) => void onDrop(event, item)}
			>
				<span class="col name" role="gridcell">
					<FileIcon {item} size={20} />
					<span class="text" title={item.name}>{item.name}</span>
					{@render badges(item)}
				</span>
				<span class="col owner muted" role="gridcell">{item.ownerName ?? '—'}</span>
				<span class="col modified muted" role="gridcell" title={formatFull(item.modifiedTime)}>
					{formatModified(item.modifiedTime)}
				</span>
				<span class="col size muted" role="gridcell">{item.isFolder ? '—' : formatBytes(item.size)}</span>
				<span class="col actions" role="gridcell">
					<button
						type="button"
						class="icon-btn"
						aria-label="More actions for {item.name}"
						onclick={(event) => openMenuAt(event, item)}
						ondblclick={(event) => event.stopPropagation()}
					>
						<Icon name="more" size={18} />
					</button>
				</span>
			</div>
		{/each}
	</div>
{:else}
	<div class="grid-view" aria-label={browser.title}>
		{#if browser.folders.length}
			<h3 class="section">Folders</h3>
			<div class="folder-grid" role="listbox" aria-multiselectable="true" aria-label="Folders">
				{#each browser.folders as item (item.id)}
					<div
						class="folder-chip"
						class:selected={browser.selection.has(item.id)}
						class:drop={browser.dropFolder?.id === item.id}
						role="option"
						tabindex="0"
						aria-selected={browser.selection.has(item.id)}
						draggable={browser.canEdit}
						onclick={(event) => onItemClick(event, item)}
						ondblclick={() => browser.open(item)}
						onkeydown={(event) => onItemKeydown(event, item)}
						oncontextmenu={(event) => browser.openContextMenu(event, item)}
						ondragstart={(event) => onDragStart(event, item)}
						ondragover={(event) => onDragOver(event, item)}
						ondragleave={(event) => onDragLeave(event, item)}
						ondrop={(event) => void onDrop(event, item)}
					>
						<FileIcon {item} size={22} />
						<span class="text" title={item.name}>{item.name}</span>
						{@render badges(item)}
						<button
							type="button"
							class="icon-btn"
							aria-label="More actions for {item.name}"
							onclick={(event) => openMenuAt(event, item)}
							ondblclick={(event) => event.stopPropagation()}
						>
							<Icon name="more" size={18} />
						</button>
					</div>
				{/each}
			</div>
		{/if}
		{#if browser.files.length}
			<h3 class="section">Files</h3>
			<div class="file-grid" role="listbox" aria-multiselectable="true" aria-label="Files">
				{#each browser.files as item (item.id)}
					{@const thumb = thumbFor(item)}
					<div
						class="card"
						class:selected={browser.selection.has(item.id)}
						role="option"
						tabindex="0"
						aria-selected={browser.selection.has(item.id)}
						draggable={browser.canEdit}
						onclick={(event) => onItemClick(event, item)}
						ondblclick={() => browser.open(item)}
						onkeydown={(event) => onItemKeydown(event, item)}
						oncontextmenu={(event) => browser.openContextMenu(event, item)}
						ondragstart={(event) => onDragStart(event, item)}
					>
						<div class="card-title">
							<FileIcon {item} size={18} />
							<span class="text" title={item.name}>{item.name}</span>
							<button
								type="button"
								class="icon-btn"
								aria-label="More actions for {item.name}"
								onclick={(event) => openMenuAt(event, item)}
								ondblclick={(event) => event.stopPropagation()}
							>
								<Icon name="more" size={18} />
							</button>
						</div>
						<div class="preview">
							{#if thumb}
								<img
									src={thumb}
									alt=""
									loading="lazy"
									referrerpolicy="no-referrer"
									onerror={() => brokenThumbs.add(item.id)}
								/>
							{:else}
								<FileIcon {item} size={64} />
							{/if}
						</div>
						<div class="card-meta muted">
							{@render badges(item)}
							<span>{item.ownerName === 'me' ? 'You' : item.ownerName} · {formatModified(item.modifiedTime)}</span>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}

<style>
	.state {
		display: grid;
		flex: 1;
		place-items: center;
		padding: 3rem 1rem;
	}

	.empty {
		align-content: center;
		gap: 0.5rem;
		text-align: center;
	}

	.empty-icon {
		color: var(--border);
	}

	.empty h3 {
		font-size: 1.05rem;
		font-weight: 500;
	}

	.list {
		display: flex;
		flex-direction: column;
		container-type: inline-size;
	}

	.row {
		display: grid;
		grid-template-columns: minmax(12rem, 1fr) 11rem 9rem 7rem 2.75rem;
		align-items: center;
		min-height: 2.9rem;
		padding: 0 0.75rem;
		border-bottom: 1px solid var(--border);
	}

	.head {
		position: sticky;
		top: 0;
		z-index: 1;
		min-height: 2.6rem;
		background: var(--surface);
	}

	.head .col {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		height: 100%;
		padding: 0 0.5rem;
		border: 0;
		background: none;
		color: var(--text-muted);
		font-size: 0.82rem;
		font-weight: 600;
		text-align: left;
		cursor: pointer;
	}

	.head .col:hover {
		color: var(--text);
	}

	.item {
		cursor: default;
		user-select: none;
	}

	.item:hover {
		background: var(--surface-hover);
	}

	.item:focus-visible,
	.folder-chip:focus-visible,
	.card:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
		box-shadow: none;
	}

	.selected,
	.item.selected:hover {
		background: var(--accent-soft);
	}

	.drop {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
		background: var(--accent-soft);
	}

	.col {
		min-width: 0;
		padding: 0 0.5rem;
		font-size: 0.875rem;
	}

	.name {
		display: flex;
		align-items: center;
		gap: 0.85rem;
	}

	.text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.owner,
	.modified,
	.size {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		padding: 0;
	}

	.item .actions .icon-btn,
	.folder-chip .icon-btn {
		opacity: 0;
	}

	.item:hover .actions .icon-btn,
	.item.selected .actions .icon-btn,
	.folder-chip:hover .icon-btn,
	.folder-chip.selected .icon-btn,
	.icon-btn:focus-visible {
		opacity: 1;
	}

	@container (max-width: 760px) {
		.row {
			grid-template-columns: minmax(10rem, 1fr) 8rem 2.75rem;
		}

		.owner,
		.size {
			display: none;
		}
	}

	@container (max-width: 480px) {
		.row {
			grid-template-columns: minmax(8rem, 1fr) 2.75rem;
		}

		.modified {
			display: none;
		}
	}

	.badge-icon {
		display: inline-grid;
		flex-shrink: 0;
		place-items: center;
		color: var(--text-muted);
	}

	.badge-icon.synced {
		color: var(--accent);
	}

	.badge-icon.starred :global(svg) {
		fill: currentColor;
	}

	.grid-view {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.5rem 0.25rem 1.5rem;
	}

	.section {
		margin-top: 0.5rem;
		color: var(--text);
		font-size: 0.9rem;
		font-weight: 500;
	}

	.folder-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(13.5rem, 1fr));
		gap: 0.75rem;
	}

	.folder-chip {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-width: 0;
		height: 3rem;
		padding: 0 0.35rem 0 1rem;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		font-size: 0.875rem;
		font-weight: 500;
		user-select: none;
	}

	.folder-chip .text {
		flex: 1;
	}

	.folder-chip:hover {
		background: var(--surface-hover);
	}

	.folder-chip.selected {
		background: var(--accent-soft);
	}

	.file-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(13.5rem, 1fr));
		gap: 0.75rem;
	}

	.card {
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		user-select: none;
	}

	.card:hover {
		background: var(--surface-hover);
	}

	.card.selected {
		background: var(--accent-soft);
	}

	.card-title {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		padding: 0.35rem 0.25rem 0.35rem 0.8rem;
		font-size: 0.875rem;
		font-weight: 500;
	}

	.card-title .text {
		flex: 1;
	}

	.preview {
		display: grid;
		place-items: center;
		height: 9.5rem;
		margin: 0 0.5rem;
		overflow: hidden;
		border-radius: 6px;
		background: var(--surface);
	}

	.preview img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		object-position: top center;
	}

	.card-meta {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.55rem 0.8rem 0.7rem;
		font-size: 0.76rem;
	}

	.card-meta span:last-child {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
