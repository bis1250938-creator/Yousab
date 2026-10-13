# YJ Studios offline mode

## Existing architecture

The site is a static vanilla HTML/CSS/JavaScript application deployed to Vercel. It has no frontend build system or router. Firebase Authentication supplies owner identities and Cloud Firestore stores bookings and project metadata. Audio, video, images, upload visibility, and file cleanup use the authenticated Cloudflare R2 Worker. The PWA manifest and root-scoped service worker are already part of the site.

This implementation keeps those services and uses Firestore's own browser cache and durable write queue. It does not add a second project database or send Firestore data through the service worker.

## Offline data model and synchronization

- `firebase-client.js` uses the Firebase JS SDK already installed by the site through its versioned CDN imports. Firestore uses its in-memory cache by default. A user must explicitly enable persistent storage in **Studio Work → Offline data settings** on each trusted personal device. The choice is stored per browser and reloads the page before Firestore initializes with IndexedDB persistence and a multi-tab manager.
- Firestore stores synchronized documents and its pending write queue in IndexedDB. Firestore automatically retries pending writes when it can reach the backend. A project document keeps its existing ID; a new project gets a UUID before its document is written. This makes a queued creation stable across a refresh instead of making a second record on retry.
- When persistent mode is enabled, the app also saves an IndexedDB recovery copy before submitting project changes to Firestore. For uploaded media it stores metadata, stable R2 paths, and file-session descriptors, never media bytes or booking contact details. Firestore remains the primary offline queue. If a write is rejected or the page closes before its acknowledgement is observed, **Retry sync** checks the stable project ID and server revision first. It reapplies only if the expected revision is still current, treats an already-applied identical create as complete without duplicating it, and keeps stale/conflicting data for review. If a completed upload has no confirmed project record, its cleanup action first checks Firestore from the server and removes only unreferenced media. Ambiguous results preserve the files and the recovery record.
- Project metadata edits include a monotonic `revision`. Firestore rules accept an update only when it advances the server revision by one. A stale offline edit is rejected rather than overwriting a newer edit. Offline deletion of an external-URL-only project uses a revision-checked tombstone (`deleted: true`, `published: false`); after Firestore acknowledges it, the owner listener removes the Firestore document. A media project that has R2 files cannot be safely deleted or unpublished offline.
- The public listener uses Firestore snapshot metadata. A cache miss is shown as “No previously synchronized public projects are available offline,” while “No published studio work yet” appears only after a server-backed empty query. Stale cached projects are labeled as previously synchronized.
- The status panel reports connection hints, persistent-cache mode, last server-confirmed synchronization, and visible pending writes. Firestore does not expose a precise count of restored pending writes; the count is therefore approximate.
- Browser `online`/`offline` events are hints. Firebase snapshot metadata and server requests confirm actual connectivity.

## Device privacy and storage limits

Persistent storage is off by default because Firestore may cache private drafts and booking contact details. The opt-in dialog warns users and asks them to use a trusted personal device. The app requests the browser's persistent-storage preference when available, but the browser may decline, and the OS/browser can still clear site data. IndexedDB is not an encrypted vault. Firebase login, ID tokens, service account credentials, and private keys are not copied into the app's offline queue.

Turning persistent mode off changes the next page load to memory-only mode; it does not erase existing IndexedDB data. Clearing browser site data can erase the Firestore cache and pending changes. Do not clear it while offline work is waiting. This is not a secure-erasure mechanism.

The service worker caches only the static app shell and the exact versioned, public Firebase JS SDK modules required to initialize the Firestore client offline. It does not cache Firestore API responses, authentication requests, private documents, R2 uploads, or portfolio media. Cached project cards and metadata can be viewed offline if previously synchronized; playing audio/video, loading remote images, YouTube/Vimeo content, and other media still require a connection.

## What works without a connection

- Reopen the previously cached app shell and its local navigation, layout, theme, and static sections.
- Read published portfolio metadata that Firestore previously synchronized to this browser. It may be stale. Media files are not downloaded by the app shell.
- With persistent Firestore storage enabled and a still-valid cached Firebase owner token, queue metadata-only project creation from a supported external HTTPS media URL, edits, publish/unpublish of projects with no R2 file paths, and deletion of external-only project records. Firestore validates every change when it reaches the server. Existing projects with R2 files cannot be unpublished or deleted offline because the Worker must update or remove the media objects.
- Save a booking request to Firestore's durable queue if persistent storage is enabled. WhatsApp does not send until the user is online and taps **Send** in WhatsApp. A queued Firestore write is not confirmation that the studio received the request.

The following remain online-only: Firebase sign-in and token refresh, uploading any local audio/video/image/cover file, R2 visibility changes and file cleanup, media playback or remote image loading, notifications, WhatsApp delivery, and YouTube/Vimeo playback. The image-project form requires a selected image file, so it cannot create a new image project while offline.

If Firestore accepts a pending write, the listener shows it optimistically and confirms it after the server acknowledges it. If Firestore rules or a revision conflict reject a project write, its recovery copy stays in IndexedDB. **Retry sync** replays it only if the server revision still permits that operation; otherwise it remains saved and the conflict is reported without overwriting newer data. Booking writes use Firestore's own pending queue, not the project-metadata recovery store; if Firebase permanently rejects a booking, use its still-prepared WhatsApp message or re-enter it. Do not interpret a pending state as server success.

