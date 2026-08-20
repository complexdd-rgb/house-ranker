import { createClient } from "npm:@supabase/supabase-js@2.111.0";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const POSTCODE_API = "https://api.postcodes.io";
const RUN_GUARD_MS = 2 * 60 * 1000;
const VERSION = "1.1";
const FALLBACK_FLOOD_SCORE = 60;

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
    headers: { Accept: "application/json", "User-Agent": "House-Ranker/2.1" },
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

type Feature = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  distanceMiles: number;
  tags: Record<string, string>;
  groups: string[];
};

function elementPoint(element: any, originLat: number, originLon: number) {
  if (Array.isArray(element?.geometry) && element.geometry.length) {
    let best: { lat: number; lon: number; distanceMiles: number } | null = null;
    for (const point of element.geometry) {
      const lat = numberOrNull(point?.lat);
      const lon = numberOrNull(point?.lon);
      if (lat === null || lon === null) continue;
      const distanceMiles = haversineMiles(originLat, originLon, lat, lon);
      if (!best || distanceMiles < best.distanceMiles) best = { lat, lon, distanceMiles };
    }
    if (best) return best;
  }
  const lat = numberOrNull(element?.lat ?? element?.center?.lat);
  const lon = numberOrNull(element?.lon ?? element?.center?.lon);
  if (lat === null || lon === null) return null;
  return { lat, lon, distanceMiles: haversineMiles(originLat, originLon, lat, lon) };
}

function classify(tags: Record<string, string>) {
  const groups: string[] = [];
  const leisure = tags.leisure || "";
  const landuse = tags.landuse || "";
  const natural = tags.natural || "";
  const boundary = tags.boundary || "";
  const highway = tags.highway || "";
  const amenity = tags.amenity || "";
  const manMade = tags.man_made || "";

  if (
    leisure === "park" ||
    leisure === "nature_reserve" ||
    landuse === "recreation_ground" ||
    landuse === "forest" ||
    natural === "wood" ||
    natural === "heath" ||
    natural === "grassland" ||
    boundary === "protected_area"
  ) groups.push("green");

  if (["motorway", "trunk", "primary", "secondary"].includes(highway)) groups.push("major_road");

  if (
    ["industrial", "quarry", "landfill"].includes(landuse) ||
    ["waste_disposal", "waste_transfer_station"].includes(amenity) ||
    ["wastewater_plant", "works"].includes(manMade)
  ) groups.push("industrial");

  return [...new Set(groups)];
}

function parseFeatures(elements: any[], latitude: number, longitude: number) {
  const map = new Map<string, Feature>();
  for (const element of elements) {
    const point = elementPoint(element, latitude, longitude);
    if (!point) continue;
    const tags = (element.tags || {}) as Record<string, string>;
    const groups = classify(tags);
    if (!groups.length) continue;
    const distanceMiles = point.distanceMiles;
    if (!Number.isFinite(distanceMiles) || distanceMiles > 4) continue;
    const name = String(tags.name || tags.ref || tags.operator || tags.landuse || tags.highway || tags.natural || "Unnamed").trim();
    const key = `${element.type}/${element.id}`;
    const feature: Feature = {
      id: key,
      name,
      latitude: point.lat,
      longitude: point.lon,
      distanceMiles: round2(distanceMiles),
      tags,
      groups,
    };
    const current = map.get(key);
    if (!current || feature.distanceMiles < current.distanceMiles) map.set(key, feature);
  }
  return [...map.values()].sort((a, b) => a.distanceMiles - b.distanceMiles);
}

