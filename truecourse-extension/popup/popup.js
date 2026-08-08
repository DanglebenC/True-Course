// popup.js
// Drives the popup UI: scans the active tab's DOM for a Degree Works-style
// audit, collects the student's preferences, and asks the background
// service worker to get a recommendation from Claude.

let currentAudit = null;
// Keyed by course code -- prerequisite/section details, fetched
// automatically for every "needed" course when "Get My Course Plan" is
// clicked (see autoFetchCourseDetails / fetchCourseDetailsBatch).
let courseDetails = {};
// Snapshot of the most recent recommendation + the preferences that
// produced it, so "Download Plan" has something to write out.
let lastPlan = null;

const el = (id) => document.getElementById(id);

// Manifest V3 popups unload their entire JS context the instant they lose
// focus (clicking elsewhere, an accidental close) -- everything above would
// normally be lost. Persisting a snapshot to chrome.storage.local (same
// place the API key already lives) and restoring it on the next open means
// closing the popup mid-session doesn't force starting over. This is local
// to the student's own device, same as the API key -- nothing new leaves
// the browser.
const STATE_STORAGE_KEY = "pathfinderState";

async function saveState() {
  const state = {
    currentAudit,
    courseDetails,
    lastPlan: lastPlan ? { ...lastPlan, generatedAt: lastPlan.generatedAt.toISOString() } : null,
    formValues: {
      gradGoal: el("input-grad-term").value,
      courseLoad: el("input-course-load").value,
      timePreference: el("input-time-preference").value,
      electiveScope: el("input-elective-scope").value,
    },
  };
  try {
    await chrome.storage.local.set({ [STATE_STORAGE_KEY]: state });
  } catch (err) {
    // Non-fatal -- worst case a later accidental close loses progress
    // again, but the current popup session keeps working normally.
    console.warn("Couldn't save session state:", err.message);
  }
}

async function loadState() {
  let stored;
  try {
    stored = await chrome.storage.local.get(STATE_STORAGE_KEY);
  } catch (err) {
    return;
  }
  const state = stored && stored[STATE_STORAGE_KEY];
  if (!state) return;

  if (state.formValues) {
    if (state.formValues.gradGoal) el("input-grad-term").value = state.formValues.gradGoal;
    if (state.formValues.courseLoad) el("input-course-load").value = state.formValues.courseLoad;
    if (state.formValues.timePreference !== undefined) el("input-time-preference").value = state.formValues.timePreference;
    if (state.formValues.electiveScope) el("input-elective-scope").value = state.formValues.electiveScope;
  }

  if (state.currentAudit) {
    currentAudit = state.currentAudit;
    courseDetails = state.courseDetails || {};
    renderSummary(currentAudit);
    el("step-summary").classList.remove("hidden");
  }

  if (state.lastPlan) {
    lastPlan = { ...state.lastPlan, generatedAt: new Date(state.lastPlan.generatedAt) };
    el("results-content").textContent = lastPlan.text;
    el("step-results").classList.remove("hidden");
    el("step-summary").classList.add("hidden");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadState();

  el("btn-scan").addEventListener("click", handleScan);
  el("btn-open-mock").addEventListener("click", openMockPage);
  el("btn-recommend").addEventListener("click", handleRecommend);
  el("btn-download-plan").addEventListener("click", handleDownloadPlan);
  el("btn-restart").addEventListener("click", restart);
  el("link-options").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // Keep typed-in preferences safe too, not just scan/plan results -- an
  // accidental close shouldn't lose a half-filled-out form either.
  ["input-grad-term", "input-course-load", "input-time-preference", "input-elective-scope"].forEach((id) => {
    el(id).addEventListener("change", saveState);
  });
});

function openMockPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL("mock/degreeworks-mock.html") });
}

// Chrome won't allow chrome.scripting.executeScript to inject into the
// extension's own chrome-extension:// pages (it works fine on a real
// http(s) Degree Works page, just not this one) -- so the mock page runs
// its own copy of the scraper (mock/mock.js) and we talk to it over
// chrome.runtime messaging instead of injection when we detect we're on it.
function isMockPageUrl(url) {
  return typeof url === "string" && url.startsWith(chrome.runtime.getURL("mock/degreeworks-mock.html"));
}

function setStatus(elId, message, kind) {
  const node = el(elId);
  node.textContent = message || "";
  node.className = "status" + (kind ? " " + kind : "");
}

