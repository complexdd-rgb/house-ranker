import { createClient } from "npm:@supabase/supabase-js@2.111.0";

const VERSION = "1.0";
const RUN_GUARD_MS = 60 * 1000;
const NEUTRAL_UNKNOWN = 60;

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

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function bool(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  return null;
}

function normalizeType(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[–—]/g, "-");
}

function absoluteSpaceScore(area: number) {
  if (area < 50) return 25;
  if (area < 60) return 35;
  if (area < 75) return 50;
  if (area < 90) return 65;
  if (area < 110) return 78;
  if (area < 130) return 88;
  if (area < 160) return 95;
  return 100;
}

function perBedroomSpaceScore(areaPerBedroom: number) {
  if (areaPerBedroom < 18) return 25;
  if (areaPerBedroom < 20) return 35;
  if (areaPerBedroom < 25) return 55;
  if (areaPerBedroom < 30) return 72;
  if (areaPerBedroom < 35) return 85;
  return 100;
}

function spaceScore(areaInput: unknown, bedroomsInput: unknown) {
  const area = num(areaInput);
  const bedrooms = num(bedroomsInput);
  if (area === null || area <= 0) {
    return { score: NEUTRAL_UNKNOWN, known: false, area: null, perBedroom: null };
  }
  const perBedroom = bedrooms && bedrooms > 0 ? area / bedrooms : null;
  const absolute = absoluteSpaceScore(area);
  const score = perBedroom === null
    ? absolute
    : Math.round(0.60 * absolute + 0.40 * perBedroomSpaceScore(perBedroom));
  return {
    score: clamp(score),
    known: true,
    area,
    perBedroom: perBedroom === null ? null : Math.round(perBedroom * 100) / 100,
  };
}

function typeScore(value: unknown) {
  const type = normalizeType(value);
  if (!type || type === "other" || type === "unknown") return { score: NEUTRAL_UNKNOWN, known: false, label: type || "unknown" };
  if (type.includes("detached") && !type.includes("semi")) return { score: 100, known: true, label: type };
  if (type.includes("semi")) return { score: 85, known: true, label: type };
  if (type.includes("bungalow")) return { score: 90, known: true, label: type };
  if (type.includes("end") && type.includes("terr")) return { score: 78, known: true, label: type };
  if (type.includes("terr")) return { score: 70, known: true, label: type };
  if (type.includes("flat") || type.includes("apartment") || type.includes("maisonette")) return { score: 55, known: true, label: type };
  return { score: 65, known: true, label: type };
}

function bedroomScore(value: unknown) {
  const bedrooms = num(value);
  if (bedrooms === null) return { score: NEUTRAL_UNKNOWN, known: false };
  if (bedrooms <= 0) return { score: 20, known: true };
  if (bedrooms === 1) return { score: 35, known: true };
  if (bedrooms === 2) return { score: 55, known: true };
  if (bedrooms === 3) return { score: 80, known: true };
  if (bedrooms === 4) return { score: 95, known: true };
  return { score: 100, known: true };
}

function bathroomScore(value: unknown) {
  const bathrooms = num(value);
  if (bathrooms === null) return { score: NEUTRAL_UNKNOWN, known: false };
  if (bathrooms <= 0) return { score: 25, known: true };
  if (bathrooms === 1) return { score: 60, known: true };
  if (bathrooms === 2) return { score: 90, known: true };
  return { score: 100, known: true };
}

function binaryFeatureScore(value: unknown, noScore: number) {
  const known = bool(value);
  if (known === null) return { score: NEUTRAL_UNKNOWN, known: false };
  return { score: known ? 100 : noScore, known: true };
}

