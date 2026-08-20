import { createClient } from "npm:@supabase/supabase-js@2.111.0";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const POSTCODE_API = "https://api.postcodes.io";
const RUN_GUARD_MS = 2 * 60 * 1000;
const VERSION = "1.0";

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

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function cleanPostcode(value: unknown) {
  const raw = String(value ?? "").toUpperCase().replace(/\s+/g, "").trim();
  return raw.length > 3 ? `${raw.slice(0, -3)} ${raw.slice(-3)}` : raw;
}

function isFullPostcode(value: unknown) {
  return /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(String(value ?? "").trim());
}

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number) {
  const r = 3958.7613;
  const toRad = (degrees: number) => degrees * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function fetchJson(url: string) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "House-Ranker/2.0" },
  });
  const text = await response.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).hostname}: ${text.slice(0, 220)}`);
  return data;
}

async function resolveLocation(postcode: unknown, existingLat: unknown, existingLng: unknown) {
  const lat = numberOrNull(existingLat);
  const lng = numberOrNull(existingLng);
  if (lat !== null && lng !== null) {
    return { latitude: lat, longitude: lng, postcode: cleanPostcode(postcode), method: "saved_coordinates" };
  }
  const cleaned = cleanPostcode(postcode);
  if (!isFullPostcode(cleaned)) return null;
  const payload = await fetchJson(`${POSTCODE_API}/postcodes/${encodeURIComponent(cleaned.replace(/\s+/g, ""))}`);
  const result = payload?.result;
  const resolvedLat = numberOrNull(result?.latitude);
  const resolvedLng = numberOrNull(result?.longitude);
  if (resolvedLat === null || resolvedLng === null) return null;
  return {
    latitude: resolvedLat,
    longitude: resolvedLng,
    postcode: cleanPostcode(result?.postcode || cleaned),
    method: "full_postcode",
  };
}

function distanceScore(miles: number | null, profile: "essential" | "green" | "leisure" | "centre" = "essential") {
  if (miles === null || !Number.isFinite(miles)) return 0;
  const bands = profile === "green"
    ? [[0.25,100],[0.5,90],[0.75,75],[1.25,55],[2,30],[3,10]]
    : profile === "leisure"
      ? [[0.75,100],[1.5,80],[2.5,60],[4,35],[6,10]]
      : profile === "centre"
        ? [[0.35,100],[0.75,90],[1.25,75],[2,55],[3,30],[5,10]]
        : [[0.5,100],[1,90],[1.5,75],[2.5,55],[4,30],[6,10]];
  for (const [limit, score] of bands) if (miles <= limit) return score;
  return 0;
}

function countScore(count: number, target: number) {
  return clamp(Math.round((Math.min(Math.max(0, count), target) / target) * 100));
}

function normaliseName(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

type Poi = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  distanceMiles: number;
  tags: Record<string, string>;
  groups: string[];
};

function elementLatLon(element: any) {
  const lat = numberOrNull(element?.lat ?? element?.center?.lat);
  const lon = numberOrNull(element?.lon ?? element?.center?.lon);
  return lat === null || lon === null ? null : { lat, lon };
}

function classify(tags: Record<string, string>) {
  const groups: string[] = [];
  const shop = tags.shop || "";
  const amenity = tags.amenity || "";
  const healthcare = tags.healthcare || "";
  const leisure = tags.leisure || "";

  if (shop === "supermarket") groups.push("supermarket", "food_shop", "centre_retail");
  if (["convenience","grocery","greengrocer","bakery","butcher"].includes(shop)) groups.push("food_shop", "centre_retail");
  if (["clothes","shoes","chemist","hardware","variety_store","department_store","books","stationery","electronics","mobile_phone","optician"].includes(shop)) groups.push("centre_retail");
  if (["hairdresser","beauty","laundry","dry_cleaning"].includes(shop)) groups.push("centre_personal");

  if (amenity === "doctors" || healthcare === "doctor" || healthcare === "general_practitioner" || healthcare === "clinic") groups.push("gp");
  if (amenity === "pharmacy" || healthcare === "pharmacy") groups.push("pharmacy", "centre_civic");
  if (["cafe","restaurant","fast_food","pub"].includes(amenity)) groups.push("centre_food");
  if (["post_office","bank","library","marketplace"].includes(amenity)) groups.push("centre_civic");
  if (leisure === "park") groups.push("park");
  if (leisure === "playground") groups.push("playground");
  if (["fitness_centre","sports_centre","swimming_pool","sports_hall"].includes(leisure)) groups.push("leisure");

  return [...new Set(groups)];
}

async function loadPois(latitude: number, longitude: number) {
  const query = `[out:json][timeout:20];(
    nwr(around:7000,${latitude},${longitude})[shop~"^(supermarket|convenience|grocery|greengrocer|bakery|butcher|clothes|shoes|chemist|hardware|variety_store|department_store|books|stationery|electronics|mobile_phone|optician|hairdresser|beauty|laundry|dry_cleaning)$"];
    nwr(around:7000,${latitude},${longitude})[amenity~"^(doctors|pharmacy|cafe|restaurant|fast_food|pub|post_office|bank|library|marketplace)$"];
    nwr(around:7000,${latitude},${longitude})[healthcare~"^(doctor|general_practitioner|clinic|pharmacy)$"];
    nwr(around:7000,${latitude},${longitude})[leisure~"^(park|playground|fitness_centre|sports_centre|swimming_pool|sports_hall)$"];
  );out center tags;`;

  const failures: string[] = [];
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": "House-Ranker/2.0 amenities-v1",
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(28000),
      });
      const text = await response.text();
      let payload: any = null;
      try { payload = text ? JSON.parse(text) : null; } catch {}
      if (!response.ok || !Array.isArray(payload?.elements)) {
        throw new Error(`${response.status}: ${text.slice(0, 180)}`);
      }

      const map = new Map<string, Poi>();
      for (const element of payload.elements) {
        const point = elementLatLon(element);
        if (!point) continue;
        const tags = (element.tags || {}) as Record<string, string>;
        const groups = classify(tags);
        if (!groups.length) continue;
        const distanceMiles = haversineMiles(latitude, longitude, point.lat, point.lon);
        if (!Number.isFinite(distanceMiles) || distanceMiles > 7) continue;
        const name = String(tags.name || tags.brand || tags.operator || "Unnamed").trim();
        const key = `${groups.sort().join("+")}|${normaliseName(name)}|${point.lat.toFixed(3)}|${point.lon.toFixed(3)}`;
        const poi: Poi = {
          id: `${element.type}/${element.id}`,
          name,
          latitude: point.lat,
          longitude: point.lon,
          distanceMiles: round2(distanceMiles),
          tags,
          groups,
        };
        const current = map.get(key);
        if (!current || poi.distanceMiles < current.distanceMiles) map.set(key, poi);
      }
      return { pois: [...map.values()].sort((a, b) => a.distanceMiles - b.distanceMiles), endpoint, failures };
    } catch (error) {
      failures.push(`${new URL(endpoint).hostname}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`OpenStreetMap amenity lookup failed: ${failures.join(" | ")}`);
}

