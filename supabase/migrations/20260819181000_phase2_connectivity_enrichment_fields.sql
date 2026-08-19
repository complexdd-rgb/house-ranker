alter table public.properties
  add column if not exists connectivity_status text not null default 'pending',
  add column if not exists connectivity_score smallint,
  add column if not exists broadband_score smallint,
  add column if not exists mobile_score smallint,
  add column if not exists broadband_max_download_mbps numeric(8,2),
  add column if not exists broadband_max_upload_mbps numeric(8,2),
  add column if not exists broadband_full_fibre boolean,
  add column if not exists broadband_gigabit boolean,
  add column if not exists mobile_likely_indoor_networks smallint,
  add column if not exists mobile_likely_outdoor_networks smallint,
  add column if not exists connectivity_enriched_at timestamptz;

alter table public.properties drop constraint if exists properties_connectivity_status_check;
alter table public.properties add constraint properties_connectivity_status_check
  check (connectivity_status in ('pending','matched','partial','needs_location','needs_api_keys','error'));

alter table public.properties drop constraint if exists properties_connectivity_score_check;
alter table public.properties add constraint properties_connectivity_score_check
  check (connectivity_score is null or connectivity_score between 0 and 100);
alter table public.properties drop constraint if exists properties_broadband_score_check;
alter table public.properties add constraint properties_broadband_score_check
  check (broadband_score is null or broadband_score between 0 and 100);
alter table public.properties drop constraint if exists properties_mobile_score_check;
alter table public.properties add constraint properties_mobile_score_check
  check (mobile_score is null or mobile_score between 0 and 100);
alter table public.properties drop constraint if exists properties_mobile_likely_indoor_networks_check;
alter table public.properties add constraint properties_mobile_likely_indoor_networks_check
  check (mobile_likely_indoor_networks is null or mobile_likely_indoor_networks between 0 and 4);
alter table public.properties drop constraint if exists properties_mobile_likely_outdoor_networks_check;
alter table public.properties add constraint properties_mobile_likely_outdoor_networks_check
  check (mobile_likely_outdoor_networks is null or mobile_likely_outdoor_networks between 0 and 4);

alter table public.area_metrics add column if not exists connectivity_score numeric;
comment on column public.properties.connectivity_score is 'House Ranker internal 0-100 connectivity score from Ofcom postcode broadband/mobile coverage data; higher is better.';
