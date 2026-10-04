/**
 * NeverLate Plaksha-Only — Popup Controller
 * Fixed single-site (Plaksha LMS) controller
 * Cache-first rendering,
 * calm semantic countdown timers, and zero auto-sync storms.
 */

document.addEventListener("DOMContentLoaded", async () => {
  let currentData = null;
  let currentBaseUrl = null;
  let currentSiteKey = null;
  let currentInstitutionName = "Plaksha University";
  let selectedCourseId = "all";
  let renderTimeout = null;
  let isSyncing = false;
  let completedDeadlines = {};
  let isCompletedExpanded = false;

  // DOM Elements
  const deadlinesList = document.getElementById("deadlines-list");
  const coursesList = document.getElementById("courses-list");
  const courseFilter = document.getElementById("course-filter");
  const exportMenuBtn = document.getElementById("export-menu-btn");
  const exportDropdownWrapper = document.getElementById("export-dropdown-wrapper");
  const exportPopover = document.getElementById("export-popover");
  const exportAllIcsBtn = document.getElementById("export-all-ics-btn");
  const exportNextGcalBtn = document.getElementById("export-next-gcal-btn");
  const exportNextOutlookBtn = document.getElementById("export-next-outlook-btn");
  const completedSection = document.getElementById("completed-section");
  const toggleCompletedBtn = document.getElementById("toggle-completed-btn");
  const completedList = document.getElementById("completed-list");
  const completedArrow = document.getElementById("completed-arrow");
  const completedCountLabel = document.getElementById("completed-count-label");
  const deadlinesEmpty = document.getElementById("deadlines-empty");
  const coursesEmpty = document.getElementById("courses-empty");
  const loggedOutState = document.getElementById("logged-out-state");
  const loggedOutDesc = document.getElementById("logged-out-desc");
  const loginPortalLink = document.getElementById("login-portal-link");
  const moodlePortalLink = document.getElementById("moodle-portal-link");
  const readySyncState = document.getElementById("ready-sync-state");
  const readySyncDesc = document.getElementById("ready-sync-desc");
  const initialSyncTrigger = document.getElementById("initial-sync-trigger");
  const deadlinesBadge = document.getElementById("deadlines-badge");
  const coursesBadge = document.getElementById("courses-badge");
  const userDisplay = document.getElementById("user-display");
  const statusDot = document.getElementById("status-dot");
  const statusText = document.getElementById("status-text");
  const lastSyncedTime = document.getElementById("last-synced-time");
  const syncBtn = document.getElementById("sync-btn");
  const syncBtnLabel = document.getElementById("sync-btn-label");
  const syncIcon = document.getElementById("sync-icon");
  const alertsToggle = document.getElementById("alerts-toggle");
  const alertsStatus = document.getElementById("alerts-status");
  const alertsCard = document.getElementById("alerts-card");
  const extrasRow = document.getElementById("extras-row");
  const extra6hBox = document.getElementById("extra-6h");
  const extra30mBox = document.getElementById("extra-30m");
  const segments = document.querySelectorAll(".segment");
  const viewPanes = document.querySelectorAll(".view-pane");

  const themeBtn = document.getElementById("theme-btn");
  const includeUrlToggle = document.getElementById("include-url-toggle");

  // Appearance Theme: System (default, follows OS) / Dark / Light.
  // The header button is a binary day/night toggle (not a 3-state cycle):
  // one click ALWAYS flips the effective appearance, so there is never a
  // "dead" first click that lands on a visually identical mode.
  const THEMES = ["system", "dark", "light"];
  const MOON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  const SUN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
  let currentTheme = "system";

  function isDarkEffective() {
    if (currentTheme === "dark") return true;
    if (currentTheme === "light") return false;
    try {
      return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    } catch (_) {
      return false;
    }
  }

  function applyTheme(theme) {
    currentTheme = THEMES.includes(theme) ? theme : "system";
    try {
      document.documentElement.dataset.theme = currentTheme;
    } catch (_) {}
    if (themeBtn) {
      const dark = isDarkEffective();
      themeBtn.innerHTML = dark ? SUN_SVG : MOON_SVG;
      themeBtn.title = dark ? "Switch to light mode" : "Switch to dark mode";
    }
  }

  async function loadTheme() {
    try {
      const s = await chrome.storage.local.get(["theme"]);
      if (s && typeof s.theme === "string" && THEMES.includes(s.theme)) {
        applyTheme(s.theme);
        return;
      }
    } catch (_) {}
    applyTheme("system");
  }

  // Single-click day/night flip based on what the user actually sees now.
  async function toggleTheme() {
    const next = isDarkEffective() ? "light" : "dark";
    applyTheme(next);
    try {
      await chrome.storage.local.set({ theme: next });
    } catch (_) {}
  }

  if (themeBtn) {
    themeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleTheme();
    });
  }
  loadTheme().catch(() => {});

  if (includeUrlToggle) {
    includeUrlToggle.addEventListener("change", () => {
      setIncludeUrlInCalendar(includeUrlToggle.checked);
    });
  }

  // HTML sanitization to prevent DOM-based XSS
  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .substring(0, 300)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Exact-origin HTTPS URL validator against active university domain
  function safeUrl(rawUrl) {
    return MoodleAPI.sanitizeMoodleUrl(rawUrl, currentBaseUrl);
  }

  // Stable per-site deadline identity (site + activity URL, event-ID fallback).
  // Prevents collisions across universities and scraper-vs-AJAX id formats.
  function completionKeyFor(item) {
    try {
      return MoodleAPI.getCompletionKey(item, currentSiteKey || currentBaseUrl);
    } catch (_) {
      return null;
    }
  }

  function isCompleted(item) {
    try {
      return MoodleAPI.isCompleted(item, completedDeadlines, currentSiteKey || currentBaseUrl);
    } catch (_) {
      return false;
    }
  }

  function showUnconfiguredState() {
    if (readySyncState) {
      readySyncState.classList.remove("hidden");
      const titleEl = readySyncState.querySelector(".empty-title");
      const descEl = document.getElementById("ready-sync-desc");
      if (titleEl) titleEl.textContent = "Connecting to Plaksha LMS";
      if (descEl) descEl.textContent = "Open Plaksha LMS in a tab and sync.";
      if (initialSyncTrigger) initialSyncTrigger.textContent = "Sync Plaksha LMS";
    }
    if (deadlinesList) deadlinesList.classList.add("hidden");
    if (deadlinesEmpty) deadlinesEmpty.classList.add("hidden");
    if (coursesList) coursesList.classList.add("hidden");
    if (coursesEmpty) coursesEmpty.classList.add("hidden");
    if (loggedOutState) loggedOutState.classList.add("hidden");
    if (userDisplay) userDisplay.textContent = "Plaksha LMS";
    if (statusText) statusText.textContent = "Not connected";
    if (statusDot) statusDot.className = "dot warning";
    if (deadlinesBadge) deadlinesBadge.textContent = "0";
    if (coursesBadge) coursesBadge.textContent = "0";
  }

  // Segmented Control Switcher
  segments.forEach((seg) => {
    seg.addEventListener("click", () => {
      const targetId = seg.getAttribute("data-tab");
      segments.forEach((s) => s.classList.remove("active"));
      viewPanes.forEach((p) => p.classList.remove("active"));
      seg.classList.add("active");
      const targetEl = document.getElementById(targetId);
      if (targetEl) targetEl.classList.add("active");
    });
  });

  /**
   * Calm Countdown formatting (Precedence Rules):
   * 1. now >= deadline -> PAST ("Deadline passed Xm ago")
   * 2. diff < 10m -> FINAL ("08:42" ticking)
   * 3. diff < 60m -> SOON ("42m left")
   * 4. Same calendar day -> TODAY ("7h 25m left")
   * 5. Next calendar day -> TOMORROW ("18h 25m left")
   * 6. <= 7 days -> UPCOMING ("3 days left")
   * 7. > 7 days -> UPCOMING ("Due Mon, Sep 18")
   */
  function formatCountdown(timesort) {
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);
    const deadlineSec = timesort;
    const diffSec = deadlineSec - nowSec;

    // 1. now >= deadline -> PAST ("Deadline passed Xm ago")
    if (diffSec <= 0) {
      const passedSec = Math.abs(diffSec);
      let passedText = "";
      if (passedSec < 60) {
        passedText = "Deadline passed <1m ago";
      } else if (passedSec < 3600) {
        const m = Math.floor(passedSec / 60);
        passedText = `Deadline passed ${m}m ago`;
      } else if (passedSec < 86400) {
        const h = Math.floor(passedSec / 3600);
        const remM = Math.floor((passedSec % 3600) / 60);
        passedText = remM > 0 ? `Deadline passed ${h}h ${remM}m ago` : `Deadline passed ${h}h ago`;
      } else {
        const d = Math.floor(passedSec / 86400);
        passedText = d === 1 ? "Deadline passed 1 day ago" : `Deadline passed ${d} days ago`;
      }
      return {
        pillText: passedText,
        pillClass: "pill-past",
        isImminent: false
      };
    }

    // 2. diff < 10m -> FINAL ("08:42" ticking)
    if (diffSec < 600) {
      const m = String(Math.floor(diffSec / 60)).padStart(2, "0");
      const s = String(diffSec % 60).padStart(2, "0");
      return {
        pillText: `${m}:${s}`,
        pillClass: "pill-final",
        isImminent: true
      };
    }

    // 3. diff < 60m -> SOON ("42m left")
    if (diffSec < 3600) {
      const remMins = Math.floor(diffSec / 60);
      return {
        pillText: `${remMins}m left`,
        pillClass: "pill-soon",
        isImminent: false
      };
    }

    const deadlineDate = new Date(deadlineSec * 1000);
    const isSameDay = (
      deadlineDate.getFullYear() === now.getFullYear() &&
      deadlineDate.getMonth() === now.getMonth() &&
      deadlineDate.getDate() === now.getDate()
    );

    const diffHours = Math.floor(diffSec / 3600);
    const remMins = Math.floor((diffSec % 3600) / 60);
    const hourMinStr = remMins > 0 ? `${diffHours}h ${remMins}m left` : `${diffHours}h left`;

    // 4. Same calendar day -> TODAY ("7h 25m left")
    if (isSameDay) {
      return {
        pillText: hourMinStr,
        pillClass: "pill-today",
        isImminent: false
      };
    }

    const tomorrowDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const isNextDay = (
      deadlineDate.getFullYear() === tomorrowDate.getFullYear() &&
      deadlineDate.getMonth() === tomorrowDate.getMonth() &&
      deadlineDate.getDate() === tomorrowDate.getDate()
    );

    // 5. Next calendar day -> TOMORROW ("18h 25m left")
    if (isNextDay) {
      return {
        pillText: hourMinStr,
        pillClass: "pill-tomorrow",
        isImminent: false
      };
    }

    // Calendar days diff
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfDeadlineDay = new Date(deadlineDate.getFullYear(), deadlineDate.getMonth(), deadlineDate.getDate()).getTime();
    const calendarDaysDiff = Math.round((startOfDeadlineDay - startOfToday) / (24 * 60 * 60 * 1000));

    // 6. <= 7 days -> UPCOMING ("3 days left")
    if (calendarDaysDiff <= 7) {
      const dayLabel = calendarDaysDiff === 1 ? "1 day left" : `${calendarDaysDiff} days left`;
      return {
        pillText: dayLabel,
        pillClass: "pill-upcoming",
        isImminent: false
      };
    }

    // 7. > 7 days -> UPCOMING ("Due Mon, Sep 18")
    const dateFormatted = deadlineDate.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric"
    });
    return {
      pillText: `Due ${dateFormatted}`,
      pillClass: "pill-upcoming",
      isImminent: false
    };
  }

  function scheduleNextRender(hasImminent) {
    if (renderTimeout) {
      clearTimeout(renderTimeout);
      renderTimeout = null;
    }
    // 1,000ms if any deadline on screen has < 10m remaining; 30,000ms otherwise
    const delay = hasImminent ? 1000 : 30000;
    renderTimeout = setTimeout(() => {
      renderDeadlines();
    }, delay);
  }

  function formatDateTime(timesort) {
    const d = new Date(timesort * 1000);
    const dateStr = d.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric"
    });
    const timeStr = d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit"
    });
    return `${dateStr} • ${timeStr}`;
  }

  // Toggle completion status of a deliverable (per-site stable key)
  async function toggleDeadlineDone(deadlineOrId) {
    const site = currentSiteKey || currentBaseUrl;
    let key = null;
    if (deadlineOrId && typeof deadlineOrId === "object") {
      key = completionKeyFor(deadlineOrId);
      // Legacy fallback for pre-2.2.1 Done marks (same site only).
      if (!key && deadlineOrId.id !== undefined) key = `${site}|event:${String(deadlineOrId.id)}`;
    } else {
      // Called with a raw id string (legacy call path): resolve against current list.
      const idStr = String(deadlineOrId || "");
      let resolved = null;
      if (currentData && Array.isArray(currentData.deadlines)) {
        resolved = currentData.deadlines.find((d) => d && String(d.id) === idStr) || null;
      }
      if (resolved) {
        key = completionKeyFor(resolved);
      } else if (idStr) {
        key = `${site}|event:${idStr}`;
      }
    }
    if (!key) return;
    if (completedDeadlines[key]) {
      delete completedDeadlines[key];
    } else {
      completedDeadlines[key] = Date.now();
    }
    // Legacy id-key cleanup for coherent undo: if the item also has a legacy
    // String(id) entry in this site's map, keep both in sync.
    try {
      if (deadlineOrId && typeof deadlineOrId === "object" && deadlineOrId.id !== undefined) {
        const legacy = String(deadlineOrId.id);
        if (completedDeadlines[key]) {
          // Keep legacy entry out; new key is canonical. Remove stale legacy dup.
          if (completedDeadlines[legacy]) delete completedDeadlines[legacy];
        } else {
          if (completedDeadlines[legacy]) delete completedDeadlines[legacy];
        }
      }
    } catch (_) {}
    if (site) {
      const nowDone = Boolean(completedDeadlines[key]);
      const doneAt = completedDeadlines[key];
      const legacyId = (deadlineOrId && typeof deadlineOrId === "object" && deadlineOrId.id !== undefined)
        ? String(deadlineOrId.id)
        : null;
      // Apply just this one change to the latest stored map (atomic).
      await MoodleAPI.updateSiteData(site, (prev) => {
        const map = { ...(prev.completedDeadlines || {}) };
        if (nowDone) map[key] = doneAt;
        else delete map[key];
        if (legacyId) delete map[legacyId];
        return { completedDeadlines: map };
      });
    } else {
      try {
        await chrome.storage.local.set({ completedDeadlines: completedDeadlines });
      } catch (_) {}
    }
    try {
      chrome.runtime.sendMessage({ action: "TOGGLE_DEADLINE_DONE" });
    } catch (_) {}
    renderDeadlines();
  }

  // Non-blocking, screen-reader-friendly notice (replaces window.alert).
  let toastTimer = null;
  function showToast(message) {
    let el = document.getElementById("nl-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "nl-toast";
      el.className = "nl-toast";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("visible"), 3000);
  }

  // Calendar URL formatting & dispatch helpers.
  // Google Calendar event timestamps are exactly YYYYMMDDTHHMMSSZ
  // (date + single T + single HHMMSS + Z). The shared helper in moodle-api.js
  // is the single source of truth so the hour field can never be duplicated.
  function formatGoogleCalendarDate(date) {
    try {
      if (MoodleAPI.formatGCalDateUTC) return MoodleAPI.formatGCalDateUTC(date);
    } catch (_) {}
    const d = (date instanceof Date) ? date : new Date(date);
    const pad = (n) => String(n).padStart(2, "0");
    return (
      d.getUTCFullYear() +
      pad(d.getUTCMonth() + 1) +
      pad(d.getUTCDate()) +
      "T" +
      pad(d.getUTCHours()) +
      pad(d.getUTCMinutes()) +
      pad(d.getUTCSeconds()) +
      "Z"
    );
  }

  // Privacy preference: whether calendar event descriptions include the
  // Moodle assignment URL. Default true (previous behavior); user can opt out.
  let includeUrlInCalendar = true;
  try {
    chrome.storage.local.get(["includeUrlInCalendar"]).then((s) => {
      if (s && typeof s.includeUrlInCalendar === "boolean") includeUrlInCalendar = s.includeUrlInCalendar;
      const box = document.getElementById("include-url-toggle");
      if (box) box.checked = includeUrlInCalendar;
    }).catch(() => {});
  } catch (_) {}

  async function setIncludeUrlInCalendar(value) {
    includeUrlInCalendar = value === true;
    try {
      await chrome.storage.local.set({ includeUrlInCalendar });
    } catch (_) {}
    const box = document.getElementById("include-url-toggle");
    if (box) box.checked = includeUrlInCalendar;
  }

  function calendarDetailsFor(item, deadlineDate) {
    const course = item.courseShortName || item.courseName || "Course";
    const base = `Course: ${item.courseName || course}\nDue: ${deadlineDate.toLocaleString()}`;
    const portal = (includeUrlInCalendar && item.url) ? `\nPortal: ${item.url}` : "";
    return `${base}${portal}\n\nTracked by NeverLate`;
  }

  function calendarLocationFor(item) {
    // Exams show the room; otherwise fall back to the portal link (if allowed).
    if (item.location && String(item.location).trim()) return String(item.location).trim().substring(0, 100);
    return (includeUrlInCalendar && item.url) ? item.url : "";
  }

  function calendarEventTitle(item) {
    const course = item.courseShortName || item.courseName || "Course";
    return `${course} — ${item.name || item.title || "Deliverable"}`;
  }

  function getGoogleCalendarUrl(item) {
    if (!item || typeof item.timesort !== "number") return null;
    const deadlineDate = new Date(item.timesort * 1000);
    const startDate = new Date((item.timesort - 1800) * 1000); // 30-min block ending at deadline
    const dates = `${formatGoogleCalendarDate(startDate)}/${formatGoogleCalendarDate(deadlineDate)}`;
    const title = calendarEventTitle(item);
    const details = calendarDetailsFor(item, deadlineDate);
    const params = new URLSearchParams({
      action: "TEMPLATE",
      text: title,
      dates: dates,
      details: details,
      location: calendarLocationFor(item)
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }

  function getOutlookCalendarUrl(item) {
    if (!item || typeof item.timesort !== "number") return null;
    const deadlineDate = new Date(item.timesort * 1000);
    const startDate = new Date((item.timesort - 1800) * 1000); // 30-min block ending at deadline
    const title = calendarEventTitle(item);
    const details = calendarDetailsFor(item, deadlineDate);
    const params = new URLSearchParams({
      path: "/calendar/action/compose",
      rru: "addevent",
      subject: title,
      startdt: startDate.toISOString(),
      enddt: deadlineDate.toISOString(),
      body: details,
      location: calendarLocationFor(item)
    });
    return `https://outlook.office.com/calendar/0/deeplink/compose?${params.toString()}`;
  }

  function openCalendarUrl(url) {
    if (!url) return;
    if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url: url });
    } else {
      window.open(url, "_blank");
    }
  }

  function getNextUpcomingDeadline() {
    if (!currentData || !Array.isArray(currentData.deadlines)) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    const uncompleted = currentData.deadlines.filter(
      (d) => d && d.timesort > nowSec && !isCompleted(d)
    );
    if (uncompleted.length === 0) {
      const anyUncompleted = currentData.deadlines.filter((d) => d && !isCompleted(d));
      return anyUncompleted.length > 0 ? anyUncompleted[0] : currentData.deadlines[0] || null;
    }
    uncompleted.sort((a, b) => a.timesort - b.timesort);
    return uncompleted[0];
  }

  // Create a clean Apple-style deliverable card with completion ring & calendar shortcuts.
  // All academic types share one chronological timeline (no separate screens).
  function createDeadlineCard(item, isCompleted = false) {
    const countdown = formatCountdown(item.timesort);
    const chipText = (item.courseShortName && item.courseShortName !== "—" && item.courseShortName !== "Course Event")
      ? item.courseShortName
      : ((item.courseName && item.courseName !== "—" && item.courseName !== "Course Event") ? item.courseName : "Course");
    let typeLabel = "ASSIGNMENT";
    let typeClass = "assignment";
    try {
      typeLabel = MoodleAPI.eventTypeLabel(item);
      typeClass = String(item.type || "assignment").toLowerCase();
      if (!["assignment", "quiz", "exam", "personal"].includes(typeClass)) typeClass = "assignment";
    } catch (_) {}
    const locText = (item.location && String(item.location).trim())
      ? ` · ${escapeHtml(String(item.location).trim().substring(0, 40))}`
      : "";
    const isManual = !!(item.source === "manual" || (item.id && String(item.id).startsWith("manual-")));

    // URL-less manual items render as a non-navigating card (same styling).
    const card = document.createElement(item.url ? "a" : "div");
    card.className = isCompleted ? "content-card is-completed" : "content-card";
    if (item.url) {
      card.href = safeUrl(item.url);
      card.target = "_blank";
      card.rel = "noopener noreferrer";
    }

    card.innerHTML = `
      <button class="completion-checkbox ${isCompleted ? "checked" : ""}" type="button" title="${isCompleted ? "Mark as Incomplete" : "Mark as Done"}">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </button>
      <div class="card-body">
        <div class="card-header-row">
          <span class="card-chips">
            <span class="type-chip type-${typeClass}">${escapeHtml(typeLabel)}</span>
            <span class="course-chip" title="${escapeHtml(item.courseName || chipText)}">${escapeHtml(chipText)}</span>
          </span>
          <span class="countdown-pill ${isCompleted ? "pill-completed" : countdown.pillClass}">
            ${isCompleted ? "Completed" : escapeHtml(countdown.pillText)}
          </span>
        </div>
        <div class="assignment-title">${escapeHtml(item.title || item.name)}</div>
        <div class="card-footer-row">
          <div class="card-date-meta">
            <svg class="cal-mini-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
              <line x1="16" y1="2" x2="16" y2="6"/>
              <line x1="8" y1="2" x2="8" y2="6"/>
              <line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
            <span>${isCompleted ? "Done · no more reminders" : `Due ${escapeHtml(formatDateTime(item.timesort))}${locText}`}</span>
          </div>
          <div class="card-footer-actions">
            <button class="card-action-icon-btn gcal-btn" type="button" data-tip="Add to Google Calendar" aria-label="Add to Google Calendar">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V9h14v11zM7 11h5v5H7z"/>
              </svg>
            </button>
            <button class="card-action-icon-btn outlook-btn" type="button" data-tip="Add to Outlook 365" aria-label="Add to Outlook 365">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2"/>
                <line x1="3" y1="10" x2="21" y2="10"/>
                <line x1="10" y1="4" x2="10" y2="22"/>
              </svg>
            </button>
            ${isManual ? `<button class="card-action-icon-btn edit-btn" type="button" data-tip="Edit this entry" aria-label="Edit this entry">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
              </svg>
            </button><button class="card-action-icon-btn delete-btn" type="button" title="Delete this entry">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>` : `<span class="action-link">Open &rsaquo;</span>`}
          </div>
        </div>
      </div>
    `;

    const checkbox = card.querySelector(".completion-checkbox");
    if (checkbox) {
      checkbox.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await toggleDeadlineDone(item);
      });
    }

    const gcalBtn = card.querySelector(".gcal-btn");
    if (gcalBtn) {
      gcalBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const url = getGoogleCalendarUrl(item);
        if (url) openCalendarUrl(url);
      });
    }

    const outlookBtn = card.querySelector(".outlook-btn");
    if (outlookBtn) {
      outlookBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const url = getOutlookCalendarUrl(item);
        if (url) openCalendarUrl(url);
      });
    }

    const deleteBtn = card.querySelector(".delete-btn");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await deleteManualDeadline(item);
      });
    }

    const editBtn = card.querySelector(".edit-btn");
    if (editBtn) {
      editBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openAddModal(item);
      });
    }

    return { card, isImminent: !isCompleted && countdown.isImminent };
  }

  // Delete a student-created manual deadline (per-site; Moodle items have no delete).
  async function deleteManualDeadline(item) {
    const site = currentSiteKey || currentBaseUrl;
    if (!site || !currentData || !Array.isArray(currentData.deadlines)) return;
    let key = null;
    try {
      key = MoodleAPI.buildStableKey(site, item);
    } catch (_) {}
    const isTarget = (d) => {
      if (!d || !MoodleAPI.isManualItem(d)) return false;
      try {
        return MoodleAPI.buildStableKey(site, d) === key;
      } catch (_) {
        return d === item;
      }
    };
    const legacyId = (item && item.id !== undefined && item.id !== null) ? String(item.id) : null;

    try {
      const saved = await MoodleAPI.updateSiteData(site, (prev) => {
        const md = prev.moodleData;
        const completed = { ...(prev.completedDeadlines || {}) };
        // Drop its Done mark too so keys never accumulate.
        if (key) delete completed[key];
        if (legacyId) delete completed[legacyId];
        const partial = { completedDeadlines: completed };
        if (md && Array.isArray(md.deadlines)) {
          partial.moodleData = { ...md, deadlines: md.deadlines.filter((d) => !isTarget(d)) };
        }
        return partial;
      });
      if (saved) {
        if (saved.moodleData) currentData = saved.moodleData;
        completedDeadlines = saved.completedDeadlines || {};
      } else {
        currentData.deadlines = currentData.deadlines.filter((d) => !isTarget(d));
      }
      chrome.runtime.sendMessage({ action: "REFRESH_SITE_ALERTS" });
    } catch (_) {}
    renderDeadlines();
  }

  // Calculate time bucket for structured section grouping (DeadlineSync style)
  function getDeadlineTimeBucket(timesort) {
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);
    if (timesort <= nowSec) {
      return "overdue";
    }

    const deadlineDate = new Date(timesort * 1000);
    const isSameDay = (
      deadlineDate.getFullYear() === now.getFullYear() &&
      deadlineDate.getMonth() === now.getMonth() &&
      deadlineDate.getDate() === now.getDate()
    );
    if (isSameDay) {
      return "today";
    }

    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfDeadlineDay = new Date(deadlineDate.getFullYear(), deadlineDate.getMonth(), deadlineDate.getDate()).getTime();
    const daysDiff = Math.round((startOfDeadlineDay - startOfToday) / (24 * 60 * 60 * 1000));

    if (daysDiff <= 7) {
      return "this_week";
    }
    if (daysDiff <= 14) {
      return "next_week";
    }
    return "later";
  }

  // Render Deadlines with active and completed grouping
  function renderDeadlines() {
    if (!currentData || !Array.isArray(currentData.deadlines)) {
      deadlinesList.innerHTML = "";
      if (completedList) completedList.innerHTML = "";
      if (completedSection) completedSection.classList.add("hidden");
      deadlinesEmpty.classList.remove("hidden");
      deadlinesBadge.textContent = "0";
      return;
    }

    let items = currentData.deadlines;
    const courses = Array.isArray(currentData.courses) ? currentData.courses : [];

    if (selectedCourseId !== "all") {
      const selectedCourse = courses.find((c) => String(c.id) === String(selectedCourseId));
      items = items.filter((d) => {
        if (!d) return false;
        if (String(d.courseId) === String(selectedCourseId)) return true;
        if (d.courseShortName && d.courseShortName === selectedCourseId) return true;

        if (selectedCourse) {
          const sName = (selectedCourse.shortname || "").toLowerCase();
          const fName = (selectedCourse.fullname || "").toLowerCase();
          const dShort = (d.courseShortName || "").toLowerCase();
          const dFull = (d.courseName || "").toLowerCase();
          const dText = `${d.name || ""} ${d.activityname || ""} ${dShort} ${dFull}`.toLowerCase();

          if (dShort && sName && (dShort === sName || sName.includes(dShort) || dShort.includes(sName))) return true;
          if (dFull && fName && (dFull === fName || fName.includes(dFull) || dFull.includes(fName))) return true;
          if (dShort && fName && fName.includes(dShort)) return true;
          if (dFull && sName && sName.includes(dFull)) return true;

          const codeMatch = sName.match(/([a-z]{2,5})\s*[-_]?\s*(\d{3,5})/i);
          if (codeMatch) {
            const prefix = codeMatch[1].toLowerCase();
            const num = codeMatch[2];
            if (dText.includes(prefix + num) || dText.includes(num)) return true;
          }
        }
        if (d.isAmbiguous || !d.courseId || d.courseShortName === "General" || d.courseShortName === "Course Event" || d.courseShortName === "Course") {
          return true;
        }
        return false;
      });
    }

    deadlinesList.innerHTML = "";
    if (completedList) completedList.innerHTML = "";
    let hasImminentDeadline = false;

    // Partition into active vs completed deliverables
    const activeItems = [];
    const completedItems = [];

    items.forEach((item) => {
      if (isCompleted(item)) {
        completedItems.push(item);
      } else {
        activeItems.push(item);
      }
    });

    if (activeItems.length === 0) {
      deadlinesEmpty.classList.remove("hidden");
      deadlinesList.classList.add("hidden");
      const emptyTitle = deadlinesEmpty.querySelector(".empty-title");
      const emptyDesc = deadlinesEmpty.querySelector(".empty-description");
      if (selectedCourseId !== "all") {
        const selCourse = courses.find((c) => String(c.id) === String(selectedCourseId));
        const cName = selCourse ? (selCourse.shortname || selCourse.fullname) : "this course";
        if (emptyTitle) emptyTitle.textContent = "No Deadlines in This Course";
        if (emptyDesc) {
          emptyDesc.innerHTML = `No pending deliverables found for <strong>${escapeHtml(cName)}</strong>.<br><button id="reset-course-filter-btn" class="reset-filter-link">Show all enrolled courses</button>`;
          const resetBtn = document.getElementById("reset-course-filter-btn");
          if (resetBtn) {
            resetBtn.addEventListener("click", () => {
              selectedCourseId = "all";
              courseFilter.value = "all";
              renderDeadlines();
            });
          }
        }
      } else {
        if (emptyTitle) emptyTitle.textContent = "No Upcoming Deadlines";
        if (emptyDesc) emptyDesc.textContent = "No pending work. Everything is done or marked complete.";
      }
    } else {
      deadlinesEmpty.classList.add("hidden");
      deadlinesList.classList.remove("hidden");

      // Group active deliverables by time bucket (DeadlineSync / Bento style)
      const bucketDefs = [
        { key: "overdue", label: "Overdue" },
        { key: "today", label: "Due Today" },
        { key: "this_week", label: "This Week" },
        { key: "next_week", label: "Next Week" },
        { key: "later", label: "Later" }
      ];

      const grouped = {
        overdue: [],
        today: [],
        this_week: [],
        next_week: [],
        later: []
      };

      activeItems.slice(0, 100).forEach((item) => {
        const bKey = getDeadlineTimeBucket(item.timesort);
        if (grouped[bKey]) {
          grouped[bKey].push(item);
        } else {
          grouped.later.push(item);
        }
      });

      bucketDefs.forEach((b) => {
        const itemsInGroup = grouped[b.key];
        if (itemsInGroup && itemsInGroup.length > 0) {
          const header = document.createElement("div");
          header.className = "time-section-header";
          header.innerHTML = `
            <span class="time-section-title">${escapeHtml(b.label)}</span>
            <span class="time-section-count">${itemsInGroup.length}</span>
          `;
          deadlinesList.appendChild(header);

          itemsInGroup.forEach((item) => {
            const { card, isImminent } = createDeadlineCard(item, false);
            if (isImminent) hasImminentDeadline = true;
            deadlinesList.appendChild(card);
          });
        }
      });
    }

    // Render completed section
    if (completedSection && completedList) {
      if (completedItems.length > 0) {
        completedSection.classList.remove("hidden");
        if (completedCountLabel) {
          completedCountLabel.textContent = `Completed (${completedItems.length})`;
        }
        completedItems.slice(0, 50).forEach((item) => {
          const { card } = createDeadlineCard(item, true);
          completedList.appendChild(card);
        });
      } else {
        completedSection.classList.add("hidden");
      }
    }

    // Badge strictly counts uncompleted upcoming deliverables
    const pendingCount = currentData.deadlines.filter(
      (d) => d && d.timesort > Math.floor(Date.now() / 1000) && !isCompleted(d)
    ).length;
    deadlinesBadge.textContent = pendingCount;

    scheduleNextRender(hasImminentDeadline);
  }

  // Render Courses
  function renderCourses() {
    if (!currentData || !Array.isArray(currentData.courses)) {
      coursesList.innerHTML = "";
      coursesEmpty.classList.remove("hidden");
      coursesBadge.textContent = "0";
      return;
    }

    coursesList.innerHTML = "";
    const courses = currentData.courses;

    if (courses.length === 0) {
      coursesEmpty.classList.remove("hidden");
      coursesList.classList.add("hidden");
    } else {
      coursesEmpty.classList.add("hidden");
      coursesList.classList.remove("hidden");

      courses.slice(0, 50).forEach((c) => {
        const card = document.createElement("a");
        card.className = "content-card";
        card.href = safeUrl(c.viewurl);
        card.target = "_blank";
        card.rel = "noopener noreferrer";

        card.innerHTML = `
          <div class="card-body">
            <div class="card-header-row">
              <span class="course-chip">${escapeHtml(c.shortname || "Course")}</span>
              <span class="action-link">View Course &rsaquo;</span>
            </div>
            <div class="course-card-title">${escapeHtml(c.fullname)}</div>
            <div class="card-footer-row">
              <span class="course-meta">ID: ${escapeHtml(String(c.id))}</span>
              <span class="course-meta">${escapeHtml(c.category || "Enrolled")}</span>
            </div>
          </div>
        `;
        coursesList.appendChild(card);
      });
    }

    coursesBadge.textContent = courses.length;

    courseFilter.innerHTML = `<option value="all">All Enrolled Courses (${courses.length})</option>`;
    courses.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.shortname || c.fullname;
      if (String(c.id) === String(selectedCourseId)) {
        opt.selected = true;
      }
      courseFilter.appendChild(opt);
    });
  }

  // Self-healing data repair for legacy or malformed cached items
  function repairLoadedData(data) {
    if (!data || !Array.isArray(data.deadlines)) return;
    const courses = Array.isArray(data.courses) ? data.courses : [];
    let needsResave = false;

    data.deadlines.forEach((d) => {
      if (!d) return;

      if (!d.name || /^go to activity$/i.test(d.name) || /^view activity$/i.test(d.name)) {
        if (d.activityname && !/^go to activity$/i.test(d.activityname)) {
          d.name = d.activityname;
        } else {
          d.name = d.type === "quiz" ? "Quiz" : "Assignment";
        }
        needsResave = true;
      }
      d.name = d.name.replace(/\s+(?:is due|due|closes|will close|is closing|opens)\s*$/i, "").trim();

      if (d.name === "Assignment" || (d.id && String(d.id).includes("Go to acti"))) {
        d.isAmbiguous = true;
        d.courseId = null;
        d.courseShortName = "General";
        needsResave = true;
      }

      let matched = null;
      if (d.courseId && courses.some(c => String(c.id) === String(d.courseId)) && !d.isAmbiguous) {
        matched = courses.find(c => String(c.id) === String(d.courseId));
      }

      if (!matched) {
        for (const c of courses) {
          const sName = (c.shortname || "").toLowerCase();
          const fName = (c.fullname || "").toLowerCase();
          const dShort = (d.courseShortName || "").toLowerCase();
          const dFull = (d.courseName || "").toLowerCase();
          const dText = `${d.name || ""} ${d.activityname || ""} ${dShort} ${dFull}`.toLowerCase();

          if (
            (dShort && sName && (dShort === sName || sName.includes(dShort) || dShort.includes(sName))) ||
            (dFull && fName && (dFull === fName || fName.includes(dFull) || dFull.includes(fName))) ||
            (dShort && fName && fName.includes(dShort)) ||
            (dFull && sName && sName.includes(dFull))
          ) {
            matched = c;
            break;
          }

          if (MoodleAPI.courseCodeMatchesText(sName, dText)) {
            matched = c;
            break;
          }
        }
      }

      if (!matched && courses.length === 1) {
        matched = courses[0];
      }

      if (matched) {
        d.courseId = matched.id;
        d.courseShortName = matched.shortname || matched.fullname;
        d.courseName = matched.fullname || matched.shortname;
        d.isAmbiguous = false;
        needsResave = true;
      } else {
        d.isAmbiguous = true;
        if (!d.courseShortName || d.courseShortName === "Course Event" || d.courseShortName === "—") {
          d.courseShortName = "General";
        }
        needsResave = true;
      }
    });

    if (needsResave) {
      try {
        const site = currentSiteKey || currentBaseUrl;
        if (site && MoodleAPI.saveSiteData) {
          // Persist only if storage still holds the snapshot we repaired; a
          // newer sync/manual edit wins and is repaired again on next load.
          const snapshotSync = data.lastSynced;
          const snapshotLen = data.deadlines.length;
          MoodleAPI.updateSiteData(site, (prev) => {
            const md = prev.moodleData;
            if (!md || md.lastSynced !== snapshotSync || !Array.isArray(md.deadlines) || md.deadlines.length !== snapshotLen) return null;
            return { moodleData: data };
          }).catch(() => {});
        } else {
          chrome.storage.local.set({ moodleData: data });
        }
      } catch (_) {}
    }
  }

  // Update UI with stored data (per-site; unconfigured shows onboarding, never another site's cache)
  function updateUI(data) {
    if (data) repairLoadedData(data);
    currentData = data;

    if (readySyncState) readySyncState.classList.add("hidden");

    // Dynamic external links (disabled when unconfigured)
    if (moodlePortalLink) {
      moodlePortalLink.href = currentBaseUrl ? `${currentBaseUrl}/my/` : "#";
    }
    if (loginPortalLink) {
      loginPortalLink.href = currentBaseUrl ? `${currentBaseUrl}/login/index.php` : "#";
      loginPortalLink.textContent = currentBaseUrl ? `Sign in to ${currentInstitutionName}` : "Connect your Moodle";
    }

    if (!currentBaseUrl) {
      showUnconfiguredState();
      return;
    }

    if (!data || !data.user?.isLoggedIn) {
      loggedOutState.classList.remove("hidden");
      coursesList.classList.add("hidden");
      coursesEmpty.classList.add("hidden");
      userDisplay.textContent = `Not signed in • ${currentInstitutionName}`;
      statusDot.className = "dot warning";
      statusText.textContent = `Sign in to ${currentInstitutionName}`;
      deadlinesBadge.textContent = "0";
      coursesBadge.textContent = "0";
      // Manual deadlines are local student records (not server state): keep
      // them visible in the timeline even while signed out.
      const manualItems = (data && Array.isArray(data.deadlines))
        ? data.deadlines.filter((d) => { try { return MoodleAPI.isManualItem(d); } catch (_) { return false; } })
        : [];
      if (manualItems.length > 0) {
        renderDeadlines();
        deadlinesList.classList.remove("hidden");
        deadlinesEmpty.classList.add("hidden");
      } else {
        deadlinesList.classList.add("hidden");
        deadlinesEmpty.classList.add("hidden");
      }
      return;
    }

    loggedOutState.classList.add("hidden");
    userDisplay.textContent = `${data.user.name || "Student"} • ${currentInstitutionName}`;
    statusDot.className = "dot";
    statusText.textContent = `Connected • ${currentInstitutionName}`;

    if (data.lastSynced) {
      const d = new Date(data.lastSynced);
      lastSyncedTime.textContent = d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      });
    }

    renderDeadlines();
    renderCourses();
    updateAlertsState();

    try {
      chrome.runtime.sendMessage({
        action: "UPDATE_BADGE",
        siteKey: currentSiteKey || currentBaseUrl,
        deadlines: data.deadlines || [],
        institutionName: currentInstitutionName
      });
    } catch (e) {}
  }

  // Optional extra reminders (global on/off; fired-memory stays per-site).
  async function loadExtrasState() {
    try {
      const stored = await chrome.storage.local.get(["alertSettings"]);
      const extra = (stored.alertSettings && stored.alertSettings.extra) || {};
      if (extra6hBox) extra6hBox.checked = extra["6h"] === true;
      if (extra30mBox) extra30mBox.checked = extra["30m"] === true;
    } catch (_) {}
  }

  async function saveExtrasState() {
    try {
      const stored = await chrome.storage.local.get(["alertSettings"]);
      const prev = (stored.alertSettings && typeof stored.alertSettings === "object") ? stored.alertSettings : {};
      await chrome.storage.local.set({
        alertSettings: {
          ...prev,
          enabled: prev.enabled === true,
          extra: {
            "6h": !!(extra6hBox && extra6hBox.checked),
            "30m": !!(extra30mBox && extra30mBox.checked)
          }
        }
      });
    } catch (_) {}
    refreshExtrasStatus();
    try {
      chrome.runtime.sendMessage({ action: "UPDATE_ALERT_SETTINGS" });
    } catch (_) {}
  }

  function refreshExtrasStatus() {
    if (!alertsStatus) return;
    const anyExtra = (extra6hBox && extra6hBox.checked) || (extra30mBox && extra30mBox.checked);
    if (alertsToggle && alertsToggle.checked && anyExtra) {
      alertsStatus.textContent = "On • 8 AM, 2h & extras";
    } else if (alertsToggle && alertsToggle.checked) {
      alertsStatus.textContent = "On • 8 AM & 2h alerts";
    }
  }

  if (extra6hBox) {
    extra6hBox.addEventListener("change", saveExtrasState);
  }
  if (extra30mBox) {
    extra30mBox.addEventListener("change", saveExtrasState);
  }

  // Alert preferences and permission handling
  async function updateAlertsState() {
    if (!alertsToggle || !alertsStatus) return;

    try {
      const stored = await chrome.storage.local.get(["alertSettings"]);
      const isEnabled = stored.alertSettings?.enabled === true;

      if (!isEnabled) {
        alertsToggle.checked = false;
        alertsStatus.textContent = "Off";
        alertsStatus.className = "alerts-status";
        if (alertsCard) alertsCard.className = "alerts-card";
        if (extrasRow) extrasRow.classList.add("hidden");
        return;
      }

      const hasPerm = await chrome.permissions.contains({ permissions: ["notifications"] });
      if (!hasPerm) {
        alertsToggle.checked = false;
        alertsStatus.textContent = "Permission needed in settings";
        alertsStatus.className = "alerts-status warning";
        if (alertsCard) alertsCard.className = "alerts-card warning";
        if (extrasRow) extrasRow.classList.add("hidden");
        return;
      }

      const level = await new Promise((resolve) => {
        if (typeof chrome !== "undefined" && chrome.notifications && typeof chrome.notifications.getPermissionLevel === "function") {
          chrome.notifications.getPermissionLevel(resolve);
        } else {
          resolve("granted");
        }
      });

      if (level !== "granted") {
        alertsToggle.checked = false;
        alertsStatus.textContent = "Permission needed in settings";
        alertsStatus.className = "alerts-status warning";
        if (alertsCard) alertsCard.className = "alerts-card warning";
        if (extrasRow) extrasRow.classList.add("hidden");
        return;
      }

      alertsToggle.checked = true;
      alertsStatus.textContent = "On • 8 AM & 2h alerts";
      alertsStatus.className = "alerts-status";
      if (alertsCard) alertsCard.className = "alerts-card active";
      if (extrasRow) extrasRow.classList.remove("hidden");
      await loadExtrasState();
      refreshExtrasStatus();
    } catch (err) {
      alertsToggle.checked = false;
      alertsStatus.textContent = "Permission needed in settings";
      alertsStatus.className = "alerts-status warning";
      if (alertsCard) alertsCard.className = "alerts-card warning";
      if (extrasRow) extrasRow.classList.add("hidden");
    }
  }

  // Merge the on/off flip into stored settings without dropping extras.
  async function setAlertsEnabled(on) {
    try {
      const stored = await chrome.storage.local.get(["alertSettings"]);
      const prev = (stored.alertSettings && typeof stored.alertSettings === "object") ? stored.alertSettings : {};
      await chrome.storage.local.set({ alertSettings: { ...prev, enabled: on === true } });
    } catch (_) {}
  }

  if (alertsToggle) {
    alertsToggle.addEventListener("change", async () => {
      if (alertsToggle.checked) {
        try {
          const granted = await chrome.permissions.request({ permissions: ["notifications"] });
          if (!granted) {
            alertsToggle.checked = false;
            alertsStatus.textContent = "Permission needed in settings";
            alertsStatus.className = "alerts-status warning";
            if (alertsCard) alertsCard.className = "alerts-card warning";
            if (extrasRow) extrasRow.classList.add("hidden");
            await setAlertsEnabled(false);
            return;
          }

          const level = await new Promise((resolve) => {
            if (typeof chrome !== "undefined" && chrome.notifications && typeof chrome.notifications.getPermissionLevel === "function") {
              chrome.notifications.getPermissionLevel(resolve);
            } else {
              resolve("granted");
            }
          });

          if (level !== "granted") {
            alertsToggle.checked = false;
            alertsStatus.textContent = "Permission needed in settings";
            alertsStatus.className = "alerts-status warning";
            if (alertsCard) alertsCard.className = "alerts-card warning";
            if (extrasRow) extrasRow.classList.add("hidden");
            await setAlertsEnabled(false);
            return;
          }

          await setAlertsEnabled(true);
          alertsStatus.textContent = "On • 8 AM & 2h alerts";
          alertsStatus.className = "alerts-status";
          if (alertsCard) alertsCard.className = "alerts-card active";
          if (extrasRow) extrasRow.classList.remove("hidden");
          await loadExtrasState();
          refreshExtrasStatus();
          chrome.runtime.sendMessage({ action: "UPDATE_ALERT_SETTINGS" });
          chrome.runtime.sendMessage({ action: "SEND_CONFIRMATION_ALERT" });
        } catch (err) {
          console.warn("[Popup] Failed to request notification permission:", err);
          alertsToggle.checked = false;
          alertsStatus.textContent = "Permission needed in settings";
          alertsStatus.className = "alerts-status warning";
          if (alertsCard) alertsCard.className = "alerts-card warning";
          if (extrasRow) extrasRow.classList.add("hidden");
          await setAlertsEnabled(false);
        }
      } else {
        await setAlertsEnabled(false);
        alertsStatus.textContent = "Off";
        alertsStatus.className = "alerts-status";
        if (alertsCard) alertsCard.className = "alerts-card";
        if (extrasRow) extrasRow.classList.add("hidden");
        chrome.runtime.sendMessage({ action: "UPDATE_ALERT_SETTINGS" });
      }
    });
  }

  // Sync dispatcher: routes strictly through background safeSync.
  // `force` bypasses ONLY the success-cache cooldown (repair path); the
  // 10s/45s attempt throttle in the background is never bypassable.
  // Stale-switch guard: the active site is captured at dispatch; a response
  // from a previous university is ignored after the user switches sites.
  // Signed-out re-verify: background (non-manual) responses that arrive
  // throttled/transient while showing signed-out schedule a capped retry so
  // a fresh sign-in is picked up without a manual Sync.
  let loggedOutRechecks = 0;
  const MAX_LOGGED_OUT_RECHECKS = 3;

  function showingSignedOut(data) {
    try {
      return MoodleAPI.isLoggedOutData(data || currentData);
    } catch (_) {
      return !currentData || !currentData.user || currentData.user.isLoggedIn !== true;
    }
  }

  function schedulePopupRecheck(siteKey, delaySec) {
    if (loggedOutRechecks >= MAX_LOGGED_OUT_RECHECKS) return;
    if ((currentSiteKey || currentBaseUrl) !== siteKey) return;
    loggedOutRechecks += 1;
    const delayMs = Math.min(Math.max(delaySec || 30, 5), 180) * 1000 + 1000;
    setTimeout(() => {
      if (isSyncing) return;
      if ((currentSiteKey || currentBaseUrl) !== siteKey) return;
      if (!showingSignedOut()) {
        loggedOutRechecks = 0;
        return;
      }
      requestSync(false, false);
    }, delayMs);
  }

  function requestSync(isManual = true, force = false) {
    if (isSyncing) return;
    if (!currentBaseUrl) {
      showUnconfiguredState();
      return;
    }

    if (isManual) loggedOutRechecks = 0;
    const siteAtStart = currentSiteKey || currentBaseUrl;
    isSyncing = true;
    syncIcon.classList.add("spin");
    syncBtnLabel.textContent = "Syncing...";
    statusText.textContent = "Syncing...";

    chrome.runtime.sendMessage(
      { action: "SYNC_NOW", isManual: isManual, force: force === true, siteKey: siteAtStart },
      (res) => {
        syncIcon.classList.remove("spin");
        isSyncing = false;

        // Ignore stale responses from a previously active university.
        const stillCurrent = (currentSiteKey || currentBaseUrl) === siteAtStart;
        if (!stillCurrent) {
          console.log("[Popup] Ignoring stale sync response from previous site");
          return;
        }
        // Background echoes the sync's site; belt-and-braces check.
        if (res && res.siteKey && res.siteKey !== siteAtStart) {
          console.log("[Popup] Ignoring response tagged for another site");
          return;
        }

        if (res && res.notConfigured) {
          syncBtnLabel.textContent = "Sync";
          showUnconfiguredState();
          return;
        }

        if (res && res.rateLimited) {
          syncBtnLabel.textContent = `Wait ${res.cooldownRemainingSec || 10}s`;
          statusText.textContent = res.error || "Cooldown active";
          statusDot.className = "dot warning";
          setTimeout(() => {
            syncBtnLabel.textContent = "Sync";
          }, 2000);
          if (res.data) updateUI(res.data);
          // Throttled while signed out: the sign-in may have just happened.
          // Retry once the throttle expires (capped; background also rechecks).
          if (!isManual && showingSignedOut(res.data)) {
            schedulePopupRecheck(siteAtStart, res.cooldownRemainingSec);
          }
          return;
        }

        if (res && res.success) {
          if (res.data) {
            if (res.data.institutionName) {
              currentInstitutionName = res.data.institutionName;
            }
            updateUI(res.data);
            if (!showingSignedOut(res.data)) loggedOutRechecks = 0;
          } else {
            loggedOutRechecks = 0;
          }

          if (res.cached) {
            syncBtnLabel.textContent = "Up to date";
            syncBtn.classList.add("synced");
            statusText.textContent = `Connected • ${currentInstitutionName}`;
          } else {
            syncBtnLabel.textContent = "Updated";
            syncBtn.classList.add("synced");
            statusText.textContent = `Connected • ${currentInstitutionName}`;
          }

          setTimeout(() => {
            syncBtnLabel.textContent = "Sync";
            syncBtn.classList.remove("synced");
          }, 2200);
        } else {
          syncBtnLabel.textContent = "Sync";

          if (res && res.transientFailure) {
            statusText.textContent = "Offline (cached)";
            statusDot.className = "dot warning";
            if (res.data) {
              updateUI(res.data);
            }
            // Same re-verify as the throttled case: a signed-out screen may
            // just be waiting on a fresh sign-in (capped).
            if (!isManual && showingSignedOut(res.data)) {
              schedulePopupRecheck(siteAtStart, 30);
            }
          } else {
            statusText.textContent = res?.error || `Sign in to ${currentInstitutionName}`;
            statusDot.className = "dot warning";
            if (res && res.data) {
              updateUI(res.data);
            } else {
              updateUI(null);
            }
          }
        }
      }
    );
  }

  // Focus return: remember what opened a modal and hand focus back on close
  // so keyboard users never lose their place.
  let modalOpener = null;

  function rememberModalOpener() {
    try {
      const active = document.activeElement;
      modalOpener = (active && active !== document.body) ? active : null;
    } catch (_) {
      modalOpener = null;
    }
  }

  function returnModalFocus() {
    try {
      if (modalOpener && document.contains(modalOpener)) modalOpener.focus();
    } catch (_) {}
    modalOpener = null;
  }

  function isAnyModalOpen() {
    return !!(addModal && !addModal.classList.contains("hidden"));
  }

  // Light Tab trap: keep keyboard focus cycling inside the open modal.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const openModal = (addModal && !addModal.classList.contains("hidden")) ? addModal : null;
    if (!openModal) return;
    let focusables = [];
    try {
      focusables = Array.from(openModal.querySelectorAll('button, input, select, [href], [tabindex]:not([tabindex="-1"])'))
        .filter((el) => !el.disabled && el.offsetParent !== null);
    } catch (_) {}
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, true);

  // Manual Academic Deadlines (+ Add): stored in the ACTIVE site's bucket,
  // rendered inline in the same Upcoming timeline with identical countdowns,
  // digests, reminders, completion, and calendar export. Zero Moodle traffic.
  const addDeadlineBtn = document.getElementById("add-deadline-btn");
  const addModal = document.getElementById("add-modal");
  const closeAddModalBtn = document.getElementById("close-add-modal-btn");
  const addTypeSelect = document.getElementById("add-type-select");
  const addSubtypeGroup = document.getElementById("add-subtype-group");
  const addSubtypeSelect = document.getElementById("add-subtype-select");
  const addTitleInput = document.getElementById("add-title-input");
  const addCourseInput = document.getElementById("add-course-input");
  const addCourseDatalist = document.getElementById("add-course-datalist");
  const addDateInput = document.getElementById("add-date-input");
  const addTimeInput = document.getElementById("add-time-input");
  const addLocationGroup = document.getElementById("add-location-group");
  const addLocationInput = document.getElementById("add-location-input");
  const addStatusMsg = document.getElementById("add-status-msg");
  const saveAddBtn = document.getElementById("save-add-btn");
  const addModalTitle = document.getElementById("add-modal-title");

  // Non-null while editing an existing manual entry (its stable key).
  let editingManualKey = null;

  function timesortToDateInput(timesort) {
    const d = new Date(timesort * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function timesortToTimeInput(timesort) {
    const d = new Date(timesort * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function refreshAddModalVisibility() {
    const type = addTypeSelect ? addTypeSelect.value : "assignment";
    // Location is venue metadata: shown for exams and quizzes (classrooms),
    // hidden for assignments and personal entries to keep the form calm.
    const showLocation = type === "exam" || type === "quiz";
    if (addSubtypeGroup) addSubtypeGroup.classList.toggle("hidden", type !== "exam");
    if (addLocationGroup) addLocationGroup.classList.toggle("hidden", !showLocation);
    refreshTitlePlaceholder();
  }

  // Title hint adapts to the selected type so each category suggests
  // something relevant instead of one static example for everything.
  function refreshTitlePlaceholder() {
    if (!addTitleInput) return;
    const type = addTypeSelect ? addTypeSelect.value : "assignment";
    if (type === "quiz") {
      addTitleInput.placeholder = "e.g. Quiz 3, Unit Test 2";
    } else if (type === "exam") {
      let label = "Mid-Sem";
      try {
        if (addSubtypeSelect) label = MoodleAPI.examSubtypeLabel(addSubtypeSelect.value);
      } catch (_) {}
      addTitleInput.placeholder = `e.g. ${label}, CS201 ${label}`;
    } else if (type === "personal") {
      addTitleInput.placeholder = "e.g. Study group meet, Project review";
    } else {
      addTitleInput.placeholder = "e.g. Problem Set 5, Essay Draft";
    }
  }

  function openAddModal(existingItem = null) {
    if (!currentBaseUrl) {
      showUnconfiguredState();
      return;
    }
    rememberModalOpener();
    if (addStatusMsg) {
      addStatusMsg.textContent = "";
      addStatusMsg.className = "form-help-text";
    }
    // Offer enrolled courses for convenience (free text still allowed).
    try {
      if (addCourseDatalist && currentData && Array.isArray(currentData.courses)) {
        addCourseDatalist.innerHTML = "";
        currentData.courses.slice(0, 50).forEach((c) => {
          const opt = document.createElement("option");
          opt.value = c.shortname || c.fullname;
          addCourseDatalist.appendChild(opt);
        });
      }
    } catch (_) {}
    // Edit mode: prefill from the entry; otherwise start blank.
    const site = currentSiteKey || currentBaseUrl;
    if (existingItem) {
      try {
        editingManualKey = MoodleAPI.buildStableKey(site, existingItem);
      } catch (_) {
        editingManualKey = null;
      }
      if (addTypeSelect) addTypeSelect.value = existingItem.type || "assignment";
      if (addSubtypeSelect && existingItem.subtype) addSubtypeSelect.value = existingItem.subtype;
      if (addTitleInput) addTitleInput.value = existingItem.title || existingItem.name || "";
      if (addCourseInput) addCourseInput.value = existingItem.course || existingItem.courseShortName || "";
      if (addDateInput && typeof existingItem.timesort === "number") addDateInput.value = timesortToDateInput(existingItem.timesort);
      if (addTimeInput && typeof existingItem.timesort === "number") addTimeInput.value = timesortToTimeInput(existingItem.timesort);
      if (addLocationInput) addLocationInput.value = existingItem.location || "";
      if (addModalTitle) addModalTitle.textContent = "Edit Deadline";
      if (saveAddBtn) saveAddBtn.textContent = "Save Changes";
    } else {
      editingManualKey = null;
      if (addTitleInput) addTitleInput.value = "";
      if (addCourseInput) addCourseInput.value = "";
      if (addDateInput) addDateInput.value = "";
      if (addLocationInput) addLocationInput.value = "";
      if (addModalTitle) addModalTitle.textContent = "Add Deadline";
      if (saveAddBtn) saveAddBtn.textContent = "Add to Upcoming";
    }
    refreshAddModalVisibility();
    if (addModal) addModal.classList.remove("hidden");
    if (addTitleInput) addTitleInput.focus();
  }

  function closeAddModal() {
    if (addModal) addModal.classList.add("hidden");
    editingManualKey = null;
    returnModalFocus();
  }

  async function saveManualDeadline() {
    const site = currentSiteKey || currentBaseUrl;
    if (!site) {
      if (addStatusMsg) {
        addStatusMsg.textContent = "Connect your Moodle first.";
        addStatusMsg.className = "form-help-text error";
      }
      return;
    }
    const type = addTypeSelect ? addTypeSelect.value : "assignment";
    const subtype = (type === "exam" && addSubtypeSelect) ? addSubtypeSelect.value : null;
    const title = addTitleInput ? addTitleInput.value.trim() : "";
    const course = addCourseInput ? addCourseInput.value.trim() : "";
    const dateVal = addDateInput ? addDateInput.value : "";
    const timeVal = (addTimeInput && addTimeInput.value) ? addTimeInput.value : "23:59";
    const location = (addLocationInput && (type === "exam" || type === "quiz")) ? addLocationInput.value.trim() : "";

    if (!title) {
      if (addStatusMsg) {
        addStatusMsg.textContent = "Please enter a title.";
        addStatusMsg.className = "form-help-text error";
      }
      return;
    }
    const parsed = new Date(`${dateVal}T${timeVal}`);
    if (!dateVal || isNaN(parsed.getTime())) {
      if (addStatusMsg) {
        addStatusMsg.textContent = "Please choose a valid date and time.";
        addStatusMsg.className = "form-help-text error";
      }
      return;
    }
    const timesort = Math.floor(parsed.getTime() / 1000);

    let item;
    try {
      item = MoodleAPI.buildManualDeadline({ siteKey: site, type, subtype, title, course, courseId: null, timesort, location });
    } catch (err) {
      if (addStatusMsg) {
        addStatusMsg.textContent = err.message || "Could not create this deadline.";
        addStatusMsg.className = "form-help-text error";
      }
      return;
    }

    try {
      const baseData = {
        user: { isLoggedIn: false, name: null },
        institutionName: currentInstitutionName,
        moodleBaseUrl: site,
        courses: (currentData && Array.isArray(currentData.courses)) ? currentData.courses : [],
        deadlines: [],
        lastSynced: 0
      };
      const keyOf = (d) => {
        try {
          return MoodleAPI.buildStableKey(site, d);
        } catch (_) {
          return null;
        }
      };

      // Apply the change to the LATEST stored list (atomically) so a sync that
      // finished while the modal was open is never overwritten by a stale copy.
      const saved = await MoodleAPI.updateSiteData(site, (prev) => {
        const md = (prev.moodleData && typeof prev.moodleData === "object") ? { ...prev.moodleData } : baseData;
        let deadlines = Array.isArray(md.deadlines) ? [...md.deadlines] : [];
        let completed = (prev.completedDeadlines && typeof prev.completedDeadlines === "object") ? prev.completedDeadlines : {};
        const newItem = { ...item };

        if (editingManualKey) {
          // Edit mode: replace the original entry in place, keeping its manual
          // id for continuity. The rebuilt key inherits the Done mark so editing
          // never silently un-completes work; a changed timestamp still yields
          // fresh reminder keys downstream.
          const original = deadlines.find((d) => d && MoodleAPI.isManualItem(d) && keyOf(d) === editingManualKey);
          if (original && original.id) {
            newItem.id = original.id;
            const rebuilt = keyOf(newItem);
            if (rebuilt) newItem.stableKey = rebuilt;
          }
          let replaced = false;
          deadlines = deadlines.map((d) => {
            if (!d || !MoodleAPI.isManualItem(d) || keyOf(d) !== editingManualKey) return d;
            replaced = true;
            completed = MoodleAPI.moveCompletion(completed, editingManualKey, newItem.stableKey);
            return newItem;
          });
          if (!replaced) deadlines.push(newItem);
        } else {
          deadlines.push(newItem);
        }
        deadlines.sort((a, b) => a.timesort - b.timesort);
        return { moodleData: { ...md, deadlines }, completedDeadlines: completed };
      });
      if (!saved) throw new Error("Storage write failed");
      currentData = saved.moodleData;
      completedDeadlines = (saved.completedDeadlines && typeof saved.completedDeadlines === "object") ? saved.completedDeadlines : completedDeadlines;
      chrome.runtime.sendMessage({ action: "REFRESH_SITE_ALERTS" });
    } catch (err) {
      if (addStatusMsg) {
        addStatusMsg.textContent = "Could not save. Please try again.";
        addStatusMsg.className = "form-help-text error";
      }
      return;
    }

    // Reset form, close, and show the updated timeline.
    if (addTitleInput) addTitleInput.value = "";
    if (addCourseInput) addCourseInput.value = "";
    if (addDateInput) addDateInput.value = "";
    if (addLocationInput) addLocationInput.value = "";
    closeAddModal();
    updateUI(currentData);
  }

  if (addDeadlineBtn) {
    addDeadlineBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openAddModal();
    });
  }
  if (closeAddModalBtn) {
    closeAddModalBtn.addEventListener("click", closeAddModal);
  }
  if (addModal) {
    addModal.addEventListener("click", (e) => {
      if (e.target === addModal) closeAddModal();
    });
  }
  if (addTypeSelect) {
    addTypeSelect.addEventListener("change", refreshAddModalVisibility);
  }
  if (addSubtypeSelect) {
    addSubtypeSelect.addEventListener("change", refreshTitlePlaceholder);
  }
  if (saveAddBtn) {
    saveAddBtn.addEventListener("click", saveManualDeadline);
  }

  // Calendar .ics Exporter (RFC 5545)
  function formatICSDate(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return (
      date.getUTCFullYear() +
      pad(date.getUTCMonth() + 1) +
      pad(date.getUTCDate()) +
      "T" +
      pad(date.getUTCHours()) +
      pad(date.getUTCMinutes()) +
      pad(date.getUTCSeconds()) +
      "Z"
    );
  }

  function escapeICS(str) {
    if (!str) return "";
    return String(str)
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\n/g, "\\n");
  }

  // RFC 5545 §3.1: fold content lines at 75 octets (UTF-8 bytes), continuing
  // with CRLF + single space. Falls back to character count when TextEncoder
  // is unavailable (e.g. very old browsers).
  function icsOctetLength(str) {
    try {
      if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str).length;
    } catch (_) {}
    return String(str).length;
  }

  function foldICSLine(line) {
    if (!line) return [""];
    const MAX = 75;
    if (icsOctetLength(line) <= MAX) return [line];
    const parts = [];
    let current = "";
    let currentBytes = 0;
    for (const ch of String(line)) {
      let chBytes = ch.length;
      try {
        if (typeof TextEncoder !== "undefined") chBytes = new TextEncoder().encode(ch).length;
      } catch (_) {}
      const limit = parts.length === 0 ? MAX : MAX - 1;
      if (currentBytes + chBytes > limit && current) {
        parts.push(parts.length === 0 ? current : " " + current);
        current = "";
        currentBytes = 0;
      }
      current += ch;
      currentBytes += chBytes;
    }
    if (current) parts.push(parts.length === 0 ? current : " " + current);
    return parts.length > 0 ? parts : [line];
  }

  function icsUidFor(item) {
    try {
      const key = completionKeyFor(item) || String(item.id || item.timesort);
      let hash = 5381;
      for (let i = 0; i < key.length; i++) {
        hash = ((hash << 5) + hash + key.charCodeAt(i)) >>> 0;
      }
      return `neverlate-${hash.toString(36)}-${item.timesort}@neverlate.app`;
    } catch (_) {
      return `neverlate-${item.timesort}@neverlate.app`;
    }
  }

  function getActiveDeadlinesForExport(deadlines) {
    if (!Array.isArray(deadlines)) return [];
    const nowSec = Math.floor(Date.now() / 1000);
    return deadlines.filter((d) => d && typeof d.timesort === "number" && d.timesort > nowSec && !isCompleted(d));
  }

  function exportToCalendarICS(deadlines, institutionName = "Plaksha University") {
    const active = getActiveDeadlinesForExport(deadlines);
    if (active.length === 0) {
      showToast("No active deadlines available to export.");
      return;
    }

    const now = new Date();
    const nowStr = formatICSDate(now);

    const icsLines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//NeverLate//Academic Deadline Tracker//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      `X-WR-CALNAME:${escapeICS(institutionName)} Deadlines`,
      "X-WR-TIMEZONE:UTC"
    ];

    active.forEach((item) => {
      if (!item || typeof item.timesort !== "number") return;
      const dueDate = new Date(item.timesort * 1000);
      const dueStr = formatICSDate(dueDate);

      const course = item.courseShortName || item.courseName || "Course";
      const summary = `${course} — ${item.name || item.title || "Deliverable"}`;
      // Start with real newlines; escapeICS() converts them to ICS \n.
      // URL inclusion follows the user's calendar privacy preference.
      const descLines = [
        `Course: ${item.courseName || course}`,
        `Due: ${dueDate.toLocaleString()}`
      ];
      if (includeUrlInCalendar && item.url) descLines.push(`Portal: ${item.url}`);
      const desc = descLines.join("\n");

      const rawLines = [
        "BEGIN:VEVENT",
        `UID:${icsUidFor(item)}`,
        `DTSTAMP:${nowStr}`,
        // Same 30-minute block ending at the deadline as the Google/Outlook links.
        `DTSTART:${formatICSDate(new Date((item.timesort - 1800) * 1000))}`,
        `DTEND:${dueStr}`,
        `SUMMARY:${escapeICS(summary)}`,
        `DESCRIPTION:${escapeICS(desc)}`,
        ...((item.location && String(item.location).trim()) ? [`LOCATION:${escapeICS(String(item.location).trim().substring(0, 100))}`] : []),
        ...(includeUrlInCalendar && item.url && typeof item.url === "string" && item.url.startsWith("https://") ? [`URL:${item.url}`] : []),
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "DESCRIPTION:Reminder: 2 hours remaining",
        "TRIGGER:-PT90M",
        "END:VALARM",
        "END:VEVENT"
      ];
      rawLines.forEach((ln) => {
        foldICSLine(ln).forEach((folded) => icsLines.push(folded));
      });
    });

    icsLines.push("END:VCALENDAR");

    // Fold header lines too (institution names can be long).
    const foldedAll = [];
    // Header was already pushed unfolded; refold X-WR-CALNAME line for correctness.
    const finalLines = [];
    icsLines.forEach((ln) => {
      if (ln.startsWith("X-WR-CALNAME:") && ln.length > 75) {
        foldICSLine(ln).forEach((f) => finalLines.push(f));
      } else if (ln.startsWith("BEGIN:") || ln.startsWith("END:") || ln.startsWith("VERSION") || ln.startsWith("PRODID") || ln.startsWith("CALSCALE") || ln.startsWith("METHOD") || ln.startsWith("X-WR-TIMEZONE")) {
        finalLines.push(ln);
      } else if (ln.startsWith("UID:") || ln.startsWith("DTSTAMP:") || ln.startsWith("DTSTART:") || ln.startsWith("TRIGGER:") || ln.startsWith("ACTION:") || ln.startsWith("URL:")) {
        finalLines.push(ln);
      } else {
        finalLines.push(ln);
      }
    });
    foldedAll.push(...finalLines);

    const blob = new Blob([foldedAll.join("\r\n")], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `NeverLate-Deadlines.ics`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // Toggle Completed Deliverables disclosure
  if (toggleCompletedBtn) {
    toggleCompletedBtn.addEventListener("click", () => {
      isCompletedExpanded = !isCompletedExpanded;
      if (isCompletedExpanded) {
        if (completedList) completedList.classList.remove("hidden");
        if (completedArrow) completedArrow.classList.add("expanded");
      } else {
        if (completedList) completedList.classList.add("hidden");
        if (completedArrow) completedArrow.classList.remove("expanded");
      }
    });
  }

  // Export Popover Dropdown Controller
  function openExportPopover() {
    if (exportPopover) {
      exportPopover.classList.remove("hidden");
      if (exportDropdownWrapper) exportDropdownWrapper.classList.add("active");
    }
  }

  function closeExportPopover() {
    if (exportPopover) {
      exportPopover.classList.add("hidden");
      if (exportDropdownWrapper) exportDropdownWrapper.classList.remove("active");
    }
  }

  function toggleExportPopover() {
    if (exportPopover && exportPopover.classList.contains("hidden")) {
      openExportPopover();
    } else {
      closeExportPopover();
    }
  }

  if (exportMenuBtn) {
    exportMenuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleExportPopover();
    });
  }

  if (exportAllIcsBtn) {
    exportAllIcsBtn.addEventListener("click", () => {
      closeExportPopover();
      if (currentData && Array.isArray(currentData.deadlines)) {
        exportToCalendarICS(currentData.deadlines, currentInstitutionName);
      }
    });
  }

  if (exportNextGcalBtn) {
    exportNextGcalBtn.addEventListener("click", () => {
      closeExportPopover();
      const next = getNextUpcomingDeadline();
      if (next) {
        const url = getGoogleCalendarUrl(next);
        if (url) openCalendarUrl(url);
      } else {
        showToast("No upcoming deadlines to add.");
      }
    });
  }

  if (exportNextOutlookBtn) {
    exportNextOutlookBtn.addEventListener("click", () => {
      closeExportPopover();
      const next = getNextUpcomingDeadline();
      if (next) {
        const url = getOutlookCalendarUrl(next);
        if (url) openCalendarUrl(url);
      } else {
        showToast("No upcoming deadlines to add.");
      }
    });
  }

  // Dismiss export popover when clicking outside
  document.addEventListener("click", (e) => {
    if (exportDropdownWrapper && !exportDropdownWrapper.contains(e.target)) {
      closeExportPopover();
    }
  });

  // Native Keyboard Shortcuts (Raycast-like navigation)
  window.addEventListener("keydown", (e) => {
    const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : "";
    if (activeTag === "input" || activeTag === "textarea" || activeTag === "select") {
      if (e.key === "Escape") {
        const hadModal = isAnyModalOpen();
        closeExportPopover();
        closeAddModal();
        // Modal closes already return focus to their opener; only blur when
        // nothing was open.
        if (!hadModal && document.activeElement) document.activeElement.blur();
      }
      return;
    }

    if (e.key === "Escape") {
      closeExportPopover();
      closeAddModal();
    } else if (e.key === "1") {
      const seg = document.querySelector('.segment[data-tab="deadlines-tab"]');
      if (seg) seg.click();
    } else if (e.key === "2") {
      const seg = document.querySelector('.segment[data-tab="courses-tab"]');
      if (seg) seg.click();
    } else if (e.key === "r" || e.key === "R") {
      requestSync(true, false);
    } else if (e.key === "e" || e.key === "E") {
      if (currentData && Array.isArray(currentData.deadlines)) {
        exportToCalendarICS(currentData.deadlines, currentInstitutionName);
      }
    } else if (e.key === "g" || e.key === "G") {
      const next = getNextUpcomingDeadline();
      if (next) {
        const url = getGoogleCalendarUrl(next);
        if (url) openCalendarUrl(url);
      }
    } else if (e.key === "o" || e.key === "O") {
      const next = getNextUpcomingDeadline();
      if (next) {
        const url = getOutlookCalendarUrl(next);
        if (url) openCalendarUrl(url);
      }
    }
  });

  // Main UI Action Listeners (manual sync is NEVER forced; background enforces cooldowns)
  syncBtn.addEventListener("click", () => requestSync(true, false));
  if (initialSyncTrigger) {
    initialSyncTrigger.addEventListener("click", () => requestSync(true, false));
  }

  courseFilter.addEventListener("change", (e) => {
    selectedCourseId = e.target.value;
    renderDeadlines();
  });

  // Popup close cleanup
  window.addEventListener("pagehide", () => {
    if (renderTimeout) {
      clearTimeout(renderTimeout);
      renderTimeout = null;
    }
  });

  window.addEventListener("unload", () => {
    if (renderTimeout) {
      clearTimeout(renderTimeout);
      renderTimeout = null;
    }
  });

  // Builder credit (name only, no affiliation): version is read live from
  // the manifest so it never goes stale.
  try {
    const creditLine = document.getElementById("credit-line");
    if (creditLine) {
      let version = "";
      try {
        version = (chrome.runtime && chrome.runtime.getManifest) ? chrome.runtime.getManifest().version : "";
      } catch (_) {}
      creditLine.textContent = version ? `NeverLate v${version} · Made by Arnav Attri` : "Made by Arnav Attri";
    }
  } catch (_) {}

  // Live UI reactivity: sync UI automatically whenever THIS site's storage updates.
  // State is namespaced per Moodle site; other universities' buckets are ignored.
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (changes.moodleBaseUrl) {
        const next = changes.moodleBaseUrl.newValue || null;
        if (next !== currentBaseUrl) {
          currentBaseUrl = next;
          currentSiteKey = next;
          // Active site switched elsewhere: reload that site's isolated state.
          (async () => {
            try {
              currentInstitutionName = await MoodleAPI.getInstitutionName();
              if (!currentBaseUrl) {
                showUnconfiguredState();
                return;
              }
              const siteData = await MoodleAPI.getSiteData(currentBaseUrl);
              completedDeadlines = siteData.completedDeadlines || {};
              if (siteData.moodleData) updateUI(siteData.moodleData);
              else showUnconfiguredState();
            } catch (_) {}
          })();
        }
        return;
      }
      if (changes.sites && changes.sites.newValue) {
        const nextSites = changes.sites.newValue;
        const bucket = currentBaseUrl ? nextSites[currentBaseUrl] : null;
        if (bucket) {
          if (bucket.institutionName) {
            currentInstitutionName = bucket.institutionName;
          } else if (bucket.moodleData && bucket.moodleData.institutionName) {
            currentInstitutionName = bucket.moodleData.institutionName;
          }
          if (bucket.completedDeadlines) {
            completedDeadlines = bucket.completedDeadlines;
          }
          if (bucket.moodleData) {
            updateUI(bucket.moodleData);
          } else {
            renderDeadlines();
          }
        } else if (currentBaseUrl) {
          renderDeadlines();
        }
        return;
      }
      // Legacy top-level keys (pre-2.2.1): honor only when they belong to active site era.
      if (changes.moodleData && changes.moodleData.newValue && !changes.sites) {
        if (changes.moodleData.newValue.institutionName) {
          currentInstitutionName = changes.moodleData.newValue.institutionName;
        }
        updateUI(changes.moodleData.newValue);
      }
    });
  }

  // Initial Load: Cache-First, per-site isolated, never another site's cache.
  try {
    currentBaseUrl = await MoodleAPI.getBaseUrl();
    currentSiteKey = currentBaseUrl;
    currentInstitutionName = await MoodleAPI.getInstitutionName();

    updateAlertsState();

    if (!currentBaseUrl) {
      // Fresh install, no university configured: onboarding only, zero network traffic.
      showUnconfiguredState();
      updateAlertsState();
      if (moodlePortalLink) moodlePortalLink.href = "#";
    } else {
      const siteData = await MoodleAPI.getSiteData(currentBaseUrl);
      if (siteData.institutionName) {
        currentInstitutionName = siteData.institutionName;
      } else if (siteData.moodleData && siteData.moodleData.institutionName) {
        currentInstitutionName = siteData.moodleData.institutionName;
      }
      if (siteData.completedDeadlines && typeof siteData.completedDeadlines === "object") {
        completedDeadlines = siteData.completedDeadlines;
      }

      const cached = siteData.moodleData;
      if (cached && cached.user) {
        updateUI(cached);

        const isUserLoggedIn = cached.user.isLoggedIn === true;

        // If cached state is logged-out, automatically verify session in background
        // in case the student just authenticated in another tab (non-forced).
        if (!isUserLoggedIn) {
          setTimeout(() => {
            requestSync(false, false);
          }, 150);
        } else {
          // Automatic background refresh only for genuinely stale or ambiguous data.
          // Ordinary 30-minute staleness uses cache; ~2.5h triggers a non-forced refresh.
          const now = Date.now();
          const lastSync = cached.lastSynced || 0;
          const deadlines = cached.deadlines || [];
          const hasAmbiguous = deadlines.some(
            (d) => !d || d.isAmbiguous || !d.courseId || d.name === "Assignment" || d.name === "Go to activity" || d.courseShortName === "Course Event" || d.courseShortName === "General"
          );

          const STALE_MS = 150 * 60 * 1000; // ~2.5 hours
          if (hasAmbiguous || (now - lastSync > STALE_MS)) {
            setTimeout(() => {
              requestSync(false, false);
            }, 300);
          }
        }
      } else {
        // Site configured but no cache yet: prompt sync (non-forced), no cross-site data.
        if (readySyncState) {
          readySyncState.classList.remove("hidden");
          const titleEl = readySyncState.querySelector(".empty-title");
          const descEl = document.getElementById("ready-sync-desc");
          if (titleEl) titleEl.textContent = "Ready to Sync";
          if (descEl) descEl.textContent = `Click "Sync" to load your enrolled courses and upcoming deadlines from ${currentInstitutionName}.`;
          if (initialSyncTrigger) initialSyncTrigger.textContent = "Sync";
        }
        deadlinesList.classList.add("hidden");
        deadlinesEmpty.classList.add("hidden");
        coursesList.classList.add("hidden");
        coursesEmpty.classList.add("hidden");
        loggedOutState.classList.add("hidden");
        userDisplay.textContent = `Student • ${currentInstitutionName}`;
        statusText.textContent = `Ready • ${currentInstitutionName}`;
        statusDot.className = "dot warning";
        if (moodlePortalLink) moodlePortalLink.href = `${currentBaseUrl}/my/`;

        setTimeout(() => {
          requestSync(false, false);
        }, 150);
      }
    }
  } catch (err) {
    console.warn("[Popup] Storage load error:", err);
    if (readySyncState) readySyncState.classList.remove("hidden");
  }
});
