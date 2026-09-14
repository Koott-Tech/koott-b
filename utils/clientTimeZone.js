/**
 * Client-facing session times in the client's own time zone.
 *
 * Everything is STORED in IST (Asia/Kolkata) — sessions, dashboards, therapist
 * and admin messages. This module only formats what goes out to the CLIENT
 * (booking email + WhatsApp, reschedule, reminder).
 *
 * Zone source, in order:
 *   1. the browser zone captured at checkout (Razorpay order notes → clientTimeZone)
 *   2. the zone saved on the client row at checkout (clients.time_zone, migration 0005)
 *   3. the country of the client's phone number, for single-zone countries only —
 *      US/CA/AU/RU/BR/MX/ID/… span several zones, so those are never guessed
 *   4. otherwise IST
 */

const { parsePhoneNumberFromString } = require('libphonenumber-js');

const IST = 'Asia/Kolkata';

const COUNTRY_ZONES = {
  IN: IST,
  // Gulf + Middle East
  AE: 'Asia/Dubai', OM: 'Asia/Muscat', SA: 'Asia/Riyadh', QA: 'Asia/Qatar', KW: 'Asia/Kuwait',
  BH: 'Asia/Bahrain', YE: 'Asia/Aden', IQ: 'Asia/Baghdad', IR: 'Asia/Tehran', IL: 'Asia/Jerusalem',
  JO: 'Asia/Amman', LB: 'Asia/Beirut', TR: 'Europe/Istanbul', EG: 'Africa/Cairo', CY: 'Asia/Nicosia',
  // South / South-East / East Asia
  LK: 'Asia/Colombo', MV: 'Indian/Maldives', NP: 'Asia/Kathmandu', BD: 'Asia/Dhaka', PK: 'Asia/Karachi',
  BT: 'Asia/Thimphu', MM: 'Asia/Yangon', SG: 'Asia/Singapore', MY: 'Asia/Kuala_Lumpur', BN: 'Asia/Brunei',
  TH: 'Asia/Bangkok', VN: 'Asia/Ho_Chi_Minh', KH: 'Asia/Phnom_Penh', PH: 'Asia/Manila', HK: 'Asia/Hong_Kong',
  MO: 'Asia/Macau', CN: 'Asia/Shanghai', TW: 'Asia/Taipei', JP: 'Asia/Tokyo', KR: 'Asia/Seoul',
  // Europe
  GB: 'Europe/London', GG: 'Europe/London', JE: 'Europe/London', IM: 'Europe/London', IE: 'Europe/Dublin',
  DE: 'Europe/Berlin', FR: 'Europe/Paris', NL: 'Europe/Amsterdam', BE: 'Europe/Brussels', LU: 'Europe/Luxembourg',
  CH: 'Europe/Zurich', AT: 'Europe/Vienna', IT: 'Europe/Rome', MT: 'Europe/Malta', ES: 'Europe/Madrid',
  PT: 'Europe/Lisbon', SE: 'Europe/Stockholm', NO: 'Europe/Oslo', DK: 'Europe/Copenhagen', FI: 'Europe/Helsinki',
  IS: 'Atlantic/Reykjavik', PL: 'Europe/Warsaw', CZ: 'Europe/Prague', SK: 'Europe/Bratislava', HU: 'Europe/Budapest',
  RO: 'Europe/Bucharest', BG: 'Europe/Sofia', GR: 'Europe/Athens', HR: 'Europe/Zagreb', SI: 'Europe/Ljubljana',
  RS: 'Europe/Belgrade', UA: 'Europe/Kyiv', LT: 'Europe/Vilnius', LV: 'Europe/Riga', EE: 'Europe/Tallinn',
  // Africa
  ZA: 'Africa/Johannesburg', KE: 'Africa/Nairobi', TZ: 'Africa/Dar_es_Salaam', UG: 'Africa/Kampala',
  ET: 'Africa/Addis_Ababa', RW: 'Africa/Kigali', NG: 'Africa/Lagos', GH: 'Africa/Accra', ZM: 'Africa/Lusaka',
  ZW: 'Africa/Harare', BW: 'Africa/Gaborone', MU: 'Indian/Mauritius', SC: 'Indian/Mahe', MA: 'Africa/Casablanca',
  TN: 'Africa/Tunis', DZ: 'Africa/Algiers', LY: 'Africa/Tripoli', SD: 'Africa/Khartoum',
  // Oceania + Americas (single-zone countries only)
  NZ: 'Pacific/Auckland', FJ: 'Pacific/Fiji', AR: 'America/Argentina/Buenos_Aires', CO: 'America/Bogota',
  PE: 'America/Lima', VE: 'America/Caracas', UY: 'America/Montevideo', PY: 'America/Asuncion',
  CR: 'America/Costa_Rica', PA: 'America/Panama', GT: 'America/Guatemala', JM: 'America/Jamaica',
  TT: 'America/Port_of_Spain', GY: 'America/Guyana',
};

