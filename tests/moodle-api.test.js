const test = require("node:test");
const assert = require("node:assert/strict");

function installChromeMock() {
  const store = {};
  global.chrome = {
    storage: {
      local: {
        async get(keys) {
          const out = {};
          for (const k of [].concat(keys)) if (k in store) out[k] = JSON.parse(JSON.stringify(store[k]));
          return out;
        },
        async set(obj) {
          // Yield so interleaved read-modify-write cycles would be exposed.
          await new Promise((r) => setTimeout(r, 5));
          for (const [k, v] of Object.entries(obj)) store[k] = JSON.parse(JSON.stringify(v));
        },
        async remove(keys) {
          for (const k of [].concat(keys)) delete store[k];
        }
      }
    }
  };
  return store;
}

const store = installChromeMock();
const { MoodleAPI, PLAKSHA_BASE_URL } = require("../scripts/moodle-api.js");

test("pruneFiredReminders keeps 7d exam key until the exam has passed", () => {
  const now = Date.now();
  const examSec = Math.floor((now + 3 * 86400000) / 1000);
  const site = PLAKSHA_BASE_URL;
  const item = { url: `${site}/mod/quiz/view.php?id=9`, timesort: examSec, type: "exam" };
  const key = MoodleAPI.getReminderKey(site, item, "7d");
  const fired = { [key]: now - 4 * 86400000 };
  const { fired: kept, pruned } = MoodleAPI.pruneFiredReminders(fired, now);
  assert.equal(pruned, false);
  assert.ok(kept[key]);

  const later = MoodleAPI.pruneFiredReminders(fired, now + 3 * 86400000 + 49 * 3600000);
  assert.equal(later.pruned, true);
  assert.deepEqual(later.fired, {});
});

test("pruneFiredReminders falls back to fire time for digest keys", () => {
  const now = Date.now();
  const fired = { "digest:x:2026-01-01": now - 49 * 3600000, "digest:x:2026-01-02": now - 1000, bad: "nope" };
  const { fired: kept } = MoodleAPI.pruneFiredReminders(fired, now);
  assert.deepEqual(Object.keys(kept), ["digest:x:2026-01-02"]);
});

test("courseCodeMatchesText matches whole tokens only", () => {
  assert.equal(MoodleAPI.courseCodeMatchesText("AI3022", "quiz for ai3022 lab"), true);
  assert.equal(MoodleAPI.courseCodeMatchesText("AI3022", "ai 3022"), true);
  assert.equal(MoodleAPI.courseCodeMatchesText("AI3022", "activity 13022 something"), false);
  assert.equal(MoodleAPI.courseCodeMatchesText("AI3022", "id 30221"), false);
  assert.equal(MoodleAPI.courseCodeMatchesText("Intro to AI", "anything 3022"), false);
});

test("cleanHtmlText decodes numeric entities without double-decoding", () => {
  assert.equal(MoodleAPI.cleanHtmlText("Tom&#39;s &#x26; Jerry &amp;lt;b&amp;gt;"), "Tom's & Jerry &lt;b&gt;");
  assert.equal(MoodleAPI.cleanHtmlText("<b>Hi</b>&nbsp;there"), "Hi there");
});

test("calendar scraper skips events without a timestamp", async () => {
  const html = `
    <div class="event" data-event-id="5"><h3 class="name">Assign 1 is due</h3>
      <a href="${PLAKSHA_BASE_URL}/mod/assign/view.php?id=77">Go to activity</a>
      <a href="${PLAKSHA_BASE_URL}/calendar/view.php?view=day&time=1900000000">Date</a></div>
    <div class="event" data-event-id="6"><h3 class="name">Mystery</h3>
      <a href="${PLAKSHA_BASE_URL}/mod/assign/view.php?id=78">Go to activity</a></div>`;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => html });
  const res = await MoodleAPI.fetchUpcomingFromCalendar(PLAKSHA_BASE_URL);
  assert.equal(res.deadlines.length, 1);
  assert.equal(res.deadlines[0].timesort, 1900000000);
  assert.equal(res.deadlines[0].name, "Assign 1");
});

test("ambiguous same-origin page does not count as verified logout", async () => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    url: `${PLAKSHA_BASE_URL}/my/`,
    text: async () => "<html><body>Some unrecognised markup</body></html>"
  });
  const session = await MoodleAPI.checkSession(PLAKSHA_BASE_URL);
  assert.equal(session.transientFailure, true);
  assert.equal(session.ambiguousSession, true);
  assert.notEqual(session.verifiedLoggedOut, true);
});

