/**
 * NeverLate Plaksha-Only — Academic deadline tracker for Plaksha LMS.
 * Single-site build: every operation targets https://lms.plaksha.edu.in.
 * (https://dle.plaksha.edu.in now redirects there and is canonicalized.)
 * Privacy-first: sesskey held only transiently in memory, never persisted.
 * Server protection: Exponential backoff, 429/5xx throttling, bounded arrays.
 *
 * v2.2.1 hardening:
 * - Fixed Plaksha server: moodleBaseUrl is always the Plaksha LMS root.
 * - HTTPS-only URL setup; non-Plaksha input throws.
 * - Stable per-site deadline identity (site + activity URL, event-ID fallback).
 *
 * v2.3.0:
 * - Shared UTC calendar timestamp helper (YYYYMMDDTHHMMSSZ, single hour field).
 * - Migration preserves legacy cache when moodleBaseUrl already exists.
 * - Hardened Moodle-root detection (plugin/file endpoints never treated as root).
 * - Secret query params (sesskey/token/...) stripped before any URL is stored.
 */

// Canonical Plaksha LMS root. The old dle host redirects here.
const PLAKSHA_BASE_URL = "https://lms.plaksha.edu.in";
const LEGACY_DLE_URL = "https://dle.plaksha.edu.in";
// Backwards-compat aliases for shared code paths.
const LEGACY_PLAKSHA_URL = LEGACY_DLE_URL;
const PLAKSHA_CURRENT_URL = PLAKSHA_BASE_URL;
const DEFAULT_MOODLE_URL = PLAKSHA_BASE_URL;

function __emptySiteData() {
  return {
    moodleData: null,
    completedDeadlines: {},
    firedReminders: {},
    firedDigestItems: {},
    lastServerSync: 0,
    lastServerAttempt: 0,
    backoffUntil: 0,
    failureCount: 0,
    institutionName: null
  };
}

class MoodleAPI {
  static _cachedBaseUrl = null;
  static _hasLoadedBaseUrl = false;

  /**
   * Normalize a URL for this Plaksha-only build. dle and lms Plaksha hosts
   * canonicalize to the LMS root; anything else throws (this build serves
   * Plaksha LMS only).
   */
  static normalizeBaseUrl(rawInput) {
    if (!rawInput || typeof rawInput !== "string") {
      throw new Error("This doesn't look like a valid Moodle URL. Please enter your university portal address (e.g. moodle.university.edu).");
    }
    let trimmed = rawInput.trim();
    if (!trimmed) {
      throw new Error("This doesn't look like a valid Moodle URL. Please enter your university portal address (e.g. moodle.university.edu).");
    }
    if (!/^https?:\/\//i.test(trimmed)) {
      trimmed = "https://" + trimmed;
    }
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch (_) {
      throw new Error("This doesn't look like a valid Moodle URL. Please enter your university portal address (e.g. moodle.university.edu).");
    }
    if (parsed.protocol !== "https:") {
      throw new Error("Moodle connections require HTTPS. Please use an https:// portal URL.");
    }
    const host = (parsed.hostname || "").toLowerCase();
    if (host === "dle.plaksha.edu.in" || host === "lms.plaksha.edu.in") {
      // Plaksha LMS is a root install — deep pages collapse to the LMS root.
      return PLAKSHA_BASE_URL;
    }
    throw new Error("This Plaksha-only build connects to lms.plaksha.edu.in.");
  }

  /**
   * Origin (scheme+host+port) for chrome.permissions requests.
   * Permissions are origin-scoped; installation subpath is enforced separately.
   */
  static originForPermission(normalizedUrl) {
    try {
      return new URL(normalizedUrl).origin;
    } catch (_) {
      return null;
    }
  }

  /**
   * Query params that must never be persisted (session / capability secrets).
   * Stripped from every Moodle URL before it is stored. Only params needed to
   * reopen the activity (e.g. `id`) are kept.
   */
  static _secretParamNames() {
    return ["sesskey", "token", "wstoken", "access_token", "key"];
  }

