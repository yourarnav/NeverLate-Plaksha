# NeverLate — Plaksha Deadline Tracker 

Fixed single-site variant of NeverLate for **Plaksha LMS only**:
canonical site is `https://lms.plaksha.edu.in`
(`https://dle.plaksha.edu.in` redirects there and is auto-canonicalized).

## No setup needed

1. Install / load this folder unpacked (`chrome://extensions` → Developer mode → Load unpacked).
2. Sign in at `https://lms.plaksha.edu.in` in a tab.
3. The extension syncs automatically shortly after Plaksha pages load — no URL pasting, no Connect screen. Open the popup and hit Sync anytime for a manual refresh.

Host permission for both Plaksha hosts is granted at install, so the first sync just works.


## Tests

`npm test` runs the unit tests in `tests/` (Node's built-in test runner; no dependencies).

## Packing

`bash scripts/package-plaksha-only.sh` builds `NeverLate-Plaksha-v<version>.zip` with only the shipped runtime files.