function isValidZone(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** ISO country of a phone number; bare 10-digit numbers are Indian (same rule as interaktService). */
function phoneCountry(phone) {
  if (!phone) return null;
  const cleaned = String(phone).trim().replace(/[\s\-().]/g, '');
  if (!cleaned) return null;
  if (/^\d{10}$/.test(cleaned)) return 'IN';
  try {
    const parsed = parsePhoneNumberFromString(cleaned.startsWith('+') ? cleaned : `+${cleaned}`);
    return parsed?.country || null;
  } catch {
    return null;
  }
}

function zoneFromPhone(phone) {
  const tz = COUNTRY_ZONES[phoneCountry(phone)];
  return tz && isValidZone(tz) ? tz : null;
}

function resolveClientTimeZone({ timeZone, phone } = {}) {
  if (isValidZone(timeZone)) return timeZone;
  return zoneFromPhone(phone);
}

/** IST wall-clock date (YYYY-MM-DD) + time (HH:MM[:SS]) → the real instant. */
function istInstant(date, time) {
  const day = String(date || '').slice(0, 10);
  const m = String(time || '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !m) return null;
  const instant = new Date(`${day}T${m[1].padStart(2, '0')}:${m[2]}:00+05:30`);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

const clean = (s) => String(s || '').replace(/[  ]/g, ' ');

function zonePart(instant, tz, style) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: style })
    .formatToParts(instant)
    .find((p) => p.type === 'timeZoneName')?.value || '';
}

function describe(instant, tz) {
  let zoneName = zonePart(instant, tz, 'long');
  // Zones without an English name come back as "GMT+04:00" — use the city instead.
  if (!zoneName || /^GMT/.test(zoneName)) zoneName = `${tz.split('/').pop().replace(/_/g, ' ')} time`;
  const offset = zonePart(instant, tz, 'shortOffset');
  return {
    dateShort: clean(instant.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: tz })),
    dateLong: clean(instant.toLocaleDateString('en-IN', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz })),
    time: clean(instant.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz })),
    dayKey: instant.toLocaleDateString('en-CA', { timeZone: tz }),
    zoneName,
    offset: offset === 'GMT' ? 'GMT+0' : offset,
  };
}

/**
 * Format an IST session start for the client.
 *
 * Returns null when date/time are not raw IST values. Otherwise:
 *   isIst        — client is on IST (India, or unknown zone): nothing to convert
 *   dateShort    — "Mon, 12 Oct 2026" in the client's zone
 *   dateLong     — "Monday, 12 October" in the client's zone
 *   timeLabel    — "7:00 PM Gulf Standard Time (GMT+4)"  |  "10:00 AM IST"
 *   istLabel     — "8:30 PM IST" (+ ", Tue, 13 Oct 2026" when the IST day differs)
 *   combinedLabel— one line for WhatsApp: "7:00 PM Gulf Standard Time (GMT+4) · 8:30 PM IST"
 */