  static stripSecretParams(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return rawUrl;
    try {
      const u = new URL(rawUrl);
      let removed = false;
      for (const name of MoodleAPI._secretParamNames()) {
        // URLSearchParams is case-sensitive; Moodle uses lowercase, but be safe.
        for (const existing of Array.from(u.searchParams.keys())) {
          if (existing.toLowerCase() === name) {
            u.searchParams.delete(existing);
            removed = true;
          }
        }
      }
      void removed;
      return u.href;
    } catch (_) {
      // Relative URLs (e.g. "/course/view.php?id=2&sesskey=abc"): strip manually.
      try {
        return String(rawUrl).replace(/([?&])(sesskey|token|wstoken|access_token|key)=[^&#]*/gi, (m, sep) => (sep === "?" ? "?" : ""));
      } catch (_) {}
      return rawUrl;
    }
  }

  /**
   * Shared Google-Calendar UTC timestamp: exactly YYYYMMDDTHHMMSSZ
   * (date + single T + single HHMMSS + Z). One hour field, never duplicated.
   */
  static formatGCalDateUTC(date) {
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

  static siteKeyFor(normalizedUrl) {
    return normalizedUrl;
  }

  /**
   * Canonicalize a normalized site URL.
   * Plaksha moved from dle.plaksha.edu.in to lms.plaksha.edu.in (old host
   * now redirects). Returning lms keeps fetches same-origin so session
   * checks don't misread the redirect as an SSO logout, and keeps all
   * per-site buckets under one key.
   */
  static canonicalSiteUrl(normalizedUrl) {
    if (!normalizedUrl || typeof normalizedUrl !== "string") return normalizedUrl;
    try {
      const u = new URL(normalizedUrl);
      if (u.hostname.toLowerCase() === "dle.plaksha.edu.in") {
        u.hostname = "lms.plaksha.edu.in";
        const port = u.port ? `:${u.port}` : "";
        const path = (u.pathname && u.pathname !== "/") ? u.pathname.replace(/\/+$/, "") : "";
        return `https://${u.hostname.toLowerCase()}${port}${path}`;
      }
    } catch (_) {}
    return normalizedUrl;
  }

  /** Rewrite a stored string that may embed the old Plaksha origin. */
  static _rewritePlakshaRef(value) {
    if (typeof value !== "string") return value;
    if (!value.includes("dle.plaksha.edu.in")) return value;
    return value.split("dle.plaksha.edu.in").join("lms.plaksha.edu.in");
  }

  /** Rewrite map keys + string-array values from dle to lms (max-wins on collision). */
  static _rewritePlakshaMap(map) {
    const out = {};
    if (!map || typeof map !== "object") return out;
    for (const k of Object.keys(map)) {
      const nk = MoodleAPI._rewritePlakshaRef(k);
      const v = map[k];
      if (out[nk] === undefined) {
        out[nk] = Array.isArray(v) ? v.map((x) => MoodleAPI._rewritePlakshaRef(x)) : v;
      } else if (typeof v === "number" && typeof out[nk] === "number") {
        out[nk] = Math.max(out[nk], v);
      }
    }
    return out;
  }

  /** Rewrite a cached bucket's site-scoped keys/URLs from dle to lms. */
  static _rewritePlakshaBucket(bucket) {
    if (!bucket || typeof bucket !== "object") return bucket;
    bucket.completedDeadlines = MoodleAPI._rewritePlakshaMap(bucket.completedDeadlines);
    bucket.firedReminders = MoodleAPI._rewritePlakshaMap(bucket.firedReminders);
    const digest = {};
    const srcDigest = (bucket.firedDigestItems && typeof bucket.firedDigestItems === "object") ? bucket.firedDigestItems : {};
    for (const k of Object.keys(srcDigest)) {
      const nk = MoodleAPI._rewritePlakshaRef(k);
      const arr = Array.isArray(srcDigest[k]) ? srcDigest[k].map((x) => MoodleAPI._rewritePlakshaRef(x)) : srcDigest[k];
      if (digest[nk] === undefined) {
        digest[nk] = arr;
      } else if (Array.isArray(digest[nk]) && Array.isArray(arr)) {
        const merged = [...digest[nk]];
        for (const x of arr) if (!merged.includes(x)) merged.push(x);
        digest[nk] = merged;
      }
    }
    bucket.firedDigestItems = digest;
    const md = bucket.moodleData;
    if (md && typeof md === "object") {
      if (typeof md.moodleBaseUrl === "string") md.moodleBaseUrl = MoodleAPI._rewritePlakshaRef(md.moodleBaseUrl);
      if (Array.isArray(md.deadlines)) {
        for (const d of md.deadlines) {
          if (!d || typeof d !== "object") continue;
          if (typeof d.stableKey === "string") d.stableKey = MoodleAPI._rewritePlakshaRef(d.stableKey);
          if (typeof d.url === "string") d.url = MoodleAPI._rewritePlakshaRef(d.url);
        }
      }
      if (Array.isArray(md.courses)) {
        for (const c of md.courses) {
          if (!c || typeof c !== "object") continue;
          if (typeof c.viewurl === "string") c.viewurl = MoodleAPI._rewritePlakshaRef(c.viewurl);
        }
      }
    }
    return bucket;
  }

  /**
   * Move the old dle.plaksha bucket onto lms.plaksha, preserving Done marks,
   * fired reminders, manual deadlines, and sync timestamps. When both buckets
   * exist, union the maps and keep the fresher moodleData (manual entries
   * from both are kept). Returns the mutated sites map.
   */
  static _mergePlakshaBuckets(sites) {
    try {
      const oldKey = LEGACY_PLAKSHA_URL;
      const newKey = PLAKSHA_CURRENT_URL;
      const oldBucket = sites[oldKey];
      if (!oldBucket || typeof oldBucket !== "object") return sites;
      MoodleAPI._rewritePlakshaBucket(oldBucket);
      const cur = sites[newKey];
      if (!cur || typeof cur !== "object") {
        sites[newKey] = oldBucket;
      } else {
        MoodleAPI._rewritePlakshaBucket(cur);
        for (const mapField of ["completedDeadlines", "firedReminders"]) {
          const merged = { ...(cur[mapField] || {}) };
          const src = oldBucket[mapField] || {};
          for (const k of Object.keys(src)) {
            if (merged[k] === undefined) merged[k] = src[k];
            else if (typeof merged[k] === "number" && typeof src[k] === "number") merged[k] = Math.max(merged[k], src[k]);
          }
          cur[mapField] = merged;
        }
        const mergedDigest = { ...(cur.firedDigestItems || {}) };
        for (const k of Object.keys(oldBucket.firedDigestItems || {})) {
          if (mergedDigest[k] === undefined) mergedDigest[k] = oldBucket.firedDigestItems[k];
          else if (Array.isArray(mergedDigest[k]) && Array.isArray(oldBucket.firedDigestItems[k])) {
            const combo = [...mergedDigest[k]];
            for (const x of oldBucket.firedDigestItems[k]) if (!combo.includes(x)) combo.push(x);
            mergedDigest[k] = combo;
          }
        }
        cur.firedDigestItems = mergedDigest;
        for (const numField of ["lastServerSync", "lastServerAttempt", "backoffUntil", "failureCount"]) {
          cur[numField] = Math.max(Number(cur[numField]) || 0, Number(oldBucket[numField]) || 0);
        }
        if (!cur.institutionName && oldBucket.institutionName) cur.institutionName = oldBucket.institutionName;
        const curData = cur.moodleData;
        const oldData = oldBucket.moodleData;
        if (curData && oldData) {
          const curSync = Number(curData.lastSynced) || 0;
          const oldSync = Number(oldData.lastSynced) || 0;
          const winner = oldSync > curSync ? oldData : curData;
          const loser = oldSync > curSync ? curData : oldData;
          const seen = new Set((winner.deadlines || []).map((d) => d && d.stableKey).filter(Boolean));
          const loserManual = (loser.deadlines || []).filter((d) => {
            try { return MoodleAPI.isManualItem(d) && d.stableKey && !seen.has(d.stableKey); } catch (_) { return false; }
          });
          if (loserManual.length > 0) {
            winner.deadlines = [...(winner.deadlines || []), ...loserManual];
            try { winner.deadlines.sort((a, b) => a.timesort - b.timesort); } catch (_) {}
          }
          cur.moodleData = winner;
        } else if (!curData && oldData) {
          cur.moodleData = oldData;
        }
      }
      delete sites[oldKey];
    } catch (_) {}
    return sites;
  }

  static async ensureSiteBucket(siteKey) {
    if (!siteKey) return;
    try {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
      const stored = await chrome.storage.local.get(["sites"]);
      const sites = (stored.sites && typeof stored.sites === "object") ? stored.sites : {};
      if (!sites[siteKey]) {
        sites[siteKey] = __emptySiteData();
        await chrome.storage.local.set({ sites });
      }
    } catch (_) {}
  }

  static async migrateLegacyToSite(siteKey, preloaded) {
    try {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
      const stored = preloaded || await chrome.storage.local.get(["sites", "moodleData", "completedDeadlines", "firedReminders", "firedDigestItems", "lastServerSync", "lastServerAttempt", "backoffUntil", "failureCount", "institutionName"]);
      const sites = (stored.sites && typeof stored.sites === "object") ? { ...stored.sites } : {};
      if (sites[siteKey]) {
        // Bucket already exists; merge any leftover legacy top-level state into
        // it (v2.1 -> v2.2 upgrades that kept moodleBaseUrl) instead of dropping it.
        await MoodleAPI.mergeLegacyIntoBucket(siteKey, sites, stored);
        await chrome.storage.local.set({ sites, moodleBaseUrl: siteKey });
        return;
      }
      const bucket = __emptySiteData();
      MoodleAPI.fillBucketFromLegacy(bucket, stored);
      sites[siteKey] = bucket;
      await chrome.storage.local.set({ sites, moodleBaseUrl: siteKey });
      // Remove legacy top-level academic state so future reads are strictly per-site.
      try {
        await chrome.storage.local.remove(["moodleData", "completedDeadlines", "firedReminders", "firedDigestItems", "lastServerSync", "lastServerAttempt", "backoffUntil", "failureCount", "institutionName"]);
      } catch (_) {}
    } catch (_) {}
  }

  /** Copy legacy top-level fields into a bucket (preserves deadlines, courses,
   * completed items, fired reminders, sync timestamps, backoff state). */
  static fillBucketFromLegacy(bucket, stored) {
    if (!bucket || !stored) return;
    if (stored.moodleData) bucket.moodleData = stored.moodleData;
    if (stored.completedDeadlines && typeof stored.completedDeadlines === "object") bucket.completedDeadlines = { ...stored.completedDeadlines };
    if (stored.firedReminders && typeof stored.firedReminders === "object") bucket.firedReminders = { ...stored.firedReminders };
    if (stored.firedDigestItems && typeof stored.firedDigestItems === "object") bucket.firedDigestItems = { ...stored.firedDigestItems };
    if (typeof stored.lastServerSync === "number") bucket.lastServerSync = stored.lastServerSync;
    if (typeof stored.lastServerAttempt === "number") bucket.lastServerAttempt = stored.lastServerAttempt;
    if (typeof stored.backoffUntil === "number") bucket.backoffUntil = stored.backoffUntil;
    if (typeof stored.failureCount === "number") bucket.failureCount = stored.failureCount;
    if (typeof stored.institutionName === "string") bucket.institutionName = stored.institutionName;
    // Preserve lastSynced-style timestamps stored inside moodleData as success marker.
    if (bucket.moodleData && typeof bucket.moodleData.lastSynced === "number" && !bucket.lastServerSync) {
      bucket.lastServerSync = bucket.moodleData.lastSynced;
    }
  }

  static hasLegacyTopLevel(stored) {
    if (!stored) return false;
    return !!(stored.moodleData || stored.institutionName || stored.completedDeadlines || stored.firedReminders || stored.firedDigestItems || stored.lastServerSync || stored.lastServerAttempt || stored.backoffUntil || stored.failureCount);
  }

  /** Merge leftover legacy top-level fields into an existing bucket without
   * clobbering per-site data that is already present. Returns true if merged. */
  static async mergeLegacyIntoBucket(siteKey, sites, stored) {
    try {
      const bucket = sites[siteKey];
      if (!bucket || typeof bucket !== "object") return false;
      if (!MoodleAPI.hasLegacyTopLevel(stored)) return false;
      let merged = false;
      if (stored.moodleData && !bucket.moodleData) { bucket.moodleData = stored.moodleData; merged = true; }
      if (stored.completedDeadlines && typeof stored.completedDeadlines === "object" && (!bucket.completedDeadlines || Object.keys(bucket.completedDeadlines).length === 0)) { bucket.completedDeadlines = { ...stored.completedDeadlines }; merged = true; }
      if (stored.firedReminders && typeof stored.firedReminders === "object" && (!bucket.firedReminders || Object.keys(bucket.firedReminders).length === 0)) { bucket.firedReminders = { ...stored.firedReminders }; merged = true; }
      if (stored.firedDigestItems && typeof stored.firedDigestItems === "object" && (!bucket.firedDigestItems || Object.keys(bucket.firedDigestItems).length === 0)) { bucket.firedDigestItems = { ...stored.firedDigestItems }; merged = true; }
      if (typeof stored.lastServerSync === "number" && !bucket.lastServerSync) { bucket.lastServerSync = stored.lastServerSync; merged = true; }
      if (typeof stored.lastServerAttempt === "number" && !bucket.lastServerAttempt) { bucket.lastServerAttempt = stored.lastServerAttempt; merged = true; }
      if (typeof stored.backoffUntil === "number" && !bucket.backoffUntil) { bucket.backoffUntil = stored.backoffUntil; merged = true; }
      if (typeof stored.failureCount === "number" && !bucket.failureCount) { bucket.failureCount = stored.failureCount; merged = true; }
      if (typeof stored.institutionName === "string" && !bucket.institutionName) { bucket.institutionName = stored.institutionName; merged = true; }
      if (merged) {
        try {
          await chrome.storage.local.remove(["moodleData", "completedDeadlines", "firedReminders", "firedDigestItems", "lastServerSync", "lastServerAttempt", "backoffUntil", "failureCount", "institutionName"]);
        } catch (_) {}
      }
      return merged;
    } catch (_) {
      return false;
    }
  }

  /**
   * Get the Plaksha LMS base URL. Always returns the fixed LMS root —
   * there is no onboarding and no per-university switching in this build.
   * One-time: folds any old dle bucket / legacy top-level cache into the
   * LMS bucket so Done marks, reminders, and deadlines survive the move.
   */
  static async getBaseUrl() {
    try {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
        return this._hasLoadedBaseUrl ? this._cachedBaseUrl : PLAKSHA_BASE_URL;
      }
      const stored = await chrome.storage.local.get(["moodleBaseUrl", "sites", "moodleData", "institutionName", "completedDeadlines", "firedReminders", "firedDigestItems", "lastServerSync", "lastServerAttempt", "backoffUntil", "failureCount"]);
      const rawSites = (stored.sites && typeof stored.sites === "object") ? { ...stored.sites } : {};
      let changed = false;
      if (rawSites[LEGACY_PLAKSHA_URL]) {
        MoodleAPI._mergePlakshaBuckets(rawSites);
        changed = true;
      }
      if (MoodleAPI.hasLegacyTopLevel(stored) && !rawSites[PLAKSHA_BASE_URL]) {
        const bucket = __emptySiteData();
        MoodleAPI.fillBucketFromLegacy(bucket, stored);
        MoodleAPI._rewritePlakshaBucket(bucket);
        rawSites[PLAKSHA_BASE_URL] = bucket;
        changed = true;
        try {
          await chrome.storage.local.remove(["moodleData", "completedDeadlines", "firedReminders", "firedDigestItems", "lastServerSync", "lastServerAttempt", "backoffUntil", "failureCount"]);
        } catch (_) {}
      } else if (MoodleAPI.hasLegacyTopLevel(stored) && rawSites[PLAKSHA_BASE_URL]) {
        if (await MoodleAPI.mergeLegacyIntoBucket(PLAKSHA_BASE_URL, rawSites, stored)) changed = true;
      }
      if (!rawSites[PLAKSHA_BASE_URL]) {
        rawSites[PLAKSHA_BASE_URL] = __emptySiteData();
        changed = true;
      }
      if (stored.moodleBaseUrl !== PLAKSHA_BASE_URL) changed = true;
      if (changed) {
        try {
          await chrome.storage.local.set({ moodleBaseUrl: PLAKSHA_BASE_URL, sites: rawSites });
        } catch (_) {}
      }
      this._cachedBaseUrl = PLAKSHA_BASE_URL;
      this._hasLoadedBaseUrl = true;
      return PLAKSHA_BASE_URL;
    } catch (_) {
      return this._hasLoadedBaseUrl ? this._cachedBaseUrl : PLAKSHA_BASE_URL;
    }
  }

  /**
   * Set active base URL. Plaksha-only: dle/lms inputs canonicalize to the
   * LMS root; anything else throws. Kept so shared callers keep working.
   */
  static async setBaseUrl(rawUrl, customInstitutionName = null) {
    const normalized = this.canonicalSiteUrl(this.normalizeBaseUrl(rawUrl));
    this._cachedBaseUrl = normalized;
    this._hasLoadedBaseUrl = true;

    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      const stored = await chrome.storage.local.get(["sites"]);
      const sites = (stored.sites && typeof stored.sites === "object") ? { ...stored.sites } : {};
      MoodleAPI._mergePlakshaBuckets(sites);
      if (!sites[normalized]) {
        sites[normalized] = __emptySiteData();
      }
      sites[normalized].institutionName = "Plaksha University";
      await chrome.storage.local.set({ moodleBaseUrl: normalized, sites });
    }
    return normalized;
  }

  static async getSiteData(siteKey) {
    const empty = __emptySiteData();
    if (!siteKey) return empty;
    try {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return empty;
      const stored = await chrome.storage.local.get(["sites"]);
      const sites = (stored.sites && typeof stored.sites === "object") ? stored.sites : {};
      const bucket = sites[siteKey];
      if (!bucket || typeof bucket !== "object") return empty;
      return {
        moodleData: bucket.moodleData || null,
        completedDeadlines: (bucket.completedDeadlines && typeof bucket.completedDeadlines === "object") ? bucket.completedDeadlines : {},
        firedReminders: (bucket.firedReminders && typeof bucket.firedReminders === "object") ? bucket.firedReminders : {},
        firedDigestItems: (bucket.firedDigestItems && typeof bucket.firedDigestItems === "object") ? bucket.firedDigestItems : {},
        lastServerSync: typeof bucket.lastServerSync === "number" ? bucket.lastServerSync : 0,
        lastServerAttempt: typeof bucket.lastServerAttempt === "number" ? bucket.lastServerAttempt : 0,
        backoffUntil: typeof bucket.backoffUntil === "number" ? bucket.backoffUntil : 0,
        failureCount: typeof bucket.failureCount === "number" ? bucket.failureCount : 0,
        institutionName: typeof bucket.institutionName === "string" ? bucket.institutionName : null
      };
    } catch (_) {
      return empty;
    }
  }

  static async saveSiteData(siteKey, partial) {
    if (!siteKey || !partial || typeof partial !== "object") return;
    try {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
      const stored = await chrome.storage.local.get(["sites"]);
      const sites = (stored.sites && typeof stored.sites === "object") ? { ...stored.sites } : {};
      const prev = (sites[siteKey] && typeof sites[siteKey] === "object") ? sites[siteKey] : __emptySiteData();
      sites[siteKey] = { ...prev, ...partial };
      await chrome.storage.local.set({ sites });
    } catch (_) {}
  }

  static async getActiveSiteData() {
    const siteKey = await this.getBaseUrl();
    if (!siteKey) {
      return { siteKey: null, data: __emptySiteData() };
    }
    const data = await this.getSiteData(siteKey);
    return { siteKey, data };
  }

  /**
   * Get the institution name. Always Plaksha University in this build.
   */
  static async getInstitutionName() {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        const stored = await chrome.storage.local.get(["sites"]);
        const bucket = stored.sites && stored.sites[PLAKSHA_BASE_URL];
        if (bucket) {
          if (bucket.institutionName) return bucket.institutionName;
          if (bucket.moodleData && bucket.moodleData.institutionName) return bucket.moodleData.institutionName;
        }
      }
    } catch (_) {}
    return "Plaksha University";
  }

  static hostnameToInstitution(host) {
    if (!host) return "Plaksha University";
    if (host.includes("plaksha.edu.in")) return "Plaksha University";
    return "Plaksha University";
  }

  /**
   * Secure URL validator: HTTPS-only, exact origin + installation-subpath match.
   * Secrets (sesskey/token/...) are stripped before the URL is returned so
   * persisted links never carry session material.
   * Returns "#" when no site is configured; falls back to <base>/my/ on mismatch.
   */
  static sanitizeMoodleUrl(rawUrl, activeBaseUrl = null) {
    const baseUrl = activeBaseUrl || this._cachedBaseUrl;
    if (!baseUrl || typeof baseUrl !== "string") return "#";
    let baseParsed;
    try {
      baseParsed = new URL(baseUrl);
    } catch (_) {
      return "#";
    }
    if (baseParsed.protocol !== "https:") return "#";
    const fallback = `${baseUrl}/my/`;
    if (!rawUrl || typeof rawUrl !== "string") return fallback;

    try {
      const cleaned = this.stripSecretParams(rawUrl);
      const parsed = new URL(cleaned, baseUrl);
      if (parsed.protocol !== "https:") return fallback;
      if (parsed.origin !== baseParsed.origin) return fallback;
      const basePath = (baseParsed.pathname || "").replace(/\/+$/, "");
      if (basePath && basePath !== "" && basePath !== "/") {
        if (!(parsed.pathname === basePath || parsed.pathname.startsWith(basePath + "/"))) {
          return fallback;
        }
      }
      return this.stripSecretParams(parsed.href);
    } catch (_) {}
    return fallback;
  }

  /** True only when a URL remains on the configured Moodle origin and, for
   * subpath installs, inside that installation root. Used to distinguish a
   * real Moodle page from an external institutional SSO redirect. */
  static isWithinMoodleBase(rawUrl, activeBaseUrl) {
    if (!rawUrl || !activeBaseUrl) return false;
    try {
      const parsed = new URL(rawUrl);
      const base = new URL(activeBaseUrl);
      if (parsed.protocol !== "https:" || base.protocol !== "https:") return false;
      if (parsed.origin !== base.origin) return false;
      const basePath = (base.pathname || "").replace(/\/+$/, "");
      if (basePath && basePath !== "/") {
        return parsed.pathname === basePath || parsed.pathname.startsWith(basePath + "/");
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  // ---- Stable per-site deadline identity ----

  static normalizeActivityUrlForKey(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return null;
    try {
      const u = new URL(rawUrl);
      if (u.protocol !== "https:" && u.protocol !== "http:") return null;
      const origin = u.origin.toLowerCase();
      const path = (u.pathname || "/").replace(/\/+$/, "") || "/";
      let idParam = null;
      try {
        idParam = u.searchParams.get("id");
      } catch (_) {}
      if (idParam && /^\d+$/.test(idParam)) {
        return `${origin}${path}?id=${idParam}`;
      }
      return `${origin}${path}${u.search || ""}`;
    } catch (_) {
      return null;
    }
  }

  static getCompletionKey(item, siteKey) {
    if (!item || typeof item !== "object") return null;
    const site = siteKey || this._cachedBaseUrl || "unconfigured";
    // Prefer the stamped stable key when it belongs to this site.
    if (item.stableKey && typeof item.stableKey === "string" && item.stableKey.startsWith(`${site}|`)) {
      return item.stableKey;
    }
    return this.buildStableKey(site, item);
  }

  static getNotifyKey(item, siteKey, alertType = "2h") {
    return this.getReminderKey(siteKey, item, alertType);
  }

  static getDigestKey(siteKey, dueDateStr) {
    if (!siteKey || !dueDateStr) return null;
    return `digest:${siteKey}:${dueDateStr}`;
  }

  /**
   * Completion check with backwards-compatible legacy fallback (same site only).
   * Legacy global keys (String(id)) were migrated into the Plaksha site bucket,
   * so checking them against the per-site map preserves Done marks on upgrade
   * without ever bleeding across universities.
   */
  static isCompleted(item, completedMap, siteKey) {
    if (!item || !completedMap || typeof completedMap !== "object") return false;
    const key = this.getCompletionKey(item, siteKey);
    if (key && completedMap[key]) return true;
    // Legacy fallbacks (site-scoped by virtue of per-site map):
    try {
      if (item.id !== undefined && item.id !== null && completedMap[String(item.id)]) return true;
    } catch (_) {}
    return false;
  }

  static markCompleted(item, completedMap, siteKey) {
    const map = (completedMap && typeof completedMap === "object") ? { ...completedMap } : {};
    const key = this.getCompletionKey(item, siteKey);
    if (key) map[key] = Date.now();
    return map;
  }

  static unmarkCompleted(item, completedMap, siteKey) {
    const map = (completedMap && typeof completedMap === "object") ? { ...completedMap } : {};
    const key = this.getCompletionKey(item, siteKey);
    if (key) delete map[key];
    // Also clear legacy id-key so undo is coherent.
    try {
      if (item && item.id !== undefined && item.id !== null) delete map[String(item.id)];
    } catch (_) {}
    return map;
  }

  /**
   * Carry a Done mark from an old stable key to a new one (manual-deadline
   * edits rebuild the key when title/type change). Editing never silently
   * un-completes finished work.
   */
  static moveCompletion(completedMap, oldKey, newKey) {
    const map = (completedMap && typeof completedMap === "object") ? { ...completedMap } : {};
    if (!oldKey || !newKey || oldKey === newKey) return map;
    if (map[oldKey]) {
      map[newKey] = map[oldKey];
      delete map[oldKey];
    }
    return map;
  }

  // ---- Academic event model (assignments, quizzes, exams, personal) ----
  // Four primary types. Exam subtypes (midsem/endsem/test/viva/practical/other)
  // are presentation metadata only; logic branches on type === "exam".

  static academicTypes() {
    return ["assignment", "quiz", "exam", "personal"];
  }

  static examSubtypes() {
    return ["midsem", "endsem", "test", "viva", "practical", "other"];
  }

  static examSubtypeLabel(subtype) {
    const map = { midsem: "Mid-Sem", endsem: "End-Sem", test: "Class Test", viva: "Viva", practical: "Practical", other: "Exam" };
    return map[String(subtype || "").toLowerCase()] || "Exam";
  }

  // ---- Reminder timing policy ----
  // Core (always on when alerts are enabled): morning digest + 2h urgent
  // (+ 7d planning for exams). Optional extras the student can toggle:
  // 6h and 30m. Offsets are data so firing + alarm scheduling share them.

  static reminderOffsetsMs() {
    return {
      "30m": 30 * 60 * 1000,
      "2h": 2 * 60 * 60 * 1000,
      "6h": 6 * 60 * 60 * 1000,
      "7d": 7 * 24 * 60 * 60 * 1000
    };
  }

  static optionalExtraReminderTypes() {
    return ["6h", "30m"];
  }

  /** Which optional extras are switched on in an alertSettings object.
   * Unknown keys are ignored; missing/invalid settings mean none. */
  static enabledExtraTypes(alertSettings) {
    try {
      const extra = alertSettings && alertSettings.extra;
      if (!extra || typeof extra !== "object") return [];
      return this.optionalExtraReminderTypes().filter((t) => extra[t] === true);
    } catch (_) {
      return [];
    }
  }

  static eventTypeLabel(item) {
    if (!item) return "Assignment";
    const t = String(item.type || "assignment").toLowerCase();
    if (t === "exam") return this.examSubtypeLabel(item.subtype).toUpperCase();
    if (t === "quiz") return "QUIZ";
    if (t === "personal") return "PERSONAL";
    return "ASSIGNMENT";
  }

  /**
   * Normalize a raw Moodle module/event into one of the four academic types.
   * Uses existing metadata only (no extra server requests): modulename,
   * eventtype, URL path, then activity name.
   */
  static classifyMoodleType(hints = {}) {
    const mod = String(hints.modulename || "").toLowerCase().trim();
    const eventType = String(hints.eventtype || "").toLowerCase().trim();
    const url = String(hints.url || "").toLowerCase();
    const name = String(hints.name || "").toLowerCase();

    if (mod === "quiz" || url.includes("/mod/quiz/")) return "quiz";
    if (mod === "exam" || url.includes("/mod/exam/") || eventType.includes("exam")) return "exam";
    if (mod === "assign" || mod === "assignment" || url.includes("/mod/assign/")) return "assignment";
    if (/\bexam\b|\bmidsem\b|\bendsem\b|\bviva\b|\bpractical\b/.test(name) && (url.includes("/calendar/") || !url)) {
      // Calendar-only event explicitly named as an exam (no activity URL).
      return "exam";
    }
    if (/\bquiz\b/.test(name)) return "quiz";
    return "assignment";
  }

  /** Authoritative sanitized activity URL part used inside stable keys. */
  static normalizeActivityUrl(rawUrl) {
    return this.normalizeActivityUrlForKey(rawUrl);
  }

  /**
   * Stable per-site identity. Prefers the sanitized activity URL; falls back
   * to type+id+title so two same-course/same-time events stay distinct and
   * manual (URL-less) items are addressable.
   */
  static buildStableKey(siteKey, item) {
    const site = siteKey || this._cachedBaseUrl || "unconfigured";
    if (item && item.url) {
      const activity = this.normalizeActivityUrl(item.url);
      if (activity) return `${site}|${activity}`;
    }
    const type = (item && item.type) ? String(item.type).toLowerCase() : "assignment";
    const id = (item && item.id !== undefined && item.id !== null) ? String(item.id) : "noid";
    const title = (item && (item.title || item.name)) ? String(item.title || item.name).substring(0, 60) : "untitled";
    return `${site}|${type}:${id}:${title}`;
  }

  /**
   * Versioned reminder key. Changing the deadline timestamp generates a new
   * key, so professor-moved deadlines re-alert. The `deadline:` prefix is
   * retained for continuity with previously fired 2h keys.
   */
  static getReminderKey(siteKey, item, reminderType = "2h") {
    const site = siteKey || this._cachedBaseUrl || "unconfigured";
    // Only reuse the stamped key when it belongs to the requested site;
    // otherwise rebuild so keys stay strictly per-site.
    const stable = (item && item.stableKey && String(item.stableKey).startsWith(`${site}|`))
      ? String(item.stableKey)
      : this.buildStableKey(site, item);
    const timesort = (item && typeof item.timesort === "number") ? item.timesort : "na";
    return `deadline:${stable}:${timesort}:${reminderType}`;
  }

  /** Parse a notification id created by getReminderKey(). The stable portion
   * can contain URL colons, so matching is anchored on the numeric timestamp
   * and one of the reminder types the extension actually supports. */
  static parseReminderKey(notificationId) {
    if (!notificationId || typeof notificationId !== "string") return null;
    const match = notificationId.match(/^deadline:(.+):(\d+):(30m|2h|6h|7d)$/);
    if (!match) return null;
    return {
      completionKey: match[1],
      timesort: Number(match[2]),
      reminderType: match[3]
    };
  }

  static reminderLeadLabel(reminderType = "2h") {
    const labels = {
      "30m": "in 30 minutes",
      "2h": "in 2 hours",
      "6h": "in 6 hours",
      "7d": "in 7 days"
    };
    return labels[reminderType] || "soon";
  }

  /** Deduplicate one sync batch by stable key (same item via AJAX + fallback). */
  static dedupeDeadlines(deadlines, siteKey) {
    if (!Array.isArray(deadlines)) return [];
    const seen = new Set();
    const out = [];
    for (const d of deadlines) {
      if (!d) continue;
      const key = this.buildStableKey(siteKey, d);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!d.stableKey) d.stableKey = key;
      out.push(d);
    }
    return out;
  }

  static isManualItem(item) {
    return !!(item && item.source === "manual");
  }

  /**
   * Build a manual/personal academic deadline. Carries both the normalized
   * academic shape and legacy display fields (name/courseShortName/...) so
   * existing render, badge, alert, and export code works unchanged.
   */
  static buildManualDeadline({ siteKey, type, subtype = null, title, course = "", courseId = null, timesort, location = null }) {
    const t = this.academicTypes().includes(String(type).toLowerCase()) ? String(type).toLowerCase() : "personal";
    const cleanTitle = String(title || "Untitled").substring(0, 200).trim() || "Untitled";
    const cleanCourse = String(course || "").substring(0, 100).trim();
    const id = `manual-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
    const item = {
      id,
      stableKey: null, // stamped below
      title: cleanTitle,
      name: cleanTitle,
      activityname: cleanTitle,
      course: cleanCourse,
      courseName: cleanCourse || "Personal",
      courseShortName: cleanCourse ? cleanCourse.split(":")[0].trim().substring(0, 30) : "Personal",
      courseId: courseId,
      type: t,
      subtype: t === "exam" ? (this.examSubtypes().includes(String(subtype).toLowerCase()) ? String(subtype).toLowerCase() : "other") : null,
      timesort,
      url: null,
      location: (t === "exam" && location) ? String(location).substring(0, 100).trim() || null : (location ? String(location).substring(0, 100).trim() || null : null),
      source: "manual",
      discoveredAt: Date.now(),
      actionName: "View Details",
      isManual: true
    };
    item.stableKey = this.buildStableKey(siteKey, item);
    return item;
  }

  /**
   * Check if client is currently in an active server backoff period (per-site).
   */
  static async checkBackoff(siteKey = null) {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return false;
    try {
      const active = siteKey || await this.getBaseUrl();
      if (!active) return true; // No site configured: block network.
      const data = await this.getSiteData(active);
      if (data.backoffUntil && Date.now() < data.backoffUntil) {
        const waitMin = Math.ceil((data.backoffUntil - Date.now()) / 60000);
        console.warn(`[MoodleAPI] Server backoff active. Pausing requests for ${waitMin}m.`);
        return true;
      }
    } catch (_) {}
    return false;
  }

  /**
   * Exponential backoff handler for 429/5xx responses (per-site).
   */
  static async applyBackoff(resp, siteKey = null) {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
    try {
      const active = siteKey || await this.getBaseUrl();
      if (!active) return;
      const data = await this.getSiteData(active);
      const currentFailures = (data.failureCount || 0) + 1;

      let delaySeconds = 0;
      if (resp && resp.headers) {
        try {
          const retryAfter = resp.headers.get("Retry-After");
          if (retryAfter) {
            const parsed = parseInt(retryAfter, 10);
            if (!isNaN(parsed) && parsed > 0) delaySeconds = parsed;
          }
        } catch (_) {}
      }

      if (!delaySeconds) {
        // 30 min -> 60 min -> 120 min
        if (currentFailures === 1) delaySeconds = 30 * 60;
        else if (currentFailures === 2) delaySeconds = 60 * 60;
        else delaySeconds = 120 * 60;
      }

      const backoffUntil = Date.now() + delaySeconds * 1000;
      await this.saveSiteData(active, {
        backoffUntil: backoffUntil,
        failureCount: currentFailures
      });
      console.warn(`[MoodleAPI] Backoff applied for ${Math.round(delaySeconds / 60)} minutes.`);
    } catch (_) {}
  }

  /**
   * Clear failure counters upon verified successful network sync (per-site).
   */
  static async clearBackoff(siteKey = null) {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
    try {
      const active = siteKey || await this.getBaseUrl();
      if (!active) return;
      await this.saveSiteData(active, { backoffUntil: 0, failureCount: 0 });
    } catch (_) {}
  }

  /** True when cached data (if any) describes a signed-out session. */
  static isLoggedOutData(data) {
    return !data || !data.user || data.user.isLoggedIn !== true;
  }

  /**
   * Helper: preserve this site's cache and return transient failure status.
   * Never returns another university's cache.
   */
  static async returnCachedTransient(errorMsg, isBackoff = false, siteKey = null) {
    let cachedData = null;
    try {
      const active = siteKey || await this.getBaseUrl();
      if (active) {
        const data = await this.getSiteData(active);
        cachedData = data.moodleData || null;
      }
    } catch (_) {}

    return {
      success: false,
      transientFailure: true,
      isBackoff: isBackoff,
      error: errorMsg,
      isLoggedIn: cachedData ? (cachedData.user?.isLoggedIn ?? false) : false,
      data: cachedData
    };
  }

  /**
   * Helper: extract clean text by stripping HTML tags and entities
   */
  static cleanHtmlText(raw) {
    if (!raw || typeof raw !== "string") return "";
    return raw
      .substring(0, 300)
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&nbsp;/gi, " ")
      .replace(/&quot;/gi, '"')
      .replace(/&#039;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Robust dynamic university & institution name extractor from Moodle HTML
   */
  static extractInstitutionName(html, currentUrl) {
    if (html && typeof html === "string") {
      // 1. Check explicit Moodle site-name markup (.site-name, .sitename)
      const siteNameMatch =
        html.match(/<span[^>]*class=["'][^"']*\bsite-name\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i) ||
        html.match(/<span[^>]*class=["'][^"']*\bsitename\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i) ||
        html.match(/<div[^>]*class=["'][^"']*\bsite-name\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);

      if (siteNameMatch) {
        const clean = this.cleanHtmlText(siteNameMatch[1]);
        if (clean && clean.length > 2 && !/^(dashboard|home|moodle)$/i.test(clean)) {
          return clean;
        }
      }

    // 2. Check navbar branding link (.navbar-brand)
    const brandMatch =
      html.match(/<a[^>]*class=["'][^"']*\bnavbar-brand\b[^"']*["'][^>]*title=["']([^"']+)["']/i) ||
      html.match(/<a[^>]*class=["'][^"']*\bnavbar-brand\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);

    if (brandMatch) {
      const clean = this.cleanHtmlText(brandMatch[1]);
      if (clean && clean.length > 2 && !/^(dashboard|home|moodle)$/i.test(clean)) {
        return clean;
      }
    }

    // 3. Check OpenGraph site_name meta tag
    const metaMatch = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
    if (metaMatch) {
      const clean = this.cleanHtmlText(metaMatch[1]);
      if (clean && clean.length > 2 && !/^(dashboard|home|moodle)$/i.test(clean)) {
        return clean;
      }
    }

    // 4. Check JavaScript Moodle config (sitename: "...")
    const jsSiteMatch = html.match(/"sitename"\s*:\s*"([^"]+)"/i) || html.match(/sitename\s*=\s*["']([^"']+)["']/i);
    if (jsSiteMatch) {
      const clean = this.cleanHtmlText(jsSiteMatch[1]);
      if (clean && clean.length > 2 && !/^(dashboard|home|moodle)$/i.test(clean)) {
        return clean;
      }
    }

    // 5. Parse <title> tag (e.g. "Dashboard | IIT Bombay" or "My courses - Plaksha University DLE")
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) {
      const fullTitle = this.cleanHtmlText(titleMatch[1]);
      const delimiters = ["|", " - ", ":", " — "];
      for (const delim of delimiters) {
        if (fullTitle.includes(delim)) {
          const parts = fullTitle.split(delim).map(p => p.trim()).filter(Boolean);
          const genericPages = /^(dashboard|my courses|courses|home|site home|log in|login|calendar|upcoming events|profile|preferences|moodle)$/i;
          const candidate = parts.find(p => !genericPages.test(p) && p.length > 2);
          if (candidate) {
            return candidate;
          }
        }
      }
    }
  }

  // 6. Hostname heuristic fallback
  if (currentUrl) {
      try {
        const parsed = new URL(currentUrl);
        const host = parsed.hostname.toLowerCase();
        const mapped = MoodleAPI.hostnameToInstitution(host);
        if (mapped) return mapped;

        // Clean domain fallback: e.g. moodle.stanford.edu -> Stanford
        const domainParts = host.split(".");
        if (domainParts.length >= 2) {
          const mainPart = domainParts.find(p => p !== "moodle" && p !== "lms" && p !== "dle" && p !== "ac" && p !== "edu" && p !== "org" && p !== "com");
          if (mainPart && mainPart.length >= 3) {
            return mainPart.charAt(0).toUpperCase() + mainPart.slice(1) + " Moodle";
          }
        }
      } catch (_) {}
    }

    return "Plaksha University";
  }

  /**
   * Parse courses from dashboard HTML
   */
  static parseCoursesFromHtml(html, baseUrl) {
    if (!html || typeof html !== "string") return [];
    if (!baseUrl || typeof baseUrl !== "string") return [];

    const coursesMap = new Map();
    // Universal regex matching relative or absolute Moodle course links
    const courseLinkRegex = /<a[^>]+href=["'](?:https?:\/\/[^"']*)?\/course\/view\.php\?id=(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = courseLinkRegex.exec(html)) !== null) {
      const cid = match[1];
      if (cid === "1") continue;

      let rawContent = match[2];
      let cleanName = this.cleanHtmlText(rawContent);

      cleanName = cleanName
        .replace(/^(Course image|Course summary)\s*/i, "")
        .replace(/\s*Select to compare\s*$/i, "")
        .trim();

      if (cleanName.length > 2 && !coursesMap.has(cid)) {
        coursesMap.set(cid, {
          id: parseInt(cid, 10),
          fullname: cleanName,
          shortname: cleanName.split(":")[0].trim().substring(0, 30),
          viewurl: `${baseUrl}/course/view.php?id=${cid}`,
          category: "Enrolled Course"
        });

        if (coursesMap.size >= 50) break;
      }
    }

    return Array.from(coursesMap.values());
  }

  /**
   * Check login state and extract transient session details
   * Differentiates verified logout from transient network/server failures.
   * Returns notConfigured when no university is connected (no network).
   */
  static async checkSession(baseUrlHint = null) {
    let baseUrl = null;
    if (baseUrlHint) {
      try {
        baseUrl = this.normalizeBaseUrl(baseUrlHint);
      } catch (_) {
        baseUrl = null;
      }
    } else {
      baseUrl = await this.getBaseUrl();
    }
    if (!baseUrl) {
      return { isLoggedIn: false, notConfigured: true, error: "Connect your Moodle to get started", baseUrl: null };
    }

    if (await this.checkBackoff(baseUrl)) {
      return { isLoggedIn: false, transientFailure: true, error: "Server busy. Using offline cache.", isBackoff: true, baseUrl };
    }

    try {
      const resp = await fetch(`${baseUrl}/my/`, {
        credentials: "include",
        cache: "no-cache"
      });

      if (resp.status === 429 || resp.status >= 500) {
        await this.applyBackoff(resp, baseUrl);
        return { isLoggedIn: false, transientFailure: true, error: `Server response ${resp.status}`, isBackoff: true, baseUrl };
      }

      if (!resp.ok) {
        return { isLoggedIn: false, transientFailure: true, error: `HTTP ${resp.status}`, baseUrl };
      }

      // fetch() follows redirects. A successful response from an institution's
      // identity provider is not a successful Moodle session; without this
      // guard an SSO login page can be mistaken for an empty logged-in account.
      if (!this.isWithinMoodleBase(resp.url, baseUrl)) {
        return {
          isLoggedIn: false,
          verifiedLoggedOut: true,
          ssoRedirect: true,
          error: "Sign in through your university portal",
          baseUrl
        };
      }

      const html = await resp.text();

      // Explicit detection of actual Moodle login page (verified logout)
      if (
        resp.url.includes("/login/index.php") ||
        resp.url.includes("/login/") ||
        html.includes('id="login"') ||
        html.includes('name="logintoken"') ||
        html.includes('id="loginform"')
      ) {
        return { isLoggedIn: false, verifiedLoggedOut: true, error: "Not logged in", baseUrl };
      }

      let sesskey = null;
      const sesskeyMatch =
        html.match(/"sesskey":"([a-zA-Z0-9]+)"/) ||
        html.match(/[?"']sesskey["']?\s*[:=]\s*["']?([a-zA-Z0-9]+)/i) ||
        html.match(/name=["']sesskey["']\s+value=["']([a-zA-Z0-9]+)["']/i) ||
        html.match(/logout\.php\?sesskey=([a-zA-Z0-9]+)/i);

      if (sesskeyMatch) {
        sesskey = sesskeyMatch[1];
      }

      let userName = "Student";
      const userMatch =
        html.match(/class=["'][^"']*usertext[^"']*["'][^>]*>([^<]+)<\/span>/i) ||
        html.match(/class=["'][^"']*logininfo[^"']*["'][^>]*>Logged in as\s+<a[^>]*>([^<]+)<\/a>/i) ||
        html.match(/"fullname":"([^"]+)"/);

      if (userMatch) {
        userName = this.cleanHtmlText(userMatch[1]).substring(0, 100);
      }

      // Require positive Moodle session evidence. Custom SSO gateway pages can
      // live on the same origin and return HTTP 200 without being Moodle.
      if (!sesskey && !userMatch) {
        return {
          isLoggedIn: false,
          verifiedLoggedOut: true,
          ssoRedirect: true,
          error: "Sign in through your university portal",
          baseUrl
        };
      }

      const detectedInstitution = this.extractInstitutionName(html, baseUrl);

      if (detectedInstitution) {
        await this.saveSiteData(baseUrl, { institutionName: detectedInstitution });
      }

      return {
        isLoggedIn: true,
        sesskey: sesskey,
        userName: userName,
        institutionName: detectedInstitution,
        baseUrl: baseUrl,
        html: html
      };
    } catch (err) {
      console.error("[MoodleAPI] checkSession error:", err);
      return { isLoggedIn: false, transientFailure: true, error: err.message || "Network error", baseUrl };
    }
  }

  /**
   * Fetch courses by reading /my/courses.php
   */
  static async fetchCoursesFromPage(baseUrl) {
    if (!baseUrl) {
      return { transientFailure: true, error: "No university configured", courses: [] };
    }
    try {
      const resp = await fetch(`${baseUrl}/my/courses.php`, {
        credentials: "include",
        cache: "no-cache"
      });

      if (resp.status === 429 || resp.status >= 500) {
        await this.applyBackoff(resp, baseUrl);
        return { isBackoff: true, error: `HTTP ${resp.status}`, courses: [] };
      }

      if (!resp.ok) return { transientFailure: true, error: `HTTP ${resp.status}`, courses: [] };
      const html = await resp.text();
      return { isBackoff: false, courses: this.parseCoursesFromHtml(html, baseUrl) };
    } catch (err) {
      console.warn("[MoodleAPI] fetchCoursesFromPage failed:", err);
      return { transientFailure: true, error: err.message, courses: [] };
    }
  }

  /**
   * Fetch upcoming deadlines from Moodle's calendar upcoming page
   */
  static async fetchUpcomingFromCalendar(baseUrl) {
    if (!baseUrl) {
      return { transientFailure: true, error: "No university configured", deadlines: [] };
    }
    try {
      const resp = await fetch(`${baseUrl}/calendar/view.php?view=upcoming`, {
        credentials: "include",
        cache: "no-cache"
      });

      if (resp.status === 429 || resp.status >= 500) {
        await this.applyBackoff(resp, baseUrl);
        return { isBackoff: true, error: `HTTP ${resp.status}`, deadlines: [] };
      }

      if (!resp.ok) return { transientFailure: true, error: `HTTP ${resp.status}`, deadlines: [] };
      const html = await resp.text();
      const deadlines = [];

      // Match each event container in Moodle's upcoming calendar view
      const eventBlockRegex = /<div[^>]+class=["'][^"']*\bevent\b[^"']*["'][^>]*>([\s\S]*?)(?=<div[^>]+class=["'][^"']*\bevent\b[^"']*["']|$)/gi;
      let blockMatch;

      while ((blockMatch = eventBlockRegex.exec(html)) !== null) {
        const fullBlock = blockMatch[0]; // Full block including opening <div ...> tag with data-* attributes

        // 1. Extract Activity URL
        const urlMatch =
          fullBlock.match(/<a[^>]+href=["'](https?:\/\/[^"']*(?:mod\/(?:assign|quiz|workshop|choice|feedback|forum|turnitintooltwo)|(?:assign|quiz|workshop|choice))\/view\.php\?id=\d+[^"']*)["']/i) ||
          fullBlock.match(/<a[^>]+href=["']([^"']*(?:mod\/(?:assign|quiz|workshop|choice|feedback|forum|turnitintooltwo)|(?:assign|quiz|workshop|choice))\/view\.php\?id=\d+[^"']*)["']/i) ||
          fullBlock.match(/<a[^>]+class=["'][^"']*card-link[^"']*["'][^>]+href=["']([^"']+)["']/i);

        let rawUrl = urlMatch ? urlMatch[1].replace(/&amp;/gi, "&") : null;
        if (!rawUrl) {
          const anyModMatch = fullBlock.match(/<a[^>]+href=["']([^"']*(?:\/mod\/[a-z0-9_]+)\/view\.php\?id=\d+[^"']*)["']/i);
          if (anyModMatch) rawUrl = anyModMatch[1].replace(/&amp;/gi, "&");
        }
        if (!rawUrl) continue;
        const fullUrl = this.sanitizeMoodleUrl(rawUrl, baseUrl);
        if (!fullUrl || fullUrl === "#") continue;

        // 2. Extract Event / Assignment Title (NEVER "Go to activity"!)
        let title = "";

        // Check Moodle event name heading: <h3 class="name d-inline-block">Assignment 1 is due</h3>
        const nameHeaderMatch =
          fullBlock.match(/<h[2-5][^>]*class=["'][^"']*\bname\b[^"']*["'][^>]*>([\s\S]*?)<\/h[2-5]>/i) ||
          fullBlock.match(/<div[^>]*class=["'][^"']*\bname\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) ||
          fullBlock.match(/<span[^>]*class=["'][^"']*\bname\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);

        if (nameHeaderMatch) {
          title = this.cleanHtmlText(nameHeaderMatch[1]);
        }

        if (!title) {
          const dataTitleMatch = fullBlock.match(/data-event-title=["']([^"']+)["']/i) || fullBlock.match(/data-event-name=["']([^"']+)["']/i);
          if (dataTitleMatch) title = this.cleanHtmlText(dataTitleMatch[1]);
        }

        if (!title) {
          const anyHeading = fullBlock.match(/<h[2-5][^>]*>([\s\S]*?)<\/h[2-5]>/i);
          if (anyHeading) title = this.cleanHtmlText(anyHeading[1]);
        }

        // Clean common Moodle phrases: "Assignment 1 is due" -> "Assignment 1"
        if (title) {
          title = title
            .replace(/\s+(?:is due|due|closes|will close|is closing|opens)\s*$/i, "")
            .replace(/^Activity\s*:\s*/i, "")
            .trim();
        }

        // Strict rejection: NEVER use "Go to activity" as assignment title
        if (!title || /^go to activity$/i.test(title) || /^view activity$/i.test(title)) {
          const titleAttrMatch = fullBlock.match(/<a[^>]+title=["']([^"']+)["'][^>]*>(?:[\s\S]*?)<\/a>/i);
          if (titleAttrMatch && !/^go to activity$/i.test(titleAttrMatch[1]) && !/^view activity$/i.test(titleAttrMatch[1])) {
            title = this.cleanHtmlText(titleAttrMatch[1]);
          } else {
            title = fullUrl.includes("quiz") ? "Quiz" : "Assignment";
          }
        }

        // 3. Extract Course ID & Course Name
        let courseId = null;
        let courseName = "";
        let courseShortName = "";

        const courseIdAttrMatch = fullBlock.match(/data-course-id=["'](\d+)["']/i);
        if (courseIdAttrMatch && courseIdAttrMatch[1] !== "1") {
          courseId = parseInt(courseIdAttrMatch[1], 10);
        }

        const courseLinkMatch = fullBlock.match(/<a[^>]+href=["'][^"']*\/course\/view\.php\?id=(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
        if (courseLinkMatch) {
          if (!courseId && courseLinkMatch[1] !== "1") {
            courseId = parseInt(courseLinkMatch[1], 10);
          }
          const rawCName = this.cleanHtmlText(courseLinkMatch[2]);
          if (rawCName && rawCName.length > 1) {
            courseName = rawCName;
          }
        }

        if (!courseName) {
          const courseDivMatch = fullBlock.match(/<div[^>]+class=["'][^"']*\bcourse\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
          if (courseDivMatch) {
            const rawCName = this.cleanHtmlText(courseDivMatch[1]);
            if (rawCName && rawCName.length > 1) {
              courseName = rawCName;
            }
          }
        }

        if (courseName) {
          courseShortName = courseName.split(":")[0].trim();
        }

        // 4. Extract Timesort
        let timesort = Math.floor(Date.now() / 1000) + 86400;
        const timeParamMatch = fullBlock.match(/time=([0-9]{9,11})/i) || fullBlock.match(/data-timestamp=["']([0-9]{9,11})["']/i);
        if (timeParamMatch) {
          timesort = parseInt(timeParamMatch[1], 10);
        } else {
          const dateMatch = fullBlock.match(/<div[^>]+class=["'][^"']*date[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
          if (dateMatch) {
            const dateStr = this.cleanHtmlText(dateMatch[1]);
            const parsed = Date.parse(dateStr);
            if (!isNaN(parsed)) {
              timesort = Math.floor(parsed / 1000);
            }
          }
        }

        const eventIdMatch = fullBlock.match(/data-event-id=["'](\d+)["']/i);
        const stableId = eventIdMatch
          ? `cal-${eventIdMatch[1]}`
          : `cal-${timesort}-${title.substring(0, 15).replace(/\s+/g, "_")}`;

        const type = this.classifyMoodleType({ url: fullUrl, name: title });

        deadlines.push({
          id: stableId,
          name: title,
          activityname: title,
          title: title,
          courseName: courseName || "Course Event",
          courseShortName: courseShortName || "",
          course: courseShortName || courseName || "",
          courseId: courseId,
          timesort: timesort,
          url: fullUrl,
          location: null,
          actionName: type === "quiz" ? "View Quiz" : "View Assignment",
          type: type,
          subtype: null,
          source: "moodle",
          discoveredAt: Date.now()
        });

        if (deadlines.length >= 100) break;
      }

      return { isBackoff: false, deadlines };
    } catch (err) {
      console.warn("[MoodleAPI] fetchUpcomingFromCalendar error:", err);
      return { transientFailure: true, error: err.message, deadlines: [] };
    }
  }

  /**
   * Query Moodle 4.x/3.x internal AJAX endpoint using transient sesskey
   */
  static async fetchFromAjax(sesskey, baseUrl) {
    if (!baseUrl) {
      return { deadlines: [], courses: [], transientFailure: true, error: "No university configured" };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const serviceUrl = `${baseUrl}/lib/ajax/service.php?sesskey=${encodeURIComponent(sesskey)}&info=core_calendar_get_action_events_by_timesort,core_course_get_enrolled_courses_by_timeline_classification`;

    const payload = [
      {
        index: 0,
        methodname: "core_calendar_get_action_events_by_timesort",
        args: {
          timesortfrom: nowSec - 86400 * 2,
          limitnum: 50
        }
      },
      {
        index: 1,
        methodname: "core_course_get_enrolled_courses_by_timeline_classification",
        args: {
          offset: 0,
          limit: 0,
          classification: "inprogress",
          sort: "fullname"
        }
      }
    ];

    try {
      const resp = await fetch(serviceUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload)
      });

      if (resp.status === 429 || resp.status >= 500) {
        await this.applyBackoff(resp, baseUrl);
        return { deadlines: [], courses: [], isBackoff: true, error: `HTTP ${resp.status}` };
      }

      if (!resp.ok) return { deadlines: [], courses: [], transientFailure: true, error: `HTTP ${resp.status}` };

      const data = await resp.json();
      if (!Array.isArray(data)) return { deadlines: [], courses: [], transientFailure: true, error: "Invalid AJAX payload" };

      let deadlines = [];
      if (data[0] && !data[0].error && data[0].data && Array.isArray(data[0].data.events)) {
        deadlines = data[0].data.events.slice(0, 100).map(ev => {
          const rawUrl = ev.action ? ev.action.url : (ev.url || `${baseUrl}/calendar/view.php`);
          const cleanName = this.cleanHtmlText(ev.name || ev.activityname);
          const type = this.classifyMoodleType({
            modulename: ev.modulename,
            eventtype: ev.eventtype,
            url: rawUrl,
            name: cleanName || ev.activityname
          });

          return {
            id: ev.id,
            name: cleanName,
            activityname: this.cleanHtmlText(ev.activityname || ev.name),
            title: cleanName,
            courseName: ev.course ? this.cleanHtmlText(ev.course.fullname || ev.course.shortname) : "Course",
            courseShortName: ev.course ? this.cleanHtmlText(ev.course.shortname) : "",
            courseId: ev.course ? ev.course.id : null,
            course: ev.course ? this.cleanHtmlText(ev.course.shortname || ev.course.fullname) : "",
            timesort: ev.timesort,
            url: this.sanitizeMoodleUrl(rawUrl, baseUrl),
            location: null,
            actionName: ev.action ? this.cleanHtmlText(ev.action.name) : "View Activity",
            type: type,
            subtype: null,
            source: "moodle",
            discoveredAt: Date.now()
          };
        });
      }

      let courses = [];
      if (data[1] && !data[1].error && data[1].data && Array.isArray(data[1].data.courses)) {
        courses = data[1].data.courses
          .filter(c => String(c.id) !== "1")
          .slice(0, 50)
          .map(c => ({
            id: c.id,
            fullname: this.cleanHtmlText(c.fullname),
            shortname: this.cleanHtmlText(c.shortname || c.fullname),
            viewurl: this.sanitizeMoodleUrl(c.viewurl || `${baseUrl}/course/view.php?id=${c.id}`, baseUrl),
            category: this.cleanHtmlText(c.coursecategory || "Enrolled Course")
          }));
      }

      return { deadlines, courses, isBackoff: false };
    } catch (err) {
      console.warn("[MoodleAPI] AJAX request error:", err);
      return { deadlines: [], courses: [], transientFailure: true, error: err.message };
    }
  }

  /**
   * Main Sync Function (per-site isolated).
   */
  static async syncAll(baseUrlHint = null) {
    console.log("[MoodleAPI] Executing session check...");

    let requestedBaseUrl = null;
    if (baseUrlHint) {
      try {
        requestedBaseUrl = this.normalizeBaseUrl(baseUrlHint);
      } catch (_) {}
    }
    if (!requestedBaseUrl) requestedBaseUrl = await this.getBaseUrl();

    const session = await this.checkSession(requestedBaseUrl);
    const baseUrl = session.baseUrl || requestedBaseUrl;

    if (!baseUrl) {
      return {
        success: false,
        notConfigured: true,
        error: "Connect your Moodle to get started",
        isLoggedIn: false,
        data: null
      };
    }

    const siteData = await this.getSiteData(baseUrl);
    let hostnameInstitution = null;
    try {
      hostnameInstitution = this.hostnameToInstitution(new URL(baseUrl).hostname.toLowerCase());
    } catch (_) {}
    const storedInstitution = siteData.institutionName || (siteData.moodleData && siteData.moodleData.institutionName) || hostnameInstitution;
    const institutionName = session.institutionName || storedInstitution || "University Moodle";

    if (!session.isLoggedIn) {
      if (session.verifiedLoggedOut) {
        // Explicitly verified logout — purge THIS SITE's Moodle academic data
        // only. Student-created manual deadlines are local records, not
        // server state, so they survive logout.
        const prevDeadlines = (siteData.moodleData && Array.isArray(siteData.moodleData.deadlines))
          ? siteData.moodleData.deadlines.filter((d) => d && this.isManualItem(d))
          : [];
        const loggedOutData = {
          user: { isLoggedIn: false, name: null },
          institutionName: institutionName,
          moodleBaseUrl: baseUrl,
          courses: [],
          deadlines: prevDeadlines,
          lastSynced: Date.now()
        };

        await this.saveSiteData(baseUrl, { moodleData: loggedOutData });

        return {
          success: false,
          verifiedLoggedOut: true,
          error: `Not signed in to ${institutionName}`,
          isLoggedIn: false,
          data: loggedOutData
        };
      } else {
        // Transient network failure or server backoff — preserve THIS SITE's cache!
        return await this.returnCachedTransient(
          session.error || "Network error. Using offline cache.",
          session.isBackoff || false,
          baseUrl
        );
      }
    }

    const coursesMap = new Map();
    let deadlines = [];

    // 1. Parse courses from /my/ page
    if (session.html) {
      const dashboardCourses = this.parseCoursesFromHtml(session.html, baseUrl);
      dashboardCourses.forEach(c => coursesMap.set(String(c.id), c));
    }

    // 2. Fetch courses from dedicated /my/courses.php
    const pageCoursesRes = await this.fetchCoursesFromPage(baseUrl);
    if (pageCoursesRes.isBackoff) {
      return await this.returnCachedTransient("Moodle is temporarily busy. Using cached data.", true, baseUrl);
    }
    if (pageCoursesRes.transientFailure) {
      return await this.returnCachedTransient("Network error reading course list. Using cached data.", false, baseUrl);
    }
    if (Array.isArray(pageCoursesRes.courses)) {
      pageCoursesRes.courses.forEach(c => coursesMap.set(String(c.id), c));
    }

    // 3. Query Moodle AJAX API using transient sesskey
    if (session.sesskey) {
      const ajaxResult = await this.fetchFromAjax(session.sesskey, baseUrl);
      if (ajaxResult.isBackoff) {
        return await this.returnCachedTransient("Moodle is temporarily busy. Using cached data.", true, baseUrl);
      }
      if (ajaxResult.transientFailure) {
        return await this.returnCachedTransient("Network error reading deadlines. Using cached data.", false, baseUrl);
      }
      if (Array.isArray(ajaxResult.courses)) {
        ajaxResult.courses.forEach(c => coursesMap.set(String(c.id), c));
      }
      deadlines = ajaxResult.deadlines || [];
    }

    // 4. Scrape upcoming calendar events if needed
    if (deadlines.length === 0) {
      const calRes = await this.fetchUpcomingFromCalendar(baseUrl);
      if (calRes.isBackoff) {
        return await this.returnCachedTransient("Moodle is temporarily busy. Using cached data.", true, baseUrl);
      }
      if (calRes.transientFailure) {
        return await this.returnCachedTransient("Network error reading calendar. Using cached data.", false, baseUrl);
      }
      deadlines = calRes.deadlines || [];
    }

    // 5. Cross-reference & enrich all deadlines with enrolled courses
    for (const d of deadlines) {
      if (!d) continue;

      // Ensure assignment title is never generic button text
      if (!d.name || /^go to activity$/i.test(d.name) || /^view activity$/i.test(d.name)) {
        if (d.activityname && !/^go to activity$/i.test(d.activityname) && !/^view activity$/i.test(d.activityname)) {
          d.name = d.activityname;
        } else {
          d.name = d.type === "quiz" ? "Quiz" : "Assignment";
        }
      }
      d.name = d.name.replace(/\s+(?:is due|due|closes|will close|is closing|opens)\s*$/i, "").trim();

      // Correlate with coursesMap
      let matchedCourse = null;
      if (d.courseId && coursesMap.has(String(d.courseId))) {
        matchedCourse = coursesMap.get(String(d.courseId));
      } else {
        // Search by shortname, fullname, or substring match against enrolled courses
        for (const [cid, c] of coursesMap.entries()) {
          const sName = (c.shortname || "").toLowerCase();
          const fName = (c.fullname || "").toLowerCase();
          const dShort = (d.courseShortName || "").toLowerCase();
          const dFull = (d.courseName || "").toLowerCase();
          const dText = `${d.name || ""} ${d.activityname || ""} ${dShort} ${dFull} ${d.url || ""}`.toLowerCase();

          if (
            (dShort && sName && (dShort === sName || sName.includes(dShort) || dShort.includes(sName))) ||
            (dFull && fName && (dFull === fName || fName.includes(dFull) || dFull.includes(fName))) ||
            (dShort && fName && fName.includes(dShort)) ||
            (dFull && sName && sName.includes(dFull))
          ) {
            matchedCourse = c;
            break;
          }

          // Course code matching (e.g. "AI3022" or "3022" or "CS2102")
          const codeMatch = sName.match(/([a-z]{2,5})\s*[-_]?\s*(\d{3,5})/i);
          if (codeMatch) {
            const prefix = codeMatch[1].toLowerCase();
            const num = codeMatch[2];
            if (dText.includes(prefix + num) || dText.includes(num)) {
              matchedCourse = c;
              break;
            }
          }
        }
      }

      // If user is enrolled in only 1 course and assignment course is unknown, associate it
      if (!matchedCourse && coursesMap.size === 1) {
        matchedCourse = Array.from(coursesMap.values())[0];
      }

      if (matchedCourse) {
        d.courseId = matchedCourse.id;
        d.courseShortName = matchedCourse.shortname || matchedCourse.fullname;
        d.courseName = matchedCourse.fullname || matchedCourse.shortname;
      } else {
        if (!d.courseShortName || d.courseShortName === "Course Event" || d.courseShortName === "—" || d.courseShortName === "Course") {
          d.courseShortName = (d.courseName && d.courseName !== "Course Event" && d.courseName !== "—" && d.courseName !== "Course")
            ? d.courseName.split(":")[0].trim()
            : "General";
        }
        if (!d.courseName || d.courseName === "Course Event" || d.courseName === "—") {
          d.courseName = d.courseShortName;
        }
      }
    }

    // Clear failure counter ONLY if entire synchronization succeeded completely without any errors
    await this.clearBackoff(baseUrl);

    // Stamp normalized academic identity, then dedupe (same item may arrive
    // via AJAX + calendar fallback + page discovery).
    for (const d of deadlines) {
      if (!d) continue;
      if (!d.source) d.source = "moodle";
      if (!d.discoveredAt) d.discoveredAt = Date.now();
      if (!d.title) d.title = d.name;
      if (!d.stableKey) d.stableKey = this.buildStableKey(baseUrl, d);
    }
    deadlines = this.dedupeDeadlines(deadlines, baseUrl);

    // Preserve student-created manual deadlines across Moodle syncs.
    const prevDeadlines = (siteData.moodleData && Array.isArray(siteData.moodleData.deadlines))
      ? siteData.moodleData.deadlines
      : [];
    const manualKept = prevDeadlines.filter((d) => d && this.isManualItem(d));
    const haveKeys = new Set(deadlines.map((d) => d && d.stableKey).filter(Boolean));
    for (const m of manualKept) {
      if (!m.stableKey) m.stableKey = this.buildStableKey(baseUrl, m);
      if (!haveKeys.has(m.stableKey)) {
        deadlines.push(m);
        haveKeys.add(m.stableKey);
      }
    }

    deadlines.sort((a, b) => a.timesort - b.timesort);
    const finalCourses = Array.from(coursesMap.values()).slice(0, 50);

    const resultData = {
      user: {
        isLoggedIn: true,
        name: session.userName
      },
      institutionName: institutionName,
      moodleBaseUrl: baseUrl,
      lastSynced: Date.now(),
      courses: finalCourses,
      deadlines: deadlines.slice(0, 100)
    };

    await this.saveSiteData(baseUrl, {
      moodleData: resultData,
      institutionName: institutionName
    });

    return {
      success: true,
      data: resultData
    };
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { MoodleAPI, DEFAULT_MOODLE_URL, LEGACY_PLAKSHA_URL, PLAKSHA_CURRENT_URL, PLAKSHA_BASE_URL, LEGACY_DLE_URL };
}