function scoreProperty(row: any) {
  const weights = { space: 40, type: 20, bedrooms: 15, bathrooms: 10, parking: 8, garden: 7 };
  const space = spaceScore(row.floor_area_m2, row.bedrooms);
  const type = typeScore(row.property_type);
  const bedrooms = bedroomScore(row.bedrooms);
  const bathrooms = bathroomScore(row.bathrooms);
  const parking = binaryFeatureScore(row.parking, 40);
  const garden = binaryFeatureScore(row.garden, 35);

  const components = {
    space: space.score,
    type: type.score,
    bedrooms: bedrooms.score,
    bathrooms: bathrooms.score,
    parking: parking.score,
    garden: garden.score,
  };

  const score = clamp(Math.round(
    components.space * weights.space / 100 +
    components.type * weights.type / 100 +
    components.bedrooms * weights.bedrooms / 100 +
    components.bathrooms * weights.bathrooms / 100 +
    components.parking * weights.parking / 100 +
    components.garden * weights.garden / 100
  ));

  const knownWeight =
    (space.known ? weights.space : 0) +
    (type.known ? weights.type : 0) +
    (bedrooms.known ? weights.bedrooms : 0) +
    (bathrooms.known ? weights.bathrooms : 0) +
    (parking.known ? weights.parking : 0) +
    (garden.known ? weights.garden : 0);

  const confidence = clamp(knownWeight);
  const status = confidence >= 90 ? "matched" : "partial";
  const missing = [
    !space.known ? "floor area" : null,
    !type.known ? "property type" : null,
    !bedrooms.known ? "bedrooms" : null,
    !bathrooms.known ? "bathrooms" : null,
    !parking.known ? "parking" : null,
    !garden.known ? "garden" : null,
  ].filter(Boolean);

  return {
    score,
    status,
    confidence,
    components,
    areaM2: space.area,
    spacePerBedroomM2: space.perBedroom,
    missing,
    weights,
    neutralUnknown: NEUTRAL_UNKNOWN,
    formula: "40% space/layout + 20% property type + 15% bedrooms + 10% bathrooms + 8% parking + 7% garden.",
  };
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  let clientKey = anon;
  try {
    clientKey = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}").default || anon;
  } catch {}

  const supabase = createClient(supabaseUrl, clientKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });

  const token = authHeader.replace(/^Bearer\s+/i, "");
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) return json({ error: "Invalid session" }, 401);

  let propertyId = "";
  try { propertyId = String((await req.json())?.propertyId ?? ""); }
  catch { return json({ error: "Invalid JSON body" }, 400); }
  if (!propertyId) return json({ error: "propertyId is required" }, 400);

  const { data: property, error: propertyError } = await supabase
    .from("properties")
    .select("id,address,price,bedrooms,bathrooms,property_type,floor_area_m2,parking,garden,listing_source,listing_data,metrics")
    .eq("id", propertyId)
    .single();
  if (propertyError || !property) return json({ error: "Property not found" }, 404);

  const activeSince = new Date(Date.now() - RUN_GUARD_MS).toISOString();
  const { data: activeRuns } = await supabase.from("enrichment_runs")
    .select("id")
    .eq("property_id", propertyId)
    .eq("source", "property")
    .eq("status", "running")
    .gte("started_at", activeSince)
    .limit(1);
  if (activeRuns?.length) return json({ status: "already_running", property });

  const { data: run } = await supabase.from("enrichment_runs").insert({
    property_id: propertyId,
    source: "property",
    status: "running",
    started_at: new Date().toISOString(),
    payload: { version: VERSION, source: "saved listing + EPC floor area" },
  }).select("id").single();

  const finishRun = async (status: string, payload: unknown, message: string | null = null) => {
    if (!run?.id) return;
    await supabase.from("enrichment_runs").update({
      status,
      finished_at: new Date().toISOString(),
      payload,
      error_message: message,
    }).eq("id", run.id);
  };

  try {
    const result = scoreProperty(property);
    const now = new Date().toISOString();
    const metrics = { ...(property.metrics || {}), property: result.score };
    const updatePayload = {
      property_status: result.status,
      property_score: result.score,
      property_space_score: result.components.space,
      property_type_score: result.components.type,
      property_bedroom_score: result.components.bedrooms,
      property_bathroom_score: result.components.bathrooms,
      property_parking_score: result.components.parking,
      property_garden_score: result.components.garden,
      property_data_confidence: result.confidence,
      property_space_per_bedroom_m2: result.spacePerBedroomM2,
      property_enriched_at: now,
      metrics,
      updated_at: now,
    };

    const { data: updated, error: updateError } = await supabase.from("properties")
      .update(updatePayload)
      .eq("id", propertyId)
      .select("*")
      .single();
    if (updateError) throw updateError;

    await finishRun("succeeded", {
      outcome: result.status,
      version: VERSION,
      score: result.score,
      confidence: result.confidence,
      components: result.components,
      missing: result.missing,
    });

    return json({
      status: result.status,
      version: VERSION,
      score: result.score,
      confidence: result.confidence,
      components: result.components,
      missing: result.missing,
      areaM2: result.areaM2,
      spacePerBedroomM2: result.spacePerBedroomM2,
      property: updated,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const now = new Date().toISOString();
    await supabase.from("properties").update({
      property_status: "error",
      property_enriched_at: now,
      updated_at: now,
    }).eq("id", propertyId);
    await finishRun("failed", { outcome: "error", version: VERSION }, message);
    return json({ error: "Property scoring failed", detail: message, version: VERSION }, 502);
  }
});
