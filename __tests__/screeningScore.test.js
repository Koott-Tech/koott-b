/**
 * Scoring is the part of the screenings that can be silently wrong: a bad
 * item→scale map or a missed reverse-key still produces a plausible-looking
 * report. These lock the published keys and the approved sample's figures.
 */

const { DASS21 } = require('../data/screenings/dass21');
const { BFI44 } = require('../data/screenings/bfi44');
const { scoreScreening, validateAnswers } = require('../utils/screeningScore');

const bandFor = (test, scale, score) =>
  test.severity[scale].find(([max]) => score <= (max === null ? Infinity : max))[1];

/** Answers that sum a subscale to `target` before the ×2 multiplier. */
const dassAnswers = (targets) => {
  const out = {};
  for (const [scale, total] of Object.entries(targets)) {
    let left = total;
    DASS21.questions.filter((q) => q.scale === scale).forEach((q) => {
      const v = Math.min(3, left);
      out[String(q.n)] = v;
      left -= v;
    });
  }
  return out;
};

describe('DASS-21 key', () => {
  it('has 21 items, seven per subscale', () => {
    expect(DASS21.questions).toHaveLength(21);
    for (const s of ['depression', 'anxiety', 'stress']) {
      expect(DASS21.questions.filter((q) => q.scale === s)).toHaveLength(7);
    }
  });

  it('maps every item to the published subscale', () => {
    const map = Object.fromEntries(DASS21.questions.map((q) => [q.n, q.scale[0]]));
    expect([1, 6, 8, 11, 12, 14, 18].every((n) => map[n] === 's')).toBe(true);
    expect([2, 4, 7, 9, 15, 19, 20].every((n) => map[n] === 'a')).toBe(true);
    expect([3, 5, 10, 13, 16, 17, 21].every((n) => map[n] === 'd')).toBe(true);
  });

  it.each([
    ['depression', [[9, 'Normal'], [10, 'Mild'], [13, 'Mild'], [14, 'Moderate'], [20, 'Moderate'], [21, 'Severe'], [27, 'Severe'], [28, 'Extremely Severe']]],
    ['anxiety', [[7, 'Normal'], [8, 'Mild'], [9, 'Mild'], [10, 'Moderate'], [14, 'Moderate'], [15, 'Severe'], [19, 'Severe'], [20, 'Extremely Severe']]],
    ['stress', [[14, 'Normal'], [15, 'Mild'], [18, 'Mild'], [19, 'Moderate'], [25, 'Moderate'], [26, 'Severe'], [33, 'Severe'], [34, 'Extremely Severe']]],
  ])('applies the %s cut-offs', (scale, cases) => {
    for (const [score, label] of cases) expect(bandFor(DASS21, scale, score)).toBe(label);
  });

  it('bands each scale on its own thresholds', () => {
    // The scales are not interchangeable: the same number means different
    // things, which is the thing people report as a bug.
    expect(bandFor(DASS21, 'stress', 16)).toBe('Mild');
    expect(bandFor(DASS21, 'anxiety', 12)).toBe('Moderate');
  });
});

describe('DASS-21 scoring', () => {
  it('doubles the raw sum and matches the approved sample', () => {
    const r = scoreScreening(DASS21, dassAnswers({ depression: 6, anxiety: 5, stress: 8 }));
    const by = Object.fromEntries(r.scales.map((s) => [s.key, s]));

    expect(by.depression.score).toBe(12);
    expect(by.anxiety.score).toBe(10);
    expect(by.stress.score).toBe(16);

    expect(by.depression.severity).toBe('Mild');
    expect(by.anxiety.severity).toBe('Moderate');
    expect(by.stress.severity).toBe('Mild');

    expect(by.depression.percent).toBe(28.6);
    expect(by.anxiety.percent).toBe(23.8);
    expect(by.stress.percent).toBe(38.1);
  });

  it('scores an all-zero sheet as Normal across the board', () => {
    const zero = Object.fromEntries(DASS21.questions.map((q) => [String(q.n), 0]));
    for (const s of scoreScreening(DASS21, zero).scales) {
      expect(s.score).toBe(0);
      expect(s.severity).toBe('Normal');
    }
  });
});

describe('BFI-44 key', () => {
  it('has 44 items with the published counts and reverse counts', () => {
    expect(BFI44.questions).toHaveLength(44);
    const order = ['extraversion', 'agreeableness', 'conscientiousness', 'neuroticism', 'openness'];
    expect(order.map((k) => BFI44.questions.filter((q) => q.scale === k).length)).toEqual([8, 9, 9, 8, 10]);
    expect(order.map((k) => BFI44.questions.filter((q) => q.scale === k && q.reverse).length)).toEqual([3, 4, 4, 3, 2]);
  });

  it('reverse-keys the published items', () => {
    const rev = BFI44.questions.filter((q) => q.reverse).map((q) => q.n).sort((a, b) => a - b);
    expect(rev).toEqual([2, 6, 8, 9, 12, 18, 21, 23, 24, 27, 31, 34, 35, 37, 41, 43]);
  });
});

describe('BFI-44 scoring', () => {
  it('takes the mean, and all-1s does not collapse to 1.00', () => {
    const ones = Object.fromEntries(BFI44.questions.map((q) => [String(q.n), 1]));
    const means = scoreScreening(BFI44, ones).scales.map((s) => s.mean);
    // Driven entirely by the reverse counts 3, 4, 4, 3, 2.
    expect(means).toEqual([2.5, 2.78, 2.78, 2.5, 1.8]);
    expect(means).not.toContain(1);
  });

  it('gives the midpoint for an all-3s sheet', () => {
    const threes = Object.fromEntries(BFI44.questions.map((q) => [String(q.n), 3]));
    for (const s of scoreScreening(BFI44, threes).scales) {
      expect(s.mean).toBe(3);
      expect(s.percent).toBe(50);
      expect(s.severity).toBeNull();   // the Big Five has no bands
    }
  });

  it('derives the percentage from the rounded mean', () => {
    const ones = Object.fromEntries(BFI44.questions.map((q) => [String(q.n), 1]));
    const openness = scoreScreening(BFI44, ones).scales.find((s) => s.key === 'openness');
    expect(openness.mean).toBe(1.8);
    expect(openness.percent).toBe(20);   // (1.8 - 1) / 4
  });
});

describe('answer validation', () => {
  it('lists missing items rather than defaulting them to zero', () => {
    const a = dassAnswers({ depression: 6, anxiety: 5, stress: 8 });
    delete a['3']; delete a['7'];
    const v = validateAnswers(DASS21, a);
    expect(v.ok).toBe(false);
    expect(v.missing).toEqual([3, 7]);
  });

  it('rejects an answer outside the option range', () => {
    const a = dassAnswers({ depression: 6, anxiety: 5, stress: 8 });
    expect(validateAnswers(DASS21, { ...a, 5: 9 }).outOfRange).toContain(5);
    expect(validateAnswers(BFI44, { ...Object.fromEntries(BFI44.questions.map((q) => [String(q.n), 3])), 1: 0 }).outOfRange).toContain(1);
  });
});
