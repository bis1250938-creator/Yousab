# YJ Studios source

Static vanilla HTML, CSS, and JavaScript site for YJ Studios.

- `index.html` — existing website, Studio Work cards and type-based upload modal.
- `studio-projects.js` — Firebase Authentication and Firestore portfolio management.
- `r2-uploader.js` — browser multipart client with resumable sessions, progress, and cleanup of completed session markers after server-confirmed saves.
- `project-upload-policy.mjs` — verifies a server-read project record before deciding whether an uploaded R2 object can safely be removed.
- `r2-worker/` — Cloudflare Worker + D1 migration for verified-owner R2 upload/delete and public media serving.
- `firebase-config.js` — public Firebase app configuration and deployed R2 Worker URL.
- `site-cloud.js` — real-time public published-project rendering.

Setup, current R2 free-tier limits, safeguards, deployment, and test instructions: [R2_SETUP.md](./R2_SETUP.md). Firebase settings: [FIREBASE_SETUP.md](./FIREBASE_SETUP.md).

Offline PWA behavior, trusted-device Firestore persistence, supported offline operations, deployment, and device testing: [OFFLINE_SETUP.md](./OFFLINE_SETUP.md).
