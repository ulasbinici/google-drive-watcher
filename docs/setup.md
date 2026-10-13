# Drive Watch setup

The desktop app runs on Tauri 2 and Svelte 5. Google account linking, Drive folder watching, and the webhook channel are handled by Firebase Functions. Subfolders of a selected folder are watched too. The scope is My Drive and Shared Drives.

Türkçe: [setup-tr.md](setup-tr.md).

## Google Cloud

1. Create a Google Cloud project and enable the Google Drive API.
2. Create an OAuth consent screen. If the app is external, add test users until it is verified.
3. Create a Desktop or Web client. The authorized redirect URI is:

   `https://us-central1-PROJECT_ID.cloudfunctions.net/oauthCallback`

4. Sign-in requests OpenID profile scopes plus a Drive scope. Read-only access uses `https://www.googleapis.com/auth/drive.readonly`. Allowing file upload and edit uses `https://www.googleapis.com/auth/drive`. These scopes are sensitive, so a public release can require Google verification. Until then, only test users can connect.

## Firebase

1. Add Firebase to the same Google Cloud project.
2. Do not enable the Google provider in Authentication. The app issues its own custom token. Authentication only needs to be turned on.
3. Create Firestore in Native mode.
4. After `firebase login`, copy `.firebaserc.example` to `.firebaserc` and set the project id.
5. Set the secrets:

```bash
firebase functions:secrets:set GOOGLE_CLIENT_ID
firebase functions:secrets:set GOOGLE_CLIENT_SECRET
firebase functions:secrets:set TOKEN_ENCRYPTION_KEY
```

`TOKEN_ENCRYPTION_KEY` is the base64 form of a random 32-byte key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

6. In `functions/.env`, set `PUBLIC_BASE_URL` to the function base URL. See `functions/.env.example`. `DESKTOP_REDIRECT_SCHEME` defaults to `drivewatch://oauth/callback`.
7. Deploy rules, indexes, and functions:

```bash
pnpm --filter @drive-watch/functions build
firebase deploy --only functions,firestore
```

`renewDriveChannels` runs every six hours and renews Drive channels that have less than 36 hours left. Drive `changes` channels live for at most one week. `cleanupEphemeralAuth` deletes expired OAuth records.

## Desktop

Install dependencies from the repo root:

```bash
pnpm install
```

Create `apps/desktop/.env` from `.env.example`. `PUBLIC_FUNCTIONS_BASE_URL` must be the Firebase function base URL, with no trailing slash. If these values are empty, the app opens with local demo data.

Development:

```bash
pnpm dev:desktop
```

Production packages:

```bash
pnpm --filter @drive-watch/desktop tauri build
```

- Windows packages are NSIS or MSI. The `drivewatch://` scheme is registered by the installer.
- macOS packages are `.app` and `.dmg`. The first launch asks for notification permission.
- Linux packages are AppImage, deb, or rpm on a system that has webkit2gtk and `xdg-desktop-menu`. Deep link registration needs `update-desktop-database`.

Closing the window leaves the app running in the tray. Left-click opens the tray menu; the first line is the sync status. **Open Drive Watch** opens the window. The menu can pause monitoring, resume it, or quit the app.

## Local checks

```bash
pnpm --filter @drive-watch/functions test
pnpm --filter @drive-watch/functions check
pnpm --filter @drive-watch/desktop check
pnpm --filter @drive-watch/desktop build
```

The Firestore and Functions emulator needs Java:

```bash
pnpm emulators
```

Rules and the webhook flow, aside from OAuth, can be tried in the emulator. The Drive client calls the Google API in production. Automated tests cover the folder tree, change kinds, the page cursor, repeated webhooks, and channel renewal.

## Acceptance flow

1. Sign in with Google from the app and approve the consent screen.
2. Pick a My Drive or Shared Drive folder and save it.
3. In a subfolder, create, edit, move, and delete a file.
4. Within a few seconds a Firestore notification and a tray notification should arrive.
5. Close the window, leave the app in the tray, open it again, and confirm the account is still signed in.
6. Pause monitoring. No notification should arrive while it is paused. Resume, and pending changes should be processed.
