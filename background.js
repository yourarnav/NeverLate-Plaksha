/**
 * NeverLate Plaksha-Only — Background Service Worker
 * Fixed single-site tracker for https://lms.plaksha.edu.in
 * (dle.plaksha.edu.in redirects there and is canonicalized).
 * Load-Conscious Reliable Architecture:
 * - In-flight sync lock (prevents duplicate requests)
 * - Jittered initial alarm (20-60m) and 3-hour cycle
 * - Multi-tier cooldown: NON-BYPASSABLE attempt throttle (10s manual / 45s auto),
 *   bypassable success cooldown (3min manual / 120m auto, force only bypasses this)
 * - Static content scripts (manifest-declared for both Plaksha hosts)
 * - Auto-sync shortly after any Plaksha LMS page finishes loading
 * - No network traffic when signed out / backoff active
 */

importScripts("scripts/moodle-api.js");

const ALARM_SYNC = "neverlate_moodle_sync";
const LEGACY_ALARM_SYNC = "plaksha_dle_sync";
const ALERT_ALARM = "neverlate_next_deadline_alert";
const LEGACY_ALERT_ALARM = "plaksha_next_deadline_alert";
// One-shot re-verify when a logged-out check was refused by the throttle.
const RETRY_ALARM = "neverlate_logged_out_recheck";

// Restrict local storage access to trusted extension contexts only
if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local && chrome.storage.local.setAccessLevel) {
  chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS"
  }).catch(() => {});
}

// Per-site concurrency locks (siteKey -> Promise)
const inFlightSyncBySite = new Map();
let alertProcessingPromise = null;

/**
 * Centralized safe synchronization controller (per-site isolated).
 * - Attempt throttle is NEVER bypassable (prevents hammering Moodle).
 * - `force` bypasses ONLY the successful-cache cooldown (repair path).
 * - No university configured -> no network requests.
 * - Stale-switch guard: the site is captured at start and echoed back as
 *   `siteKey`; badge/alert updates are skipped when the user has since
 *   switched to a different university.
 */
async function safeSync(isManual = false, force = false) {
  const activeSite = await MoodleAPI.getBaseUrl();
  if (!activeSite) {
    return {
      success: false,
      notConfigured: true,
      error: "Plaksha LMS unavailable",
      data: null,
      siteKey: null
    };
  }

  // Check-and-register must happen in the same synchronous turn (no await
  // in between) or concurrent triggers can each start their own sync.
  if (inFlightSyncBySite.has(activeSite)) {
    console.log("[Background] Reusing existing in-flight sync operation for site");
    return inFlightSyncBySite.get(activeSite);
  }

  const lockedPromise = _runSafeSync(activeSite, isManual, force)
    .catch((err) => {
      console.warn("[Background] safeSync failed:", err);
      return { success: false, error: err.message, siteKey: activeSite };
    })
    .finally(() => {
      inFlightSyncBySite.delete(activeSite);
    });
  inFlightSyncBySite.set(activeSite, lockedPromise);
  return lockedPromise;
}

async function _runSafeSync(activeSite, isManual, force) {
  const siteData = await MoodleAPI.getSiteData(activeSite);
  const now = Date.now();
  const elapsedSinceAttempt = now - (siteData.lastServerAttempt || 0);
  const elapsedSinceSuccess = now - (siteData.lastServerSync || 0);

  // Check if current cached data contains placeholder/corrupted deadlines that need fresh server sync
  const deadlines = (siteData.moodleData && Array.isArray(siteData.moodleData.deadlines)) ? siteData.moodleData.deadlines : [];
  const hasCorruptedLegacyData = deadlines.some(
    d => !d || d.name === "Assignment" || d.name === "Go to activity" || (d.id && String(d.id).includes("Go to acti")) || d.courseShortName === "Course Event" || d.courseShortName === "General"
  );

  // 1. Attempt throttle: ALWAYS enforced, never bypassable (even with force=true).
  // 10s for manual clicks, 45s for automated syncs.
  const attemptCooldown = isManual ? (10 * 1000) : (45 * 1000);
  if (siteData.lastServerAttempt && elapsedSinceAttempt < attemptCooldown) {
    const waitSec = Math.ceil((attemptCooldown - elapsedSinceAttempt) / 1000);
    console.log(`[Background] Attempt rate limit enforced: wait ${waitSec}s`);
    // Owed check: the cache says signed-out, so the student may have just
    // signed in. Re-verify once the throttle expires instead of going silent
    // (which strands the UI on the sign-in screen until a manual sync).
    if (!isManual && MoodleAPI.isLoggedOutData(siteData.moodleData)) {
      scheduleLoggedOutRecheck(waitSec).catch(() => {});
    }
    return {
      success: true,
      cached: true,
      rateLimited: true,
      data: siteData.moodleData,
      error: `Please wait ${waitSec}s between sync attempts`,
      cooldownRemainingSec: waitSec,
      siteKey: activeSite
    };
  }

  // 2. Success cooldown: bypassable via explicit force (repair) or corrupted cache.
  // Manual success cooldown is 3 minutes; background scheduled sync is 120 minutes.
  // Placeholder/"General" items can persist legitimately (unmatched course), so a
  // corrupted-looking cache may only repair itself once per 10 minutes instead of
  // re-syncing on every page load.
  // A signed-out cache always bypasses it too: a purge leaves lastServerSync
  // untouched, so without this a fresh login within the cooldown would not sync.
  const cacheSaysSignedOut = !!siteData.moodleData && MoodleAPI.isLoggedOutData(siteData.moodleData);
  const shouldBypassSuccessCooldown = (force === true) || cacheSaysSignedOut || (hasCorruptedLegacyData && elapsedSinceSuccess >= 10 * 60 * 1000);
  if (!shouldBypassSuccessCooldown) {
    const requiredSuccessCooldown = isManual ? (3 * 60 * 1000) : (120 * 60 * 1000);
    if (siteData.lastServerSync && elapsedSinceSuccess < requiredSuccessCooldown) {
      const waitSec = Math.ceil((requiredSuccessCooldown - elapsedSinceSuccess) / 1000);
      console.log(`[Background] Rate limit enforced: ${waitSec}s cooldown remaining`);
      return {
        success: true,
        cached: true,
        data: siteData.moodleData,
        cooldownRemainingSec: waitSec,
        siteKey: activeSite
      };
    }
  }

  const siteAtStart = activeSite;
  // Record attempt timestamp BEFORE firing network requests (per-site).
  await MoodleAPI.saveSiteData(siteAtStart, { lastServerAttempt: Date.now() });

  // Pass the captured site explicitly. syncAll must never resolve the active
  // site a second time after the user has had a chance to switch universities.
  let res = await MoodleAPI.syncAll(siteAtStart);
  res = res || {};
  res.siteKey = siteAtStart;
  // Stale-switch guard: only touch badge/alerts when this sync's site is
  // still the active university. Cache writes already landed in the
  // correct per-site bucket inside syncAll().
  const stillActive = (await MoodleAPI.getBaseUrl()) === siteAtStart;
  if (res.success && res.data) {
    await MoodleAPI.saveSiteData(siteAtStart, { lastServerSync: Date.now() });
    if (stillActive) {
      await updateBadgeAndTooltip(res.data.deadlines, res.data.institutionName, siteAtStart);
      await processDueAlerts();
    } else {
      console.log("[Background] Sync finished for a non-active site; skipping badge/alert update");
    }
  } else if (res.transientFailure && res.data) {
    // Network/server temporary issue: preserve existing badge from THIS site's cache.
    if (stillActive) {
      await updateBadgeAndTooltip(res.data.deadlines || [], res.data.institutionName, siteAtStart);
    }
  } else if (res.verifiedLoggedOut) {
    if (stillActive) {
      await updateBadgeAndTooltip([], res.data?.institutionName, siteAtStart);
    }
  } else if (res.notConfigured) {
    if (stillActive) {
      await updateBadgeAndTooltip([], null, siteAtStart);
    }
  }
  return res;
}

