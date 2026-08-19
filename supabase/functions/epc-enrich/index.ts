import { createClient } from "npm:@supabase/supabase-js@2.111.0";

const EPC_BASE_URL = "https://api.get-energy-performance-data.communities.gov.uk";
const EPC_SOURCE = "MHCLG Energy Certificate Data API";
const MATCH_THRESHOLD = 75;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function cleanPostcode(value: unknown) {
  const raw = String(value ?? "").toUpperCase().replace(/\s+/g, "").trim();
  if (!raw) return "";
  return raw.length > 3 ? `${raw.slice(0, -3)} ${raw.slice(-3)}` : raw;
}

function extractPostcode(value: unknown) {
  const match = String(value ?? "").toUpperCase().match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/);
  return match ? cleanPostcode(match[1]) : "";
}

function normalizeAddress(value: unknown) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/\b(UNIT|APARTMENT)\b/g, "FLAT")
    .replace(/\bROAD\b/g, "RD")
    .replace(/\bSTREET\b/g, "ST")
    .replace(/\bAVENUE\b/g, "AVE")
    .replace(/\bDRIVE\b/g, "DR")
    .replace(/\bLANE\b/g, "LN")
    .replace(/\bCLOSE\b/g, "CL")
    .replace(/\bCOURT\b/g, "CT")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function removePostcode(address: string, postcode: string) {
  const compact = postcode.replace(/\s/g, "");
  if (!compact) return address;
  const escaped = compact.split("").join("\\s*");
  return address.replace(new RegExp(`\\b${escaped}\\b`, "ig"), " ").replace(/\s+/g, " ").trim();
}

function tokens(value: string) {
  return new Set(normalizeAddress(value).split(" ").filter(token => token.length > 1));
}

function jaccard(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = new Set([...left, ...right]).size;
  return union ? intersection / union : 0;
}

function houseIdentifier(value: string) {
  const normalized = normalizeAddress(value);
  const flat = normalized.match(/\bFLAT\s+([A-Z0-9-]+)\b/);
  const house = normalized.match(/\b(\d+[A-Z]?)\b/);
  return `${flat?.[1] ?? ""}|${house?.[1] ?? ""}`;
}

function candidateAddress(candidate: Record<string, unknown>) {
  return [
    candidate.addressLine1,
    candidate.addressLine2,
    candidate.addressLine3,
    candidate.addressLine4,
    candidate.postTown,
  ].filter(Boolean).join(" ");
}

function scoreCandidate(propertyAddress: string, propertyPostcode: string, candidate: Record<string, unknown>) {
  const candidatePostcode = cleanPostcode(candidate.postcode);
  const targetAddress = removePostcode(propertyAddress, propertyPostcode);
  const sourceAddress = candidateAddress(candidate);
  const targetNormalized = normalizeAddress(targetAddress);
  const sourceNormalized = normalizeAddress(sourceAddress);

  if (targetNormalized && targetNormalized === sourceNormalized && (!propertyPostcode || candidatePostcode === propertyPostcode)) {
    return 100;
  }

  let score = 0;
  if (propertyPostcode && candidatePostcode === propertyPostcode) score += 20;

  const targetHouse = houseIdentifier(targetAddress);
  const sourceHouse = houseIdentifier(sourceAddress);
  if (targetHouse !== "|" && sourceHouse !== "|") {
    if (targetHouse === sourceHouse) score += 30;
    else score -= 35;
  }

  const overlap = jaccard(tokens(targetAddress), tokens(sourceAddress));
  score += overlap * 50;

  if (targetNormalized && sourceNormalized && (targetNormalized.includes(sourceNormalized) || sourceNormalized.includes(targetNormalized))) {
    score += 10;
  }

  return clamp(Math.round(score));
}

function getCertificateNumber(candidate: Record<string, unknown>) {
  return String(candidate.certificateNumber ?? candidate.certificate_number ?? "");
}

function getRegistrationDate(candidate: Record<string, unknown>) {
  return String(candidate.registrationDate ?? candidate.registration_date ?? "");
}

function getSearchRows(payload: any): Record<string, unknown>[] {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload)) return payload;
  return [];
}

