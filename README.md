# Drive Watch

A desktop app that watches Google Drive folders. You get a notification when a file is added, changed, or removed in a selected folder or any of its subfolders. A folder can also be kept in sync with a directory on your computer.

Built with Tauri 2, Svelte 5, and Firebase Functions. Works with My Drive and Shared Drives.

## Features

- Folder watching with tray notifications
- Drive browser: open folders, upload, download
- Folder sync (download only, or upload too when file editing is allowed)
- The file being synced is shown in the tray tooltip and tray menu
- A "sync finished" notification lists the copied files. Folders that are already up to date stay quiet
- Google Docs, Sheets, and Slides are skipped. Deleting a file on one side does not delete it on the other

Closing the window keeps the app running in the tray. Left-clicking the tray icon opens the menu; the first line shows the sync status. **Open Drive Watch** opens the window.

## Repository

| Path | Contents |
| --- | --- |
| `apps/desktop` | Tauri + SvelteKit desktop app |
| `functions` | OAuth, Drive watching, and change processing |
| `packages/shared` | Shared types |
| [`docs/setup.md`](docs/setup.md) | Google Cloud and Firebase setup |

## Setup

Google Cloud, Firebase, secrets, and the first deploy are in [docs/setup.md](docs/setup.md). Türkçe kurulum: [docs/setup-tr.md](docs/setup-tr.md).

## Development

Requirements: Node.js, pnpm 10.30.3, Rust 1.85 or later.

```bash
pnpm install
pnpm dev:desktop
```

Create `apps/desktop/.env` from `apps/desktop/.env.example`. If these values are empty, the app opens with local demo data. Google sign-in, Drive watching, and webhooks follow [docs/setup.md](docs/setup.md). OAuth client credentials and the token encryption key are not stored in the repo; they live in Firebase Secret Manager.

Local UI: `http://localhost:1420`. Drive browser: `http://localhost:1420/browse`.

Checks:

```bash
pnpm --filter @drive-watch/functions test
pnpm --filter @drive-watch/desktop check
```

## Packaging

Windows (NSIS and MSI):

```bash
pnpm build:windows:setup
```

Installers are copied to `apps/desktop/installers`, which is not tracked by git.

macOS (run on a Mac):

```bash
pnpm --filter @drive-watch/desktop tauri build --bundles app,dmg
```

Output goes to `apps/desktop/src-tauri/target/release/bundle`. `build:windows:setup` is Windows only.

Installers are unsigned. On Windows, Smart App Control may block a new `.exe` setup; the MSI usually installs. On macOS, Gatekeeper may warn on first launch.
