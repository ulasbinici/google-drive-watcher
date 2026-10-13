<script lang="ts">
	import { tick } from 'svelte';
	import { CHANGE_LABELS, formatDateTime, formatRelative } from '$lib/format';
	import { getAppState } from '$lib/state/app-state.svelte';
	import type { ChangeType, NotificationView } from '$lib/types';
	import Icon from './Icon.svelte';
	import StatusBlock from './StatusBlock.svelte';

	let { collapsible = true }: { collapsible?: boolean } = $props();

	const app = getAppState();
	let collapsed = $state(false);
	let editingId = $state<string | null>(null);
	let noteValue = $state('');
	let noteTitle = $state('');
	let noteHadText = $state(false);
	let noteReturnFocus = $state<HTMLButtonElement | null>(null);

	const items = $derived(app.notifications.status === 'idle' ? undefined : app.notifications.data);
	const readCount = $derived((items ?? []).filter((item) => item.read && !item.pinned).length);

	function openNote(notification: NotificationView, trigger: HTMLButtonElement) {
		editingId = notification.id;
		noteValue = notification.note;
		noteTitle = notification.fileName;
		noteHadText = notification.note.length > 0;
		noteReturnFocus = trigger;
	}

	async function closeNote() {
		const trigger = noteReturnFocus;
		editingId = null;
		noteReturnFocus = null;
		await tick();
		trigger?.focus();
	}

	function submitNote(event: SubmitEvent) {
		event.preventDefault();
		if (!editingId) return;
		void app.saveNotificationNote(editingId, noteValue);
		void closeNote();
	}

	function onNoteKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || !editingId) return;
		event.preventDefault();
		void closeNote();
	}

	function focusNote(node: HTMLTextAreaElement) {
		node.focus();
		const length = node.value.length;
		node.setSelectionRange(length, length);
	}

	function openExternal(event: MouseEvent, url: string) {
		if (!('__TAURI_INTERNALS__' in window)) return;
		event.preventDefault();
		void import('@tauri-apps/plugin-opener').then(({ openUrl }) => openUrl(url));
	}

	const tone: Record<ChangeType, string> = {
		created: 'success',
		modified: 'accent',
		deleted: 'danger',
		moved: 'warning',
		renamed: 'warning',
		shared: 'accent'
	};
</script>

<svelte:window onkeydown={onNoteKeydown} />

