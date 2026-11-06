// =============================================================================
// Aurora Trail: the deterministic NLP toolkit.
//
// Everything in this file is plain JavaScript with no AI calls, so every
// number it produces can be reproduced by hand and unit-tested
// (see tests/nlp.test.js). The Netlify Function (netlify/functions/story.mjs)
// imports it to measure and check each chapter Claude writes.
//
// Pipeline steps that live here (numbering matches the project brief):
//   STEP 1  INPUT        validateProfile(): clean and check the form data
//   STEP 3  READABILITY  analyzeText(): tokenize, count syllables, score the
//                        grade level (Flesch-Kincaid for English, Crawford for
//                        Spanish) and compare it with the chosen level
//   STEP 3b SELF-CHECK   buildFixFeedback(): turn a missed target into
//                        concrete rewrite instructions for Claude
//   STEP 4  VOCABULARY   selectStretchWords(): keep only stretch words that
//                        really appear in the text, with a definition
//   STEP 5  ADAPT        shiftLevel(): move one reading level down or up
//   STEP 6  SAFETY       ruleBasedSafety(): word-list screen by age, the
//                        first of two safety layers (the second is a Claude
//                        classifier in the function)
// =============================================================================

// -----------------------------------------------------------------------------
// Reading levels and their measurable targets.
//
// gradeMin/gradeMax: the band the readability score should land in.
// words:  chapter length range (word count).
// wps:    target average words per sentence; used in the prompt and in the
//         self-check feedback.
// stretch: how many "new" vocabulary words to teach at this level.
// -----------------------------------------------------------------------------
export const LEVELS = [
  { id: "k1",   label: "K–1",        name: "Beginning reader",  gradeMin: -5,  gradeMax: 2,  words: [60, 130],  wps: [4, 8],   stretch: 2 },
  { id: "g23",  label: "Grades 2–3", name: "Early reader",      gradeMin: 2,   gradeMax: 4,  words: [120, 230], wps: [7, 10],  stretch: 3 },
  { id: "g45",  label: "Grades 4–5", name: "Growing reader",    gradeMin: 4,   gradeMax: 6,  words: [180, 300], wps: [9, 13],  stretch: 3 },
  { id: "g68",  label: "Grades 6–8", name: "Strong reader",     gradeMin: 6,   gradeMax: 9,  words: [220, 360], wps: [12, 16], stretch: 4 },
  { id: "g912", label: "Grades 9–12", name: "Advanced reader",  gradeMin: 9,   gradeMax: 13, words: [260, 420], wps: [15, 20], stretch: 4 },
];

export const AGES = [5, 6, 7, 8, 9, 10];
export const LANGUAGES = ["en", "es"];
export const MAX_INTERESTS = 3;

export function getLevel(id) {
  return LEVELS.find((l) => l.id === id) || null;
}

// Content maturity is set by AGE, never by reading level. A gifted 6-year-old
// reading at grade 6 still gets stories suitable for a 6-year-old.
export function maturityRules(age) {
  if (age <= 6) {
    return "Very gentle. Problems are small and solved kindly. No scary creatures, no peril, no one gets hurt, no death, no villains who frighten.";
  }
  if (age <= 8) {
    return "Gentle adventure. Mild suspense is fine (a lost map, a storm, a puzzle) but nothing frightening. No injury, death, weapons or cruelty.";
  }
  return "Adventure with mild peril and real challenges is fine, but no gore, no death on the page, no weapons used against anyone, no romance, no cruelty.";
}

