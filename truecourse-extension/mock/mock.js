// mock.js
// Runs on mock/degreeworks-mock.html itself (loaded as a normal <script> tag,
// not injected). This exists because of a Chrome restriction: extensions
// cannot use chrome.scripting.executeScript to inject into their own
// chrome-extension:// pages the way they can into a real http(s) page like
// a live Degree Works audit -- Chrome blocks it even with activeTab granted,
// and reports "Cannot access contents of the page." Real Degree Works pages
// don't have this problem; only our own bundled mock page does.
//
// The fix: instead of the popup injecting a scraper into this page, this
// page runs its own copy of the same scraping logic and answers requests
// from the popup over chrome.runtime messaging, which extension pages can
// always use freely. This also has the advantage of reading truly live DOM
// state (e.g. whether the course dialog is currently open), which a fetch()
// of the static HTML file would miss entirely.
//
// scrapeAuditData() intentionally mirrors scrapeDegreeWorksDOM() in
// popup/popup.js -- keep them in sync if those selectors change.
// fetchCourseDetailsBatchMock() stands in for fetchCourseDetailsBatch(),
// but can't truly mirror it since this mock page has no live backend API to
// call -- see its own comment below for what it does instead.
//
// This file also wires up the "View Details"/close buttons on the page.
// That logic used to be an inline <script> with onclick="" attributes, but
// Manifest V3's CSP for extension pages ("script-src 'self'") blocks inline
// script and inline event handlers outright -- there's no way to opt back
// into 'unsafe-inline' for extension pages, so everything has to be an
// external file with addEventListener instead.
document.addEventListener("DOMContentLoaded", () => {
  const viewBtn = document.getElementById("btn-view-course-details");
  const closeBtn = document.getElementById("btn-close-course-dialog");
  const backdrop = document.getElementById("course-dialog-backdrop");

  if (viewBtn && backdrop) {
    viewBtn.addEventListener("click", () => backdrop.classList.add("open"));
  }
  if (closeBtn && backdrop) {
    closeBtn.addEventListener("click", () => backdrop.classList.remove("open"));
  }
});

function scrapeAuditData() {
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

  // See the matching comment in scrapeDegreeWorksDOM() in popup/popup.js --
  // some rows render "Still needed:" plus a free-text description instead
  // of the normal columns.
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

  // See the matching comment in scrapeDegreeWorksDOM() in popup/popup.js --
  // some blocks render a plain-English credit-shortfall summary that's the
  // real remaining requirement, often smaller than the sum of every
  // individually-listed "needed" row.
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
          if (!parsed) return null;
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
    return { error: "No requirement blocks found on the sample page." };
  }

  return { student, blocks, scannedAt: new Date().toISOString() };
}

// Shared with scrapeDialogData() below -- reads the course-detail dialog's
// markup regardless of whether it's currently visible, since the batch
// fetch below needs to read it as a stand-in for a real API response even
// when the student hasn't opened it on screen.
function readDialogContent() {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return null;

  const h2 = dialog.querySelector("h2");
  const header = h2 ? h2.textContent.trim() : "";

  const codeMatch = header.match(/^[A-Z]{2,6}\s?\d{2,4}/);
  const code = codeMatch ? codeMatch[0].trim() : "";

  const paragraphs = Array.from(dialog.querySelectorAll("p"));
  const description = paragraphs.length ? paragraphs[0].textContent.trim() : "";

  const findAfterLabel = (labelPattern) => {
    const labelEl = paragraphs.find((p) => labelPattern.test(p.textContent.trim()));
    if (!labelEl) return "";
    const next = labelEl.nextElementSibling;
    return next ? next.textContent.trim() : "";
  };

  const prerequisites = findAfterLabel(/^prerequisites:?$/i);
  const corequisites = findAfterLabel(/^corequisites:?$/i);

  // See the matching comment in fetchCourseDetailsBatch() in
  // popup/popup.js -- some course descriptions end with a plain-English
  // offering pattern like "Offered (FALL/SPRING)".
  const offeredMatch = description.match(/offered\s*\(([^)]+)\)/i);
  const offeredTerms = offeredMatch ? offeredMatch[1].trim() : "";

  const table = dialog.querySelector("table");
  let sections = [];
  if (table) {
    const headers = Array.from(table.querySelectorAll("thead th")).map(
      (th) => th.getAttribute("data-label") || th.textContent.trim()
    );
    sections = Array.from(table.querySelectorAll("tbody tr")).map((row) => {
      const cells = Array.from(row.querySelectorAll("td"));
      const entry = {};
      cells.forEach((td, i) => {
        const key = headers[i] || "column" + i;
        entry[key] = td.textContent.trim();
      });
      return entry;
    });
  }

  return { code, header, description, prerequisites, corequisites, sections, offeredTerms };
}

function scrapeDialogData() {
  if (!document.getElementById("course-dialog-backdrop").classList.contains("open")) {
    return { error: "No course dialog is currently open on this page." };
  }
  return readDialogContent() || { error: "No course dialog is currently open on this page." };
}

// Mirrors fetchCourseDetailsBatch() in popup/popup.js, which calls Degree
// Works' real /Dashboard/api/course-link endpoint directly. The mock page
// has no live backend to call, so this can't do the same thing -- instead
// it returns the one course's data that's actually baked into this fixture
// (CS 301, see the hidden course-dialog markup below), regardless of
// whether the dialog is currently open on screen, and simply has nothing to
// return for any other code. That's an honest limitation of a static mock,
// not a bug: on a real Degree Works page every needed course gets looked
// up, not just one.
function fetchCourseDetailsBatchMock(codes) {
  const dialogContent = readDialogContent();
  const results = {};
  if (!dialogContent) return results;

  const normalize = (s) => (s || "").replace(/\s+/g, " ").trim().toUpperCase();
  const dialogCode = normalize(dialogContent.code);

  codes.forEach((rawCode) => {
    if (normalize(rawCode) === dialogCode) {
      results[rawCode] = dialogContent;
    }
  });

  return results;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "SCRAPE_AUDIT") {
    sendResponse(scrapeAuditData());
    return true;
  }
  if (message && message.type === "SCRAPE_DIALOG") {
    sendResponse(scrapeDialogData());
    return true;
  }
  if (message && message.type === "FETCH_COURSE_DETAILS_BATCH") {
    sendResponse(fetchCourseDetailsBatchMock(message.codes || []));
    return true;
  }
});
