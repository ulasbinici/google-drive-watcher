<script lang="ts">
	interface Props {
		title: string;
		initial?: string;
		confirmLabel: string;
		onsubmit: (name: string) => void;
		oncancel: () => void;
	}

	let { title, initial = '', confirmLabel, onsubmit, oncancel }: Props = $props();
	let name = $state((() => initial)());

	function focusAndSelect(input: HTMLInputElement) {
		input.focus();
		const dot = input.value.lastIndexOf('.');
		input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
	}

	function submit(event: SubmitEvent) {
		event.preventDefault();
		const trimmed = name.trim();
		if (trimmed) onsubmit(trimmed);
	}
</script>

<div class="backdrop">
	<button type="button" class="scrim" aria-label="Cancel" onclick={oncancel}></button>
	<div class="dialog" role="dialog" aria-modal="true" aria-label={title}>
		<form onsubmit={submit}>
			<h2>{title}</h2>
			<input
				{@attach focusAndSelect}
				bind:value={name}
				aria-label="Name"
				onkeydown={(event) => event.key === 'Escape' && oncancel()}
			/>
			<div class="actions">
				<button type="button" class="btn btn-ghost" onclick={oncancel}>Cancel</button>
				<button type="submit" class="btn btn-primary" disabled={!name.trim()}>{confirmLabel}</button>
			</div>
		</form>
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
		width: min(24rem, calc(100vw - 2rem));
		padding: 1.25rem;
		border-radius: var(--radius);
		background: var(--surface);
		box-shadow: 0 12px 40px rgb(0 0 0 / 35%);
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	h2 {
		font-size: 1.1rem;
		font-weight: 500;
	}

	input {
		padding: 0.6rem 0.75rem;
		border: 1px solid var(--accent);
		border-radius: var(--radius-sm);
		background: var(--surface);
		outline: none;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
