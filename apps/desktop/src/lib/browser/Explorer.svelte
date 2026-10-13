<script lang="ts">
	import Icon, { type IconName } from '$lib/components/Icon.svelte';
	import { errorMessage } from '$lib/format';
	import { openLocalPath } from '$lib/native';
	import StatusBlock from '$lib/components/StatusBlock.svelte';
	import type { SpecialView } from '$lib/drive/drive-api';
	import { getBrowserState, type SortKey } from './browser-state.svelte';
	import ContextMenu from './ContextMenu.svelte';
	import { filesFromDrop, filesFromInput, hasDriveItems, hasExternalFiles } from './drop';
	import ItemsView from './ItemsView.svelte';
	import NameDialog from './NameDialog.svelte';
	import SyncDialog from './SyncDialog.svelte';
	import TransferPanel from './TransferPanel.svelte';

	const browser = getBrowserState();

	let fileInput: HTMLInputElement | undefined;
	let folderInput: HTMLInputElement | undefined;
	let searchInput: HTMLInputElement | undefined;
	let newMenuOpen = $state(false);
	let dragDepth = 0;

	const specials: { view: SpecialView; label: string; icon: IconName }[] = [
		{ view: 'shared-with-me', label: 'Shared with me', icon: 'shared' },
		{ view: 'recent', label: 'Recent', icon: 'clock' },
		{ view: 'starred', label: 'Starred', icon: 'star' },
		{ view: 'trash', label: 'Trash', icon: 'trash' }
	];

	const sortLabels: Record<SortKey, string> = {
		name: 'Name',
		modified: 'Last modified',
		size: 'File size',
		owner: 'Owner'
	};

	const selected = $derived(browser.selectedItems);
	const single = $derived(selected.length === 1 ? selected[0]! : null);
	const inTrash = $derived(browser.place.kind === 'trash');
	const removal = $derived(browser.removalAction(selected));
	const dropLabel = $derived(browser.dropFolder?.name ?? browser.title);
	const myDriveActive = $derived(browser.place.kind === 'folder' && browser.crumbs[0]?.id === 'root');

	function pinCrumbs(node: HTMLOListElement) {
		let path = '';
		for (let index = 0; index < browser.crumbs.length; index += 1) {
			path += browser.crumbs[index]?.id ?? '';
		}
		if (path.length === 0) return;
		node.scrollLeft = node.scrollWidth;
	}

	function rememberFileInput(node: HTMLInputElement) {
		fileInput = node;
	}

	function rememberFolderInput(node: HTMLInputElement) {
		folderInput = node;
		node.setAttribute('webkitdirectory', '');
	}

	function rememberSearch(node: HTMLInputElement) {
		searchInput = node;
	}

	function pickFiles() {
		newMenuOpen = false;
		fileInput?.click();
	}

	function pickFolder() {
		newMenuOpen = false;
		folderInput?.click();
	}

	function onPicked(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const picked = filesFromInput(input);
		input.value = '';
		void browser.upload(picked);
	}

	function isTyping(target: EventTarget | null) {
		const element = target as HTMLElement | null;
		return Boolean(element?.closest('input, textarea, select, [contenteditable="true"]'));
	}

	function onKeydown(event: KeyboardEvent) {
		if (browser.dialog) return;
		const ctrl = event.ctrlKey || event.metaKey;
		if (ctrl && event.key.toLowerCase() === 'f') {
			event.preventDefault();
			searchInput?.focus();
			searchInput?.select();
			return;
		}
		if (isTyping(event.target)) return;
		if (event.altKey && event.key === 'ArrowLeft') browser.back();
		else if (event.altKey && event.key === 'ArrowRight') browser.forward();
		else if (event.key === 'Backspace') browser.back();
		else if (event.key === '/') {
			event.preventDefault();
			searchInput?.focus();
		} else if (ctrl && event.key.toLowerCase() === 'a') {
			event.preventDefault();
			browser.selectAll();
		} else if (event.key === 'Escape') {
			browser.menu = null;
			newMenuOpen = false;
			browser.clearSelection();
		} else if (event.key === 'Delete' && removal) {
			void browser.removeSelected(selected);
		} else if (event.key === 'F2' && single && browser.canEdit) {
			browser.dialog = { kind: 'rename', item: single };
		} else if (event.key === 'F5') {
			event.preventDefault();
			void browser.load();
		}
	}

	function onWindowDragOver(event: DragEvent) {
		event.preventDefault();
		if (event.dataTransfer && !hasDriveItems(event)) {
			event.dataTransfer.dropEffect = browser.canUploadHere ? 'copy' : 'none';
		}
	}

	function onDragEnter(event: DragEvent) {
		if (!hasExternalFiles(event)) return;
		dragDepth++;
		browser.dragging = true;
	}

	function onDragLeave(event: DragEvent) {
		if (!hasExternalFiles(event)) return;
		dragDepth = Math.max(0, dragDepth - 1);
		if (dragDepth === 0) {
			browser.dragging = false;
			browser.dropFolder = null;
		}
	}

	async function onDrop(event: DragEvent) {
		event.preventDefault();
		dragDepth = 0;
		browser.dragging = false;
		browser.dropFolder = null;
		if (!event.dataTransfer || !hasExternalFiles(event)) return;
		if (!browser.canUploadHere) {
			browser.notify(
				browser.canEdit
					? 'Open a folder to upload files into it.'
					: 'Turn on “Allow file upload and edit” in Drive Watch Settings first.'
			);
			return;
		}
		await browser.upload(await filesFromDrop(event.dataTransfer));
	}

	function onBackgroundClick(event: MouseEvent) {
		if (event.target === event.currentTarget) browser.clearSelection();
	}

	function closeSync(message?: string) {
		browser.dialog = null;
		if (message) browser.notify(message);
		void browser.loadSyncPairs();
	}
