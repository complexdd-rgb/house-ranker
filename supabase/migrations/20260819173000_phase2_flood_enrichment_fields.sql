alter table public.properties
  add column if not exists flood_status text not null default 'pending',
  add column if not exists flood_score smallint,
  add column if not exists flood_band text,
  add column if not exists flood_high_count integer,
  add column if not exists flood_medium_count integer,
  add column if not exists flood_low_count integer,
  add column if not exists flood_groundwater_risk text,
  add column if not exists flood_data_date date,
  add column if not exists flood_enriched_at timestamptz;

alter table public.properties drop constraint if exists properties_flood_status_check;
alter table public.properties add constraint properties_flood_status_check
  check (flood_status in ('pending','matched','not_found','error'));

alter table public.properties drop constraint if exists properties_flood_score_check;
alter table public.properties add constraint properties_flood_score_check
  check (flood_score is null or flood_score between 0 and 100);

alter table public.properties drop constraint if exists properties_flood_band_check;
alter table public.properties add constraint properties_flood_band_check
  check (flood_band is null or flood_band in ('very_low','low','medium','high'));

alter table public.properties drop constraint if exists properties_flood_counts_check;
alter table public.properties add constraint properties_flood_counts_check
  check (
    (flood_high_count is null or flood_high_count >= 0) and
    (flood_medium_count is null or flood_medium_count >= 0) and
    (flood_low_count is null or flood_low_count >= 0)
  );