function formatCountdownString(timesort) {
  const nowSec = Math.floor(Date.now() / 1000);
  const diffSec = timesort - nowSec;
  if (diffSec <= 0) return "Overdue";
  const diffHours = Math.floor(diffSec / 3600);
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays >= 1) {
    return diffDays === 1 ? "1 day left" : `${diffDays} days left`;
  }
  const remMins = Math.floor((diffSec % 3600) / 60);
  if (diffHours >= 1) {
    return `${diffHours}h ${remMins}m left`;
  }
  return `${remMins}m left`;
}

function getTooltipString(deadlines, institutionName = "NeverLate") {
  const now = Math.floor(Date.now() / 1000);
  const upcoming = (deadlines || []).filter(d => d && typeof d.timesort === "number" && d.timesort > now);
  const label = institutionName || "NeverLate";

  if (upcoming.length === 0) {
    return `${label}: All deadlines completed`;
  }

  upcoming.sort((a, b) => a.timesort - b.timesort);
  const next = upcoming[0];
  const timeStr = formatCountdownString(next.timesort);
  const course = (next.courseShortName || next.courseName || "Course").substring(0, 30);
  const title = (next.name || "Deliverable").substring(0, 50);

  return `${label}: ${title} (${timeStr}) - ${course}`;
}

async function updateBadgeAndTooltip(deadlines, institutionName, siteKeyHint = null) {
  try {
    const activeSite = siteKeyHint || await MoodleAPI.getBaseUrl();
    let instName = institutionName;
    let completedMap = {};
    if (activeSite) {
      const data = await MoodleAPI.getSiteData(activeSite);
      completedMap = data.completedDeadlines || {};
      if (!instName) {
        instName = data.institutionName || (data.moodleData && data.moodleData.institutionName) || await MoodleAPI.getInstitutionName();
      }
    } else {
      instName = instName || "NeverLate";
    }

    const now = Math.floor(Date.now() / 1000);
    const upcoming = (deadlines || []).filter(
      (d) => d && typeof d.timesort === "number" && d.timesort > now && !MoodleAPI.isCompleted(d, completedMap, activeSite)
    );

    const tooltip = getTooltipString(upcoming, instName);
    await chrome.action.setTitle({ title: tooltip });

    if (upcoming.length > 0) {
      await chrome.action.setBadgeText({ text: String(upcoming.length) });
      await chrome.action.setBadgeBackgroundColor({ color: "#D70015" });
      if (chrome.action.setBadgeTextColor) {
        await chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
      }
    } else {
      await chrome.action.setBadgeText({ text: "" });
    }
  } catch (err) {
    console.warn("[Background] Badge/Tooltip error:", err);
  }
}

/* ==========================================================================
   Canonical Deadline Alert Engine (v1.1.0)
   - Morning digest (8 AM local) with 8 AM - 12 PM catch-up window
   - 2-Hour Urgent Reminder (catch-up on wake before deadline; Chrome alarms
     may be delayed while the device sleeps)
   - Per-site versioned persistent deduplication
   - Single dynamic alert alarm (recalculated after each lifecycle event)
   - Zero additional network traffic to Moodle
   ========================================================================== */

async function hasNotificationPermission() {
  try {
    if (typeof chrome === "undefined" || !chrome.notifications || !chrome.permissions) {
      return false;
    }
    const hasPerm = await chrome.permissions.contains({ permissions: ["notifications"] });
    if (!hasPerm) return false;
    const level = await new Promise((resolve) => {
      if (typeof chrome.notifications.getPermissionLevel === "function") {
        chrome.notifications.getPermissionLevel(resolve);
      } else {
        resolve("granted");
      }
    });
    return level === "granted";
  } catch (err) {
    console.warn("[Background] Notification permission check error:", err);
    return false;
  }
}

async function areAlertsEnabled() {
  try {
    const stored = await chrome.storage.local.get(["alertSettings"]);
    if (!stored.alertSettings || stored.alertSettings.enabled !== true) {
      return false;
    }
    return await hasNotificationPermission();
  } catch (_) {
    return false;
  }
}

// Optional extra heads-ups the student switched on (global preference;
// fired-reminder memory itself stays per-site like everything else).
async function getEnabledExtraTypes() {
  try {
    const stored = await chrome.storage.local.get(["alertSettings"]);
    return MoodleAPI.enabledExtraTypes(stored.alertSettings);
  } catch (_) {
    return [];
  }
}