</script>

<svelte:window onkeydown={onKeydown} ondragover={onWindowDragOver} ondrop={(event) => event.preventDefault()} />

<input {@attach rememberFileInput} class="visually-hidden" type="file" multiple onchange={onPicked} tabindex="-1" />
<input {@attach rememberFolderInput} class="visually-hidden" type="file" onchange={onPicked} tabindex="-1" />

{#if browser.session !== 'signed-in'}
	<main class="gate">
		{#if browser.session === 'checking'}
			<StatusBlock kind="loading" title="Opening your Drive" />
		{:else if browser.session === 'unavailable'}
			<StatusBlock kind="error" title="Drive isn't configured" message="Browse needs the Firebase connection used by Drive Watch." />
		{:else}
			<StatusBlock kind="empty" icon="google" title="Sign in first" message="Sign in with Google in the main Drive Watch window, then open Browse again." />
		{/if}
	</main>
{:else}
	<div class="app">
		<header class="topbar">
			<div class="brand">
				<span class="logo"><Icon name="drive" size={20} /></span>
				<span class="brand-name">Drive</span>
			</div>
			<form
				class="search"
				role="search"
				onsubmit={(event) => {
					event.preventDefault();
					browser.runSearch();
				}}
			>
				<Icon name="search" size={18} />
				<input
					{@attach rememberSearch}
					type="search"
					placeholder="Search in Drive"
					aria-label="Search in Drive"
					value={browser.searchText}
					oninput={(event) => browser.setSearch(event.currentTarget.value)}
					onkeydown={(event) => {
						if (event.key === 'Escape') {
							browser.setSearch('');
							event.currentTarget.blur();
						}
					}}
				/>
				{#if browser.searchText}
					<button type="button" class="icon-btn" aria-label="Clear search" onclick={() => browser.setSearch('')}>
						<Icon name="close" size={16} />
					</button>
				{/if}
			</form>
			<div class="top-actions">
				<span
					class="badge"
					data-tone={browser.canEdit ? 'success' : 'warning'}
					title={browser.canEdit
						? 'Uploads, renames, moves and deletes are allowed'
						: 'Turn on “Allow file upload and edit” in Drive Watch Settings to change files'}
				>
					{browser.canEdit ? 'Can edit' : 'Read-only'}
				</span>
				<div class="segmented" role="group" aria-label="Layout">
					<button
						type="button"
						aria-pressed={browser.view === 'list'}
						aria-label="List layout"
						title="List layout"
						onclick={() => browser.setView('list')}
					>
						<Icon name="list" size={18} />
					</button>
					<button
						type="button"
						aria-pressed={browser.view === 'grid'}
						aria-label="Grid layout"
						title="Grid layout"
						onclick={() => browser.setView('grid')}
					>
						<Icon name="grid" size={18} />
					</button>
				</div>
			</div>
		</header>

		<nav class="sidebar" aria-label="Drive locations">
			<div class="new-wrap">
				<button
					type="button"
					class="new-btn"
					aria-haspopup="menu"
					aria-expanded={newMenuOpen}
					disabled={!browser.canUploadHere}
					title={browser.canUploadHere ? undefined : browser.canEdit ? 'Open a folder first' : 'Read-only'}
					onclick={() => (newMenuOpen = !newMenuOpen)}
				>
					<Icon name="plus" size={22} />
					New
				</button>
				{#if newMenuOpen}
					<button type="button" class="menu-scrim" aria-label="Close" onclick={() => (newMenuOpen = false)}></button>
					<div class="new-menu" role="menu">
						<button
							type="button"
							role="menuitem"
							onclick={() => {
								newMenuOpen = false;
								browser.dialog = { kind: 'new-folder' };
							}}
						>
							<Icon name="folder-plus" size={18} /> New folder
						</button>
						<hr />
						<button type="button" role="menuitem" onclick={pickFiles}>
							<Icon name="upload" size={18} /> File upload
						</button>
						<button type="button" role="menuitem" onclick={pickFolder}>
							<Icon name="upload" size={18} /> Folder upload
						</button>
					</div>
				{/if}
			</div>

			<ul class="nav">
				<li>
					<button type="button" class:active={myDriveActive} onclick={() => browser.goMyDrive()}>
						<Icon name="drive" size={18} /> My Drive
					</button>
				</li>
				{#each specials as special (special.view)}
					<li>
						<button
							type="button"
							class:active={browser.place.kind === special.view}
							onclick={() => browser.goSpecial(special.view)}
						>
							<Icon name={special.icon} size={18} />
							{special.label}
						</button>
					</li>
				{/each}
			</ul>

			{#if browser.shortcuts.length}
				<section class="shortcut-panel" aria-labelledby="browse-shortcuts-title">
					<h3 id="browse-shortcuts-title" class="shortcut-title">
						<Icon name="shortcut" size={15} /> Shortcuts
					</h3>
					<ul class="nav shortcuts">
						{#each browser.shortcuts as shortcut (shortcut.id)}
							<li>
								<button
									type="button"
									class:active={browser.place.kind === 'folder' && browser.place.id === shortcut.id}
									title={shortcut.location}
									onclick={() => void browser.openShortcut(shortcut.id)}
								>
									<Icon name="folder" size={17} />
									<span class="nav-text">{shortcut.name}</span>
								</button>
								<button
									type="button"
									class="shortcut-remove"
									aria-label="Remove shortcut {shortcut.name}"
									title="Remove shortcut"
									onclick={() => void browser.removeShortcut(shortcut.id)}
								>
									<Icon name="close" size={14} />
								</button>
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			{#if browser.sharedDrives.length}
				<h3 class="nav-title">Shared drives</h3>
				<ul class="nav">
					{#each browser.sharedDrives as drive (drive.id)}
						<li>
							<button
								type="button"
								class:active={browser.place.kind === 'folder' && browser.crumbs[0]?.id === drive.id}
								onclick={() => browser.goSharedDrive(drive)}
							>
								<Icon name="shared" size={18} />
								<span class="nav-text">{drive.name}</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}

			{#if browser.syncPairs.length}
				<h3 class="nav-title">Synced folders</h3>
				<ul class="nav synced">
					{#each browser.syncPairs as pair (pair.id)}
						<li title="{pair.drivePath} ⇄ {pair.localPath}">
							<button
								type="button"
								class="synced-row"
								title="Open {pair.localPath}"
								onclick={() =>
									void openLocalPath(pair.localPath).catch((error) => browser.notify(errorMessage(error)))}
							>
								<Icon name="sync" size={16} />
								<span class="nav-text">{pair.driveFolderName}</span>
								{#if pair.lastError}
									<span class="sync-error"><Icon name="warning" size={14} label={pair.lastError} /></span>
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</nav>

		<main
			class="content"
			class:dragging={browser.dragging}
			ondragenter={onDragEnter}
			ondragleave={onDragLeave}
			ondrop={(event) => void onDrop(event)}
		>
			{#if selected.length}
				<div class="toolbar selection" role="toolbar" aria-label="Selection actions">
					<button type="button" class="icon-btn" aria-label="Clear selection" onclick={() => browser.clearSelection()}>
						<Icon name="close" size={18} />
					</button>
					<span class="count">{selected.length} selected</span>
					{#if inTrash}
						<button type="button" class="tool" disabled={!browser.canEdit} onclick={() => void browser.restore(selected)}>
							<Icon name="restore" size={17} /> Restore
						</button>
					{:else}
						<button type="button" class="tool" title="Download" onclick={() => void browser.download(selected)}>
							<Icon name="download" size={17} /> Download
						</button>
						<button
							type="button"
							class="tool"
							title={removal === 'remove' ? 'Remove' : 'Move to trash'}
							disabled={!browser.canEdit || removal === null}
							onclick={() => void browser.removeSelected(selected)}
						>
							<Icon name="trash" size={17} />
							{removal === 'remove' ? 'Remove' : 'Trash'}
						</button>
						<button type="button" class="tool" title="Star" onclick={() => void browser.toggleStar(selected)}>
							<Icon name="star" size={17} />
							{selected.every((item) => item.starred) ? 'Unstar' : 'Star'}
						</button>
						{#if browser.shortcutLabel(selected)}
							<button type="button" class="tool" onclick={() => void browser.toggleShortcuts(selected)}>
								<Icon name="shortcut" size={17} />
								{browser.shortcutLabel(selected)}
							</button>
						{/if}
						{#if single}
							<button
								type="button"
								class="tool"
								disabled={!browser.canEdit || !single.canRename}
								onclick={() => (browser.dialog = { kind: 'rename', item: single })}
							>
								<Icon name="edit" size={17} /> Rename
							</button>
							{#if single.isFolder}
								<button
									type="button"
									class="tool"
									onclick={() =>
										(browser.dialog = { kind: 'sync', item: single, path: browser.locationOf(single) })}
								>
									<Icon name="sync" size={17} />
									{browser.syncPairFor(single.id) ? 'Edit sync' : 'Sync'}
								</button>
							{/if}
							<button type="button" class="tool" onclick={() => browser.openInDrive(single)}>
								<Icon name="external" size={17} /> Open in Drive
							</button>
						{/if}
					{/if}
				</div>
			{:else}
				<div class="toolbar">
					<button type="button" class="icon-btn" aria-label="Back" title="Back (Alt+←)" disabled={!browser.canGoBack} onclick={() => browser.back()}>
						<Icon name="arrow-left" size={18} />
					</button>
					<button type="button" class="icon-btn" aria-label="Forward" title="Forward (Alt+→)" disabled={!browser.canGoForward} onclick={() => browser.forward()}>
						<Icon name="arrow-right" size={18} />
					</button>
					<ol class="crumbs" aria-label="Location" {@attach pinCrumbs}>
						{#each browser.crumbs as crumb, index (crumb.id + index)}
							<li>
								{#if index > 0}<span class="sep"><Icon name="chevron" size={16} /></span>{/if}
								<button
									type="button"
									class="crumb"
									title={crumb.name}
									aria-current={index === browser.crumbs.length - 1 ? 'location' : undefined}
									onclick={() => browser.goCrumb(index)}
								>
									{crumb.name}
								</button>
							</li>
						{/each}
					</ol>
					{#if browser.view === 'grid'}
						<label class="sort">
							<span class="visually-hidden">Sort by</span>
							<select value={browser.sortKey} onchange={(event) => browser.sortBy(event.currentTarget.value as SortKey)}>
								{#each Object.entries(sortLabels) as [key, label] (key)}
									<option value={key}>{label}</option>
								{/each}
							</select>
						</label>
						<button
							type="button"
							class="icon-btn"
							aria-label={browser.sortAscending ? 'Sort descending' : 'Sort ascending'}
							onclick={() => browser.sortBy(browser.sortKey)}
						>
							<Icon name={browser.sortAscending ? 'arrow-up' : 'arrow-down'} size={17} />
						</button>
					{/if}
					<button
						type="button"
						class="icon-btn"
						aria-label="Refresh"
						title="Refresh (F5)"
						onclick={() => void browser.load()}
					>
						<span class:spinning={browser.items.status === 'loading'}><Icon name="refresh" size={17} /></span>
					</button>
				</div>
			{/if}

			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
			<div
				class="scroller"
				onclick={onBackgroundClick}
				oncontextmenu={(event) => {
					if (event.target === event.currentTarget) browser.openContextMenu(event, null);
				}}
			>
				<ItemsView />
			</div>

			{#if browser.dragging && !browser.dropFolder}
				<div class="drop-overlay" class:blocked={!browser.canUploadHere}>
					<div class="drop-card">
						<Icon name="upload" size={28} />
						{#if browser.canUploadHere}
							Drop files to upload them to <strong>{dropLabel}</strong>
						{:else if !browser.canEdit}
							Uploading is off. Turn on “Allow file upload and edit” in Settings.
						{:else}
							Open a folder to upload into it
						{/if}
					</div>
				</div>
			{:else if browser.dropFolder}
				<div class="drop-hint">Drop to upload or move into <strong>{browser.dropFolder.name}</strong></div>
			{/if}
		</main>
	</div>

	<ContextMenu onuploadfiles={pickFiles} onuploadfolder={pickFolder} />
	<TransferPanel />

	{#if browser.toasts.length}
		<div class="toasts" aria-live="polite">
			{#each browser.toasts as toast (toast.id)}
				<div class="toast">
					<span>{toast.message}</span>
					{#if toast.action}
						<button
							type="button"
							class="toast-action"
							onclick={() => {
								toast.action?.();
								browser.dismissToast(toast.id);
							}}
						>
							{toast.actionLabel}
						</button>
					{/if}
					<button type="button" class="icon-btn" aria-label="Dismiss" onclick={() => browser.dismissToast(toast.id)}>
						<Icon name="close" size={15} />
					</button>
				</div>
			{/each}
		</div>
	{/if}

	{#if browser.dialog?.kind === 'new-folder'}
		<NameDialog
			title="New folder"
			initial="Untitled folder"
			confirmLabel="Create"
			oncancel={() => (browser.dialog = null)}
			onsubmit={(name) => {
				browser.dialog = null;
				void browser.createFolder(name);
			}}
		/>
	{:else if browser.dialog?.kind === 'rename'}
		{@const item = browser.dialog.item}
		<NameDialog
			title="Rename"
			initial={item.name}
			confirmLabel="OK"
			oncancel={() => (browser.dialog = null)}
			onsubmit={(name) => {
				browser.dialog = null;
				void browser.rename(item, name);
			}}
		/>
	{:else if browser.dialog?.kind === 'sync'}
		<SyncDialog
			folder={browser.dialog.item}
			drivePath={browser.dialog.path}
			existing={browser.syncPairFor(browser.dialog.item.id)}
			canEdit={browser.canEdit}
			onclose={closeSync}
		/>
	{/if}
{/if}

<style>
	.gate {
		display: grid;
		min-height: 100dvh;
		place-items: center;
		padding: 1.5rem;
	}

	.app {
		display: grid;
		grid-template-columns: 16rem minmax(0, 1fr);
		grid-template-rows: auto minmax(0, 1fr);
		height: 100dvh;
		background: var(--bg);
	}

	.topbar {
		display: flex;
		grid-column: 1 / -1;
		align-items: center;
		gap: 1rem;
		padding: 0.55rem 1rem;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		width: 15rem;
		flex-shrink: 0;
	}

	.logo {
		display: grid;
		place-items: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 10px;
		background: var(--accent);
		color: #fff;
	}

	.brand-name {
		font-size: 1.3rem;
		font-weight: 400;
	}

	.search {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 0.6rem;
		max-width: 44rem;
		height: 2.9rem;
		padding: 0 0.6rem 0 1.1rem;
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--text-muted);
	}

	.search:focus-within {
		background: var(--surface);
		box-shadow: 0 1px 4px rgb(0 0 0 / 30%);
	}

	.search input {
		flex: 1;
		min-width: 0;
		border: 0;
		background: transparent;
		font-size: 1rem;
		outline: none;
	}

	.search input::-webkit-search-cancel-button {
		display: none;
	}

	.top-actions {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-left: auto;
	}

	.segmented {
		display: flex;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: 999px;
	}

	.segmented button {
		display: grid;
		place-items: center;
		width: 2.6rem;
		height: 2.1rem;
		border: 0;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}

	.segmented button + button {
		border-left: 1px solid var(--border);
	}

	.segmented button[aria-pressed='true'] {
		background: var(--accent-soft);
		color: var(--accent);
	}

	.sidebar {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-height: 0;
		padding: 0.5rem 0.75rem 1rem 0.5rem;
		overflow: auto;
	}

	.new-wrap {
		position: relative;
		margin: 0.25rem 0 0.9rem 0.25rem;
	}

	.new-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.75rem;
		height: 3.5rem;
		padding: 0 1.4rem 0 1rem;
		border: 0;
		border-radius: 16px;
		background: var(--surface);
		box-shadow:
			0 1px 2px rgb(0 0 0 / 30%),
			0 1px 3px 1px rgb(0 0 0 / 15%);
		font-size: 0.95rem;
		font-weight: 500;
		cursor: pointer;
	}

	.new-btn:hover:not(:disabled) {
		background: var(--surface-hover);
	}

	.new-btn:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.menu-scrim {
		position: fixed;
		inset: 0;
		z-index: 20;
		border: 0;
		background: transparent;
	}

	.new-menu {
		position: absolute;
		top: 3.8rem;
		left: 0;
		z-index: 21;
		display: flex;
		flex-direction: column;
		min-width: 15rem;
		padding: 0.4rem 0;
		border-radius: var(--radius-sm);
		background: var(--surface);
		box-shadow: 0 8px 24px rgb(0 0 0 / 30%);
	}

	.new-menu button {
		display: flex;
		align-items: center;
		gap: 0.85rem;
		padding: 0.55rem 1rem;
		border: 0;
		background: transparent;
		font-size: 0.9rem;
		text-align: left;
		cursor: pointer;
	}

	.new-menu button:hover {
		background: var(--surface-hover);
	}

	.new-menu hr {
		margin: 0.35rem 0;
		border: 0;
		border-top: 1px solid var(--border);
	}

	.nav {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.nav button,
	.synced-row {
		display: flex;
		align-items: center;
		gap: 1rem;
		width: 100%;
		height: 2.1rem;
		padding: 0 1rem 0 1.1rem;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: var(--text);
		font-size: 0.875rem;
		text-align: left;
		cursor: pointer;
	}

	.synced-row {
		color: var(--text-muted);
	}

	.shortcut-panel {
		margin: 0.85rem 0.5rem 0 0.25rem;
		padding: 0.5rem 0.25rem 0.4rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
	}

	.shortcut-title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0 0 0.25rem 0.85rem;
		color: var(--text-muted);
		font-size: 0.75rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.shortcuts li > button:first-child {
		padding-left: 0.85rem;
		gap: 0.75rem;
	}

	.shortcuts li {
		display: flex;
		align-items: center;
		gap: 0.1rem;
		padding-right: 0.35rem;
	}

	.shortcuts li > button:first-child {
		width: auto;
		min-width: 0;
		flex: 1;
	}

	.nav .shortcut-remove {
		width: 1.6rem;
		height: 1.6rem;
		flex: none;
		justify-content: center;
		padding: 0;
		color: var(--text-muted);
	}

	.nav button:hover {
		background: var(--surface-hover);
	}

	.nav button.active {
		background: var(--accent-soft);
		color: var(--accent);
		font-weight: 600;
	}

	.nav-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.sync-error {
		margin-left: auto;
		color: var(--danger);
	}

	.nav-title {
		margin: 1rem 0 0.25rem 1.1rem;
		color: var(--text-muted);
		font-size: 0.75rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.content {
		position: relative;
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		margin: 0 0.75rem 0.75rem 0;
		overflow: hidden;
		border-radius: 16px;
		background: var(--surface);
	}

	.toolbar {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
		min-height: 3.5rem;
		padding: 0.4rem 0.75rem;
	}

	.toolbar.selection {
		margin: 0.4rem 0.6rem;
		min-height: 2.75rem;
		border-radius: 999px;
		background: var(--surface-2);
	}

	.count {
		margin: 0 0.75rem 0 0.25rem;
		font-size: 0.9rem;
		font-weight: 500;
	}

	.tool {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		height: 2.1rem;
		padding: 0 0.75rem;
		border: 0;
		border-radius: 999px;
		background: transparent;
		font-size: 0.85rem;
		cursor: pointer;
	}

	.tool:hover:not(:disabled) {
		background: var(--surface-hover);
	}

	.tool:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.crumbs {
		display: flex;
		flex: 1;
		flex-wrap: nowrap;
		align-items: center;
		min-width: 0;
		margin: 0 0 0 0.25rem;
		padding: 0;
		overflow-x: auto;
		overflow-y: hidden;
		overscroll-behavior-x: contain;
		list-style: none;
		scrollbar-width: none;
	}

	.crumbs::-webkit-scrollbar {
		display: none;
	}

	.crumbs li {
		display: flex;
		flex: 0 1 auto;
		align-items: center;
		min-width: 2.75rem;
		max-width: 16rem;
		overflow: hidden;
	}

	.crumbs li:last-child {
		flex-shrink: 0;
		min-width: 3rem;
		max-width: min(28rem, 70%);
	}

	.sep {
		display: inline-flex;
		flex: none;
		color: var(--text-muted);
	}

	.crumb {
		flex: 1 1 auto;
		min-width: 0;
		max-width: 100%;
		overflow: hidden;
		padding: 0.3rem 0.7rem;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: var(--text-muted);
		font-size: 1.15rem;
		text-overflow: ellipsis;
		white-space: nowrap;
		cursor: pointer;
	}

	.crumb:hover {
		background: var(--surface-hover);
	}

	.crumb[aria-current='location'] {
		color: var(--text);
		font-size: 1.35rem;
	}

	.sort select {
		height: 2rem;
		padding: 0 0.5rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		font: inherit;
		font-size: 0.85rem;
	}

	.spinning {
		display: grid;
		animation: spin 0.9s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.scroller {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-height: 0;
		padding: 0 0.75rem;
		overflow: auto;
	}

	.drop-overlay {
		position: absolute;
		inset: 0;
		z-index: 5;
		display: grid;
		place-items: end center;
		padding-bottom: 2.5rem;
		border: 2px solid var(--accent);
		border-radius: 16px;
		background: rgb(26 115 232 / 8%);
		pointer-events: none;
	}

	.drop-overlay.blocked {
		border-color: var(--warning);
		background: rgb(176 96 0 / 8%);
	}

	.drop-card,
	.drop-hint {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.8rem 1.4rem;
		border-radius: 999px;
		background: var(--accent);
		color: #fff;
		font-size: 0.95rem;
		box-shadow: 0 6px 20px rgb(0 0 0 / 30%);
	}

	.drop-hint {
		position: absolute;
		bottom: 2rem;
		left: 50%;
		z-index: 5;
		transform: translateX(-50%);
		pointer-events: none;
	}

	.blocked .drop-card {
		background: var(--warning);
	}

	.toasts {
		position: fixed;
		bottom: 1.25rem;
		left: 1.25rem;
		z-index: 35;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.toast {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		max-width: 32rem;
		padding: 0.55rem 0.5rem 0.55rem 1rem;
		border-radius: 6px;
		background: #323232;
		color: #f1f1f1;
		font-size: 0.875rem;
		box-shadow: 0 6px 20px rgb(0 0 0 / 35%);
	}

	.toast .icon-btn {
		color: #c8c8c8;
	}

	.toast-action {
		border: 0;
		background: transparent;
		color: #8ab4f8;
		font-weight: 600;
		cursor: pointer;
	}

	@media (max-width: 900px) {
		.app {
			grid-template-columns: 4.25rem minmax(0, 1fr);
		}

		.brand {
			width: auto;
		}

		.brand-name,
		.nav-title,
		.nav-text,
		.synced {
			display: none;
		}

		.new-btn {
			width: 3.25rem;
			padding: 0;
			justify-content: center;
			font-size: 0;
		}

		.nav button {
			justify-content: center;
			padding: 0;
			font-size: 0;
		}
	}
</style>
