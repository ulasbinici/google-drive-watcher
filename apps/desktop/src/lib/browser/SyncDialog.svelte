<script lang="ts">
	import type { DriveItem } from '$lib/drive/drive-api';
	import { errorMessage } from '$lib/format';
	import { pickLocalFolder } from '$lib/native';
	import {
		DIRECTION_LABELS,
		removePair,
		requestSyncRun,
		upsertPair,
		type SyncDirection,
		type SyncPair
	} from '$lib/sync/sync-store';

	interface Props {
		folder: DriveItem;
		drivePath: string;
		existing: SyncPair | undefined;
		canEdit: boolean;
		onclose: (message?: string) => void;
	}

	let { folder, drivePath, existing, canEdit, onclose }: Props = $props();

	// Seeded once from the existing pair; the dialog is recreated each time it opens.
	const initial = (() => existing)();
	let localPath = $state(initial?.localPath ?? '');
	let direction = $state<SyncDirection>(initial?.direction ?? 'two-way');
	let busy = $state(false);
	let error = $state<string | null>(null);

	const directions = Object.entries(DIRECTION_LABELS) as [SyncDirection, string][];
	const DESCRIPTIONS: Record<SyncDirection, string> = {
		'two-way': 'Changes on either side are copied to the other. The newer file wins.',
		download: 'Drive is the source. New and changed Drive files are copied to this PC.',
		upload: 'This PC is the source. New and changed local files are copied to Drive.'
	};

	async function choose() {
		error = null;
		try {
			const picked = await pickLocalFolder(`Local folder for “${folder.name}”`);
			if (picked) localPath = picked;
		} catch (err) {
			error = errorMessage(err);
		}
	}

	async function save() {
		if (!localPath) return;
		busy = true;
		error = null;
		try {
			const pair = await upsertPair({
				id: existing?.id,
				driveFolderId: folder.id,
				driveFolderName: folder.name,
				drivePath,
				driveId: folder.driveId,
				localPath,
				direction
			});
			await requestSyncRun(pair.id);
			onclose(`Syncing “${folder.name}” with ${localPath}`);
		} catch (err) {
			error = errorMessage(err);
			busy = false;
		}
	}

	async function remove() {
		if (!existing) return;
		busy = true;
		await removePair(existing.id);
		onclose(`Stopped syncing “${folder.name}”`);
	}
</script>

<div class="backdrop">
	<button type="button" class="scrim" aria-label="Cancel" onclick={() => onclose()}></button>
	<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="sync-title">
		<h2 id="sync-title">{existing ? 'Edit folder sync' : 'Sync with a local folder'}</h2>

		<div class="field">
			<span class="label">Google Drive folder</span>
			<span class="value" title={drivePath}>{drivePath}</span>
		</div>

		<div class="field">
			<span class="label">Folder on this PC</span>
			<div class="pick">
				<span class="value" class:muted={!localPath} title={localPath}>
					{localPath || 'No folder chosen'}
				</span>
				<button type="button" class="btn btn-sm" onclick={choose} disabled={busy}>
					{localPath ? 'Change…' : 'Choose…'}
				</button>
			</div>
		</div>

		<fieldset>
			<legend class="label">Direction</legend>
			{#each directions as [value, label] (value)}
				<label class="choice">
					<input type="radio" name="direction" {value} bind:group={direction} disabled={busy} />
					<span>
						<strong>{label}</strong>
						<span class="muted">{DESCRIPTIONS[value]}</span>
					</span>
				</label>
			{/each}
		</fieldset>

		{#if direction !== 'download' && !canEdit}
			<p class="hint">
				Uploading needs “Allow file upload and edit” in Settings. Until then this folder only downloads.
			</p>
		{/if}
		{#if error}
			<p class="error" role="alert">{error}</p>
		{/if}

		<div class="actions">
			{#if existing}
				<button type="button" class="btn btn-ghost danger" onclick={remove} disabled={busy}>
					Stop syncing
				</button>
			{/if}
			<span class="spacer"></span>
			<button type="button" class="btn btn-ghost" onclick={() => onclose()} disabled={busy}>
				Cancel
			</button>
			<button type="button" class="btn btn-primary" onclick={save} disabled={busy || !localPath}>
				{existing ? 'Save' : 'Start syncing'}
			</button>
		</div>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 40;
		display: grid;
		place-items: center;
	}

	.scrim {
		position: absolute;
		inset: 0;
		border: 0;
		background: rgb(15 20 28 / 45%);
	}

	.dialog {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		width: min(32rem, calc(100vw - 2rem));
		max-height: calc(100dvh - 2rem);
		overflow: auto;
		padding: 1.25rem;
		border-radius: var(--radius);
		background: var(--surface);
		box-shadow: 0 12px 40px rgb(0 0 0 / 35%);
	}

	h2 {
		font-size: 1.1rem;
		font-weight: 500;
	}

	.field,
	fieldset {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.label {
		color: var(--text-muted);
		font-size: 0.78rem;
		font-weight: 600;
		letter-spacing: 0.02em;
		text-transform: uppercase;
	}

	.value {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.pick {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	.pick .value {
		flex: 1;
		padding: 0.45rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		font-size: 0.88rem;
	}

	.choice {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
		padding: 0.5rem 0.6rem;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.choice:hover {
		background: var(--surface-hover);
	}

	.choice span {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}

	.choice .muted {
		font-size: 0.82rem;
	}

	.hint {
		padding: 0.55rem 0.7rem;
		border-radius: var(--radius-sm);
		background: var(--warning-soft);
		color: var(--warning);
		font-size: 0.84rem;
	}

	.error {
		color: var(--danger);
		font-size: 0.85rem;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.spacer {
		flex: 1;
	}

	.danger {
		color: var(--danger);
	}
</style>
