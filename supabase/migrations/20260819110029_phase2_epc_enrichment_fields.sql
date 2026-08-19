alter table public.properties
  add column if not exists epc_certificate_number text,
  add column if not exists epc_uprn text,
  add column if not exists epc_rating smallint,
  add column if not exists epc_band text,
  add column if not exists epc_potential_rating smallint,
  add column if not exists epc_potential_band text,
  add column if not exists epc_registration_date date,
  add column if not exists epc_match_confidence smallint,
  add column if not exists epc_status text not null default 'pending',
  add column if not exists epc_enriched_at timestamptz;

create index if not exists properties_postcode_idx on public.properties (postcode);
create index if not exists properties_epc_uprn_idx on public.properties (epc_uprn);

comment on column public.properties.floor_area_m2 is 'Total floor area in square metres, enriched from the government EPC dataset when available.';
comment on column public.properties.epc_certificate_number is 'Matched government EPC certificate number.';
comment on column public.properties.epc_uprn is 'UPRN returned by the government EPC dataset, stored as text to preserve leading zeroes.';
comment on column public.properties.epc_rating is 'Current EPC numerical energy rating from the matched certificate.';
comment on column public.properties.epc_band is 'Current EPC efficiency band A-G from the matched certificate.';
comment on column public.properties.epc_potential_rating is 'Potential EPC numerical energy rating from the matched certificate when available.';
comment on column public.properties.epc_potential_band is 'Potential EPC efficiency band A-G from the matched certificate when available.';
comment on column public.properties.epc_match_confidence is 'House Ranker address-match confidence from 0-100.';
comment on column public.properties.epc_status is 'EPC enrichment state: pending, matched, no_match, needs_review, error.';
comment on column public.properties.epc_enriched_at is 'Timestamp of the most recent EPC enrichment attempt.';
