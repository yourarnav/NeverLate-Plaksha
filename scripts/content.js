/**
 * NeverLate Plaksha-Only — Content Script for Plaksha LMS Pages
 * Statically registered via manifest for lms + dle Plaksha hosts.
 * Detects institution name, student identity, and active course
 * enrollments from the page DOM.
 * Zero direct storage access: communicates strictly via background worker messages.
 */

(function () {
  if (window.location.pathname.includes("/login/")) return;

  function cleanText(raw) {
    if (!raw || typeof raw !== "string") return "";
    return raw
      .substring(0, 300)
      .replace(/\s+/g, " ")
      .trim();
  }

  function extractInstitutionName() {
    // 1. Site name badge
    const siteEl = document.querySelector(".site-name, .sitename");
    if (siteEl) {
      const txt = cleanText(siteEl.innerText || siteEl.textContent);
      if (txt && txt.length > 2 && !/^(dashboard|home|moodle)$/i.test(txt)) {
        return txt;
      }
    }

    // 2. Brand element
    const brandEl = document.querySelector(".navbar-brand");
    if (brandEl) {
      const titleAttr = brandEl.getAttribute("title");
      if (titleAttr && titleAttr.length > 2) {
        return cleanText(titleAttr);
      }
      const txt = cleanText(brandEl.innerText || brandEl.textContent);
      if (txt && txt.length > 2 && !/^(dashboard|home|moodle)$/i.test(txt)) {
        return txt;
      }
    }

    // Page titles vary per page (assignments, forums...), so they are not a
    // reliable institution name; fall back to the fixed site name.
    return "Plaksha University";
  }

  // Only the dashboard / "My courses" pages list the student's own courses.
  // Every other page links to arbitrary courses (catalog, search, content).
  function isCourseListPage() {
    const p = window.location.pathname.replace(/\/+$/, "");
    return p === "/my" || p === "/my/index.php" || p === "/my/courses.php";
  }

  function extractCoursesFromPage() {
    if (!isCourseListPage()) return [];
    const courseLinks = document.querySelectorAll('a[href*="/course/view.php?id="]');
    const coursesMap = new Map();

    for (const link of courseLinks) {
      if (coursesMap.size >= 50) break;
      let parsed;
      try {
        parsed = new URL(link.href);
      } catch (_) {
        continue;
      }
      if (parsed.origin !== window.location.origin || parsed.pathname !== "/course/view.php") continue;
      const cid = parsed.searchParams.get("id");
      if (!cid || !/^[0-9]{1,10}$/.test(cid) || cid === "1") continue; // skip Site Home

      let name = link.innerText || link.textContent || "";
      name = name
        .replace(/^(Course name|Course image|Star for|Star this course|Starred)\s*/i, "")
        .replace(/\s*(Course name|Course image|Star for|Star this course|Starred)$/i, "")
        .substring(0, 200)
        .trim();

      if (name.length > 2 && !coursesMap.has(cid)) {
        let shortname = name;
        if (name.includes(":")) {
          shortname = name.split(":")[0].trim();
        } else if (name.length > 20) {
          shortname = name.substring(0, 20).trim();
        }

        coursesMap.set(cid, {
          id: parseInt(cid, 10),
          fullname: name,
          shortname: shortname,
          viewurl: `${window.location.origin}/course/view.php?id=${cid}`
        });
      }
    }

    return Array.from(coursesMap.values());
  }

  function getStudentName() {
    const el = document.querySelector(".usertext, .logininfo a, [data-region='usermenu']");
    if (!el) return null;
    return cleanText(el.textContent.replace(/^Logged in as\s+/i, "")).substring(0, 100);
  }

  function scanAndDispatch() {
    const courses = extractCoursesFromPage();
    const studentName = getStudentName();
    const institutionName = extractInstitutionName();
    if ((courses.length > 0 || studentName) && typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        chrome.runtime.sendMessage({
          action: "COURSES_DISCOVERED_FROM_PAGE",
          courses: courses,
          studentName: studentName,
          institutionName: institutionName
        });
      } catch (e) {
        // Safe to ignore if background worker is temporarily idle
      }
    }
  }

  scanAndDispatch();
  setTimeout(scanAndDispatch, 2000);
})();
