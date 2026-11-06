// =============================================================================
// Aurora Trail: browser code.
//
// The browser never talks to Claude and never sees the API key. It calls
// our own Netlify Function at /api/story, one pipeline step at a time, and
// shows the child the result. The order of the pipeline lives in
// runPipeline() below:
//
//   STEP 1 INPUT        the setup form (readForm) + server-side validation
//   STEP 2 GENERATION   action "generate": Claude writes the chapter
//   STEP 3 READABILITY  every generate/rewrite response carries the measured
//                       grade level; STEP 3b asks for one fix if it missed
//   STEP 4 VOCABULARY   stretch words come back checked; renderStory() turns
//                       them into tappable words with definitions
//   STEP 5 ADAPT        "Make it easier" / "Challenge me" rewrite the chapter
//                       one level down or up
//   STEP 6 SAFETY       action "safety": word rules + a Claude classifier;
//                       nothing is shown until it passes
// =============================================================================

// Labels only; the targets themselves live in shared/nlp.js on the server.
const LEVELS = [
  { id: "k1", label: "K–1", name: "Beginning reader" },
  { id: "g23", label: "Grades 2–3", name: "Early reader" },
  { id: "g45", label: "Grades 4–5", name: "Growing reader" },
  { id: "g68", label: "Grades 6–8", name: "Strong reader" },
  { id: "g912", label: "Grades 9–12", name: "Advanced reader" },
];
const AGES = [5, 6, 7, 8, 9, 10];
const PRESET_INTERESTS = ["Animals", "Space", "Mysteries", "Dinosaurs", "Magic forests", "Oceans", "Robots", "Mythology", "Sports", "Music"];
const MAX_INTERESTS = 3;
const MAX_ADAPTS_PER_STORY = 8; // keeps API spend per story bounded
const REQUEST_TIMEOUT_MS = 60_000;

// Reader controls in the story's language.
const READER_TEXT = {
  en: { easier: "Make it easier", harder: "Challenge me", hint: "Tap a gold word to learn it", chapter: "Chapter 1", newWord: "New word", gotIt: "Got it", free: "Free chapter" },
  es: { easier: "Más fácil", harder: "Rétame", hint: "Toca una palabra dorada para aprenderla", chapter: "Capítulo 1", newWord: "Palabra nueva", gotIt: "¡Entendido!", free: "Capítulo gratis" },
};

const $ = (id) => document.getElementById(id);

const state = {
  form: { age: null, level: null, language: "en", interests: [] },
  profile: null,   // the validated profile used for the current story
  current: null,   // { chapter, analysis, ... } as returned by the function
  log: null,       // pipeline record shown in "How this chapter was made"
  adapts: 0,
  busy: false,
};

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function store(key, value) {
  try { localStorage.setItem(`aurora.${key}`, value); } catch { /* storage may be blocked */ }
}
function recall(key) {
  try { return localStorage.getItem(`aurora.${key}`); } catch { return null; }
}

function showView(name) {
  for (const v of ["setup", "working", "reader"]) $(`view-${v}`).hidden = v !== name;
  window.scrollTo({ top: 0 });
}

function showError(id, message) {
  const box = $(id);
  box.textContent = message;
  box.hidden = !message;
}

// -----------------------------------------------------------------------------
// Theme and reading comfort (persisted per device)
// -----------------------------------------------------------------------------
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll("[data-theme-choice]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.themeChoice === theme));
  });
  store("theme", theme);
}

function setStorySize(px) {
  const size = Math.max(18, Math.min(32, px));
  document.documentElement.style.setProperty("--story-size", `${size}px`);
  store("size", String(size));
}
function currentStorySize() {
  return parseInt(getComputedStyle(document.documentElement).getPropertyValue("--story-size"), 10) || 22;
}

function setEasyFont(on) {
  document.documentElement.dataset.easy = String(on);
  $("easy-font").setAttribute("aria-pressed", String(on));
  store("easy", String(on));
}

// =============================================================================
// STEP 1 INPUT: build and read the setup form.
// =============================================================================
function chip(label, pressed, onclick, sub) {
  return el("button", { type: "button", class: "chip", "aria-pressed": String(pressed), onclick },
    label, sub ? el("small", { text: sub }) : null);
}

