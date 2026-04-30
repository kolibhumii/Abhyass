import { auth, db } from "./firebase.js";

import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  reload,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";

import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";

const studentSignupForm = document.getElementById("studentSignupForm");
const teacherSignupForm = document.getElementById("teacherSignupForm");
const loginForm = document.getElementById("loginForm");
const alertBox = document.getElementById("authAlert");
const verificationPanel = document.getElementById("verificationPanel");
const verificationTitle = document.getElementById("verificationPanelTitle");
const verificationText = document.getElementById("verificationPanelText");
const verificationEmail = document.getElementById("verificationPanelEmail");
const resendVerificationBtn = document.getElementById("resendVerificationBtn");
const refreshVerificationBtn = document.getElementById("refreshVerificationBtn");
const verificationSignOutBtn = document.getElementById("verificationSignOutBtn");

let activeVerificationRole = "";
let resendCooldownTimer = null;
let resendCooldownUntil = 0;
let authFlowBusy = false;

function showAuthAlert(message, tone = "info") {
  if (!alertBox) return;

  const toneClass = {
    success: "alert-success",
    warning: "alert-warning",
    danger: "alert-danger",
    info: "alert-info",
  }[tone] || "alert-info";

  alertBox.className = `alert mt-3 ${toneClass}`;
  alertBox.textContent = message;
  alertBox.classList.remove("d-none");
}

function hideAuthAlert() {
  alertBox?.classList.add("d-none");
}

function queueAuthFlash(message, tone = "info") {
  localStorage.setItem(
    "authFlash",
    JSON.stringify({
      message,
      tone,
      createdAt: Date.now(),
    })
  );
}

function consumeAuthFlash() {
  const raw = localStorage.getItem("authFlash");
  if (!raw) return;

  localStorage.removeItem("authFlash");

  try {
    const flash = JSON.parse(raw);
    if (flash?.message) {
      showAuthAlert(flash.message, flash.tone || "info");
    }
  } catch {
    // Ignore malformed flash payloads.
  }
}

function setFormBusy(form, isBusy, busyLabel = "Please wait...") {
  if (!form) return;

  const submitButton = form.querySelector('button[type="submit"]');
  if (!submitButton) return;

  if (!submitButton.dataset.defaultLabel) {
    submitButton.dataset.defaultLabel = submitButton.innerHTML;
  }

  submitButton.disabled = isBusy;
  submitButton.innerHTML = isBusy
    ? `<span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>${busyLabel}`
    : submitButton.dataset.defaultLabel;
}

function setVerificationPanelVisible(isVisible) {
  verificationPanel?.classList.toggle("d-none", !isVisible);
}

function setVerificationCopy(user, role = "", source = "login") {
  if (!verificationTitle || !verificationText || !verificationEmail) return;

  const roleLabel = role ? `${role[0].toUpperCase()}${role.slice(1)}` : "Account";
  const email = user?.email || "your inbox";

  verificationTitle.textContent =
    source === "signup" ? "Verify your email to activate the account" : "Email verification required";
  verificationText.textContent =
    source === "signup"
      ? `${roleLabel} access is locked until this email is verified. Open the verification mail, finish the check, then come back here.`
      : `${roleLabel} dashboard access stays blocked until this email is verified. Use the buttons below after you open the verification mail.`;
  verificationEmail.textContent = email;
}

function updateResendButtonState() {
  if (!resendVerificationBtn) return;

  const secondsLeft = Math.max(0, Math.ceil((resendCooldownUntil - Date.now()) / 1000));
  resendVerificationBtn.disabled = secondsLeft > 0;
  resendVerificationBtn.textContent =
    secondsLeft > 0 ? `Resend Email (${secondsLeft}s)` : "Resend Email";

  if (secondsLeft <= 0 && resendCooldownTimer) {
    clearInterval(resendCooldownTimer);
    resendCooldownTimer = null;
  }
}

function startResendCooldown(durationMs = 30000) {
  resendCooldownUntil = Date.now() + durationMs;
  updateResendButtonState();

  if (resendCooldownTimer) {
    clearInterval(resendCooldownTimer);
  }

  resendCooldownTimer = window.setInterval(updateResendButtonState, 1000);
}

