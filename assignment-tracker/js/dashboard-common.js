const THEME_STORAGE_KEY = "eduportal-dashboard-theme";

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

export function normalizeIdentifier(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return trimmed.includes("@") ? trimmed.toLowerCase() : trimmed.toUpperCase();
}

export function toTime(value) {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") return new Date(value).getTime() || 0;
  return 0;
}

export function fmtDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function fmtDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatRelativeTime(value) {
  if (!value) return "Just now";

  const diff = toTime(value) - Date.now();
  const minutes = Math.round(diff / 60000);

  if (Math.abs(minutes) < 1) return "Just now";

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  if (Math.abs(minutes) < 60) {
    return formatter.format(minutes, "minute");
  }

  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) {
    return formatter.format(hours, "hour");
  }

  const days = Math.round(hours / 24);
  if (Math.abs(days) < 7) {
    return formatter.format(days, "day");
  }

  return fmtDate(value);
}

export function buildThreadKey(userA, userB) {
  return [String(userA || ""), String(userB || "")]
    .filter(Boolean)
    .sort()
    .join("__");
}

export function buildGroupChatKey(groupId) {
  const cleaned = String(groupId || "").trim();
  return cleaned ? `group__${cleaned}` : "";
}

export function getInitials(value, fallback = "NA") {
  const initials = String(value || "")
    .trim()
    .split(/\s+/)
    .map((part) => part[0] || "")
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return initials || fallback;
}

export function initThemeToggle({
  buttonSelector = "#themeToggle",
  iconSelector = "#themeToggleIcon",
} = {}) {
  const button = document.querySelector(buttonSelector);
  const icon = document.querySelector(iconSelector);

  function updateThemeIcon(theme) {
    if (!icon) return;
    icon.className =
      theme === "dark" ? "bi bi-sun-fill" : "bi bi-moon-stars-fill";
  }

  function applyTheme(theme) {
    const nextTheme = theme === "dark" ? "dark" : "light";
    document.body.dataset.theme = nextTheme;
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    updateThemeIcon(nextTheme);
    if (button) {
      button.setAttribute(
        "aria-label",
        nextTheme === "dark" ? "Switch to light mode" : "Switch to dark mode"
      );
    }
  }

  const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  const preferredTheme =
    storedTheme ||
    (window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light");

  applyTheme(preferredTheme);

  button?.addEventListener("click", () => {
    applyTheme(document.body.dataset.theme === "dark" ? "light" : "dark");
  });

  return {
    applyTheme,
    getTheme: () => document.body.dataset.theme || "light",
  };
}
