<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { formatBytes } from './format';
	import { getBrowserState, type Transfer } from './browser-state.svelte';

	const browser = getBrowserState();
	let collapsed = $state(false);

	const uploads = $derived(browser.transfers.filter((t) => t.kind === 'upload').length);
	const failed = $derived(browser.transfers.filter((t) => t.status === 'error').length);
	const heading = $derived.by(() => {
		const active = browser.activeTransfers;
		const verb = uploads === browser.transfers.length ? 'Uploading' : uploads === 0 ? 'Downloading' : 'Transferring';
		if (active > 0) return `${verb} ${active} ${active === 1 ? 'item' : 'items'}`;
		const done = browser.transfers.filter((t) => t.status === 'done').length;
		return `${done} ${done === 1 ? 'item' : 'items'} complete${failed ? `, ${failed} failed` : ''}`;
	});

	function percent(transfer: Transfer) {
		if (transfer.status === 'done') return 100;
		return transfer.total ? Math.min(100, Math.round((transfer.loaded / transfer.total) * 100)) : 0;
	}
</script>

{#if browser.transfers.length > 0}
	<section class="panel" aria-label="Transfers">
		<header>
			<h2>{heading}</h2>
			<button
				type="button"
				class="icon-btn"
				aria-label={collapsed ? 'Expand' : 'Collapse'}
				onclick={() => (collapsed = !collapsed)}
			>
				<span class="chevron" class:collapsed><Icon name="chevron" size={16} /></span>
			</button>
			{#if browser.activeTransfers === 0}
				<button
					type="button"
					class="icon-btn"
					aria-label="Close"
					onclick={() => browser.clearFinishedTransfers()}
				>
					<Icon name="close" size={16} />
				</button>
			{/if}
		</header>
		{#if !collapsed}
			<ul>
				{#each browser.transfers as transfer (transfer.id)}
					<li>
						<Icon name={transfer.kind === 'upload' ? 'upload' : 'download'} size={16} />
						<div class="info">
							<span class="name" title={transfer.name}>{transfer.name}</span>
							{#if transfer.status === 'error'}
								<span class="error" title={transfer.error ?? ''}>{transfer.error}</span>
							{:else if transfer.status === 'active' || transfer.status === 'queued'}
								<div class="bar" aria-hidden="true">
									<span style:width="{percent(transfer)}%"></span>
								</div>
								<span class="muted size">
									{transfer.status === 'queued'
										? 'Waiting…'
										: `${formatBytes(transfer.loaded)}${transfer.total ? ` of ${formatBytes(transfer.total)}` : ''}`}
								</span>
							{:else if transfer.status === 'cancelled'}
								<span class="muted size">Cancelled</span>
							{/if}
						</div>
						{#if transfer.status === 'active' || transfer.status === 'queued'}
							<button
								type="button"
								class="icon-btn"
								aria-label="Cancel {transfer.name}"
								onclick={() => browser.cancelTransfer(transfer)}
							>
								<Icon name="close" size={15} />
							</button>
						{:else if transfer.status === 'done'}
							{#if transfer.localPath}
								<button
									type="button"
									class="btn btn-sm btn-ghost"
									onclick={() => browser.revealTransfer(transfer)}
								>
									Show
								</button>
							{/if}
							<span class="done"><Icon name="check" size={16} label="Done" /></span>
						{:else if transfer.status === 'error'}
							<span class="failed"><Icon name="warning" size={16} label="Failed" /></span>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/if}

<style>
	.panel {
		position: fixed;
		right: 1.25rem;
		bottom: 1.25rem;
		z-index: 25;
		width: min(22rem, calc(100vw - 2.5rem));
		overflow: hidden;
		border-radius: var(--radius);
		background: var(--surface);
		box-shadow: 0 8px 28px rgb(0 0 0 / 35%);
	}

	header {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.7rem 0.6rem 0.7rem 1rem;
		background: var(--surface-2);
	}

	h2 {
		flex: 1;
		font-size: 0.92rem;
		font-weight: 600;
	}

	.chevron {
		display: grid;
		transform: rotate(90deg);
		transition: transform 0.15s ease;
	}

	.chevron.collapsed {
		transform: rotate(-90deg);
	}

	ul {
		max-height: 18rem;
		margin: 0;
		padding: 0.35rem 0;
		overflow: auto;
		list-style: none;
	}

	li {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		padding: 0.45rem 0.6rem 0.45rem 1rem;
		color: var(--text-muted);
	}

	.info {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
	}

	.name {
		overflow: hidden;
		color: var(--text);
		font-size: 0.85rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.bar {
		height: 3px;
		overflow: hidden;
		border-radius: 2px;
		background: var(--border);
	}

	.bar span {
		display: block;
		height: 100%;
		background: var(--accent);
		transition: width 0.2s linear;
	}

	.size,
	.error {
		font-size: 0.74rem;
	}

	.error {
		overflow: hidden;
		color: var(--danger);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.done {
		color: var(--success);
	}

	.failed {
		color: var(--danger);
	}
</style>