async function updateVerificationFields(user, extra = {}) {
  if (!user?.uid) return null;

  const userRef = doc(db, "users", user.uid);
  const userSnap = await getDoc(userRef);
  if (!userSnap.exists()) return null;

  const patch = {
    emailVerified: Boolean(user.emailVerified),
    ...extra,
  };

  if (user.emailVerified && !userSnap.data().emailVerifiedAt) {
    patch.emailVerifiedAt = Date.now();
  }

  await updateDoc(userRef, patch).catch(() => {});
  return { ref: userRef, snap: userSnap };
}

async function sendVerificationEmail(user) {
  if (!user) {
    throw new Error("Please sign in first so we can send the verification email.");
  }

  await sendEmailVerification(user);
  await updateVerificationFields(user, {
    emailVerificationSentAt: Date.now(),
  });
  startResendCooldown();
}

function formatAuthError(error, fallbackMessage) {
  switch (error.code) {
    case "auth/email-already-in-use":
      return "This email is already registered. Please sign in instead.";
    case "auth/invalid-email":
      return "Please enter a valid email.";
    case "auth/weak-password":
      return "Password should be at least 6 characters.";
    case "auth/user-not-found":
    case "auth/invalid-credential":
      return "User not found. Please create an account first.";
    case "auth/wrong-password":
      return "Incorrect password.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a moment and try again.";
    default:
      return fallbackMessage || error.message;
  }
}

async function redirectForRole(role) {
  if (role === "student") {
    window.location.href = "student.html";
    return;
  }

  window.location.href = "teacher.html";
}

function buildStudentProfile() {
  return {
    name: document.getElementById("studentName").value.trim(),
    email: document.getElementById("studentEmail").value.trim().toLowerCase(),
    role: "student",
    yearOfStudy: document.getElementById("studentYear").value,
    department: document.getElementById("studentDepartment").value,
    section: document.getElementById("studentSection").value.trim().toUpperCase(),
    rollNumber: document.getElementById("studentRollNumber").value.trim().toUpperCase(),
    groupIds: [],
    emailVerified: false,
    emailVerificationSentAt: null,
    emailVerifiedAt: null,
  };
}

function buildTeacherProfile() {
  return {
    name: document.getElementById("teacherName").value.trim(),
    email: document.getElementById("teacherEmail").value.trim().toLowerCase(),
    role: "teacher",
    department: document.getElementById("teacherDepartment").value,
    groupIds: [],
    emailVerified: false,
    emailVerificationSentAt: null,
    emailVerifiedAt: null,
  };
}

async function openVerificationGate(user, role, source = "login") {
  activeVerificationRole = role || "";
  setVerificationCopy(user, role, source);
  setVerificationPanelVisible(true);
}

function closeVerificationGate() {
  activeVerificationRole = "";
  setVerificationPanelVisible(false);
}

async function createAccount(profile, password, form) {
  authFlowBusy = true;
  setFormBusy(form, true, "Creating Account...");
  hideAuthAlert();

  try {
    const userCredential = await createUserWithEmailAndPassword(
      auth,
      profile.email,
      password
    );
    const user = userCredential.user;
    const sentAt = Date.now();

    await setDoc(doc(db, "users", user.uid), {
      ...profile,
      emailVerified: Boolean(user.emailVerified),
      emailVerificationSentAt: sentAt,
      emailVerifiedAt: null,
    });

    await sendVerificationEmail(user);
    showAuthAlert(
      `Verification email sent to ${profile.email}. Verify it before entering the dashboard.`,
      "success"
    );
    await openVerificationGate(user, profile.role, "signup");
  } catch (error) {
    showAuthAlert(formatAuthError(error, "Unable to create your account."), "danger");
  } finally {
    authFlowBusy = false;
    setFormBusy(form, false);
  }
}

async function handleVerifiedSession(user, role) {
  closeVerificationGate();
  await updateVerificationFields(user, {
    emailVerified: true,
  });
  await redirectForRole(role);
}

async function handleUnverifiedSession(user, role, source = "login", shouldSend = false) {
  await openVerificationGate(user, role, source);

  if (shouldSend) {
    try {
      await sendVerificationEmail(user);
      showAuthAlert(
        `Your email is not verified yet. A verification email has been sent to ${user.email}.`,
        "warning"
      );
    } catch (error) {
      showAuthAlert(
        formatAuthError(error, "We could not send the verification email right now."),
        "danger"
      );
    }
    return;
  }

  showAuthAlert(
    `Verify ${user.email} before opening the dashboard.`,
    "warning"
  );
}

studentSignupForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!studentSignupForm.checkValidity()) {
    studentSignupForm.classList.add("was-validated");
    return;
  }

  await createAccount(
    buildStudentProfile(),
    document.getElementById("studentPassword").value,
    studentSignupForm
  );
});

teacherSignupForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!teacherSignupForm.checkValidity()) {
    teacherSignupForm.classList.add("was-validated");
    return;
  }

  await createAccount(
    buildTeacherProfile(),
    document.getElementById("teacherPassword").value,
    teacherSignupForm
  );
});

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!loginForm.checkValidity()) {
    loginForm.classList.add("was-validated");
    return;
  }

  const email = document.getElementById("loginIdentifier").value.trim().toLowerCase();
  const password = document.getElementById("loginPassword").value;
  const selectedRole = document.getElementById("loginRole").value;

  authFlowBusy = true;
  setFormBusy(loginForm, true, "Signing In...");
  hideAuthAlert();

  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    await reload(userCredential.user);

    const user = auth.currentUser || userCredential.user;
    const userSnap = await getDoc(doc(db, "users", user.uid));

    if (!userSnap.exists()) {
      await signOut(auth);
      showAuthAlert("User data not found.", "danger");
      return;
    }

    const role = userSnap.data().role;

    if (selectedRole && selectedRole !== role) {
      await signOut(auth);
      showAuthAlert(
        `This account is registered as a ${role}. Please choose the correct role.`,
        "warning"
      );
      return;
    }

    if (!user.emailVerified) {
      await handleUnverifiedSession(user, role, "login", true);
      return;
    }

    await handleVerifiedSession(user, role);
  } catch (error) {
    showAuthAlert(formatAuthError(error, "Login failed."), "danger");
  } finally {
    authFlowBusy = false;
    setFormBusy(loginForm, false);
  }
});

resendVerificationBtn?.addEventListener("click", async () => {
  if (!auth.currentUser) {
    showAuthAlert("Sign in first so we know which account to verify.", "warning");
    return;
  }

  try {
    await sendVerificationEmail(auth.currentUser);
    showAuthAlert(
      `Verification email sent again to ${auth.currentUser.email}.`,
      "success"
    );
  } catch (error) {
    showAuthAlert(
      formatAuthError(error, "Unable to resend the verification email."),
      "danger"
    );
  }
});

refreshVerificationBtn?.addEventListener("click", async () => {
  if (!auth.currentUser) {
    showAuthAlert("Sign in again to continue.", "warning");
    return;
  }

  try {
    await reload(auth.currentUser);
    const user = auth.currentUser;
    if (!user) {
      showAuthAlert("Your session ended. Please sign in again.", "warning");
      return;
    }

    const userSnap = await getDoc(doc(db, "users", user.uid));
    if (!userSnap.exists()) {
      await signOut(auth);
      showAuthAlert("User data not found.", "danger");
      return;
    }

    if (!user.emailVerified) {
      showAuthAlert(
        `We still do not see a verified email for ${user.email}. Open the verification mail first, then try again.`,
        "warning"
      );
      return;
    }

    await handleVerifiedSession(user, userSnap.data().role);
  } catch (error) {
    showAuthAlert(
      formatAuthError(error, "Unable to refresh your verification status."),
      "danger"
    );
  }
});

verificationSignOutBtn?.addEventListener("click", async () => {
  await signOut(auth).catch(() => {});
  closeVerificationGate();
  showAuthAlert("Signed out. You can switch to another account now.", "info");
});

consumeAuthFlash();
updateResendButtonState();

onAuthStateChanged(auth, async (user) => {
  if (authFlowBusy) return;

  if (!user) {
    closeVerificationGate();
    return;
  }

  try {
    await reload(user);
    const currentUser = auth.currentUser || user;
    const userSnap = await getDoc(doc(db, "users", currentUser.uid));

    if (!userSnap.exists()) {
      await signOut(auth);
      queueAuthFlash("User data missing. Please sign in again.", "danger");
      return;
    }

    const role = userSnap.data().role;

    if (!currentUser.emailVerified) {
      await handleUnverifiedSession(currentUser, role, "resume", false);
      return;
    }

    await handleVerifiedSession(currentUser, role);
  } catch (error) {
    showAuthAlert(
      formatAuthError(error, "We could not finish checking your account."),
      "danger"
    );
  }
});
