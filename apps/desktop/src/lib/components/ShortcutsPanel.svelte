<script lang="ts">
	import { openExternalUrl } from '$lib/native';
	import { getAppState } from '$lib/state/app-state.svelte';
	import { shortcutDriveUrl, type FolderShortcut } from '$lib/state/folder-shortcuts';
	import Icon from './Icon.svelte';

	const app = getAppState();

	let draggingId = $state('');
	let overId = $state('');
	/** Chip id armed by a pointer-down on the chip body. Icon controls leave this empty. */
	let dragHandleId = $state('');
	let suppressClick = false;

	function isIconControl(target: EventTarget | null): boolean {
		return target instanceof Element && Boolean(target.closest('button.icon, a.icon'));
	}

	function chipTitle(shortcut: FolderShortcut): string {
		if (draggingId === shortcut.id) return `Reordering ${shortcut.name}`;
		if (draggingId && overId === shortcut.id) return 'Move shortcut here';
		const place = shortcut.location || shortcut.name;
		return `${place}. Drag to reorder.`;
	}

	function openDrive(event: MouseEvent, shortcut: FolderShortcut) {
		event.preventDefault();
		if (suppressClick) return;
		void openExternalUrl(shortcutDriveUrl(shortcut));
	}

	function onOpen(shortcut: FolderShortcut) {
		if (suppressClick) return;
		void app.openShortcut(shortcut);
	}

	function onPointerDown(event: PointerEvent, id: string) {
		dragHandleId = isIconControl(event.target) ? '' : id;
	}

	function onPointerUp() {
		if (draggingId) return;
		dragHandleId = '';
	}

	function onDragStart(event: DragEvent, id: string) {
		if (dragHandleId !== id || !event.dataTransfer) {
			event.preventDefault();
			return;
		}
		draggingId = id;
		suppressClick = true;
		event.dataTransfer.setData('text/plain', id);
		event.dataTransfer.effectAllowed = 'move';
	}

	function onDragOver(event: DragEvent, id: string) {
		if (!draggingId || draggingId === id) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
		overId = id;
	}

	function onDragLeave(event: DragEvent, id: string) {
		const next = event.relatedTarget;
		if (next instanceof Node && event.currentTarget instanceof Node && event.currentTarget.contains(next)) return;
		if (overId === id) overId = '';
	}

	function clearDrag() {
		draggingId = '';
		overId = '';
		dragHandleId = '';
	}

	function onDrop(event: DragEvent, targetId: string) {
		const sourceId = draggingId;
		if (!sourceId) return;
		event.preventDefault();
		clearDrag();
		if (sourceId === targetId) return;
		const ids = app.shortcuts.map((shortcut) => shortcut.id);
		const from = ids.indexOf(sourceId);
		const to = ids.indexOf(targetId);
		if (from < 0 || to < 0) return;
		const [moved] = ids.splice(from, 1);
		if (!moved) return;
		ids.splice(to, 0, moved);
		void app.reorderShortcuts(ids);
	}

	function onDragEnd() {
		clearDrag();
		window.setTimeout(() => {
			suppressClick = false;
		});
	}
</script>

<svelte:window onpointerup={onPointerUp} />

{#if app.shortcuts.length}
	<section class="card shortcuts" aria-label="Shortcuts">
		<ul>
			{#each app.shortcuts as shortcut (shortcut.id)}
				<li
					class={{
						dragging: draggingId === shortcut.id,
						over: overId === shortcut.id && draggingId !== shortcut.id
					}}
					title={chipTitle(shortcut)}
					draggable={dragHandleId === shortcut.id}
					aria-grabbed={draggingId === shortcut.id ? 'true' : 'false'}
					onpointerdown={(event) => onPointerDown(event, shortcut.id)}
					ondragstart={(event) => onDragStart(event, shortcut.id)}
					ondragover={(event) => onDragOver(event, shortcut.id)}
					ondragleave={(event) => onDragLeave(event, shortcut.id)}
					ondrop={(event) => onDrop(event, shortcut.id)}
					ondragend={onDragEnd}
				>
					<button
						type="button"
						class={['icon', 'tray', { active: shortcut.inTray }]}
						draggable="false"
						aria-pressed={shortcut.inTray}
						title={shortcut.inTray ? 'Remove from the tray menu' : 'Show in the tray menu'}
						aria-label={shortcut.inTray
							? `Remove ${shortcut.name} from the tray menu`
							: `Show ${shortcut.name} in the tray menu`}
						onclick={() => {
							if (suppressClick) return;
							void app.setShortcutInTray(shortcut.id, !shortcut.inTray);
						}}
					>
						<Icon name="tray" size={15} />
					</button>
					<button
						type="button"
						class="open"
						title={chipTitle(shortcut)}
						aria-grabbed={draggingId === shortcut.id ? 'true' : 'false'}
						onclick={() => onOpen(shortcut)}
					>
						<Icon name="folder" size={15} />
						<span class="name">{shortcut.name}</span>
					</button>
					<a
						class="icon"
						href={shortcutDriveUrl(shortcut)}
						draggable="false"
						title="Open in Google Drive"
						aria-label="Open {shortcut.name} in Google Drive"
						onclick={(event) => openDrive(event, shortcut)}
					>
						<Icon name="external" size={14} />
					</a>
					<button
						type="button"
						class="icon"
						draggable="false"
						title="Remove shortcut"
						aria-label="Remove shortcut {shortcut.name}"
						onclick={() => {
							if (suppressClick) return;
							void app.removeShortcut(shortcut.id);
						}}
					>
						<Icon name="close" size={13} />
					</button>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	.shortcuts {
		flex: none;
		min-height: 0;
		background: color-mix(in srgb, white 7%, var(--surface));
	}

	ul {
		box-sizing: border-box;
		display: flex;
		flex-wrap: wrap;
		align-content: flex-start;
		gap: 0.5rem;
		/* Two chip rows, then the list scrolls. A single row stays only as tall as its chips. */
		max-height: calc(2 * 3.15rem + 0.5rem + 1.4rem);
		margin: 0;
		padding: 0.7rem 1rem;
		overflow-x: hidden;
		overflow-y: auto;
		list-style: none;
	}

	li {
		display: flex;
		flex: 0 1 auto;
		align-items: center;
		gap: 0.15rem;
		min-height: 2.75rem;
		max-width: 100%;
		padding: 0.35rem 0.35rem;
		border: 1px solid color-mix(in srgb, var(--text) 22%, var(--border));
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		box-shadow: var(--shadow);
		cursor: grab;
	}

	li:hover {
		background: var(--surface-hover);
	}

	li.dragging {
		opacity: 0.45;
		cursor: grabbing;
	}

	li.over {
		border-color: var(--accent);
		background: var(--accent-soft);
	}

	.open {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		min-width: 0;
		max-width: 15rem;
		padding: 0 0.3rem;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: grab;
	}

	li.dragging .open {
		cursor: grabbing;
	}

	.name {
		display: -webkit-box;
		overflow: hidden;
		font-size: 0.875rem;
		font-weight: 600;
		line-height: 1.25;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		overflow-wrap: anywhere;
	}

	.icon {
		display: grid;
		flex: none;
		place-items: center;
		width: 1.7rem;
		height: 1.7rem;
		padding: 0;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: var(--text-muted);
		text-decoration: none;
		cursor: pointer;
	}

	.icon:hover {
		background: var(--surface-hover);
		color: var(--text);
	}

	.tray.active {
		background: var(--accent-soft);
		color: var(--accent);
	}
</style>
