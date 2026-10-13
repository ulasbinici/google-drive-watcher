<script lang="ts">
	import { appVersion } from '$lib/native';
	import { getAppState } from '$lib/state/app-state.svelte';
	import { getSyncManager } from '$lib/sync/sync-manager.svelte';
	import { MAX_SYNC_INTERVAL_MINUTES, MIN_SYNC_INTERVAL_MINUTES } from '$lib/sync/sync-store';

	const app = getAppState();
	const sync = getSyncManager();
	let version = $state('');

	void appVersion()
		.then((value) => {
			version = value;
		})
		.catch(() => {
			version = '';
		});

	function onToggle(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		void app.setFileEdits(input.checked).finally(() => {
			input.checked = app.allowFileEdits;
		});
	}

	function onMirrorDeletes(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		void sync.setMirrorDeletes(input.checked).finally(() => {
			input.checked = sync.mirrorDeletes;
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
				<h3>Folder sync</h3>
				<label class="interval">
					<span>Sync every</span>
					<input
						type="number"
						min={MIN_SYNC_INTERVAL_MINUTES}
						max={MAX_SYNC_INTERVAL_MINUTES}
						value={sync.intervalMinutes}
						onchange={(event) => {
							const input = event.currentTarget;
							void sync.setIntervalMinutes(Number(input.value)).then(() => {
								input.value = String(sync.intervalMinutes);
							});
						}}
					/>
					<span>minutes</span>
				</label>
				<p class="muted note">
					Runs while Drive Watch is open. Synced folders are listed under Monitoring. 1 to
					{MAX_SYNC_INTERVAL_MINUTES} minutes.
				</p>
				<label class="option">
					<input type="checkbox" checked={sync.mirrorDeletes} onchange={onMirrorDeletes} />
					<span>
						<strong>Mirror deletions</strong>
						<span class="muted">
							Off by default. When on, deleting a file also removes it on the other side. Two-way
							folders delete both ways. Download-only folders only remove the PC copy. Upload-only
							folders only remove the Drive copy, and that copy goes to trash. Turning this on also
							needs “Allow file upload and edit” before a PC delete can reach Drive.
						</span>
					</span>
				</label>
			</section>

			{#if version}
				<p class="muted version">Drive Watch {version}</p>
			{/if}
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

	.heading {
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
	.note,
	.status,
	.version {
		font-size: 0.85rem;
	}

	.interval {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.45rem;
		font-size: 0.9rem;
	}

	.interval input {
		width: 5rem;
		min-height: 1.875rem;
		padding: 0.15rem 0.5rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--text);
		font: inherit;
	}

	.note {
		margin: 0;
	}

	.version {
		margin: 0;
	}

	.error {
		color: var(--danger);
		font-size: 0.82rem;
	}
</style>