function getLocalTomorrowDueDateString(nowDate = new Date()) {
  const tomorrow = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + 1);
  const y = tomorrow.getFullYear();
  const m = String(tomorrow.getMonth() + 1).padStart(2, "0");
  const d = String(tomorrow.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getTomorrowLocalBounds(nowDate = new Date()) {
  const tomorrow = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + 1);
  const y = tomorrow.getFullYear();
  const m = tomorrow.getMonth();
  const d = tomorrow.getDate();
  const startMs = new Date(y, m, d, 0, 0, 0, 0).getTime();
  const endMs = new Date(y, m, d, 23, 59, 59, 999).getTime();
  return { startMs, endMs };
}

function getTodayMorningWindow(nowDate = new Date()) {
  const y = nowDate.getFullYear();
  const m = nowDate.getMonth();
  const d = nowDate.getDate();
  const start8am = new Date(y, m, d, 8, 0, 0, 0).getTime();
  const endNoon = new Date(y, m, d, 12, 0, 0, 0).getTime();
  return { start8am, endNoon };
}

function formatAlertTime(timesort) {
  const d = new Date(timesort * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function extractDeadlineKey(notificationId) {
  // Format: deadline:<siteKey>|<activityUrlOrEvent>:<timesort>:<type>
  // activityUrl contains colons, so anchor on numeric timesort suffix.
  try {
    const parsed = MoodleAPI.parseReminderKey(notificationId);
    return parsed && parsed.completionKey ? parsed.completionKey : null;
  } catch (_) {
    return null;
  }
}

function isFired(firedMap, newKey, legacyKey) {
  if (!firedMap || typeof firedMap !== "object") return false;
  if (newKey && firedMap[newKey]) return true;
  if (legacyKey && firedMap[legacyKey]) return true;
  return false;
}

function completionKeysForItem(item, siteKey) {
  const keys = [];
  try {
    const k = MoodleAPI.getCompletionKey(item, siteKey);
    if (k) keys.push(k);
  } catch (_) {}
  try {
    if (item && item.id !== undefined && item.id !== null) keys.push(String(item.id));
  } catch (_) {}
  return keys;
}

async function sanitizeMoodleClickUrl(rawUrl) {
  const baseUrl = await MoodleAPI.getBaseUrl();
  if (!baseUrl) return null;
  const fallback = `${baseUrl}/my/`;
  if (!rawUrl || typeof rawUrl !== "string") return fallback;
  try {
    const parsed = new URL(rawUrl, fallback);
    const parsedBase = new URL(baseUrl);
    if (parsed.protocol !== "https:") return fallback;
    if (parsed.origin !== parsedBase.origin) return fallback;
    const basePath = (parsedBase.pathname || "").replace(/\/+$/, "");
    if (basePath && basePath !== "" && basePath !== "/") {
      if (!(parsed.pathname === basePath || parsed.pathname.startsWith(basePath + "/"))) {
        return fallback;
      }
    }
    return parsed.href;
  } catch (_) {}
  return fallback;
}

function formatAlertDay(timesort) {
  const d = new Date(timesort * 1000);
  return d.toLocaleDateString([], { weekday: "long" });
}

function displayNameOf(item) {
  let itemName = item.name || item.title;
  if (!itemName || /^go to activity$/i.test(itemName) || /^view activity$/i.test(itemName)) {
    itemName = (item.activityname && !/^go to activity$/i.test(item.activityname)) ? item.activityname : "Assignment";
  }
  return itemName;
}

function courseOf(item) {
  return (item.courseShortName && item.courseShortName !== "—" && item.courseShortName !== "Course Event"
    ? item.courseShortName
    : (item.courseName && item.courseName !== "—" && item.courseName !== "Course Event" ? item.courseName : "Course")
  ).substring(0, 30);
}

function examLabelOf(item) {
  try {
    return MoodleAPI.examSubtypeLabel(item && item.subtype);
  } catch (_) {
    return "Exam";
  }
}

async function deliverUrgentAlert(item, minsRemaining, notificationId, reminderType = "2h") {
  const course = courseOf(item);
  const itemName = displayNameOf(item);
  const isExam = String(item.type || "").toLowerCase() === "exam";
  const loc = (item.location && String(item.location).trim()) ? ` · ${String(item.location).trim().substring(0, 40)}` : "";
  const leadLabel = MoodleAPI.reminderLeadLabel(reminderType);

  const title = isExam
    ? `${course} ${examLabelOf(item)} ${leadLabel}`
    : `Upcoming Deadline (${reminderType}): ${course}`;
  const dueTimeStr = formatAlertTime(item.timesort);
  const message = isExam
    ? `${itemName}\n${dueTimeStr}${loc}`
    : `${itemName}\nDue at ${dueTimeStr} (~${minsRemaining}m remaining)${loc}`;

  return new Promise((resolve) => {
    chrome.notifications.create(
      notificationId,
      {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: title,
        message: message,
        priority: 2,
        requireInteraction: false
      },
      (id) => {
        if (chrome.runtime.lastError) {
          console.warn("[Background] Urgent alert creation failed:", chrome.runtime.lastError.message);
          resolve(false);
          return;
        }
        resolve(Boolean(id));
      }
    );
  });
}

async function deliverDigest(items, dueDateStr, notificationId, isUpdate = false) {
  const count = items.length;
  const title = isUpdate
    ? `Updated Morning Brief: ${count} new deadline${count > 1 ? "s" : ""} tomorrow`
    : `Morning Brief: ${count} deadline${count > 1 ? "s" : ""} tomorrow`;

  let lines = [];
  items.slice(0, 4).forEach((it) => {
    const course = (it.courseShortName && it.courseShortName !== "—" && it.courseShortName !== "Course Event"
      ? it.courseShortName
      : (it.courseName && it.courseName !== "—" && it.courseName !== "Course Event" ? it.courseName : "Course")
    ).substring(0, 20);

    let itName = displayNameOf(it);
    let typeLabel = "ASSIGNMENT";
    try {
      typeLabel = MoodleAPI.eventTypeLabel(it);
    } catch (_) {}

    const timeStr = formatAlertTime(it.timesort);
    lines.push(`• ${typeLabel} · ${itName} (${course}) · ${timeStr}`);
  });
  if (count > 4) {
    lines.push(`...and ${count - 4} more`);
  }

  const message = lines.join("\n");

  return new Promise((resolve) => {
    chrome.notifications.create(
      notificationId,
      {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: title,
        message: message,
        priority: 1,
        requireInteraction: false
      },
      (id) => {
        if (chrome.runtime.lastError) {
          console.warn("[Background] Digest creation failed:", chrome.runtime.lastError.message);
          resolve(false);
          return;
        }
        resolve(Boolean(id));
      }
    );
  });
}

async function deliverExamPlanningAlert(item, notificationId) {
  const course = courseOf(item);
  const itemName = displayNameOf(item);
  const label = examLabelOf(item);
  const dayStr = formatAlertDay(item.timesort);
  const timeStr = formatAlertTime(item.timesort);
  const loc = (item.location && String(item.location).trim()) ? `\n${String(item.location).trim().substring(0, 60)}` : "";

  return new Promise((resolve) => {
    chrome.notifications.create(
      notificationId,
      {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: `${course} ${label} in 7 days`,
        message: `${itemName}\n${dayStr} · ${timeStr}${loc}`,
        priority: 1,
        requireInteraction: false
      },
      (id) => {
        if (chrome.runtime.lastError) {
          console.warn("[Background] Exam planning alert creation failed:", chrome.runtime.lastError.message);
          resolve(false);
          return;
        }
        resolve(Boolean(id));
      }
    );
  });
}

async function processDueAlerts() {
  if (alertProcessingPromise) {
    console.log("[Background] Reusing existing alert processing operation");
    return alertProcessingPromise;
  }

  alertProcessingPromise = _internalProcessDueAlerts()
    .catch((err) => {
      console.warn("[Background] processDueAlerts error:", err);
    })
    .finally(() => {
      alertProcessingPromise = null;
    });

  return alertProcessingPromise;
}

async function _internalProcessDueAlerts() {
  const enabled = await areAlertsEnabled();
  if (!enabled) {
    await recalculateNextAlertAlarm();
    return;
  }

  const activeSite = await MoodleAPI.getBaseUrl();
  if (!activeSite) {
    await recalculateNextAlertAlarm();
    return;
  }
  const siteData = await MoodleAPI.getSiteData(activeSite);
  const deadlines = (siteData.moodleData && Array.isArray(siteData.moodleData.deadlines))
    ? siteData.moodleData.deadlines
    : [];
  const completedMap = (siteData.completedDeadlines && typeof siteData.completedDeadlines === "object")
    ? siteData.completedDeadlines
    : {};
  let fired = (siteData.firedReminders && typeof siteData.firedReminders === "object")
    ? { ...siteData.firedReminders }
    : {};

  const nowMs = Date.now();
  const nowDate = new Date(nowMs);

  // Prune reminder memory only after each deadline is well past (see
  // pruneFiredReminders): age-based pruning re-fired the 7-day exam heads-up.
  const pruneResult = MoodleAPI.pruneFiredReminders(fired, nowMs);
  fired = pruneResult.fired;
  const pruned = pruneResult.pruned;

  let digestItems = (siteData.firedDigestItems && typeof siteData.firedDigestItems === "object")
    ? { ...siteData.firedDigestItems }
    : {};
  let digestItemsPruned = false;
  for (const k in digestItems) {
    if (!fired[k]) {
      delete digestItems[k];
      digestItemsPruned = true;
    }
  }

  if (pruned || digestItemsPruned) {
    const toUpdate = {};
    if (pruned) toUpdate.firedReminders = fired;
    if (digestItemsPruned) toUpdate.firedDigestItems = digestItems;
    await MoodleAPI.saveSiteData(activeSite, toUpdate);
  }

  // 1. Morning Digest (8 AM - 12 PM catch-up window, skipping completed items)
  const { start8am, endNoon } = getTodayMorningWindow(nowDate);
  if (nowMs >= start8am && nowMs <= endNoon) {
    const dueDateStr = getLocalTomorrowDueDateString(nowDate);
    const digestKey = MoodleAPI.getDigestKey(activeSite, dueDateStr);
    const legacyDigestKey = `digest:${dueDateStr}`;
    const { startMs: tomStartMs, endMs: tomEndMs } = getTomorrowLocalBounds(nowDate);
    const tomorrowDeadlines = deadlines.filter((d) => {
      if (!d || typeof d.timesort !== "number" || MoodleAPI.isCompleted(d, completedMap, activeSite)) return false;
      const dMs = d.timesort * 1000;
      return dMs >= tomStartMs && dMs <= tomEndMs;
    });

    if (tomorrowDeadlines.length > 0) {
      const storedDigestItems = { ...digestItems };
      const alertedKeys = Array.isArray(storedDigestItems[digestKey])
        ? storedDigestItems[digestKey]
        : [];
      // Backwards-compat: also consider legacy digest item ids recorded under old key.
      const legacyAlertedIds = Array.isArray(storedDigestItems[legacyDigestKey])
        ? storedDigestItems[legacyDigestKey]
        : [];
      const alreadyAlerted = new Set([...alertedKeys, ...legacyAlertedIds]);

      if (!isFired(fired, digestKey, legacyDigestKey)) {
        // Initial morning planning digest
        const ok = await deliverDigest(tomorrowDeadlines, dueDateStr, digestKey, false);
        if (ok) {
          fired[digestKey] = Date.now();
          const newKeys = [];
          tomorrowDeadlines.forEach((d) => {
            completionKeysForItem(d, activeSite).forEach((k) => {
              if (!newKeys.includes(k)) newKeys.push(k);
            });
          });
          storedDigestItems[digestKey] = newKeys;
          await MoodleAPI.saveSiteData(activeSite, {
            firedReminders: fired,
            firedDigestItems: storedDigestItems
          });
          console.log(`[Background] Delivered morning digest for ${dueDateStr}`);
        }
      } else {
        // Newly discovered assignment due tomorrow inside morning planning window (8 AM - 12 PM)
        const newItems = tomorrowDeadlines.filter((d) => {
          const keys = completionKeysForItem(d, activeSite);
          return !keys.some((k) => alreadyAlerted.has(k));
        });
        if (newItems.length > 0) {
          const updateNotificationId = `${digestKey}:update:${Date.now()}`;
          const ok = await deliverDigest(newItems, dueDateStr, updateNotificationId, true);
          if (ok) {
            const addKeys = [];
            newItems.forEach((d) => {
              completionKeysForItem(d, activeSite).forEach((k) => {
                if (!addKeys.includes(k)) addKeys.push(k);
              });
            });
            storedDigestItems[digestKey] = [...alertedKeys, ...addKeys];
            await MoodleAPI.saveSiteData(activeSite, { firedDigestItems: storedDigestItems });
            console.log(`[Background] Delivered catch-up morning digest for ${newItems.length} new deadline(s)`);
          }
        }
      }
    }
  }

  // 2. 2-Hour Urgent Reminder (fires when nowMs >= urgentMs and nowMs < deadlineMs, skipping completed items)
  // 3. Exam 7-day planning reminder (fires when nowMs >= examMs - 7d and nowMs < examMs).
  // 4. Optional student-enabled extras (6h / 30m), uniform across all types.
  const extraTypes = await getEnabledExtraTypes();
  const offsets = MoodleAPI.reminderOffsetsMs();
  for (const item of deadlines) {
    if (!item || typeof item.timesort !== "number" || item.id === undefined || item.id === null) {
      continue;
    }
    // Student marked this as completed — suppress alert!
    if (MoodleAPI.isCompleted(item, completedMap, activeSite)) {
      continue;
    }

    const deadlineMs = item.timesort * 1000;
    const urgentMs = deadlineMs - (2 * 60 * 60 * 1000);

    if (nowMs >= urgentMs && nowMs < deadlineMs) {
      const dedupeKey = MoodleAPI.getReminderKey(activeSite, item, "2h");
      const legacyKey = `deadline:${item.id}:${item.timesort}:2h`;
      if (!isFired(fired, dedupeKey, legacyKey)) {
        const minsRemaining = Math.max(1, Math.round((deadlineMs - nowMs) / 60000));
        const ok = await deliverUrgentAlert(item, minsRemaining, dedupeKey);
        if (ok) {
          fired[dedupeKey] = Date.now();
          await MoodleAPI.saveSiteData(activeSite, { firedReminders: fired });
          console.log(`[Background] Delivered 2h urgent alert for ${item.name} (${dedupeKey})`);
        }
      }
    }

    // Exams get an extra calm planning heads-up 7 days out (catch-up on wake
    // included: fires whenever we observe now inside the 7d window).
    if (String(item.type || "").toLowerCase() === "exam") {
      const planningMs = deadlineMs - (7 * 24 * 60 * 60 * 1000);
      if (nowMs >= planningMs && nowMs < deadlineMs) {
        const planKey = MoodleAPI.getReminderKey(activeSite, item, "7d");
        if (!isFired(fired, planKey, null)) {
          const ok = await deliverExamPlanningAlert(item, planKey);
          if (ok) {
            fired[planKey] = Date.now();
            await MoodleAPI.saveSiteData(activeSite, { firedReminders: fired });
            console.log(`[Background] Delivered 7d exam planning alert for ${item.name} (${planKey})`);
          }
        }
      }
    }

    // Optional extras share the urgent copy (it already states ~Xm remaining
    // and any location), so no new notification templates are needed.
    for (const extra of extraTypes) {
      if (extra === "2h" || extra === "7d") continue;
      const offset = offsets[extra];
      if (!offset) continue;
      const fireMs = deadlineMs - offset;
      if (nowMs >= fireMs && nowMs < deadlineMs) {
        const extraKey = MoodleAPI.getReminderKey(activeSite, item, extra);
        if (!isFired(fired, extraKey, null)) {
          const minsRemaining = Math.max(1, Math.round((deadlineMs - nowMs) / 60000));
          const ok = await deliverUrgentAlert(item, minsRemaining, extraKey, extra);
          if (ok) {
            fired[extraKey] = Date.now();
            await MoodleAPI.saveSiteData(activeSite, { firedReminders: fired });
            console.log(`[Background] Delivered ${extra} alert for ${item.name} (${extraKey})`);
          }
        }
      }
    }
  }

  // Always recalculate next alarm at end of alert processing cycle
  await recalculateNextAlertAlarm();
}

async function recalculateNextAlertAlarm() {
  const enabled = await areAlertsEnabled();
  if (!enabled) {
    try {
      await chrome.alarms.clear(ALERT_ALARM);
      await chrome.alarms.clear(LEGACY_ALERT_ALARM);
    } catch (_) {}
    return;
  }

  const activeSite = await MoodleAPI.getBaseUrl();
  if (!activeSite) {
    try {
      await chrome.alarms.clear(ALERT_ALARM);
    } catch (_) {}
    return;
  }
  const siteData = await MoodleAPI.getSiteData(activeSite);
  const deadlines = (siteData.moodleData && Array.isArray(siteData.moodleData.deadlines))
    ? siteData.moodleData.deadlines
    : [];
  const completedMap = (siteData.completedDeadlines && typeof siteData.completedDeadlines === "object")
    ? siteData.completedDeadlines
    : {};
  const fired = siteData.firedReminders || {};

  const nowMs = Date.now();
  const nowDate = new Date(nowMs);
  const candidates = [];

  // 1. Future 2-hour urgent reminders + exam 7-day planning + enabled
  // extras (excluding completed items):
  const extraTypes = await getEnabledExtraTypes();
  const offsets = MoodleAPI.reminderOffsetsMs();
  deadlines.forEach((item) => {
    if (!item || typeof item.timesort !== "number" || item.id === undefined || item.id === null || MoodleAPI.isCompleted(item, completedMap, activeSite)) {
      return;
    }
    const deadlineMs = item.timesort * 1000;
    const urgentMs = deadlineMs - (2 * 60 * 60 * 1000);
    const dedupeKey = MoodleAPI.getReminderKey(activeSite, item, "2h");
    const legacyKey = `deadline:${item.id}:${item.timesort}:2h`;
    if (urgentMs > nowMs && !isFired(fired, dedupeKey, legacyKey)) {
      candidates.push(urgentMs);
    }
    if (String(item.type || "").toLowerCase() === "exam") {
      const planningMs = deadlineMs - (7 * 24 * 60 * 60 * 1000);
      const planKey = MoodleAPI.getReminderKey(activeSite, item, "7d");
      if (planningMs > nowMs && !isFired(fired, planKey, null)) {
        candidates.push(planningMs);
      }
    }
    for (const extra of extraTypes) {
      if (extra === "2h" || extra === "7d" || !offsets[extra]) continue;
      const fireMs = deadlineMs - offsets[extra];
      const extraKey = MoodleAPI.getReminderKey(activeSite, item, extra);
      if (fireMs > nowMs && !isFired(fired, extraKey, null)) {
        candidates.push(fireMs);
      }
    }
  });

  // 2. Next 8:00 AM digest:
  const curY = nowDate.getFullYear();
  const curM = nowDate.getMonth();
  const curD = nowDate.getDate();
  const today8am = new Date(curY, curM, curD, 8, 0, 0, 0).getTime();

  if (nowMs < today8am) {
    candidates.push(today8am);
  } else {
    const tomorrow8am = new Date(curY, curM, curD + 1, 8, 0, 0, 0).getTime();
    candidates.push(tomorrow8am);
  }

  if (candidates.length > 0) {
    const nextTimestamp = Math.min(...candidates);
    try {
      try {
        await chrome.alarms.create(ALERT_ALARM, { when: nextTimestamp, persistAcrossSessions: true });
      } catch (_) {
        await chrome.alarms.create(ALERT_ALARM, { when: nextTimestamp });
      }
      console.log(`[Background] Next alert alarm scheduled for ${new Date(nextTimestamp).toLocaleString()} (${Math.round((nextTimestamp - nowMs) / 60000)}m)`);
    } catch (err) {
      console.warn("[Background] Failed to schedule alert alarm:", err);
    }
  } else {
    try {
      await chrome.alarms.clear(ALERT_ALARM);
    } catch (_) {}
  }
}

// Notification Click Handler: lookup cached deadline via stable per-site key
async function handleNotificationClick(notificationId) {
  try {
    if (!notificationId || typeof notificationId !== "string") return;

    const baseUrl = await MoodleAPI.getBaseUrl();
    if (!baseUrl) return;

    if (notificationId.startsWith("deadline:")) {
      const completionKey = extractDeadlineKey(notificationId);
      const siteData = await MoodleAPI.getSiteData(baseUrl);
      const deadlines = (siteData.moodleData && Array.isArray(siteData.moodleData.deadlines))
        ? siteData.moodleData.deadlines
        : [];
      let match = null;
      if (completionKey) {
        match = deadlines.find((d) => {
          if (!d) return false;
          try {
            return MoodleAPI.getCompletionKey(d, baseUrl) === completionKey;
          } catch (_) {
            return false;
          }
        });
        // Legacy fallback: old notification ids encoded raw event id.
        if (!match) {
          match = deadlines.find((d) => d && String(d.id) === String(completionKey));
        }
      }
      const targetUrl = (match && match.url) ? await sanitizeMoodleClickUrl(match.url) : `${baseUrl}/my/`;
      if (!targetUrl) return;
      await chrome.tabs.create({ url: targetUrl });
      await chrome.notifications.clear(notificationId);
    } else if (notificationId.startsWith("digest:")) {
      await chrome.tabs.create({ url: `${baseUrl}/my/` });
      await chrome.notifications.clear(notificationId);
    }
  } catch (err) {
    console.warn("[Background] Notification click handling error:", err);
  }
}

if (typeof chrome !== "undefined" && chrome.notifications && chrome.notifications.onClicked) {
  chrome.notifications.onClicked.addListener(handleNotificationClick);
}

// Retry bookkeeping for throttled signed-out verifies (see safeSync).
// Only ever scheduled from the rate-limited branch — an explicitly owed
// check — never from transient/backoff paths, so offline servers are not
// polled. Single alarm: concurrent triggers collapse into one re-verify.
async function scheduleLoggedOutRecheck(waitSec) {
  const existing = await chrome.alarms.get(RETRY_ALARM);
  if (existing) return;
  const clampedSec = Math.min(Math.max(waitSec || 30, 1), 300);
  await chrome.alarms.create(RETRY_ALARM, { when: Date.now() + clampedSec * 1000 + 2000 });
  console.log(`[Background] Scheduled signed-out re-verify in ~${clampedSec + 2}s`);
}

// Alarm assurance helper: ensures alarm exists across service worker lifecycles
async function ensureSyncAlarm() {
  try {
    const alarm = await chrome.alarms.get(ALARM_SYNC);
    if (!alarm) {
      const JITTER_MIN = 20;
      const JITTER_MAX = 60;
      const randomInitialDelay = Math.floor(JITTER_MIN + Math.random() * (JITTER_MAX - JITTER_MIN));

      await chrome.alarms.create(ALARM_SYNC, {
        delayInMinutes: randomInitialDelay,
        periodInMinutes: 180 // 3 hours
      });
      console.log(`[Background] Sync alarm ensured with ${randomInitialDelay}m initial jitter`);
    }

    // Clean up legacy alarm if present
    try {
      await chrome.alarms.clear(LEGACY_ALARM_SYNC);
      await chrome.alarms.clear(LEGACY_ALERT_ALARM);
    } catch (_) {}
  } catch (err) {
    console.warn("[Background] ensureSyncAlarm error:", err);
  }
}

/**
 * Sender authorization: only Plaksha LMS hosts (lms + legacy dle, which
 * redirects to lms) may deliver page-discovered courses.
 */
async function isAuthorizedMoodleSender(senderUrl) {
  try {
    if (!senderUrl || typeof senderUrl !== "string") return false;
    const sender = new URL(senderUrl);
    if (sender.protocol !== "https:") return false;
    const host = sender.hostname.toLowerCase();
    return host === "lms.plaksha.edu.in" || host === "dle.plaksha.edu.in";
  } catch (_) {
    return false;
  }
}

// Only the dashboard / "My courses" pages list the student's own courses.
// Other pages (catalog, search, course content) link to arbitrary courses.
function isCourseListPath(senderUrl) {
  try {
    const p = new URL(senderUrl).pathname.replace(/\/+$/, "");
    return p === "/my" || p === "/my/index.php" || p === "/my/courses.php";
  } catch (_) {
    return false;
  }
}

function namesLookSame(a, b) {
  const norm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return true;
  return x === y || x.includes(y) || y.includes(x);
}

const ACCOUNT_MISMATCH_SYNC_GAP_MS = 10 * 60 * 1000;
let lastAccountMismatchSyncAt = 0;

// Service worker startup execution
ensureSyncAlarm();
processDueAlerts();

// Seamless pickup: shortly after any Plaksha LMS page finishes loading,
// run a throttled background sync (no clicks needed once installed).
// Async + awaited: returning the promise keeps the service worker alive
// until the sync finishes, otherwise Chrome can kill it mid-fetch and the
// auto-sync silently never lands.
if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    try {
      if (!changeInfo || changeInfo.status !== "complete") return;
      const url = tab && tab.url;
      if (!url || typeof url !== "string" || !url.startsWith("https://")) return;
      let host = null;
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch (_) {
        return;
      }
      if (host !== "lms.plaksha.edu.in" && host !== "dle.plaksha.edu.in") return;
      if (url.includes("/login/")) return;
      console.log("[Background] Plaksha page loaded, running auto-sync");
      await safeSync(false, false);
    } catch (_) {}
  });
}

