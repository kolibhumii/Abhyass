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
  formatRelativeTime,
  getInitials,
  initThemeToggle,
} from "./dashboard-common.js";

import {
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";

import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc as fsDoc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";

(() => {
  initThemeToggle();

  const assignmentUploadHint = document.querySelector("#aAttachment ~ .form-text");
  if (assignmentUploadHint) {
    assignmentUploadHint.textContent = describePdfUploadRules().replace(
      "Only",
      "Optional. Only"
    );
  }

  let currentUser = null;
  let teacherProfile = null;

  let groupsCache = [];
  let assignmentsCache = [];
  let submissionsCache = [];
  let studentProfilesCache = new Map();
  let notificationsCache = [];
  let chatThreadsCache = [];
  let activeChatMessages = [];

  let selectedGroupId = "";
  let selectedAssignmentId = "";
  let activeChatMode = "group";
  let activeChatStudentId = "";
  let activeGroupChatId = "";
  let activeChatThreadId = "";

  let notificationsUnsub = null;
  let chatThreadsUnsub = null;
  let activeChatMessagesUnsub = null;
  let assignmentsUnsub = null;
  let submissionsUnsub = null;

  const PAGE_META = {
    overview: {
      title: "Overview",
      sub: "View groups, assignments, and review progress",
    },
    groups: {
      title: "Groups",
      sub: "Create groups and manage students",
    },
    assignments: {
      title: "Assignments",
      sub: "Create assignments, review submissions, and award marks",
    },
    tracking: {
      title: "Tracking",
      sub: "Track submission, checking, and marking progress",
    },
    saved: {
      title: "Saved",
      sub: "Open saved reviews and download them as PDF",
    },
    chat: {
      title: "Chat",
      sub: "Stay connected with your students",
    },
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => document.querySelectorAll(selector);

  function normalizeGroupName(name) {
    return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  function normalizeIdentifier(value) {
    const trimmed = String(value || "").trim();
    if (!trimmed) return "";
    return trimmed.includes("@") ? trimmed.toLowerCase() : trimmed.toUpperCase();
  }

  function normalizeList(raw) {
    return [...new Set(
      String(raw || "")
        .split(/[\n,]+/)
        .map((item) => normalizeIdentifier(item))
        .filter(Boolean)
    )];
  }

  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char]);
  }

  function fmtDate(value) {
    if (!value) return "—";
    return new Date(value).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function fmtDateTime(value) {
    if (!value) return "—";
    return new Date(value).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function toTime(value) {
    if (value == null) return 0;
    if (typeof value === "number") return value;
    if (typeof value === "string") return new Date(value).getTime() || 0;
    return 0;
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

  function endOfDayTime(value) {
    const date = new Date(value);
    date.setHours(23, 59, 59, 999);
    return date.getTime();
  }

  function slugify(value) {
    return String(value || "assignment")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "assignment";
  }

  function hasMarks(value) {
    return value !== null && value !== undefined && value !== "";
  }

  function parseMarksValue(value) {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) return null;

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return null;

    return Math.max(0, Math.min(100, Math.round(parsed * 10) / 10));
  }

  function countLabel(count, singular) {
    return `${count} ${singular}${count === 1 ? "" : "s"}`;
  }

  function formatFileSize(size) {
    const bytes = Number(size || 0);
    if (!bytes) return "0 KB";
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    return `${Math.max(bytes / 1024, 0.1).toFixed(1)} KB`;
  }

  function showToast(message) {
    const toastBody = $("#toastBody");
    const toastEl = $("#actionToast");
    if (!toastBody || !toastEl) return;

    toastBody.textContent = message;
    bootstrap.Toast.getOrCreateInstance(toastEl).show();
  }

  function groupById(id) {
    return groupsCache.find((group) => group.id === id) || null;
  }

  function assignmentById(id) {
    return assignmentsCache.find((assignment) => assignment.id === id) || null;
  }

  function assignmentsForGroup(groupId) {
    return assignmentsCache
      .filter((assignment) => assignment.groupId === groupId)
      .sort((a, b) => {
        const deadlineDiff = toTime(a.deadline) - toTime(b.deadline);
        if (deadlineDiff !== 0) return deadlineDiff;
        return toTime(b.createdAt) - toTime(a.createdAt);
      });
  }

  function preferredSubmission(current, next) {
    if (!current) return next;
    if (!next) return current;

    const submittedDiff =
      Number(next.status === "submitted") - Number(current.status === "submitted");
    if (submittedDiff !== 0) {
      return submittedDiff > 0 ? next : current;
    }

    return toTime(next.updatedAt) >= toTime(current.updatedAt) ? next : current;
  }

  function submissionsForAssignment(assignmentId) {
    const deduped = new Map();

    submissionsCache
      .filter((submission) => submission.assignmentId === assignmentId)
      .forEach((submission) => {
        const key =
          normalizeIdentifier(submission.studentId) ||
          normalizeIdentifier(submission.submittedByEmail) ||
          String(submission.submittedByUid || "").trim() ||
          submission.id;

        deduped.set(key, preferredSubmission(deduped.get(key), submission));
      });

    return [...deduped.values()];
  }

  function cacheStudentProfile(profile, identifiers = []) {
    if (!profile) return;

    const normalizedKeys = new Set(
      [...identifiers, profile.email, profile.rollNumber]
        .map((item) => normalizeIdentifier(item))
        .filter(Boolean)
    );

    normalizedKeys.forEach((key) => {
      studentProfilesCache.set(key, profile);
    });
  }

  async function findUserDocsByIdentifier(identifier) {
    const normalized = normalizeIdentifier(identifier);
    if (!normalized) return [];

    const checks = normalized.includes("@")
      ? [
          query(collection(db, "users"), where("email", "==", normalized)),
          query(
            collection(db, "users"),
            where("rollNumber", "==", normalized.toUpperCase())
          ),
        ]
      : [
          query(
            collection(db, "users"),
            where("rollNumber", "==", normalized.toUpperCase())
          ),
          query(collection(db, "users"), where("email", "==", normalized.toLowerCase())),
        ];

    const docs = [];
    const seenIds = new Set();

    for (const check of checks) {
      const snap = await getDocs(check);
      snap.forEach((docSnap) => {
        if (seenIds.has(docSnap.id)) return;
        seenIds.add(docSnap.id);
        docs.push(docSnap);
      });
    }

    return docs;
  }

  async function loadStudentProfiles() {
    const identifiers = [
      ...new Set(
        groupsCache
          .flatMap((group) => group.studentIds || [])
          .map((item) => normalizeIdentifier(item))
          .filter(Boolean)
      ),
    ];

    studentProfilesCache = new Map();

    await Promise.all(
      identifiers.map(async (identifier) => {
        const docs = await findUserDocsByIdentifier(identifier);
        if (!docs.length) return;

        const docSnap = docs[0];
        cacheStudentProfile({ id: docSnap.id, ...docSnap.data() }, [identifier]);
      })
    );
  }

  function studentProfileByIdentifier(identifier) {
    return studentProfilesCache.get(normalizeIdentifier(identifier)) || null;
  }

  function studentDisplay(identifier) {
    const normalized = normalizeIdentifier(identifier);
    const profile = studentProfileByIdentifier(normalized);

    return {
      name:
        profile?.name?.trim() ||
        (normalized.includes("@") ? normalized.split("@")[0] : normalized) ||
        "Student",
      rollNumber:
        profile?.rollNumber ||
        (normalized && !normalized.includes("@") ? normalized : "—"),
      identifier: profile?.email || normalized || "—",
      section: profile?.section || "—",
      department: profile?.department || "—",
      yearOfStudy: profile?.yearOfStudy || "—",
    };
  }

  function submissionStatusMeta(submission, assignment) {
    if (!submission) {
      return isPastDeadline(assignment?.deadline)
        ? {
            key: "overdue",
            label: "Overdue",
            badgeClass: "overdue",
            isSubmitted: false,
            isLate: false,
          }
        : {
            key: "pending",
            label: "Pending",
            badgeClass: "pending",
            isSubmitted: false,
            isLate: false,
          };
    }

    if (submission.status === "submitted") {
      const late =
        Boolean(submission.submittedAt) &&
        endOfDayTime(assignment.deadline) < toTime(submission.submittedAt);

      return late
        ? {
            key: "late",
            label: "Late submission",
            badgeClass: "late",
            isSubmitted: true,
            isLate: true,
          }
        : {
            key: "submitted",
            label: "Submitted",
            badgeClass: "submitted",
            isSubmitted: true,
            isLate: false,
          };
    }

    return isPastDeadline(assignment.deadline)
      ? {
          key: "overdue",
          label: "Overdue",
          badgeClass: "overdue",
          isSubmitted: false,
          isLate: false,
        }
      : {
          key: "pending",
          label: "Pending",
          badgeClass: "pending",
          isSubmitted: false,
          isLate: false,
        };
  }

  function assignmentStats(assignment) {
    const group = groupById(assignment.groupId);
    const related = submissionsForAssignment(assignment.id);
    const total = Math.max(related.length, (group?.studentIds || []).length);

    let submitted = 0;
    let pending = 0;
    let overdue = 0;
    let late = 0;
    let checked = 0;
    let marked = 0;

    related.forEach((submission) => {
      const meta = submissionStatusMeta(submission, assignment);

      if (meta.isSubmitted) {
        submitted += 1;
        if (meta.isLate) late += 1;
        if (submission.reviewChecked) checked += 1;
        if (hasMarks(submission.marks)) marked += 1;
        return;
      }

      if (meta.key === "overdue") {
        overdue += 1;
      } else {
        pending += 1;
      }
    });

    const missing = Math.max(total - related.length, 0);
    if (missing > 0) {
      if (isPastDeadline(assignment.deadline)) {
        overdue += missing;
      } else {
        pending += missing;
      }
    }

    const marks = related
      .map((submission) => Number(submission.marks))
      .filter((value) => Number.isFinite(value));

    const averageMarks = marks.length
      ? Math.round((marks.reduce((sum, value) => sum + value, 0) / marks.length) * 10) /
        10
      : null;

    const submissionPct = total ? Math.round((submitted / total) * 100) : 0;
    const checkedPct = submitted ? Math.round((checked / submitted) * 100) : 0;
    const markedPct = submitted ? Math.round((marked / submitted) * 100) : 0;

    return {
      total,
      submitted,
      pending,
      overdue,
      late,
      checked,
      marked,
      submissionPct,
      checkedPct,
      markedPct,
      averageMarks,
      saved: Boolean(assignment.savedAt),
      isFullyChecked:
        total > 0 && submitted === total && pending === 0 && overdue === 0 && checked === submitted,
    };
  }

  function groupStats(group) {
    const groupAssignments = assignmentsForGroup(group.id);

    return groupAssignments.reduce(
      (summary, assignment) => {
        const stats = assignmentStats(assignment);

        summary.assignmentCount += 1;
        summary.submitted += stats.submitted;
        summary.pending += stats.pending;
        summary.overdue += stats.overdue;
        summary.checked += stats.checked;
        summary.saved += stats.saved ? 1 : 0;

        return summary;
      },
      {
        assignmentCount: 0,
        submitted: 0,
        pending: 0,
        overdue: 0,
        checked: 0,
        saved: 0,
      }
    );
  }

  function buildReviewRows(assignment) {
    const group = groupById(assignment.groupId);
    const related = submissionsForAssignment(assignment.id);
    const submissionMap = new Map();

    related.forEach((submission) => {
      submissionMap.set(normalizeIdentifier(submission.studentId), submission);
    });

    const identifiers = [
      ...(group?.studentIds || []),
      ...related.map((submission) => submission.studentId),
    ]
      .map((item) => normalizeIdentifier(item))
      .filter(Boolean);

    const uniqueIdentifiers = [...new Set(identifiers)];

    return uniqueIdentifiers
      .map((identifier) => {
        const submission = submissionMap.get(identifier) || null;
        const student = studentDisplay(identifier);
        const meta = submissionStatusMeta(submission, assignment);

        return {
          identifier,
          submission,
          student,
          meta,
        };
      })
      .sort((a, b) => {
        const rollA = a.student.rollNumber === "—" ? "ZZZ" : a.student.rollNumber;
        const rollB = b.student.rollNumber === "—" ? "ZZZ" : b.student.rollNumber;

        if (rollA !== rollB) return rollA.localeCompare(rollB);
        return a.student.name.localeCompare(b.student.name);
      });
  }

  function syncSelections() {
    if (!groupsCache.length) {
      selectedGroupId = "";
      selectedAssignmentId = "";
      return;
    }

    if (!groupById(selectedGroupId)) {
      selectedGroupId = groupsCache[0].id;
    }

    const groupAssignments = assignmentsForGroup(selectedGroupId);

    if (!groupAssignments.length) {
      selectedAssignmentId = "";
      return;
    }

    if (!assignmentById(selectedAssignmentId) || assignmentById(selectedAssignmentId)?.groupId !== selectedGroupId) {
      selectedAssignmentId = groupAssignments[0].id;
    }
  }

  function teacherDisplayName() {
    return teacherProfile?.name || currentUser?.email || "Teacher";
  }

  function teacherInitials() {
    return teacherDisplayName()
      .split(/\s+/)
      .map((part) => part[0] || "")
      .join("")
      .slice(0, 2)
      .toUpperCase() || "TP";
  }

  function teacherRoleLabel() {
    return teacherProfile?.department
      ? `${teacherProfile.department} Department`
      : "Faculty";
  }

  function teacherSummaryStats() {
    const uniqueStudents = new Set();

    groupsCache.forEach((group) => {
      (group.studentIds || []).forEach((studentId) =>
        uniqueStudents.add(normalizeIdentifier(studentId))
      );
    });

    const savedCount = assignmentsCache.filter(
      (assignment) => assignment.savedAt
    ).length;
    const pendingReview = assignmentsCache.filter((assignment) => {
      const stats = assignmentStats(assignment);
      return (
        stats.submitted > stats.checked ||
        stats.pending > 0 ||
        stats.overdue > 0
      );
    }).length;

    return {
      groups: groupsCache.length,
      students: uniqueStudents.size,
      assignments: assignmentsCache.length,
      savedCount,
      pendingReview,
    };
  }

  function setTeacherHeader() {
    const profileNameEl = $(".profile-name");
    const avatarEl = $(".topbar .avatar");
    const profileRoleEl = $(".profile-role");

    const displayName = teacherDisplayName();
    const initials = teacherInitials();

    if (profileNameEl) profileNameEl.textContent = displayName;
    if (avatarEl) avatarEl.textContent = initials || "TP";
    if (profileRoleEl) profileRoleEl.textContent = teacherRoleLabel();
  }

  function renderTeacherProfileModal() {
    const hero = $("#teacherProfileHero");
    const view = $("#teacherProfileView");
    if (!hero || !view) return;

    const stats = teacherSummaryStats();

    hero.innerHTML = `
      <div class="profile-modal-avatar">${escapeHtml(teacherInitials())}</div>
      <div>
        <div class="profile-modal-title">${escapeHtml(teacherDisplayName())}</div>
        <div class="profile-modal-copy">${escapeHtml(teacherProfile?.email || currentUser?.email || "—")}</div>
        <div class="profile-modal-copy">${escapeHtml(teacherRoleLabel())}</div>
      </div>
    `;

    view.innerHTML = `
      <div class="profile-modal-item">
        <span>Full Name</span>
        <strong>${escapeHtml(teacherDisplayName())}</strong>
      </div>
      <div class="profile-modal-item">
        <span>Email</span>
        <strong>${escapeHtml(teacherProfile?.email || currentUser?.email || "—")}</strong>
      </div>
      <div class="profile-modal-item">
        <span>Department</span>
        <strong>${escapeHtml(teacherProfile?.department || "—")}</strong>
      </div>
      <div class="profile-modal-item">
        <span>Groups</span>
        <strong>${stats.groups}</strong>
      </div>
      <div class="profile-modal-item">
        <span>Assignments</span>
        <strong>${stats.assignments}</strong>
      </div>
      <div class="profile-modal-item">
        <span>Students</span>
        <strong>${stats.students}</strong>
      </div>
      <div class="profile-modal-item">
        <span>Saved Reviews</span>
        <strong>${stats.savedCount}</strong>
      </div>
      <div class="profile-modal-item">
        <span>Pending Review</span>
        <strong>${stats.pendingReview}</strong>
      </div>
    `;

    const nameInput = $("#teacherProfileName");
    const emailInput = $("#teacherProfileEmail");
    const departmentInput = $("#teacherProfileDepartment");

    if (nameInput) nameInput.value = teacherProfile?.name || "";
    if (emailInput) emailInput.value = teacherProfile?.email || currentUser?.email || "";
    if (departmentInput) departmentInput.value = teacherProfile?.department || "";
  }

  function setTeacherProfileModalMode(mode = "view") {
    const isEdit = mode === "edit";
    const title = $("#teacherProfileModalTitle");
    const sub = $("#teacherProfileModalSub");
    const view = $("#teacherProfileView");
    const form = $("#teacherProfileForm");
    const editBtn = $("#teacherProfileEditBtn");
    const saveBtn = $("#teacherProfileSaveBtn");
    const closeBtn = $("#teacherProfileCloseBtn");

    if (title) {
      title.textContent = isEdit ? "Edit Teacher Profile" : "Teacher Profile";
    }

    if (sub) {
      sub.textContent = isEdit
        ? "Update your teacher profile details"
        : "View your profile details";
    }

    if (view) view.classList.toggle("d-none", isEdit);
    if (form) {
      form.classList.toggle("d-none", !isEdit);
      form.classList.remove("was-validated");
    }
    if (editBtn) editBtn.classList.toggle("d-none", isEdit);
    if (saveBtn) saveBtn.classList.toggle("d-none", !isEdit);
    if (closeBtn) closeBtn.textContent = isEdit ? "Cancel" : "Close";
  }

  function openTeacherProfileModal(mode = "view") {
    renderTeacherProfileModal();
    setTeacherProfileModalMode(mode);
    bootstrap.Modal.getOrCreateInstance($("#teacherProfileModal")).show();
  }

  function renderTeacherProfileCard() {
    const el = $("#teacherProfileCard");
    if (!el) return;

    const stats = teacherSummaryStats();

    el.innerHTML = `
      <div class="profile-panel-head">
        <div class="profile-panel-avatar">
          ${escapeHtml(teacherInitials())}
        </div>
        <div>
          <div class="profile-panel-name">${escapeHtml(teacherDisplayName())}</div>
          <div class="profile-panel-copy">${escapeHtml(teacherProfile?.email || currentUser?.email || "—")}</div>
        </div>
      </div>
      <div class="profile-panel-grid">
        <div class="profile-panel-item">
          <span>Department</span>
          <strong>${escapeHtml(teacherProfile?.department || "—")}</strong>
        </div>
        <div class="profile-panel-item">
          <span>Saved Reviews</span>
          <strong>${stats.savedCount}</strong>
        </div>
        <div class="profile-panel-item">
          <span>Pending Review</span>
          <strong>${stats.pendingReview}</strong>
        </div>
        <div class="profile-panel-item">
          <span>Total Assignments</span>
          <strong>${stats.assignments}</strong>
        </div>
      </div>
    `;
  }

  function renderOverviewAlerts() {
    const container = $("#overviewAlerts");
    if (!container) return;

    const overdueAssignments = assignmentsCache.filter(
      (assignment) => assignmentStats(assignment).overdue > 0
    ).length;
    const pendingReviewAssignments = assignmentsCache.filter((assignment) => {
      const stats = assignmentStats(assignment);
      return stats.submitted > stats.checked;
    }).length;
    const savedReviews = assignmentsCache.filter((assignment) => assignment.savedAt).length;

    const alerts = [];

    if (overdueAssignments > 0) {
      alerts.push({
        kind: "danger",
        icon: "bi-exclamation-triangle-fill",
        text: `<strong>${overdueAssignments}</strong> assignment${overdueAssignments === 1 ? "" : "s"} include overdue student submissions`,
      });
    }

    if (pendingReviewAssignments > 0) {
      alerts.push({
        kind: "warning",
        icon: "bi-journal-check",
        text: `<strong>${pendingReviewAssignments}</strong> assignment${pendingReviewAssignments === 1 ? "" : "s"} still have unchecked submitted work`,
      });
    }

    if (savedReviews > 0) {
      alerts.push({
        kind: "info",
        icon: "bi-bookmark-check-fill",
        text: `<strong>${savedReviews}</strong> review${savedReviews === 1 ? "" : "s"} saved and ready for PDF download`,
      });
    }

    if (!alerts.length) {
      alerts.push({
        kind: "info",
        icon: "bi-check2-all",
        text: "Everything looks organized. Your groups and reviews are up to date.",
      });
    }

    container.innerHTML = alerts
      .map(
        (item) => `
          <div class="alert-soft alert-${item.kind}-soft">
            <i class="bi ${item.icon} alert-icon"></i>
            <div>${item.text}</div>
          </div>
        `
      )
      .join("");
  }

  function renderOverviewStats() {
    const uniqueStudents = new Set();

    groupsCache.forEach((group) => {
      (group.studentIds || []).forEach((studentId) => uniqueStudents.add(normalizeIdentifier(studentId)));
    });

    let submitted = 0;
    let pending = 0;
    let overdue = 0;

    assignmentsCache.forEach((assignment) => {
      const stats = assignmentStats(assignment);
      submitted += stats.submitted;
      pending += stats.pending;
      overdue += stats.overdue;
    });

    const stats = {
      groups: groupsCache.length,
      students: uniqueStudents.size,
      assignments: assignmentsCache.length,
      submitted,
      pending,
      overdue,
    };

    Object.entries(stats).forEach(([key, value]) => {
      document
        .querySelectorAll(`[data-stat="${key}"]`)
        .forEach((node) => (node.textContent = value));
    });
  }

  function renderOverviewGroups() {
    const list = $("#overviewGroupsList");
    const empty = $("#overviewGroupsEmpty");
    const count = $("#overviewGroupsCount");

    if (count) {
      count.textContent = `${groupsCache.length} group${groupsCache.length === 1 ? "" : "s"}`;
    }

    if (!list || !empty) return;

    if (!groupsCache.length) {
      list.innerHTML = "";
      empty.classList.remove("d-none");
      return;
    }

    empty.classList.add("d-none");

    list.innerHTML = groupsCache
      .map((group) => {
        const summary = groupStats(group);
        const initials = group.groupName
          .split(/\s+/)
          .map((word) => word[0] || "")
          .join("")
          .slice(0, 2)
          .toUpperCase();

        return `
          <button type="button" class="overview-group-card" data-open-group="${group.id}">
            <div class="overview-group-head">
              <div class="group-avatar">${escapeHtml(initials || "G")}</div>
              <div class="overview-group-meta">
                <div class="overview-group-name">${escapeHtml(group.groupName)}</div>
                <div class="overview-group-copy">
                  ${countLabel((group.studentIds || []).length, "student")} • ${countLabel(summary.assignmentCount, "assignment")}
                </div>
              </div>
              <i class="bi bi-arrow-right-circle-fill"></i>
            </div>
            <div class="overview-group-stats">
              <span class="metric-pill metric-pill-primary">${summary.assignmentCount} assignments</span>
              <span class="metric-pill metric-pill-success">${summary.submitted} submitted</span>
              <span class="metric-pill metric-pill-warning">${summary.pending} pending</span>
              <span class="metric-pill metric-pill-danger">${summary.overdue} overdue</span>
            </div>
            <div class="overview-group-foot">
              <span>${summary.checked} checked</span>
              <span>${summary.saved} saved review${summary.saved === 1 ? "" : "s"}</span>
            </div>
          </button>
        `;
      })
      .join("");
  }

  function renderOverviewQueue() {
    const list = $("#overviewQueueList");
    const empty = $("#overviewQueueEmpty");
    if (!list || !empty) return;

    const queue = assignmentsCache
      .map((assignment) => ({
        assignment,
        group: groupById(assignment.groupId),
        stats: assignmentStats(assignment),
      }))
      .filter(({ stats }) => stats.pending > 0 || stats.overdue > 0 || stats.submitted > stats.checked)
      .sort((a, b) => {
        if (b.stats.overdue !== a.stats.overdue) return b.stats.overdue - a.stats.overdue;
        if (b.stats.pending !== a.stats.pending) return b.stats.pending - a.stats.pending;
        return toTime(a.assignment.deadline) - toTime(b.assignment.deadline);
      })
      .slice(0, 6);

    if (!queue.length) {
      list.innerHTML = "";
      empty.classList.remove("d-none");
      return;
    }

    empty.classList.add("d-none");

    list.innerHTML = queue
      .map(({ assignment, group, stats }) => `
        <button type="button" class="quick-item" data-open-assignment="${assignment.id}">
          <div class="quick-item-main">
            <div class="quick-item-title">${escapeHtml(assignment.title)}</div>
            <div class="quick-item-copy">${escapeHtml(group?.groupName || "—")} • Due ${fmtDate(assignment.deadline)}</div>
          </div>
          <div class="quick-item-side">
            <span>${stats.submissionPct}% submitted</span>
            <span>${stats.checked}/${stats.submitted || 0} checked</span>
          </div>
        </button>
      `)
      .join("");
  }

  function renderOverview() {
    renderOverviewStats();
    renderOverviewAlerts();
    renderTeacherProfileCard();
    renderOverviewGroups();
    renderOverviewQueue();
  }

  function refreshGroupSelects() {
    const assignmentSelect = $("#aGroup");
    const groupFilter = $("#assignmentGroupFilter");

    if (assignmentSelect) {
      assignmentSelect.innerHTML =
        `<option value="" disabled${selectedGroupId ? "" : " selected"}>Select a group</option>` +
        groupsCache
          .map((group) => `
            <option value="${group.id}" ${group.id === selectedGroupId ? "selected" : ""}>
              ${escapeHtml(group.groupName)} (${(group.studentIds || []).length})
            </option>
          `)
          .join("");
    }

    if (groupFilter) {
      groupFilter.innerHTML = groupsCache.length
        ? groupsCache
            .map((group) => `
              <option value="${group.id}" ${group.id === selectedGroupId ? "selected" : ""}>
                ${escapeHtml(group.groupName)}
              </option>
            `)
            .join("")
        : `<option value="">No groups yet</option>`;

      groupFilter.disabled = groupsCache.length === 0;
    }
  }

  function renderGroups() {
    const list = $("#groupsList");
    const empty = $("#groupsEmpty");
    const count = $("#groupsCount");

    if (count) {
      count.textContent = `${groupsCache.length} group${groupsCache.length === 1 ? "" : "s"}`;
    }

    if (!list || !empty) return;

    if (!groupsCache.length) {
      list.innerHTML = "";
      empty.classList.remove("d-none");
      refreshGroupSelects();
      return;
    }

    empty.classList.add("d-none");

    list.innerHTML = groupsCache
      .map((group) => {
        const initials = group.groupName
          .split(/\s+/)
          .map((word) => word[0] || "")
          .join("")
          .slice(0, 2)
          .toUpperCase();
        const summary = groupStats(group);

        return `
          <div class="group-card" data-group="${group.id}">
            <div class="group-avatar">${escapeHtml(initials || "G")}</div>
            <div class="group-meta">
              <div class="group-name">${escapeHtml(group.groupName)}</div>
              <div class="group-sub">
                ${(group.studentIds || []).length} student${(group.studentIds || []).length === 1 ? "" : "s"} •
                ${summary.assignmentCount} assignment${summary.assignmentCount === 1 ? "" : "s"}
              </div>
            </div>
            <i class="bi bi-chevron-right text-muted"></i>
          </div>
        `;
      })
      .join("");

    refreshGroupSelects();
  }

  function openGroupModal(groupId) {
    const group = groupById(groupId);
    if (!group) return;

    $("#groupModalTitle").textContent = group.groupName;

    const body = $("#groupModal").querySelector(".modal-body");
    const students = group.studentIds || [];

    body.innerHTML = `
      <div class="d-flex justify-content-between align-items-start gap-3 mb-3">
        <div>
          <h5 class="modal-title mb-1">${escapeHtml(group.groupName)}</h5>
          <small class="text-muted">${countLabel(students.length, "student")}</small>
        </div>
        <button type="button" class="btn btn-outline-danger btn-sm delete-group-btn" data-group="${group.id}">
          <i class="bi bi-trash me-1"></i> Delete group
        </button>
      </div>
      <ul class="member-list" id="groupModalMembers">
        ${
          students.length
            ? students
                .map((identifier) => {
                  const student = studentDisplay(identifier);
                  const avatar = (student.name || identifier)
                    .split(/\s+/)
                    .map((part) => part[0] || "")
                    .join("")
                    .slice(0, 2)
                    .toUpperCase();

                  return `
                    <li class="member-list-item">
                      <div class="member-main">
                        <span class="m-avatar">${escapeHtml(avatar || "S")}</span>
                        <div>
                          <div class="member-name">${escapeHtml(student.name)}</div>
                          <div class="member-meta">
                            Roll: ${escapeHtml(student.rollNumber)} • ${escapeHtml(student.identifier)}
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        class="btn btn-sm btn-light text-danger remove-student-btn"
                        data-group="${group.id}"
                        data-student="${encodeURIComponent(identifier)}"
                      >
                        Remove
                      </button>
                    </li>
                  `;
                })
                .join("")
            : `<li class="text-muted small">No students in this group.</li>`
        }
      </ul>
    `;

    bootstrap.Modal.getOrCreateInstance($("#groupModal")).show();
  }

  function renderAssignmentGroupSummary() {
    const summary = $("#assignmentGroupSummary");
    const sub = $("#assignmentListSub");

    if (!summary || !sub) return;

    const group = groupById(selectedGroupId);
    if (!group) {
      summary.innerHTML = `
        <div class="selection-summary-empty">
          Create a group first to start assigning work.
        </div>
      `;
      sub.textContent = "Select a group to review its assignments";
      return;
    }

    const stats = groupStats(group);
    sub.textContent = `${group.groupName} • ${(group.studentIds || []).length} student${(group.studentIds || []).length === 1 ? "" : "s"}`;

    summary.innerHTML = `
      <div class="selection-summary-head">
        <strong>${escapeHtml(group.groupName)}</strong>
        <span>${countLabel((group.studentIds || []).length, "student")}</span>
      </div>
      <div class="selection-summary-grid">
        <div><span>Assignments</span><strong>${stats.assignmentCount}</strong></div>
        <div><span>Submitted</span><strong>${stats.submitted}</strong></div>
        <div><span>Pending</span><strong>${stats.pending}</strong></div>
        <div><span>Overdue</span><strong>${stats.overdue}</strong></div>
      </div>
    `;
  }

  function renderAssignmentList() {
    const tbody = $("#assignmentTableBody");
    const empty = $("#assignmentTableEmpty");
    const search = ($("#assignmentSearch")?.value || "").trim().toLowerCase();

    if (!tbody || !empty) return;

    const group = groupById(selectedGroupId);
    const rows = group
      ? assignmentsForGroup(group.id).filter((assignment) => {
          if (!search) return true;
          return (
            assignment.title.toLowerCase().includes(search) ||
            assignment.subject.toLowerCase().includes(search)
          );
        })
      : [];

    if (!rows.length) {
      tbody.innerHTML = "";
      empty.classList.remove("d-none");
      return;
    }

    empty.classList.add("d-none");

    tbody.innerHTML = rows
      .map((assignment) => {
        const stats = assignmentStats(assignment);
        const selected = assignment.id === selectedAssignmentId;

        return `
          <tr class="${selected ? "row-selected" : ""}">
            <td>
              <div class="a-title">${escapeHtml(assignment.title)}</div>
              <div class="a-sub">${escapeHtml(assignment.subject)}</div>
              ${
                assignment.attachmentUrl
                  ? `<a href="${escapeHtml(assignment.attachmentUrl)}" target="_blank" rel="noopener noreferrer" class="file-link mt-1">
                      <i class="bi bi-paperclip"></i> ${escapeHtml(assignment.attachmentName || "Assignment PDF")}
                    </a>`
                  : ""
              }
            </td>
            <td>
              <div>${fmtDate(assignment.deadline)}</div>
              <div class="a-sub">${stats.submissionPct}% submitted</div>
            </td>
            <td class="text-center"><span class="count-badge submitted">${stats.submitted}</span></td>
            <td class="text-center"><span class="count-badge pending">${stats.pending}</span></td>
            <td class="text-center"><span class="count-badge overdue">${stats.overdue}</span></td>
            <td class="text-center">
              <span class="count-badge total">${stats.checked}/${stats.submitted || 0}</span>
            </td>
            <td>
              ${
                assignment.savedAt
                  ? `<span class="status-pill saved">Saved ${fmtDate(assignment.savedAt)}</span>`
                  : `<span class="text-muted small">Not saved</span>`
              }
            </td>
            <td class="text-end">
              <div class="table-actions">
                <button type="button" class="btn btn-sm btn-light" data-open-assignment="${assignment.id}">
                  Open
                </button>
                <button type="button" class="btn btn-sm btn-outline-danger delete-assignment-btn" data-id="${assignment.id}">
                  Delete
                </button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  function renderReviewPanel() {
    const assignment = assignmentById(selectedAssignmentId);
    const title = $("#reviewPanelTitle");
    const sub = $("#reviewPanelSub");
    const summary = $("#reviewSummary");
    const tbody = $("#reviewTableBody");
    const empty = $("#reviewEmpty");
    const saveBtn = $("#saveSelectedReview");
    const downloadBtn = $("#downloadSelectedReview");

    if (!assignment || !title || !sub || !summary || !tbody || !empty || !saveBtn || !downloadBtn) {
      return;
    }

    if (!assignment) return;

    const group = groupById(assignment.groupId);
    const stats = assignmentStats(assignment);
    const rows = buildReviewRows(assignment);

    title.textContent = assignment.title;
    sub.textContent = `${group?.groupName || "—"} • Due ${fmtDate(assignment.deadline)} • ${stats.submissionPct}% submitted`;
    saveBtn.disabled = false;
    downloadBtn.disabled = false;

    summary.classList.remove("d-none");
    summary.innerHTML = `
      <span class="summary-chip summary-chip-primary">${stats.total} total</span>
      <span class="summary-chip summary-chip-success">${stats.submitted} submitted</span>
      <span class="summary-chip summary-chip-warning">${stats.pending} pending</span>
      <span class="summary-chip summary-chip-danger">${stats.overdue} overdue</span>
      <span class="summary-chip summary-chip-late">${stats.late} late</span>
      <span class="summary-chip summary-chip-primary">${stats.checked}/${stats.submitted || 0} checked</span>
      <span class="summary-chip summary-chip-primary">${stats.marked}/${stats.submitted || 0} marked</span>
      ${
        assignment.savedAt
          ? `<span class="summary-chip summary-chip-saved">Saved ${fmtDateTime(assignment.savedAt)}</span>`
          : ""
      }
      ${
        assignment.attachmentUrl
          ? `<a href="${escapeHtml(assignment.attachmentUrl)}" target="_blank" rel="noopener noreferrer" class="file-link">
              <i class="bi bi-paperclip"></i> ${escapeHtml(assignment.attachmentName || "Assignment PDF")}
            </a>`
          : ""
      }
    `;

    if (!rows.length) {
      tbody.innerHTML = "";
      empty.classList.remove("d-none");
      return;
    }

    empty.classList.add("d-none");

    tbody.innerHTML = rows
      .map(({ student, submission, meta, identifier }) => {
        const disabled = !submission?.id || !meta.isSubmitted;
        const checked = Boolean(submission?.reviewChecked);
        const marksValue = hasMarks(submission?.marks) ? submission.marks : "";

        return `
          <tr>
            <td>${escapeHtml(student.rollNumber)}</td>
            <td>
              <div class="a-title">${escapeHtml(student.name)}</div>
              <div class="a-sub">${escapeHtml(student.department)} • ${escapeHtml(student.section)}</div>
            </td>
            <td class="a-sub">${escapeHtml(identifier)}</td>
            <td>
              <span class="status-pill ${meta.badgeClass}">${escapeHtml(meta.label)}</span>
            </td>
            <td class="a-sub">
              ${
                submission?.submittedAt
                  ? escapeHtml(fmtDateTime(submission.submittedAt))
                  : meta.isSubmitted
                  ? "Submitted"
                  : "—"
              }
            </td>
            <td>
              ${
                submission?.fileUrl
                  ? `<a href="${escapeHtml(submission.fileUrl)}" target="_blank" rel="noopener noreferrer" class="file-link">
                      <i class="bi bi-file-earmark-pdf-fill"></i> ${escapeHtml(submission.fileName || "Submission PDF")}
                    </a>
                    <div class="a-sub mt-1">${escapeHtml(formatFileSize(submission.fileSize))}</div>`
                  : `<span class="file-link-muted"><i class="bi bi-dash-circle"></i> No file</span>`
              }
            </td>
            <td class="text-center">
              <button
                type="button"
                class="review-check-btn ${checked ? "checked" : ""}"
                data-toggle-check="${submission?.id || ""}"
                ${disabled ? "disabled" : ""}
                aria-label="Toggle checked"
              >
                <i class="bi ${checked ? "bi-check-square-fill" : "bi-square"}"></i>
              </button>
            </td>
            <td>
              <input
                type="number"
                class="form-control form-control-sm marks-input"
                data-marks-submission="${submission?.id || ""}"
                value="${escapeHtml(marksValue)}"
                min="0"
                max="100"
                step="0.5"
                placeholder="0-100"
                ${disabled ? "disabled" : ""}
              />
            </td>
          </tr>
        `;
      })
      .join("");
  }

  function renderAssignmentReviewSection() {
    const title = $("#reviewPanelTitle");
    const sub = $("#reviewPanelSub");
    const summary = $("#reviewSummary");
    const tbody = $("#reviewTableBody");
    const empty = $("#reviewEmpty");
    const saveBtn = $("#saveSelectedReview");
    const downloadBtn = $("#downloadSelectedReview");

    if (!title || !sub || !summary || !tbody || !empty || !saveBtn || !downloadBtn) {
      return;
    }

    const assignment = assignmentById(selectedAssignmentId);
    if (!assignment) {
      title.textContent = "Assignment Review";
      sub.textContent = "Select any assignment above to see the full student list, checking status, and marks.";
      summary.classList.add("d-none");
      summary.innerHTML = "";
      tbody.innerHTML = "";
      empty.classList.remove("d-none");
      saveBtn.disabled = true;
      downloadBtn.disabled = true;
      return;
    }

    renderReviewPanel();
  }

  function renderAssignmentsPage() {
    refreshGroupSelects();
    renderAssignmentGroupSummary();
    renderAssignmentList();
    renderAssignmentReviewSection();
  }

  function renderTracking() {
    const search = ($("#trackSearch")?.value || "").trim().toLowerCase();
    const tbody = $("#trackingTableBody");
    const empty = $("#trackingEmpty");

    if (!tbody || !empty) return;

    const allRows = assignmentsCache.map((assignment) => ({
      assignment,
      group: groupById(assignment.groupId),
      stats: assignmentStats(assignment),
    }));

    $("#trackingCheckedCount").textContent = allRows.filter(
      ({ stats }) => stats.isFullyChecked
    ).length;
    $("#trackingPendingCount").textContent = allRows.filter(
      ({ stats }) => !stats.isFullyChecked
    ).length;
    $("#trackingMarkedCount").textContent = allRows.reduce(
      (sum, { stats }) => sum + stats.marked,
      0
    );
    $("#trackingSavedCount").textContent = allRows.filter(
      ({ assignment }) => assignment.savedAt
    ).length;

    const rows = allRows.filter(({ assignment, group }) => {
      if (!search) return true;
      return (
        assignment.title.toLowerCase().includes(search) ||
        assignment.subject.toLowerCase().includes(search) ||
        (group?.groupName || "").toLowerCase().includes(search)
      );
    });

    if (!rows.length) {
      tbody.innerHTML = "";
      empty.classList.remove("d-none");
      return;
    }

    empty.classList.add("d-none");

    tbody.innerHTML = rows
      .sort((a, b) => toTime(a.assignment.deadline) - toTime(b.assignment.deadline))
      .map(({ assignment, group, stats }) => `
        <tr>
          <td>
            <div class="a-title">${escapeHtml(assignment.title)}</div>
            <div class="a-sub">${escapeHtml(assignment.subject)} • Due ${fmtDate(assignment.deadline)}</div>
          </td>
          <td>${escapeHtml(group?.groupName || "—")}</td>
          <td>
            <div class="metric-copy">${stats.submitted}/${stats.total} submitted</div>
            <div class="progress thin">
              <div class="progress-bar bg-success" style="width:${stats.submissionPct}%"></div>
            </div>
          </td>
          <td>
            <div class="metric-copy">${stats.checked}/${stats.submitted || 0} checked</div>
            <div class="progress thin">
              <div class="progress-bar bg-primary" style="width:${stats.checkedPct}%"></div>
            </div>
          </td>
          <td>
            <div class="metric-copy">${stats.marked}/${stats.submitted || 0} marked</div>
            <div class="a-sub">
              ${
                stats.averageMarks == null
                  ? "No marks yet"
                  : `Average ${stats.averageMarks}`
              }
            </div>
          </td>
          <td>
            ${
              assignment.savedAt
                ? `<span class="status-pill saved">Saved ${fmtDate(assignment.savedAt)}</span>`
                : `<span class="text-muted small">Not saved</span>`
            }
          </td>
          <td>
            <div class="progress-report">
              <span>${stats.submissionPct}% submission</span>
              <span>${stats.checkedPct}% checked</span>
              <span>${stats.markedPct}% marked</span>
              ${stats.late ? `<span>${stats.late} late</span>` : ""}
            </div>
          </td>
          <td class="text-end">
            <button type="button" class="btn btn-sm btn-light" data-open-assignment="${assignment.id}">
              Open
            </button>
          </td>
        </tr>
      `)
      .join("");
  }

  function renderSaved() {
    const list = $("#savedAssignmentsList");
    const empty = $("#savedEmpty");
    const search = ($("#savedSearch")?.value || "").trim().toLowerCase();

    if (!list || !empty) return;

    const rows = assignmentsCache
      .filter((assignment) => assignment.savedAt)
      .map((assignment) => ({
        assignment,
        group: groupById(assignment.groupId),
        stats: assignmentStats(assignment),
      }))
      .filter(({ assignment, group }) => {
        if (!search) return true;
        return (
          assignment.title.toLowerCase().includes(search) ||
          assignment.subject.toLowerCase().includes(search) ||
          (group?.groupName || "").toLowerCase().includes(search)
        );
      })
      .sort((a, b) => toTime(b.assignment.savedAt) - toTime(a.assignment.savedAt));

    if (!rows.length) {
      list.innerHTML = "";
      empty.classList.remove("d-none");
      return;
    }

    empty.classList.add("d-none");

    list.innerHTML = rows
      .map(({ assignment, group, stats }) => `
        <article class="saved-card">
          <div class="saved-card-head">
            <div>
              <h6 class="mb-1">${escapeHtml(assignment.title)}</h6>
              <div class="a-sub">${escapeHtml(group?.groupName || "—")} • Saved ${fmtDateTime(assignment.savedAt)}</div>
            </div>
            <span class="status-pill saved">Saved</span>
          </div>
          <div class="saved-card-grid">
            <span class="metric-pill metric-pill-success">${stats.submitted}/${stats.total} submitted</span>
            <span class="metric-pill metric-pill-primary">${stats.checked}/${stats.submitted || 0} checked</span>
            <span class="metric-pill metric-pill-primary">${stats.marked}/${stats.submitted || 0} marked</span>
            ${
              stats.averageMarks == null
                ? `<span class="metric-pill metric-pill-muted">No marks</span>`
                : `<span class="metric-pill metric-pill-primary">Avg ${stats.averageMarks}</span>`
            }
          </div>
          <div class="saved-actions">
            <button type="button" class="btn btn-light btn-sm" data-open-assignment="${assignment.id}">
              Open
            </button>
            <button type="button" class="btn btn-primary-grad btn-sm" data-download-assignment="${assignment.id}">
              <i class="bi bi-download me-1"></i> Download PDF
            </button>
          </div>
        </article>
      `)
      .join("");
  }

  function createNotification(payload) {
    if (!payload.userId) return Promise.resolve();

    return addDoc(collection(db, "notifications"), {
      ...payload,
      createdAt: Date.now(),
      isRead: false,
    });
  }

  async function createGroupChatForGroup(group, participantIds = []) {
    if (!group?.id) return null;

    const threadId = buildGroupChatKey(group.id);
    const createdAt = Date.now();
    const participants = [
      ...new Set([currentUser.uid, ...participantIds].filter(Boolean)),
    ];

    await setDoc(fsDoc(db, "chatThreads", threadId), {
      type: "group",
      participantKey: threadId,
      participants,
      participantCount: participants.length,
      participantIdentifiers: group.studentIds || [],
      groupId: group.id,
      groupName: group.groupName,
      createdBy: currentUser.uid,
      createdAt,
      updatedAt: createdAt,
      lastMessage: `${group.groupName} group chat is ready.`,
      lastMessageSenderId: currentUser.uid,
      lastMessageSenderName: teacherDisplayName(),
    });

    await addDoc(collection(db, "chatThreads", threadId, "messages"), {
      threadId,
      senderId: currentUser.uid,
      senderName: teacherDisplayName(),
      senderRole: "teacher",
      text: `${group.groupName} group chat is ready.`,
      createdAt,
      groupId: group.id,
      groupName: group.groupName,
      type: "system",
    });

    await Promise.all(
      participants
        .filter((userId) => userId !== currentUser.uid)
        .map((userId) =>
          createNotification({
            userId,
            type: "group-chat",
            title: `New group chat: ${group.groupName}`,
            body: `${teacherDisplayName()} created a group chat for ${group.groupName}.`,
            page: "chat",
            threadId,
            groupId: group.id,
            partnerId: currentUser.uid,
          })
        )
    );

    return {
      id: threadId,
      groupId: group.id,
      participants,
    };
  }

  function chatStudents() {
    const uniqueStudents = new Map();

    groupsCache.forEach((group) => {
      (group.studentIds || []).forEach((identifier) => {
        const profile = studentProfileByIdentifier(identifier);
        if (!profile?.id) return;

        const student = studentDisplay(identifier);
        const existing = uniqueStudents.get(profile.id);

        if (existing) {
          existing.groupNames.add(group.groupName);
          return;
        }

        uniqueStudents.set(profile.id, {
          id: profile.id,
          name: profile.name || student.name,
          email: profile.email || student.identifier,
          rollNumber: profile.rollNumber || student.rollNumber,
          section: profile.section || student.section,
          department: profile.department || student.department,
          groupNames: new Set([group.groupName]),
        });
      });
    });

    return [...uniqueStudents.values()]
      .map((student) => ({
        ...student,
        groupLabel: [...student.groupNames].join(", "),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function chatStudentById(studentId) {
    return chatStudents().find((student) => student.id === studentId) || null;
  }

  function threadForStudent(studentId) {
    const threadId = buildThreadKey(currentUser?.uid, studentId);
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
      : threadForStudent(activeChatStudentId);
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
      activeChatStudentId &&
      chatStudentById(activeChatStudentId)
    ) {
      return;
    }

    const groups = groupChatThreads();
    if (groups.length) {
      activeChatMode = "group";
      activeGroupChatId = groups[0].groupId;
      activeChatStudentId = "";
      return;
    }

    const contacts = chatStudents();
    if (contacts.length) {
      activeChatMode = "direct";
      activeChatStudentId = contacts[0].id;
      activeGroupChatId = "";
      return;
    }

    activeChatMode = "group";
    activeGroupChatId = "";
    activeChatStudentId = "";
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

  function renderNotifications() {
    const list = $("#notificationList");
    const empty = $("#notificationEmpty");

    if (!list || !empty) return;

    const notifications = [...notificationsCache].sort(
      (a, b) => toTime(b.createdAt) - toTime(a.createdAt)
    );

    if (!notifications.length) {
      list.innerHTML = "";
      empty.classList.remove("d-none");
      return;
    }

    empty.classList.add("d-none");

    list.innerHTML = notifications
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
    $("#notificationBadge")?.classList.toggle("d-none", unreadCount === 0);
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
    const unreadNotifications = notificationsCache.filter((item) => !item.isRead);
    if (!unreadNotifications.length) return;

    await Promise.all(
      unreadNotifications.map((notification) =>
        updateDoc(fsDoc(db, "notifications", notification.id), {
          isRead: true,
          readAt: Date.now(),
        })
      )
    );
  }

  function renderChatContacts() {
    ensureDefaultChatSelection();

    const groups = groupChatThreads();
    const contacts = chatStudents();
    const list = $("#chatContactsList");
    const empty = $("#chatContactsEmpty");

    if (!list || !empty) return;

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
                      thread.groupName || groupById(thread.groupId)?.groupName || "Group Chat"
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
          .map((student) => {
            const thread = threadForStudent(student.id);
            const unreadCount = notificationsCache.filter(
              (notification) =>
                !notification.isRead &&
                notification.type === "chat" &&
                notification.partnerId === student.id
            ).length;

            return `
              <button
                type="button"
                class="chat-contact ${
                  activeChatMode === "direct" && student.id === activeChatStudentId
                    ? "active"
                    : ""
                }"
                data-chat-student="${student.id}"
              >
                <div class="chat-avatar">${escapeHtml(getInitials(student.name, "ST"))}</div>
                <div class="chat-contact-main">
                  <div class="chat-contact-top">
                    <span class="chat-contact-name">${escapeHtml(student.name)}</span>
                    <span class="chat-meta">${escapeHtml(
                      thread?.updatedAt
                        ? formatRelativeTime(thread.updatedAt)
                        : student.rollNumber || "Student"
                    )}</span>
                  </div>
                  <div class="chat-contact-meta">${escapeHtml(
                    student.groupLabel || student.department || "Student"
                  )}</div>
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
    const student = isGroupChat ? null : chatStudentById(activeChatStudentId);
    const partnerAvatar = $("#chatPartnerAvatar");
    const partnerName = $("#chatPartnerName");
    const partnerMeta = $("#chatPartnerMeta");
    const messages = $("#chatMessages");
    const emptyPanel = $("#chatEmptyPanel");
    const form = $("#chatForm");

    if (!partnerAvatar || !partnerName || !partnerMeta || !messages || !emptyPanel || !form) {
      return;
    }

    if (isGroupChat && thread) {
      partnerAvatar.innerHTML = '<i class="bi bi-people-fill"></i>';
      partnerName.textContent =
        thread.groupName || groupById(thread.groupId)?.groupName || "Group Chat";
      partnerMeta.textContent = [
        `${(thread.participants || []).length} members`,
        groupById(thread.groupId)?.groupName || "Class group",
      ]
        .filter(Boolean)
        .join(" • ");
    }

    if (isGroupChat && !thread) {
      partnerAvatar.textContent = "GC";
      partnerName.textContent = "Select a conversation";
      partnerMeta.textContent =
        "Choose a group chat or a direct message from the left to open it.";
      messages.classList.add("d-none");
      form.classList.add("d-none");
      emptyPanel.classList.remove("d-none");
      return;
    }

    if (!student && !isGroupChat) {
      partnerAvatar.textContent = "ST";
      partnerName.textContent = "Select a student";
      partnerMeta.textContent = "Choose a student from the left to open the conversation.";
      messages.classList.add("d-none");
      form.classList.add("d-none");
      emptyPanel.classList.remove("d-none");
      return;
    }

    if (!isGroupChat && student) {
      partnerAvatar.textContent = getInitials(student.name, "ST");
      partnerName.textContent = student.name;
      partnerMeta.textContent = [student.rollNumber, student.groupLabel || student.department]
        .filter(Boolean)
        .join(" • ");
    }

    messages.classList.remove("d-none");
    form.classList.remove("d-none");
    emptyPanel.classList.add("d-none");

    if (!activeChatMessages.length) {
      messages.innerHTML = `
        <div class="chat-thread-empty">
          <div>
            <i class="bi ${isGroupChat ? "bi-people-fill" : "bi-chat-quote"} fs-2 d-block mb-2"></i>
            <h6 class="mb-1">No messages yet</h6>
            <p class="mb-0 small">${
              isGroupChat
                ? `Send the first message to ${escapeHtml(
                    thread?.groupName || "this group"
                  )}.`
                : `Send the first message to ${escapeHtml(student.name)}.`
            }</p>
          </div>
        </div>
      `;
      return;
    }

    messages.innerHTML = activeChatMessages
      .sort((a, b) => toTime(a.createdAt) - toTime(b.createdAt))
      .map((message) =>
        renderChatMessageHtml(message, {
          showSender: isGroupChat,
        })
      )
      .join("");

    messages.scrollTop = messages.scrollHeight;
  }

  function renderChatPage() {
    ensureDefaultChatSelection();
    renderChatContacts();
    renderChatThread();
  }

  function syncActiveChatThread() {
    if (!currentUser?.uid) {
      activeChatThreadId = "";
      activeChatMessages = [];
      if (activeChatMessagesUnsub) {
        activeChatMessagesUnsub();
        activeChatMessagesUnsub = null;
      }
      renderChatPage();
      return;
    }

    const thread = activeConversationThread();
    const expectedThreadId =
      activeChatMode === "group"
        ? buildGroupChatKey(activeGroupChatId)
        : buildThreadKey(currentUser.uid, activeChatStudentId);

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
    activeChatStudentId = "";
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

  async function openChatWithStudent(studentId, focusPage = false) {
    activeChatMode = "direct";
    activeChatStudentId = studentId;
    activeGroupChatId = "";
    syncActiveChatThread();

    await Promise.all(
      notificationsCache
        .filter(
          (notification) =>
            !notification.isRead &&
            notification.type === "chat" &&
            notification.partnerId === studentId
        )
        .map((notification) => markNotificationRead(notification.id))
    );

    if (focusPage) showPage("chat");
    else renderChatPage();
  }

  async function ensureChatThread(studentId) {
    const threadId = buildThreadKey(currentUser.uid, studentId);
    const existingThread = threadForStudent(studentId);

    if (existingThread) return existingThread;

    await setDoc(fsDoc(db, "chatThreads", threadId), {
      participantKey: threadId,
      participants: [currentUser.uid, studentId],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastMessage: "",
      lastMessageSenderId: "",
      lastMessageSenderName: "",
    });

    return {
      id: threadId,
      participantKey: threadId,
      participants: [currentUser.uid, studentId],
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
            body: `${teacherDisplayName()}: ${text}`,
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

    const input = $("#chatMessageInput");
    const text = input?.value.trim();

    if (!text) return;

    if (activeChatMode === "group") {
      const thread = groupChatThreadByGroupId(activeGroupChatId);
      if (!thread) return;

      const createdAt = Date.now();

      await addDoc(collection(db, "chatThreads", thread.id, "messages"), {
        threadId: thread.id,
        senderId: currentUser.uid,
        senderName: teacherDisplayName(),
        senderRole: "teacher",
        text,
        createdAt,
        groupId: thread.groupId,
        groupName: thread.groupName || groupById(thread.groupId)?.groupName || "",
      });

      await updateDoc(fsDoc(db, "chatThreads", thread.id), {
        updatedAt: createdAt,
        lastMessage: text,
        lastMessageSenderId: currentUser.uid,
        lastMessageSenderName: teacherDisplayName(),
      });

      await notifyGroupChatParticipants(thread, text);

      if (input) input.value = "";
      return;
    }

    const student = chatStudentById(activeChatStudentId);
    if (!student) return;

    const thread = await ensureChatThread(student.id);
    const createdAt = Date.now();

    await addDoc(collection(db, "chatThreads", thread.id, "messages"), {
      threadId: thread.id,
      senderId: currentUser.uid,
      senderName: teacherDisplayName(),
      senderRole: "teacher",
      receiverId: student.id,
      text,
      createdAt,
    });

    await updateDoc(fsDoc(db, "chatThreads", thread.id), {
      updatedAt: createdAt,
      lastMessage: text,
      lastMessageSenderId: currentUser.uid,
      lastMessageSenderName: teacherDisplayName(),
    });

    await createNotification({
      userId: student.id,
      type: "chat",
      title: `New message from ${teacherDisplayName()}`,
      body: text,
      page: "chat",
      partnerId: currentUser.uid,
      threadId: thread.id,
    });

    if (input) input.value = "";
  }

  async function notifyStudentsForAssignment(assignment, group) {
    const users = new Map();

    for (const identifier of group?.studentIds || []) {
      const docs = await findUserDocsByIdentifier(identifier);
      docs.forEach((docSnap) => {
        const data = docSnap.data();
        if (data.role === "student") {
          users.set(docSnap.id, { id: docSnap.id, ...data });
        }
      });
    }

    await Promise.all(
      [...users.values()].map((student) =>
        createNotification({
          userId: student.id,
          type: "assignment",
          title: `New assignment: ${assignment.title}`,
          body: `${group.groupName} • Due ${fmtDate(assignment.deadline)}`,
          page: "assignments",
          assignmentId: assignment.id,
          partnerId: currentUser.uid,
        })
      )
    );
  }

  async function notifyStudentReviewUpdate(submission, assignment, title, body) {
    if (!submission || !assignment) return;

    const users = [];
    const docs = await findUserDocsByIdentifier(submission.studentId);

    docs.forEach((docSnap) => {
      const data = docSnap.data();
      if (data.role === "student") {
        users.push({ id: docSnap.id, ...data });
      }
    });

    await Promise.all(
      users.map((student) =>
        createNotification({
          userId: student.id,
          type: "review",
          title,
          body,
          page: "status",
          assignmentId: assignment.id,
          partnerId: currentUser.uid,
        })
      )
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
      await refreshAllData();
      await openGroupChat(notification.groupId, true);
    } else if (notification.type === "chat" && notification.partnerId) {
      await refreshAllData();
      await openChatWithStudent(notification.partnerId, true);
    } else {
      await refreshAllData();
      if (notification.assignmentId) {
        openAssignmentReview(notification.assignmentId);
      } else {
        showPage(notification.page || "overview");
      }
    }

    bootstrap.Offcanvas.getInstance($("#notificationDrawer"))?.hide();
  }

  function applyPageMeta(page) {
    const meta = PAGE_META[page];
    if (!meta) return;

    $("#pageTitle").textContent = meta.title;
    $("#pageSub").textContent = meta.sub;
  }

  function renderPageContent(page) {
    if (page === "overview") renderOverview();
    if (page === "groups") renderGroups();
    if (page === "assignments") renderAssignmentsPage();
    if (page === "tracking") renderTracking();
    if (page === "saved") renderSaved();
    if (page === "chat") renderChatPage();
  }

  function pageFromHash() {
    const hash = (location.hash || "#overview").slice(1);
    return PAGE_META[hash] ? hash : "overview";
  }

  function closeSidebar() {
    $("#sidebar")?.classList.remove("show");
    $("#sidebarBackdrop")?.classList.remove("show");
  }

  function showPage(page) {
    if (!PAGE_META[page]) return;

    $$(".page").forEach((section) => {
      section.classList.toggle("d-none", section.dataset.page !== page);
    });

    $$(".sidebar-nav .nav-item").forEach((navItem) => {
      navItem.classList.toggle("active", navItem.dataset.page === page);
    });

    applyPageMeta(page);
    renderPageContent(page);

    if (location.hash !== `#${page}`) {
      history.replaceState(null, "", `#${page}`);
    }

    window.scrollTo({ top: 0, behavior: "smooth" });
    closeSidebar();
  }

  function renderCurrentPage() {
    const page = pageFromHash();
    applyPageMeta(page);
    renderNotifications();
    updateNotificationBadge();
    renderPageContent(page);
  }

  function openGroupAssignments(groupId) {
    const group = groupById(groupId);
    if (!group) return;

    selectedGroupId = group.id;
    selectedAssignmentId = assignmentsForGroup(group.id)[0]?.id || "";
    showPage("assignments");
  }

  function openAssignmentReview(assignmentId) {
    const assignment = assignmentById(assignmentId);
    if (!assignment) return;

    selectedGroupId = assignment.groupId;
    selectedAssignmentId = assignment.id;
    showPage("assignments");
  }

  async function loadTeacherProfile() {
    if (!currentUser) return;

    const snap = await getDoc(fsDoc(db, "users", currentUser.uid));
    teacherProfile = snap.exists() ? snap.data() : null;
    setTeacherHeader();
  }

  async function loadGroups() {
    if (!currentUser) return;

    const snap = await getDocs(
      query(collection(db, "groups"), where("teacherId", "==", currentUser.uid))
    );

    groupsCache = snap.docs
      .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
      .sort((a, b) => toTime(b.createdAt) - toTime(a.createdAt));
  }

  function watchAssignments() {
    if (assignmentsUnsub) assignmentsUnsub();
    if (!currentUser) return;

    assignmentsUnsub = onSnapshot(
      query(collection(db, "assignments"), where("createdBy", "==", currentUser.uid)),
      (snap) => {
        assignmentsCache = snap.docs
          .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
          .sort((a, b) => toTime(b.createdAt) - toTime(a.createdAt));
        renderCurrentPage();
      }
    );
  }

  function watchSubmissions() {
    if (submissionsUnsub) submissionsUnsub();
    if (!currentUser) return;

    submissionsUnsub = onSnapshot(
      query(collection(db, "submissions"), where("teacherId", "==", currentUser.uid)),
      (snap) => {
        submissionsCache = snap.docs
          .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
          .sort((a, b) => toTime(b.createdAt) - toTime(a.createdAt));
        renderCurrentPage();
      }
    );
  }

  async function refreshAllData() {
    await Promise.all([loadGroups()]);
    await loadStudentProfiles();
    syncSelections();

    const contacts = chatStudents();
    if (!activeChatStudentId && contacts.length) {
      activeChatStudentId = contacts[0].id;
    }
  }

  async function patchSubmission(submissionId, changes) {
    const index = submissionsCache.findIndex(
      (submission) => submission.id === submissionId
    );
    if (index === -1) return;

    const previous = { ...submissionsCache[index] };
    const patch = {
      ...changes,
      updatedAt: Date.now(),
    };

    submissionsCache[index] = {
      ...submissionsCache[index],
      ...patch,
    };
    renderCurrentPage();

    try {
      await updateDoc(fsDoc(db, "submissions", submissionId), patch);
    } catch (error) {
      submissionsCache[index] = previous;
      renderCurrentPage();
      alert(error.message);
    }
  }

  async function patchAssignment(assignmentId, changes, toastMessage = "") {
    const index = assignmentsCache.findIndex(
      (assignment) => assignment.id === assignmentId
    );
    if (index === -1) return;

    const previous = { ...assignmentsCache[index] };
    assignmentsCache[index] = {
      ...assignmentsCache[index],
      ...changes,
    };
    renderCurrentPage();

    try {
      await updateDoc(fsDoc(db, "assignments", assignmentId), changes);
      if (toastMessage) showToast(toastMessage);
    } catch (error) {
      assignmentsCache[index] = previous;
      renderCurrentPage();
      alert(error.message);
    }
  }

  async function toggleSubmissionChecked(submissionId) {
    const submission = submissionsCache.find((item) => item.id === submissionId);
    if (!submission) return;

    const assignment = assignmentById(submission.assignmentId);
    const meta = submissionStatusMeta(submission, assignment);
    if (!meta.isSubmitted) return;

    const nextChecked = !submission.reviewChecked;

    await patchSubmission(submissionId, {
      reviewChecked: nextChecked,
    });

    if (nextChecked) {
      await notifyStudentReviewUpdate(
        submission,
        assignment,
        `Reviewed: ${assignment.title}`,
        `Your submission for ${assignment.title} has been checked by ${teacherDisplayName()}.`
      );
    }
  }

  async function updateSubmissionMarks(submissionId, rawValue) {
    const submission = submissionsCache.find((item) => item.id === submissionId);
    if (!submission) return;

    const assignment = assignmentById(submission.assignmentId);
    const meta = submissionStatusMeta(submission, assignment);
    if (!meta.isSubmitted) return;

    const nextMarks = parseMarksValue(rawValue);
    if (nextMarks === submission.marks) return;

    await patchSubmission(submissionId, {
      marks: nextMarks,
    });

    if (nextMarks != null) {
      await notifyStudentReviewUpdate(
        submission,
        assignment,
        `Marks updated: ${assignment.title}`,
        `Your submission for ${assignment.title} has been marked with ${nextMarks}.`
      );
    }
  }

  async function saveAssignmentReview(assignmentId) {
    const assignment = assignmentById(assignmentId);
    if (!assignment) return;

    await patchAssignment(
      assignmentId,
      {
        savedAt: Date.now(),
        savedBy: currentUser?.uid || "",
      },
      `Saved review for "${assignment.title}".`
    );
  }

  async function handleTeacherProfileSave(event) {
    event.preventDefault();
    event.stopPropagation();

    const form = event.currentTarget;

    if (!form.checkValidity()) {
      form.classList.add("was-validated");
      return;
    }

    const name = $("#teacherProfileName").value.trim();
    const department = $("#teacherProfileDepartment").value.trim();

    try {
      await updateDoc(fsDoc(db, "users", currentUser.uid), {
        name,
        department,
      });

      teacherProfile = {
        ...(teacherProfile || {}),
        name,
        department,
        email: teacherProfile?.email || currentUser?.email || "",
      };

      setTeacherHeader();
      renderTeacherProfileModal();
      renderCurrentPage();
      setTeacherProfileModalMode("view");
      showToast("Teacher profile updated.");
    } catch (error) {
      alert(error.message);
    }
  }

  async function deleteSubmissionAssets(submission) {
    const storagePath = submission?.submissionFile?.storagePath || submission?.storagePath || "";
    if (!storagePath) return;
    await deleteStoredFile(storagePath).catch(() => {});
  }

  async function deleteAssignmentAssets(assignment) {
    const storagePath =
      assignment?.attachment?.storagePath || assignment?.attachmentStoragePath || "";
    if (!storagePath) return;
    await deleteStoredFile(storagePath).catch(() => {});
  }

  async function deleteChatThread(threadId) {
    if (!threadId) return;

    const messageSnap = await getDocs(collection(db, "chatThreads", threadId, "messages"));
    for (const docSnap of messageSnap.docs) {
      await deleteDoc(docSnap.ref);
    }

    await deleteDoc(fsDoc(db, "chatThreads", threadId)).catch(() => {});
  }

  async function removeStudentFromGroup(groupId, studentIdentifier) {
    const group = groupById(groupId);
    if (!group) {
      alert("Group not found.");
      return;
    }

    if ((group.studentIds || []).length <= 1) {
      alert("This is the last student in the group. Delete the group instead.");
      return;
    }

    if (!confirm(`Remove ${studentIdentifier} from "${group.groupName}"?`)) {
      return;
    }

    try {
      const originalIdentifier = String(studentIdentifier || "").trim();
      const normalizedIdentifier = normalizeIdentifier(studentIdentifier);
      const storedIdentifier =
        (group.studentIds || []).find(
          (identifier) => normalizeIdentifier(identifier) === normalizedIdentifier
        ) || originalIdentifier;
      const groupRef = fsDoc(db, "groups", groupId);
      const groupThread = groupChatThreadByGroupId(groupId);
      const removedUserIds = [];

      const submissionSnap = await getDocs(
        query(collection(db, "submissions"), where("groupId", "==", groupId))
      );

      for (const docSnap of submissionSnap.docs) {
        if (normalizeIdentifier(docSnap.data().studentId) === normalizedIdentifier) {
          await deleteSubmissionAssets(docSnap.data());
          await deleteDoc(docSnap.ref);
        }
      }

      const userDocs = await findUserDocsByIdentifier(normalizedIdentifier);
      for (const userDoc of userDocs) {
        const nextGroupPatch = {
          groupIds: arrayRemove(groupId),
        };

        if (userDoc.data().groupId === groupId) {
          nextGroupPatch.groupId = "";
        }

        removedUserIds.push(userDoc.id);
        await updateDoc(userDoc.ref, nextGroupPatch);
      }

      await updateDoc(groupRef, {
        studentIds: arrayRemove(storedIdentifier),
        studentCount: Math.max((group.studentIds || []).length - 1, 0),
      });

      if (groupThread) {
        const threadPatch = {
          participantIdentifiers: arrayRemove(storedIdentifier),
        };

        if (removedUserIds.length) {
          threadPatch.participants = arrayRemove(...removedUserIds);
          threadPatch.participantCount = Math.max(
            (groupThread.participants || []).length - removedUserIds.length,
            1
          );
        }

        await updateDoc(fsDoc(db, "chatThreads", groupThread.id), threadPatch).catch(
          () => {}
        );
      }

      showToast(`${studentIdentifier} removed from "${group.groupName}".`);
      await refreshAllData();
      renderCurrentPage();
      openGroupModal(groupId);
    } catch (error) {
      alert(error.message);
    }
  }

  async function deleteGroup(groupId) {
    const group = groupById(groupId);
    if (!group) {
      alert("Group not found.");
      return;
    }

    if (!confirm(`Delete group "${group.groupName}"? This will also remove its assignments.`)) {
      return;
    }

    try {
      const groupRef = fsDoc(db, "groups", groupId);

      const submissionSnap = await getDocs(
        query(collection(db, "submissions"), where("groupId", "==", groupId))
      );
      for (const docSnap of submissionSnap.docs) {
        await deleteSubmissionAssets(docSnap.data());
        await deleteDoc(docSnap.ref);
      }

      const assignmentSnap = await getDocs(
        query(collection(db, "assignments"), where("groupId", "==", groupId))
      );
      for (const docSnap of assignmentSnap.docs) {
        await deleteAssignmentAssets(docSnap.data());
        await deleteDoc(docSnap.ref);
      }

      for (const identifier of group.studentIds || []) {
        const userDocs = await findUserDocsByIdentifier(identifier);
        for (const userDoc of userDocs) {
          const nextGroupPatch = {
            groupIds: arrayRemove(groupId),
          };

          if (userDoc.data().groupId === groupId) {
            nextGroupPatch.groupId = "";
          }

          await updateDoc(userDoc.ref, nextGroupPatch);
        }
      }

      await deleteChatThread(buildGroupChatKey(groupId));

      await deleteDoc(groupRef);

      bootstrap.Modal.getInstance($("#groupModal"))?.hide();
      showToast(`Group "${group.groupName}" deleted.`);

      if (selectedGroupId === groupId) {
        selectedGroupId = "";
        selectedAssignmentId = "";
      }

      await refreshAllData();
      showPage("groups");
    } catch (error) {
      alert(error.message);
    }
  }

  async function deleteAssignment(assignmentId) {
    const assignment = assignmentById(assignmentId);
    if (!assignment) {
      alert("Assignment not found.");
      return;
    }

    if (!confirm(`Delete assignment "${assignment.title}"? This will remove all submissions.`)) {
      return;
    }

    try {
      const subSnap = await getDocs(
        query(collection(db, "submissions"), where("assignmentId", "==", assignmentId))
      );

      for (const docSnap of subSnap.docs) {
        await deleteSubmissionAssets(docSnap.data());
        await deleteDoc(docSnap.ref);
      }

      await deleteAssignmentAssets(assignment);
      await deleteDoc(fsDoc(db, "assignments", assignmentId));

      if (selectedAssignmentId === assignmentId) {
        selectedAssignmentId = "";
      }

      showToast(`Assignment "${assignment.title}" deleted.`);
      await refreshAllData();
      showPage("assignments");
    } catch (error) {
      alert(error.message);
    }
  }

  async function handleGroupCreate(event) {
    event.preventDefault();
    event.stopPropagation();

    const form = event.currentTarget;
    const name = $("#groupName").value.trim();
    const studentIds = normalizeList($("#groupStudents").value);

    if (!name) {
      alert("Group name is required.");
      return;
    }

    if (!studentIds.length) {
      alert("Please add at least one student to the group.");
      return;
    }

    await loadGroups();

    const duplicate = groupsCache.some(
      (group) => normalizeGroupName(group.groupName) === normalizeGroupName(name)
    );
    if (duplicate) {
      alert("A group with this name already exists. Please use a different name.");
      return;
    }

    if (!form.checkValidity()) {
      form.classList.add("was-validated");
      return;
    }

    try {
      const groupRef = await addDoc(collection(db, "groups"), {
        groupName: name,
        groupNameNormalized: normalizeGroupName(name),
        teacherId: currentUser.uid,
        studentIds,
        studentCount: studentIds.length,
        createdAt: Date.now(),
      });

      const batch = writeBatch(db);
      const groupParticipantIds = [];

      for (const identifier of studentIds) {
        const userDocs = await findUserDocsByIdentifier(identifier);
        userDocs.forEach((userDoc) => {
          groupParticipantIds.push(userDoc.id);
          batch.update(userDoc.ref, {
            groupId: groupRef.id,
            groupIds: arrayUnion(groupRef.id),
          });
        });
      }

      await batch.commit().catch(() => {});
      await createGroupChatForGroup(
        {
          id: groupRef.id,
          groupName: name,
          studentIds,
        },
        groupParticipantIds
      );

      form.reset();
      form.classList.remove("was-validated");

      showToast(`Group "${name}" created with ${studentIds.length} students.`);
      await refreshAllData();
      showPage("groups");
    } catch (error) {
      alert(error.message);
    }
  }

  async function handleAssignmentCreate(event) {
    event.preventDefault();
    event.stopPropagation();

    const form = event.currentTarget;
    const openDate = $("#aOpen").value;
    const deadline = $("#aDeadline").value;

    let valid = form.checkValidity();
    if (openDate && deadline && new Date(deadline) < new Date(openDate)) {
      $("#aDeadline").setCustomValidity("Deadline must be on or after the open date.");
      $("#aDeadline").reportValidity();
      valid = false;
    } else {
      $("#aDeadline").setCustomValidity("");
    }

    if (!valid) {
      form.classList.add("was-validated");
      return;
    }

    const title = $("#aTitle").value.trim();
    const subject = $("#aSubject").value.trim();
    const groupId = $("#aGroup").value;
    const description = $("#aDesc").value.trim();
    const attachmentFile = $("#aAttachment").files?.[0] || null;
    const fileError = attachmentFile ? validatePdfFile(attachmentFile) : "";

    const group = groupById(groupId);
    if (!group) {
      alert("Please choose a valid group.");
      return;
    }

    if (!(group.studentIds || []).length) {
      alert("This group has no students yet.");
      return;
    }

    if (fileError) {
      alert(fileError);
      return;
    }

    let uploadedAttachment = null;
    let assignmentRef = null;
    let assignmentCreated = false;
    try {
      assignmentRef = fsDoc(collection(db, "assignments"));

      if (attachmentFile) {
        uploadedAttachment = await uploadPdfFile(
          ["assignments", currentUser.uid, assignmentRef.id],
          attachmentFile
        );
      }

      const createdAt = Date.now();
      const attachment = buildStoredPdfRecord(uploadedAttachment, createdAt);

      await setDoc(assignmentRef, {
        title,
        subject,
        description,
        groupId,
        groupName: group.groupName,
        openDate,
        deadline,
        createdBy: currentUser.uid,
        createdAt,
        savedAt: null,
        savedBy: "",
        attachmentUrl: uploadedAttachment?.downloadURL || "",
        attachmentName: uploadedAttachment?.fileName || "",
        attachmentSize: uploadedAttachment?.size || 0,
        attachmentType: uploadedAttachment?.contentType || "",
        attachmentStoragePath: uploadedAttachment?.storagePath || "",
        attachment,
      });

      const batch = writeBatch(db);

      (group.studentIds || []).forEach((studentId) => {
        const subRef = fsDoc(collection(db, "submissions"));
        batch.set(subRef, {
          assignmentId: assignmentRef.id,
          teacherId: currentUser.uid,
          groupId,
          studentId,
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
        });
      });

      await batch.commit();
      assignmentCreated = true;

      form.reset();
      form.classList.remove("was-validated");
      $("#aDeadline").setCustomValidity("");

      $("#aOpen").value = new Date().toISOString().slice(0, 10);
      const nextWeek = new Date();
      nextWeek.setDate(nextWeek.getDate() + 7);
      $("#aDeadline").value = nextWeek.toISOString().slice(0, 10);

      selectedGroupId = groupId;
      selectedAssignmentId = assignmentRef.id;

      await notifyStudentsForAssignment(
        {
          id: assignmentRef.id,
          title,
          deadline,
        },
        group
      ).catch(() => {});

      showToast(`Assignment "${title}" created for ${group.groupName}.`);
      await refreshAllData();
      showPage("assignments");
    } catch (error) {
      if (!assignmentCreated && assignmentRef?.id) {
        await deleteDoc(assignmentRef).catch(() => {});
      }
      if (!assignmentCreated && uploadedAttachment?.storagePath) {
        await deleteStoredFile(uploadedAttachment.storagePath).catch(() => {});
      }
      alert(formatFirebaseUploadError(error, "create this assignment"));
    }
  }

  function drawPdfTableHeader(doc, topY) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text("Roll", 40, topY);
    doc.text("Name", 95, topY);
    doc.text("Status", 300, topY);
    doc.text("Checked", 395, topY);
    doc.text("Marks", 470, topY);
    doc.line(40, topY + 8, 555, topY + 8);
  }

  function downloadAssignmentPdf(assignmentId) {
    const assignment = assignmentById(assignmentId);
    if (!assignment) {
      alert("Assignment not found.");
      return;
    }

    const jsPdfApi = window.jspdf?.jsPDF;
    if (!jsPdfApi) {
      alert("PDF export is not available right now.");
      return;
    }

    const group = groupById(assignment.groupId);
    const stats = assignmentStats(assignment);
    const rows = buildReviewRows(assignment);
    const doc = new jsPdfApi({ unit: "pt", format: "a4" });
    const pageHeight = doc.internal.pageSize.getHeight();
    let y = 40;

    const ensureRoom = (space, withHeader = false) => {
      if (y + space <= pageHeight - 40) return;
      doc.addPage();
      y = 40;
      if (withHeader) {
        drawPdfTableHeader(doc, y);
        y += 24;
      }
    };

    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text(assignment.title, 40, y);
    y += 20;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text(`Group: ${group?.groupName || "—"}`, 40, y);
    y += 14;
    doc.text(`Subject: ${assignment.subject || "—"}`, 40, y);
    y += 14;
    doc.text(`Deadline: ${fmtDate(assignment.deadline)}`, 40, y);
    y += 14;
    doc.text(
      `Summary: ${stats.submitted}/${stats.total} submitted, ${stats.checked}/${stats.submitted || 0} checked, ${stats.marked}/${stats.submitted || 0} marked`,
      40,
      y
    );
    y += 14;
    doc.text(
      `Saved: ${assignment.savedAt ? fmtDateTime(assignment.savedAt) : "Not saved"}`,
      40,
      y
    );
    y += 24;

    drawPdfTableHeader(doc, y);
    y += 24;

    rows.forEach(({ student, submission, meta }) => {
      ensureRoom(36, true);

      const nameLines = doc.splitTextToSize(student.name, 180);
      const lineHeight = Math.max(nameLines.length * 11, 16);

      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.text(student.rollNumber || "—", 40, y);
      doc.text(nameLines, 95, y);
      doc.text(meta.label, 300, y);
      doc.text(
        submission?.reviewChecked ? "Checked" : meta.isSubmitted ? "Open" : "—",
        395,
        y
      );
      doc.text(
        hasMarks(submission?.marks) ? String(submission.marks) : "—",
        470,
        y
      );

      doc.setFontSize(8);
      doc.setTextColor(107, 114, 128);
      doc.text(student.identifier || "—", 95, y + lineHeight);
      doc.text(
        submission?.submittedAt ? fmtDateTime(submission.submittedAt) : "Not submitted",
        300,
        y + lineHeight
      );
      doc.setTextColor(31, 41, 55);

      y += lineHeight + 14;
      doc.line(40, y, 555, y);
      y += 12;
    });

    doc.save(
      `${slugify(group?.groupName || "group")}-${slugify(assignment.title)}-review.pdf`
    );
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
    const openGroup = event.target.closest("[data-open-group]");
    const openAssignment = event.target.closest("[data-open-assignment]");
    const downloadAssignment = event.target.closest("[data-download-assignment]");
    const notificationButton = event.target.closest("[data-notification-id]");
    const profileAction = event.target.closest("[data-profile-action]");
    const chatGroupButton = event.target.closest("[data-chat-group]");
    const chatStudentButton = event.target.closest("[data-chat-student]");
    const toggleCheck = event.target.closest("[data-toggle-check]");
    const removeStudentBtn = event.target.closest(".remove-student-btn");
    const deleteGroupBtn = event.target.closest(".delete-group-btn");
    const deleteAssignmentBtn = event.target.closest(".delete-assignment-btn");

    if (profileAction) {
      event.preventDefault();
      openTeacherProfileModal(profileAction.dataset.profileAction || "view");
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

    if (chatStudentButton) {
      openChatWithStudent(chatStudentButton.dataset.chatStudent, true);
      return;
    }

    if (toggleCheck) {
      const submissionId = toggleCheck.dataset.toggleCheck;
      if (submissionId) toggleSubmissionChecked(submissionId);
      return;
    }

    if (downloadAssignment) {
      const assignmentId = downloadAssignment.dataset.downloadAssignment;
      if (assignmentId) downloadAssignmentPdf(assignmentId);
      return;
    }

    if (openAssignment) {
      openAssignmentReview(openAssignment.dataset.openAssignment);
      return;
    }

    if (openGroup) {
      openGroupAssignments(openGroup.dataset.openGroup);
      return;
    }

    if (deleteAssignmentBtn) {
      event.preventDefault();
      deleteAssignment(deleteAssignmentBtn.dataset.id);
      return;
    }

    if (removeStudentBtn) {
      event.preventDefault();
      removeStudentFromGroup(
        removeStudentBtn.dataset.group,
        decodeURIComponent(removeStudentBtn.dataset.student)
      );
      return;
    }

    if (deleteGroupBtn) {
      event.preventDefault();
      deleteGroup(deleteGroupBtn.dataset.group);
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

    const groupCard = event.target.closest(".group-card");
    if (groupCard) {
      openGroupModal(groupCard.dataset.group);
    }
  });

  document.addEventListener("change", (event) => {
    const marksInput = event.target.closest("[data-marks-submission]");
    if (marksInput) {
      updateSubmissionMarks(marksInput.dataset.marksSubmission, marksInput.value);
      return;
    }

    if (event.target.id === "assignmentGroupFilter") {
      selectedGroupId = event.target.value;
      selectedAssignmentId = assignmentsForGroup(selectedGroupId)[0]?.id || "";
      renderAssignmentsPage();
    }
  });

  $("#groupForm")?.addEventListener("submit", handleGroupCreate);
  $("#assignmentForm")?.addEventListener("submit", handleAssignmentCreate);
  $("#teacherProfileForm")?.addEventListener("submit", handleTeacherProfileSave);

  $("#assignmentForm")?.addEventListener("reset", () => {
    window.setTimeout(() => {
      refreshGroupSelects();
      $("#aOpen").value = new Date().toISOString().slice(0, 10);
      const nextWeek = new Date();
      nextWeek.setDate(nextWeek.getDate() + 7);
      $("#aDeadline").value = nextWeek.toISOString().slice(0, 10);
      if (selectedGroupId && $("#aGroup")) {
        $("#aGroup").value = selectedGroupId;
      }
    }, 0);
  });

  $("#assignmentSearch")?.addEventListener("input", renderAssignmentsPage);
  $("#trackSearch")?.addEventListener("input", renderTracking);
  $("#savedSearch")?.addEventListener("input", renderSaved);
  $("#chatForm")?.addEventListener("submit", sendChatMessage);
  $("#markAllNotifications")?.addEventListener("click", markAllNotificationsRead);

  $("#saveSelectedReview")?.addEventListener("click", () => {
    if (selectedAssignmentId) saveAssignmentReview(selectedAssignmentId);
  });

  $("#teacherProfileEditBtn")?.addEventListener("click", () => {
    renderTeacherProfileModal();
    setTeacherProfileModalMode("edit");
  });

  $("#downloadSelectedReview")?.addEventListener("click", () => {
    if (selectedAssignmentId) downloadAssignmentPdf(selectedAssignmentId);
  });

  $("#confirmLogout")?.addEventListener("click", async () => {
    bootstrap.Modal.getInstance($("#logoutModal"))?.hide();
    await handleLogout();
  });

  $("#sidebarToggle")?.addEventListener("click", () => {
    $("#sidebar")?.classList.add("show");
    $("#sidebarBackdrop")?.classList.add("show");
  });

  $("#sidebarBackdrop")?.addEventListener("click", closeSidebar);

  $("#teacherProfileModal")?.addEventListener("hidden.bs.modal", () => {
    setTeacherProfileModalMode("view");
  });

  window.addEventListener("hashchange", () => {
    showPage(pageFromHash());
  });

  $("#aOpen").value = new Date().toISOString().slice(0, 10);
  const initialDeadline = new Date();
  initialDeadline.setDate(initialDeadline.getDate() + 7);
  $("#aDeadline").value = initialDeadline.toISOString().slice(0, 10);

  onAuthStateChanged(auth, async (user) => {
    if (!user) return;

    currentUser = user;
    await loadTeacherProfile();
    await refreshAllData();
    watchAssignments();
    watchSubmissions();
    watchNotifications();
    watchChatThreads();
    showPage(pageFromHash());
  });
})();
