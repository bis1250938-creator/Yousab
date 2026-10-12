# YJ Studios

Static HTML/CSS/JavaScript website and owner dashboard. No build step is required.

- `index.html` — current public studio site and portfolio gallery.
- `dashboard.html` — private portfolio and booking dashboard.
- `firebase-config.js` / `firebase-client.js` — public Firebase Web config and single app/Auth/Firestore initialization.
- `site-cloud.js` — published project reads and public booking requests.
- `media-storage.js` — replaceable media provider boundary and upload validation.
- `firestore.rules`, `storage.rules`, `firestore.indexes.json`, `firebase.json` — database/storage security and deployment configuration.
- `admin-tools/` — trusted Admin SDK tool for granting/revoking the custom `owner` claim. Never publish this folder or credentials.
- `FIREBASE_SETUP.md` — Console setup, admin access, billing/provider limitations, deployment, and remaining steps.

To preview locally, serve this folder over localhost with VS Code Live Server. Do not open the site with `file://`. Deploy the static root to Netlify or Firebase Hosting. Add the site hostname to Firebase Authentication's authorized domains.

Email/Password sign-in requires an enabled, verified Firebase Auth account with the trusted `owner: true` claim. Google sign-in remains available for existing owner accounts. The dashboard cannot grant privileges. Read `FIREBASE_SETUP.md` before deploying rules or choosing media storage.

Firebase Storage uploads require the Blaze billing plan under Firebase's current policy. This project did not enable billing. The local browser fallback remains available, but it does not publish media across devices. Do not describe a local upload as a cloud-published project.

Run local mocked checks with `node --test tests/auth-flow.test.mjs`. These do not contact Firebase or validate deployed Security Rules.
