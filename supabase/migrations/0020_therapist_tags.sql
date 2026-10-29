-- ============================================================================
-- 0020 — the tags a therapist is found by
--
-- Clients filter on price, type, conditions, languages, experience, therapy
-- method and whether sessions are online or in person. Only price, conditions
-- and experience existed. Languages were hardcoded to ['English','Malayalam']
-- in the booking page, so every therapist claimed the same two whatever they
-- actually spoke.
--
-- The values are controlled rather than free text. area_of_expertise shows why:
-- seven therapists typed 37 different conditions, 27 of them used once, with
-- "low mood" beside "depression" and "womens health" missing its apostrophe.
-- The booking filter is built from those values, so it offered 37 options, most
-- matching a single therapist. tag_options holds the allowed values per kind and
-- the admin picks from them.
--
-- Tags stay as array columns on psychologists rather than a junction table:
-- the listing already filters with .contains() on area_of_expertise, so the
-- queries, the indexes and the API shape all keep working.
--
-- Safe to re-run. Re-running re-seeds the vocabulary but never re-maps a
-- therapist's tags, so an admin's later edits are not undone.
-- ============================================================================

-- --------------------------------------------------------------------------
-- 1. The vocabulary
-- --------------------------------------------------------------------------
create table if not exists tag_options (
  id         uuid primary key default gen_random_uuid(),
  -- condition | language | method | type | mode | employment
  kind       text not null,
  -- what is stored on the therapist, and what filters compare
  value      text not null,
  -- what a person reads; may be edited without breaking stored values
  label      text not null,
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  unique (kind, value)
);
create index if not exists tag_options_kind_idx on tag_options (kind, sort_order);
alter table tag_options enable row level security;

-- --------------------------------------------------------------------------
-- 2. The columns
-- --------------------------------------------------------------------------
-- Multi-valued, queried with .contains() like area_of_expertise already is.
alter table psychologists add column if not exists languages       text[] default '{}';
alter table psychologists add column if not exists therapy_methods text[] default '{}';
alter table psychologists add column if not exists session_modes   text[] default '{}';
-- Single-valued. employment_type is internal: clients never see it.
alter table psychologists add column if not exists employment_type text;
-- specialist_category already exists and is empty on every row; it becomes the
-- controlled "type", with designation left as the free-text job title shown on
-- the profile.

-- Array membership is answered by a GIN index; without one every filter is a
-- sequential scan over the whole table.
create index if not exists psychologists_expertise_idx on psychologists using gin (area_of_expertise);
create index if not exists psychologists_languages_idx on psychologists using gin (languages);
create index if not exists psychologists_methods_idx   on psychologists using gin (therapy_methods);
create index if not exists psychologists_modes_idx     on psychologists using gin (session_modes);
create index if not exists psychologists_category_idx  on psychologists (specialist_category);

-- --------------------------------------------------------------------------
-- 3. Seed the vocabulary
-- --------------------------------------------------------------------------
insert into tag_options (kind, value, label, sort_order) values
  -- Conditions. The existing free-text values, tidied and merged where they
  -- plainly meant the same thing; step 4 maps the old spellings onto these.
  ('condition', 'anxiety',              'Anxiety',                      10),
  ('condition', 'social-anxiety',       'Social Anxiety',               20),
  ('condition', 'panic-attacks',        'Panic Attacks',                30),
  ('condition', 'depression',           'Depression',                   40),
  ('condition', 'bipolar',              'Bipolar & Mood Disorders',     50),
  ('condition', 'ocd',                  'OCD',                         60),
  ('condition', 'adhd',                 'ADHD',                        70),
  ('condition', 'stress',               'Stress',                      80),
  ('condition', 'burnout',              'Work Stress & Burnout',       90),
  ('condition', 'sleep',                'Sleep Problems',             100),
  ('condition', 'self-esteem',          'Self-Esteem & Identity',     110),
  ('condition', 'anger',                'Anger Management',           120),
  ('condition', 'grief',                'Grief & Loss',               130),
  ('condition', 'loneliness',           'Loneliness',                 140),
  ('condition', 'life-transitions',     'Life Transitions',           150),
  ('condition', 'relationships',        'Relationships',              160),
  ('condition', 'couples',              'Couples & Marriage',         170),
  ('condition', 'separation',           'Separation & Divorce',       180),
  ('condition', 'family-conflict',      'Family Conflict',            190),
  ('condition', 'parenting',            'Parenting',                  200),
  ('condition', 'child-behaviour',      'Child Behaviour',            210),
  ('condition', 'exam-stress',          'Exam & School Stress',       220),
  ('condition', 'bullying',             'Bullying',                   230),
  ('condition', 'screen-time',          'Screen Time & Gaming',       240),
  ('condition', 'postpartum',           'Postpartum',                 250),
  ('condition', 'womens-health',        'Women''s Health',            260),
  ('condition', 'trauma',               'Trauma & PTSD',              270),
  ('condition', 'addiction',            'Addiction',                  280),
  ('condition', 'eating',               'Eating Concerns',            290),
  ('condition', 'medication-review',    'Medication Review',          300),
  ('condition', 'psychiatric-assessment','Psychiatric Assessment',    310),

  -- Languages. Malayalam first: Koott's clients are Malayali, and the card
  -- names it before the rest.
  ('language', 'malayalam', 'Malayalam', 10),
  ('language', 'english',   'English',   20),
  ('language', 'hindi',     'Hindi',     30),
  ('language', 'tamil',     'Tamil',     40),
  ('language', 'kannada',   'Kannada',   50),
  ('language', 'telugu',    'Telugu',    60),
  ('language', 'arabic',    'Arabic',    70),

  -- Therapy methods.
  ('method', 'cbt',             'CBT (Cognitive Behavioural Therapy)', 10),
  ('method', 'dbt',             'DBT (Dialectical Behaviour Therapy)', 20),
  ('method', 'act',             'ACT (Acceptance & Commitment)',       30),
  ('method', 'rebt',            'REBT',                                40),
  ('method', 'psychodynamic',   'Psychodynamic',                       50),
  ('method', 'person-centred',  'Person-Centred',                      60),
  ('method', 'solution-focused','Solution-Focused Brief Therapy',      70),
  ('method', 'mindfulness',     'Mindfulness-Based',                   80),
  ('method', 'emdr',            'EMDR',                                90),
  ('method', 'family-systems',  'Family Systems',                     100),
  ('method', 'narrative',       'Narrative Therapy',                  110),
  ('method', 'play-therapy',    'Play Therapy',                       120),
  ('method', 'gottman',         'Gottman Method',                     130),

  -- Type. The free-text designations already in use, as a chooseable list.
  ('type', 'clinical-psychologist',   'Clinical Psychologist',          10),
  ('type', 'counselling-psychologist','Counselling Psychologist',       20),
  ('type', 'consultant-psychologist', 'Consultant Psychologist',        30),
  ('type', 'senior-psychologist',     'Senior Psychologist',            40),
  ('type', 'child-psychologist',      'Child & Adolescent Psychologist',50),
  ('type', 'couples-therapist',       'Couples Therapist',              60),
  ('type', 'psychiatrist',            'Psychiatrist',                   70),
  ('type', 'rehabilitation',          'Rehabilitation Psychologist',    80),

  -- How sessions happen.
  ('mode', 'online',  'Online',    10),
  ('mode', 'offline', 'In person', 20),

  -- Internal only: clients never see this.
  ('employment', 'full-time',  'Full time',  10),
  ('employment', 'part-time',  'Part time',  20),
  ('employment', 'freelance',  'Freelance',  30),
  ('employment', 'consultant', 'Consultant', 40)
