# YJ Studios website

Editable static website source. There is no build step. Visitors and the owner use one Firebase Google sign-in and sign-up flow; the trusted owner role routes the owner to the private dashboard.

## Files

- `index.html` — responsive studio site, searchable multimedia portfolio, audio visualizer, and session request form.
- `auth.html` — shared Google sign-in and sign-up page for studio visitors and the owner.
- `account.html` — signed-in visitor account page, session status, booking link, and sign-out.
- `dashboard.html` — private owner workspace for adding, editing, previewing, ordering, publishing, and deleting portfolio projects, plus service rates, activity, and booking inbox.
- `auth-flow.mjs` — validated Google sign-in/sign-up intent, role routing, and owner-session helpers.
- `firebase-config.js` — Firebase Web app configuration used for Google sign-in.
- `firebase-client.js` / `site-cloud.js` — Firebase initialization, public portfolio reads, and booking request writes.
- `firestore.rules` / `storage.rules` — owner-only dashboard data and uploads, with published portfolio media readable by visitors.
- `firestore.indexes.json` / `firebase.json` / `storage-cors.json` — Firestore query index, Firebase rule deployment, and audio visualizer CORS setup.
- `site.webmanifest` — app name, colors, and home-screen icons.
- `dashboard.webmanifest` — separate phone install entry that opens directly to the owner dashboard.
- `sw.js` — offline cache for the website shell.
- `tests/auth-flow.test.mjs` — mocked Google account-flow tests (`node --test tests/auth-flow.test.mjs`).
- `admin-tools/` — privileged Firebase Admin SDK script to grant or revoke the owner claim by Firebase UID. Keep its admin credentials out of the website.
- `yj-studios-logo.jpg` — supplied studio logo.
- `icons/` — Android and iPhone home-screen icons.
- `INSTALL-ON-PHONE.txt` — publishing and phone-install steps.

## Edit and preview in VS Code

1. Open this project folder in VS Code with **File → Open Folder…**.
3. Edit `index.html` for the page, styling, and interactive behavior. Edit `site.webmanifest` for the app name and colors.
4. For local PWA and offline behavior, serve the folder from `localhost` with a static server such as VS Code Live Server. Opening `index.html` as a `file://` URL does not enable the service worker.

To keep the site or owner dashboard on a phone, publish the website files at an HTTPS address and follow `INSTALL-ON-PHONE.txt`. Do not publish `admin-tools/`. Open `dashboard.html`, sign in through the shared account page, then use the dashboard install button to add a separate YJ Owner icon. The dashboard still requires internet access for Google sign-in and live booking data.

## Portfolio and booking data

Sign in through `auth.html` with the Google account assigned the owner role. New projects save their metadata in Firestore and their media in Firebase Cloud Storage. The dashboard supports audio, video, and image projects, descriptions, categories, tags, client and credit details, external links, featured status, drafts, previews, replacing media, and manual ordering. Uploads show progress and are retried from the form if a connection fails; new projects are never saved to browser storage as a fallback.

Projects that were saved in IndexedDB by an older version of this site are still available in the owner dashboard. Use **Publish** beside each older project to upload it to Cloud Storage and copy its metadata to Firestore. Once published, that local copy is removed. The public website reads only published Firestore projects, so projects appear consistently across browsers and devices.

The public portfolio has media-type and category filters, search, featured projects, responsive players, image thumbnails, and project previews. Audio and video use native player controls and do not preload the full file before a visitor presses play. Uploaded image and video thumbnails are generated in the browser when its decoder supports them; otherwise the cover image or media itself is used.

Published media is public so visitors can play or view it; only a verified owner account can create, edit, publish, unpublish, order, or delete project records and media. Firestore Rules validate project metadata; Storage Rules validate the owner claim, file paths, types, and size limits. Cloud Storage requires the Firebase Blaze billing plan. Downloads and stored files may incur charges, so set a budget alert and publish media intended for the public site only.

When Firestore is enabled and `firestore.rules` are published, the public booking form sends inquiries to a private owner-only inbox. The dashboard shows new requests live and lets the owner update their status or delete them. A request is not a confirmed session. If Firestore is not configured or sending fails, the visitor can still copy and share the request.

## Owner sign-in and role setup

Visitors and the owner use the same **Sign in / create account** page and Google provider. New visitors can create a Firebase Auth account and use the basic account page; existing accounts sign in and restore their Firebase-managed session. A Google identity that is new during sign-in is rejected rather than silently registered. Attempting sign-up with an existing identity is rejected without creating a duplicate. Google is the only login provider configured here, so the current account-linking policy does not merge identities from different providers.

After authentication, the shared flow refreshes the Firebase ID token and routes only a verified Google identity with the trusted `owner: true` custom claim to `dashboard.html`. Other authenticated visitors go to `account.html`. The account page currently shows the signed-in identity and links back to the studio booking form; booking requests remain studio inquiries rather than account-owned records.