function renderForm() {
  const f = state.form;
  $("age-chips").replaceChildren(...AGES.map((a) =>
    chip(String(a), f.age === a, () => { f.age = a; renderForm(); })));

  const allInterests = [...new Set([...PRESET_INTERESTS, ...f.interests])];
  $("interest-chips").replaceChildren(...allInterests.map((i) =>
    chip(i, f.interests.includes(i), () => toggleInterest(i))));

  $("level-chips").replaceChildren(...LEVELS.map((l) =>
    chip(l.label, f.level === l.id, () => { f.level = l.id; renderForm(); }, l.name)));

  $("language-chips").replaceChildren(
    chip("English", f.language === "en", () => { f.language = "en"; renderForm(); }),
    chip("Español", f.language === "es", () => { f.language = "es"; renderForm(); }),
  );
}

function toggleInterest(name) {
  const list = state.form.interests;
  const i = list.indexOf(name);
  if (i >= 0) list.splice(i, 1);
  else if (list.length < MAX_INTERESTS) list.push(name);
  else { showError("form-error", `You can pick up to ${MAX_INTERESTS}. Tap one to remove it first.`); return; }
  showError("form-error", "");
  renderForm();
}

function addCustomInterest() {
  const input = $("custom-interest");
  const value = input.value.trim().replace(/\s+/g, " ");
  if (!value) return;
  if (!/^[\p{L}\p{M}0-9][\p{L}\p{M}0-9 '’&,-]{0,29}$/u.test(value)) {
    showError("form-error", "Interests can use letters and numbers only (up to 30).");
    return;
  }
  input.value = "";
  if (!state.form.interests.includes(value)) toggleInterest(value);
}

// Returns a profile, or shows a friendly message and returns null.
// The server checks everything again (shared/nlp.js validateProfile).
function readForm() {
  const form = $("setup-form");
  const name = form.elements.name.value.trim().replace(/\s+/g, " ");
  const companion = form.elements.companion.value.trim().replace(/\s+/g, " ");
  const f = state.form;
  let error = "";
  if (!/^[\p{L}\p{M}][\p{L}\p{M} '’.-]{0,29}$/u.test(name)) error = "Please type the hero's first name (letters only).";
  else if (!f.age) error = "Please pick an age.";
  else if (f.interests.length === 0) error = "Pick at least one thing they love.";
  else if (!f.level) error = "Please pick a reading level.";
  showError("form-error", error);
  if (error) return null;
  return { name, companion, age: f.age, interests: [...f.interests], level: f.level, language: f.language };
}

// -----------------------------------------------------------------------------
// Talking to our Netlify Function
// -----------------------------------------------------------------------------
async function callStory(action, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch("/api/story", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
      signal: controller.signal,
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON error page */ }
    if (!res.ok || !data?.ok) {
      const fallback = res.status === 404
        ? "The story service isn't running. If you're testing locally, start it with `netlify dev`."
        : "Something went wrong. Please try again.";
      throw new Error(data?.error || fallback);
    }
    return data;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("The story took too long. Please try again.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// Progress list while the pipeline runs
// -----------------------------------------------------------------------------
const STEP_LABELS = {
  input: "Step 1 · Checking the hero's details",
  generate: "Step 2 · Claude writes the chapter",
  adapt: "Step 5 · Claude rewrites it at the new level",
  readability: "Step 3 · Measuring the reading level",
  fix: "Step 3b · Self-check: fixing the level if needed",
  vocabulary: "Step 4 · Choosing new words to learn",
  safety: "Step 6 · Safety check for this age",
};

function startProgress(title, keys) {
  $("working-title").textContent = title;
  $("working-steps").replaceChildren(...keys.map((k) => el("li", { "data-step": k, text: STEP_LABELS[k] })));
  showView("working");
}
function markStep(key, status) {
  const li = $("working-steps").querySelector(`[data-step="${key}"]`);
  if (li) li.className = status;
}

// =============================================================================
// The pipeline. `kind` is "generate" (new story) or "easier"/"harder" (adapt).
// =============================================================================
async function runPipeline(kind) {
  if (state.busy) return;
  state.busy = true;
  const isAdapt = kind !== "generate";
  const first = isAdapt ? "adapt" : "generate";
  startProgress(isAdapt ? "Rewriting your chapter…" : "Writing your story…",
    ["input", first, "readability", "fix", "vocabulary", "safety"]);

  const log = {
    kind,
    startLevel: state.profile.level,
    drafts: [],
    fixFeedback: [],
    safety: [],
    previous: isAdapt ? state.current : null,
  };

  try {
    // STEP 1 INPUT: the server validates the profile on every call.
    markStep("input", "done");

    // STEP 2 GENERATION or STEP 5 ADAPT: one Claude call.
    markStep(first, "active");
    let result = isAdapt
      ? await callStory("rewrite", { profile: state.profile, chapter: state.current.chapter, reason: kind })
      : await callStory("generate", { profile: state.profile });
    let profile = { ...state.profile, level: result.level || state.profile.level };
    log.drafts.push(result);
    markStep(first, "done");

    // STEP 3 READABILITY: the response already carries the measurement.
    markStep("readability", "done");

    // STEP 3b SELF-CHECK & FIX: one rewrite if the level, length or word
    // rules missed. Keep whichever draft is closer to the target.
    markStep("fix", "active");
    if (result.feedback.length > 0 || !result.ruleSafety.safe) {
      const fixed = await callStory("rewrite", { profile, chapter: result.chapter, reason: "fix" });
      log.drafts.push(fixed);
      log.fixFeedback = fixed.fixFeedback || [];
      if (isBetter(fixed, result)) result = fixed;
    }
    markStep("fix", "done");

    // STEP 4 VOCABULARY: the stretch words were checked on the server.
    markStep("vocabulary", "done");

    // STEP 6 SAFETY: nothing is shown until both safety layers pass.
    markStep("safety", "active");
    let safety = await callStory("safety", { profile, chapter: result.chapter });
    log.safety.push(safety);
    if (!safety.safe) {
      // One safer rewrite, then check again.
      const safer = await callStory("rewrite", { profile, chapter: result.chapter, reason: "fix", safetyConcerns: true });
      log.drafts.push(safer);
      safety = await callStory("safety", { profile, chapter: safer.chapter });
      log.safety.push(safety);
      if (!safety.safe) throw new Error("We couldn't write a chapter that's right for this age. Please try different interests.");
      result = safer;
    }
    markStep("safety", "done");

    state.profile = profile;
    state.current = result;
    state.log = log;
    if (isAdapt) state.adapts += 1;
    renderReader();
    showView("reader");
  } catch (err) {
    document.querySelectorAll("#working-steps li.active").forEach((li) => { li.className = "failed"; });
    if (isAdapt) {
      showView("reader");
      showError("reader-error", err.message);
    } else {
      showView("setup");
      showError("form-error", err.message);
    }
  } finally {
    state.busy = false;
  }
}

// A draft is better if it passes the word rules and is closer to the level.
function isBetter(a, b) {
  if (a.ruleSafety.safe !== b.ruleSafety.safe) return a.ruleSafety.safe;
  if (a.analysis.distance !== b.analysis.distance) return a.analysis.distance < b.analysis.distance;
  return a.analysis.lengthOk && !b.analysis.lengthOk;
}

// =============================================================================
// Reader rendering
// =============================================================================
const WORD_RE = /[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu;

// STEP 4 VOCABULARY (display): wrap the first use of each stretch word in a
// button. Text is added with text nodes only, never as HTML.
function renderStory(chapter) {
  const lookup = new Map(chapter.stretchWords.map((w) => [w.word.toLowerCase(), w]));
  const used = new Set();
  const paragraphs = chapter.paragraphs.map((text) => {
    const p = el("p");
    let last = 0;
    for (const match of text.matchAll(WORD_RE)) {
      const key = match[0].toLowerCase();
      const info = lookup.get(key);
      if (!info || used.has(key)) continue;
      used.add(key);
      if (match.index > last) p.append(text.slice(last, match.index));
      p.append(el("button", {
        type: "button",
        class: "stretch",
        "aria-expanded": "false",
        "aria-controls": "word-card",
        "aria-label": `${match[0]}, new word. Tap to hear what it means.`,
        onclick: (e) => showWord(info, e.currentTarget),
        text: match[0],
      }));
      last = match.index + match[0].length;
    }
    if (last < text.length) p.append(text.slice(last));
    return p;
  });
  $("story-text").replaceChildren(...paragraphs);
}

function showWord(info, button) {
  document.querySelectorAll(".stretch[aria-expanded='true']").forEach((b) => b.setAttribute("aria-expanded", "false"));
  button.setAttribute("aria-expanded", "true");
  $("word-card-word").textContent = info.word;
  $("word-card-pos").textContent = info.partOfSpeech;
  $("word-card-def").textContent = info.definition;
  $("word-card").hidden = false;
  $("word-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideWord() {
  $("word-card").hidden = true;
  document.querySelectorAll(".stretch[aria-expanded='true']").forEach((b) => b.setAttribute("aria-expanded", "false"));
}

function levelInfo(id) {
  return LEVELS.find((l) => l.id === id);
}

function statusLabel(status) {
  return { "on-target": "On target", close: "Within 1 grade", off: "Off target" }[status] || status;
}

function stat(k, v) {
  return el("div", { class: "stat" }, el("div", { class: "k", text: k }), el("div", { class: "v", text: v }));
}

function renderStats() {
  const { analysis, chapter } = state.current;
  const level = levelInfo(state.profile.level);
  const band = analysis.level.gradeMin < 0 ? `≤ ${analysis.level.gradeMax}` : `${analysis.level.gradeMin}–${analysis.level.gradeMax}`;
  $("chapter-stats").replaceChildren(
    el("h3", { text: "This chapter" }),
    el("p", {}, el("span", { class: `status ${analysis.status}`, text: statusLabel(analysis.status) })),
    el("div", { class: "stat-grid" },
      stat("Target level", level.label),
      stat("Measured grade", `${analysis.grade}`),
      stat("Target grade", band),
      stat("Reading ease", `${analysis.ease} / 100`),
      stat("Words", `${analysis.wordCount}`),
      stat("Words / sentence", `${analysis.wordsPerSentence}`),
    ),
    el("p", { class: "hint", text: `Scored with ${analysis.formula}. Content maturity: age ${state.profile.age} · locked.` }),
    el("h3", { text: "New words" }),
    chapter.stretchWords.length
      ? el("div", { class: "word-list" }, chapter.stretchWords.map((w) => el("span", { text: w.word })))
      : el("p", { class: "hint", text: "No new words this time." }),
  );
}

// "How this chapter was made": the evidence for each pipeline step.
function renderPipeline() {
  const log = state.log;
  const p = state.profile;
  const drafts = log.drafts;
  const final = state.current;
  const steps = [];

  steps.push(section("Step 1 · Input", [
    el("p", { text: `${p.name}, age ${p.age}${p.companion ? `, with ${p.companion}` : ""}. Loves ${p.interests.join(", ")}.` }),
    el("p", { text: `Reading level ${levelInfo(log.startLevel).label} · ${p.language === "es" ? "Español" : "English"}. Checked in the browser and again on the server.` }),
  ]));

  if (log.kind === "generate") {
    steps.push(section("Step 2 · Generation", [
      el("p", { text: `Claude (${drafts[0].model}) wrote the chapter as structured JSON: title, paragraphs, stretch words. Took ${(drafts[0].ms / 1000).toFixed(1)} s.` }),
    ]));
  } else {
    const before = log.previous;
    steps.push(section(`Step 5 · Adapt (${log.kind === "easier" ? "Make it easier" : "Challenge me"})`, [
      el("p", { text: `Level ${levelInfo(log.startLevel).label} → ${levelInfo(p.level).label}. Claude kept the plot and names and rewrote sentence length and word choice.` }),
      el("p", { text: `Measured grade ${before.analysis.grade} → ${final.analysis.grade}.` }),
    ]));
  }

  // STEP 3 table: one column per draft.
  const head = ["Measure", "Target", ...drafts.map((_, i) => (i === 0 ? "Draft 1" : `Fix ${i}`))];
  const lv = final.analysis.level;
  const rows = [
    ["Grade level", lv.gradeMin < 0 ? `≤ ${lv.gradeMax}` : `${lv.gradeMin}–${lv.gradeMax}`, (a) => a.grade],
    ["Words / sentence", `${lv.wps[0]}–${lv.wps[1]}`, (a) => a.wordsPerSentence],
    ["Syllables / word", "", (a) => a.syllablesPerWord],
    ["Long words (3+ syl.)", "", (a) => `${a.longWordShare}%`],
    ["Length (words)", `${lv.words[0]}–${lv.words[1]}`, (a) => a.wordCount],
    ["Status", "on target", (a) => statusLabel(a.status)],
  ];
  steps.push(section("Step 3 · Readability", [
    el("p", { text: `${final.analysis.formula}. ${p.language === "es" ? "Spanish syllables follow diphthong and hiatus rules (bos·que, rí·o)." : "Grade = 0.39 × words/sentence + 11.8 × syllables/word − 15.59."}` }),
    el("table", { class: "ptable" },
      el("thead", {}, el("tr", {}, head.map((h) => el("th", { text: h })))),
      el("tbody", {}, rows.map(([name, target, get]) =>
        el("tr", {}, el("td", { text: name }), el("td", { text: target }), drafts.map((d) => el("td", { text: String(get(d.analysis)) }))))),
    ),
    log.fixFeedback.length
      ? el("div", {}, el("p", { text: "Step 3b · Self-check sent these fix instructions:" }), el("ul", {}, log.fixFeedback.map((t) => el("li", { text: t }))))
      : el("p", { text: "Step 3b · Self-check: no fix needed." }),
  ]));

  steps.push(section("Step 4 · Vocabulary", [
    el("p", { text: "Claude suggested stretch words with child-friendly definitions; the server kept only words found in the tokenized text (and never the hero's name)." }),
    el("ul", {}, final.chapter.stretchWords.map((w) => el("li", { text: `${w.word} (${w.partOfSpeech}, ${w.syllables} syl.): ${w.definition}` }))),
  ]));

  const s = log.safety[log.safety.length - 1];
  steps.push(section("Step 6 · Safety", [
    el("p", {}, "Word rules: ", el("span", { class: `status ${s.rules.safe ? "pass" : "fail"}`, text: s.rules.safe ? "pass" : `flagged: ${s.rules.flagged.join(", ")}` })),
    el("p", {}, `Claude reviewer (age ${p.age}): `, el("span", { class: `status ${s.classifier.suitable ? "pass" : "fail"}`, text: s.classifier.suitable ? "suitable" : "not suitable" })),
    s.classifier.concerns.length ? el("ul", {}, s.classifier.concerns.map((c) => el("li", { text: c }))) : null,
    log.safety.length > 1 ? el("p", { text: "The first draft failed review, so it was rewritten more gently and checked again." }) : null,
  ]));

  $("pipeline-body").replaceChildren(...steps);
}

function section(title, children) {
  return el("div", { class: "pipeline-step" }, el("h4", { text: title }), children);
}

function renderReader() {
  const { chapter } = state.current;
  const t = READER_TEXT[state.profile.language];
  hideWord();
  showError("reader-error", "");
  document.documentElement.lang = state.profile.language;
  $("free-badge").textContent = t.free;
  $("chapter-kicker").textContent = `${t.chapter} · ${levelInfo(state.profile.level).label}`;
  $("chapter-title").textContent = chapter.title;
  renderStory(chapter);
  $("word-card-kicker").textContent = t.newWord;
  $("word-card-close").textContent = t.gotIt;
  $("btn-easier").textContent = t.easier;
  $("btn-harder").textContent = t.harder;
  $("adapt-hint").textContent = chapter.stretchWords.length ? t.hint : "";

  const i = LEVELS.findIndex((l) => l.id === state.profile.level);
  const limit = state.adapts >= MAX_ADAPTS_PER_STORY;
  $("btn-easier").disabled = i === 0 || limit;
  $("btn-harder").disabled = i === LEVELS.length - 1 || limit;
  if (limit) $("adapt-hint").textContent = "You've changed the level a lot. Start a new story to keep going.";

  renderStats();
  renderPipeline();
}

// =============================================================================
// Wire everything up
// =============================================================================
function init() {
  setTheme(recall("theme") === "bedtime" ? "bedtime" : "day");
  const size = parseInt(recall("size"), 10);
  if (size) setStorySize(size);
  setEasyFont(recall("easy") === "true");

  document.querySelectorAll("[data-theme-choice]").forEach((b) =>
    b.addEventListener("click", () => setTheme(b.dataset.themeChoice)));
  $("font-down").addEventListener("click", () => setStorySize(currentStorySize() - 2));
  $("font-up").addEventListener("click", () => setStorySize(currentStorySize() + 2));
  $("easy-font").addEventListener("click", () => setEasyFont(document.documentElement.dataset.easy !== "true"));

  renderForm();
  $("add-interest").addEventListener("click", addCustomInterest);
  $("custom-interest").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addCustomInterest(); }
  });

  $("setup-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const profile = readForm();
    if (!profile) return;
    state.profile = profile;
    state.adapts = 0;
    runPipeline("generate");
  });

  $("btn-easier").addEventListener("click", () => runPipeline("easier"));
  $("btn-harder").addEventListener("click", () => runPipeline("harder"));
  $("word-card-close").addEventListener("click", hideWord);
  $("btn-new").addEventListener("click", () => {
    document.documentElement.lang = "en";
    showView("setup");
  });
}

init();
