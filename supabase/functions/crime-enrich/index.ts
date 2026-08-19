import { createClient } from "npm:@supabase/supabase-js@2.111.0";

const POLICE_API = "https://data.police.uk/api";
const POSTCODE_API = "https://api.postcodes.io/postcodes";
const SOURCE = "Police.uk street-level crime API";
const MONTHS = 6;
const RADIUS_METRES = 1000;

const CATEGORY_WEIGHTS: Record<string, number> = {
  "violent-crime": 2.0,
  "robbery": 2.5,
  "burglary": 2.0,
  "possession-of-weapons": 2.5,
  "vehicle-crime": 1.5,
  "criminal-damage-arson": 1.5,
  "theft-from-person": 1.5,
  "drugs": 1.2,
  "public-order": 1.1,
  "anti-social-behaviour": 0.75,
  "bicycle-theft": 0.75,
  "other-theft": 0.75,
  "shoplifting": 0.5,
  "other-crime": 1.0
};

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

function isFullPostcode(value: unknown) {
  return /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(String(value ?? "").trim());
}

function toNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function monthsEndingAt(latestMonth: string, count: number) {
  const [year, month] = latestMonth.split("-").map(Number);
  const result: string[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    const d = new Date(Date.UTC(year, month - 1 - offset, 1));
    result.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return result;
}

function polygonAround(lat: number, lng: number, radiusMetres: number, points = 8) {
  const latRadians = lat * Math.PI / 180;
  const latScale = 111320;
  const lngScale = Math.max(1, 111320 * Math.cos(latRadians));
  const coords: string[] = [];
  for (let i = 0; i < points; i += 1) {
    const angle = (Math.PI * 2 * i) / points;
    const pointLat = lat + (Math.sin(angle) * radiusMetres) / latScale;
    const pointLng = lng + (Math.cos(angle) * radiusMetres) / lngScale;
    coords.push(`${pointLat.toFixed(6)},${pointLng.toFixed(6)}`);
  }
  return coords.join(":");
}

function crimeScore(weightedMonthlyAverage: number) {
  return clamp(Math.round(100 - 5 * Math.sqrt(Math.max(0, weightedMonthlyAverage))), 5, 100);
}

async function fetchJson(url: string) {
  const response = await fetch(url, {
    headers: { "Accept": "application/json", "User-Agent": "House-Ranker/1.0" },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} from ${new URL(url).hostname}: ${body.slice(0, 240)}`);
  }
  return response.json();
}

async function resolveCoordinates(postcode: string, existingLat: unknown, existingLng: unknown) {
  const lat = toNumber(existingLat);
  const lng = toNumber(existingLng);
  if (lat !== null && lng !== null) return { lat, lng, method: "listing_coordinates" };

  if (!isFullPostcode(postcode)) return null;
  const compact = postcode.replace(/\s+/g, "");
  const payload = await fetchJson(`${POSTCODE_API}/${encodeURIComponent(compact)}`);
  const result = payload?.result;
  const resolvedLat = toNumber(result?.latitude);
  const resolvedLng = toNumber(result?.longitude);
  if (resolvedLat === null || resolvedLng === null) return null;
  return { lat: resolvedLat, lng: resolvedLng, method: "postcode_centroid_postcodes_io" };
}

function summarizeCategories(crimes: any[]) {
  const counts: Record<string, number> = {};
  let weighted = 0;
  for (const crime of crimes) {
    const category = String(crime?.category ?? "other-crime");
    counts[category] = (counts[category] ?? 0) + 1;
    weighted += CATEGORY_WEIGHTS[category] ?? 1.0;
  }
  return { counts, weighted };
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
    .select("id,address,postcode,latitude,longitude,metrics")
    .eq("id", propertyId)
    .single();

  if (propertyError || !property) return json({ error: "Property not found" }, 404);

  const startedAt = new Date().toISOString();
  const { data: run } = await supabase
    .from("enrichment_runs")
    .insert({
      property_id: propertyId,
      source: "crime",
      status: "running",
      started_at: startedAt,
      payload: { postcode: property.postcode || null, radiusMetres: RADIUS_METRES, months: MONTHS },
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

  try {
    const postcode = cleanPostcode(property.postcode);
    const coordinates = await resolveCoordinates(postcode, property.latitude, property.longitude);
    if (!coordinates) {
      const now = new Date().toISOString();
      const { data: updated } = await supabase
        .from("properties")
        .update({ crime_status: "needs_location", crime_enriched_at: now })
        .eq("id", propertyId)
        .select("*")
        .single();
      await finishRun("succeeded", { outcome: "needs_location", postcode: postcode || null });
      return json({ status: "needs_location", property: updated });
    }

    const latest = await fetchJson(`${POLICE_API}/crime-last-updated`);
    const latestMonth = String(latest?.date ?? "").slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(latestMonth)) throw new Error("Police.uk did not return a valid latest crime month");

    const months = monthsEndingAt(latestMonth, MONTHS);
    const poly = polygonAround(coordinates.lat, coordinates.lng, RADIUS_METRES);

    const monthlyResults = await Promise.all(months.map(async month => {
      const params = new URLSearchParams({ date: month, poly });
      const crimes = await fetchJson(`${POLICE_API}/crimes-street/all-crime?${params.toString()}`);
      const rows = Array.isArray(crimes) ? crimes : [];
      const summary = summarizeCategories(rows);
      return { month, total: rows.length, weighted: summary.weighted, categories: summary.counts };
    }));

    const totalCrimes = monthlyResults.reduce((sum, month) => sum + month.total, 0);
    const weightedTotal = monthlyResults.reduce((sum, month) => sum + month.weighted, 0);
    const monthlyAverage = totalCrimes / MONTHS;
    const weightedMonthlyAverage = weightedTotal / MONTHS;
    const score = crimeScore(weightedMonthlyAverage);

    const categoryTotals: Record<string, number> = {};
    for (const month of monthlyResults) {
      for (const [category, count] of Object.entries(month.categories)) {
        categoryTotals[category] = (categoryTotals[category] ?? 0) + count;
      }
    }

    const topCategories = Object.entries(categoryTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([category, count]) => ({ category, count, weight: CATEGORY_WEIGHTS[category] ?? 1.0 }));

    const metrics = { ...(property.metrics ?? {}), crime: score };
    const now = new Date().toISOString();

    const { data: updatedProperty, error: updateError } = await supabase
      .from("properties")
      .update({
        latitude: coordinates.lat,
        longitude: coordinates.lng,
        crime_status: "matched",
        crime_score: score,
        crime_latest_month: `${latestMonth}-01`,
        crime_monthly_average: Math.round(monthlyAverage * 100) / 100,
        crime_weighted_monthly_average: Math.round(weightedMonthlyAverage * 100) / 100,
        crime_total_6m: totalCrimes,
        crime_enriched_at: now,
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
      crime: {
        source: SOURCE,
        latestMonth,
        months,
        radiusMetres: RADIUS_METRES,
        coordinateMethod: coordinates.method,
        latitude: coordinates.lat,
        longitude: coordinates.lng,
        totalCrimes,
        monthlyAverage: Math.round(monthlyAverage * 100) / 100,
        weightedMonthlyAverage: Math.round(weightedMonthlyAverage * 100) / 100,
        score,
        scoreMethod: "clamp(round(100 - 5 * sqrt(weightedMonthlyAverage)), 5, 100)",
        categoryWeights: CATEGORY_WEIGHTS,
        categoryTotals,
        topCategories,
        monthlyResults,
        locationNote: "Police.uk street-level coordinates are anonymised/approximate; this score represents the surrounding neighbourhood, not the exact property.",
      },
    };

    const { error: areaError } = await supabase
      .from("area_metrics")
      .upsert({
        property_id: propertyId,
        crime_score: score,
        raw_data: rawData,
        refreshed_at: now,
      }, { onConflict: "property_id" });

    if (areaError) throw areaError;

    await finishRun("succeeded", {
      outcome: "matched",
      score,
      latestMonth,
      months,
      totalCrimes,
      monthlyAverage: Math.round(monthlyAverage * 100) / 100,
      weightedMonthlyAverage: Math.round(weightedMonthlyAverage * 100) / 100,
      radiusMetres: RADIUS_METRES,
      topCategories,
    });

    return json({
      status: "matched",
      score,
      latestMonth,
      totalCrimes,
      monthlyAverage: Math.round(monthlyAverage * 100) / 100,
      weightedMonthlyAverage: Math.round(weightedMonthlyAverage * 100) / 100,
      topCategories,
      property: updatedProperty,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const now = new Date().toISOString();
    await supabase.from("properties").update({ crime_status: "error", crime_enriched_at: now }).eq("id", propertyId);
    await finishRun("failed", { outcome: "error" }, message);
    console.error("Crime enrichment failed", { propertyId, message });
    return json({ error: "Crime enrichment failed", detail: message }, 502);
  }
});