# Firebase setup for YJ Studios

## What changed

- `firebase-config.js` now uses the Firebase Web app configuration supplied for project `yj-studio-50df5`.
- `firebase-client.js` reuses the default Firebase app and exports reusable `app`, `auth`, `db`, and bucket configuration. Analytics is omitted because this site does not need it.
- `site-cloud.js` listens in real time to published Firestore projects, accepts current and legacy media URL fields, sorts on the client so missing `createdAt` values do not disappear from results, and reports published documents with invalid media data separately from a truly empty gallery.
- `index.html` keeps the existing portfolio design and media cards; Studio Work adds search, media/category filters, a custom audio player, responsive video/embeds, and an accessible image lightbox.
- The booking form continues saving requests to the private Firestore inbox and opens a prefilled WhatsApp chat to `+20 120 867 8717` on submit. The customer must tap **Send** in WhatsApp; websites cannot silently send WhatsApp messages.
- `dashboard.html` keeps the owner-only sign-in and supports project metadata, draft/published status, order, search/filter, editing, confirmed deletion, and uploads of audio, video, and images to Firebase Storage.
- `media-storage.js` isolates storage operations behind a provider interface and normalizes browser MIME aliases to types accepted by Storage Rules. Its 250 MB media and 20 MB cover limits are application limits, not Firebase quotas. MOV is rejected because browser playback varies; MP4 and WebM are supported.
- `firebase-config.js` selects Firebase Storage as the media provider. Uploads work after the Firebase project is on Blaze, its Storage bucket is initialized, and the included Storage Rules are deployed.
- `auth-flow.mjs`, `admin-tools/`, `firestore.rules`, and `storage.rules` authorize only verified accounts with the trusted `owner: true` custom claim. The claim is never granted by frontend code.
- `firestore.indexes.json` is retained for deployments that use the composite ordering elsewhere; the public gallery no longer requires that composite index.

## Billing and media storage status

The Firebase Storage upload adapter is enabled following your approval of the Blaze option. I cannot change billing, initialize the bucket, or inspect this project's private Console state from this workspace, so those Firebase Console steps remain manual.