async function epcGet(path: string, params: URLSearchParams, token: string) {
  const response = await fetch(`${EPC_BASE_URL}${path}?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (response.status === 404) return { status: 404, data: null };
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`EPC API ${response.status}: ${text.slice(0, 300)}`);
  }
  return { status: response.status, data: await response.json() };
}

function pick(source: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function toNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function bandFallbackScore(band: string) {
  return ({ A: 95, B: 85, C: 72, D: 60, E: 47, F: 32, G: 15 } as Record<string, number>)[band] ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const legacyAnon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  let publishableKey = legacyAnon;
  try {
    const publishableKeys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
    publishableKey = publishableKeys.default || legacyAnon;
  } catch {
    publishableKey = legacyAnon;
  }

  const supabase = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });

  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) return json({ error: "Invalid session" }, 401);

  let propertyId = "";
  try {
    const body = await req.json();
    propertyId = String(body?.propertyId ?? "");
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!propertyId) return json({ error: "propertyId is required" }, 400);

  const { data: property, error: propertyError } = await supabase
    .from("properties")
    .select("id,address,postcode,metrics")
    .eq("id", propertyId)
    .single();

  if (propertyError || !property) return json({ error: "Property not found" }, 404);

  const derivedPostcode = cleanPostcode(property.postcode) || extractPostcode(property.address);
  const searchAddress = removePostcode(String(property.address), derivedPostcode);
  const startedAt = new Date().toISOString();

  const { data: run } = await supabase
    .from("enrichment_runs")
    .insert({
      property_id: propertyId,
      source: "epc",
      status: "running",
      started_at: startedAt,
      payload: { address: property.address, postcode: derivedPostcode || null },
    })
    .select("id")
    .single();

  const finishRun = async (status: "succeeded" | "failed", payload: Record<string, unknown>, errorMessage: string | null = null) => {
    if (!run?.id) return;
    await supabase
      .from("enrichment_runs")
      .update({ status, finished_at: new Date().toISOString(), payload, error_message: errorMessage })
      .eq("id", run.id);
  };

  const epcToken = Deno.env.get("EPC_BEARER_TOKEN") ?? "";
  if (!epcToken) {
    await supabase.from("properties").update({ epc_status: "error", epc_enriched_at: new Date().toISOString() }).eq("id", propertyId);
    await finishRun("failed", { reason: "EPC_BEARER_TOKEN missing" }, "EPC bearer token is not configured");
    return json({ error: "EPC bearer token is not configured", code: "EPC_TOKEN_NOT_CONFIGURED" }, 503);
  }

  try {
    let rows: Record<string, unknown>[] = [];

    const primary = new URLSearchParams();
    if (derivedPostcode) primary.set("postcode", derivedPostcode);
    if (searchAddress) primary.set("address", searchAddress);
    primary.set("page_size", "100");

    const primaryResult = await epcGet("/api/domestic/search", primary, epcToken);
    if (primaryResult.data) rows = getSearchRows(primaryResult.data);

    if (!rows.length && derivedPostcode) {
      const fallback = new URLSearchParams({ postcode: derivedPostcode, page_size: "200" });
      const fallbackResult = await epcGet("/api/domestic/search", fallback, epcToken);
      if (fallbackResult.data) rows = getSearchRows(fallbackResult.data);
    }

    if (!rows.length) {
      const now = new Date().toISOString();
      const { data: updated } = await supabase
        .from("properties")
        .update({ postcode: derivedPostcode || property.postcode || null, epc_status: "no_match", epc_enriched_at: now })
        .eq("id", propertyId)
        .select("*")
        .single();
      await finishRun("succeeded", { outcome: "no_match", postcode: derivedPostcode || null });
      return json({ status: "no_match", property: updated });
    }

    const ranked = rows
      .map(candidate => ({
        candidate,
        confidence: scoreCandidate(String(property.address), derivedPostcode, candidate),
        registrationDate: getRegistrationDate(candidate),
      }))
      .sort((a, b) => b.confidence - a.confidence || String(b.registrationDate).localeCompare(String(a.registrationDate)));

    const best = ranked[0];
    const certificateNumber = getCertificateNumber(best.candidate);

    if (!certificateNumber || best.confidence < MATCH_THRESHOLD) {
      const now = new Date().toISOString();
      const { data: updated } = await supabase
        .from("properties")
        .update({
          postcode: derivedPostcode || property.postcode || null,
          epc_match_confidence: best?.confidence ?? null,
          epc_status: "needs_review",
          epc_enriched_at: now,
        })
        .eq("id", propertyId)
        .select("*")
        .single();
      await finishRun("succeeded", {
        outcome: "needs_review",
        confidence: best?.confidence ?? null,
        candidateCount: rows.length,
      });
      return json({ status: "needs_review", confidence: best?.confidence ?? null, property: updated });
    }

    const detailParams = new URLSearchParams({ certificate_number: certificateNumber });
    const detailResult = await epcGet("/api/certificate", detailParams, epcToken);
    const certificate = (detailResult.data?.data ?? detailResult.data ?? {}) as Record<string, unknown>;

    const currentBand = String(pick(certificate, "current_energy_efficiency_band", "currentEnergyEfficiencyBand") ?? best.candidate.currentEnergyEfficiencyBand ?? "").toUpperCase();
    const currentRating = toNumber(pick(certificate, "energy_rating_current", "current_energy_efficiency", "currentEnergyEfficiency", "energyRatingCurrent"));
    const potentialRating = toNumber(pick(certificate, "energy_rating_potential", "potential_energy_efficiency", "potentialEnergyEfficiency", "energyRatingPotential"));
    const potentialBand = String(pick(certificate, "potential_energy_efficiency_band", "potentialEnergyEfficiencyBand") ?? "").toUpperCase();
    const floorArea = toNumber(pick(certificate, "total_floor_area", "totalFloorArea"));
    const uprnValue = pick(certificate, "uprn") ?? best.candidate.uprn ?? null;
    const registrationDate = String(pick(certificate, "registration_date", "registrationDate") ?? best.registrationDate ?? "") || null;
    const certificatePostcode = cleanPostcode(pick(certificate, "postcode") ?? best.candidate.postcode ?? derivedPostcode);

    const fallback = bandFallbackScore(currentBand);
    const energyScore = currentRating !== null ? clamp(Math.round(currentRating)) : fallback;
    if (energyScore === null) throw new Error("Matched EPC did not contain a usable energy rating");

    const metrics = { ...(property.metrics ?? {}), energy: energyScore };
    const now = new Date().toISOString();

    const { data: updatedProperty, error: updateError } = await supabase
      .from("properties")
      .update({
        postcode: certificatePostcode || derivedPostcode || property.postcode || null,
        floor_area_m2: floorArea,
        epc_certificate_number: certificateNumber,
        epc_uprn: uprnValue === null ? null : String(uprnValue),
        epc_rating: currentRating === null ? null : Math.round(currentRating),
        epc_band: currentBand || null,
        epc_potential_rating: potentialRating === null ? null : Math.round(potentialRating),
        epc_potential_band: potentialBand || null,
        epc_registration_date: registrationDate,
        epc_match_confidence: best.confidence,
        epc_status: "matched",
        epc_enriched_at: now,
        metrics,
        updated_at: now,
      })
      .eq("id", propertyId)
      .select("*")
      .single();

    if (updateError) throw updateError;

    const { data: existingAreaMetrics } = await supabase
      .from("area_metrics")
      .select("raw_data")
      .eq("property_id", propertyId)
      .maybeSingle();

    const rawData = {
      ...(existingAreaMetrics?.raw_data ?? {}),
      epc: {
        source: EPC_SOURCE,
        certificateNumber,
        uprn: uprnValue === null ? null : String(uprnValue),
        currentRating,
        currentBand: currentBand || null,
        potentialRating,
        potentialBand: potentialBand || null,
        totalFloorAreaM2: floorArea,
        registrationDate,
        matchConfidence: best.confidence,
        scoreMethod: currentRating !== null ? "epc_numeric_rating_capped_0_100" : "epc_band_midpoint_fallback",
      },
    };

    const { error: areaError } = await supabase
      .from("area_metrics")
      .upsert({
        property_id: propertyId,
        energy_score: energyScore,
        raw_data: rawData,
        refreshed_at: now,
      }, { onConflict: "property_id" });

    if (areaError) throw areaError;

    await finishRun("succeeded", {
      outcome: "matched",
      certificateNumber,
      confidence: best.confidence,
      energyScore,
      floorAreaM2: floorArea,
    });

    return json({
      status: "matched",
      energyScore,
      confidence: best.confidence,
      property: updatedProperty,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const now = new Date().toISOString();
    await supabase.from("properties").update({ epc_status: "error", epc_enriched_at: now }).eq("id", propertyId);
    await finishRun("failed", { outcome: "error" }, message);
    console.error("EPC enrichment failed", { propertyId, message });
    return json({ error: "EPC enrichment failed", detail: message }, 502);
  }
});
