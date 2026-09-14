/**
 * Regenerate the four policy pages from the copy on the live site, keeping the
 * design that is already in place (the page's own CSS module plus the same
 * Tailwind utility classes the hand-written versions used).
 *
 * Every string is emitted as a JS string literal inside JSX ({"…"}) rather than
 * raw JSX text, so quotes, braces, ampersands and the smart punctuation in the
 * legal copy cannot break the build or get mangled into entities.
 */
const fs = require('fs');
const path = require('path');

const policies = require('./policies.json');
const APP = 'D:/koott-new/frontend/src/app';

const HEADINGS = {
  'privacy-policy': 'Privacy Policy',
  'terms-and-conditions': 'Terms and Conditions of Service',
  'refundpolicy': 'Refund & Cancellation Policy',
  'agreement': 'Therapy Agreement',
};

/** Each route keeps whatever stylesheet it already used — terms-and-conditions
 *  shares the privacy-policy module rather than having one of its own. */
const CSS_IMPORT = {
  'privacy-policy': './privacy-policy.module.css',
  'terms-and-conditions': '../privacy-policy/privacy-policy.module.css',
  'refundpolicy': './refund-policy.module.css',
  'agreement': './therapy-agreement.module.css',
};

const COMPONENT = {
  'privacy-policy': 'PrivacyPolicyPage',
  'terms-and-conditions': 'TermsAndConditionsPage',
  'refundpolicy': 'RefundPolicyPage',
  'agreement': 'TherapyAgreementPage',
};

const s = (t) => JSON.stringify(t);

/** Group consecutive list items so they render as one <ul>. */
function groupBlocks(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === 'li') {
      const last = out[out.length - 1];
      if (last && last.type === 'ul') last.items.push(b.text);
      else out.push({ type: 'ul', items: [b.text] });
    } else {
      out.push(b);
    }
  }
  return out;
}

function renderBlocks(blocks, title) {
  const lines = [];
  const norm = (t) => t.replace(/[^a-z0-9]/gi, '').toLowerCase();

  for (const b of groupBlocks(blocks)) {
    if (b.type === 'h') {
      // The live pages repeat their own title as the first heading; the page
      // already renders it above, so skip that one.
      if (norm(b.text) === norm(title)) continue;
      lines.push(`                <h3 className={\`\${styles.sectionHeading} mt-10 text-gray-900\`}>{${s(b.text)}}</h3>`);
    } else if (b.type === 'ul') {
      lines.push('                <ul className="mt-4 space-y-3 text-base leading-relaxed text-gray-700 list-disc list-inside">');
      b.items.forEach((it, i) => {
        lines.push(`                    <li key={${i}}>{${s(it)}}</li>`);
      });
      lines.push('                </ul>');
    } else {
      lines.push(`                <p className="mt-4 text-base leading-relaxed text-gray-700">{${s(b.text)}}</p>`);
    }
  }
  return lines.join('\n');
}

function pageSource(liveSlug, v) {
  const route = v.ourRoute;
  const cssModule = CSS_IMPORT[liveSlug];
  const heading = HEADINGS[liveSlug];
  const title = v.seoTitle || `${heading} | Koott`;
  const description = v.seoDescription || '';
  const url = `https://www.koott.in/${route}`;

  return `import styles from ${s(cssModule)};

/**
 * ${heading}.
 *
 * Copy is the text published at koott.in/${liveSlug}; the layout and type scale
 * are this page's existing design. Regenerate with scripts rather than editing
 * the prose here by hand, so the two stay in step.
 */

export const metadata = {
    title: { absolute: ${s(title)} },
    description: ${s(description)},
    alternates: { canonical: ${s(url)} },
    openGraph: {
        title: ${s(title)},
        description: ${s(description)},
        type: "website",
        url: ${s(url)},
        siteName: "Koott",
        images: [
            { url: "https://www.koott.in/logo.png", width: 1200, height: 630, alt: "Koott logo" },
        ],
    },
    twitter: {
        card: "summary_large_image",
        title: ${s(title)},
        description: ${s(description)},
        images: ["https://www.koott.in/logo.png"],
    },
};

export const dynamic = 'force-static';

export default function ${COMPONENT[liveSlug]}() {
    // Header.jsx is position:fixed and reserves no space of its own.
    return (
        <div className={\`bg-white text-gray-900 \${styles.page}\`} style={{ paddingTop: 64 }}>
            <div className="max-w-5xl mx-auto px-6 py-16 lg:px-8 lg:py-24">
                <h3 className={\`\${styles.title} mt-2 text-gray-900\`}>{${s(heading)}}</h3>
${renderBlocks(v.blocks, heading)}
            </div>
        </div>
    );
}
`;
}

let written = 0;
for (const [liveSlug, v] of Object.entries(policies)) {
  const dir = path.join(APP, v.ourRoute);
  if (!fs.existsSync(dir)) { console.log('SKIP (no route dir):', v.ourRoute); continue; }
  const file = path.join(dir, 'page.js');
  fs.writeFileSync(file, pageSource(liveSlug, v));
  written++;
  console.log(`${v.ourRoute.padEnd(22)} <- ${liveSlug.padEnd(22)} ${v.blocks.length} blocks, ${fs.statSync(file).size} bytes`);
}
console.log('written:', written);
