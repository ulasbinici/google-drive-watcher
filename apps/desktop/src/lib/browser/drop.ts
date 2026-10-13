export interface PickedFile {
	file: File;
	/** Path relative to the drop target, `/`-separated, including the file name. */
	path: string;
}

export const DRIVE_ITEMS_MIME = 'application/x-drive-watch-items';

export function hasExternalFiles(event: DragEvent): boolean {
	return Boolean(event.dataTransfer?.types.includes('Files'));
}

export function hasDriveItems(event: DragEvent): boolean {
	return Boolean(event.dataTransfer?.types.includes(DRIVE_ITEMS_MIME));
}

function readFile(entry: FileSystemFileEntry): Promise<File> {
	return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
	return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function walk(entry: FileSystemEntry, prefix: string, out: PickedFile[]): Promise<void> {
	const path = prefix ? `${prefix}/${entry.name}` : entry.name;
	if (entry.isFile) {
		out.push({ file: await readFile(entry as FileSystemFileEntry), path });
		return;
	}
	if (!entry.isDirectory) return;
	const reader = (entry as FileSystemDirectoryEntry).createReader();
	for (;;) {
		const batch = await readBatch(reader);
		if (batch.length === 0) break;
		for (const child of batch) await walk(child, path, out);
	}
}

/** Collects dropped files and folders, keeping folder structure in `path`. */
export async function filesFromDrop(transfer: DataTransfer): Promise<PickedFile[]> {
	const entries = [...transfer.items]
		.filter((item) => item.kind === 'file')
		.map((item) => item.webkitGetAsEntry())
		.filter((entry): entry is FileSystemEntry => entry !== null);
	if (entries.length === 0) {
		return [...transfer.files].map((file) => ({ file, path: file.name }));
	}
	const out: PickedFile[] = [];
	for (const entry of entries) await walk(entry, '', out);
	return out;
}

export function filesFromInput(input: HTMLInputElement): PickedFile[] {
	return [...(input.files ?? [])].map((file) => ({
		file,
		path: file.webkitRelativePath || file.name
	}));
}