async function handleScan() {
  setStatus("scan-status", "Scanning page…");
  el("btn-scan").disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error("Couldn't find the active tab.");

    let result;
    if (isMockPageUrl(tab.url)) {
      result = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_AUDIT" });
    } else {
      const injection = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: scrapeDegreeWorksDOM,
      });
      result = injection && injection[0] && injection[0].result;
    }

    if (!result || result.error) {
      setStatus(
        "scan-status",
        (result && result.error) ||
          "No audit data found on this page. Try the sample audit instead.",
        "error"
      );
      el("btn-scan").disabled = false;
      return;
    }

    currentAudit = result;
    renderSummary(result);
    setStatus("scan-status", "Scan complete.", "ok");
    el("step-summary").classList.remove("hidden");
    saveState();
  } catch (err) {
    setStatus(
      "scan-status",
      "Couldn't scan this page (" + err.message + "). Try the sample audit instead.",
      "error"
    );
  } finally {
    el("btn-scan").disabled = false;
  }
}

// This function is injected into the *page* being scanned, not the
// extension's own context, so it must be fully self-contained (no
// references to outer-scope variables, imports, or other functions in this
// file -- chrome.scripting.executeScript only serializes this one function).
//
// Selectors verified against a live Ellucian Degree Works "Dashboard" React
// audit (the modern dashboard.bundle.js UI, not the legacy worksheets/render
// view). A few things worth knowing about why it's built this way:
//
//   - Ellucian's Dashboard is built with Material-UI + JSS, which generates
//     random hashed class names per build (e.g. "jssHXunBvEckh2550"). Those
//     are NOT stable and are not used here.
//   - What *is* stable: element ids like `block-{RULE_ID}` and
//     `{RULE_ID}_statusLabel`, and accessible aria-labels on the status
//     icons ("Requirement is complete" / "Not complete" / an in-progress
//     variant). These come from Ellucian's shared component library, so
//     they should hold across schools running the same Dashboard product,
//     even though the school's theming/colors differ.
//   - Also mirrored in mock/degreeworks-mock.html, so the mock and the real
//     page are scraped by the exact same code path.
//
// Known limitation: elective "choose one of" requirement rows can collapse
// their individual course options behind a "see more" toggle that isn't
// expanded on page load, so this pass captures requirement-level status
// (e.g. "Systems Analysis and Design -- Not complete") rather than every
// individual course that could satisfy it. Auto-expanding those toggles
// before scraping is a natural next step.
//
// A second row layout, verified on a live audit: some rows render a
// literal "Still needed:" label in the first cell and a free-text
// description in the second, instead of the normal Course/Title/Grade/
// Credits/Term columns -- e.g. "1 Class in PHIL 109 or 119" (a genuine
// either/or choice) or "See Major in Information Systems section" (a
// cross-reference to another block, not a real requirement of its own).
// parseStillNeededRow() below handles this so those descriptions don't
// get silently misread as if "Still needed:" were a course code.
function scrapeDegreeWorksDOM() {
  const fieldValue = (elm) => {
    if (!elm) return "";
    const raw = "value" in elm ? elm.value : elm.textContent;
    return (raw || "").trim();
  };

  const normalizeStatus = (ariaLabel) => {
    const s = (ariaLabel || "").toLowerCase();
    if (s.includes("not complete")) return "needed";
    if (s.includes("in-progress") || s.includes("in progress")) return "in-progress";
    if (s.includes("complete")) return "complete";
    return "unknown";
  };

  // Parses a "Still needed:" row's free-text description. Returns null for
  // pure "See X section" cross-references (skip -- the real courses are
  // already captured under that other block). Otherwise returns
  // { code, title, options }, where options has more than one entry only
  // for genuine either/or choices ("1 Class in PHIL 109 or 119").
  const parseStillNeededDescription = (description) => {
    const trimmed = (description || "").trim();
    if (/^see\s+.+\s+section$/i.test(trimmed)) return null;

    const match = trimmed.match(/^\d+\s+class(?:es)?\s+in\s+(.+)$/i);
    if (!match) {
      return { code: "", title: trimmed, options: [] };
    }

    const rawOptions = match[1]
      .split(/\s+or\s+/i)
      .map((s) => s.trim())
      .filter(Boolean);
    // Alternates in the same department are often listed without repeating
    // the department code (e.g. "MGBU 499 or 498") -- fill it back in.
    const deptMatch = (rawOptions[0] || "").match(/^([A-Z]{2,6})\s*\d/);
    const dept = deptMatch ? deptMatch[1] : "";
    const options = rawOptions.map((opt) =>
      /^[A-Z]{2,6}\s*\d/.test(opt) ? opt : dept ? dept + " " + opt : opt
    );

    return {
      code: options.join(" or "),
      title: options.length > 1 ? "Choose 1 of: " + options.join(", ") : options[0] || trimmed,
      options,
    };
  };

  // Some blocks render a plain-English credit-shortfall summary (verified
  // on a live audit), e.g. "48 to 55 credits are required. You currently
  // have 45, you still need 3 more credits." This is the block's real
  // remaining requirement -- often much smaller than the sum of every
  // individually-listed "needed" row, since many blocks list more optional
  // courses than a student actually needs to take. Returns null if no such
  // summary is found (not every block has one -- e.g. blocks with a fixed,
  // fully-enumerated course list usually don't).
  const parseCreditsShortfall = (container) => {
    const candidates = Array.from(container.querySelectorAll("p"));
    const text = candidates.map((p) => p.textContent.trim()).find((t) => /credits?\s+are\s+required/i.test(t));
    if (!text) return null;

    const match = text.match(
      /(\d+)(?:\s*to\s*(\d+))?\s*credits?\s*are\s*required\.?\s*You\s*currently\s*have\s*(\d+),?\s*you\s*still\s*need\s*(\d+)\s*more\s*credits?/i
    );
    if (!match) return null;

    return {
      creditsRequiredMin: parseInt(match[1], 10),
      creditsRequiredMax: match[2] ? parseInt(match[2], 10) : parseInt(match[1], 10),
      creditsCurrent: parseInt(match[3], 10),
      creditsStillNeeded: parseInt(match[4], 10),
    };
  };

  const student = {
    id: fieldValue(document.getElementById("student-id")),
    name: fieldValue(document.getElementById("student-name")),
    degree: fieldValue(document.getElementById("degree")),
  };

  const blockHeaders = Array.from(document.querySelectorAll('h3[id^="block-"]'));

  const blocks = blockHeaders.map((h3) => {
    const ruleId = h3.id.replace("block-", "");
    const status = fieldValue(document.getElementById(ruleId + "_statusLabel"));
    const title = h3.firstChild ? h3.firstChild.textContent.trim() : fieldValue(h3);

    // Block-level metadata (Credits required/applied, Catalog year, GPA) is
    // rendered as sibling `<div><span>Label:</span>Value</div>` rows next to
    // the h3, not inside it.
    const meta = {};
    Array.from(h3.parentElement.children)
      .filter((d) => d !== h3 && d.tagName === "DIV")
      .forEach((d) => {
        const span = d.querySelector("span");
        if (!span) return;
        const label = span.textContent.trim().replace(/:$/, "");
        const value = d.textContent.replace(span.textContent, "").trim();
        if (label) meta[label] = value;
      });

    // The requirement/course table lives somewhere above the h3, inside the
    // block's outer container -- but how many levels up varies (the mock
    // page nests it shallowly; the real Dashboard wraps it in a collapsible
    // header/content pair several levels deep). Rather than hard-coding a
    // hop count, climb ancestors only as long as the ancestor still contains
    // exactly this one block's heading -- the moment climbing one more level
    // would pull in a sibling block's h3 too, stop, since that means we've
    // stepped outside this block's own container.
    let container = h3.parentElement || h3;
    for (let i = 0; i < 15 && container.parentElement; i++) {
      const next = container.parentElement;
      const blockCount = next.querySelectorAll('h3[id^="block-"]').length;
      if (blockCount > 1) break;
      container = next;
    }

    const creditsShortfall = parseCreditsShortfall(container);
    if (creditsShortfall) Object.assign(meta, creditsShortfall);

    const rows = Array.from(container.querySelectorAll("tbody tr"));
    const courses = rows
      .map((row) => {
        const icon = row.querySelector("svg[aria-label]");
        const rawStatus = icon ? icon.getAttribute("aria-label") : "";
        const status = normalizeStatus(rawStatus);
        const cells = Array.from(row.querySelectorAll("td")).map((td) => fieldValue(td));
        const label = fieldValue(row.querySelector("th"));

        if (/^still needed:?$/i.test(cells[0] || "")) {
          const parsed = parseStillNeededDescription(cells[1] || "");
          if (!parsed) return null; // "See X section" cross-reference -- not a real requirement
          return {
            code: parsed.code,
            title: parsed.title,
            options: parsed.options,
            grade: "",
            credits: "",
            term: "",
            status,
          };
        }

        // Verified column order on a live instance: Course, Title, Grade, Credits, Term, Repeated
        const [code, courseTitle, grade, credits, term] = cells;
        return {
          code: code || "",
          title: courseTitle || label,
          options: [],
          grade: grade || "",
          credits: credits || "",
          term: term || "",
          status,
        };
      })
      .filter((c) => c && (c.code || c.title));

    return { title, status, meta, courses };
  });

  if (blocks.length === 0) {
    return {
      error:
        'No Degree Works audit blocks found on this page (looking for h3[id^="block-"]). This school\'s Dashboard build may render differently -- see the comment above scrapeDegreeWorksDOM() in popup.js.',
    };
  }

  return { student, blocks, scannedAt: new Date().toISOString() };
}

