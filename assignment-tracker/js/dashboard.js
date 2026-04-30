import { auth, db } from "./firebase.js";
import {
  buildStoredPdfRecord,
  deleteStoredFile,
  describePdfUploadRules,
  formatFirebaseUploadError,
  uploadPdfFile,
  validatePdfFile,
} from "./file-storage.js";
import {
  buildGroupChatKey,
  buildThreadKey,
  escapeHtml,
  fmtDate,
  fmtDateTime,
  formatRelativeTime,
  getInitials,
  initThemeToggle,
  normalizeIdentifier,
  toTime,
} from "./dashboard-common.js";

import {
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";

import {
  addDoc,
  collection,
  doc as fsDoc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";

(() => {
  initThemeToggle();

  const submissionUploadRuleText = describePdfUploadRules();
  const submissionUploadHint = document.querySelector(
    "#submissionPdfFile ~ .form-text"
  );
  if (submissionUploadHint) {
    submissionUploadHint.textContent = submissionUploadRuleText;
  }

  let currentUser = null;
  let studentProfile = null;
  let groupRecord = null;

  let studentActiveGroupIds = []; // Tracks all groups the student is currently in
  let assignmentsCache = [];
  let submissionsCache = [];
  let teacherProfilesCache = new Map();
  let notificationsCache = [];
  let chatThreadsCache = [];
  let activeChatMessages = [];

  let activeChatTeacherId = "";
  let activeChatMode = "group";
  let activeGroupChatId = "";
  let activeChatThreadId = "";
  let pendingSubmissionAssignmentId = "";

  let userProfileUnsub = null;
  let groupDocUnsub = null;
  let assignmentsUnsub = null;
  let submissionsUnsub = null;
  let notificationsUnsub = null;
  let chatThreadsUnsub = null;
  let activeChatMessagesUnsub = null;

  const PAGE_META = {
    dashboard: {
      title: "Dashboard",
      sub: "Welcome back, here is your study overview",
    },
    assignments: {
      title: "Assignments",
      sub: "Manage and submit your assignments",
    },
    status: {
      title: "Status",
      sub: "Track your submission progress",
    },
    chat: {
      title: "Chat",
      sub: "Stay connected with your teachers",
    },
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => document.querySelectorAll(selector);

  function formatFileSize(size) {
    const bytes = Number(size || 0);
    if (!bytes) return "0 KB";
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    return `${Math.max(bytes / 1024, 0.1).toFixed(1)} KB`;
  }

  function showToast(message) {
    $("#toastBody").textContent = message;
    bootstrap.Toast.getOrCreateInstance($("#actionToast")).show();
  }

  function currentIdentifiers() {
    return [
      ...new Set(
        [studentProfile?.email, currentUser?.email, studentProfile?.rollNumber]
          .map((value) => normalizeIdentifier(value))
          .filter(Boolean)
      ),
    ];
  }

  function submissionIdentityKeys(submission) {
    return [
      submission?.studentId,
      submission?.submittedByEmail,
    ]
      .map((value) => normalizeIdentifier(value))
      .filter(Boolean);
  }

  function matchesCurrentStudentSubmission(submission, extraIdentifiers = []) {
    if (!submission) return false;
    if (currentUser?.uid && submission.submittedByUid === currentUser.uid) {
      return true;
    }

    const identifiers = new Set(
      [...currentIdentifiers(), ...extraIdentifiers]
        .map((value) => normalizeIdentifier(value))
        .filter(Boolean)
    );

    if (!identifiers.size) return false;

    return submissionIdentityKeys(submission).some((value) => identifiers.has(value));
  }

  function pickLatestSubmission(submissions) {
    return [...submissions].sort((a, b) => {
      const submittedDiff =
        Number(b.status === "submitted") - Number(a.status === "submitted");
      if (submittedDiff !== 0) return submittedDiff;
      return toTime(b.updatedAt) - toTime(a.updatedAt);
    })[0] || null;
  }

  function upsertSubmissionCache(submission) {
    if (!submission?.id) return;

    submissionsCache = [
      submission,
      ...submissionsCache.filter((item) => item.id !== submission.id),
    ].sort((a, b) => toTime(b.updatedAt) - toTime(a.updatedAt));
  }

  async function resolveAssignmentStudentIdentifier(assignment) {
    const identifiers = new Set(currentIdentifiers());
    if (!identifiers.size) return "";

    const localMatch =
      (groupRecord?.id === assignment?.groupId ? groupRecord?.studentIds : [])
        ?.find((studentId) => identifiers.has(normalizeIdentifier(studentId))) || "";

    if (localMatch) return localMatch;

    if (assignment?.groupId) {
      const groupSnap = await getDoc(fsDoc(db, "groups", assignment.groupId));
      if (groupSnap.exists()) {
        const matchedGroupIdentifier = (groupSnap.data().studentIds || []).find(
          (studentId) => identifiers.has(normalizeIdentifier(studentId))
        );

        if (matchedGroupIdentifier) return matchedGroupIdentifier;
      }
    }

    return normalizeIdentifier(
      studentProfile?.email ||
        currentUser?.email ||
        studentProfile?.rollNumber ||
        ""
    );
  }

  async function ensureSubmissionRecord(assignment) {
    const matchedIdentifier = await resolveAssignmentStudentIdentifier(assignment);

    let submission = submissionForAssignment(
      assignment.id,
      matchedIdentifier ? [matchedIdentifier] : []
    );
    if (submission) return submission;

    const existingSnap = await getDocs(
      query(collection(db, "submissions"), where("assignmentId", "==", assignment.id))
    );

    submission = pickLatestSubmission(
      existingSnap.docs
        .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
        .filter((item) =>
          matchesCurrentStudentSubmission(
            item,
            matchedIdentifier ? [matchedIdentifier] : []
          )
        )
    );

    if (submission) {
      upsertSubmissionCache(submission);
      return submission;
    }

    if (!matchedIdentifier) {
      throw new Error(
        "Your student record is not linked to this assignment group yet. Please ask your teacher to verify the group student list."
      );
    }

    const submissionRef = fsDoc(collection(db, "submissions"));
    const createdAt = Date.now();

    submission = {
      id: submissionRef.id,
      assignmentId: assignment.id,
      teacherId: assignment.createdBy || groupRecord?.teacherId || "",
      groupId: assignment.groupId,
      studentId: matchedIdentifier,
      status: "pending",
      submittedAt: null,
      reviewChecked: false,
      marks: null,
      fileUrl: "",
      fileName: "",
      fileSize: 0,
      fileType: "",
      storagePath: "",
      submissionFile: null,
      submittedByUid: "",
      submittedByEmail: "",
      createdAt,
      updatedAt: createdAt,
    };

    await setDoc(submissionRef, {
      assignmentId: submission.assignmentId,
      teacherId: submission.teacherId,
      groupId: submission.groupId,
      studentId: submission.studentId,
      status: submission.status,
      submittedAt: submission.submittedAt,
      reviewChecked: submission.reviewChecked,
      marks: submission.marks,
      fileUrl: submission.fileUrl,
      fileName: submission.fileName,
      fileSize: submission.fileSize,
      fileType: submission.fileType,
      storagePath: submission.storagePath,
      submissionFile: submission.submissionFile,
      submittedByUid: submission.submittedByUid,
      submittedByEmail: submission.submittedByEmail,
      createdAt: submission.createdAt,
      updatedAt: submission.updatedAt,
    });

    upsertSubmissionCache(submission);
    return submission;
  }

  function setSubmissionFormBusy(isBusy, progressPercent = null) {
    const submitButton = $("#submitAssignmentForm button[type=\"submit\"]");
    const fileInput = $("#submissionPdfFile");
    const helperText = $("#submissionPdfFile")?.closest(".mb-3")?.querySelector(".form-text");
    const progressWrap = $("#submissionUploadProgressWrap");
    const progressBar = $("#submissionUploadProgressBar");

    if (submitButton) {
      submitButton.disabled = isBusy;
      submitButton.innerHTML = isBusy
        ? `<span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Uploading${
            Number.isFinite(progressPercent) ? ` ${progressPercent}%` : "..."
          }`
        : '<i class="bi bi-upload me-1"></i> Upload Submission';
    }

    if (fileInput) {
      fileInput.disabled = isBusy;
    }

    if (helperText) {
      helperText.textContent = isBusy
        ? `Uploading to Firebase Storage${
            Number.isFinite(progressPercent) ? `: ${progressPercent}%` : "..."
          }`
        : submissionUploadRuleText;
    }

    if (progressWrap && progressBar) {
      progressWrap.classList.toggle("d-none", !isBusy);
      const safeProgress = Number.isFinite(progressPercent) ? progressPercent : 0;
      progressBar.style.width = `${safeProgress}%`;
      progressBar.setAttribute("aria-valuenow", String(safeProgress));
    }
  }

  function closeSidebar() {
    $("#sidebar")?.classList.remove("show");
    $("#sidebarBackdrop")?.classList.remove("show");
  }

  function pageFromHash() {
    const page = (location.hash || "#dashboard").slice(1);
    return PAGE_META[page] ? page : "dashboard";
  }

  function daysUntil(value) {
    const target = new Date(value);
    const ms =
      target.setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0);
    return Math.round(ms / 86400000);
  }

  function isPastDeadline(value) {
    return daysUntil(value) < 0;
  }

  function teacherById(id) {
    return teacherProfilesCache.get(id) || null;
  }

  function teacherContacts() {
    const uniqueTeacherIds = new Set();

    if (groupRecord?.teacherId) uniqueTeacherIds.add(groupRecord.teacherId);
    assignmentsCache.forEach((assignment) => {
      if (assignment.createdBy) uniqueTeacherIds.add(assignment.createdBy);
    });

    return [...uniqueTeacherIds]
      .map((id) => {
        const profile = teacherById(id);
        if (!profile) return null;

        return {
          id,
          name: profile.name || profile.email || "Teacher",
          email: profile.email || "—",
          department: profile.department || "Faculty",
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function assignmentById(id) {
    return assignmentsCache.find((assignment) => assignment.id === id) || null;
  }

  function submissionForAssignment(assignmentId, extraIdentifiers = []) {
    return pickLatestSubmission(
      submissionsCache.filter(
        (submission) =>
          submission.assignmentId === assignmentId &&
          matchesCurrentStudentSubmission(submission, extraIdentifiers)
      )
    );
  }

  function submissionFileLink(submission) {
    const file = submission?.submissionFile || null;
    const url = file?.url || submission?.fileUrl || "";
    const name = file?.name || submission?.fileName || "Submission PDF";
    const size = file?.size ?? submission?.fileSize ?? 0;

    if (!url) return "";

    return `
      <a
        href="${escapeHtml(url)}"
        target="_blank"
        rel="noopener noreferrer"
        class="card-link"
        title="${escapeHtml(formatFileSize(size))}"
      >
        <i class="bi bi-file-earmark-pdf-fill"></i>
        ${escapeHtml(name)}
      </a>
    `;
  }

  function teacherAttachmentLink(assignment) {
    const attachment = assignment?.attachment || null;
    const url = attachment?.url || assignment?.attachmentUrl || "";
    const name = attachment?.name || assignment?.attachmentName || "Assignment PDF";
    const size = attachment?.size ?? assignment?.attachmentSize ?? 0;

    if (!url) return "";

    return `
      <a
        href="${escapeHtml(url)}"
        target="_blank"
        rel="noopener noreferrer"
        class="card-link"
        title="${escapeHtml(formatFileSize(size))}"
      >
        <i class="bi bi-paperclip"></i>
        ${escapeHtml(name)}
      </a>
    `;
  }

  function assignmentStatusMeta(assignment) {
    const submission = submissionForAssignment(assignment.id);

    if (submission?.status === "submitted") {
      const late =
        submission.submittedAt &&
        new Date(submission.submittedAt).getTime() >
          new Date(`${assignment.deadline}T23:59:59`).getTime();

      return late
        ? {
            kind: "submitted",
            label: "Submitted late",
            icon: "bi-check-circle-fill",
            progress: 100,
          }
        : {
            kind: "submitted",
            label: "Submitted",
            icon: "bi-check-circle-fill",
            progress: 100,
          };
    }

    const dueInDays = daysUntil(assignment.deadline);

    if (dueInDays < 0) {
      return {
        kind: "overdue",
        label: "Overdue",
        icon: "bi-exclamation-triangle-fill",
        progress: 10,
      };
    }

    if (dueInDays <= 2) {
      return {
        kind: "upcoming",
        label: dueInDays === 0 ? "Due today" : `Due in ${dueInDays}d`,
        icon: "bi-clock-fill",
        progress: 72,
      };
    }

    return {
      kind: "pending",
      label: "Pending",
      icon: "bi-hourglass-split",
      progress: 48,
    };
  }

  function studentDisplayName() {
    return studentProfile?.name || currentUser?.email || "Student";
  }

  function studentMetaLine() {
    const parts = [
      studentProfile?.rollNumber,
      studentProfile?.yearOfStudy,
      studentProfile?.department,
    ].filter(Boolean);
    return parts.join(" • ") || "Student";
  }

  function setStudentHeader() {
    $("#studentAvatar").textContent = getInitials(studentDisplayName(), "ST");
    $("#studentProfileName").textContent = studentDisplayName();
    $("#studentProfileMeta").textContent = studentMetaLine();
  }

  function renderStudentProfileModal() {
    const hero = $("#studentProfileHero");
    const view = $("#studentProfileView");
    if (!hero || !view) return;

    hero.innerHTML = `
      <div class="profile-modal-avatar">${escapeHtml(getInitials(studentDisplayName(), "ST"))}</div>
      <div>
        <div class="profile-modal-title">${escapeHtml(studentDisplayName())}</div>
        <div class="profile-modal-copy">${escapeHtml(studentProfile?.email || currentUser?.email || "—")}</div>
        <div class="profile-modal-copy">${escapeHtml(studentMetaLine())}</div>
      </div>
    `;

    view.innerHTML = `
      <div class="profile-modal-item">
        <span>Full Name</span>
        <strong>${escapeHtml(studentProfile?.name || "—")}</strong>
      </div>
      <div class="profile-modal-item">
        <span>Email</span>
        <strong>${escapeHtml(studentProfile?.email || currentUser?.email || "—")}</strong>
      </div>
      <div class="profile-modal-item">
        <span>Roll Number</span>
        <strong>${escapeHtml(studentProfile?.rollNumber || "—")}</strong>
      </div>
      <div class="profile-modal-item">
        <span>Section</span>
        <strong>${escapeHtml(studentProfile?.section || "—")}</strong>
      </div>
      <div class="profile-modal-item">
        <span>Year of Study</span>
        <strong>${escapeHtml(studentProfile?.yearOfStudy || "—")}</strong>
      </div>
      <div class="profile-modal-item">
        <span>Department</span>
        <strong>${escapeHtml(studentProfile?.department || "—")}</strong>
      </div>
      <div class="profile-modal-item">
        <span>Groups Enrolled</span>
        <strong>${escapeHtml(studentActiveGroupIds.length ? studentActiveGroupIds.length + " Groups" : "Not assigned")}</strong>
      </div>
    `;

    $("#studentProfileEditName").value = studentProfile?.name || "";
    $("#studentProfileEditRollNumber").value = studentProfile?.rollNumber || "";
    $("#studentProfileEditSection").value = studentProfile?.section || "";
    $("#studentProfileEditYear").value = studentProfile?.yearOfStudy || "";
    $("#studentProfileEditDepartment").value = studentProfile?.department || "";
    $("#studentProfileEditEmail").value = studentProfile?.email || currentUser?.email || "";
  }

  function setStudentProfileModalMode(mode = "view") {
    const isEdit = mode === "edit";
    $("#studentProfileModalTitle").textContent = isEdit
      ? "Edit Student Profile"
      : "Student Profile";
    $("#studentProfileModalSub").textContent = isEdit
      ? "Update your student profile details"
      : "View your profile details";
    $("#studentProfileView").classList.toggle("d-none", isEdit);
    $("#studentProfileForm").classList.toggle("d-none", !isEdit);
    $("#studentProfileForm").classList.remove("was-validated");
    $("#studentProfileEditBtn").classList.toggle("d-none", isEdit);
    $("#studentProfileSaveBtn").classList.toggle("d-none", !isEdit);
    $("#studentProfileCloseBtn").textContent = isEdit ? "Cancel" : "Close";
  }

  function openStudentProfileModal(mode = "view") {
    renderStudentProfileModal();
    setStudentProfileModalMode(mode);
    bootstrap.Modal.getOrCreateInstance($("#studentProfileModal")).show();
  }

  function cardHtml(assignment) {
    const status = assignmentStatusMeta(assignment);
    const submission = submissionForAssignment(assignment.id);
    const marks =
      submission?.marks !== null && submission?.marks !== undefined && submission?.marks !== ""
        ? submission.marks
        : null;

    const teacherProfile = teacherById(assignment.createdBy);
    const teacherName = teacherProfile?.name || teacherProfile?.email || "Teacher";
    const groupName = assignment.groupName || "Class Group";

    return `
      <div class="col-12 col-md-6 col-xl-4">
        <article class="assignment-card status-${status.kind}">
          <div class="card-head">
            <h6 class="card-title">${escapeHtml(assignment.title)}</h6>
            <span class="status-badge ${status.kind}">
              <i class="bi ${status.icon}"></i> ${escapeHtml(status.label)}
            </span>
          </div>
          <span class="card-subject">
            <i class="bi bi-bookmark-fill"></i> ${escapeHtml(assignment.subject || "General")}
          </span>
          <div class="small text-muted mb-3" style="line-height: 1.6;">
            <div><i class="bi bi-person-badge text-primary"></i> Assigned by: <strong>${escapeHtml(teacherName)}</strong></div>
            <div><i class="bi bi-people text-primary"></i> Group: <strong>${escapeHtml(groupName)}</strong></div>
          </div>
          <div class="card-dates">
            <div class="row-line">
              <i class="bi bi-calendar-event"></i>
              <span>Opened: <strong>${fmtDate(assignment.openDate)}</strong></span>
            </div>
            <div class="row-line">
              <i class="bi bi-calendar-x"></i>
              <span>Deadline: <strong>${fmtDate(assignment.deadline)}</strong></span>
            </div>
          </div>
          ${
            assignment.description
              ? `<div class="card-description">${escapeHtml(assignment.description)}</div>`
              : ""
          }
          <div class="card-meta-stack">
            ${teacherAttachmentLink(assignment)}
            ${submissionFileLink(submission)}
            ${
              submission?.reviewChecked
                ? `<span class="file-chip"><i class="bi bi-check2-square"></i> Checked</span>`
                : ""
            }
            ${
              marks != null
                ? `<span class="file-chip"><i class="bi bi-award"></i> Marks: ${escapeHtml(marks)}</span>`
                : ""
            }
          </div>
          <div class="card-progress">
            <div class="meta">
              <span>Progress</span>
              <span>${status.progress}%</span>
            </div>
            <div class="progress">
              <div
                class="progress-bar"
                style="width:${status.progress}%; background: linear-gradient(90deg, var(--primary), #7c8cff);"
              ></div>
            </div>
          </div>
          <div class="card-actions">
            ${
              status.kind === "submitted"
                ? `<button type="button" class="btn-submitted"><i class="bi bi-check2-circle"></i> Submitted</button>`
                : `<button type="button" class="btn-submit" data-submit="${assignment.id}"><i class="bi bi-upload me-1"></i> Submit</button>`
            }
          </div>
        </article>
      </div>
    `;
  }

  function renderDashboard() {
    const allAssignments = [...assignmentsCache]
      .sort((a, b) => toTime(a.deadline) - toTime(b.deadline));

    $("#dashboardGrid").innerHTML = allAssignments.map(cardHtml).join("");
  }

  function activeFilter() {
    return $(".btn-filter.active")?.dataset.filter || "all";
  }

  function renderAssignments() {
    const grid = $("#assignmentsGrid");
    const empty = $("#emptyState");
    const filter = activeFilter();
    const queryValue = ($("#searchInput").value || "").trim().toLowerCase();

    const filtered = assignmentsCache.filter((assignment) => {
      const status = assignmentStatusMeta(assignment).kind;
      const matchesFilter =
        filter === "all" ||
        (filter === "submitted" && status === "submitted") ||
        (filter === "overdue" && status === "overdue") ||
        (filter === "upcoming" && status === "upcoming") ||
        (filter === "pending" && (status === "pending" || status === "upcoming"));

      const matchesSearch =
        !queryValue ||
        assignment.title.toLowerCase().includes(queryValue) ||
        (assignment.subject || "").toLowerCase().includes(queryValue);

      return matchesFilter && matchesSearch;
    });

    grid.innerHTML = filtered.map(cardHtml).join("");
    empty.classList.toggle("d-none", filtered.length !== 0);
  }

  function renderStatus() {
    const total = assignmentsCache.length;
    const submitted = assignmentsCache.filter(
      (assignment) => assignmentStatusMeta(assignment).kind === "submitted"
    ).length;
    const overdue = assignmentsCache.filter(
      (assignment) => assignmentStatusMeta(assignment).kind === "overdue"
    ).length;
    const pending = total - submitted;

    const percentage = (value) =>
      total ? Math.round((value / total) * 100) : 0;

    $("#barSubmitted").style.width = `${percentage(submitted)}%`;
    $("#barPending").style.width = `${percentage(pending)}%`;
    $("#barOverdue").style.width = `${percentage(overdue)}%`;

    const completion = percentage(submitted);
    $("#barCompletion").style.width = `${completion}%`;
    $("#completionPct").textContent = `${completion}%`;

    $("#statusTableBody").innerHTML = assignmentsCache
      .sort((a, b) => toTime(a.deadline) - toTime(b.deadline))
      .map((assignment) => {
        const status = assignmentStatusMeta(assignment);
        const barColor =
          status.kind === "submitted"
            ? "success"
            : status.kind === "overdue"
            ? "danger"
            : status.kind === "upcoming"
            ? "warning"
            : "primary";

        return `
          <tr>
            <td><strong>${escapeHtml(assignment.title)}</strong></td>
            <td class="d-none d-md-table-cell text-muted">${escapeHtml(assignment.subject || "General")}</td>
            <td class="d-none d-md-table-cell text-muted">${fmtDate(assignment.deadline)}</td>
            <td>
              <div class="d-flex align-items-center gap-2">
                <div class="progress flex-grow-1">
                  <div class="progress-bar bg-${barColor}" style="width:${status.progress}%"></div>
                </div>
                <small class="text-muted">${status.progress}%</small>
              </div>
            </td>
            <td>
              <span class="status-badge ${status.kind}">
                <i class="bi ${status.icon}"></i> ${escapeHtml(status.label)}
              </span>
              ${
                submissionForAssignment(assignment.id)?.marks !== null &&
                submissionForAssignment(assignment.id)?.marks !== undefined
                  ? `<div class="small text-muted mt-1">Marks: ${escapeHtml(
                      submissionForAssignment(assignment.id).marks
                    )}</div>`
                  : ""
              }
            </td>
          </tr>
        `;
      })
      .join("");
  }

  function updateGlobalStats() {
    let pending = 0;
    let submitted = 0;
    let overdue = 0;
    let dueTomorrow = 0;

    assignmentsCache.forEach((assignment) => {
      const status = assignmentStatusMeta(assignment).kind;

      if (status === "submitted") {
        submitted += 1;
        return;
      }

      pending += 1;
      if (status === "overdue") overdue += 1;
      if (daysUntil(assignment.deadline) === 1) dueTomorrow += 1;
    });

    $$('[data-stat="total"]').forEach((node) => (node.textContent = assignmentsCache.length));
    $$('[data-stat="pending"]').forEach((node) => (node.textContent = pending));
    $$('[data-stat="submitted"]').forEach((node) => (node.textContent = submitted));
    $$('[data-stat="overdue"]').forEach((node) => (node.textContent = overdue));

    const banner = $("#notificationBanner");
    const headline = $("#bannerHeadline");
    const sub = $("#bannerSub");

    if (studentActiveGroupIds.length === 0) {
      headline.textContent = "You are not linked to a teacher group yet";
      sub.textContent = "Once your teacher adds you to a group, assignments and chat will appear here.";
      banner.classList.remove("alert-warning-soft");
      return;
    }

    headline.textContent = `You have ${pending} pending assignment${pending === 1 ? "" : "s"}`;

    const notes = [];
    if (overdue > 0) notes.push(`${overdue} overdue`);
    if (dueTomorrow > 0) {
      notes.push(`${dueTomorrow} assignment${dueTomorrow === 1 ? "" : "s"} due tomorrow`);
    }

    sub.textContent = notes.length ? notes.join(" • ") : "All caught up. Nice work!";
    banner.classList.toggle("alert-warning-soft", overdue > 0 || dueTomorrow > 0);
  }

  function renderNotifications() {
    const list = $("#notificationList");
    const empty = $("#notificationEmpty");

    const items = [...notificationsCache].sort(
      (a, b) => toTime(b.createdAt) - toTime(a.createdAt)
    );

    if (!items.length) {
      list.innerHTML = "";
      empty.classList.remove("d-none");
      return;
    }

    empty.classList.add("d-none");

    list.innerHTML = items
      .map(
        (notification) => `
          <button
            type="button"
            class="notification-item ${notification.isRead ? "" : "unread"}"
            data-notification-id="${notification.id}"
          >
            <div class="notification-head">
              <div class="notification-title">${escapeHtml(notification.title || "Update")}</div>
              ${notification.isRead ? "" : `<span class="chat-count">New</span>`}
            </div>
            <div class="notification-copy">${escapeHtml(notification.body || "")}</div>
            <div class="notification-time">${escapeHtml(formatRelativeTime(notification.createdAt))}</div>
          </button>
        `
      )
      .join("");
  }

  function updateNotificationBadge() {
    const unreadCount = notificationsCache.filter((item) => !item.isRead).length;
    $("#notificationBadge").classList.toggle("d-none", unreadCount === 0);
  }

  async function markNotificationRead(notificationId) {
    const notification = notificationsCache.find((item) => item.id === notificationId);
    if (!notification || notification.isRead) return;

    await updateDoc(fsDoc(db, "notifications", notificationId), {
      isRead: true,
      readAt: Date.now(),
    });
  }

  async function markAllNotificationsRead() {
    const unreadItems = notificationsCache.filter((item) => !item.isRead);
    if (!unreadItems.length) return;

    await Promise.all(
      unreadItems.map((notification) =>
        updateDoc(fsDoc(db, "notifications", notification.id), {
          isRead: true,
          readAt: Date.now(),
        })
      )
    );
  }

  function threadForTeacher(teacherId) {
    const threadId = buildThreadKey(currentUser?.uid, teacherId);
    return (
      chatThreadsCache.find(
        (thread) => thread.id === threadId && thread.type !== "group"
      ) || null
    );
  }

  function groupChatThreads() {
    return chatThreadsCache
      .filter((thread) => thread.type === "group" && thread.groupId)
      .sort((a, b) => toTime(b.updatedAt) - toTime(a.updatedAt));
  }

  function groupChatThreadByGroupId(groupId) {
    const threadId = buildGroupChatKey(groupId);
    return (
      chatThreadsCache.find(
        (thread) =>
          thread.id === threadId &&
          (thread.type === "group" || thread.groupId === groupId)
      ) || null
    );
  }

  function activeConversationThread() {
    return activeChatMode === "group"
      ? groupChatThreadByGroupId(activeGroupChatId)
      : threadForTeacher(activeChatTeacherId);
  }

  function groupChatUnreadCount(groupId) {
    const threadId = buildGroupChatKey(groupId);
    return notificationsCache.filter(
      (notification) =>
        !notification.isRead &&
        notification.type === "group-chat" &&
        notification.threadId === threadId
    ).length;
  }

  function ensureDefaultChatSelection() {
    if (activeChatMode === "group" && activeGroupChatId && activeConversationThread()) {
      return;
    }

    if (
      activeChatMode === "direct" &&
      activeChatTeacherId &&
      teacherById(activeChatTeacherId)
    ) {
      return;
    }

    const groups = groupChatThreads();
    if (groups.length) {
      activeChatMode = "group";
      activeGroupChatId = groups[0].groupId;
      activeChatTeacherId = "";
      return;
    }

    const contacts = teacherContacts();
    if (contacts.length) {
      activeChatMode = "direct";
      activeChatTeacherId = contacts[0].id;
      activeGroupChatId = "";
      return;
    }

    activeChatMode = "group";
    activeGroupChatId = "";
    activeChatTeacherId = "";
  }

  function renderChatMessageHtml(message, { showSender = false } = {}) {
    const mine = message.senderId === currentUser.uid;
    const senderLabel =
      showSender && !mine && message.senderName
        ? `<div class="chat-message-sender">${escapeHtml(message.senderName)}</div>`
        : "";

    return `
      <div class="chat-message-row ${mine ? "mine" : ""}">
        <div class="chat-message ${mine ? "mine" : "them"}">
          ${senderLabel}
          <div class="chat-message-copy">${escapeHtml(message.text)}</div>
          <span class="chat-message-time">${escapeHtml(fmtDateTime(message.createdAt))}</span>
        </div>
      </div>
    `;
  }

  async function watchTeacherProfiles() {
    const teacherIds = [
      ...new Set(
        [groupRecord?.teacherId, ...assignmentsCache.map((assignment) => assignment.createdBy)]
          .filter(Boolean)
      ),
    ];

    const nextMap = new Map();

    await Promise.all(
      teacherIds.map(async (teacherId) => {
        const snap = await getDoc(fsDoc(db, "users", teacherId));
        if (!snap.exists()) return;
        nextMap.set(teacherId, { id: snap.id, ...snap.data() });
      })
    );

    teacherProfilesCache = nextMap;
    ensureDefaultChatSelection();
    syncActiveChatThread();
    renderCurrentPage();
  }

  function renderChatContacts() {
    ensureDefaultChatSelection();

    const groups = groupChatThreads();
    const contacts = teacherContacts();
    const list = $("#chatContactsList");
    const empty = $("#chatContactsEmpty");

    if (!groups.length && !contacts.length) {
      list.innerHTML = "";
      empty.classList.remove("d-none");
      return;
    }

    empty.classList.add("d-none");

    const sections = [];

    if (groups.length) {
      sections.push(
        `<div class="chat-contact-section-label">Group Chats</div>${groups
          .map((thread) => {
            const unreadCount = groupChatUnreadCount(thread.groupId);

            return `
              <button
                type="button"
                class="chat-contact ${
                  activeChatMode === "group" && thread.groupId === activeGroupChatId
                    ? "active"
                    : ""
                }"
                data-chat-group="${thread.groupId}"
              >
                <div class="chat-avatar"><i class="bi bi-people-fill"></i></div>
                <div class="chat-contact-main">
                  <div class="chat-contact-top">
                    <span class="chat-contact-name">${escapeHtml(
                      thread.groupName || groupRecord?.groupName || "Group Chat"
                    )}</span>
                    <span class="chat-meta">${escapeHtml(
                      thread.updatedAt
                        ? formatRelativeTime(thread.updatedAt)
                        : "Group chat"
                    )}</span>
                  </div>
                  <div class="chat-contact-meta">${escapeHtml(
                    `${(thread.participants || []).length} members`
                  )}</div>
                  <div class="chat-snippet">${escapeHtml(
                    thread.lastMessage || "Group chat created for this class."
                  )}</div>
                </div>
                ${unreadCount ? `<span class="chat-count">${unreadCount}</span>` : ""}
              </button>
            `;
          })
          .join("")}`
      );
    }

    if (contacts.length) {
      sections.push(
        `<div class="chat-contact-section-label">Direct Messages</div>${contacts
          .map((teacher) => {
            const thread = threadForTeacher(teacher.id);
            const unreadCount = notificationsCache.filter(
              (notification) =>
                !notification.isRead &&
                notification.type === "chat" &&
                notification.partnerId === teacher.id
            ).length;

            return `
              <button
                type="button"
                class="chat-contact ${
                  activeChatMode === "direct" && teacher.id === activeChatTeacherId
                    ? "active"
                    : ""
                }"
                data-chat-partner="${teacher.id}"
              >
                <div class="chat-avatar">${escapeHtml(getInitials(teacher.name, "TC"))}</div>
                <div class="chat-contact-main">
                  <div class="chat-contact-top">
                    <span class="chat-contact-name">${escapeHtml(teacher.name)}</span>
                    <span class="chat-meta">${escapeHtml(
                      thread?.updatedAt
                        ? formatRelativeTime(thread.updatedAt)
                        : teacher.department
                    )}</span>
                  </div>
                  <div class="chat-contact-meta">${escapeHtml(teacher.department)}</div>
                  <div class="chat-snippet">${escapeHtml(
                    thread?.lastMessage || "Start the conversation here."
                  )}</div>
                </div>
                ${unreadCount ? `<span class="chat-count">${unreadCount}</span>` : ""}
              </button>
            `;
          })
          .join("")}`
      );
    }

    list.innerHTML = sections.join("");
  }

  function renderChatThread() {
    ensureDefaultChatSelection();

    const isGroupChat = activeChatMode === "group";
    const thread = activeConversationThread();
    const partner = isGroupChat ? null : teacherById(activeChatTeacherId);

    if (isGroupChat && thread) {
      $("#chatPartnerAvatar").innerHTML = '<i class="bi bi-people-fill"></i>';
      $("#chatPartnerName").textContent =
        thread.groupName || groupRecord?.groupName || "Group Chat";
      $("#chatPartnerMeta").textContent = [
        `${(thread.participants || []).length} members`,
        groupRecord?.groupName || "Class group",
      ]
        .filter(Boolean)
        .join(" • ");
    }

    if (isGroupChat && !thread) {
      $("#chatPartnerAvatar").textContent = "GC";
      $("#chatPartnerName").textContent = "Select a conversation";
      $("#chatPartnerMeta").textContent =
        "Open a group chat or teacher conversation to start chatting.";
      $("#chatMessages").classList.add("d-none");
      $("#chatForm").classList.add("d-none");
      $("#chatEmptyPanel").classList.remove("d-none");
      return;
    }

    if (!partner && !isGroupChat) {
      $("#chatPartnerAvatar").textContent = "TC";
      $("#chatPartnerName").textContent = "Select a teacher";
      $("#chatPartnerMeta").textContent = "Open a conversation to start chatting.";
      $("#chatMessages").classList.add("d-none");
      $("#chatForm").classList.add("d-none");
      $("#chatEmptyPanel").classList.remove("d-none");
      return;
    }

    if (!isGroupChat && partner) {
      $("#chatPartnerAvatar").textContent = getInitials(partner.name || partner.email, "TC");
      $("#chatPartnerName").textContent = partner.name || partner.email || "Teacher";
      $("#chatPartnerMeta").textContent = `${partner.department || "Faculty"} • ${partner.email || "Teacher account"}`;
    }

    $("#chatForm").classList.remove("d-none");
    $("#chatMessages").classList.remove("d-none");
    $("#chatEmptyPanel").classList.add("d-none");

    if (!activeChatMessages.length) {
      $("#chatMessages").innerHTML = `
        <div class="chat-thread-empty">
          <div>
            <i class="bi ${isGroupChat ? "bi-people-fill" : "bi-chat-heart"} fs-2 d-block mb-2"></i>
            <h6 class="mb-1">No messages yet</h6>
            <p class="mb-0 small">${
              isGroupChat
                ? `Send the first message to ${escapeHtml(
                    thread?.groupName || "this group"
                  )}.`
                : `Send the first message to ${escapeHtml(
                    partner?.name || "your teacher"
                  )}.`
            }</p>
          </div>
        </div>
      `;
      return;
    }

    $("#chatMessages").innerHTML = activeChatMessages
      .sort((a, b) => toTime(a.createdAt) - toTime(b.createdAt))
      .map((message) =>
        renderChatMessageHtml(message, {
          showSender: isGroupChat,
        })
      )
      .join("");

    $("#chatMessages").scrollTop = $("#chatMessages").scrollHeight;
  }

  function renderChatPage() {
    ensureDefaultChatSelection();
    renderChatContacts();
    renderChatThread();
  }

  function renderPage(page) {
    if (page === "dashboard") renderDashboard();
    if (page === "assignments") renderAssignments();
    if (page === "status") renderStatus();
    if (page === "chat") renderChatPage();
  }

  function showPage(page) {
    if (!PAGE_META[page]) return;

    $$(".page").forEach((section) => {
      section.classList.toggle("d-none", section.dataset.page !== page);
    });

    $$(".sidebar-nav .nav-item").forEach((item) => {
      item.classList.toggle("active", item.dataset.page === page);
    });

    $("#pageTitle").textContent = PAGE_META[page].title;
    $("#pageSub").textContent = PAGE_META[page].sub;

    renderPage(page);

    if (location.hash !== `#${page}`) {
      history.replaceState(null, "", `#${page}`);
    }

    window.scrollTo({ top: 0, behavior: "smooth" });
    closeSidebar();
  }

  function renderCurrentPage() {
    const page = pageFromHash();
    $("#pageTitle").textContent = PAGE_META[page].title;
    $("#pageSub").textContent = PAGE_META[page].sub;
    updateGlobalStats();
    renderNotifications();
    updateNotificationBadge();
    renderPage(page);
  }

  function syncActiveChatThread() {
    if (!currentUser?.uid) {
      activeChatThreadId = "";
      activeChatMessages = [];
      renderChatPage();
      return;
    }

    const thread = activeConversationThread();
    const expectedThreadId =
      activeChatMode === "group"
        ? buildGroupChatKey(activeGroupChatId)
        : buildThreadKey(currentUser.uid, activeChatTeacherId);

    if (!thread) {
      activeChatThreadId = expectedThreadId;
      activeChatMessages = [];
      if (activeChatMessagesUnsub) {
        activeChatMessagesUnsub();
        activeChatMessagesUnsub = null;
      }
      renderChatPage();
      return;
    }

    if (thread.id === activeChatThreadId && activeChatMessagesUnsub) {
      renderChatPage();
      return;
    }

    activeChatThreadId = thread.id;

    if (activeChatMessagesUnsub) activeChatMessagesUnsub();
    activeChatMessagesUnsub = onSnapshot(
      collection(db, "chatThreads", thread.id, "messages"),
      (snap) => {
        activeChatMessages = snap.docs
          .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
          .sort((a, b) => toTime(a.createdAt) - toTime(b.createdAt));
        renderChatPage();
      }
    );
  }

  async function openGroupChat(groupId, focusPage = false) {
    activeChatMode = "group";
    activeGroupChatId = groupId;
    activeChatTeacherId = "";
    syncActiveChatThread();

    await Promise.all(
      notificationsCache
        .filter(
          (notification) =>
            !notification.isRead &&
            notification.type === "group-chat" &&
            notification.threadId === buildGroupChatKey(groupId)
        )
        .map((notification) => markNotificationRead(notification.id))
    );

    if (focusPage) showPage("chat");
    else renderChatPage();
  }

  async function openChatWithTeacher(teacherId, focusPage = false) {
    activeChatMode = "direct";
    activeChatTeacherId = teacherId;
    activeGroupChatId = "";
    syncActiveChatThread();

    await Promise.all(
      notificationsCache
        .filter(
          (notification) =>
            !notification.isRead &&
            notification.type === "chat" &&
            notification.partnerId === teacherId
        )
        .map((notification) => markNotificationRead(notification.id))
    );

    if (focusPage) showPage("chat");
    else renderChatPage();
  }

  async function createNotification(payload) {
    if (!payload.userId) return;

    await addDoc(collection(db, "notifications"), {
      ...payload,
      createdAt: Date.now(),
      isRead: false,
    });
  }

  async function ensureChatThread(teacherId) {
    const threadId = buildThreadKey(currentUser.uid, teacherId);
    const existingThread = threadForTeacher(teacherId);

    if (existingThread) return existingThread;

    await setDoc(fsDoc(db, "chatThreads", threadId), {
      participantKey: threadId,
      participants: [currentUser.uid, teacherId],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastMessage: "",
      lastMessageSenderId: "",
      lastMessageSenderName: "",
    });

    return {
      id: threadId,
      participantKey: threadId,
      participants: [currentUser.uid, teacherId],
    };
  }

  async function notifyGroupChatParticipants(thread, text) {
    if (!thread?.id) return;

    await Promise.all(
      (thread.participants || [])
        .filter((userId) => userId && userId !== currentUser.uid)
        .map((userId) =>
          createNotification({
            userId,
            type: "group-chat",
            title: `New message in ${thread.groupName || "group chat"}`,
            body: `${studentDisplayName()}: ${text}`,
            page: "chat",
            threadId: thread.id,
            groupId: thread.groupId,
            partnerId: currentUser.uid,
          })
        )
    );
  }

  async function sendChatMessage(event) {
    event.preventDefault();

    const text = $("#chatMessageInput").value.trim();

    if (!text) return;

    if (activeChatMode === "group") {
      const thread = groupChatThreadByGroupId(activeGroupChatId);
      if (!thread) return;

      const createdAt = Date.now();

      await addDoc(collection(db, "chatThreads", thread.id, "messages"), {
        threadId: thread.id,
        senderId: currentUser.uid,
        senderName: studentDisplayName(),
        senderRole: "student",
        text,
        createdAt,
        groupId: thread.groupId,
        groupName: thread.groupName || groupRecord?.groupName || "",
      });

      await updateDoc(fsDoc(db, "chatThreads", thread.id), {
        updatedAt: createdAt,
        lastMessage: text,
        lastMessageSenderId: currentUser.uid,
        lastMessageSenderName: studentDisplayName(),
      });

      await notifyGroupChatParticipants(thread, text);

      $("#chatMessageInput").value = "";
      return;
    }

    const teacher = teacherById(activeChatTeacherId);
    if (!teacher) return;

    const thread = await ensureChatThread(teacher.id);
    const createdAt = Date.now();

    await addDoc(collection(db, "chatThreads", thread.id, "messages"), {
      threadId: thread.id,
      senderId: currentUser.uid,
      senderName: studentDisplayName(),
      senderRole: "student",
      receiverId: teacher.id,
      text,
      createdAt,
    });

    await updateDoc(fsDoc(db, "chatThreads", thread.id), {
      updatedAt: createdAt,
      lastMessage: text,
      lastMessageSenderId: currentUser.uid,
      lastMessageSenderName: studentDisplayName(),
    });

    await createNotification({
      userId: teacher.id,
      type: "chat",
      title: `New message from ${studentDisplayName()}`,
      body: text,
      page: "chat",
      partnerId: currentUser.uid,
      threadId: thread.id,
    });

    $("#chatMessageInput").value = "";
  }

  function openSubmissionModal(assignmentId) {
    const assignment = assignmentById(assignmentId);
    const submission = submissionForAssignment(assignmentId);
    const attachment = assignment?.attachment || null;
    const attachmentName = attachment?.name || assignment?.attachmentName || "";
    const attachmentUrl = attachment?.url || assignment?.attachmentUrl || "";

    if (!assignment) return;
    if (submission?.status === "submitted") {
      showToast(`"${assignment.title}" is already submitted.`);
      return;
    }

    pendingSubmissionAssignmentId = assignmentId;
    $("#submitAssignmentModalTitle").textContent = `Submit ${assignment.title}`;
    $("#submitAssignmentModalSub").textContent = "Upload your PDF so your teacher can review and mark it.";
    $("#submitAssignmentSummary").innerHTML = `
      <div class="selection-summary-head">
        <strong>${escapeHtml(assignment.title)}</strong>
        <span>${escapeHtml(assignment.subject || "General")}</span>
      </div>
      <div class="selection-summary-grid">
        <div><span>Deadline</span><strong>${fmtDate(assignment.deadline)}</strong></div>
        <div><span>Teacher File</span><strong>${attachmentName ? escapeHtml(attachmentName) : "None"}</strong></div>
      </div>
      ${
        attachmentUrl
          ? `<a href="${escapeHtml(attachmentUrl)}" target="_blank" rel="noopener noreferrer" class="card-link mt-3">
              <i class="bi bi-paperclip"></i> Open assignment PDF
            </a>`
          : ""
      }
    `;
    $("#submitAssignmentForm").classList.remove("was-validated");
    $("#submissionPdfFile").value = "";
    setSubmissionFormBusy(false);
    bootstrap.Modal.getOrCreateInstance($("#submitAssignmentModal")).show();
  }

  async function handleAssignmentSubmission(event) {
    event.preventDefault();
    event.stopPropagation();

    const form = event.currentTarget;
    const assignment = assignmentById(pendingSubmissionAssignmentId);
    const file = $("#submissionPdfFile").files?.[0] || null;
    const fileError = validatePdfFile(file);

    if (!form.checkValidity() || fileError) {
      form.classList.add("was-validated");
      if (fileError) alert(fileError);
      return;
    }

    if (!assignment) return;

    let uploadedStoragePath = "";
    let submissionSaved = false;

    try {
      setSubmissionFormBusy(true);

      let submission = await ensureSubmissionRecord(assignment);
      if (!submission) {
        throw new Error("Unable to prepare your submission record.");
      }

      if (submission.status === "submitted") {
        showToast(`"${assignment.title}" is already submitted.`);
        bootstrap.Modal.getInstance($("#submitAssignmentModal"))?.hide();
        return;
      }

      const upload = await uploadPdfFile(
        ["submissions", currentUser.uid, submission.id],
        file,
        {
          onProgress: (progressPercent) =>
            setSubmissionFormBusy(true, progressPercent),
        }
      );
      uploadedStoragePath = upload.storagePath;
      const submittedAt = Date.now();
      const submissionFile = buildStoredPdfRecord(upload, submittedAt);
      const submissionPatch = {
        status: "submitted",
        submittedAt,
        updatedAt: submittedAt,
        fileUrl: upload.downloadURL,
        fileName: upload.fileName,
        fileSize: upload.size,
        fileType: upload.contentType,
        storagePath: upload.storagePath,
        submissionFile,
        submittedByUid: currentUser.uid,
        submittedByEmail: currentUser.email || studentProfile?.email || "",
      };

      try {
        await updateDoc(fsDoc(db, "submissions", submission.id), submissionPatch);
      } catch (error) {
        const errorCode = String(error?.code || "").toLowerCase();

        if (
          errorCode !== "permission-denied" &&
          errorCode !== "firestore/permission-denied"
        ) {
          throw error;
        }

        const fallbackRef = fsDoc(collection(db, "submissions"));
        const fallbackSubmission = {
          assignmentId: submission.assignmentId,
          teacherId:
            submission.teacherId || assignment.createdBy || groupRecord?.teacherId || "",
          groupId: submission.groupId || assignment.groupId,
          studentId:
            submission.studentId || (await resolveAssignmentStudentIdentifier(assignment)),
          reviewChecked: submission.reviewChecked || false,
          marks:
            submission.marks !== undefined && submission.marks !== null
              ? submission.marks
              : null,
          createdAt: submission.createdAt || submittedAt,
          ...submissionPatch,
        };

        await setDoc(fallbackRef, fallbackSubmission);
        submission = {
          id: fallbackRef.id,
          ...fallbackSubmission,
        };
      }

      upsertSubmissionCache({
        ...submission,
        ...submissionPatch,
      });
      submissionSaved = true;
      renderCurrentPage();

      const teacherId = assignment.createdBy || groupRecord?.teacherId;
      await createNotification({
        userId: teacherId,
        type: "submission",
        title: `${studentDisplayName()} submitted ${assignment.title}`,
        body: `${studentProfile?.rollNumber || "Student"} submitted work for ${assignment.subject || "your class"}.`,
        page: "assignments",
        assignmentId: assignment.id,
        partnerId: currentUser.uid,
      }).catch(() => {});

      bootstrap.Modal.getInstance($("#submitAssignmentModal"))?.hide();
      showToast(`Submitted "${assignment.title}" successfully.`);
    } catch (error) {
      if (!submissionSaved && uploadedStoragePath) {
        await deleteStoredFile(uploadedStoragePath).catch(() => {});
      }
      alert(formatFirebaseUploadError(error, "submit this assignment"));
    } finally {
      setSubmissionFormBusy(false);
    }
  }

  async function handleStudentProfileSave(event) {
    event.preventDefault();
    event.stopPropagation();

    const form = event.currentTarget;
    if (!form.checkValidity()) {
      form.classList.add("was-validated");
      return;
    }

    const previousRoll = String(studentProfile?.rollNumber || "").trim().toUpperCase();
    const nextRoll = $("#studentProfileEditRollNumber").value.trim().toUpperCase();
    const payload = {
      name: $("#studentProfileEditName").value.trim(),
      rollNumber: nextRoll,
      section: $("#studentProfileEditSection").value.trim().toUpperCase(),
      yearOfStudy: $("#studentProfileEditYear").value,
      department: $("#studentProfileEditDepartment").value,
    };

    try {
      await updateDoc(fsDoc(db, "users", currentUser.uid), payload);

      studentProfile = {
        ...(studentProfile || {}),
        ...payload,
        email: studentProfile?.email || currentUser?.email || "",
      };

      setStudentHeader();
      renderStudentProfileModal();
      renderCurrentPage();
      setStudentProfileModalMode("view");
      showToast("Student profile updated.");
    } catch (error) {
      alert(error.message);
    }
  }

  // >>> ARCHITECTURE FIX: SCANNING THE MAIN GROUPS COLLECTION <<<
  function watchGroupData() {
    if (groupDocUnsub) groupDocUnsub();
    if (assignmentsUnsub) assignmentsUnsub();
    if (submissionsUnsub) submissionsUnsub();

    groupRecord = null;
    studentActiveGroupIds = [];
    assignmentsCache = [];
    submissionsCache = [];
    teacherProfilesCache = new Map();

    const identifiers = currentIdentifiers();
    if (identifiers.length === 0) {
      renderCurrentPage();
      return;
    }

    // Instead of trusting the student's profile array, the App actively 
    // scans the database for ANY group that includes their email or roll number
    groupDocUnsub = onSnapshot(
      query(collection(db, "groups"), where("studentIds", "array-contains-any", identifiers)),
      (groupSnap) => {
        studentActiveGroupIds = groupSnap.docs.map((doc) => doc.id);

        if (studentActiveGroupIds.length === 0) {
          groupRecord = null;
          assignmentsCache = [];
          submissionsCache = [];
          renderCurrentPage();
          return;
        }

        groupRecord = { id: groupSnap.docs[0].id, ...groupSnap.docs[0].data() };

        // Firestore limits 'in' queries to 10 elements
        const safeGroupIds = studentActiveGroupIds.slice(0, 10);

        if (assignmentsUnsub) assignmentsUnsub();
        assignmentsUnsub = onSnapshot(
          query(collection(db, "assignments"), where("groupId", "in", safeGroupIds)),
          (snap) => {
            assignmentsCache = snap.docs
              .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
              .sort((a, b) => toTime(a.deadline) - toTime(b.deadline));
            void watchTeacherProfiles();
            renderCurrentPage();
          }
        );

        if (submissionsUnsub) submissionsUnsub();
        submissionsUnsub = onSnapshot(
          query(collection(db, "submissions"), where("groupId", "in", safeGroupIds)),
          (snap) => {
            submissionsCache = snap.docs
              .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
              .sort((a, b) => toTime(b.updatedAt) - toTime(a.updatedAt));
            renderCurrentPage();
          }
        );
      }
    );
  }

  function watchNotifications() {
    if (notificationsUnsub) notificationsUnsub();
    if (!currentUser) return;

    notificationsUnsub = onSnapshot(
      query(collection(db, "notifications"), where("userId", "==", currentUser.uid)),
      (snap) => {
        notificationsCache = snap.docs.map((docSnap) => ({
          id: docSnap.id,
          ...docSnap.data(),
        }));
        renderNotifications();
        updateNotificationBadge();
        renderChatPage();
      }
    );
  }

  function watchChatThreads() {
    if (chatThreadsUnsub) chatThreadsUnsub();
    if (!currentUser) return;

    chatThreadsUnsub = onSnapshot(
      query(collection(db, "chatThreads"), where("participants", "array-contains", currentUser.uid)),
      (snap) => {
        chatThreadsCache = snap.docs
          .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
          .sort((a, b) => toTime(b.updatedAt) - toTime(a.updatedAt));
        syncActiveChatThread();
        renderChatPage();
      }
    );
  }

  async function handleNotificationClick(notificationId) {
    const notification = notificationsCache.find((item) => item.id === notificationId);
    if (!notification) return;

    await markNotificationRead(notificationId);

    if (notification.type === "group-chat" && notification.groupId) {
      await openGroupChat(notification.groupId, true);
    } else if (notification.type === "chat" && notification.partnerId) {
      await openChatWithTeacher(notification.partnerId, true);
    } else {
      showPage(notification.page || "dashboard");
    }

    bootstrap.Offcanvas.getInstance($("#notificationDrawer"))?.hide();
  }

  async function handleLogout() {
    try {
      await signOut(auth);
      window.location.href = "index.html";
    } catch (error) {
      alert(error.message);
    }
  }

  document.addEventListener("click", (event) => {
    const navTrigger = event.target.closest("[data-page]");
    const submitButton = event.target.closest("[data-submit]");
    const notificationButton = event.target.closest("[data-notification-id]");
    const chatGroupButton = event.target.closest("[data-chat-group]");
    const chatPartnerButton = event.target.closest("[data-chat-partner]");
    const profileAction = event.target.closest("[data-profile-action]");

    if (profileAction) {
      event.preventDefault();
      openStudentProfileModal(profileAction.dataset.profileAction || "view");
      return;
    }

    if (
      navTrigger &&
      (navTrigger.classList.contains("nav-item") ||
        navTrigger.classList.contains("nav-link-internal"))
    ) {
      event.preventDefault();
      const page = navTrigger.dataset.page;
      if (page === "logout") {
        bootstrap.Modal.getOrCreateInstance($("#logoutModal")).show();
      } else {
        showPage(page);
      }
      return;
    }

    if (submitButton) {
      openSubmissionModal(submitButton.dataset.submit);
      return;
    }

    if (notificationButton) {
      handleNotificationClick(notificationButton.dataset.notificationId);
      return;
    }

    if (chatGroupButton) {
      openGroupChat(chatGroupButton.dataset.chatGroup, true);
      return;
    }

    if (chatPartnerButton) {
      openChatWithTeacher(chatPartnerButton.dataset.chatPartner, true);
    }
  });

  $$(".btn-filter").forEach((button) => {
    button.addEventListener("click", () => {
      $$(".btn-filter").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      renderAssignments();
    });
  });

  $("#searchInput").addEventListener("input", renderAssignments);
  $("#chatForm").addEventListener("submit", sendChatMessage);
  $("#markAllNotifications").addEventListener("click", markAllNotificationsRead);
  $("#submitAssignmentForm").addEventListener("submit", handleAssignmentSubmission);
  $("#studentProfileForm").addEventListener("submit", handleStudentProfileSave);
  $("#studentProfileEditBtn").addEventListener("click", () => {
    renderStudentProfileModal();
    setStudentProfileModalMode("edit");
  });

  $("#sidebarToggle").addEventListener("click", () => {
    $("#sidebar").classList.add("show");
    $("#sidebarBackdrop").classList.add("show");
  });

  $("#sidebarBackdrop").addEventListener("click", closeSidebar);

  $("[data-dismiss-banner]").addEventListener("click", () => {
    $("#notificationBanner").classList.add("d-none");
  });

  $("#confirmLogout").addEventListener("click", async () => {
    bootstrap.Modal.getInstance($("#logoutModal"))?.hide();
    await handleLogout();
  });

  $("#studentProfileModal").addEventListener("hidden.bs.modal", () => {
    setStudentProfileModalMode("view");
  });

  $("#submitAssignmentModal").addEventListener("hidden.bs.modal", () => {
    pendingSubmissionAssignmentId = "";
    $("#submitAssignmentForm").classList.remove("was-validated");
    $("#submissionPdfFile").value = "";
    setSubmissionFormBusy(false);
  });

  window.addEventListener("hashchange", () => showPage(pageFromHash()));

  onAuthStateChanged(auth, (user) => {
    if (!user) return;

    currentUser = user;
    watchNotifications();
    watchChatThreads();

    if (userProfileUnsub) userProfileUnsub();
    userProfileUnsub = onSnapshot(fsDoc(db, "users", user.uid), (snap) => {
      studentProfile = snap.exists() ? { id: snap.id, ...snap.data() } : null;
      setStudentHeader();
      watchGroupData();
    });

    showPage(pageFromHash());
  });
})();
