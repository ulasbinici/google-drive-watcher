<script lang="ts">
	interface Props {
		size?: number;
		/** When set, the spinner is announced as a status; otherwise it is decorative. */
		label?: string;
	}

	let { size = 16, label }: Props = $props();
</script>

{#if label}
	<span class="spinner" style:--size="{size}px" role="status" aria-label={label}></span>
{:else}
	<span class="spinner" style:--size="{size}px" aria-hidden="true"></span>
{/if}

<style>
	.spinner {
		display: inline-block;
		flex-shrink: 0;
		width: var(--size);
		height: var(--size);
		border: 2px solid currentColor;
		border-right-color: transparent;
		border-radius: 50%;
		opacity: 0.75;
		animation: spin 0.7s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
