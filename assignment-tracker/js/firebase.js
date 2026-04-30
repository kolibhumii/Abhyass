// firebase.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";

//  Add these (IMPORTANT for your project)
import { getAuth } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-storage.js";

// Your config
const firebaseConfig = {
  apiKey: "AIzaSyAQaJfGfBSCeyLltewjvcXKrcPY5Q68TNQ",
  authDomain: "assignment-tracker-43083.firebaseapp.com",
  projectId: "assignment-tracker-43083",
  storageBucket: "assignment-tracker-43083.firebasestorage.app",
  messagingSenderId: "940268263929",
  appId: "1:940268263929:web:1173be5b8edd91ffac8528",
  measurementId: "G-WYMHFGH56P"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize services
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

// Export them (VERY IMPORTANT)
export { auth, db, storage };
