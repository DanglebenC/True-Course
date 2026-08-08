// background.js (Manifest V3 service worker)
// Receives the scraped Degree Works audit + the student's stated
// preferences from the popup, builds a prompt, and calls the Claude API
// directly from the extension using the student's own API key.

const CLAUDE_MODEL = "claude-sonnet-5";
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "GET_RECOMMENDATION") {
    getRecommendation(message.payload)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true; // keep the message channel open for the async response
  }
});

const TIME_PREFERENCE_LABELS = {
  morning: "morning classes (before 11am)",
  midday: "midday/afternoon classes (11am-5pm)",
  evening: "evening classes (after 5pm)",
};

async function getRecommendation({ audit, gradGoal, courseLoad, timePreference, courseDetails, electiveScope }) {
  const { anthropicApiKey } = await chrome.storage.local.get("anthropicApiKey");

  if (!anthropicApiKey) {
    throw new Error(
      "No Claude API key set yet. Click \"Set Claude API key\" below to add one."
    );
  }

  const hasVerifiedPrereqs = Array.isArray(courseDetails) && courseDetails.length > 0;
  const hasGradGoal = typeof gradGoal === "string" && gradGoal.trim().length > 0;
  const hasSectionData =
    hasVerifiedPrereqs && courseDetails.some((c) => Array.isArray(c.sections) && c.sections.length > 0);
  const hasTimePreference = typeof timePreference === "string" && timePreference.length > 0;
  const timePreferenceLabel = hasTimePreference ? TIME_PREFERENCE_LABELS[timePreference] || timePreference : "";
  const wantsExtra = electiveScope === "extra";
  const hasCreditsData =
    audit &&
    Array.isArray(audit.blocks) &&
    audit.blocks.some((b) => b && b.meta && typeof b.meta.creditsStillNeeded === "number");

  const systemPrompt = [
    "You are a careful, encouraging academic advisor helping a college student plan their next semester.",
    "You are given a JSON export of their Degree Works requirement audit, scraped directly from the page: for each requirement block, a status ('complete', 'in-progress', 'needed', or 'unknown') and a list of course/requirement rows with whatever code, title, grade, credits, and term were available.",
    "Some rows have an 'options' array with more than one course code (Degree Works phrases these as e.g. 'X or Y'). That means the requirement is satisfied by completing ANY ONE of those courses, not all of them -- when recommending, pick whichever option best fits (prerequisites already done, likely offered soon, etc.) and say which alternatives exist so the student knows they have a choice. Rows with an empty or single-item 'options' array are normal, fixed requirements.",
    "Degree Works' main audit table does not expose a structured prerequisite field. Some courses may come with a separate 'verified prerequisite details' list -- these were looked up automatically, directly from Degree Works' own course data, for every course still needed, so that text is authoritative and should be trusted exactly as written (including any minimum-grade requirements). For any course this lookup couldn't reach, use standard conventions (e.g. course numbering, 'Intro to X' before 'Advanced X') and general knowledge of the subject area to reason about likely prerequisite ordering, and say so plainly when you're inferring rather than reading a verified prerequisite.",
    "The student may not have given a target graduation term -- this is common and expected for part-time students, students who've fallen behind pace, and transfer students who don't yet know how their credits will apply. Do not treat a missing target as an error or ask the student to go fill it in. Instead, estimate: count total remaining 'needed' courses/credits across all blocks, divide by the course load they specified per semester, and state a realistic number of semesters (and, if you can infer the current term from context, an approximate target term), clearly labeled as an estimate.",
    "Using ONLY rows marked 'needed' (never re-recommend anything already 'complete' or 'in-progress'), recommend a specific course list for next semester that:",
    "1. Avoids recommending a course whose prerequisites (verified or likely-inferred) aren't already complete or in-progress.",
    "2. Matches the number of courses the student asked for.",
    "3. Prioritizes courses that unlock the most future 'needed' courses (bottleneck courses), so the student doesn't stall later.",
    hasGradGoal
      ? "4. Flags anything that puts their stated target graduation term at risk, and explains briefly why."
      : "4. Since no target term was given, includes the estimated realistic timeline described above instead of a risk check.",
    "5. Notes any remaining requirement blocks that haven't been started at all ('needed' with no progress).",
    hasVerifiedPrereqs
      ? "6. Explicitly calls out which recommendations are backed by verified prerequisite data vs. inferred."
      : "",
    hasTimePreference
      ? "7. Time-of-day preference: each course's 'sections' data (if present) lists real offered sections with meeting times, looked up automatically -- when a needed course has section data, prefer or recommend a specific CRN matching the student's stated preference (" +
        timePreferenceLabel +
        "), and name the CRN and meeting time so the student can register directly. For any recommended course where the lookup found no section data (it may not be offered next term, or the lookup couldn't reach it), say plainly that no schedule data was available and the student should check section times in registration themselves. Never guess a meeting time or CRN that wasn't in the data."
      : "",
    hasCreditsData
      ? "8. Some blocks include a 'meta' object with creditsRequiredMin/creditsRequiredMax, creditsCurrent, and creditsStillNeeded -- this comes from Degree Works' own summary sentence for that block (e.g. '48 to 55 credits are required. You currently have 45, you still need 3 more credits.') and is the AUTHORITATIVE real remaining requirement for that block, not the count of 'needed' rows listed under it. Degree Works often lists more optional/elective 'needed' rows in a block than a student actually has to complete -- creditsStillNeeded is the true gap. " +
        (wantsExtra
          ? "The student said they'd like to explore extra electives beyond the minimum, so for blocks with room to choose among electives, feel free to suggest more than the minimum credits' worth when it's a good fit -- but still say plainly which courses are required to close the real gap vs. which are optional extras beyond it."
          : "The student wants to do just the minimum required, so for any block with a known creditsStillNeeded, do not recommend more courses/credits from that block than are needed to close that specific gap -- pick whichever 'needed' row(s) best fit up to that credit total (e.g. if 3 credits are still needed, that's normally one course, not three) rather than including every optional row listed. Say explicitly when you're choosing one option among several to stay within the real gap.")
      : "",
    hasVerifiedPrereqs
      ? "9. Cross-check grades against prerequisite minimums: for any course whose verified prerequisite text states a minimum grade (e.g. 'CS 102 (minimum grade C)'), check that prerequisite course's actual 'grade' field in the audit. Degree Works marks a prerequisite 'complete' the moment it's passed, regardless of grade, so a completed course with a grade below the stated minimum can be a real, easy-to-miss problem -- flag it explicitly if you find one. Don't flag anything if the prerequisite's grade is missing from the audit or clearly meets the minimum."
      : "",
    hasVerifiedPrereqs
      ? "10. Term/offering-pattern awareness: some courses' verified details include an 'offeredTerms' field (e.g. 'FALL/SPRING' or 'FALL only'), parsed from the course catalog description. Never recommend a course for a semester its offeredTerms clearly excludes. Separately, if a 'needed' course you are NOT recommending this semester has a restrictive offeredTerms pattern (Fall-only or Spring-only), call it out as something to plan around now even though it isn't due yet -- missing its one offered term can cost a full extra year, not just a semester."
      : "",
    "11. Full-time status: add up the 'credits' field (where present) of the courses you're recommending. If that total comes out below 12, note plainly that this plan would leave the student below the usual full-time enrollment threshold, which can affect financial aid, visa status, or housing eligibility depending on the school. TrueCourse can't know the student's specific situation, so frame this as something worth confirming rather than a certainty.",
    "12. Close with a short 'Questions for your advisor' section: take anything above that you inferred rather than verified, or that touches a policy or regulation you can't be fully certain about (financial aid rules, transfer credit edge cases, and similar), and rephrase it as a direct question the student can bring to their next advising appointment.",
    "Keep the response concise, organized with short headers or a simple list, and written directly to the student in a supportive tone. Do not use markdown tables.",
  ]
    .filter(Boolean)
    .join(" ");

  const userContent =
    "Degree Works audit (JSON):\n" +
    JSON.stringify(audit, null, 2) +
    (hasVerifiedPrereqs
      ? "\n\nVerified prerequisite/section details (looked up automatically from Degree Works for every needed course, JSON -- 'sections' holds real offered sections with CRNs and meeting times where available):\n" +
        JSON.stringify(courseDetails, null, 2)
      : "") +
    "\n\nStudent's target graduation term: " +
    (hasGradGoal ? gradGoal : "not given -- please estimate a realistic timeline instead") +
    "\nNumber of courses they want to take next semester: " +
    courseLoad +
    "\nPreferred class time of day: " +
    (hasTimePreference ? timePreferenceLabel : "no preference stated") +
    (hasTimePreference && !hasSectionData
      ? " (note: no section/meeting-time data could be found automatically this time, so this can't be honored for any course in this plan)"
      : "") +
    "\nFlexible/elective areas: " +
    (wantsExtra
      ? "the student wants to explore extra electives beyond the minimum where it makes sense"
      : "the student wants to just meet the minimum required -- do not exceed each block's real remaining credit gap (see meta.creditsStillNeeded where present)") +
    "\n\nRecommend their next-semester course list.";

  // Extended thinking has been the root cause of every empty-response bug
  // here -- twice now a real audit came back with stop_reason "max_tokens"
  // and the entire output spent on a thinking block, zero characters of
  // actual answer. The surprising part: this happened even after removing
  // the "thinking" parameter from the request entirely, expecting that to
  // mean thinking was off by default. It wasn't -- one logged response with
  // no "thinking" param in the request still came back with 8191 of 8192
  // output tokens spent thinking. For this model/account, thinking is
  // evidently on unless explicitly turned off, not off unless explicitly
  // turned on -- so it has to be disabled outright rather than just left
  // unmentioned. The system prompt already spells out the reasoning steps
  // explicitly (numbered instructions 1-8), so there's no real upside being
  // traded away here, and disabling it is the only way left to guarantee
  // the full token budget goes to a visible answer instead of an invisible
  // one that might not finish in time.
  const data = await callClaude(anthropicApiKey, systemPrompt, userContent, {
    max_tokens: 8192,
    thinking: { type: "disabled" },
  });
  const text = extractText(data);

  if (!text) {
    // Log the full raw response so it's inspectable from the extension's
    // service worker console (chrome://extensions -> TrueCourse ->
    // "service worker" link) without needing to reproduce the request.
    // Surface the stop_reason in the user-facing message too, since
    // "max_tokens" vs "end_turn" vs a refusal point to different fixes (an
    // even larger audit, or a different prompt).
    console.error("Claude API returned no text content:", JSON.stringify(data, null, 2));
    const reason = data.stop_reason ? " (stop_reason: " + data.stop_reason + ")" : "";
    throw new Error(
      "Claude returned no text" +
        reason +
        ". Try again -- if it keeps happening, open the extension's service worker console (chrome://extensions -> TrueCourse -> \"service worker\") to see the full API response."
    );
  }

  return { text };
}

async function callClaude(apiKey, systemPrompt, userContent, extraBody) {
  const res = await fetch(CLAUDE_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Required for calling the Claude API directly from a browser context.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
      ...extraBody,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const err = new Error("Claude API error (" + res.status + "): " + errText);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();

  // The API can return 200 OK with a body shaped like an error in some
  // edge cases (e.g. certain proxy/gateway configurations) -- catch that
  // explicitly instead of silently treating it as empty content.
  if (data.type === "error") {
    throw new Error("Claude API error: " + (data.error && data.error.message ? data.error.message : JSON.stringify(data)));
  }

  return data;
}

function extractText(data) {
  // Extended-thinking responses include a "thinking" block (with a
  // `.thinking` property, not `.text`) ahead of the real answer -- this
  // naturally skips those and only picks up actual text blocks.
  return (data.content || [])
    .map((block) => block.text || "")
    .join("\n")
    .trim();
}