async function runOverpass(query: string, label: string) {
  const failures: string[] = [];
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": "House-Ranker/2.1 environment-v1",
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(14000),
      });
      const text = await response.text();
      let payload: any = null;
      try { payload = text ? JSON.parse(text) : null; } catch {}
      if (!response.ok || !Array.isArray(payload?.elements)) {
        throw new Error(`${response.status}: ${text.slice(0, 160)}`);
      }
      return { elements: payload.elements, endpoint, failures };
    } catch (error) {
      failures.push(`${new URL(endpoint).hostname}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`${label} query failed: ${failures.join(" | ")}`);
}

async function loadEnvironmentFeatures(latitude: number, longitude: number) {
  const placesQuery = `[out:json][timeout:12];(
    nwr(around:3500,${latitude},${longitude})[leisure~"^(park|nature_reserve)$"];
    nwr(around:3500,${latitude},${longitude})[landuse~"^(recreation_ground|forest|industrial|quarry|landfill)$"];
    nwr(around:3500,${latitude},${longitude})[natural~"^(wood|heath|grassland)$"];
    nwr(around:3500,${latitude},${longitude})[boundary="protected_area"];
    nwr(around:3500,${latitude},${longitude})[amenity~"^(waste_disposal|waste_transfer_station)$"];
    nwr(around:3500,${latitude},${longitude})[man_made~"^(wastewater_plant|works)$"];
  );out center tags;`;

  const roadsQuery = `[out:json][timeout:12];
    way(around:1800,${latitude},${longitude})[highway~"^(motorway|trunk|primary|secondary)$"];
    out geom tags;`;

  const [places, roads] = await Promise.all([
    runOverpass(placesQuery, "places"),
    runOverpass(roadsQuery, "roads"),
  ]);

  const features = parseFeatures(
    [...places.elements, ...roads.elements],
    latitude,
    longitude,
  );

  return {
    features,
    endpoints: [...new Set([places.endpoint, roads.endpoint])],
    failures: [...places.failures, ...roads.failures],
  };
}

function groupFeatures(features: Feature[], group: string) {
  return features.filter(feature => feature.groups.includes(group));
}

function nearest(features: Feature[], group: string) {
  return groupFeatures(features, group)[0] || null;
}

function countWithin(features: Feature[], group: string, miles: number) {
  return groupFeatures(features, group).filter(feature => feature.distanceMiles <= miles).length;
}

function greenDistanceScore(miles: number | null) {
  if (miles === null) return 0;
  const bands = [[0.25,100],[0.5,92],[0.75,82],[1.25,68],[2,48],[3,28],[4,12]];
  for (const [limit, score] of bands) if (miles <= limit) return score;
  return 0;
}

function roadDistanceScore(miles: number | null, roadClass: string | null) {
  if (miles === null) return 100;
  let score = miles <= 0.08 ? 18
    : miles <= 0.15 ? 32
      : miles <= 0.25 ? 50
        : miles <= 0.4 ? 68
          : miles <= 0.75 ? 84
            : miles <= 1.25 ? 94
              : 100;
  if (["motorway", "trunk"].includes(roadClass || "") && miles <= 0.75) score -= 8;
  else if (roadClass === "primary" && miles <= 0.5) score -= 4;
  return clamp(Math.round(score), 5, 100);
}

function landuseDistanceScore(miles: number | null, nearbyCount: number) {
  if (miles === null) return 100;
  let score = miles <= 0.2 ? 18
    : miles <= 0.4 ? 35
      : miles <= 0.75 ? 55
        : miles <= 1.25 ? 72
          : miles <= 2 ? 86
            : miles <= 3 ? 95
              : 100;
  score -= Math.min(15, Math.max(0, nearbyCount - 1) * 4);
  return clamp(Math.round(score), 5, 100);
}

function scoreEnvironment(features: Feature[], floodScoreInput: unknown) {
  const floodScoreRaw = numberOrNull(floodScoreInput);
  const floodScore = floodScoreRaw === null ? FALLBACK_FLOOD_SCORE : clamp(Math.round(floodScoreRaw));
  const floodAvailable = floodScoreRaw !== null;

  const nearestGreen = nearest(features, "green");
  const greenCount2Miles = countWithin(features, "green", 2);
  const greenChoice = clamp(Math.round((Math.min(greenCount2Miles, 5) / 5) * 100));
  const green = clamp(Math.round(0.75 * greenDistanceScore(nearestGreen?.distanceMiles ?? null) + 0.25 * greenChoice));

  const nearestRoad = nearest(features, "major_road");
  const roadClass = nearestRoad?.tags?.highway || null;
  const road = roadDistanceScore(nearestRoad?.distanceMiles ?? null, roadClass);

  const nearestIndustrial = nearest(features, "industrial");
  const industrialCount1Mile = countWithin(features, "industrial", 1);
  const landuse = landuseDistanceScore(nearestIndustrial?.distanceMiles ?? null, industrialCount1Mile);

  const score = clamp(Math.round(
    0.40 * floodScore +
    0.25 * green +
    0.20 * road +
    0.15 * landuse
  ));

  return {
    score,
    status: floodAvailable ? "matched" : "partial",
    components: { flood: floodScore, green, road, landuse },
    floodAvailable,
    nearest: { green: nearestGreen, road: nearestRoad, industrial: nearestIndustrial },
    counts: {
      green2Miles: greenCount2Miles,
      industrial1Mile: industrialCount1Mile,
      majorRoads1Mile: countWithin(features, "major_road", 1),
    },
    formula: "40% flood resilience + 25% green/open-space access + 20% major-road exposure + 15% industrial/land-use exposure.",
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
    .select("id,address,postcode,latitude,longitude,metrics,flood_status,flood_score,flood_band")
    .eq("id", propertyId)
    .single();
  if (propertyError || !property) return json({ error: "Property not found" }, 404);

  const activeSince = new Date(Date.now() - RUN_GUARD_MS).toISOString();
  const { data: activeRuns } = await supabase
    .from("enrichment_runs")
    .select("id")
    .eq("property_id", propertyId)
    .eq("source", "environment")
    .eq("status", "running")
    .gte("started_at", activeSince)
    .limit(1);
  if (activeRuns?.length) return json({ status: "already_running", property });

  const { data: run } = await supabase
    .from("enrichment_runs")
    .insert({
      property_id: propertyId,
      source: "environment",
      status: "running",
      started_at: new Date().toISOString(),
      payload: { version: VERSION, source: "Environment Agency flood + OpenStreetMap" },
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
        environment_status: "needs_location",
        environment_enriched_at: now,
        updated_at: now,
      }).eq("id", propertyId).select("*").single();
      await finishRun("succeeded", { outcome: "needs_location", version: VERSION });
      return json({ status: "needs_location", version: VERSION, property: updated });
    }

    const loaded = await loadEnvironmentFeatures(location.latitude, location.longitude);
    const result = scoreEnvironment(loaded.features, property.flood_score);
    const metrics = { ...(property.metrics || {}), environment: result.score };

    const updatePayload = {
      postcode: location.postcode || property.postcode || null,
      latitude: location.latitude,
      longitude: location.longitude,
      environment_status: result.status,
      environment_score: result.score,
      environment_flood_score: result.components.flood,
      environment_green_score: result.components.green,
      environment_road_score: result.components.road,
      environment_landuse_score: result.components.landuse,
      environment_nearest_green_name: result.nearest.green?.name ?? null,
      environment_nearest_green_miles: result.nearest.green?.distanceMiles ?? null,
      environment_nearest_major_road_name: result.nearest.road?.name ?? null,
      environment_nearest_major_road_class: result.nearest.road?.tags?.highway ?? null,
      environment_nearest_major_road_miles: result.nearest.road?.distanceMiles ?? null,
      environment_nearest_industrial_name: result.nearest.industrial?.name ?? null,
      environment_nearest_industrial_miles: result.nearest.industrial?.distanceMiles ?? null,
      environment_enriched_at: now,
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
      environment: {
        version: VERSION,
        status: result.status,
        source: "Environment Agency flood screening + OpenStreetMap via Overpass API",
        endpoints: loaded.endpoints,
        locationMethod: location.method,
        score: result.score,
        components: result.components,
        floodAvailable: result.floodAvailable,
        floodBand: property.flood_band || null,
        counts: result.counts,
        nearest: result.nearest,
        formula: result.formula,
        limitations: "V1 uses the existing Environment Agency postcode flood score plus straight-line OpenStreetMap proximity. Major-road distance is a noise/air-quality exposure proxy, not a measured noise or pollution reading. OSM coverage can be incomplete.",
        endpointFailures: loaded.failures,
      },
    };

    const { error: areaError } = await supabase.from("area_metrics").upsert({
      property_id: propertyId,
      environment_score: result.score,
      raw_data: rawData,
      refreshed_at: now,
    }, { onConflict: "property_id" });
    if (areaError) throw areaError;

    await finishRun("succeeded", {
      outcome: result.status,
      version: VERSION,
      score: result.score,
      components: result.components,
      counts: result.counts,
      floodAvailable: result.floodAvailable,
      endpoints: loaded.endpoints,
    });

    return json({
      status: result.status,
      version: VERSION,
      score: result.score,
      components: result.components,
      counts: result.counts,
      nearest: result.nearest,
      floodAvailable: result.floodAvailable,
      property: updated,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const now = new Date().toISOString();
    await supabase.from("properties").update({
      environment_status: "error",
      environment_enriched_at: now,
      updated_at: now,
    }).eq("id", propertyId);
    await finishRun("failed", { outcome: "error", version: VERSION }, message);
    return json({ error: "Environment lookup failed", detail: message, version: VERSION }, 502);
  }
});