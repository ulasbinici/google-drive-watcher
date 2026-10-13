<script lang="ts">
	import { BrowserState, setBrowserState } from './browser-state.svelte';
	import Explorer from './Explorer.svelte';

	const browser = new BrowserState();
	setBrowserState(browser);

	// start() writes state, so it runs during init rather than inside an effect.
	const stop = browser.start();
	$effect(() => stop);
</script>

<svelte:head>
	<title>{browser.title} – Drive Watch</title>
</svelte:head>

<Explorer />