// =============================================================================
// STEP 1  INPUT: validate and normalize the child's profile.
// Runs on the server even though the form also checks it, because a browser
// can send anything. Returns { ok, profile } or { ok: false, error }.
// =============================================================================
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} '’.-]{0,29}$/u;
const INTEREST_RE = /^[\p{L}\p{M}0-9][\p{L}\p{M}0-9 '’&,-]{0,29}$/u;

export function validateProfile(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Missing profile." };

  const name = String(raw.name ?? "").trim().replace(/\s+/g, " ");
  if (!NAME_RE.test(name)) {
    return { ok: false, error: "Please enter a first name using letters only (up to 30)." };
  }

  const age = Number(raw.age);
  if (!AGES.includes(age)) return { ok: false, error: "Age must be between 5 and 10." };

  const level = getLevel(raw.level);
  if (!level) return { ok: false, error: "Please pick a reading level." };

  const language = LANGUAGES.includes(raw.language) ? raw.language : null;
  if (!language) return { ok: false, error: "Language must be English or Spanish." };

  const interestsIn = Array.isArray(raw.interests) ? raw.interests : [];
  const interests = [...new Set(interestsIn.map((s) => String(s).trim().replace(/\s+/g, " ")))]
    .filter(Boolean);
  if (interests.length === 0) return { ok: false, error: "Pick at least one interest." };
  if (interests.length > MAX_INTERESTS) return { ok: false, error: `Pick up to ${MAX_INTERESTS} interests.` };
  if (!interests.every((s) => INTEREST_RE.test(s))) {
    return { ok: false, error: "Interests can use letters and numbers only (up to 30 each)." };
  }

  const companion = String(raw.companion ?? "").trim().replace(/\s+/g, " ");
  if (companion && !INTEREST_RE.test(companion)) {
    return { ok: false, error: "Companion can use letters and numbers only (up to 30)." };
  }

  // The child's own words are screened too (STEP 6 rules), so an unsuitable
  // interest never reaches the story prompt.
  const inputCheck = ruleBasedSafety([name, companion, ...interests].join(" "), age, language);
  if (!inputCheck.safe) {
    return { ok: false, error: "Let's pick different interests for this story." };
  }

  return { ok: true, profile: { name, age, level: level.id, language, interests, companion } };
}

// =============================================================================
// Tokenization (shared by STEPS 3, 4 and 6).
// =============================================================================

// A "word" is a run of letters, optionally joined by an apostrophe or hyphen
// (don't, well-known). Numbers and punctuation are not words.
const WORD_RE = /[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu;

export function tokenizeWords(text) {
  return String(text).match(WORD_RE) || [];
}

// Abbreviations that end in a period but do not end a sentence.
const ABBREVIATIONS = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Sra|Srta|St|Jr|vs|etc|e\.g|i\.e)\.$/i;

// Split text into sentences at . ! ? … (plus any closing quotes), keeping
// abbreviations like "Dr." together. Works for Spanish ¿…? and ¡…! too.
export function splitSentences(text) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const parts = clean.split(/(?<=[.!?…]["'”’»)]*)\s+(?=["'“‘«(¿¡—\-]*[\p{Lu}\p{N}¿¡"“«—])/u);
  const sentences = [];
  for (const part of parts) {
    const prev = sentences[sentences.length - 1];
    if (prev && ABBREVIATIONS.test(prev)) sentences[sentences.length - 1] = `${prev} ${part}`;
    else sentences.push(part);
  }
  // A "sentence" with no words (stray punctuation) is not counted.
  return sentences.filter((s) => tokenizeWords(s).length > 0);
}

// =============================================================================
// Syllable counting.
// =============================================================================

// English has no exact spelling-to-syllable rule, so this is the standard
// vowel-group heuristic with the usual corrections, plus a small exception
// list. It is accurate enough for readability formulas, which average over
// hundreds of words.
const EN_EXCEPTIONS = {
  the: 1, every: 3, everything: 4, everyone: 4, different: 3, family: 3,
  beautiful: 3, favorite: 3, people: 2, little: 2, idea: 3, area: 3,
  lion: 2, quiet: 2, science: 2, poem: 2, being: 2, create: 2, created: 3,
  orange: 2, business: 2, chocolate: 3, camera: 3, animal: 3, animals: 3,
  ocean: 2, ancient: 2, dinosaur: 3, dinosaurs: 3, video: 3, radio: 3,
  giant: 2, piano: 3, museum: 3, cereal: 3, real: 1, really: 2, fire: 1,
  hour: 1, our: 1, flower: 2, power: 2, tower: 2, wednesday: 2, said: 1,
  says: 1, were: 1, there: 1, where: 1, here: 1, whale: 1, smile: 1,
  hypothesis: 4, curious: 3, mysterious: 4, peculiar: 3, observe: 2,
};

export function countSyllablesEn(word) {
  let w = word.toLowerCase().replace(/[’']/g, "").replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (EN_EXCEPTIONS[w]) return EN_EXCEPTIONS[w];
  if (w.length <= 3) return 1;
  // Silent endings: "-es"/"-e" after a consonant (but keep "-le" as in
  // "table"), and "-ed" except after t/d ("jumped" = 1, "wanted" = 2).
  w = w.replace(/(?:[^laeiouy]es|[^laeiouytd]ed|[^laeiouy]e)$/, "");
  w = w.replace(/^y/, ""); // initial y is a consonant ("yellow")
  const groups = w.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

// Spanish spelling is regular, so syllables can be counted from vowel nuclei.
// Strong vowels: a e o (and accented á é ó, plus accented í ú, which break a
// diphthong). Weak vowels: i u ü. Two vowels side by side form ONE syllable
// (a diphthong) unless both are strong, or one is an accented í/ú next to a
// strong vowel: that is a hiatus, which makes TWO syllables.
//   bos·que (2), rí·o (2), cie·lo (2), le·ón (2), hoy (1)
const ES_STRONG = new Set(["a", "e", "o", "á", "é", "ó", "í", "ú"]);
const ES_VOWELS = new Set(["a", "e", "i", "o", "u", "á", "é", "í", "ó", "ú", "ü"]);

export function countSyllablesEs(word) {
  let w = word.toLowerCase().replace(/[^a-záéíóúüñ]/g, "");
  if (!w) return 0;
  // "y" at the end of a word is a vowel sound (hoy, muy, rey).
  if (w.endsWith("y")) w = `${w.slice(0, -1)}i`;
  // The "u" in que/qui/gue/gui is silent: drop it so it does not form a vowel pair.
  w = w.replace(/([qg])u([eiéí])/g, "$1$2");

  let syllables = 0;
  let prev = null; // previous character if it was a vowel
  for (const ch of w) {
    if (!ES_VOWELS.has(ch)) { prev = null; continue; }
    if (prev === null) {
      syllables += 1; // start of a new vowel nucleus
    } else if (ES_STRONG.has(prev) && ES_STRONG.has(ch)) {
      syllables += 1; // hiatus: two strong vowels (le·ón, rí·o)
    }
    prev = ch;
  }
  return Math.max(1, syllables);
}

export function countSyllables(word, language) {
  return language === "es" ? countSyllablesEs(word) : countSyllablesEn(word);
}

// =============================================================================
// STEP 3  READABILITY: score a chapter and compare it with the target level.
// =============================================================================

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

export function readabilityStats(text, language) {
  const sentences = splitSentences(text);
  const words = tokenizeWords(text);
  const syllableCounts = words.map((w) => countSyllables(w, language));
  const syllables = syllableCounts.reduce((a, b) => a + b, 0);
  const wordCount = words.length;
  const sentenceCount = Math.max(1, sentences.length);
  const wordsPerSentence = wordCount / sentenceCount;
  const syllablesPerWord = wordCount ? syllables / wordCount : 0;
  const longWords = syllableCounts.filter((n) => n >= 3).length;

  let grade;
  let ease;
  let formula;
  if (language === "es") {
    // Crawford (1984): a grade-level formula built for Spanish primary texts.
    //   grade = -0.205·OP + 0.049·SP - 3.407
    //   OP = sentences per 100 words, SP = syllables per 100 words
    const OP = (sentenceCount / Math.max(1, wordCount)) * 100;
    const SP = syllablesPerWord * 100;
    grade = -0.205 * OP + 0.049 * SP - 3.407;
    // Fernández Huerta (1959): Spanish reading ease, 0–100 (higher = easier).
    //   L = 206.84 - 0.60·P - 1.02·F
    //   P = syllables per 100 words, F = sentences per 100 words
    ease = 206.84 - 0.6 * SP - 1.02 * OP;
    formula = "Crawford grade · Fernández Huerta ease";
  } else {
    // Flesch-Kincaid Grade Level (Kincaid et al., 1975):
    //   grade = 0.39·(words/sentences) + 11.8·(syllables/words) - 15.59
    grade = 0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59;
    // Flesch Reading Ease (1948): 0–100, higher = easier.
    ease = 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord;
    formula = "Flesch-Kincaid grade · Flesch reading ease";
  }

  return {
    formula,
    grade: round1(grade),
    ease: Math.round(Math.max(0, Math.min(100, ease))),
    wordCount,
    sentenceCount: sentences.length,
    wordsPerSentence: round1(wordsPerSentence),
    syllablesPerWord: round2(syllablesPerWord),
    longWordShare: wordCount ? round1((longWords / wordCount) * 100) : 0, // % of words with 3+ syllables
  };
}

// "on-target": inside the level's band.
// "close":     within 1 grade of the band (a normal measurement wobble).
// "off":       further away; the self-check (STEP 3b) asks for a rewrite.
export function levelStatus(grade, level) {
  if (grade >= level.gradeMin && grade <= level.gradeMax) return "on-target";
  const distance = grade < level.gradeMin ? level.gradeMin - grade : grade - level.gradeMax;
  return distance <= 1 ? "close" : "off";
}

export function gradeDistance(grade, level) {
  if (grade < level.gradeMin) return level.gradeMin - grade;
  if (grade > level.gradeMax) return grade - level.gradeMax;
  return 0;
}

export function chapterText(chapter) {
  return (chapter.paragraphs || []).join("\n\n");
}

// The full analysis returned to the browser for every chapter.
export function analyzeChapter(chapter, profile) {
  const level = getLevel(profile.level);
  const stats = readabilityStats(chapterText(chapter), profile.language);
  const status = levelStatus(stats.grade, level);
  const lengthOk = stats.wordCount >= level.words[0] * 0.8 && stats.wordCount <= level.words[1] * 1.25;
  return {
    ...stats,
    level: { id: level.id, label: level.label, gradeMin: level.gradeMin, gradeMax: level.gradeMax, words: level.words, wps: level.wps },
    status,
    distance: round1(gradeDistance(stats.grade, level)),
    lengthOk,
  };
}

// =============================================================================
// STEP 3b  SELF-CHECK & FIX: explain to Claude what to change, in numbers.
// Returns [] when the chapter already fits.
// =============================================================================
export function buildFixFeedback(analysis) {
  const tips = [];
  const { level } = analysis;
  const targetWps = (level.wps[0] + level.wps[1]) / 2;
  if (analysis.status !== "on-target") {
    const band = level.gradeMin < 0 ? `at or below grade ${level.gradeMax}` : `between grade ${level.gradeMin} and ${level.gradeMax}`;
    tips.push(`The measured reading level is grade ${analysis.grade}; it must be ${band}.`);
    if (analysis.grade > level.gradeMax) {
      if (analysis.wordsPerSentence > level.wps[1]) {
        tips.push(`Sentences average ${analysis.wordsPerSentence} words. Split them so they average about ${Math.round(targetWps)} words.`);
      }
      tips.push(`Replace long words (3+ syllables, now ${analysis.longWordShare}% of words) with shorter everyday words, except the stretch words.`);
    } else {
      if (analysis.wordsPerSentence < level.wps[0]) {
        tips.push(`Sentences average ${analysis.wordsPerSentence} words. Combine some so they average about ${Math.round(targetWps)} words.`);
      }
      tips.push("Use richer, more precise vocabulary and some longer sentences with joining words (because, although, while).");
    }
  }
  if (!analysis.lengthOk) {
    tips.push(`The chapter has ${analysis.wordCount} words; aim for ${level.words[0]}–${level.words[1]}.`);
  }
  return tips;
}

// =============================================================================
// STEP 4  VOCABULARY: keep only stretch words that are really in the text.
// Claude suggests the words and child-friendly definitions; this code checks
// each suggestion against the tokenized chapter so the reader never sees a
// tappable word that is not on the page, and removes duplicates.
// =============================================================================
export function selectStretchWords(candidates, chapter, profile) {
  const level = getLevel(profile.level);
  const tokens = new Set(tokenizeWords(chapterText(chapter)).map((t) => t.toLowerCase()));
  const childNames = new Set(
    tokenizeWords([profile.name, profile.companion].join(" ")).map((t) => t.toLowerCase()),
  );
  const seen = new Set();
  const chosen = [];
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const word = String(c?.word ?? "").trim();
    const key = word.toLowerCase();
    const definition = String(c?.definition ?? "").trim();
    if (!word || !definition || seen.has(key)) continue;
    if (!tokens.has(key)) continue;     // must appear in the chapter, exactly
    if (childNames.has(key)) continue;  // never "define" the hero's name
    seen.add(key);
    chosen.push({
      word,
      partOfSpeech: String(c?.part_of_speech ?? "").trim().slice(0, 20),
      definition: definition.slice(0, 200),
      syllables: countSyllables(word, profile.language),
    });
    if (chosen.length >= level.stretch + 1) break;
  }
  return chosen;
}

// =============================================================================
// STEP 5  ADAPT: one level easier or harder ("Make it easier" / "Challenge me").
// Returns null at the ends of the scale so the UI can say so.
// =============================================================================
export function shiftLevel(levelId, direction) {
  const i = LEVELS.findIndex((l) => l.id === levelId);
  if (i === -1) return null;
  const j = direction === "easier" ? i - 1 : direction === "harder" ? i + 1 : i;
  return LEVELS[j] || null;
}

// =============================================================================
// STEP 6  SAFETY (layer 1 of 2): rule-based word screen.
// Fast, free and predictable. It catches clearly unsuitable words in English
// and Spanish; words in the "young" lists are only blocked for ages 5–7.
// Layer 2 (a Claude classifier judging the whole chapter for the child's age)
// runs in the Netlify Function. A chapter is shown only if both layers pass.
// =============================================================================
const BLOCK_ALL_AGES = {
  en: [
    "kill", "kills", "killed", "killing", "killer", "murder", "murdered", "murderer",
    "blood", "bloody", "gore", "gory", "corpse", "corpses", "suicide", "torture", "tortured",
    "gun", "guns", "pistol", "rifle", "shotgun", "bullet", "bullets", "stab", "stabbed", "bomb", "bombs",
    "drug", "drugs", "cocaine", "heroin", "beer", "wine", "vodka", "whiskey", "drunk", "cigarette", "cigarettes",
    "sex", "sexy", "naked", "nude",
    "hell", "damn", "crap", "shit", "fuck", "bitch", "bastard", "idiot", "stupid",
  ],
  es: [
    "matar", "mató", "matan", "asesino", "asesina", "asesinato", "asesinar",
    "sangre", "sangriento", "sangrienta", "cadáver", "cadáveres", "suicidio", "tortura", "torturar",
    "pistola", "pistolas", "rifle", "escopeta", "bala", "balas", "apuñalar", "bomba", "bombas",
    "droga", "drogas", "cocaína", "heroína", "cerveza", "vodka", "whisky", "borracho", "borracha", "cigarrillo", "cigarrillos",
    "sexo", "sexy", "desnudo", "desnuda",
    "infierno", "maldito", "maldita", "mierda", "joder", "idiota", "estúpido", "estúpida",
  ],
};
const BLOCK_YOUNG = {
  en: ["die", "dies", "died", "dying", "dead", "death", "weapon", "weapons", "knife", "sword", "terrifying", "horror", "nightmare", "nightmares", "coffin", "skeleton", "zombie", "zombies"],
  es: ["morir", "muere", "murió", "muerto", "muerta", "muerte", "arma", "armas", "cuchillo", "espada", "terrorífico", "terror", "pesadilla", "pesadillas", "ataúd", "tumba", "esqueleto", "zombi", "zombis"],
};

export function ruleBasedSafety(text, age, language) {
  const lang = language === "es" ? "es" : "en";
  // Screen both languages' all-ages lists: a Spanish chapter can still contain an English word.
  const blocked = new Set([...BLOCK_ALL_AGES.en, ...BLOCK_ALL_AGES.es]);
  if (age <= 7) BLOCK_YOUNG[lang].forEach((w) => blocked.add(w));
  const flagged = [...new Set(tokenizeWords(text).map((t) => t.toLowerCase()).filter((t) => blocked.has(t)))];
  return { safe: flagged.length === 0, flagged };
}
