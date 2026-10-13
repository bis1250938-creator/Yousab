# Cloudflare R2 upload setup

## What this changes

The existing YJ Studios site remains a static vanilla HTML/CSS/JavaScript site on Vercel. Firebase Authentication remains the identity provider and Firestore remains the project metadata database. Media upload, deletion, and delivery now go through `r2-worker/`, a Cloudflare Worker bound to a private R2 bucket. The browser only receives a Worker URL and Firebase ID token; it never receives R2 access keys.

The original Add Project control was already connected to the existing type wizard. When the current user lacked the trusted Firebase `owner: true` custom claim, its click handler opened the sign-in modal rather than the project modal. After sign-in, the same handler opened the wizard. The storage implementation was hard-wired to Firebase Storage, which required an initialized bucket and was not suitable for the requested R2 path. This change leaves that authorization behavior intact and replaces the media provider.

**Current deployment blocker:** this source still has `https://SET-YOUR-WORKER-URL.workers.dev` in `firebase-config.js` and `REPLACE_WITH_D1_DATABASE_ID` in `r2-worker/wrangler.toml`. Until a real D1 database is attached, its migration is applied, the Worker is deployed, and the resulting HTTPS URL replaces the placeholder, file uploads cannot reach storage. This cannot be completed by frontend code alone because it requires access to the Cloudflare account. The Add Project form now reports this configuration failure directly. The uploader also retains multipart resume state after transient failures and refreshes expired Firebase ID tokens.

## R2 free tier and cost safeguards

Cloudflare currently lists R2 Standard's free tier as 10 GB-month storage, 1 million Class A operations/month, 10 million Class B operations/month, and free internet egress. Beyond those free allowances, current listed Standard rates are $0.015/GB-month, $4.50/million Class A operations, and $0.36/million Class B operations. The free tier is an allowance, not unlimited storage, and the allowance is shared at the Cloudflare account level. Infrequent Access has different charges and is not used here. Verify current details before deployment at [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/).

Safeguards configured in the Worker source:

- `STORAGE_QUOTA_BYTES=8000000000` reserves a conservative 8,000,000,000-byte portfolio limit, leaving headroom under the 10 GB-month R2 allowance. It counts active multipart reservations and complete objects in this app's D1 inventory. Use a dedicated bucket/account and check other account usage because R2 free allowances are shared.
- `MAX_OBJECT_BYTES=5368709120` caps any one file at 5 GiB. The Worker clamps this to the provider limit and independently enforces `MAX_COVER_BYTES=104857600` (100 MiB) for image covers. The browser validates the same limits for usability.
- `MAX_MONTHLY_R2_CLASS_A=900000` stops Worker-mediated multipart Class A operations before the listed 1 million allowance. This app counter does not observe other buckets or services in the account, so keep account usage below the free limits independently.
- Worker Free plan requests have a 100,000 requests/day limit. Each public media read passes through the Worker, so this also limits portfolio media requests while keeping R2 Class B usage bounded. If the account uses paid Workers, configure it to stay on the Free plan; this Worker does not automatically upgrade services.
- The Worker rejects uploads when configured limits are reached. Cloudflare D1 also has plan-based quotas; check its current limits before launch at [D1 pricing and limits](https://developers.cloudflare.com/d1/platform/pricing/). The Worker does not provide a Cloudflare account-wide hard spending cap. Configure Cloudflare usage/billing notifications in the dashboard and review R2 and Workers usage regularly. Treat alerts as monitoring, not a spending cap. Do not enable paid Workers or other paid products as a way around a reached limit.

R2 charges can still occur if the Cloudflare account uses other buckets/services, the free allowance changes, the Worker is moved to a paid plan, or account-level settings permit paid overages. No code can promise a $0 bill without control of the whole Cloudflare account. The configured app quotas are additional safeguards, not an unlimited free-tier claim.

## Set up Cloudflare without enabling a paid plan

1. Create or use a Cloudflare account and keep Workers on the Free plan. Create an R2 bucket named `yj-studios-media` using Standard storage. Do not create an Infrequent Access bucket for this integration.
2. Install Node.js and Wrangler, then in `r2-worker/` run:

   ```sh
   npm install
   npx wrangler login
   npx wrangler r2 bucket create yj-studios-media
   npx wrangler d1 create yj-studios-media-control
   ```

   If the bucket already exists, keep it; avoid creating duplicates. Copy the D1 database ID into `r2-worker/wrangler.toml` in place of `REPLACE_WITH_D1_DATABASE_ID`.
3. Apply the schema to the remote D1 database:

   ```sh
   npx wrangler d1 migrations apply yj-studios-media-control --remote
   ```
4. Review `r2-worker/wrangler.toml`. Add your exact production origin to `ALLOWED_ORIGINS`. Keep localhost entries only for local development. The Worker enforces a 5 GiB object cap, 100 MiB cover cap, 8 GB app-level reserved-storage cap, and 900,000 monthly app-tracked Class A-operation cap. These limits are clamped in Worker code so a larger config value cannot raise them. Do not change the source safeguards without checking account usage and current pricing.
5. Deploy from `r2-worker/`:

   ```sh
   npx wrangler deploy
   ```

   The R2 binding is used instead of S3 credentials, so do not generate or copy R2 access keys into this site. The Worker validates Firebase ID tokens using Firebase's public signing keys and requires a verified email, the `owner: true` custom claim, and an allowed Firebase sign-in provider.
6. Copy the deployed Worker HTTPS URL into `r2WorkerUrl` in `firebase-config.js`, replacing `https://SET-YOUR-WORKER-URL.workers.dev`. This URL is public configuration, not a secret.
7. In Cloudflare billing/notifications, enable email alerts for usage and billing near the free allowance. Check **R2 → Overview/Analytics** and **Workers & Pages → Usage** after launch and at least weekly during uploads. Cloudflare does not offer a universal hard dollar cap for all R2 use; keep the Worker quotas and Free plan in place. Avoid sending the R2 media host direct public traffic; all media URLs use the Worker so the Free Worker daily request cap applies.

R2 multipart parts are 16 MiB from the browser. This stays below the Cloudflare Workers Free incoming request-body limit (100 MB), including for files larger than 500 MB. R2 supports up to 10,000 parts and 5 GiB maximum part size; 16 MiB parts keep the 5 GiB app cap far below the part-count maximum. R2 has a 5 MiB minimum part size except the last part. The Worker retries transient part failures in the browser, and the browser stores an opaque resume session in local storage; after a page interruption, select the same file again to resume. The R2 automatically aborts abandoned multipart uploads after seven days; the included daily Worker Cron tries to abort at six days and releases the D1 reservation. Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [R2 multipart uploads](https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/), [R2 upload limits](https://developers.cloudflare.com/r2/objects/upload-objects/), [R2 lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).

## Firebase and Vercel setup

1. Firebase Authentication must retain the existing owner account and trusted `owner: true` custom claim. The claim is still set only by the existing trusted admin tool; neither the browser nor Worker grants it. Sign out and back in after changing claims.
2. Deploy the existing Firestore rules, which allow public reads only for published projects and owner-only writes:

   ```sh
   firebase deploy --only firestore --project yj-studio-50df5
   ```

   Firestore and Firebase Authentication remain required. Firebase Storage is not used for new uploads and does not need to be enabled for R2 media.
3. Vercel continues to serve the existing static site. Deploy the updated source folder as before. Verify that `firebase-config.js` contains the production Worker URL before publishing.
4. Serve locally over HTTP (not `file://`) and use a Firebase-authorized owner account. `localhost` must be in Firebase Auth authorized domains and the Worker `ALLOWED_ORIGINS` list.

## Upload and publish

1. Sign into the owner account on the site. If Add Project opens the sign-in dialog, complete sign-in; only a verified account with the trusted claim can open the type wizard.
2. Select one of the six project types, choose a local file, fill the required title, and use Draft or Publish. Preview and file size are shown before saving.
3. The browser uploads 16 MiB parts to the authenticated Worker, which checks the trusted owner token, file MIME, per-file size, and reserved quota in D1 before writing multipart objects to R2. Progress, retries, and cancel are handled in the modal. Once every object completes, the project document is written to the existing `projects` Firestore collection with Worker media URLs and R2 object keys. The modal reports separately when media is uploaded and when Firestore confirms project metadata.
4. For published R2 media, the Worker marks only that project’s R2 objects public after the owner action; draft R2 objects return 404. Published projects appear through the existing real-time Firestore portfolio listener. Draft metadata remains hidden by Firestore rules. Edit/publish/unpublish/delete controls remain owner-only.
5. If Firestore rejects metadata after media upload, the client first reads the project from the server. It deletes only uploaded keys that the confirmed record does not reference. If the read or deletion is unavailable, the app preserves the media paths in IndexedDB for owner retry; it never blindly deletes objects after an ambiguous Firestore acknowledgement. A saved create is replayed with its stable document ID, and an already-committed create is recognized without making a duplicate. Download recovery details before discarding records. A metadata-only external-URL project still uses Firestore without R2.

## What was checked and what remains

Run the current repository checks with `node --test`; they also validate that every accepted project media type maps to a Worker-supported content type. No live Firebase account, Cloudflare credentials, deployed Worker, R2 bucket, or D1 database was available in this workspace, so real sign-in, upload, playback, quota, resume, and delete flows remain untested. Complete the Cloudflare/Firebase setup above, then test a small audio, image, and video project, one file above 500 MB, a canceled/retried upload, publish/unpublish, and deletion before opening uploads to visitors.
