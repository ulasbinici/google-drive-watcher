<script lang="ts">
	import { openExternalUrl } from '$lib/native';
	import { getAppState } from '$lib/state/app-state.svelte';
	import { shortcutDriveUrl, type FolderShortcut } from '$lib/state/folder-shortcuts';
	import Icon from './Icon.svelte';

	const app = getAppState();

	function openDrive(event: MouseEvent, shortcut: FolderShortcut) {
		event.preventDefault();
		void openExternalUrl(shortcutDriveUrl(shortcut));
	}
</script>

{#if app.shortcuts.length}
	<section class="card shortcuts" aria-labelledby="shortcuts-heading">
		<div class="card-header">
			<h2 id="shortcuts-heading">Shortcuts</h2>
		</div>
		<ul>
			{#each app.shortcuts as shortcut (shortcut.id)}
				<li>
					<label class="tray" title={shortcut.inTray ? 'Shown in the tray menu' : 'Show in the tray menu'}>
						<input
							type="checkbox"
							checked={shortcut.inTray}
							aria-label={shortcut.inTray
								? `Remove ${shortcut.name} from the tray menu`
								: `Show ${shortcut.name} in the tray menu`}
							onchange={(event) => {
								const input = event.currentTarget;
								if (input instanceof HTMLInputElement) {
									void app.setShortcutInTray(shortcut.id, input.checked);
								}
							}}
						/>
					</label>
					<button
						type="button"
						class="open"
						title={shortcut.location || shortcut.name}
						onclick={() => void app.openShortcut(shortcut)}
					>
						<Icon name="folder" size={15} />
						<span class="name">{shortcut.name}</span>
					</button>
					<a
						href={shortcutDriveUrl(shortcut)}
						title="Open in Google Drive"
						aria-label="Open {shortcut.name} in Google Drive"
						onclick={(event) => openDrive(event, shortcut)}
					>
						<Icon name="external" size={14} />
					</a>
					<button
						type="button"
						class="remove"
						aria-label="Remove shortcut {shortcut.name}"
						onclick={() => void app.removeShortcut(shortcut.id)}
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
	}

	ul {
		box-sizing: border-box;
		display: flex;
		flex-wrap: wrap;
		align-content: flex-start;
		gap: 0.4rem;
		/* Two chip rows, then the list scrolls. One row stays one row tall. */
		max-height: calc(2 * 1.85rem + 0.4rem + 1rem);
		margin: 0;
		padding: 0.15rem 1rem 0.85rem;
		overflow-x: hidden;
		overflow-y: auto;
		list-style: none;
	}

	li {
		display: flex;
		flex: 0 1 auto;
		align-items: center;
		gap: 0.15rem;
		height: 1.85rem;
		max-width: 100%;
		padding: 0 0.15rem 0 0.4rem;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface-2);
	}

	.tray {
		display: grid;
		flex: none;
		place-items: center;
	}

	.tray input {
		width: 0.85rem;
		height: 0.85rem;
		margin: 0;
		accent-color: var(--accent);
		cursor: pointer;
	}

	.open {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		min-width: 0;
		max-width: 14rem;
		padding: 0 0.15rem;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}

	.name {
		overflow: hidden;
		font-size: 0.82rem;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	a,
	.remove {
		display: grid;
		flex: none;
		place-items: center;
		width: 1.45rem;
		height: 1.45rem;
		padding: 0;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: var(--text-muted);
		text-decoration: none;
		cursor: pointer;
	}

	a:hover,
	.remove:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
</style>
