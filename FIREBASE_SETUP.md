# Firebase setup for YJ Studios

Firebase Authentication and Firestore continue to power owner sign-in, trusted administrator authorization, booking requests, and portfolio metadata. New audio, image, and video files use the authenticated Cloudflare R2 Worker documented in [R2_SETUP.md](./R2_SETUP.md); Firebase Storage is not used for new uploads.

## Cross-device Web Push notifications

The main-site **Notifications** control uses Firebase Cloud Messaging (FCM) on supported HTTPS browsers. It requests browser permission only after the user selects **Enable Notifications**. Each browser installation receives its own Firebase Installation ID (FID), stored under `notificationDevices/{firebaseUid}/devices/{browserDeviceId}` by a callable Function. On this version of Firebase, the Web SDK's FID registration callbacks update the saved record when an installation changes; dead FIDs are removed when a test send reports them invalid.

The client cannot read or write device records directly. `registerNotificationDevice`, `removeNotificationDevice`, and `sendTestNotification` verify a signed-in, email-verified Google or Email/Password Firebase identity. Registration and removal are scoped to `request.auth.uid`, with a transactional limit of 10 browser devices per account. The test endpoint takes no target UID, FID, or custom message, and sends only to the caller's registered devices. It is rate-limited to one test every 30 seconds. This avoids opening a general-purpose send API; it does not send portfolio announcements to other users.

### Required Firebase setup

1. In Firebase Console, select project `yj-studio-50df5` → **Project settings → Cloud Messaging**. Under **Web Push certificates**, generate a key pair. Copy only the displayed **public** key into `globalThis.YJ_FCM_VAPID_KEY` in `firebase-public-config.js`. Do not paste the private key anywhere in this website.
2. In the Cloud Messaging settings, confirm the Firebase Cloud Messaging API and FCM Registration API are enabled for this project. The web SDK registration requires HTTPS, a service worker, a Web Push key, and browser Push API support. The existing root-scoped `sw.js` was extended so the offline shell and FCM background handler share one registration.
3. The Firebase project must be on **Blaze** to deploy Cloud Functions. This implementation does not switch billing plans or deploy services automatically. Functions have no-cost usage quotas, but deployment artifacts and usage beyond quotas can cost money. Configure a Google Cloud budget alert and a Cloud Run Functions spend cap before deployment; budgets are notifications, not a hard cap by themselves.
4. From this website's project directory run:

   ```sh
   npm --prefix functions install
   npm --prefix functions test
   firebase deploy --only functions,firestore:rules --project yj-studio-50df5
   ```

   The Functions runtime uses the project's attached service identity and Firebase Admin SDK. No service-account JSON or server secret belongs in this repository. Static website files (including `sw.js` and `firebase-public-config.js`) still deploy through Vercel; the `functions/` source is excluded from the Vercel static deployment.

### Use and platform notes

1. Sign in with an existing verified Google or Email/Password Firebase account. Project edits still require the existing `owner: true` claim; notification subscriptions are per verified account and cannot target another account.
2. Open **Notifications** → **Enable Notifications** on each browser/device and accept the browser prompt. A permission grant on one device does not subscribe another. **Send Test Notification** targets all of that account's registered devices. **Disable on This Device** removes this browser's record and FCM installation; repeat on other devices if desired. Owner sign-out also unregisters the current browser.
3. Foreground delivery appears as an in-page toast to avoid duplicate OS notifications. Background messages are displayed by the service worker; clicking opens the Studio Work section. Browser/OS focus modes, revoked site permissions, connectivity, and push-provider delivery policies can delay or suppress delivery.
4. iPhone/iPad web push requires iOS/iPadOS 16.4 or later and installing the website to the Home Screen; a normal Safari tab is not sufficient. The Firebase SDK also checks whether the required messaging APIs are present and shows an unsupported-browser message if not. Firebase documents FCM Web for browsers with Push API support; Apple documents the Home Screen requirement for iOS. [Firebase FCM Web setup](https://firebase.google.com/docs/cloud-messaging/web/get-started) · [Apple Web Push requirements](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers).
5. To test, use one desktop browser and a second browser/device signed into the same Firebase account. Enable each separately, send a test, verify foreground toast on an open page and a system notification with the page backgrounded, click the notification, then disable one device and verify the other remains registered. Also test permission states `default`, `granted`, and `denied` using browser site settings. A callable response means FCM accepted a send; it cannot guarantee OS display.

### Current delivery boundary

The source changes and local policy tests are implemented, but the VAPID public key is intentionally blank until generated in Firebase Console, and the Functions are not deployed from this workspace. Live cross-device delivery therefore remains unverified until the setup above is completed. Firebase's JavaScript SDK only attempts browsers where its runtime support check succeeds. Apple's iOS behavior is documented separately; the browser must be installed as a Home Screen app on a supported iOS/iPadOS release.

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
- `firebase-public-config.js`, `notifications.js`, `notification-policy.mjs`, the extended `sw.js`, and `functions/` implement the FCM FID-based subscription, private device records, background handling, test sender, and local policy tests.
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
