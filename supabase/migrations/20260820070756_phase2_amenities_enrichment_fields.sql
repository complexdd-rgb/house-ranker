alter table public.properties
  add column if not exists amenities_status text not null default 'pending',
  add column if not exists amenities_score smallint,
  add column if not exists amenities_grocery_score smallint,
  add column if not exists amenities_healthcare_score smallint,
  add column if not exists amenities_green_score smallint,
  add column if not exists amenities_centre_score smallint,
  add column if not exists amenities_leisure_score smallint,
  add column if not exists amenities_nearest_supermarket_name text,
  add column if not exists amenities_nearest_supermarket_miles numeric(6,2),
  add column if not exists amenities_nearest_gp_miles numeric(6,2),
  add column if not exists amenities_nearest_pharmacy_miles numeric(6,2),
  add column if not exists amenities_nearest_park_miles numeric(6,2),
  add column if not exists amenities_nearest_playground_miles numeric(6,2),
  add column if not exists amenities_nearest_leisure_miles numeric(6,2),
  add column if not exists amenities_enriched_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'properties_amenities_status_check') then
    alter table public.properties add constraint properties_amenities_status_check
      check (amenities_status in ('pending','matched','partial','needs_location','error'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'properties_amenities_score_check') then
    alter table public.properties add constraint properties_amenities_score_check
      check (amenities_score is null or amenities_score between 0 and 100);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'properties_amenities_component_scores_check') then
    alter table public.properties add constraint properties_amenities_component_scores_check
      check (
        (amenities_grocery_score is null or amenities_grocery_score between 0 and 100) and
        (amenities_healthcare_score is null or amenities_healthcare_score between 0 and 100) and
        (amenities_green_score is null or amenities_green_score between 0 and 100) and
        (amenities_centre_score is null or amenities_centre_score between 0 and 100) and
        (amenities_leisure_score is null or amenities_leisure_score between 0 and 100)
      );
  end if;
end $$;
