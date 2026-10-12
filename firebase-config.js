// Web app configuration is public client-side data. Keep Firebase Security Rules
// enforced; never put private service-account keys or admin passwords here.
export const firebaseConfig = {
  apiKey: "AIzaSyAMDW3JJZ-nNnXLQveUd3gcwiBLX4F0nB4",
  authDomain: "yj-studio-50df5.firebaseapp.com",
  projectId: "yj-studio-50df5",
  storageBucket: "yj-studio-50df5.firebasestorage.app",
  messagingSenderId: "1058803606124",
  appId: "1:1058803606124:web:84a26afbad30d79433ae49",
  measurementId: "G-JJ4E1W0RDM"
};

// Set to the deployed Cloudflare Worker API base URL. This value is public;
// R2 credentials remain only in the Worker environment.
export const r2WorkerUrl = 'https://SET-YOUR-WORKER-URL.workers.dev';
