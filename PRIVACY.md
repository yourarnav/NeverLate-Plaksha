# NeverLate Privacy Policy

Effective date: October 4, 2026

NeverLate is an independent Chrome extension that helps Plaksha University students track academic deadlines from the Plaksha LMS (`lms.plaksha.edu.in`, and its legacy address `dle.plaksha.edu.in`). NeverLate does not operate a developer backend, does not use analytics or advertising, and does not sell user data.

## Data the extension handles

While the student is signed in to the Plaksha LMS, NeverLate may process:

- the institution name and LMS address;
- the student's display name;
- course names, course identifiers, course links, deadline titles, activity links, due dates, and related academic metadata shown by the LMS;
- a Moodle session key used transiently to request the student's calendar data from the same site;
- manual deadlines, completion status, reminder history, theme settings, alert preferences, and calendar-export preferences entered or selected by the user; and
- the address of a Plaksha LMS page when needed to verify that extension messages came from the LMS.

This information is used only to display courses and deadlines, calculate countdowns, schedule requested reminders, suppress completed items, and create calendar exports.

## Storage and retention

Course and deadline data, settings, completion status, and reminder history are stored locally on the user's device with `chrome.storage.local`. The developer cannot access that storage. Moodle session keys are held only in memory for the duration of a request and are never written to extension storage.

Local data remains until it is replaced during synchronization, cleared through Chrome's extension-data controls, or removed when the extension is uninstalled. Manual deadlines can also be deleted individually in NeverLate.

## Network requests and sharing

A small content script runs on Plaksha LMS pages. It reads the student's display name and, on the dashboard and "My courses" pages, the course list, and passes them only to NeverLate's own background worker on the user's device. NeverLate makes background requests only to the Plaksha LMS over HTTPS. Those requests use the portal's existing browser session and are rate-limited. The extension does not send portal data to the developer or to a developer-operated server.

If the user explicitly chooses **Google Calendar** or **Outlook 365** export, NeverLate opens that provider's event-composition page. The selected deadline's title, course, date and time, optional location, and—when the user keeps the link option enabled—the activity link are included in that request and are then handled under the chosen provider's privacy terms. Exporting an `.ics` file creates a local file; any later import is controlled by the user and the calendar application they choose.

NeverLate does not otherwise share user data with third parties. It does not sell data, use data for advertising, or allow the developer or other humans to read user data.

## Permissions

- **Storage:** saves the local cache, settings, completion status, and reminder history.
- **Alarms:** schedules low-frequency portal refreshes and deadline reminders.
- **Notifications (optional):** displays deadline reminders after the user opts in.
- **Website access:** limited to `lms.plaksha.edu.in` and `dle.plaksha.edu.in`, for syncing deadlines and the content script described above. NeverLate has no access to any other website.

## Security

NeverLate accepts only HTTPS Plaksha LMS addresses, restricts extension messages and saved activity links to the Plaksha LMS origin, strips known session and access-token parameters before storing links, and does not execute remotely hosted code.

## Chrome Web Store Limited Use

NeverLate's use of information obtained from Chrome APIs and connected websites complies with the Chrome Web Store User Data Policy, including the Limited Use requirements. Data is used only to provide or improve the extension's disclosed, user-facing academic deadline-tracking purpose.

## User choices

Users choose whether to enable notifications, whether calendar exports include activity links, and whether to initiate any Google, Microsoft, or `.ics` calendar export. Removing the extension deletes its local extension storage through Chrome.

## Contact

Questions or privacy requests can be submitted through the project's public issue tracker: <https://github.com/yourarnav/BetterMoodle/issues>.

## Trademark notice

Moodle™ is a trademark of Moodle Pty Ltd or its related affiliates. NeverLate is an independent project and is not affiliated with, endorsed by, or sponsored by Moodle Pty Ltd.
