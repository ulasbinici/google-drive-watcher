export async function notifyNative(title: string, body: string): Promise<void> {
	if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
	const { isPermissionGranted, requestPermission, sendNotification } = await import(
		"@tauri-apps/plugin-notification"
	);
	let granted = await isPermissionGranted();
	if (!granted) granted = (await requestPermission()) === "granted";
	if (granted) sendNotification({ title, body });
}
