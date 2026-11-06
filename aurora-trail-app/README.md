# Aurora Trail app

Aurora Trail writes a short story chapter starring a child, at their reading level, in English or Spanish. It measures the chapter's reading level, teaches a few new words, checks that the content suits the child's age, and lets the reader make the chapter easier or harder.

The first chapter is free. There are no logins and no payments.

## How it is built

| Part | Where | What it does |
|---|---|---|
| Web app | `public/` (`index.html`, `styles.css`, `app.js`) | The form, the reader and the "How this chapter was made" panel. Runs the pipeline steps in order. Never sees the API key. |
| Netlify Function | `netlify/functions/story.mjs` | The only code that calls Claude. Reads `ANTHROPIC_API_KEY` from the environment. One Claude call per request. |
| NLP toolkit | `shared/nlp.js` | Plain JavaScript, no AI: validation, tokenizing, syllables, readability formulas, vocabulary checks, safety word rules. |
| Tests | `tests/` | Unit tests for the NLP toolkit and end-to-end tests of the function against a fake Claude server (no key, no cost). |

## The NLP pipeline: where each step happens

Search the code for `STEP 1`, `STEP 2` and so on to find every place a step happens.

| Step | What happens | Where |
|---|---|---|
| **1 · Input** | The form collects name, age (5–10), up to 3 interests, reading level and language. It's checked in the browser and again on the server, including a safety screen of the child's own words. | `app.js` `readForm()` · `nlp.js` `validateProfile()` |
| **2 · Generation** | Claude writes the chapter as structured JSON (title, paragraphs, stretch words). The prompt gives measurable targets: grade band, sentence length, word count, and content rules set by **age**, never by reading level. | `story.mjs` `generate()`, `WRITER_SYSTEM`, `generatePrompt()` |
| **3 · Readability** | The chapter is tokenized, split into sentences and syllable-counted. English uses **Flesch-Kincaid Grade Level** (plus Flesch Reading Ease). Spanish uses the **Crawford** grade formula (plus **Fernández Huerta** ease), with Spanish syllable rules for diphthongs and hiatus. The score is compared with the chosen level: on target, within 1 grade, or off. | `nlp.js` `readabilityStats()`, `analyzeChapter()`, `levelStatus()` |
| **3b · Self-check & fix** | If the chapter misses its level or length, the code writes specific fix instructions from the numbers (for example, "sentences average 29 words; split them to about 9") and Claude rewrites the chapter once. The closer draft is kept. | `nlp.js` `buildFixFeedback()` · `story.mjs` `rewrite()` with `reason: "fix"` · `app.js` `runPipeline()`, `isBetter()` |
| **4 · Vocabulary** | Claude suggests stretch words with child-friendly definitions. The code keeps only words that really appear in the tokenized text, removes duplicates and the hero's name, and caps the count by level. In the reader they're gold buttons; tapping one shows its definition. | `nlp.js` `selectStretchWords()` · `app.js` `renderStory()`, `showWord()` |
| **5 · Adapt** | "Make it easier" and "Challenge me" move one level down or up, and Claude rewrites the same plot at the new targets. The new chapter goes through steps 3, 3b, 4 and 6 again. | `nlp.js` `shiftLevel()` · `story.mjs` `rewrite()` · `app.js` `runPipeline("easier" / "harder")` |
| **6 · Safety** | Two layers, and both must pass before anything is shown. (1) Word rules: English and Spanish blocklists, with extra words blocked for ages 5–7. (2) A separate Claude call acting as a reviewer judges the whole chapter for the child's age. If it fails, the chapter is rewritten more gently once and checked again. | `nlp.js` `ruleBasedSafety()` · `story.mjs` `safetyCheck()`, `SAFETY_SYSTEM` · `app.js` `runPipeline()` |

The **How this chapter was made** panel under each chapter shows the evidence for every step: the readability table for each draft, the fix instructions sent, the vocabulary kept, and both safety results.

### Limitations

- Readability formulas measure sentence length and word length only, not meaning. Short texts (under about 100 words) give noisier scores.
- English syllable counting is a heuristic with an exception list. Spanish syllable counting follows spelling rules and is more reliable.
- The Crawford formula was built for Spanish primary-school texts, so Spanish grades above about 6 are extrapolated.
- The word lists catch obvious problems only. The Claude reviewer handles context, such as a scary scene with no blocked words.

## Test it on your computer

You need [Node.js](https://nodejs.org) 20 or newer and an Anthropic API key from [console.anthropic.com](https://console.anthropic.com).

1. Open a terminal in this folder:

   ```bash
   cd aurora-trail-app
   ```

2. Install the dependencies:

   ```bash
   npm install
   ```

3. Run the tests (no key needed):

   ```bash
   npm test
   ```

4. Install the Netlify command-line tool (one time):

   ```bash
   npm install -g netlify-cli
   ```

5. Create your local key file. Copy `.env.example` to `.env` and paste your key after `ANTHROPIC_API_KEY=`. `.env` is listed in `.gitignore`, so it never goes to GitHub.

6. Start the app:

   ```bash
   netlify dev
   ```

7. Open http://localhost:8888, fill in the form and click **Write my free chapter**. A chapter takes about 20–60 seconds because it runs several Claude calls in turn.

Opening `public/index.html` directly won't work: the story service only runs under `netlify dev` or on Netlify.

## Deploy on Netlify

1. In Netlify, choose **Add new site → Import an existing project** and pick this GitHub repository.
2. Set **Base directory** to `aurora-trail-app`. The publish folder, functions folder and build settings come from `netlify.toml`.
3. Under **Site configuration → Environment variables**, add `ANTHROPIC_API_KEY` with your key.
4. Deploy.

Optional: set `CLAUDE_MODEL` to use a different Claude model (the default is `claude-opus-5-5`).

**Cost note:** anyone who can open the site can make it call Claude with your key. Each story is capped at 8 level changes, but set a monthly spend limit in the Anthropic Console before sharing the link widely.
