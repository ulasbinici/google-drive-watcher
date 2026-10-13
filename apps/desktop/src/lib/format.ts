import type { ChangeType } from '$lib/types';

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	['day', 86_400_000],
	['hour', 3_600_000],
	['minute', 60_000]
];

export function formatRelative(iso: string | null, now: number): string {
	if (!iso) return 'never';
	const diff = new Date(iso).getTime() - now;
	if (Math.abs(diff) < 45_000) return diff > 0 ? 'in a moment' : 'just now';
	for (const [unit, ms] of UNITS) {
		if (Math.abs(diff) >= ms || unit === 'minute') {
			return relative.format(Math.round(diff / ms), unit);
		}
	}
	return relative.format(0, 'minute');
}

export function formatDateTime(iso: string): string {
	return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export const CHANGE_LABELS: Record<ChangeType, string> = {
	created: 'Added',
	modified: 'Edited',
	deleted: 'Removed',
	moved: 'Moved',
	renamed: 'Renamed',
	shared: 'Shared'
};

export function initials(name: string): string {
	return name
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part[0]!.toUpperCase())
		.join('');
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return typeof error === 'string' ? error : 'Something went wrong.';
}
