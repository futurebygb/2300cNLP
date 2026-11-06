// Unit tests for the deterministic NLP steps (shared/nlp.js).
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countSyllablesEn,
  countSyllablesEs,
  splitSentences,
  tokenizeWords,
  readabilityStats,
  levelStatus,
  getLevel,
  analyzeChapter,
  buildFixFeedback,
  selectStretchWords,
  shiftLevel,
  ruleBasedSafety,
  validateProfile,
} from "../shared/nlp.js";

const profile = { name: "Maya", companion: "Pickles", age: 9, level: "g23", language: "en", interests: ["Animals"] };

test("English syllables", () => {
  const cases = { cat: 1, table: 2, jumped: 1, wanted: 2, stone: 1, explorer: 3, shiny: 2, yellow: 2, ancient: 2, hypothesis: 4, whispered: 2 };
  for (const [word, n] of Object.entries(cases)) assert.equal(countSyllablesEn(word), n, word);
});

test("Spanish syllables follow diphthong and hiatus rules", () => {
  const cases = { bosque: 2, río: 2, cielo: 2, león: 2, hoy: 1, capitana: 4, quiero: 2, guitarra: 3, pingüino: 3, país: 2, murciélago: 4, ciudad: 2 };
  for (const [word, n] of Object.entries(cases)) assert.equal(countSyllablesEs(word), n, word);
});

test("sentence splitting handles abbreviations, quotes and Spanish punctuation", () => {
  const s = splitSentences('Dr. Pop smiled. "That is peculiar," she said. ¿Dónde está? ¡Aquí!');
  assert.deepEqual(s, ["Dr. Pop smiled.", '"That is peculiar," she said.', "¿Dónde está?", "¡Aquí!"]);
});

test("tokenizer keeps contractions and hyphenated words whole", () => {
  assert.deepEqual(tokenizeWords("Don't stop, well-known fox!"), ["Don't", "stop", "well-known", "fox"]);
});

test("Flesch-Kincaid grade matches a hand calculation", () => {
  // 7 words, 1 sentence, 11 syllables: 0.39*7 + 11.8*(11/7) - 15.59 = 5.68
  const r = readabilityStats("Lila the Explorer found a shiny stone.", "en");
  assert.equal(r.wordCount, 7);
  assert.equal(r.sentenceCount, 1);
  assert.equal(r.grade, 5.7);
});

test("harder text scores a higher grade than easier text", () => {
  const easy = readabilityStats("The cat sat. The dog ran. We had fun in the sun.", "en");
  const hard = readabilityStats("Lila hypothesized the artifact contained bioluminescent compounds, prompting meticulous documentation.", "en");
  assert.ok(easy.grade < 2, `easy grade ${easy.grade}`);
  assert.ok(hard.grade > 12, `hard grade ${hard.grade}`);
});

test("Spanish uses Crawford grade and Fernández Huerta ease", () => {
  const r = readabilityStats("La capitana Maya cruzó los helechos al borde del Bosque Brillante. Pickles corría delante, con su cola naranja sobre el musgo azul.", "es");
  assert.match(r.formula, /Crawford/);
  assert.equal(r.ease, 78); // same value as the mockup's Spanish scorer
  assert.ok(r.grade > 3 && r.grade < 6, `grade ${r.grade}`);
});

test("level status: on target, close, off", () => {
  const g23 = getLevel("g23"); // grades 2–4
  assert.equal(levelStatus(3, g23), "on-target");
  assert.equal(levelStatus(4.8, g23), "close");
  assert.equal(levelStatus(6.5, g23), "off");
});

test("self-check feedback asks for shorter sentences when too hard", () => {
  const chapter = { paragraphs: ["Maya contemplated the extraordinarily intricate, luminescent formations decorating the cavern, wondering whether ancient civilizations had deliberately engineered them."] };
  const analysis = analyzeChapter(chapter, profile);
  assert.equal(analysis.status, "off");
  const tips = buildFixFeedback(analysis);
  assert.ok(tips.some((t) => /Split them/.test(t)));
  assert.ok(tips.some((t) => /Replace long words/.test(t)));
});

test("vocabulary keeps only words that appear in the text, never the hero's name", () => {
  const chapter = { paragraphs: ["Maya saw an ancient stone. It was peculiar."] };
  const words = selectStretchWords([
    { word: "ancient", part_of_speech: "adjective", definition: "Very old." },
    { word: "Peculiar", part_of_speech: "adjective", definition: "Strange." },
    { word: "glimmer", part_of_speech: "verb", definition: "Shine softly." }, // not in text
    { word: "Maya", part_of_speech: "noun", definition: "The hero." },       // hero's name
    { word: "ancient", part_of_speech: "adjective", definition: "Duplicate." },
  ], chapter, profile);
  assert.deepEqual(words.map((w) => w.word), ["ancient", "Peculiar"]);
});

test("adapt moves one level and stops at the ends", () => {
  assert.equal(shiftLevel("g23", "easier").id, "k1");
  assert.equal(shiftLevel("g23", "harder").id, "g45");
  assert.equal(shiftLevel("k1", "easier"), null);
  assert.equal(shiftLevel("g912", "harder"), null);
});

test("safety rules: age-based and bilingual", () => {
  assert.equal(ruleBasedSafety("The dragon flew home.", 6, "en").safe, true);
  assert.deepEqual(ruleBasedSafety("The old tree died.", 6, "en").flagged, ["died"]);
  assert.equal(ruleBasedSafety("The old tree died.", 9, "en").safe, true); // allowed for older kids
  assert.equal(ruleBasedSafety("He grabbed a gun.", 10, "en").safe, false); // blocked at every age
  assert.equal(ruleBasedSafety("El dragón vino a casa.", 6, "es").safe, true); // "vino" = came
  assert.deepEqual(ruleBasedSafety("Había sangre.", 9, "es").flagged, ["sangre"]);
});

test("profile validation", () => {
  const ok = validateProfile({ name: " Maya ", age: "9", level: "g23", language: "en", interests: ["Animals", "Space"] });
  assert.equal(ok.ok, true);
  assert.equal(ok.profile.name, "Maya");
  assert.equal(ok.profile.age, 9);
  assert.equal(validateProfile({ ...ok.profile, age: 12 }).ok, false);
  assert.equal(validateProfile({ ...ok.profile, interests: ["a", "b", "c", "d"] }).ok, false);
  assert.equal(validateProfile({ ...ok.profile, name: "<script>" }).ok, false);
  assert.equal(validateProfile({ ...ok.profile, interests: ["guns"] }).ok, false);
});
