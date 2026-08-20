alter table public.properties
  add column if not exists environment_status text not null default 'pending',
  add column if not exists environment_score smallint,
  add column if not exists environment_flood_score smallint,
  add column if not exists environment_green_score smallint,
  add column if not exists environment_road_score smallint,
  add column if not exists environment_landuse_score smallint,
  add column if not exists environment_nearest_green_name text,
  add column if not exists environment_nearest_green_miles numeric(6,2),
  add column if not exists environment_nearest_major_road_name text,
  add column if not exists environment_nearest_major_road_class text,
  add column if not exists environment_nearest_major_road_miles numeric(6,2),
  add column if not exists environment_nearest_industrial_name text,
  add column if not exists environment_nearest_industrial_miles numeric(6,2),
  add column if not exists environment_enriched_at timestamptz;

alter table public.properties
  drop constraint if exists properties_environment_status_check,
  add constraint properties_environment_status_check
    check (environment_status in ('pending','matched','partial','needs_location','error')),
  drop constraint if exists properties_environment_score_check,
  add constraint properties_environment_score_check
    check (environment_score is null or environment_score between 0 and 100),
  drop constraint if exists properties_environment_flood_score_check,
  add constraint properties_environment_flood_score_check
    check (environment_flood_score is null or environment_flood_score between 0 and 100),
  drop constraint if exists properties_environment_green_score_check,
  add constraint properties_environment_green_score_check
    check (environment_green_score is null or environment_green_score between 0 and 100),
  drop constraint if exists properties_environment_road_score_check,
  add constraint properties_environment_road_score_check
    check (environment_road_score is null or environment_road_score between 0 and 100),
  drop constraint if exists properties_environment_landuse_score_check,
  add constraint properties_environment_landuse_score_check
    check (environment_landuse_score is null or environment_landuse_score between 0 and 100);
