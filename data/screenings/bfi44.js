/**
 * BFI-44 — Big Five Inventory, 44 items.
 *
 * Scored as the MEAN of each trait's items after reverse-keying the marked
 * ones. No doubling, no sum, and no severity bands — the Big Five describes a
 * profile rather than a severity.
 *
 * Reverse counts per trait are 3, 4, 4, 3, 2. All-1s therefore yields 2.50,
 * 2.78, 2.78, 2.50, 1.80 rather than 1.00 everywhere — that is the quickest
 * check that the key is wired up the right way round.
 */

const E = 'extraversion'; const A = 'agreeableness'; const C = 'conscientiousness';
const N = 'neuroticism'; const O = 'openness';

// [item number, trait, reverse-keyed?, statement]
const ITEMS = [
  [1,  E, false, 'Is talkative'],
  [2,  A, true,  'Tends to find fault with others'],
  [3,  C, false, 'Does a thorough job'],
  [4,  N, false, 'Is depressed, blue'],
  [5,  O, false, 'Is original, comes up with new ideas'],
  [6,  E, true,  'Is reserved'],
  [7,  A, false, 'Is helpful and unselfish with others'],
  [8,  C, true,  'Can be somewhat careless'],
  [9,  N, true,  'Is relaxed, handles stress well'],
  [10, O, false, 'Is curious about many different things'],
  [11, E, false, 'Is full of energy'],
  [12, A, true,  'Starts quarrels with others'],
  [13, C, false, 'Is a reliable worker'],
  [14, N, false, 'Can be tense'],
  [15, O, false, 'Is ingenious, a deep thinker'],
  [16, E, false, 'Generates a lot of enthusiasm'],
  [17, A, false, 'Has a forgiving nature'],
  [18, C, true,  'Tends to be disorganized'],
  [19, N, false, 'Worries a lot'],
  [20, O, false, 'Has an active imagination'],
  [21, E, true,  'Tends to be quiet'],
  [22, A, false, 'Is generally trusting'],
  [23, C, true,  'Tends to be lazy'],
  [24, N, true,  'Is emotionally stable, not easily upset'],
  [25, O, false, 'Is inventive'],
  [26, E, false, 'Has an assertive personality'],
  [27, A, true,  'Can be cold and aloof'],
  [28, C, false, 'Perseveres until the task is finished'],
  [29, N, false, 'Can be moody'],
  [30, O, false, 'Values artistic, aesthetic experiences'],
  [31, E, true,  'Is sometimes shy, inhibited'],
  [32, A, false, 'Is considerate and kind to almost everyone'],
  [33, C, false, 'Does things efficiently'],
  [34, N, true,  'Remains calm in tense situations'],
  [35, O, true,  'Prefers work that is routine'],
  [36, E, false, 'Is outgoing, sociable'],
  [37, A, true,  'Is sometimes rude to others'],
  [38, C, false, 'Makes plans and follows through with them'],
  [39, N, false, 'Gets nervous easily'],
  [40, O, false, 'Likes to reflect, play with ideas'],
  [41, O, true,  'Has few artistic interests'],
  [42, A, false, 'Likes to cooperate with others'],
  [43, C, true,  'Is easily distracted'],
  [44, O, false, 'Is sophisticated in art, music, or literature'],
];

const BFI44 = {
  slug: 'big-five',
  name: 'Big Five (BFI-44)',
  full_name: 'Big Five Inventory',
  summary: 'A 44-question profile of five broad personality traits. No right or wrong answers.',
  description:
    'The Big Five Inventory describes personality across five broad traits. It produces a profile rather than a '
    + 'score out of anything, and there are no good or bad results — only differences in where people sit on each trait.',
  lead_line: 'I see myself as someone who…',
  method: 'mean',
  options: [
    { value: 1, label: 'Disagree strongly' },
    { value: 2, label: 'Disagree a little' },
    { value: 3, label: 'Neither agree nor disagree' },
    { value: 4, label: 'Agree a little' },
    { value: 5, label: 'Agree strongly' },
  ],
  questions: ITEMS.map(([n, scale, reverse, text]) => ({ n, scale, reverse, text })),
  scales: [
    {
      key: E, label: 'Extraversion', subtitle: 'vs. Introversion',
      description: 'Extraversion describes how much you draw energy from company, activity and outward expression.',
      facets: ['Gregariousness', 'Assertiveness', 'Activity', 'Excitement-seeking', 'Positive emotion', 'Warmth'],
    },
    {
      key: A, label: 'Agreeableness', subtitle: 'vs. Antagonism',
      description: 'Agreeableness describes how much you lean towards trust, cooperation and consideration of others.',
      facets: ['Trust', 'Straightforwardness', 'Altruism', 'Compliance', 'Modesty', 'Tender-mindedness'],
    },
    {
      key: C, label: 'Conscientiousness', subtitle: 'vs. Lack of direction',
      description: 'Conscientiousness describes how much you plan, organise and follow things through.',
      facets: ['Competence', 'Order', 'Dutifulness', 'Achievement-striving', 'Self-discipline', 'Deliberation'],
    },
    {
      key: N, label: 'Neuroticism', subtitle: 'vs. Emotional stability',
      description: 'Neuroticism describes how strongly and how often you experience negative emotion and tension.',
      facets: ['Anxiety', 'Angry hostility', 'Depression', 'Self-consciousness', 'Impulsiveness', 'Vulnerability'],
    },
    {
      key: O, label: 'Openness', subtitle: 'vs. Closedness to experience',
      description: 'Openness describes how drawn you are to new ideas, imagination, art and varied experience.',
      facets: ['Fantasy', 'Aesthetics', 'Feelings', 'Actions', 'Ideas', 'Values'],
    },
  ],
  severity: {},   // the Big Five has no bands
  report_note:
    'This report is based on a self-administered questionnaire. It describes a personality profile, not a clinical '
    + 'condition, and is not a diagnosis. Please discuss the results with a qualified mental health professional.',
  done_note:
    'Your responses have been sent to our psychologists. The Big Five describes personality — there are no right or '
    + 'wrong answers and it is not a diagnosis. One of the team will be in touch to talk it through with you.',
};

module.exports = { BFI44, ITEMS };
