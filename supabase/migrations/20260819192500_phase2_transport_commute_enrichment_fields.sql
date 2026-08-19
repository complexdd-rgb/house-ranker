alter table public.properties
  add column if not exists commute_status text not null default 'pending',
  add column if not exists commute_score smallint,
  add column if not exists commute_distance_miles numeric(6,2),
  add column if not exists commute_destination text,
  add column if not exists commute_enriched_at timestamptz,
  add column if not exists transport_status text not null default 'pending',
  add column if not exists transport_score smallint,
  add column if not exists transport_nearest_rail_name text,
  add column if not exists transport_nearest_rail_miles numeric(6,2),
  add column if not exists transport_nearest_bus_miles numeric(6,2),
  add column if not exists transport_bus_stops_half_mile smallint,
  add column if not exists transport_enriched_at timestamptz;

alter table public.properties drop constraint if exists properties_commute_status_check;
alter table public.properties add constraint properties_commute_status_check
  check (commute_status in ('pending','matched','partial','needs_location','error'));

alter table public.properties drop constraint if exists properties_transport_status_check;
alter table public.properties add constraint properties_transport_status_check
  check (transport_status in ('pending','matched','partial','needs_location','error'));

alter table public.properties drop constraint if exists properties_commute_score_check;
alter table public.properties add constraint properties_commute_score_check
  check (commute_score is null or commute_score between 0 and 100);

alter table public.properties drop constraint if exists properties_transport_score_check;
alter table public.properties add constraint properties_transport_score_check
  check (transport_score is null or transport_score between 0 and 100);

alter table public.properties drop constraint if exists properties_transport_bus_stops_half_mile_check;
alter table public.properties add constraint properties_transport_bus_stops_half_mile_check
  check (transport_bus_stops_half_mile is null or transport_bus_stops_half_mile >= 0);

comment on column public.properties.commute_score is 'House Ranker internal 0-100 score from estimated traffic-free driving time to Queen''s Medical Centre; higher is better.';
comment on column public.properties.transport_score is 'House Ranker internal 0-100 public transport access score using NaPTAN rail proximity and nearby bus access; higher is better.';