test("updateSiteData serialises concurrent read-modify-write cycles", async () => {
  delete store.sites;
  await Promise.all([
    MoodleAPI.updateSiteData(PLAKSHA_BASE_URL, (prev) => ({ completedDeadlines: { ...prev.completedDeadlines, a: 1 } })),
    MoodleAPI.updateSiteData(PLAKSHA_BASE_URL, (prev) => ({ completedDeadlines: { ...prev.completedDeadlines, b: 2 } })),
    MoodleAPI.saveSiteData(PLAKSHA_BASE_URL, { institutionName: "Plaksha University" })
  ]);
  const data = await MoodleAPI.getSiteData(PLAKSHA_BASE_URL);
  assert.deepEqual(data.completedDeadlines, { a: 1, b: 2 });
  assert.equal(data.institutionName, "Plaksha University");
});

test("syncAll keeps manual deadlines added while the sync was running", async () => {
  delete store.sites;
  const manual = MoodleAPI.buildManualDeadline({
    siteKey: PLAKSHA_BASE_URL, type: "personal", title: "Gym", timesort: Math.floor(Date.now() / 1000) + 3600
  });
  const dash = `<html><script>M.cfg={"sesskey":"abc123"}</script><span class="usertext">Test User</span></html>`;
  global.fetch = async (url, opts) => {
    if (String(url).includes("/lib/ajax/service.php")) {
      // Student adds a manual deadline mid-sync.
      await MoodleAPI.updateSiteData(PLAKSHA_BASE_URL, () => ({
        moodleData: { user: { isLoggedIn: true }, courses: [], deadlines: [manual] }
      }));
      return { ok: true, status: 200, json: async () => [{ data: { events: [] } }, { data: { courses: [] } }] };
    }
    if (String(url).includes("/calendar/view.php")) return { ok: true, status: 200, text: async () => "" };
    return { ok: true, status: 200, url: String(url), text: async () => dash };
  };
  const res = await MoodleAPI.syncAll(PLAKSHA_BASE_URL);
  assert.equal(res.success, true);
  assert.ok(res.data.deadlines.some((d) => d.id === manual.id));
  const stored = await MoodleAPI.getSiteData(PLAKSHA_BASE_URL);
  assert.ok(stored.moodleData.deadlines.some((d) => d.id === manual.id));
});

test("exam wording is recognised for calendar-only events", () => {
  const cls = (name, url = "") => MoodleAPI.classifyMoodleType({ name, url });
  for (const n of ["Mid Term", "Mid-Sem Exam", "MidSem", "End Sem", "Endsem Exam", "End-Semester", "Final Exam", "Finals", "Test 1", "Class Test", "Viva"]) {
    assert.equal(cls(n, `${PLAKSHA_BASE_URL}/calendar/view.php?view=day`), "exam", n);
    assert.equal(cls(n), "exam", n);
  }
});

test("exam detection does not hijack real activities", () => {
  const assign = `${PLAKSHA_BASE_URL}/mod/assign/view.php?id=1`;
  assert.equal(MoodleAPI.classifyMoodleType({ name: "Mid Term Project", url: assign }), "assignment");
  assert.equal(MoodleAPI.classifyMoodleType({ name: "Final project submission", url: `${PLAKSHA_BASE_URL}/calendar/view.php` }), "assignment");
  assert.equal(MoodleAPI.classifyMoodleType({ name: "Weekly Quiz 3", url: `${PLAKSHA_BASE_URL}/mod/quiz/view.php?id=2` }), "quiz");
  assert.equal(MoodleAPI.classifyMoodleType({ name: "Problem Set 5" }), "assignment");
});

test("guessExamSubtype maps wording to kinds", () => {
  assert.equal(MoodleAPI.guessExamSubtype("Mid Term"), "midsem");
  assert.equal(MoodleAPI.guessExamSubtype("End Sem"), "endsem");
  assert.equal(MoodleAPI.guessExamSubtype("Final Exam"), "endsem");
  assert.equal(MoodleAPI.guessExamSubtype("Test 2"), "test");
  assert.equal(MoodleAPI.guessExamSubtype("Viva"), "viva");
  assert.equal(MoodleAPI.guessExamSubtype("Some Exam"), "other");
});