<section class={['card', 'fill', { steady: !collapsible }]} aria-labelledby="notifications-heading">
	<div class="card-header">
		<h2 id="notifications-heading">Recent changes</h2>
		<div class="actions">
			{#if collapsible}
				<button
					type="button"
					class="btn btn-sm btn-ghost"
					aria-expanded={!collapsed}
					aria-controls="notifications-body"
					aria-label={collapsed ? 'Expand recent changes' : 'Collapse recent changes'}
					onclick={() => (collapsed = !collapsed)}
				>
					<span class={['collapse-chevron', { collapsed }]}><Icon name="chevron" size={16} /></span>
				</button>
			{/if}
			{#if app.unreadCount > 0}
				<span class="badge" data-tone="accent">{app.unreadCount} unread</span>
				<button type="button" class="btn btn-sm btn-ghost" onclick={() => app.markAllRead()}>
					<Icon name="check" size={14} />
					Mark all read
				</button>
			{/if}
			{#if readCount > 0}
				<button type="button" class="btn btn-sm btn-ghost" onclick={() => app.clearRead()}>
					Clear
				</button>
			{/if}
		</div>
	</div>
	<div class="card-body" id="notifications-body" hidden={collapsible && collapsed}>
		{#if app.notifications.status === 'error'}
			<StatusBlock
				kind="error"
				title="Couldn't load notifications"
				message={app.notifications.error}
				onretry={() => app.loadNotifications()}
			/>
		{:else if !items}
			<StatusBlock kind="loading" title="Loading recent changes" />
		{:else if items.length === 0}
			<StatusBlock
				kind="empty"
				icon="inbox"
				title="No recent changes"
				message="New files and edits in watched folders will show up here."
			/>
		{:else}
			<ul class="list">
				{#each items as notification (notification.id)}
					<li class={{ unread: !notification.read }}>
						<article aria-labelledby="note-{notification.id}">
							<div class="top">
								<span class="badge" data-tone={tone[notification.changeType]}>
									{CHANGE_LABELS[notification.changeType]}
								</span>
								<div class="row-end">
									<time
										datetime={notification.occurredAt}
										title={formatDateTime(notification.occurredAt)}
									>
										{formatRelative(notification.occurredAt, app.now)}
									</time>
									<button
										type="button"
										class={['icon-btn', { active: notification.pinned }]}
										aria-pressed={notification.pinned}
										title={notification.pinned ? 'Unpin' : 'Pin'}
										aria-label={notification.pinned
											? `Unpin ${notification.fileName}`
											: `Pin ${notification.fileName}`}
										onclick={() => app.setNotificationPinned(notification.id, !notification.pinned)}
									>
										<Icon name="pin" size={15} />
									</button>
									<button
										type="button"
										class="icon-btn"
										title={notification.note ? 'Edit note' : 'Add note'}
										aria-label={notification.note
											? `Edit note for ${notification.fileName}`
											: `Add note for ${notification.fileName}`}
										onclick={(event) => {
											const trigger = event.currentTarget;
											if (trigger instanceof HTMLButtonElement) openNote(notification, trigger);
										}}
									>
										<Icon name={notification.note ? 'edit-note' : 'note'} size={15} />
									</button>
								</div>
							</div>
							<h3 id="note-{notification.id}">
								<Icon name="file" size={15} />
								{notification.fileName}
							</h3>
							<p class="muted detail">
								{notification.folderName}
								<span aria-hidden="true"> · </span>
								{notification.driveName}
							</p>
							{#if notification.note}
								<p class="user-note">{notification.note}</p>
							{/if}
							<dl class="meta">
								{#if notification.actorName}
									<dt>Changed by</dt>
									<dd>{notification.actorName}</dd>
								{/if}
								{#if notification.ownerName}
									<dt>Owner</dt>
									<dd>{notification.ownerName}</dd>
								{/if}
								<dt>When</dt>
								<dd>{formatDateTime(notification.occurredAt)}</dd>
							</dl>
							<div class="note-actions">
								{#if !notification.read}
									<button
										type="button"
										class="btn btn-sm btn-ghost"
										onclick={() => app.markRead(notification.id)}
									>
										Mark read
									</button>
								{/if}
								{#if notification.webViewLink}
									<a
										class="btn btn-sm btn-ghost"
										href={notification.webViewLink}
										target="_blank"
										rel="noopener noreferrer external"
										onclick={(event) => openExternal(event, notification.webViewLink!)}
									>
										Open file
									</a>
								{/if}
							</div>
						</article>
					</li>
				{/each}
			</ul>
			{#if app.notifications.status === 'loading'}
				<StatusBlock compact kind="loading" title="Refreshing notifications" />
			{/if}
		{/if}
	</div>
</section>

{#if editingId}
	<div class="backdrop">
		<button type="button" class="scrim" aria-label="Cancel" onclick={() => void closeNote()}></button>
		<div
			class="dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="notification-note-title"
			aria-describedby="notification-note-file"
		>
			<form onsubmit={submitNote}>
				<h2 id="notification-note-title">{noteHadText ? 'Edit note' : 'Add note'}</h2>
				<p id="notification-note-file" class="muted file-name">{noteTitle}</p>
				<label class="note-label" for="notification-note-text">Note</label>
				<textarea
					id="notification-note-text"
					{@attach focusNote}
					bind:value={noteValue}
					rows="4"
				></textarea>
				<div class="dialog-actions">
					<button type="button" class="btn btn-ghost" onclick={() => void closeNote()}>Cancel</button>
					<button type="submit" class="btn btn-primary">Save</button>
				</div>
			</form>
		</div>
	</div>
{/if}

<style>
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: 0.35rem;
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

	.list {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.45rem;
		min-height: 8rem;
		margin: 0;
		padding: 0;
		overflow: auto;
		list-style: none;
	}

	@media (max-width: 900px) {
		.fill:not(.steady) {
			flex: none;
			min-height: 18rem;
		}
	}

	article {
		padding: 0.65rem 0.7rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
	}

	.unread article {
		background: var(--accent-soft);
		border-color: transparent;
	}

	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.row-end {
		display: flex;
		align-items: center;
		gap: 0.15rem;
		min-width: 0;
	}

	.row-end .icon-btn {
		width: 1.75rem;
		height: 1.75rem;
	}

	.icon-btn.active {
		color: var(--accent);
		background: var(--accent-soft);
	}

	.user-note {
		margin-top: 0.4rem;
		padding: 0.35rem 0.5rem;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		font-size: 0.8rem;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	time {
		font-size: 0.75rem;
		color: var(--text-muted);
		white-space: nowrap;
	}

	h3 {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		margin-top: 0.35rem;
		font-size: 0.92rem;
		font-weight: 650;
	}

	.detail {
		margin-top: 0.15rem;
		font-size: 0.8rem;
	}

	.meta {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.1rem 0.6rem;
		margin: 0.35rem 0 0;
		font-size: 0.78rem;
	}

	.meta dt {
		color: var(--text-muted);
	}

	.meta dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.note-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		margin-top: 0.35rem;
	}

	.note-actions:empty {
		display: none;
	}

	a.btn {
		text-decoration: none;
	}

	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 30;
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
		width: min(26rem, calc(100vw - 2rem));
		padding: 1.25rem;
		border-radius: var(--radius);
		background: var(--surface);
		box-shadow: 0 12px 40px rgb(0 0 0 / 35%);
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.dialog h2 {
		font-size: 1.05rem;
		font-weight: 650;
	}

	.file-name {
		font-size: 0.85rem;
		overflow-wrap: anywhere;
	}

	.note-label {
		font-size: 0.82rem;
		font-weight: 600;
	}

	textarea {
		width: 100%;
		min-height: 6.5rem;
		padding: 0.6rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--text);
		font: inherit;
		resize: vertical;
	}

	.dialog-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
