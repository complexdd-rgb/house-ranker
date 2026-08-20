alter table public.properties
  add column if not exists value_status text not null default 'pending',
  add column if not exists value_score smallint,
  add column if not exists value_market_score smallint,
  add column if not exists value_budget_score smallint,
  add column if not exists value_data_confidence smallint,
  add column if not exists value_comparable_count integer,
  add column if not exists value_median_price numeric(12,2),
  add column if not exists value_expected_price numeric(12,2),
  add column if not exists value_price_vs_expected_pct numeric(7,2),
  add column if not exists value_price_per_m2 numeric(12,2),
  add column if not exists value_postcode text,
  add column if not exists value_comparables jsonb not null default '[]'::jsonb,
  add column if not exists value_enriched_at timestamptz;

alter table public.properties
  drop constraint if exists properties_value_status_check,
  add constraint properties_value_status_check
    check (value_status in ('pending','matched','partial','error')),
  drop constraint if exists properties_value_score_check,
  add constraint properties_value_score_check
    check (value_score is null or value_score between 0 and 100),
  drop constraint if exists properties_value_component_scores_check,
  add constraint properties_value_component_scores_check
    check (
      (value_market_score is null or value_market_score between 0 and 100) and
      (value_budget_score is null or value_budget_score between 0 and 100) and
      (value_data_confidence is null or value_data_confidence between 0 and 100)
    );

comment on column public.properties.value_score is 'House Ranker Price & Value V1 score. Market value evidence is weighted 80%; fit against the user maximum budget is weighted 20%.';
comment on column public.properties.value_comparables is 'Small cached sample of HM Land Registry Price Paid Data comparables used for Price & Value V1.';
comment on column public.properties.value_data_confidence is 'Confidence in Price & Value V1 based on postcode completeness, comparable count/type match and availability of the user budget.';
