-- 0031 - the therapist profile fields the Koott 2.0 design shows.
--
-- The profile screen (Figma "Profile v3", 7858:80652) has five blocks the psychologists
-- table had nowhere to store, so each stayed hidden. These columns fill them in. All are
-- optional: a block is drawn only when its field has something in it.
--
--   registration_number  the pill under the name, e.g. "KMC90539"
--   intro_video_url      the "Meet <name>" card; _thumb is its still (the photo is used
--                        when no still is given)
--   approaches           "Approaches I use", one per line:  Title | optional note
--   profile_videos       the video rail, one per line:      Title | thumb URL | video URL
--   profile_media        the Media tab, one per line:
--                        article|Title|5 min read · Oct 2026|page URL|thumb URL
--                        (type is article, video or podcast)
--
-- The three list columns are plain text, one item a line, because that is what the admin
-- form edits; utils/profileLists.js is the one place that reads the format.

alter table psychologists add column if not exists registration_number text;
alter table psychologists add column if not exists intro_video_url     text;
alter table psychologists add column if not exists intro_video_thumb   text;
alter table psychologists add column if not exists approaches          text;
alter table psychologists add column if not exists profile_videos      text;
alter table psychologists add column if not exists profile_media       text;

notify pgrst, 'reload schema';
