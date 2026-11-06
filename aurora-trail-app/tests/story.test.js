// End-to-end tests of the Netlify Function (netlify/functions/story.mjs)
// against a FAKE Claude API running on localhost, so they need no API key
// and cost nothing. They check the request the function sends to Claude
// (model, structured output, key stays server-side) and the pipeline logic
// around it.
// Run: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const calls = [];
let nextChapter = null;
let nextSafety = { suitable: true, concerns: [] };

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const parsed = JSON.parse(body);
    calls.push({ url: req.url, headers: req.headers, body: parsed });
    const isSafety = parsed.system.startsWith("You review");
    const payload = isSafety ? nextSafety : nextChapter;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: parsed.model,
      content: [{ type: "text", text: JSON.stringify(payload) }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    }));
  });
});

let handler;
before(async () => {
  await new Promise((r) => server.listen(0, r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.ANTHROPIC_API_KEY = "test-key";
  ({ default: handler } = await import("../netlify/functions/story.mjs"));
});
after(() => server.close());

const profile = { name: "Maya", companion: "Pickles", age: 9, level: "g23", language: "en", interests: ["Animals", "Mysteries"] };

const easyChapter = {
  title: "The Lantern Stone",
  paragraphs: [
    "Maya and Pickles walked into the green woods. The leaves gave off a soft light. Maya stopped to look at one.",
    "Pickles sat by a flat gray stone. Someone had drawn lines on it long ago. It looked very ancient.",
    "Maya knelt down. She traced the marks with one finger. The woods began to hum. What did the stone want to say?",
  ],
  stretch_words: [
    { word: "ancient", part_of_speech: "adjective", definition: "Very, very old." },
    { word: "traced", part_of_speech: "verb", definition: "Followed a line with your finger." },
    { word: "sparkle", part_of_speech: "verb", definition: "Not in the text, so it is dropped." },
  ],
};

async function post(body) {
  const res = await handler(new Request("http://localhost/api/story", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, data: await res.json() };
}

test("generate: calls Claude with structured output and returns a measured chapter", async () => {
  calls.length = 0;
  nextChapter = easyChapter;
  const { status, data } = await post({ action: "generate", profile });
  assert.equal(status, 200);
  assert.equal(data.ok, true);

  // The request to Claude
  assert.equal(calls.length, 1);
  const sent = calls[0].body;
  assert.equal(sent.model, "claude-opus-5-5");
  assert.equal(sent.output_config.format.type, "json_schema");
  assert.equal(sent.fallbacks, "default");
  assert.match(calls[0].headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  // The key is sent to Claude from the server (SDK 1.x uses a Bearer header).
  const auth = calls[0].headers["x-api-key"] || calls[0].headers.authorization;
  assert.match(auth, /test-key/);
  assert.match(sent.messages[0].content, /<name>Maya<\/name>/);

  // STEP 3 readability and STEP 4 vocabulary
  assert.ok(typeof data.analysis.grade === "number");
  assert.equal(data.analysis.level.id, "g23");
  assert.deepEqual(data.chapter.stretchWords.map((w) => w.word), ["ancient", "traced"]);
  assert.equal(data.ruleSafety.safe, true);
  // The API key never appears in the response
  assert.doesNotMatch(JSON.stringify(data), /test-key/);
});

test("rewrite easier: moves down one level and keeps the plot instruction", async () => {
  calls.length = 0;
  nextChapter = easyChapter;
  const { data } = await post({ action: "rewrite", reason: "easier", profile, chapter: easyChapter });
  assert.equal(data.ok, true);
  assert.equal(data.level, "k1");
  assert.match(calls[0].body.messages[0].content, /one reading level lower/);
  assert.match(calls[0].body.messages[0].content, /Reading level: K–1/);
});

test("rewrite harder at the top level is refused without calling Claude", async () => {
  calls.length = 0;
  const { status, data } = await post({ action: "rewrite", reason: "harder", profile: { ...profile, level: "g912" }, chapter: easyChapter });
  assert.equal(status, 400);
  assert.equal(data.code, "level_limit");
  assert.equal(calls.length, 0);
});

test("rewrite fix: sends feedback computed by our own checks", async () => {
  calls.length = 0;
  nextChapter = easyChapter;
  const hard = { title: "T", paragraphs: ["Maya contemplated the extraordinarily intricate luminescent formations decorating the cavern, wondering whether ancient civilizations had deliberately engineered them for navigation."] };
  const { data } = await post({ action: "rewrite", reason: "fix", profile, chapter: hard });
  assert.equal(data.ok, true);
  assert.ok(data.fixFeedback.some((t) => /measured reading level/.test(t)));
  assert.match(calls[0].body.messages[0].content, /Problems to fix/);
});

test("safety: both layers must pass", async () => {
  nextSafety = { suitable: true, concerns: [] };
  let r = await post({ action: "safety", profile, chapter: easyChapter });
  assert.equal(r.data.safe, true);

  nextSafety = { suitable: false, concerns: ["A character is frightened by a monster."] };
  r = await post({ action: "safety", profile, chapter: easyChapter });
  assert.equal(r.data.safe, false);
  assert.deepEqual(r.data.classifier.concerns, ["A character is frightened by a monster."]);

  nextSafety = { suitable: true, concerns: [] };
  const unsafe = { ...easyChapter, paragraphs: [...easyChapter.paragraphs, "Then he drank a beer."] };
  r = await post({ action: "safety", profile, chapter: unsafe });
  assert.equal(r.data.safe, false);
  assert.deepEqual(r.data.rules.flagged, ["beer"]);
});

test("invalid profiles are rejected before any Claude call", async () => {
  calls.length = 0;
  const { status, data } = await post({ action: "generate", profile: { ...profile, age: 14 } });
  assert.equal(status, 400);
  assert.equal(data.code, "invalid_profile");
  assert.equal(calls.length, 0);
});

test("only POST is allowed", async () => {
  const res = await handler(new Request("http://localhost/api/story"));
  assert.equal(res.status, 405);
});
