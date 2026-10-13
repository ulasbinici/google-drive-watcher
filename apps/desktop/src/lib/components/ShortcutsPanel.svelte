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
						<div class="top">
							<button
								type="button"
								class="open"
								title={shortcut.location}
								onclick={() => void app.openShortcut(shortcut)}
							>
								<Icon name="folder" size={18} />
								<span class="copy">
									<span class="name">{shortcut.name}</span>
									{#if shortcut.location}
										<span class="location">{shortcut.location}</span>
									{/if}
								</span>
							</button>
							<button
								type="button"
								class="remove"
								aria-label="Remove shortcut"
								onclick={() => void app.removeShortcut(shortcut.id)}
							>
								<Icon name="close" size={14} />
							</button>
						</div>
						<a href={shortcutDriveUrl(shortcut)} onclick={(event) => openDrive(event, shortcut)}>
							Open in Google Drive
						</a>
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
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		max-height: 11.5rem;
		margin: 0;
		padding: 0.85rem 1rem 1rem;
		overflow: auto;
		list-style: none;
	}

	li {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		width: min(100%, 16rem);
		min-width: 0;
		padding: 0.45rem 0.45rem 0.45rem 0.55rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
	}

	.top {
		display: flex;
		align-items: flex-start;
		gap: 0.25rem;
	}

	.open {
		display: flex;
		align-items: flex-start;
		gap: 0.45rem;
		width: 100%;
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}

	.copy {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}

	.name {
		overflow: hidden;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.location {
		overflow: hidden;
		color: var(--text-muted);
		font-size: 0.75rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	a {
		align-self: flex-start;
		margin-left: 1.6rem;
		color: var(--accent);
		font-size: 0.75rem;
		text-decoration: none;
	}

	a:hover {
		text-decoration: underline;
	}

	.remove {
		flex: none;
		padding: 0.15rem;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}

	.remove:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
</style>
