import { auth, db } from "./firebase.js";

import {
  onAuthStateChanged,
  reload,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";

function queueAuthFlash(message, tone = "warning") {
  localStorage.setItem(
    "authFlash",
    JSON.stringify({
      tone,
      message,
      createdAt: Date.now(),
    })
  );
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }

  await reload(user).catch(() => {});
  const currentUser = auth.currentUser || user;

  if (!currentUser.emailVerified) {
    queueAuthFlash("Please verify your email before opening the dashboard.", "warning");
    await signOut(auth).catch(() => {});
    window.location.href = "index.html";
    return;
  }

  const docSnap = await getDoc(doc(db, "users", currentUser.uid));

  if (!docSnap.exists()) {
    queueAuthFlash("User data is missing. Please sign in again.", "danger");
    await signOut(auth).catch(() => {});
    window.location.href = "index.html";
    return;
  }

  const role = docSnap.data().role;
  const currentPage = window.location.pathname;

  if (currentPage.includes("student") && role !== "student") {
    window.location.href = "teacher.html";
  }

  if (currentPage.includes("teacher") && role !== "teacher") {
    window.location.href = "student.html";
  }
});
