# Koott first-party analytics

Koott's own record of the funnel — ad or organic visit → therapist listing →
profile → booking → payment → confirmed paid booking — and the marketing
dashboard on top of it (`/marketing` in the frontend). Meta and Google are not
the source of truth; this is.

## Switch it on

1. Run `supabase/migrations/0011_analytics.sql`, then
   `0012_marketing_reports.sql`, in the Supabase SQL editor (staging first).
   0011 adds tables plus one trigger on `payments`; 0012 adds read-only
   reporting functions.
2. Restart the backend. The outbox worker starts with it
   (`ANALYTICS_OUTBOX_ENABLED=false` stops it).
3. Marketing logins: `node scripts/createMarketingUser.js <email> ["Name"]`
   creates a `marketing` account (or resets its password) and prints a
   generated password once. Admins and superadmins can open the dashboard too.

Rollback: the bottom of the migration. Dropping the trigger alone detaches
analytics from payments; bookings are unaffected either way.

## How data flows

```
browser  ── track() ──►  POST /api/analytics/events  ──►  analytics_events
            (batched, only with analytics consent; validated against registry.js)

create-order ── analytics context ──►  booking_attribution   (frozen per payment)
OTP verify   ── analytics context ──►  lead_attribution       (first visit wins)
login        ── /api/analytics/identify ──► analytics_identities + login/registration event

payments.status → success | failed | refunded
   └─ trigger ─► analytics_outbox ─► worker (every minute, SKIP LOCKED, retries)
                                        └─► booking_completed / payment_failed / booking_cancelled
```

Paid bookings are only ever counted from the server: whichever path marks a
Razorpay payment `success` (webhook, success callback, status poll, recovery
job) fires the trigger once, and the outbox's unique key makes the event
exactly-once.

## Events

Browser events and their allowed props live in `registry.js` (`BROWSER_EVENTS`).
Anything not listed is dropped — an unknown event, an extra prop, a value of
the wrong shape. Server-only events (`booking_completed`, `payment_*`,
`registration_completed`, `login_completed`, `booking_cancelled`) are refused
from the browser.

| Group | Events |
|---|---|
| Pages | `page_view`, `page_engaged`, `scroll_depth` |
| Interactions | `ui_click` (any `data-track="…"` element), `ui_toggle`, `popup_shown` / `popup_action` / `popup_dismissed`, `filter_applied`, `contact_clicked`, `voice_intro_played` |
| Funnel | `counsellor_list_view`, `counsellor_profile_view`, `booking_started`, `booking_step_viewed`, `phone_verified`, `slot_selected`, `plan_selected`, `details_completed`, `checkout_started`, `payment_opened` |
| Friction | `booking_step_error`, `payment_attempt_failed`, `payment_dismissed`, `js_error`, `api_error` |
| Server | `registration_completed`, `login_completed`, `payment_initiated`, `payment_failed`, `booking_completed`, `booking_cancelled` |

Adding an event: add it to `BROWSER_EVENTS` here, then call
`track('name', props)` in the frontend (`src/analytics`). A new button only
needs `data-track="snake_case_id"`; give it a friendly name in the dashboard's
`ELEMENT` map.

## Privacy rules (enforced in code)

- No free text, ever: props are ids, enums and small numbers. Filter values are
  the site's own option labels, internal only.
- Only with analytics consent. The banner records each choice in
  `consent_records`.
- Staff pages (`/admin`, `/marketing`, …) and signed-in staff are never tracked.
- Query strings are dropped from stored paths. Third parties (GA4, PostHog,
  Vercel) only get redacted URLs — condition pages become `/topic`, blog posts
  `/blog` (frontend `src/analytics/redact.js`).
- IP and user agent are kept on `booking_attribution` only with advertising
  consent, and nulled after 30 days (`ANALYTICS_IP_RETENTION_DAYS`).
- Raw events are deleted after 13 months; click ids after 90 days.
- The dashboard API returns aggregates only; topic, campaign and region
  breakdowns below 3 bookings show `<3`.

## Tests

`npx jest analytics` — channel classification, page grouping, and what the
collector accepts or drops.

## Dashboard

`/marketing` shows the two reports Koott had on Wix — **Analytics Highlights**
and **Traffic Overview** — plus a live-visitor corner feed. Sales and bookings
come from the `payments` and `sessions` tables; visits, clicks and pages from
first-party events. "Clicks by Google searches" needs `SEARCH_CONSOLE_SITE_URL`
(see `searchConsole.js`).

## Meta (built, not sending)

- **Browser Pixel** (`koott-frontend/src/analytics/meta.js`): PageView,
  ViewContent, Lead, CompleteRegistration, InitiateCheckout, Contact — only with
  advertising consent, never on condition or blog pages, automatic events off.
  Off until `NEXT_PUBLIC_META_PIXEL_ENABLED=true`.
- **Conversions API** (`providers/meta.js`): one Purchase per verified Razorpay
  payment (advertising consent only), event_id `purchase_<payment id>`, hashed
  email/phone, fbp/fbc, IP and user agent, INR value — nothing clinical. While
  `META_CAPI_ENABLED` isn't `true`, each is prepared and held in
  `analytics_outbox` (provider `meta`, status `skipped`). After switching on:
  `node scripts/releaseMetaQueue.js --go` sends the last 7 days of held ones.

## Next

- GA4 Measurement Protocol as a further outbox provider.
- Google Workspace sign-in for `/marketing`, Google Chat alerts.
