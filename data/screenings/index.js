/**
 * The screening registry.
 *
 * Conditions and the tests under them are declared HERE, in code — not in the
 * database and not in a CMS. Every instrument has its own item map, reverse
 * keys, multipliers, cut-offs and report wording, and those rules are exactly
 * the thing that must not drift: a form that can edit a scoring key is a way to
 * produce a wrong clinical report that still looks right.
 *
 * Adding a test is three steps:
 *   1. write data/screenings/<slug>.js, exporting the definition
 *   2. require it below and list its slug under the right condition
 *   3. add its key and cut-offs to __tests__/screeningScore.test.js
 *
 * Step 3 is not optional. The tests are what catch a mistyped item map.
 */

const { DASS21 } = require('./dass21');
const { BFI44 } = require('./bfi44');

/** Every instrument, keyed by slug. */
const TESTS = {
  [DASS21.slug]: DASS21,
  [BFI44.slug]: BFI44,
};

/**
 * Conditions, in the order they appear on the landing page.
 *
 * `tests` lists slugs from TESTS. A test may appear under more than one
 * condition — the DASS-21 reports depression, anxiety and stress, so it
 * genuinely belongs under all three rather than being duplicated.
 */
const CONDITIONS = [
  {
    slug: 'depression',
    name: 'Depression',
    icon: '🌧',
    summary: 'Low mood, loss of interest, feeling flat or hopeless.',
    description:
      'These checks ask how you have been feeling recently and describe what they find. They are a starting point '
      + 'for a conversation with a psychologist, not a diagnosis.',
    tests: ['dass-21'],
  },
  {
    slug: 'anxiety',
    name: 'Anxiety',
    icon: '🌀',
    summary: 'Worry, tension, restlessness or panic.',
    description:
      'These checks ask about worry, physical tension and panic over the past week. They describe what you report '
      + 'and are not a diagnosis.',
    tests: ['dass-21'],
  },
  {
    slug: 'stress',
    name: 'Stress',
    icon: '🫧',
    summary: 'Difficulty relaxing, irritability, feeling easily upset.',
    description:
      'These checks ask how much tension and irritability you have carried over the past week. They describe what '
      + 'you report and are not a diagnosis.',
    tests: ['dass-21'],
  },
  {
    slug: 'personality',
    name: 'Personality',
    icon: '🧭',
    summary: 'A profile of five broad traits. No right or wrong answers.',
    description:
      'Personality measures describe where you sit on broad traits. There are no good or bad results and nothing '
      + 'here is a clinical finding.',
    tests: ['big-five'],
  },
];

const getTest = (slug) => TESTS[String(slug || '')] || null;
const getCondition = (slug) => CONDITIONS.find((c) => c.slug === String(slug || '')) || null;

/** The conditions a given test appears under — used for breadcrumbs. */
const conditionsForTest = (slug) => CONDITIONS.filter((c) => c.tests.includes(slug));

/** Landing-page shape: conditions with their tests expanded, no question banks. */
function listConditions() {
  return CONDITIONS.map((c) => ({
    slug: c.slug,
    name: c.name,
    icon: c.icon,
    summary: c.summary,
    tests: c.tests
      .map((s) => TESTS[s])
      .filter(Boolean)
      .map((t) => ({
        slug: t.slug,
        name: t.name,
        fullName: t.full_name,
        summary: t.summary,
        questionCount: (t.questions || []).length,
      })),
  }));
}

/** A test without its answer key, safe to send to the browser. */
function publicTest(slug) {
  const t = getTest(slug);
  if (!t) return null;
  return {
    slug: t.slug,
    name: t.name,
    fullName: t.full_name,
    summary: t.summary,
    description: t.description,
    leadLine: t.lead_line,
    options: t.options,
    // `scale` and `reverse` are the answer key — they are deliberately not sent.
    questions: (t.questions || []).map((q) => ({ n: q.n, text: q.text })),
    doneNote: t.done_note,
    consent: t.consent || null,
  };
}

module.exports = { TESTS, CONDITIONS, getTest, getCondition, conditionsForTest, listConditions, publicTest };
