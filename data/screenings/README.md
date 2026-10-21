# Screenings

Self-administered questionnaires on the public site: a visitor picks a
condition, picks a test, answers one question per screen, and the practice is
emailed a scored PDF. The visitor never receives the report.

## Why these live in code

Every instrument has its own item→scale map, reverse-keyed items, multipliers,
cut-off bands, facet lists and report wording. Those rules are the part that
must not drift. A form that can edit a scoring key is a way to produce a report
that is clinically wrong and still looks right, and nobody would notice until
someone acted on it.

So instruments are added here, by hand, one at a time, with tests. There is no
CMS for them. The only thing in the database is the submissions table
(`0017_screenings.sql`).

## Adding a test

1. **Write the definition** — `data/screenings/<slug>.js`, exporting an object:

   | field | meaning |
   |---|---|
   | `slug`, `name`, `full_name` | identity; `slug` is the URL segment |
   | `summary`, `description` | shown before the visitor starts |
   | `lead_line` | the line above every item, e.g. `Over the past week…` |
   | `method` | `'sum'` or `'mean'` |
   | `options` | `[{ value, label }]`, ascending |
   | `questions` | `[{ n, scale, text, reverse }]` |
   | `scales` | `[{ key, label, subtitle, multiplier, facets, description }]` |
   | `severity` | `{ scaleKey: [[maxInclusive, label], …] }`, last entry `null` for open-ended. Omit entirely when the instrument has no bands |
   | `report_note`, `done_note` | the not-a-diagnosis wording |
   | `letterhead`, `note_preprinted` | see below |

2. **Register it** — require it in `index.js` and list its slug under the
   right condition(s). A test may sit under several: the DASS-21 reports
   depression, anxiety and stress, so it appears under all three.

3. **Test it** — add its key and cut-offs to
   `__tests__/screeningScore.test.js`. This step is not optional; it is what
   catches a mistyped item number.

## Scoring

`utils/screeningScore.js` is the only engine.

- **`sum`** — add the items in a scale, multiply by `multiplier`, read the band
  out of `severity`. The DASS-21 doubles because it is the short form of the
  DASS-42 and the published norms are for 42 items.
- **`mean`** — reverse-key the marked items, then take the mean. No bands.

Reverse-keying mirrors an answer within the option range (`min + max - v`), so
it works for 0–3 and 1–5 alike.

The percentage is computed from the **rounded** mean, matching the approved
sample reports.

### The bar / severity mismatch

Bars are drawn as a raw proportion, which can contradict the severity column —
Stress 16 (Mild) draws longer than Anxiety 12 (Moderate). This is reproduced
from the approved sample. To make bars agree with severity instead, set
`percentMax` on a scale to where "Extremely severe" begins (Depression 28,
Anxiety 20, Stress 34). It is a data change; no code changes.

## Letterheads

`letterhead` names a file in `templates/`. **Sheets are per-instrument and are
not interchangeable** — footer wording differs, and some already carry the
explanatory note, in which case set `note_preprinted: true` so it is not drawn
twice.

`templates/template.pdf` is the **payment receipt** sheet and is refused by
name: stamping a report onto it produces a clinical report headed RECEIPT with
PAYABLE TO and GRAND TOTAL running through the text.

With no letterhead the report renders on a clean A4 page and always draws the
note.

## Non-negotiables

- The client **never** receives the report. It goes only to fixed practice
  addresses; their email is collected so a psychologist can make contact and is
  printed on the report, never used as a recipient.
- Nothing here is a diagnosis. Every report and the final screen say so.
- All dates are **Asia/Kolkata** via `utils/istDate.js`. `toISOString()` is
  wrong — before 05:30 IST it reports the previous day.
- A storage failure must never cost a submission: still build the PDF, still
  send the email, still return success.
- One question per screen.
