alter table public.properties
  add column if not exists schools_status text not null default 'pending',
  add column if not exists schools_score smallint,
  add column if not exists schools_primary_score smallint,
  add column if not exists schools_secondary_score smallint,
  add column if not exists schools_nearest_primary_miles numeric(5,2),
  add column if not exists schools_nearest_secondary_miles numeric(5,2),
  add column if not exists schools_enriched_at timestamptz;

alter table public.properties drop constraint if exists properties_schools_status_check;
alter table public.properties add constraint properties_schools_status_check
  check (schools_status in ('pending','matched','needs_location','error'));

alter table public.properties drop constraint if exists properties_schools_score_check;
alter table public.properties add constraint properties_schools_score_check
  check (schools_score is null or schools_score between 0 and 100);

alter table public.properties drop constraint if exists properties_schools_primary_score_check;
alter table public.properties add constraint properties_schools_primary_score_check
  check (schools_primary_score is null or schools_primary_score between 0 and 100);

alter table public.properties drop constraint if exists properties_schools_secondary_score_check;
alter table public.properties add constraint properties_schools_secondary_score_check
  check (schools_secondary_score is null or schools_secondary_score between 0 and 100);
