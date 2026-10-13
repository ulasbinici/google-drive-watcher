<script lang="ts" module>
	export type IconName =
		| 'arrow-down'
		| 'arrow-left'
		| 'arrow-right'
		| 'arrow-up'
		| 'bell'
		| 'check'
		| 'chevron'
		| 'clock'
		| 'close'
		| 'download'
		| 'drive'
		| 'edit'
		| 'edit-note'
		| 'external'
		| 'file'
		| 'folder'
		| 'folder-plus'
		| 'google'
		| 'grid'
		| 'inbox'
		| 'list'
		| 'logout'
		| 'more'
		| 'note'
		| 'pause'
		| 'pin'
		| 'play'
		| 'plus'
		| 'refresh'
		| 'restore'
		| 'search'
		| 'shared'
		| 'star'
		| 'sync'
		| 'trash'
		| 'upload'
		| 'warning';
</script>

<script lang="ts">
	interface Props {
		name: IconName;
		size?: number;
		/** When set, the icon is announced; otherwise it is decorative. */
		label?: string;
	}

	let { name, size = 18, label }: Props = $props();
</script>

<svg
	class="icon"
	width={size}
	height={size}
	viewBox={name === 'google' ? '0 0 48 48' : '0 0 24 24'}
	fill="none"
	stroke="currentColor"
	stroke-width="2"
	stroke-linecap="round"
	stroke-linejoin="round"
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
	focusable="false"
>
	{#if name === 'bell'}
		<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
		<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
	{:else if name === 'check'}
		<path d="M20 6 9 17l-5-5" />
	{:else if name === 'chevron'}
		<path d="m9 6 6 6-6 6" />
	{:else if name === 'close'}
		<path d="M18 6 6 18M6 6l12 12" />
	{:else if name === 'drive'}
		<path d="M6.5 5h11L21 15v4H3v-4z" />
		<path d="M3 15h18M7 18h.01" />
	{:else if name === 'file'}
		<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
		<path d="M14 3v6h6" />
	{:else if name === 'folder'}
		<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
	{:else if name === 'google'}
		<g stroke="none">
			<path
				fill="#FFC107"
				d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.5z"
			/>
			<path
				fill="#FF3D00"
				d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
			/>
			<path
				fill="#4CAF50"
				d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"
			/>
			<path
				fill="#1976D2"
				d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.5z"
			/>
		</g>
	{:else if name === 'inbox'}
		<path d="M22 12h-6l-2 3h-4l-2-3H2" />
		<path
			d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"
		/>
	{:else if name === 'logout'}
		<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
		<path d="m16 17 5-5-5-5M21 12H9" />
	{:else if name === 'pause'}
		<rect x="6" y="5" width="4" height="14" rx="1" />
		<rect x="14" y="5" width="4" height="14" rx="1" />
	{:else if name === 'play'}
		<path d="M7 5v14l11-7z" />
	{:else if name === 'refresh'}
		<path d="M21 12a9 9 0 1 1-2.64-6.36" />
		<path d="M21 3v6h-6" />
	{:else if name === 'search'}
		<circle cx="11" cy="11" r="7" />
		<path d="m20 20-3.5-3.5" />
	{:else if name === 'shared'}
		<circle cx="9" cy="8" r="3.5" />
		<path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
		<path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6" />
	{:else if name === 'warning'}
		<circle cx="12" cy="12" r="9" />
		<path d="M12 8v4M12 16h.01" />
	{:else if name === 'arrow-down'}
		<path d="M12 5v14M5 12l7 7 7-7" />
	{:else if name === 'arrow-up'}
		<path d="M12 19V5M5 12l7-7 7 7" />
	{:else if name === 'arrow-left'}
		<path d="M19 12H5M12 19l-7-7 7-7" />
	{:else if name === 'arrow-right'}
		<path d="M5 12h14M12 5l7 7-7 7" />
	{:else if name === 'clock'}
		<circle cx="12" cy="12" r="9" />
		<path d="M12 7v5l3 3" />
	{:else if name === 'download'}
		<path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
	{:else if name === 'upload'}
		<path d="M12 20V9M7 14l5-5 5 5M5 4h14" />
	{:else if name === 'edit'}
		<path d="M12 20h9" />
		<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
	{:else if name === 'external'}
		<path d="M14 4h6v6M20 4l-9 9" />
		<path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
	{:else if name === 'folder-plus'}
		<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
		<path d="M12 10v6M9 13h6" />
	{:else if name === 'grid'}
		<rect x="4" y="4" width="7" height="7" rx="1.5" />
		<rect x="13" y="4" width="7" height="7" rx="1.5" />
		<rect x="4" y="13" width="7" height="7" rx="1.5" />
		<rect x="13" y="13" width="7" height="7" rx="1.5" />
	{:else if name === 'list'}
		<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
	{:else if name === 'more'}
		<circle cx="12" cy="5" r="1" />
		<circle cx="12" cy="12" r="1" />
		<circle cx="12" cy="19" r="1" />
	{:else if name === 'plus'}
		<path d="M12 5v14M5 12h14" />
	{:else if name === 'restore'}
		<path d="M3 12a9 9 0 1 0 2.64-6.36" />
		<path d="M3 3v6h6" />
	{:else if name === 'star'}
		<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9z" />
	{:else if name === 'sync'}
		<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
		<path d="M4 3v5h5" />
		<path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" />
		<path d="M20 21v-5h-5" />
	{:else if name === 'trash'}
		<path d="M4 7h16M10 11v6M14 11v6" />
		<path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
	{:else if name === 'pin'}
		<path d="M12 17v5" />
		<path
			d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"
		/>
	{:else if name === 'note'}
		<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
		<path d="M14 3v6h6" />
		<path d="M8 13h8M8 17h5" />
	{:else if name === 'edit-note'}
		<path d="M12 20h9" />
		<path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
	{/if}
</svg>

<style>
	.icon {
		flex-shrink: 0;
		display: block;
	}
</style>