// Collects every "needed" course code from the scanned audit (including
// each option in an either/or row's `options` array) and looks up its
// prerequisite/section data in one batch, storing results in courseDetails
// keyed by the original code string. Runs automatically as part of
// handleRecommend(), right before the audit is sent to Claude -- see
// fetchCourseDetailsBatch() for how the lookup itself works, and why it
// doesn't need a click on the Degree Works page at all. Failures here are
// non-fatal: courseDetails just stays whatever it already had, and Claude
// falls back to inferred prerequisites for anything missing.
async function autoFetchCourseDetails(tab, audit) {
  const codes = new Set();
  (audit.blocks || []).forEach((b) => {
    (b.courses || []).forEach((c) => {
      if (c.status !== "needed") return;
      if (Array.isArray(c.options) && c.options.length > 0) {
        c.options.forEach((o) => {
          if (o) codes.add(o.trim());
        });
      } else if (c.code) {
        codes.add(c.code.trim());
      }
    });
  });

  const codeList = Array.from(codes).filter(Boolean);
  if (codeList.length === 0) return;

  let results;
  if (isMockPageUrl(tab.url)) {
    results = await chrome.tabs.sendMessage(tab.id, { type: "FETCH_COURSE_DETAILS_BATCH", codes: codeList });
  } else {
    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fetchCourseDetailsBatch,
      args: [codeList],
    });
    results = injection && injection[0] && injection[0].result;
  }

  if (results && typeof results === "object") {
    Object.assign(courseDetails, results);
  }
}

