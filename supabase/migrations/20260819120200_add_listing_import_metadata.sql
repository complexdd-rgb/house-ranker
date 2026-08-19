alter table public.properties
  add column if not exists listing_source text,
  add column if not exists listing_id text,
  add column if not exists bathrooms smallint check (bathrooms is null or bathrooms >= 0),
  add column if not exists tenure text,
  add column if not exists council_tax_band text,
  add column if not exists latitude numeric(9,6),
  add column if not exists longitude numeric(9,6),
  add column if not exists garden boolean,
  add column if not exists listing_data jsonb not null default '{}'::jsonb,
  add column if not exists listing_imported_at timestamptz;

comment on column public.properties.listing_source is 'Property portal used for URL import, e.g. rightmove.';
comment on column public.properties.listing_id is 'Portal listing identifier extracted from the listing URL/page.';
comment on column public.properties.listing_data is 'Normalized source listing metadata retained for enrichment and audit.';
comment on column public.properties.listing_imported_at is 'Timestamp of the most recent listing URL import.';
