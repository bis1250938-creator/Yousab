# Firebase setup for YJ Studios

Firebase Authentication and Firestore continue to power owner sign-in, trusted administrator authorization, booking requests, and portfolio metadata. New audio, image, and video files use the authenticated Cloudflare R2 Worker documented in [R2_SETUP.md](./R2_SETUP.md); Firebase Storage is not used for new uploads.

## Firebase Console configuration

1. In **Project settings → General → Your apps**, confirm the Web app belongs to `yj-studio-50df5`. The web API key and app ID in `firebase-config.js` are public client configuration, not administrator secrets.
2. In **Authentication → Sign-in method**, enable Email/Password or Google. Add the production site and `localhost` to **Authentication → Settings → Authorized domains**.
3. Keep the owner account verified and grant it the trusted `owner: true` custom claim only through `admin-tools/set-owner-role.mjs` from a trusted machine. The dashboard UI and Cloudflare Worker both check the verified owner claim. Never add an admin password or service-account key to this site.
4. Deploy Firestore rules:

   ```sh
   firebase deploy --only firestore --project yj-studio-50df5
   ```

   Rules allow public visitors to read published project metadata and only the authorized owner to create, edit, publish, or delete projects. Booking requests remain in the private owner inbox.
5. Follow [R2_SETUP.md](./R2_SETUP.md) to create the R2 bucket, D1 control database, deploy the Worker, configure usage safeguards, and set the Worker URL in `firebase-config.js`.

## Current implementation

- `index.html` preserves the Studio Work design and hosts the six-type project wizard.
- `studio-projects.js` retains Firebase owner sign-in and Firestore metadata management, and sends media uploads/deletes through the authenticated R2 adapter.
- `r2-uploader.js` uploads resumable 16 MiB chunks with progress, retry, cancellation, and local resume state.
- `r2-worker/` validates Firebase ID tokens and claims, manages multipart uploads in R2, maintains active-object and operation quota inventory in D1, serves public media with byte-range support, and periodically cleans up stale upload reservations.
- `firebase-config.js` contains the public Worker endpoint setting. It must be updated after deployment.
- `firestore.rules` remains the authorization boundary for public published-project reads and owner-only metadata writes.
- `storage.rules` is retained for legacy Firebase Storage objects only; it is not part of new R2 uploads.

## Local use and deployment

Serve the project over HTTP (for example `python -m http.server 8000`) instead of opening `index.html` with `file://`. Add the localhost origin to Firebase Auth and the Worker's `ALLOWED_ORIGINS`. Deploy the static website to Vercel as before after setting the real Worker URL in `firebase-config.js`. Full Cloudflare instructions, cost limits, monitoring, and test steps are in [R2_SETUP.md](./R2_SETUP.md).