// Self-contained, injected into the page (same constraints as
// scrapeDegreeWorksDOM -- no outer-scope references, since
// chrome.scripting.executeScript only serializes this one function).
//
// Degree Works' course-detail dialog (opened by clicking a course) doesn't
// render its contents from data already on the page -- it fetches them.
// Watching the network tab while clicking a course on a live audit showed a
// same-origin GET to /Dashboard/api/course-link?discipline=X&number=Y that
// returns structured JSON: title, description, a prerequisites array (each
// entry has subjectCodePrerequisite/courseNumberPrerequisite/minimumGrade/
// connector), and a sections array (term, CRN, seats, and a meetings array
// with day flags + 24-hour begin/end times). Since it's same-origin, a
// script injected into the page can call it directly with the student's
// existing session cookies -- no click simulation needed, and (unlike the
// dialog itself) it can be called for every needed course in one batch
// instead of one at a time. This endpoint is not a documented public API --
// it's what the page's own UI calls internally, discovered via network
// inspection -- so if Ellucian changes its shape, this is the place to fix.
// The description text also sometimes ends with a plain-English offering
// pattern (e.g. "Offered (FALL/SPRING)") -- pulled out separately below into
// `offeredTerms` so the prompt can reason about term availability directly.
async function fetchCourseDetailsBatch(codes) {
  const formatTime = (hhmm) => {
    if (!hhmm || hhmm.length < 3) return "";
    const hour = parseInt(hhmm.slice(0, hhmm.length - 2), 10);
    const minute = hhmm.slice(-2);
    const period = hour >= 12 ? "pm" : "am";
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    return hour12 + ":" + minute + period;
  };

  const formatMeeting = (meeting) => {
    if (!meeting) return "";
    const dayLetters = [
      ["sunday", "U"],
      ["monday", "M"],
      ["tuesday", "T"],
      ["wednesday", "W"],
      ["thursday", "R"],
      ["friday", "F"],
      ["saturday", "S"],
    ];
    const days = dayLetters
      .filter(([field]) => meeting[field])
      .map(([, letter]) => letter)
      .join("");
    const time =
      meeting.beginTime && meeting.endTime ? formatTime(meeting.beginTime) + " - " + formatTime(meeting.endTime) : "";
    return [days, time].filter(Boolean).join(" ");
  };

  // Rebuilds a readable prerequisite string (e.g. "INSS 391 (minimum grade
  // C) or EEGR 243 (minimum grade C)") from the API's structured list.
  const formatPrerequisites = (list) => {
    if (!Array.isArray(list) || list.length === 0) return "";
    return list
      .map((p, i) => {
        const subject = p.subjectCodePrerequisite || "";
        const number = p.courseNumberPrerequisite || "";
        if (!subject && !number) return "";
        let piece = (subject + " " + number).trim();
        if (p.minimumGrade) piece += " (minimum grade " + p.minimumGrade + ")";
        if (i === 0) return piece;
        return (p.connector === "O" ? " or " : " and ") + piece;
      })
      .filter(Boolean)
      .join("");
  };

  const results = {};

  await Promise.all(
    codes.map(async (rawCode) => {
      const match = (rawCode || "").match(/^([A-Z]{2,6})\s*(\d{2,4})/);
      if (!match) return;
      const discipline = match[1];
      const number = match[2];

      try {
        const res = await fetch(
          "/Dashboard/api/course-link?discipline=" + discipline + "&number=" + number + "&",
          { credentials: "include" }
        );
        if (!res.ok) return;

        const data = await res.json();
        const course =
          data && data.courseInformation && Array.isArray(data.courseInformation.courses)
            ? data.courseInformation.courses[0]
            : null;
        if (!course) return;

        const description = Array.isArray(course.description) ? course.description.join("").trim() : "";
        // The catalog description often ends with a plain-English offering
        // pattern, e.g. "...Offered (FALL/SPRING)" or "Offered (FALL only)"
        // -- verified on a live audit (INSS 396). Pulling this out
        // separately lets the prompt reason about it explicitly instead of
        // hoping it notices a clause buried in a paragraph.
        const offeredMatch = description.match(/offered\s*\(([^)]+)\)/i);
        const offeredTerms = offeredMatch ? offeredMatch[1].trim() : "";
        const sections = Array.isArray(course.sections)
          ? course.sections.map((s) => ({
              term: s.termLiteral || "",
              crn: s.courseReferenceNumber || "",
              section: s.sequenceNumber || "",
              seats:
                s.seatsAvailable != null && s.maximumEnrollment != null
                  ? s.seatsAvailable + " open (of " + s.maximumEnrollment + ")"
                  : "",
              meeting: Array.isArray(s.meetings) && s.meetings.length ? formatMeeting(s.meetings[0]) : "",
            }))
          : [];

        results[rawCode] = {
          code: discipline + " " + number,
          header: discipline + " " + number + (course.title ? " - " + course.title : ""),
          description,
          prerequisites: formatPrerequisites(course.prerequisites),
          corequisites: "",
          sections,
          offeredTerms,
        };
      } catch (err) {
        // Skip this one course on any fetch/parse failure -- the others in
        // the batch shouldn't be held up by it, and Claude already handles
        // a course with no verified data by falling back to inferred
        // prerequisites and skipping time-of-day filtering for it.
      }
    })
  );

  return results;
}

