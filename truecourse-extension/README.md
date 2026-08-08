# TrueCourse

A Chrome extension that reads a student's Degree Works audit and acts as a conversational advisor — asking about target graduation term and desired course load, then recommending next semester's courses while respecting prerequisites and flagging bottleneck classes that could delay graduation.

Built for [Stellic's Pathfinders Challenge](https://www.stellic.com/pathfinders), category: **Degree Planning & Discovery**.

> **Judging this submission?** This is a Chrome extension, not a hosted web app, so there's no live URL to click into. Jump straight to [**For judges: installing and testing**](#for-judges-installing-and-testing) below for a 5-minute load-unpacked install and a no-login sample audit to test against.

## The problem

Degree Works audits are accurate but dense — a wall of requirement blocks, statuses, and codes that most students don't read closely until they're forced to during registration. Students end up guessing at what to take next, or leaning on an advisor's limited office hours, rather than getting real-time, requirement-aware guidance grounded in their actual progress.

## How it works

1. **Scan** — a content script (injected on demand via `chrome.scripting`) reads the DOM of the currently open Degree Works audit page and extracts completed, in-progress, and still-needed courses, grouped by requirement block.
2. **Look up prerequisites and section times automatically** — Degree Works only shows a course's prerequisites, and its offered sections' meeting times, inside that course's own detail popup, not in the main audit table. Rather than requiring the student to click through each course, the extension calls the same backend endpoint that popup uses (discovered via network inspection) directly, for every course still needed, using the student's existing session — no clicking required.
3. **Ask** — the popup asks the student their target graduation term (optional), how many courses they want to take next semester, their preferred time of day for classes (optional), and whether they'd like to stick to the minimum required in flexible/elective areas or explore extra electives.
4. **Advise** — the audit data, the automatically-looked-up prerequisite/section details, and the student's preferences are sent to Claude (via the Anthropic API, called directly from the extension with the student's own API key), which returns a recommended course list that respects prerequisites, prioritizes courses that unlock the most future requirements, flags anything that puts the target graduation term at risk (or estimates a realistic one if none was given), recommends a specific CRN matching the student's time-of-day preference where section data was found, and caps recommendations to each block's real remaining credit gap when the student chose "minimum." A few checks came directly from thinking through this as a real academic advisor would: cross-checking a completed prerequisite's actual grade against a downstream course's stated minimum grade (Degree Works marks a prerequisite "complete" the moment it's passed, regardless of grade), watching for courses with a restrictive offering pattern (e.g. Fall-only) that aren't part of this semester's plan but are worth locking in early, flagging a plan that would drop the student below the usual 12-credit full-time threshold, and closing with a short "Questions for your advisor" section that turns anything inferred (rather than verified) into an actual question to ask.
5. **Save it** — "Download Plan" writes the recommendation, plus the preferences and the courses verified behind it, out to a plain-text file the student can keep or bring to an actual advisor appointment. This doesn't need any extra permission (no `downloads` API) -- it's a Blob URL and a synthetic `<a download>` click, the same mechanism any web page can use.

A Manifest V3 popup unloads its entire JS state the moment it loses focus, so an accidental click elsewhere would normally mean starting over. The scanned audit, looked-up course details, typed-in preferences, and the last recommendation are all mirrored to `chrome.storage.local` (the same local-only storage the API key already uses) and restored automatically the next time the popup opens.

The extension targets Degree Works generally. Its selectors (see `scrapeDegreeWorksDOM()` in `popup/popup.js`) were verified against a live Ellucian Degree Works "Dashboard" audit (the modern React `dashboard.bundle.js` UI). Two things made this workable across schools rather than one-off:

- The Dashboard is styled with Material-UI + JSS, which generates random hashed class names per build (e.g. `jssHXunBvEckh2550`) — those are unusable as selectors and aren't relied on.
- What *is* stable are element ids Ellucian's component library assigns consistently — `block-{RULE_ID}` on each requirement block's heading, `{RULE_ID}_statusLabel` for its status text — and accessible `aria-label`s on each row's status icon (`"Requirement is complete"`, `"Not complete"`, and an in-progress variant). Since these come from the shared Dashboard product rather than a school's custom theming, they should hold across institutions running the same product, even though colors/branding differ.

`mock/degreeworks-mock.html` reproduces this exact structure (same ids, same `svg[aria-label]` pattern), so it's scraped by the identical code path as a real audit — the mock isn't a simplified stand-in, it's a faithful fixture.

**On prerequisites and section times specifically:** Degree Works' main audit table doesn't include a prerequisite field or meeting times — both only live inside a course's own detail dialog (opened by clicking that specific course), which also lists that course's offered sections (term, CRN, section, seats, and meeting time). We first tried auto-clicking through every "needed" course to harvest this, but Ellucian's click handler only responds to genuine user gestures — synthetic/programmatic clicks didn't open the dialog. Inspecting the network requests while clicking a course manually showed the dialog doesn't render from data already on the page — it calls a same-origin backend endpoint (`/Dashboard/api/course-link?discipline=X&number=Y`) and renders whatever JSON comes back. Since that's same-origin, a script injected into the page can call it directly with the student's own session cookies, for every needed course, without any click at all (`fetchCourseDetailsBatch()` in `popup/popup.js`). This is not a documented public API — it's what the page's own UI calls internally — so if Ellucian changes its shape, that function is the place to fix it. Claude falls back to inferring likely prerequisites from course numbering/subject knowledge for any course the lookup couldn't reach, says so explicitly when it's inferring, and only applies the student's time-of-day preference (down to a specific CRN) to courses where section data was actually found — it's told never to guess a meeting time or CRN.

**Known gap:** elective "choose one of" requirements can collapse their individual course options behind an unexpanded "see more" toggle in the main audit table, so the requirement-level status is captured but not every individual qualifying course — documented as a next step (auto-expanding those toggles before scraping).

## For judges: installing and testing

This isn't published to the Chrome Web Store (a hackathon-scale extension pointed at a sensitive login-gated page isn't something we wanted to push live yet). Instead:

