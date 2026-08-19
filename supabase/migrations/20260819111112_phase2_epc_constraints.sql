alter table public.properties
  add constraint properties_epc_status_check
    check (epc_status = any (array['pending'::text, 'matched'::text, 'no_match'::text, 'needs_review'::text, 'error'::text])),
  add constraint properties_epc_band_check
    check (epc_band is null or epc_band = any (array['A'::text, 'B'::text, 'C'::text, 'D'::text, 'E'::text, 'F'::text, 'G'::text])),
  add constraint properties_epc_potential_band_check
    check (epc_potential_band is null or epc_potential_band = any (array['A'::text, 'B'::text, 'C'::text, 'D'::text, 'E'::text, 'F'::text, 'G'::text])),
  add constraint properties_epc_match_confidence_check
    check (epc_match_confidence is null or (epc_match_confidence between 0 and 100)),
  add constraint properties_floor_area_positive_check
    check (floor_area_m2 is null or floor_area_m2 > 0);
