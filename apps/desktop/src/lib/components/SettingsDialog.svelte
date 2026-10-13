<script lang="ts">
	import { formatRelative } from '$lib/format';
	import { openBrowseWindow, revealLocalPath } from '$lib/native';
	import { getAppState } from '$lib/state/app-state.svelte';
	import { getSyncManager } from '$lib/sync/sync-manager.svelte';
	import { DIRECTION_LABELS, type SyncDirection } from '$lib/sync/sync-store';
	import Spinner from './Spinner.svelte';

	const app = getAppState();
	const sync = getSyncManager();
	const directions = Object.entries(DIRECTION_LABELS) as [SyncDirection, string][];

	function onToggle(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		void app.setFileEdits(input.checked).finally(() => {
			input.checked = app.allowFileEdits;
		});
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && app.settingsOpen) app.settingsOpen = false;
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if app.settingsOpen}
	<div class="backdrop">
		<button
			type="button"
			class="scrim"
			aria-label="Close settings"
			onclick={() => (app.settingsOpen = false)}
		></button>
		<div class="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
			<div class="heading">
				<h2 id="settings-title">Settings</h2>
				<button type="button" class="btn btn-sm btn-ghost" onclick={() => (app.settingsOpen = false)}>
					Close
				</button>
			</div>

			<section class="block">
				<label class="option">
					<input
						type="checkbox"
						checked={app.allowFileEdits}
						disabled={app.settingsBusy}
						onchange={onToggle}
					/>
					<span>
						<strong>Allow file upload and edit</strong>
						<span class="muted">
							Off by default, so Drive stays read-only: you can browse and download. Turning this on
							asks Google for permission to upload, rename, move and delete files.
						</span>
					</span>
				</label>
				{#if app.settingsBusy}
					<p class="muted status">Waiting for Google…</p>
				{/if}
				{#if app.settingsError}
					<p class="error" role="alert">{app.settingsError}</p>
				{/if}
			</section>

			<section class="block">
				<div class="block-head">
					<h3>Synced folders</h3>
					{#if sync.pairs.length > 0}
						<button
							type="button"
							class="btn btn-sm"
							disabled={sync.runningId !== null}
							onclick={() => sync.request(null)}
						>
							Sync all now
						</button>
					{/if}
				</div>
				{#if sync.pairs.length === 0}
					<p class="muted empty">
						No synced folders yet. In
						<button type="button" class="link" onclick={() => void openBrowseWindow()}>Browse</button>,
						right-click a folder and choose <strong>Sync with a local folder</strong>.
					</p>
				{:else}
					<ul class="pairs">
						{#each sync.pairs as pair (pair.id)}
							{@const running = sync.runningId === pair.id}
							<li class="pair">
								<div class="paths">
									<span class="drive" title={pair.drivePath}>{pair.drivePath}</span>
									<span class="arrow" aria-hidden="true">
										{pair.direction === 'two-way' ? '⇄' : pair.direction === 'download' ? '→' : '←'}
									</span>
									<span class="local" title={pair.localPath}>{pair.localPath}</span>
								</div>
								<div class="pair-controls">
									<label class="visually-hidden" for="direction-{pair.id}">Sync direction</label>
									<select
										id="direction-{pair.id}"
										value={pair.direction}
										disabled={running}
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
										disabled={sync.runningId !== null}
										onclick={() => sync.request(pair.id)}
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
										disabled={running}
										onclick={() => void sync.remove(pair.id)}
									>
										Remove
									</button>
								</div>
								<p class="muted pair-status">
									{#if running}
										<Spinner size={12} />
										{sync.progress ?? 'Syncing…'}
									{:else if pair.lastSyncAt}
										Last sync {formatRelative(pair.lastSyncAt, app.now)}
										{#if pair.lastSummary}· {pair.lastSummary}{/if}
									{:else}
										Waiting for first sync
									{/if}
								</p>
								{#if pair.lastError && !running}
									<p class="error pair-error">{pair.lastError}</p>
								{/if}
							</li>
						{/each}
					</ul>
					<p class="muted note">
						Syncs run every 5 minutes while Drive Watch is open. Deleting a file on one side does not
						delete it on the other. Google Docs, Sheets and Slides are skipped.
					</p>
				{/if}
			</section>
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 20;
		display: grid;
		place-items: center;
		padding: 1rem;
	}

	.scrim {
		position: absolute;
		inset: 0;
		border: 0;
		background: rgb(15 20 28 / 45%);
		cursor: default;
	}

	.settings {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		width: min(44rem, 100%);
		max-height: calc(100dvh - 2rem);
		overflow: auto;
		padding: 1.1rem 1.2rem 1.25rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		box-shadow: var(--shadow);
	}

	.heading,
	.block-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	h2 {
		font-size: 1.05rem;
	}

	h3 {
		font-size: 0.92rem;
	}

	.block {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		padding-top: 0.9rem;
		border-top: 1px solid var(--border);
	}

	.option {
		display: flex;
		align-items: flex-start;
		gap: 0.7rem;
		cursor: pointer;
	}

	.option span {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.option .muted,
	.empty,
	.note,
	.status {
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
		gap: 0.55rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.pair {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		padding: 0.7rem 0.8rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
	}

	.paths {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
		align-items: center;
		gap: 0.6rem;
		font-size: 0.86rem;
	}

	.drive,
	.local {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.drive {
		font-weight: 600;
	}

	.arrow {
		color: var(--accent);
		font-size: 1rem;
	}

	.pair-controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.35rem;
	}

	select {
		min-height: 1.875rem;
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
		font-size: 0.8rem;
	}

	.error {
		color: var(--danger);
		font-size: 0.82rem;
	}
</style>
