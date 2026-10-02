# NeverLate — Plaksha Deadline Tracker (Plaksha-only build)

Fixed single-site variant of NeverLate for **Plaksha LMS only**:
canonical site is `https://lms.plaksha.edu.in`
(`https://dle.plaksha.edu.in` redirects there and is auto-canonicalized).

## No setup needed

1. Install / load this folder unpacked (`chrome://extensions` → Developer mode → Load unpacked).
2. Sign in at `https://lms.plaksha.edu.in` in a tab.
3. The extension syncs automatically shortly after Plaksha pages load — no URL pasting, no Connect screen. Open the popup and hit Sync anytime for a manual refresh.

Host permission for both Plaksha hosts is granted at install, so the first sync just works.

## What's different from the multi-university build

- No university switcher, presets, or Current-Tab onboarding.
- `getBaseUrl()` always returns the LMS root; old `dle` buckets and legacy caches migrate into it (Done marks, reminders, manual deadlines preserved).
- Background auto-syncs (throttled: 10s manual / 45s auto attempt throttle, 3m/120m success cooldown) when a Plaksha page finishes loading.
- Content scripts are statically declared in `manifest.json` for both Plaksha hosts.

## Packing

`bash scripts/package-plaksha-only.sh` builds `NeverLate-Plaksha-v<version>.zip` with only the shipped runtime files.
