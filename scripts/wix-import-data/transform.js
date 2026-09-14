/**
 * Turn a scraped condition page into the object ConditionPageTemplate renders,
 * i.e. the shape documented in frontend/src/data/conditionPageTemplateSample.js.
 * That object is what gets stored in counselling_services.content.
 */

const BOOK_HREF = '/book-malayali-psychologists';

/* Reviews are global marketing copy — the same carousel on every condition page,
 * and rendered client-side by a Wix gallery rather than served in the HTML.
 * These are the five already matched to the design in conditionPageTemplateSample. */
const SHARED_REVIEWS = {
  eyebrow: 'Reviews',
  title: '4.9 in Google reviews, Touched more than a million human lives.',
  items: [
    { quote: 'Being in a new country was not easy. Our relationship felt distant, and we struggled to express what we were struggling with. But we finally open up, at our own pace, in online counselling by Koott.', name: 'Divya Menon', age: '37 years', source: 'zoho', sourceLogo: null, avatar: null },
    { quote: 'Things had been really stressful lately… we were constantly misunderstanding each other. I was holding back what I actually felt. Counselling helped us learn to express things better.', name: 'Jithin Mohan', age: '36 years', source: 'whatsapp', sourceLogo: null, avatar: null },
    { quote: 'There were a lot of unresolved issues, and we struggled to understand what we felt. Counselling was the best decision we made, we understand each other much better and resolve issues.', name: 'Fathima Noora', age: '26 years', source: 'google', sourceLogo: null, avatar: null },
    { quote: 'There were constant misunderstandings and it gets even messier when family interferes to fix it. Counselling by a professional therapist helped us resolve issues and hear each other out.', name: 'Praveen', age: '32 years', source: 'zoho', sourceLogo: null, avatar: null },
    { quote: 'Online counselling helped me regain control when everything felt overwhelming. My therapist helped me track small improvements week by week.', name: 'Anjali R', age: '29 years', source: 'google', sourceLogo: null, avatar: null },
  ],
};

const cards = (s) => (s && s.cards ? s.cards : []);
const toItems = (s) => cards(s).map((c) => ({ title: c.title, body: c.body }));

/** "Starting from ₹749" -> 749 */
const priceOf = (t) => {
  const m = String(t || '').match(/([\d,]+)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
};

/**
 * Pick a CTA band by its button label, falling back to document order. The four
 * bands always appear in the same sequence, but a couple of pages reword the
 * button, so the label is a hint rather than a rule.
 */
function pickBands(bands = []) {
  const rest = [...bands];
  const take = (re) => {
    const i = rest.findIndex((b) => re.test(b.cta));
    return i > -1 ? rest.splice(i, 1)[0] : null;
  };
  const ctaBand = take(/^book now/i) || rest.shift() || null;
  const midCta = take(/book a session/i) || rest.shift() || null;
  const bookBand = take(/talk to a (therapist|psychologist)/i) || rest.shift() || null;
  const closing = take(/view therapist/i) || rest.shift() || null;
  return { ctaBand, midCta, bookBand, closing };
}

const band = (b, fallbackLabel, fallbackText) => ({
  text: (b && b.text) || fallbackText,
  cta: { label: (b && b.cta) || fallbackLabel, href: BOOK_HREF },
});

function transform(p) {
  const { ctaBand, midCta, bookBand, closing } = pickBands(p.bands);
  const planNames = cards(p.plans);

  return {
    slug: p.slug,

    seo: { title: p.seo.title, description: p.seo.description },

    hero: {
      eyebrow: p.hero.eyebrow,
      title: p.hero.title,
      subtitle: p.hero.subtitle,
      // The live line is prefixed with a tick glyph the template draws itself.
      verifiedBy: (p.hero.verified || '').replace(/^✔\s*/, ''),
      primaryCta: { label: 'Book Now', href: BOOK_HREF },
      secondaryCta: { label: 'Whatsapp Us', href: 'https://wa.me/918138010101' },
      mediaLabel: p.hero.title,
      image: p.hero.image || null,
    },

    stats: (p.stats || []).map((s) => ({ value: s.figure, label: s.caption })),

    therapists: {
      eyebrow: 'We made it easy for you to choose.',
      title: p.therapistsHeading,
      filters: ['Specialist', 'Concern'],
      // Filled at request time from /api/public/psychologists.
      items: [],
    },

    howItWorks: {
      title: p.howItWorks.head,
      subtitle: p.howItWorks.intro,
      steps: toItems(p.howItWorks),
    },

    why: { title: p.why.head, subtitle: p.why.intro, items: toItems(p.why) },

    plans: {
      title: p.plans.head,
      subtitle: p.plans.intro,
      items: planNames.map((c, i) => ({
        name: c.title,
        body: c.body,
        from: priceOf((p.planPrices || [])[i]),
      })),
    },

    reviews: SHARED_REVIEWS,

    ctaBand: band(ctaBand, 'Book Now',
      'Take the first step today—connect with a licensed therapist in Kerala to improve your wellbeing.'),

    about: {
      title: p.about.head,
      paragraphs: p.about.paras || [],
      pillars: (p.pillars || []).map((c) => ({ title: c.title, body: c.body })),
    },

    symptoms: { title: p.symptoms.head, subtitle: p.symptoms.intro, items: toItems(p.symptoms) },

    midCta: band(midCta, 'Book a Session', 'You do not have to work through this on your own.'),

    seekHelp: { title: p.seekHelp.head, subtitle: p.seekHelp.intro, items: toItems(p.seekHelp) },

    bookBand: {
      title: 'Book a session with our psychologist.',
      text: (bookBand && bookBand.text) || 'Book a session with our psychologist.',
      cta: { label: (bookBand && bookBand.cta) || 'Talk to a Psychologist', href: BOOK_HREF },
    },

    // Types cards are a bullet list on some pages and a paragraph on others.
    types: {
      title: p.types.head,
      subtitle: p.types.intro,
      items: cards(p.types).map((c) => (c.items && c.items.length
        ? { title: c.title, items: c.items }
        : { title: c.title, body: c.body })),
    },

    therapyHelps: {
      title: p.therapyHelps.head,
      subtitle: p.therapyHelps.intro,
      items: toItems(p.therapyHelps),
    },

    supportKit: p.supportKit
      ? { title: p.supportKit.head, subtitle: p.supportKit.intro, items: toItems(p.supportKit) }
      : null,

    related: p.related
      ? { title: p.related.head, subtitle: p.related.intro, items: toItems(p.related) }
      : null,

    finalCta: {
      text: (p.finalCta && p.finalCta.intro) || (closing && closing.text)
        || 'Connect with a licensed Malayali psychologist today.',
      cta: { label: (closing && closing.cta) || 'View Therapists', href: BOOK_HREF },
    },

    faqs: (p.faqs || []).map((f) => ({ q: f.q, a: f.a })),
  };
}

module.exports = { transform, SHARED_REVIEWS, BOOK_HREF };

if (require.main === module) {
  const all = require('./conditions.json');
  const one = all.find((x) => x.slug === (process.argv[2] || 'depression-treatment'));
  console.log(JSON.stringify(transform(one), null, 1).slice(0, 3000));
}
