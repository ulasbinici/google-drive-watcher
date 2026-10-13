<script lang="ts">
	import Icon, { type IconName } from './Icon.svelte';
	import Spinner from './Spinner.svelte';

	interface Props {
		kind: 'loading' | 'error' | 'empty';
		title: string;
		message?: string;
		icon?: IconName;
		compact?: boolean;
		retryLabel?: string;
		onretry?: () => void;
	}

	let { kind, title, message, icon, compact = false, retryLabel = 'Try again', onretry }: Props =
		$props();

	const resolvedIcon = $derived<IconName>(icon ?? (kind === 'error' ? 'warning' : 'inbox'));
</script>

<div
	class="status"
	class:compact
	data-kind={kind}
	role={kind === 'error' ? 'alert' : kind === 'loading' ? 'status' : undefined}
	aria-live={kind === 'loading' ? 'polite' : undefined}
>
	<span class="glyph">
		{#if kind === 'loading'}
			<Spinner size={compact ? 14 : 22} />
		{:else}
			<Icon name={resolvedIcon} size={compact ? 16 : 24} />
		{/if}
	</span>
	<div class="text">
		<p class="title">{title}</p>
		{#if message}
			<p class="message">{message}</p>
		{/if}
	</div>
	{#if onretry}
		<button type="button" class="btn btn-sm" onclick={onretry}>{retryLabel}</button>
	{/if}
</div>

<style>
	.status {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.6rem;
		padding: 1.75rem 1rem;
		text-align: center;
		color: var(--text-muted);
	}

	.status.compact {
		flex-direction: row;
		flex-wrap: wrap;
		gap: 0.5rem;
		padding: 0.4rem 0.5rem;
		text-align: left;
		font-size: 0.85rem;
	}

	.status[data-kind='error'] {
		color: var(--danger);
	}

	.glyph {
		display: grid;
		place-items: center;
	}

	.status:not(.compact) .glyph {
		width: 3rem;
		height: 3rem;
		border-radius: 50%;
		background: var(--surface-2);
	}

	.status[data-kind='error']:not(.compact) .glyph {
		background: var(--danger-soft);
	}

	.text {
		min-width: 0;
	}

	.compact .text {
		flex: 1;
	}

	.title {
		font-weight: 600;
		color: var(--text);
	}

	.compact .title {
		font-weight: 500;
		color: inherit;
	}

	.message {
		font-size: 0.875rem;
	}
</style>