## Files changed for this feature

- `firebase-client.js` — opt-in Firestore IndexedDB persistence, otherwise memory cache, with memory fallback if IndexedDB is unavailable.
- `offline-policy.mjs` — storage preference, owner-token expiry, revision, public empty-state, and offline-operation policies.
- `offline-recovery.mjs`, `offline-replay.mjs`, and `project-upload-policy.mjs` — IndexedDB recovery for project changes and R2 cleanup, revision-checked idempotent replay, and server-confirmed safeguards against deleting referenced media.
- `offline-sync.mjs` — status panel, metadata-based sync state, manual retry, trusted-device settings, and write feedback.
- `site-cloud.js` — metadata-aware published-project listener, durable idempotent booking document IDs, and Firestore retry wiring.
- `studio-projects.js` — cached owner-token fallback, upload/save acknowledgement handling, safe R2 cleanup, recoverable create IDs and resumable sessions, offline metadata guards, revisioned edits, tombstone deletion, and explicit R2-online requirements.
- `firestore.rules` — owner-only monotonic project revisions and safe offline tombstones; existing public read and owner authorization checks remain in place.
- `index.html` — status/settings UI and honest booking/offline messages; existing site layout and PWA install controls remain.
- `sw.js` — versioned shell, offline route fallback, and an allowlist for versioned public Firebase SDK modules; private/API/media responses remain outside the cache.
- `offline.html` — branded fallback for a deep URL that was not cached.
- `vercel.json` — prevents stale cache responses for the offline fallback and its modules.
- `tests/offline-policy.test.mjs`, `tests/owner-authorization.test.mjs`, `tests/auth-flow.test.mjs`, and `tests/pwa.test.mjs` — policy, owner-token, revision, shell, and routing checks.

## Local testing

There is no frontend package install or build command. From this directory:

```sh
node --test
node --check firebase-client.js
node --check offline-policy.mjs
node --check offline-recovery.mjs
node --check offline-replay.mjs
node --check offline-sync.mjs
node --check site-cloud.js
node --check studio-projects.js
node --check sw.js
```

Serve the static site over HTTP, not `file://`:

```sh
python -m http.server 8000
```

For local sign-in and the media Worker, add `localhost` to Firebase Authentication's Authorized domains and add `http://localhost:8000` to the Worker `ALLOWED_ORIGINS`. PWA service workers require HTTPS in production; localhost is accepted for local development.

## Deployment and verification

Deploy the Firestore rules and the matching static-site version together. The new update rules require a `revision` increment, so an old cached website version will get a permission error on edits until it reloads the new scripts.

```sh
firebase deploy --only firestore:rules --project yj-studio-50df5
vercel deploy --prod
```

No package install or build step is needed for the static Vercel site. Keep the existing Firebase Auth, Firestore, R2 Worker, and Vercel settings. Do not open billing or change the project plan for offline mode.

Test on each real device/browser that matters:

1. Deploy and open the site online over HTTPS. Leave it open until the service worker has installed and its shell has cached. Reload once and confirm Studio Work says Firestore confirmed.
2. On a personally controlled device, open **Offline data settings**, read the privacy notice, and select **Enable on this trusted device**. The site reloads so Firebase initializes persistence before any database access.
3. Let published project metadata sync. As the owner, make an external-URL-only test edit, then disable network in DevTools or device settings. Confirm the owner session is accepted only if its cached ID token is still valid; edit metadata or queue an external-only project; check the pending status; refresh and confirm the local state remains.
4. Reconnect. Confirm the pending state clears, a server-confirmed sync time changes, and the public portfolio updates. Try a stale edit from another device to confirm it is rejected rather than overwriting a newer revision.
5. Confirm uploaded-media project deletion/unpublishing and all file uploads report that the connection is required while offline. Confirm public visitors still cannot write.
6. Open an uncached internal URL offline; it should show `offline.html`. Open `index.html#work`; the installed shell should still display.
7. Test Android Chrome/Edge, iPhone/iPad Home Screen web app where supported, and desktop browsers separately. Browser storage eviction, private browsing restrictions, and OS background limits differ by device.

The automated Node tests verify source policies and service-worker behavior in a controlled simulation. They do not connect to Firebase, exercise deployed Firestore rules, test R2, emulate an expired live Firebase session, or install the PWA on physical devices. Those checks require the deployed project and device test steps above.

## Recovery and stale versions

- If the status says a write was rejected, read the Firebase error and confirm the current owner UID, verified email, custom claim, deployed rules, and project revision. Reload the server copy, then reapply the change. A revision rejection is a conflict signal, not a reason to weaken the rules.
- **Retry sync** re-enables Firestore networking, waits for queued Firestore writes, and requests a server-backed published-project read. Keep persistent mode enabled until pending work has been acknowledged.
- If the app looks stale, reconnect, reload, and let the new service worker activate. The worker cache version changes with shell updates and removes older `yj-studios-shell-*` caches on activation. If it remains stale, use the browser's site settings to unregister the service worker and clear site data, then reload online. Clearing site data deletes pending offline changes, so do this only after they are synchronized or intentionally abandoned.