On Firebase's current no-cost (Spark) plan, standard Cloud Firestore includes up to 1 GiB stored, 50,000 document reads/day, 20,000 writes/day, 20,000 deletes/day, and 10 GiB/month egress. Exceeding a Spark quota shuts that product off until the quota resets; it does not automatically charge a card. Standard Email/Password and social sign-in are part of Firebase Authentication's no-cost options; phone/SMS authentication is excluded here. See [Firebase plan details](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans) and [Firebase pricing](https://firebase.google.com/pricing). These are project-wide service quotas, not unlimited guarantees.

Firebase currently requires the pay-as-you-go Blaze plan to provision a Cloud Storage bucket and to retain Storage access. The configured bucket is `yj-studio-50df5.firebasestorage.app`. Some usage may fall within no-cost allowances, but a linked billing account is required and usage beyond included amounts can incur charges. The upload adapter is enabled in code, but file uploads will fail until the approved billing option is activated in Firebase Console, the bucket is initialized, and rules are deployed. No billing or bucket change was performed in this workspace.

I checked two alternatives. Cloudflare R2 Standard includes 10 GB-month storage, 1 million Class A requests, 10 million Class B requests, and free egress each month. But its setup requires an R2 subscription checkout, overages are billed, and a secure upload endpoint still needs to be hosted/configured. Cloudinary's Free plan is $0 with no credit card and 25 monthly credits shared across storage, transformations, and bandwidth. Browser uploads would require an unsigned preset: the preset name is public, Cloudinary says anyone who knows it can upload, and unsigned presets cannot enforce a per-preset file size. Secure signed uploads and deletion need a trusted server component. Neither service is an appropriate turnkey, securely admin-only $0 solution in this frontend-only project; neither was connected. The storage adapter is the seam for adding a provider after you choose and configure one.

Sources: [Firebase Storage billing changes](https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024), [Firebase pricing](https://firebase.google.com/pricing), [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/), [R2 setup](https://developers.cloudflare.com/r2/get-started/), [Cloudinary free plan](https://cloudinary.com/pricing), [Cloudinary unsigned upload security](https://cloudinary.com/documentation/upload_presets).

## Firebase Console configuration

1. In **Project settings → General → Your apps**, confirm the Web app matches `firebase-config.js`. The Web API key and app ID are public client configuration, not administrator secrets.
2. In **Authentication → Sign-in method**, enable **Email/Password**. Create the administrator account in Firebase Console or the trusted Admin SDK. Verify its email. Do not add a public sign-up flow to this dashboard.
3. Add the production domain and the local development hostname (usually `localhost`) to **Authentication → Settings → Authorized domains**. Serve the site over HTTPS or localhost; `file://` is not supported.
4. Deploy Firestore rules and indexes from this folder:

   ```sh
   firebase deploy --only firestore --project yj-studio-50df5
   ```

5. In **Storage → Get started**, activate Blaze if not already active and initialize the configured bucket in the location you choose. The code already selects the Firebase Storage provider. Deploy both rule sets:

   ```sh
   firebase deploy --only firestore,storage --project yj-studio-50df5
   ```

   Storage rules consult Firestore to allow public reads only for published project files. Firebase will ask to enable the cross-service Firestore rules permission; approve it to use public media reads. `getDownloadURL()` links are shareable URLs, so treat published media links as public. Unpublishing blocks rule-authorized reads, but revoke/rotate download tokens if a previously shared token URL must be invalidated.

## Administrator authorization

Firestore and Storage rules require all three conditions: a verified email, Firebase Auth sign-in via Email/Password or Google, and the `owner: true` custom claim. A signed-in account without the claim has no private dashboard access and cannot write projects or upload media.

Grant/revoke the claim from a trusted machine using Application Default Credentials with an account authorized to administer this Firebase project. Never publish ADC files, service-account keys, or this tool in a public site deployment.

```sh
cd admin-tools
npm install
gcloud auth application-default login
node set-owner-role.mjs grant FIREBASE_UID FIREBASE_UID
```

Find the exact UID in **Authentication → Users** first. The script requires the same UID twice, checks the account is enabled and email-verified, preserves unrelated claims, and supports Email/Password or Google accounts. After granting the role, sign out and back in so Firebase issues a token with the claim. Revoke with:

```sh
node set-owner-role.mjs revoke FIREBASE_UID FIREBASE_UID
```

Never use an email string as a substitute for the Firebase UID. Security Rules are the authorization boundary; the dashboard gate only controls the interface.

## Projects and rules

Public portfolio documents live in `projects` and should set `published: true`, `title`, `description`, `mediaType` (`audio`, `video`, or `image`), `category`, `fileUrl`, `filePath` when applicable, `createdAt`, and optionally `featured`, `artist`, `credits`, `thumbnailUrl`, and `sortOrder`. Existing documents using `kind`, `mediaUrl`, and `caption` remain readable. The admin can save direct HTTPS media URLs now, including YouTube/Vimeo links for video. The public site omits documents without a real HTTPS media URL or with example/placeholder URLs. Draft metadata remains owner-only. Firestore rules allow public reads of published projects; only an authorized owner can create, edit metadata/status/order, or delete. Storage rules validate the owner, path, size, and declared MIME type, and consult Firestore so stored media is readable publicly only while its project is published (or by the owner). Rules cannot inspect encoded bytes; the browser checks file extension and MIME type for usability. Deploying Storage rules requires enabling the cross-service Firestore read permission when Firebase prompts; these reads count against Firestore quotas.

The existing booking form also writes booking requests. Those documents remain publicly creatable with field validation and owner-only readable/editable, as required for the public booking form.

## Local run and deploy

There is no build step. Open this folder and serve it over HTTPS or localhost; `file://` does not support Firebase sign-in. `index.html` is the public site and `dashboard.html` is the private dashboard at `/dashboard.html`. The dashboard verifies the Firebase owner claim before showing controls. The static files can be deployed to Vercel, Netlify, or Firebase Hosting; publish the website root files and do not publish `admin-tools/` or its credentials. For Firebase Hosting, configure the hosting root to this folder and deploy with `firebase deploy --only hosting --project yj-studio-50df5` after reviewing `firebase.json`.

The existing PWA service worker, responsive layout, animations, portfolio cards, and media filters are preserved. Sign-in, Firestore, and Storage operations have not been exercised against the live Firebase project. Uploading files from a computer requires the manual Console setup and rules deployment above.

## Remaining setup

- Enable Email/Password authentication and create/verify the administrator account.
- Assign its custom claim from a trusted Admin SDK environment.
- Deploy the Firestore rules and index.
- Activate the approved Blaze billing option and initialize the Storage bucket in Firebase Console; usage beyond included amounts can incur charges.
- Deploy the static site and add its domain to Firebase Authentication authorized domains.