function renderSummary(audit) {
  const s = audit.student || {};
  // Catalog year, if present, tends to live in the top-level degree block's
  // metadata rather than a standalone student field.
  const topBlockMeta = (audit.blocks || [])[0]?.meta || {};
  const catalogYear = topBlockMeta["Catalog year"] || "";

  el("student-summary").innerHTML = [
    s.name ? "<div><strong>" + escapeHtml(s.name) + "</strong></div>" : "",
    s.degree ? "<div>" + escapeHtml(s.degree) + "</div>" : "",
    catalogYear ? "<div>Catalog: " + escapeHtml(catalogYear) + "</div>" : "",
  ]
    .filter(Boolean)
    .join("");

  const blockSummaryHtml = (audit.blocks || [])
    .map((b) => {
      const needed = b.courses.filter((c) => c.status === "needed").length;
      const total = b.courses.length;
      return (
        '<div class="block-summary-row"><span>' +
        escapeHtml(b.title) +
        "</span><span>" +
        needed +
        " of " +
        total +
        " still needed</span></div>"
      );
    })
    .join("");

  el("block-summary").innerHTML = blockSummaryHtml;
}

async function handleRecommend() {
  if (!currentAudit) return;

  // Left blank on purpose covers part-time, behind-schedule, and transfer
  // students who may not have a real target yet -- background.js asks
  // Claude to estimate a timeline instead of skipping that guidance.
  const gradGoal = el("input-grad-term").value.trim() || null;
  const courseLoad = el("input-course-load").value;
  const timePreference = el("input-time-preference").value || null;
  const electiveScope = el("input-elective-scope").value || "minimum";

  setStatus("recommend-status", "Looking up prerequisites and sections for your remaining courses…");
  el("btn-recommend").disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      try {
        await autoFetchCourseDetails(tab, currentAudit);
      } catch (err) {
        // Non-fatal: proceed with whatever courseDetails already has.
        // Claude falls back to inferred prerequisites and skips
        // time-of-day filtering for any course this couldn't reach.
        console.warn("Auto course-detail fetch failed:", err.message);
      }
    }

    setStatus("recommend-status", "Asking Claude for a plan…");

    const response = await chrome.runtime.sendMessage({
      type: "GET_RECOMMENDATION",
      payload: {
        audit: currentAudit,
        gradGoal,
        courseLoad,
        timePreference,
        electiveScope,
        courseDetails: Object.values(courseDetails),
      },
    });

    if (!response || response.error) {
      const message = (response && response.error) || "Something went wrong.";
      setStatus("recommend-status", message, "error");
      el("btn-recommend").disabled = false;
      return;
    }

    el("results-content").textContent = response.text;
    el("step-results").classList.remove("hidden");
    el("step-summary").classList.add("hidden");
    setStatus("recommend-status", "", "");

    lastPlan = {
      text: response.text,
      generatedAt: new Date(),
      student: (currentAudit && currentAudit.student) || {},
      gradGoal,
      courseLoad,
      timePreference,
      electiveScope,
      importedCourses: Object.values(courseDetails),
    };
    saveState();
  } catch (err) {
    setStatus("recommend-status", "Request failed: " + err.message, "error");
  } finally {
    el("btn-recommend").disabled = false;
  }
}