function groupPois(pois: Poi[], group: string) {
  return pois.filter(poi => poi.groups.includes(group));
}

function nearest(pois: Poi[], group: string) {
  return groupPois(pois, group)[0] || null;
}

function within(pois: Poi[], group: string, miles: number) {
  return groupPois(pois, group).filter(poi => poi.distanceMiles <= miles);
}

function scoreAmenities(pois: Poi[]) {
  const supermarket = nearest(pois, "supermarket");
  const foodShop = nearest(pois, "food_shop");
  const gp = nearest(pois, "gp");
  const pharmacy = nearest(pois, "pharmacy");
  const park = nearest(pois, "park");
  const playground = nearest(pois, "playground");
  const leisure = nearest(pois, "leisure");

  const supermarketChoice = countScore(within(pois, "supermarket", 3).length, 3);
  const foodChoice = countScore(within(pois, "food_shop", 1.5).length, 6);
  const groceryChoice = Math.round(0.6 * supermarketChoice + 0.4 * foodChoice);
  const grocery = clamp(Math.round(
    0.65 * distanceScore(supermarket?.distanceMiles ?? null) +
    0.15 * distanceScore(foodShop?.distanceMiles ?? null) +
    0.20 * groceryChoice
  ));

  const gpChoice = countScore(within(pois, "gp", 2.5).length, 3);
  const pharmacyChoice = countScore(within(pois, "pharmacy", 2.5).length, 3);
  const healthcareChoice = Math.round(0.5 * gpChoice + 0.5 * pharmacyChoice);
  const healthcare = clamp(Math.round(
    0.40 * distanceScore(gp?.distanceMiles ?? null) +
    0.35 * distanceScore(pharmacy?.distanceMiles ?? null) +
    0.25 * healthcareChoice
  ));

  const parkChoice = countScore(within(pois, "park", 1.5).length, 4);
  const playgroundChoice = countScore(within(pois, "playground", 1.5).length, 4);
  const greenChoice = Math.round(0.6 * parkChoice + 0.4 * playgroundChoice);
  const green = clamp(Math.round(
    0.45 * distanceScore(park?.distanceMiles ?? null, "green") +
    0.30 * distanceScore(playground?.distanceMiles ?? null, "green") +
    0.25 * greenChoice
  ));

  const centreGroups = ["centre_retail", "centre_food", "centre_civic", "centre_personal"];
  const nearbyCentrePois = pois.filter(poi => poi.distanceMiles <= 1.2 && poi.groups.some(group => centreGroups.includes(group)));
  const distinctTypes = centreGroups.filter(group => nearbyCentrePois.some(poi => poi.groups.includes(group))).length;
  const centreDiversity = countScore(distinctTypes, centreGroups.length);
  const centreCount = countScore(nearbyCentrePois.length, 15);
  const centreChoice = Math.round(0.7 * centreDiversity + 0.3 * centreCount);
  const nearestCentrePoi = pois.find(poi => poi.groups.some(group => centreGroups.includes(group))) || null;
  const centre = clamp(Math.round(
    0.45 * distanceScore(nearestCentrePoi?.distanceMiles ?? null, "centre") +
    0.55 * centreChoice
  ));

  const leisureChoice = countScore(within(pois, "leisure", 3).length, 4);
  const leisureScore = clamp(Math.round(
    0.70 * distanceScore(leisure?.distanceMiles ?? null, "leisure") +
    0.30 * leisureChoice
  ));

  const score = clamp(Math.round(
    0.30 * grocery +
    0.20 * healthcare +
    0.20 * green +
    0.20 * centre +
    0.10 * leisureScore
  ));

  return {
    score,
    components: { grocery, healthcare, green, centre, leisure: leisureScore },
    nearest: { supermarket, foodShop, gp, pharmacy, park, playground, leisure, centre: nearestCentrePoi },
    counts: {
      supermarkets3Miles: within(pois, "supermarket", 3).length,
      foodShops1_5Miles: within(pois, "food_shop", 1.5).length,
      gps2_5Miles: within(pois, "gp", 2.5).length,
      pharmacies2_5Miles: within(pois, "pharmacy", 2.5).length,
      parks1_5Miles: within(pois, "park", 1.5).length,
      playgrounds1_5Miles: within(pois, "playground", 1.5).length,
      leisure3Miles: within(pois, "leisure", 3).length,
      centrePois1_2Miles: nearbyCentrePois.length,
      centreDistinctTypes: distinctTypes,
    },
    formula: "30% groceries + 20% healthcare + 20% parks/playgrounds + 20% local-centre usefulness + 10% leisure; each component combines proximity with capped choice.",
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
  try { clientKey = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}").default || anon; } catch {}

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
    .select("id,address,postcode,latitude,longitude,metrics")
    .eq("id", propertyId)
    .single();
  if (propertyError || !property) return json({ error: "Property not found" }, 404);

  const activeSince = new Date(Date.now() - RUN_GUARD_MS).toISOString();
  const { data: activeRuns } = await supabase
    .from("enrichment_runs")
    .select("id")
    .eq("property_id", propertyId)
    .eq("source", "amenities")
    .eq("status", "running")
    .gte("started_at", activeSince)
    .limit(1);
  if (activeRuns?.length) return json({ status: "already_running", property });

  const { data: run } = await supabase
    .from("enrichment_runs")
    .insert({
      property_id: propertyId,
      source: "amenities",
      status: "running",
      started_at: new Date().toISOString(),
      payload: { version: VERSION, source: "OpenStreetMap via Overpass API" },
    })
    .select("id")
    .single();

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
    const location = await resolveLocation(property.postcode, property.latitude, property.longitude);
    const now = new Date().toISOString();

    if (!location) {
      const { data: updated } = await supabase.from("properties").update({
        amenities_status: "needs_location",
        amenities_enriched_at: now,
        updated_at: now,
      }).eq("id", propertyId).select("*").single();
      await finishRun("succeeded", { outcome: "needs_location", version: VERSION });
      return json({ status: "needs_location", version: VERSION, property: updated });
    }

    const loaded = await loadPois(location.latitude, location.longitude);
    const result = scoreAmenities(loaded.pois);
    const metrics = { ...(property.metrics || {}), amenities: result.score };

    const updatePayload = {
      postcode: location.postcode || property.postcode || null,
      latitude: location.latitude,
      longitude: location.longitude,
      amenities_status: "matched",
      amenities_score: result.score,
      amenities_grocery_score: result.components.grocery,
      amenities_healthcare_score: result.components.healthcare,
      amenities_green_score: result.components.green,
      amenities_centre_score: result.components.centre,
      amenities_leisure_score: result.components.leisure,
      amenities_nearest_supermarket_name: result.nearest.supermarket?.name ?? null,
      amenities_nearest_supermarket_miles: result.nearest.supermarket?.distanceMiles ?? null,
      amenities_nearest_gp_miles: result.nearest.gp?.distanceMiles ?? null,
      amenities_nearest_pharmacy_miles: result.nearest.pharmacy?.distanceMiles ?? null,
      amenities_nearest_park_miles: result.nearest.park?.distanceMiles ?? null,
      amenities_nearest_playground_miles: result.nearest.playground?.distanceMiles ?? null,
      amenities_nearest_leisure_miles: result.nearest.leisure?.distanceMiles ?? null,
      amenities_enriched_at: now,
      metrics,
      updated_at: now,
    };

    const { data: updated, error: updateError } = await supabase
      .from("properties")
      .update(updatePayload)
      .eq("id", propertyId)
      .select("*")
      .single();
    if (updateError) throw updateError;

    const { data: area } = await supabase
      .from("area_metrics")
      .select("raw_data")
      .eq("property_id", propertyId)
      .maybeSingle();

    const rawData = {
      ...(area?.raw_data || {}),
      amenities: {
        version: VERSION,
        status: "matched",
        source: "OpenStreetMap via Overpass API",
        endpoint: loaded.endpoint,
        locationMethod: location.method,
        score: result.score,
        components: result.components,
        counts: result.counts,
        nearest: result.nearest,
        formula: result.formula,
        limitations: "V1 measures straight-line access and mapped choice. It does not yet account for opening hours, store size, footpath routing, service quality or live availability.",
        endpointFailures: loaded.failures,
      },
    };

    const { error: areaError } = await supabase.from("area_metrics").upsert({
      property_id: propertyId,
      amenities_score: result.score,
      raw_data: rawData,
      refreshed_at: now,
    }, { onConflict: "property_id" });
    if (areaError) throw areaError;

    await finishRun("succeeded", {
      outcome: "matched",
      version: VERSION,
      score: result.score,
      components: result.components,
      counts: result.counts,
    });

    return json({
      status: "matched",
      version: VERSION,
      score: result.score,
      components: result.components,
      counts: result.counts,
      nearest: result.nearest,
      property: updated,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const now = new Date().toISOString();
    await supabase.from("properties").update({
      amenities_status: "error",
      amenities_enriched_at: now,
      updated_at: now,
    }).eq("id", propertyId);
    await finishRun("failed", { outcome: "error", version: VERSION }, message);
    return json({ error: "Amenities lookup failed", detail: message, version: VERSION }, 502);
  }
});