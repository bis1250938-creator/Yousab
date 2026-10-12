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


## Fix “not authorized to manage Studio Work”

The site does not authorize by email address or Firestore `/users` records. Its source of truth is the Firebase Authentication custom claim `owner: true` on the signed-in Firebase UID. The frontend force-refreshes the ID token and checks the project ID, verified email, Google or Email/Password provider, and owner claim. Firestore rules and the Cloudflare Worker enforce the owner claim again. A Google sign-in can succeed while project management is denied if this claim is missing. There is no email comparison or Firestore `/users` owner lookup in this authorization path.

1. In Firebase Console → **Authentication → Users**, find the account that just signed in and copy its Firebase **UID**. Confirm it is the existing owner identity; do not use an email address as the UID.
2. On a trusted developer machine with permission to administer Firebase, install the existing Admin SDK utility and authenticate with Google Application Default Credentials: 

   ```sh
   cd admin-tools
   npm install
   gcloud auth application-default login
   node set-owner-role.mjs grant FIREBASE_UID FIREBASE_UID
   ```

   Replace both `FIREBASE_UID` values with that exact UID. The script defaults to `yj-studio-50df5` and refuses to run if `FIREBASE_PROJECT_ID` is set to any other project. It checks that the account is enabled, email-verified, and linked to Google or Email/Password, then preserves existing custom claims while adding `owner: true`. It never grants roles from website code.
3. Sign out of the website, then sign in again with that same Firebase account. The app force-refreshes the ID token and should show the signed-in owner state. If the message says a different Firebase project, compare the Web app's project ID with `firebase-config.js` and the Worker's `FIREBASE_PROJECT_ID`.
4. To remove access later, run `node set-owner-role.mjs revoke FIREBASE_UID FIREBASE_UID`; the script removes only the owner claim, preserves unrelated claims, and revokes refresh tokens.

Do not put service-account files, ADC files, or credentials in the site folder or Vercel deployment. Check **Authentication → Settings → Authorized domains** for the deployed hostname if Google sign-in itself returns `auth/unauthorized-domain`.

## Local use and deployment

Serve the project over HTTP (for example `python -m http.server 8000`) instead of opening `index.html` with `file://`. Add the localhost origin to Firebase Auth and the Worker's `ALLOWED_ORIGINS`. Deploy the static website to Vercel as before after setting the real Worker URL in `firebase-config.js`. Full Cloudflare instructions, cost limits, monitoring, and test steps are in [R2_SETUP.md](./R2_SETUP.md).