1. Download or clone this repository.
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (top right toggle).
4. Click **Load unpacked** and select the `truecourse-extension` folder.
5. Pin the extension (puzzle-piece icon → pin) for easy access.

### Testing without a Degree Works account

Since Degree Works sits behind each school's own student login, you won't have credentials to test against a real audit. This repo includes a **mock audit page** at `mock/degreeworks-mock.html`, built to mirror a real audit's structure (student header, requirement blocks, course statuses, prerequisites).

To test:
1. Click the extension icon.
2. Click **"Open Sample Degree Works Page."**
3. On that page, click the extension icon again, then **"Scan This Page."**
4. Fill in a target graduation term, desired course load, and preferred class time (all optional except course load), then **"Get My Course Plan."** Prerequisite and section data is looked up automatically at this point — no extra clicking needed.

This exercises the full pipeline — DOM scraping, the automatic prerequisite/section lookup, and the Claude-generated recommendation — without needing a real login. Since the sample page has no live backend to query, that automatic lookup only has real data to find for the CS 301 row (its detail dialog is baked into the fixture — click **"View Details"** next to it to see the source data yourself); every other course falls back to Claude's inferred reasoning, same as it would for any course a real school's lookup couldn't reach. Our demo video also shows the extension running against a real Degree Works audit, where the lookup covers every needed course.

Under the hood, the mock page is scraped a little differently than a real Degree Works tab: Chrome blocks `chrome.scripting.executeScript` injection into an extension's own `chrome-extension://` pages (it works fine on real http(s) pages), so `mock/mock.js` runs the same scraping logic directly on the page itself and answers the popup over `chrome.runtime` messaging instead. See the comment at the top of `mock/mock.js` for details — the real-page code path in `popup/popup.js` is unaffected.

### Claude API key

