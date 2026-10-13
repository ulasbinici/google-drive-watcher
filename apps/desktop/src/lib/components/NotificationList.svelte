<script lang="ts">
	import { CHANGE_LABELS, formatDateTime, formatRelative } from '$lib/format';
	import { getAppState } from '$lib/state/app-state.svelte';
	import type { ChangeType } from '$lib/types';
	import Icon from './Icon.svelte';
	import StatusBlock from './StatusBlock.svelte';

	const app = getAppState();
	const items = $derived(app.notifications.status === 'idle' ? undefined : app.notifications.data);
	const readCount = $derived((items ?? []).filter((item) => item.read).length);

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

<section class="card fill" aria-labelledby="notifications-heading">
	<div class="card-header">
		<h2 id="notifications-heading">Recent changes</h2>
		<div class="actions">
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
	<div class="card-body">
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
					<li class:unread={!notification.read}>
						<article aria-labelledby="note-{notification.id}">
							<div class="top">
								<span class="badge" data-tone={tone[notification.changeType]}>
									{CHANGE_LABELS[notification.changeType]}
								</span>
								<time
									datetime={notification.occurredAt}
									title={formatDateTime(notification.occurredAt)}
								>
									{formatRelative(notification.occurredAt, app.now)}
								</time>
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
		.fill {
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
</style>