function clientSessionTime({ date, time, timeZone, phone } = {}) {
  const instant = istInstant(date, time);
  if (!instant) return null;

  const tz = resolveClientTimeZone({ timeZone, phone }) || IST;
  const ist = describe(instant, IST);
  const local = tz === IST ? ist : describe(instant, tz);
  const isIst = local.dayKey === ist.dayKey && local.time === ist.time;
  const shown = isIst ? ist : local;

  const istTime = `${ist.time} IST`;
  const istLabel = shown.dayKey === ist.dayKey ? istTime : `${istTime}, ${ist.dateShort}`;
  const timeLabel = isIst ? istTime : `${local.time} ${local.zoneName} (${local.offset})`;

  return {
    timeZone: isIst ? IST : tz,
    isIst,
    dateShort: shown.dateShort,
    dateLong: shown.dateLong,
    time: shown.time,
    zoneName: isIst ? 'IST' : local.zoneName,
    offset: shown.offset,
    timeLabel,
    istLabel,
    istDateShort: ist.dateShort,
    combinedLabel: isIst ? istTime : `${timeLabel} · ${istLabel}`,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const missingZoneColumn = (error) => /time_zone/.test(error?.message || '');

/** { phone, timeZone } by clients.id (or users.id via clients.user_id). */
async function lookupClientContact(clientId) {
  const none = { phone: null, timeZone: null };
  if (!clientId || !UUID_RE.test(String(clientId))) return none;
  try {
    const { supabaseAdmin } = require('../config/supabase');
    for (const column of ['id', 'user_id']) {
      let { data, error } = await supabaseAdmin
        .from('clients')
        .select('phone_number, time_zone')
        .eq(column, clientId)
        .limit(1);
      // Before migration 0005 there is no time_zone column — phone only.
      if (error && missingZoneColumn(error)) {
        ({ data, error } = await supabaseAdmin
          .from('clients')
          .select('phone_number')
          .eq(column, clientId)
          .limit(1));
      }
      const row = !error && data?.[0];
      if (row) {
        return {
          phone: row.phone_number || null,
          timeZone: isValidZone(row.time_zone) ? row.time_zone : null,
        };
      }
    }
  } catch { /* fall through to IST */ }
  return none;
}

async function lookupClientPhone(clientId) {
  return (await lookupClientContact(clientId)).phone;
}

/** Saved zone of the client with this phone number, or null (also null before migration 0005). */
async function clientTimeZoneByPhone(phone) {
  const value = String(phone || '').trim();
  if (!value) return null;
  try {
    const { supabaseAdmin } = require('../config/supabase');
    const { data, error } = await supabaseAdmin
      .from('clients')
      .select('time_zone')
      .eq('phone_number', value)
      .not('time_zone', 'is', null)
      .limit(1);
    const tz = !error && data?.[0]?.time_zone;
    return isValidZone(tz) ? tz : null;
  } catch {
    return null;
  }
}

/** Remember the browser zone captured at checkout. No-op (false) until migration 0005 is applied. */
async function saveClientTimeZone(clientId, timeZone) {
  if (!isValidZone(timeZone) || !clientId || !UUID_RE.test(String(clientId))) return false;
  try {
    const { supabaseAdmin } = require('../config/supabase');
    for (const column of ['id', 'user_id']) {
      const { data, error } = await supabaseAdmin
        .from('clients')
        .update({ time_zone: timeZone })
        .eq(column, clientId)
        .select('id');
      if (error) return false;
      if (data?.length) return true;
    }
  } catch { /* best effort */ }
  return false;
}

/** clientSessionTime, filling in the saved zone / phone from the client row when not passed. */
async function clientSessionTimeFor({ date, time, timeZone, phone, clientId } = {}) {
  let zone = isValidZone(timeZone) ? timeZone : null;
  let resolvedPhone = phone;
  if (!zone && clientId) {
    const contact = await lookupClientContact(clientId);
    zone = contact.timeZone;
    resolvedPhone = resolvedPhone || contact.phone;
  }
  if (!zone && resolvedPhone) zone = await clientTimeZoneByPhone(resolvedPhone);
  return clientSessionTime({ date, time, timeZone: zone, phone: resolvedPhone });
}

module.exports = {
  IST,
  COUNTRY_ZONES,
  isValidZone,
  phoneCountry,
  zoneFromPhone,
  resolveClientTimeZone,
  istInstant,
  clientSessionTime,
  clientSessionTimeFor,
  lookupClientContact,
  lookupClientPhone,
  clientTimeZoneByPhone,
  saveClientTimeZone,
};
