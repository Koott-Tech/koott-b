/**
 * DASS-21 — Depression Anxiety Stress Scales, 21-item short form.
 *
 * Item → subscale map and cut-offs are the published ones. Scores are DOUBLED
 * before the bands are applied, because the DASS-21 is the short form of the
 * DASS-42 and the norms are for 42 items.
 *
 * Each scale has its own thresholds; they are deliberately different. Stress
 * does not leave "Normal" until 15, while Anxiety leaves it at 8 — so Stress 16
 * is Mild while Anxiety 12 is Moderate. That is the instrument, not a bug.
 */

const S = 'stress'; const A = 'anxiety'; const D = 'depression';

const ITEMS = [
  [1,  S, 'I found it hard to wind down'],
  [2,  A, 'I was aware of dryness of my mouth'],
  [3,  D, "I couldn't seem to experience any positive feeling at all"],
  [4,  A, 'I experienced breathing difficulty (e.g. excessively rapid breathing, breathlessness in the absence of physical exertion)'],
  [5,  D, 'I found it difficult to work up the initiative to do things'],
  [6,  S, 'I tended to over-react to situations'],
  [7,  A, 'I experienced trembling (e.g. in the hands)'],
  [8,  S, 'I felt that I was using a lot of nervous energy'],
  [9,  A, 'I was worried about situations in which I might panic and make a fool of myself'],
  [10, D, 'I felt that I had nothing to look forward to'],
  [11, S, 'I found myself getting agitated'],
  [12, S, 'I found it difficult to relax'],
  [13, D, 'I felt down-hearted and blue'],
  [14, S, 'I was intolerant of anything that kept me from getting on with what I was doing'],
  [15, A, 'I felt I was close to panic'],
  [16, D, 'I was unable to become enthusiastic about anything'],
  [17, D, "I felt I wasn't worth much as a person"],
  [18, S, 'I felt that I was rather touchy'],
  [19, A, 'I was aware of the action of my heart in the absence of physical exertion (e.g. sense of heart rate increase, heart missing a beat)'],
  [20, A, 'I felt scared without any good reason'],
  [21, D, 'I felt that life was meaningless'],
];

const DASS21 = {
  slug: 'dass-21',
  name: 'DASS-21',
  full_name: 'Depression Anxiety Stress Scales',
  summary: 'A 21-question check on how depression, anxiety and stress have affected you over the past week.',
  description:
    'The DASS-21 asks how much each of 21 statements applied to you over the past week, and reports three separate '
    + 'scores: depression, anxiety and stress. It is a screening measure that describes how you have been feeling '
    + 'recently — it is not a diagnosis.',
  lead_line: 'Over the past week…',
  method: 'sum',
  options: [
    { value: 0, label: 'Did not apply to me at all' },
    { value: 1, label: 'Applied to me to some degree, or some of the time' },
    { value: 2, label: 'Applied to me to a considerable degree, or a good part of time' },
    { value: 3, label: 'Applied to me very much or most of the time' },
  ],
  questions: ITEMS.map(([n, scale, text]) => ({ n, scale, text, reverse: false })),
  scales: [
    {
      key: D, label: 'Depression', multiplier: 2,
      description:
        'The depression scale reflects low mood, loss of interest and enjoyment, a sense of hopelessness, and a low '
        + 'opinion of oneself over the past week.',
      facets: ['Dysphoria', 'Hopelessness', 'Devaluation of life', 'Self-deprecation', 'Lack of interest', 'Anhedonia'],
    },
    {
      key: A, label: 'Anxiety', multiplier: 2,
      description:
        'The anxiety scale reflects physical signs of arousal, situational anxiety, and the subjective experience of '
        + 'fear over the past week.',
      facets: ['Autonomic arousal', 'Skeletal muscle effects', 'Situational anxiety', 'Subjective experience of anxiety'],
    },
    {
      key: S, label: 'Stress', multiplier: 2,
      description:
        'The stress scale reflects difficulty relaxing, nervous tension, irritability and being easily upset or '
        + 'impatient over the past week.',
      facets: ['Difficulty relaxing', 'Nervous arousal', 'Easily upset or agitated', 'Irritable or over-reactive', 'Impatient'],
    },
  ],
  // [maxInclusive, label] in order, ending open-ended.
  severity: {
    [D]: [[9, 'Normal'], [13, 'Mild'], [20, 'Moderate'], [27, 'Severe'], [null, 'Extremely Severe']],
    [A]: [[7, 'Normal'], [9, 'Mild'], [14, 'Moderate'], [19, 'Severe'], [null, 'Extremely Severe']],
    [S]: [[14, 'Normal'], [18, 'Mild'], [25, 'Moderate'], [33, 'Severe'], [null, 'Extremely Severe']],
  },
  report_note:
    'This report is based on a self-administered screening questionnaire. It describes how you reported feeling over '
    + 'the past week and is not a clinical diagnosis. Please discuss the results with a qualified mental health '
    + 'professional.',
  done_note:
    'Your responses have been sent to our psychologists. The DASS-21 is a screening measure, not a diagnosis — one of '
    + 'the team will be in touch to talk it through with you.',
};

module.exports = { DASS21, ITEMS };
