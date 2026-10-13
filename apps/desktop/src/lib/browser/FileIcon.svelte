<script lang="ts">
	import { iconUrl, type DriveItem } from '$lib/drive/drive-api';
	import Icon from '$lib/components/Icon.svelte';

	interface Props {
		item: DriveItem;
		size?: number;
	}

	let { item, size = 20 }: Props = $props();
	let failed = $state(false);
	const src = $derived(failed ? null : iconUrl(item, size > 24 ? 64 : 32));
</script>

{#if src}
	<img
		class="file-icon"
		{src}
		alt=""
		width={size}
		height={size}
		referrerpolicy="no-referrer"
		onerror={() => (failed = true)}
	/>
{:else}
	<span class="fallback" class:folder={item.isFolder} style:width="{size}px" style:height="{size}px">
		<Icon name={item.isFolder ? 'folder' : 'file'} size={size} />
	</span>
{/if}

<style>
	.file-icon {
		flex-shrink: 0;
		object-fit: contain;
	}

	.fallback {
		display: inline-grid;
		flex-shrink: 0;
		place-items: center;
		color: var(--text-muted);
	}

	.fallback.folder {
		color: #5f6368;
	}
</style>