Recommendations are generated by calling the Claude API directly from the extension. Click **"Set Claude API key"** at the bottom of the popup (or right-click the extension icon → Options) and paste in a key from [console.anthropic.com](https://console.anthropic.com/). The key is stored only in `chrome.storage.local` on your device and is sent only to Anthropic's API.

For judging purposes, a working key is being shared with reviewers directly through the submission process rather than committed to this public repository, so you can test a live recommendation without creating your own account. This doesn't change the limitation below — it's a convenience for this review period only, not how the product would work at scale.

## Project structure

```
truecourse-extension/
├── manifest.json          Manifest V3 config
├── icons/                 Extension icons
├── popup/                 Popup UI (scan trigger, preferences form, results)
├── background/            Service worker — calls the Claude API
├── options/                API key settings page
└── mock/                  Sample Degree Works page for testing without an account
```

## Tools used

- Chrome Extensions (Manifest V3) — `chrome.scripting`, `chrome.storage`, `chrome.tabs`
- Claude API (Anthropic Messages API) for the advising/recommendation logic
- Vanilla HTML/CSS/JS (no build step, no external dependencies)
- Claude (via Claude Code) for scaffolding and writing the extension

## Privacy note

Audit data is scraped locally in the browser and sent only to Anthropic's Claude API as part of the recommendation request — it isn't stored on any server we control, and nothing is persisted beyond the current popup session. For a production version, the API key would move behind a backend proxy rather than living in the client, and audit data handling would go through a formal privacy/security review given it touches real academic records.

**On the API key today:** every student currently needs their own Anthropic API key to get a live, audit-specific recommendation — that's real friction, and it's the opposite of who this is meant to help (a first-gen student with no one to ask is also less likely to have a Claude API key on hand). The clear next step for a school-hosted version is routing the Claude API call through a backend the school (or Stellic) hosts and pays for centrally, so no student ever needs to bring their own key.

## Known limitations

- Elective "choose one of" requirements whose course options are collapsed behind an unexpanded toggle aren't fully enumerated yet — the requirement-level status is still captured, just not every individual qualifying course.
- Some requirement rows use a completely different column layout than the rest: a literal "Still needed:" label in the first cell and a plain-English description in the second (e.g. "1 Class in PHIL 109 or 119", or "See Major in Information Systems section"), verified against a live audit. `parseStillNeededDescription()` in `popup/popup.js` (mirrored in `mock/mock.js`) handles this: either/or descriptions become a course entry with an `options` array (Claude is told this means "pick one, not all"), and pure cross-references to another block are skipped so they don't get double-counted. If a school phrases this differently than "Still needed:" / "N Class(es) in X or Y", that function is the place to extend it.
- A block can list more individually-"needed" rows than a student actually has to complete — e.g. an elective area that offers several optional courses but only needs one more to finish. Degree Works often renders a real summary sentence per block (e.g. "48 to 55 credits are required. You currently have 45, you still need 3 more credits."); `parseCreditsShortfall()` in `popup/popup.js` (mirrored in `mock/mock.js`) extracts that as `meta.creditsRequiredMin/Max`, `meta.creditsCurrent`, and `meta.creditsStillNeeded`, and it's treated as the authoritative gap rather than the row count. A "Flexible/elective areas" choice in the popup lets the student pick "just meet the minimum required" (default — Claude is told not to recommend more than the real gap for that block) or "explore extra electives too" (Claude can suggest beyond it, labeling what's required vs. optional). This only works when a block renders that exact summary-sentence pattern; blocks without it fall back to the prior row-count-based behavior.
- Prerequisite and section-time lookup relies on an internal, undocumented Degree Works endpoint (`/Dashboard/api/course-link`), found via network inspection rather than published documentation -- it could change shape or move without notice on any given school's Ellucian deployment. Any course the lookup can't reach falls back to Claude's inferred prerequisite reasoning (clearly labeled as such) and gets no time-of-day filtering, since there's no schedule data to filter on.
- Course recommendations are generated by an LLM reasoning over the scraped audit — they're a planning aid, not a registration system, and should be double-checked against an official advisor before registering.
- Offering/term-availability (e.g., "CS 490 is Fall-only") is picked up automatically when a course's catalog description ends with a plain-English pattern like "Offered (FALL/SPRING)" -- verified against a live audit (`offeredTerms` in `fetchCourseDetailsBatch()`, `popup/popup.js`). Courses whose description doesn't include that exact phrasing (some schools may word it differently) fall back to no term-availability data for that course.
- If a school's Dashboard build differs enough that `h3[id^="block-"]` or the status-icon `aria-label`s don't match, `scrapeDegreeWorksDOM()` in `popup/popup.js` is the single place to adjust.
