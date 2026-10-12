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

// File uploads use the Firebase Storage bucket configured above.
// Storage must be initialized in Firebase Console and the Storage Rules deployed.
export const mediaStorageProvider = 'firebase-storage';