// Runtime startup hook (browser starts or profile loads)
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(async () => {
    try {
      await processDueAlerts();
    } catch (err) {
      console.warn("[Background] onStartup error:", err);
    }
  });
}

// Initial setup on install/update
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log("[NeverLate] Extension initialized:", details.reason);

  try {
    await ensureSyncAlarm();
    // Fixed Plaksha site: pointer + bucket always exist after getBaseUrl().
    const activeSite = await MoodleAPI.getBaseUrl();

    // Display active site's cache only (never another site's).
    if (activeSite) {
      const siteData = await MoodleAPI.getSiteData(activeSite);
      if (siteData.moodleData && Array.isArray(siteData.moodleData.deadlines)) {
        const instName = siteData.institutionName || siteData.moodleData.institutionName;
        await updateBadgeAndTooltip(siteData.moodleData.deadlines, instName, activeSite);
      } else {
        await updateBadgeAndTooltip([], null, activeSite);
      }
    } else {
      try {
        await chrome.action.setBadgeText({ text: "" });
        await chrome.action.setTitle({ title: "NeverLate: Plaksha LMS" });
      } catch (_) {}
    }
    await processDueAlerts();
    // Fresh drag while already signed in should just work: run one
    // throttled sync immediately instead of waiting for the next page load.
    // Awaited so the worker stays alive until it finishes.
    try {
      await safeSync(false, false);
    } catch (_) {}
  } catch (err) {
    console.error("[Background] onInstalled error:", err);
  }
});