Owner access is represented by the Firebase Auth custom claim `owner: true`, assigned only by the trusted Admin SDK tool in `admin-tools/`. The script targets an explicit Firebase UID, requires that the account is enabled, email-verified, and linked to Google, preserves unrelated custom claims, and requires the UID to be typed twice. The application does not grant a role from a client-provided email, Google sign-in alone, or local storage. Firestore and Storage Security Rules independently require the signed Firebase ID token to contain the owner claim and to represent a verified Google session. Firebase documents that custom claims must be assigned from a privileged Admin SDK environment and can be enforced in Security Rules: [custom claims](https://firebase.google.com/docs/auth/admin/custom-claims), [Security Rules and Auth](https://firebase.google.com/docs/rules/rules-and-auth).

This is a static Firebase client application with no custom HTTP server or separate application user table. Firebase Auth is the account store; its Firebase UID maps the linked Google identity. `getAdditionalUserInfo(...).isNewUser` keeps the sign-in and sign-up actions distinct. Owner status is not inferred from email or browser state. Sign-up only creates an ordinary Firebase Auth identity; it cannot read owner data or open the dashboard until an administrator grants the custom claim. Firebase provisions first-time federated identities before the app receives the result, so a failed cleanup on a sign-in attempt must be removed from **Authentication → Users**.

Google is the only owner login provider present in this project; there is no existing email/password authentication route to preserve or migrate.

The dashboard refreshes and verifies the Firebase ID token's owner claim before revealing private data. Firebase SDK local persistence is explicitly stored in IndexedDB, not copied into application localStorage; it survives refreshes on that browser and origin. Each browser/device signs in with Google separately. Firebase-managed ID tokens are checked by Firestore and Storage on each request. This site has no custom backend endpoints or cookie session to secure; if one is added later, it must verify the Firebase ID token with the Admin SDK and authorize the `owner` claim. [Firebase Auth persistence](https://firebase.google.com/docs/auth/web/auth-state-persistence), [Admin SDK token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens).

### One-time owner setup

1. In Firebase Console, enable Google under **Authentication → Sign-in method** and add `yjstudio.com` under **Authentication → Settings → Authorized domains**. The Firebase Web app is `yj-studio-50df5` with `authDomain` `yj-studio-50df5.firebaseapp.com`; the OAuth handler is `https://yj-studio-50df5.firebaseapp.com/__/auth/handler`. For local Live Server, use `http://localhost:5500` and authorize `localhost`. Never use `file://` for sign-in.
2. In **Authentication → Users**, find the existing owner account linked to Google and copy its Firebase UID. If that Auth account does not exist yet, publish the site, choose **Create an account** at `auth.html`, and sign up with the intended Google account. This creates only an unprivileged account. Verify the UID corresponds to the intended owner before granting a role.
3. Install and sign in to the Firebase CLI (`npm install -g firebase-tools`, then `firebase login`). From this website project folder, deploy the Firestore indexes and Firestore/Storage rules with `firebase deploy --only firestore,storage --project yj-studio-50df5`. The dashboard remains blocked until the next step assigns the owner claim.
4. In a trusted admin terminal, install the isolated tool dependency and authenticate with Google Cloud Application Default Credentials using an account permitted to administer this Firebase project:

   ```powershell
   cd admin-tools
   npm install
   gcloud auth application-default login
   node set-owner-role.mjs grant FIREBASE_UID FIREBASE_UID
   ```

   Replace both `FIREBASE_UID` values with the same UID copied from Firebase Console. The tool does not accept an email as the grant target. Keep ADC credentials and any service-account files outside the published website and source ZIP.
5. The owner signs out, then signs in at `auth.html`. The shared flow force-refreshes the ID token and routes to the dashboard after checking the claim. Existing owner Auth data is preserved; there is no database migration.
6. To revoke owner access, run `node set-owner-role.mjs revoke FIREBASE_UID FIREBASE_UID` from `outputs/admin-tools`, then sign out the owner. The role claim is removed, unrelated claims are preserved, and refresh tokens are revoked. Firebase ID tokens already issued can remain usable until they expire; the app force-refreshes before opening the dashboard.

The client-side dashboard gate is for navigation and feedback; the rules are the actual data security boundary. Storage paths remain scoped to the Firebase UID. No OAuth client secret or Admin SDK key belongs in `firebase-config.js` or any published file.

Publish `auth.html`, `account.html`, `dashboard.html`, `auth-flow.mjs`, the Firebase web config/client files, site files, service worker, manifests, icons, and logo at the site root. Do not publish `admin-tools/` with credentials. The Firebase Web `apiKey` and app ID are public client configuration. Firestore has a no-cost daily quota; usage above that quota requires billing. See [Firebase pricing](https://firebase.google.com/docs/firestore/pricing).

Run the mocked auth/role tests with `node --test tests/auth-flow.test.mjs`. They cover distinct sign-in/sign-up results, redirect intent, shared account routing, trusted role-claim checks, admin tool eligibility, logout wiring, owner-only rules, and error messages. They do not contact Google, connect to Firebase, or emulate/deploy Security Rules. This repository has no web build, lint, or type-check configuration. Google opens its own sign-in page; never enter a Google password into this website or share service-account credentials.
