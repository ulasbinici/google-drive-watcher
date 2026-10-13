<script lang="ts">
	import Icon, { type IconName } from '$lib/components/Icon.svelte';
	import { getBrowserState } from './browser-state.svelte';

	interface Props {
		onuploadfiles: () => void;
		onuploadfolder: () => void;
	}

	let { onuploadfiles, onuploadfolder }: Props = $props();
	const browser = getBrowserState();

	interface Entry {
		label: string;
		icon: IconName;
		run: () => void;
		disabled?: boolean;
		danger?: boolean;
		divider?: boolean;
	}

	const entries = $derived.by((): Entry[] => {
		const menu = browser.menu;
		if (!menu) return [];
		const items = menu.items;
		if (items.length === 0) {
			const writable = browser.canUploadHere;
			return [
				{ label: 'New folder', icon: 'folder-plus', run: () => (browser.dialog = { kind: 'new-folder' }), disabled: !writable },
				{ label: 'File upload', icon: 'upload', run: onuploadfiles, disabled: !writable, divider: true },
				{ label: 'Folder upload', icon: 'upload', run: onuploadfolder, disabled: !writable },
				{ label: 'Refresh', icon: 'refresh', run: () => void browser.load(), divider: true }
			];
		}
		const single = items.length === 1 ? items[0]! : null;
		if (browser.place.kind === 'trash') {
			return [
				{ label: 'Restore', icon: 'restore', run: () => void browser.restore(items), disabled: !browser.canEdit }
			];
		}
		const list: Entry[] = [];
		if (single) {
			list.push({ label: single.isFolder ? 'Open' : 'Open in Google Drive', icon: single.isFolder ? 'folder' : 'external', run: () => browser.open(single) });
		}
		list.push({ label: 'Download', icon: 'download', run: () => void browser.download(items) });
		if (single) {
			list.push({
				label: 'Rename',
				icon: 'edit',
				run: () => (browser.dialog = { kind: 'rename', item: single }),
				disabled: !browser.canEdit || !single.canRename,
				divider: true
			});
		}
		const allStarred = items.every((item) => item.starred);
		list.push({
			label: allStarred ? 'Remove from Starred' : 'Add to Starred',
			icon: 'star',
			run: () => void browser.toggleStar(items),
			divider: !single
		});
		if (single?.isFolder) {
			const synced = browser.syncPairFor(single.id);
			list.push({
				label: synced ? 'Edit folder sync…' : 'Sync with a local folder…',
				icon: 'sync',
				run: () => (browser.dialog = { kind: 'sync', item: single, path: browser.locationOf(single) }),
				divider: true
			});
		}
		if (single?.isFolder) {
			list.push({ label: 'Open in Google Drive', icon: 'external', run: () => browser.openInDrive(single) });
		}
		const removal = browser.removalAction(items);
		list.push({
			label: removal === 'remove' ? 'Remove' : 'Move to trash',
			icon: 'trash',
			run: () => void browser.removeSelected(items),
			disabled: !browser.canEdit || removal === null,
			danger: true,
			divider: true
		});
		return list;
	});

	function place(node: HTMLElement) {
		const menu = browser.menu;
		if (!menu) return;
		const rect = node.getBoundingClientRect();
		const x = Math.min(menu.x, window.innerWidth - rect.width - 8);
		const y = menu.y + rect.height > window.innerHeight - 8 ? Math.max(8, menu.y - rect.height) : menu.y;
		node.style.left = `${Math.max(8, x)}px`;
		node.style.top = `${y}px`;
		node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
	}

	function choose(entry: Entry) {
		browser.menu = null;
		entry.run();
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') browser.menu = null;
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		event.preventDefault();
		const buttons = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
		const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
		const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
		buttons[(next + buttons.length) % buttons.length]?.focus();
	}
</script>

{#if browser.menu}
	<button
		type="button"
		class="scrim"
		aria-label="Close menu"
		onclick={() => (browser.menu = null)}
		oncontextmenu={(event) => {
			event.preventDefault();
			browser.menu = null;
		}}
	></button>
	<div class="menu" role="menu" tabindex="-1" {@attach place} onkeydown={onKeydown}>
		{#each entries as entry (entry.label)}
			{#if entry.divider}<hr />{/if}
			<button
				type="button"
				role="menuitem"
				class:danger={entry.danger}
				disabled={entry.disabled}
				onclick={() => choose(entry)}
			>
				<Icon name={entry.icon} size={17} />
				{entry.label}
			</button>
		{/each}
	</div>
{/if}

<style>
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 30;
		border: 0;
		background: transparent;
		cursor: default;
	}

	.menu {
		position: fixed;
		z-index: 31;
		display: flex;
		flex-direction: column;
		min-width: 15rem;
		padding: 0.4rem 0;
		border-radius: var(--radius-sm);
		background: var(--surface);
		box-shadow:
			0 2px 6px rgb(0 0 0 / 25%),
			0 8px 24px rgb(0 0 0 / 25%);
	}

	button[role='menuitem'] {
		display: flex;
		align-items: center;
		gap: 0.85rem;
		padding: 0.45rem 1rem;
		border: 0;
		background: transparent;
		font-size: 0.88rem;
		text-align: left;
		cursor: pointer;
	}

	button[role='menuitem']:hover:not(:disabled),
	button[role='menuitem']:focus-visible {
		background: var(--surface-hover);
		box-shadow: none;
	}

	button[role='menuitem']:disabled {
		opacity: 0.45;
		cursor: default;
	}

	.danger {
		color: var(--danger);
	}

	hr {
		margin: 0.35rem 0;
		border: 0;
		border-top: 1px solid var(--border);
	}
</style>