// Periodic alarm handler
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === RETRY_ALARM) {
    try {
      await chrome.alarms.clear(RETRY_ALARM);
    } catch (_) {}
    console.log("[NeverLate] Retrying throttled signed-out verify");
    await safeSync(false, false);
  } else if (alarm.name === ALARM_SYNC || alarm.name === LEGACY_ALARM_SYNC) {
    console.log("[NeverLate] Scheduled jittered background sync");
    await safeSync(false, false);
  } else if (alarm.name === ALERT_ALARM || alarm.name === LEGACY_ALERT_ALARM) {
    console.log("[NeverLate] Scheduled deadline alert alarm fired");
    await processDueAlerts();
  }
});

// Hardened message dispatcher with strict per-site sender authorization
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || typeof request.action !== "string") {
    sendResponse({ success: false, error: "Invalid message" });
    return false;
  }

  const isInternalExtension = sender.id === chrome.runtime.id && (!sender.url || sender.url.startsWith("chrome-extension://"));

  // SYNC_NOW: Only authorized from internal extension contexts
  if (request.action === "SYNC_NOW") {
    if (!isInternalExtension) {
      sendResponse({ success: false, error: "Unauthorized sender for SYNC_NOW" });
      return false;
    }

    safeSync(request.isManual !== false, request.force === true)
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  // UPDATE_BADGE: Only authorized from internal extension contexts.
  // Stale-switch guard: ignore badge updates that no longer belong to the
  // active site (e.g. a sync started on Site A finishing after switching to B).
  if (request.action === "UPDATE_BADGE") {
    if (!isInternalExtension) {
      sendResponse({ success: false, error: "Unauthorized sender for UPDATE_BADGE" });
      return false;
    }

    (async () => {
      try {
        const activeSite = await MoodleAPI.getBaseUrl();
        if (request.siteKey && request.siteKey !== activeSite) {
          sendResponse({ success: false, stale: true, error: "Stale site response ignored" });
          return;
        }
        const deadlines = Array.isArray(request.deadlines) ? request.deadlines : [];
        await updateBadgeAndTooltip(deadlines, request.institutionName, activeSite);
        sendResponse({ success: true, siteKey: activeSite });
      } catch (_) {
        sendResponse({ success: false });
      }
    })();
    return true;
  }

  // REFRESH_SITE_ALERTS: recompute badge + alerts for the CURRENT site from
  // cache, with zero network traffic. Sent by the popup immediately after a
  // university switch so the new site's state applies even when no sync runs.
  if (request.action === "REFRESH_SITE_ALERTS") {
    if (!isInternalExtension) {
      sendResponse({ success: false, error: "Unauthorized sender for REFRESH_SITE_ALERTS" });
      return false;
    }

    (async () => {
      try {
        const activeSite = await MoodleAPI.getBaseUrl();
        if (!activeSite) {
          try {
            await chrome.action.setBadgeText({ text: "" });
            await chrome.action.setTitle({ title: "NeverLate: Plaksha LMS" });
          } catch (_) {}
          await recalculateNextAlertAlarm();
          sendResponse({ success: true, siteKey: null });
          return;
        }
        const siteData = await MoodleAPI.getSiteData(activeSite);
        const deadlines = (siteData.moodleData && Array.isArray(siteData.moodleData.deadlines))
          ? siteData.moodleData.deadlines
          : [];
        const instName = siteData.institutionName || (siteData.moodleData && siteData.moodleData.institutionName);
        await updateBadgeAndTooltip(deadlines, instName, activeSite);
        await processDueAlerts();
        await recalculateNextAlertAlarm();
        sendResponse({ success: true, siteKey: activeSite });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // TOGGLE_DEADLINE_DONE: Only authorized from internal extension contexts
  if (request.action === "TOGGLE_DEADLINE_DONE") {
    if (!isInternalExtension) {
      sendResponse({ success: false, error: "Unauthorized sender for TOGGLE_DEADLINE_DONE" });
      return false;
    }

    (async () => {
      try {
        const activeSite = await MoodleAPI.getBaseUrl();
        if (!activeSite) {
          sendResponse({ success: true });
          return;
        }
        const siteData = await MoodleAPI.getSiteData(activeSite);
        const deadlines = (siteData.moodleData && Array.isArray(siteData.moodleData.deadlines))
          ? siteData.moodleData.deadlines
          : [];
        const instName = siteData.institutionName || (siteData.moodleData && siteData.moodleData.institutionName);
        await updateBadgeAndTooltip(deadlines, instName, activeSite);
        await recalculateNextAlertAlarm();
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // SEND_CONFIRMATION_ALERT: Only authorized from internal extension contexts
  if (request.action === "SEND_CONFIRMATION_ALERT") {
    if (!isInternalExtension) {
      sendResponse({ success: false, error: "Unauthorized sender" });
      return false;
    }

    try {
      if (typeof chrome !== "undefined" && chrome.notifications && chrome.notifications.create) {
        chrome.notifications.create(
          "neverlate_alerts_enabled",
          {
            type: "basic",
            iconUrl: chrome.runtime.getURL("icons/icon128.png"),
            title: "Deadline Alerts Active",
            message: "NeverLate will alert you at 8:00 AM the day before and 2 hours before each deadline (7 days before exams), plus any extra reminders you switch on.",
            priority: 1
          },
          (id) => {
            sendResponse({ success: Boolean(id) });
          }
        );
      } else {
        sendResponse({ success: false, error: "Notifications API unavailable" });
      }
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
    return true;
  }

  // UPDATE_ALERT_SETTINGS: Only authorized from internal extension contexts
  if (request.action === "UPDATE_ALERT_SETTINGS") {
    if (!isInternalExtension) {
      sendResponse({ success: false, error: "Unauthorized sender for UPDATE_ALERT_SETTINGS" });
      return false;
    }

    processDueAlerts()
      .then(() => {
        sendResponse({ success: true });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  // COURSES_DISCOVERED_FROM_PAGE: Authorized ONLY from the Plaksha LMS hosts.
  // Passive page data is advisory: it can add enrolled courses seen on the
  // dashboard/course list, but never renames or replaces what sync found.
  if (request.action === "COURSES_DISCOVERED_FROM_PAGE") {
    (async () => {
      try {
        const authorized = sender.url ? await isAuthorizedMoodleSender(sender.url) : false;
        if (!authorized) {
          sendResponse({ success: false, error: "Unauthorized sender for COURSES_DISCOVERED_FROM_PAGE" });
          return;
        }

        if (!Array.isArray(request.courses)) {
          sendResponse({ success: false, error: "Invalid payload" });
          return;
        }

        const activeSite = await MoodleAPI.getBaseUrl();
        if (!activeSite) {
          sendResponse({ success: false, error: "No university configured" });
          return;
        }

        const siteData = await MoodleAPI.getSiteData(activeSite);
        const current = siteData.moodleData;
        const incomingName = typeof request.studentName === "string" ? request.studentName.substring(0, 100) : null;
        const hasPageEvidence = Boolean(incomingName) || request.courses.length > 0;

        // Extension believes the student is signed out but the page shows an
        // active session: verify authoritatively with a (throttled) sync.
        if (!current || !current.user || !current.user.isLoggedIn) {
          if (hasPageEvidence) {
            console.log("[Background] Active Moodle session observed on page while logged out. Triggering immediate auto-sync.");
            safeSync(false, false).catch(() => {});
            sendResponse({ success: true, triggeredSync: true });
            return;
          }
          sendResponse({ success: false, error: "Ignoring passive discovery without verified session" });
          return;
        }

        // A different account on the page than the cached one: refresh from the
        // server (rate-limited here and by safeSync) rather than trusting or
        // wiping the cache.
        if (incomingName && current.user.name && !namesLookSame(incomingName, current.user.name)) {
          const nowMs = Date.now();
          if (nowMs - lastAccountMismatchSyncAt > ACCOUNT_MISMATCH_SYNC_GAP_MS) {
            lastAccountMismatchSyncAt = nowMs;
            safeSync(false, true).catch(() => {});
          }
          sendResponse({ success: true, triggeredSync: true });
          return;
        }

        const acceptNewCourses = isCourseListPath(sender.url);
        const cleanInst = (typeof request.institutionName === "string")
          ? request.institutionName.trim().substring(0, 100)
          : "";

        let changed = false;
        let courseCount = 0;
        const saved = await MoodleAPI.updateSiteData(activeSite, (prev) => {
          const md = prev.moodleData;
          if (!md || !md.user || !md.user.isLoggedIn) return null;
          const next = { ...md };
          const partial = {};

          if (cleanInst && cleanInst !== md.institutionName) {
            next.institutionName = cleanInst;
            partial.institutionName = cleanInst;
            changed = true;
          }

          const mergedMap = new Map();
          (Array.isArray(md.courses) ? md.courses : []).forEach((c) => {
            if (c && c.id) mergedMap.set(String(c.id), c);
          });
          if (acceptNewCourses) {
            request.courses.slice(0, 50).forEach((c) => {
              if (!c || typeof c.id !== "number" || c.id <= 1 || typeof c.fullname !== "string") return;
              const cid = String(c.id);
              if (mergedMap.has(cid) || mergedMap.size >= 50) return;
              const cleanFull = c.fullname.substring(0, 200);
              mergedMap.set(cid, {
                id: c.id,
                fullname: cleanFull,
                shortname: (c.shortname || cleanFull).substring(0, 30),
                viewurl: `${activeSite}/course/view.php?id=${c.id}`,
                category: "Enrolled Course"
              });
              changed = true;
            });
          }
          next.courses = Array.from(mergedMap.values()).slice(0, 50);
          courseCount = next.courses.length;

          // Repair deadlines whose course link is missing using known courses.
          if (Array.isArray(md.deadlines)) {
            next.deadlines = md.deadlines.map((d) => {
              if (!d || (d.courseId && mergedMap.has(String(d.courseId)))) return d;
              for (const c of mergedMap.values()) {
                const sName = (c.shortname || "").toLowerCase();
                const fName = (c.fullname || "").toLowerCase();
                const dShort = (d.courseShortName || "").toLowerCase();
                const dFull = (d.courseName || "").toLowerCase();
                if (
                  (dShort && sName && (dShort === sName || sName.includes(dShort) || dShort.includes(sName))) ||
                  (dFull && fName && (dFull === fName || fName.includes(dFull) || dFull.includes(fName))) ||
                  (dShort && fName && fName.includes(dShort)) ||
                  (dFull && sName && sName.includes(dFull))
                ) {
                  changed = true;
                  return { ...d, courseId: c.id, courseShortName: c.shortname || c.fullname, courseName: c.fullname || c.shortname };
                }
              }
              return d;
            });
          }

          if (!changed) return null;
          partial.moodleData = next;
          return partial;
        });

        sendResponse({ success: Boolean(saved), count: courseCount, changed });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  sendResponse({ success: false, error: "Unknown action" });
  return false;
});
