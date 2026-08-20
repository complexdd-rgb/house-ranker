alter table public.properties
  add column if not exists property_status text not null default 'pending',
  add column if not exists property_score smallint,
  add column if not exists property_space_score smallint,
  add column if not exists property_type_score smallint,
  add column if not exists property_bedroom_score smallint,
  add column if not exists property_bathroom_score smallint,
  add column if not exists property_parking_score smallint,
  add column if not exists property_garden_score smallint,
  add column if not exists property_data_confidence smallint,
  add column if not exists property_space_per_bedroom_m2 numeric(6,2),
  add column if not exists property_enriched_at timestamptz;

alter table public.properties
  drop constraint if exists properties_property_status_check,
  add constraint properties_property_status_check
    check (property_status in ('pending','matched','partial','error')),
  drop constraint if exists properties_property_score_check,
  add constraint properties_property_score_check
    check (property_score is null or property_score between 0 and 100),
  drop constraint if exists properties_property_component_scores_check,
  add constraint properties_property_component_scores_check
    check (
      (property_space_score is null or property_space_score between 0 and 100) and
      (property_type_score is null or property_type_score between 0 and 100) and
      (property_bedroom_score is null or property_bedroom_score between 0 and 100) and
      (property_bathroom_score is null or property_bathroom_score between 0 and 100) and
      (property_parking_score is null or property_parking_score between 0 and 100) and
      (property_garden_score is null or property_garden_score between 0 and 100) and
      (property_data_confidence is null or property_data_confidence between 0 and 100)
    );

comment on column public.properties.property_score is 'House Ranker 0-100 property-quality score: 40% space/layout, 20% type, 15% bedrooms, 10% bathrooms, 8% parking, 7% garden.';
comment on column public.properties.property_data_confidence is 'Share of Property V1 component weight backed by known listing/EPC fields; unknown fields use a neutral score and reduce confidence.';
