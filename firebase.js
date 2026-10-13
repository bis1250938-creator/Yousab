// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyAMDW3JJZ-nNnXLQveUd3gcwiBLX4F0nB4",
  authDomain: "yj-studio-50df5.firebaseapp.com",
  databaseURL: "https://yj-studio-50df5-default-rtdb.firebaseio.com",
  projectId: "yj-studio-50df5",
  storageBucket: "yj-studio-50df5.firebasestorage.app",
  messagingSenderId: "1058803606124",
  appId: "1:1058803606124:web:84a26afbad30d79433ae49",
  measurementId: "G-JJ4E1W0RDM"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);