// Builds a plain-text copy of the plan (recommendation + the preferences
// that produced it) and triggers a normal browser download of it. This
// needs no extra manifest permission -- popups can trigger file downloads
// the same way any web page can, via a Blob URL and a synthetic <a
// download> click, so there's no "downloads" permission to request.
function handleDownloadPlan() {
  if (!lastPlan) return;

  const lines = [
    "TrueCourse -- Course Plan",
    "Generated: " + lastPlan.generatedAt.toLocaleString(),
    "",
  ];

  if (lastPlan.student.name || lastPlan.student.degree) {
    if (lastPlan.student.name) lines.push("Student: " + lastPlan.student.name);
    if (lastPlan.student.degree) lines.push("Degree: " + lastPlan.student.degree);
    lines.push("");
  }

  lines.push("Target graduation term: " + (lastPlan.gradGoal || "not specified (Claude estimated a timeline)"));
  lines.push("Courses requested for next semester: " + lastPlan.courseLoad);
  lines.push("Preferred class times: " + (lastPlan.timePreference || "no preference"));
  lines.push(
    "Flexible/elective areas: " +
      (lastPlan.electiveScope === "extra" ? "include extra electives beyond the minimum" : "just meet the minimum required")
  );

  if (lastPlan.importedCourses.length) {
    lines.push("");
    lines.push("Courses with verified prerequisite/section details found automatically:");
    lastPlan.importedCourses.forEach((c) => {
      lines.push("  - " + (c.code || c.header || "Unknown course"));
    });
  }

  lines.push("");
  lines.push("-".repeat(40));
  lines.push("");
  lines.push(lastPlan.text);
  lines.push("");
  lines.push("-".repeat(40));
  lines.push("Generated by Claude -- a planning aid, not a registration system.");
  lines.push("Double-check with your academic advisor before registering.");

  const blob = new Blob([lines.join("\n")], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const dateStamp = lastPlan.generatedAt.toISOString().slice(0, 10);

  const link = document.createElement("a");
  link.href = url;
  link.download = "truecourse-plan-" + dateStamp + ".txt";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function restart() {
  currentAudit = null;
  courseDetails = {};
  lastPlan = null;
  el("step-results").classList.add("hidden");
  el("step-summary").classList.add("hidden");
  el("results-content").textContent = "";
  setStatus("scan-status", "");
  setStatus("recommend-status", "");
  // Clears the saved scan/plan but keeps whatever preferences are still
  // typed into the form, same as a normal "Start Over" would feel.
  saveState();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