on conflict (kind, value) do update
  set label = excluded.label, sort_order = excluded.sort_order, is_active = true;

-- --------------------------------------------------------------------------
-- 4. Move the therapists onto the vocabulary
--
-- Only rows that have not been set yet are touched, so re-running this file
-- never overwrites an admin's later choices.
-- --------------------------------------------------------------------------

-- Conditions: old spelling -> controlled value. Anything unrecognised is kept
-- as-is rather than dropped, so nothing is silently lost; those show up in the
-- admin as values outside the list and can be fixed by hand.
with mapping(old, new) as (
  values
    ('anxiety','anxiety'), ('social anxiety','social-anxiety'), ('teen anxiety','anxiety'),
    ('panic attacks','panic-attacks'),
    ('depression','depression'), ('low mood','depression'),
    ('mood disorders','bipolar'), ('bipolar','bipolar'),
    ('ocd','ocd'), ('adhd','adhd'),
    ('stress','stress'), ('work pressure','burnout'), ('burnout','burnout'),
    ('sleep','sleep'),
    ('self-esteem','self-esteem'), ('identity','self-esteem'),
    ('anger','anger'), ('grief','grief'), ('loneliness','loneliness'),
    ('life transitions','life-transitions'),
    ('relationships','relationships'), ('communication','relationships'),
    ('intimacy','couples'), ('infidelity','couples'), ('couples therapy','couples'),
    ('separation','separation'),
    ('family conflict','family-conflict'),
    ('parenting','parenting'), ('child behaviour','child-behaviour'),
    ('school stress','exam-stress'), ('exam pressure','exam-stress'),
    ('bullying','bullying'), ('screen time','screen-time'),
    ('postpartum','postpartum'), ('womens health','womens-health'),
    ('medication review','medication-review'),
    ('psychiatric assessment','psychiatric-assessment')
)
update psychologists p
   set area_of_expertise = sub.mapped
  from (
    select p2.id,
           array(select distinct coalesce(m.new, lower(trim(t)))
                   from unnest(p2.area_of_expertise) as t
                   left join mapping m on m.old = lower(trim(t))
                  order by 1) as mapped
      from psychologists p2
     where p2.area_of_expertise is not null
       and array_length(p2.area_of_expertise, 1) > 0
  ) sub
 where p.id = sub.id;

-- Type, from the job title already written on the row.
update psychologists set specialist_category =
  case
    when designation ilike '%psychiatrist%'              then 'psychiatrist'
    when designation ilike '%child%' or designation ilike '%adolescent%' then 'child-psychologist'
    when designation ilike '%couple%'                    then 'couples-therapist'
    when designation ilike '%clinical%'                  then 'clinical-psychologist'
    when designation ilike '%counselling%'               then 'counselling-psychologist'
    when designation ilike '%senior%'                    then 'senior-psychologist'
    when designation ilike '%consultant%'                then 'consultant-psychologist'
    else null
  end
 where specialist_category is null;

-- Languages. The booking page claimed English and Malayalam for everyone, so
-- that is what the data already implied; an admin can correct each therapist.
update psychologists
   set languages = array['malayalam','english']
 where languages is null or array_length(languages, 1) is null;

-- Every session on Koott is a video call today.
update psychologists
   set session_modes = array['online']
 where session_modes is null or array_length(session_modes, 1) is null;

-- Therapy methods and employment are left empty on purpose: nothing in the
-- database implies them, and a guess here would be read as fact.

notify pgrst, 'reload schema';

-- ============================================================================
-- Rollback:
--   drop table if exists tag_options;
--   alter table psychologists
--     drop column if exists languages,
--     drop column if exists therapy_methods,
--     drop column if exists session_modes,
--     drop column if exists employment_type;
--   (area_of_expertise and specialist_category keep their mapped values)
-- ============================================================================
