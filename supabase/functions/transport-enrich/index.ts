import { createClient } from "npm:@supabase/supabase-js@2.111.0";

const OSRM_BASE = "https://router.project-osrm.org";
const NAPTAN_API = "https://naptan.api.dft.gov.uk/v1/access-nodes";
const POSTCODE_API = "https://api.postcodes.io";
const QMC = {
  name: "Queen's Medical Centre, Nottingham",
  postcode: "NG7 2UH",
  latitude: 52.943799,
  longitude: -1.185957,
};

const BUS_ATCO_AREAS = ["330", "339", "100", "109"]; // Nottinghamshire, Nottingham, Derbyshire, Derby
const RAIL_ATCO_AREA = "910"; // National rail
const RUN_GUARD_MS = 2 * 60 * 1000;

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

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanPostcode(value: unknown) {
  const raw = String(value ?? "").toUpperCase().replace(/\s+/g, "").trim();
  return raw.length > 3 ? `${raw.slice(0, -3)} ${raw.slice(-3)}` : raw;
}

function isFullPostcode(value: unknown) {
  return /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(String(value ?? "").trim());
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function normaliseStopName(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number) {
  const r = 3958.7613;
  const toRad = (degrees: number) => degrees * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function fetchJson(url: string) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "House-Ranker/1.6" },
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
  const compact = cleaned.replace(/\s+/g, "");
  const payload = await fetchJson(`${POSTCODE_API}/postcodes/${encodeURIComponent(compact)}`);
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

function commuteScore(minutes: number) {
  if (minutes <= 20) return 100;
  if (minutes <= 30) return clamp(Math.round(100 - (minutes - 20) * 2));
  if (minutes <= 40) return clamp(Math.round(80 - (minutes - 30) * 3));
  if (minutes <= 50) return clamp(Math.round(50 - (minutes - 40) * 3));
  if (minutes <= 60) return clamp(Math.round(20 - (minutes - 50) * 2));
  return 0;
}

function railScore(miles: number) {
  if (miles <= 1) return 100;
  if (miles <= 2) return 85;
  if (miles <= 3) return 70;
  if (miles <= 5) return 50;
  if (miles <= 8) return 30;
  if (miles <= 12) return 15;
  return 5;
}

function busDistanceScore(miles: number) {
  if (miles <= 0.15) return 100;
  if (miles <= 0.3) return 90;
  if (miles <= 0.5) return 75;
  if (miles <= 0.8) return 55;
  if (miles <= 1.2) return 35;
  if (miles <= 2) return 15;
  return 5;
}

function busCountScore(count: number) {
  if (count >= 10) return 100;
  if (count >= 7) return 85;
  if (count >= 4) return 70;
  if (count >= 2) return 50;
  if (count >= 1) return 35;
  return 10;
}

function parseCsvLine(line: string) {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function headerIndex(headers: string[], name: string) {
  return headers.findIndex(header => header.trim().toLowerCase() === name.toLowerCase());
}

async function loadNaptanArea(areaCode: string, latitude: number, longitude: number) {
  const response = await fetch(`${NAPTAN_API}?dataFormat=CSV&atcoAreaCodes=${encodeURIComponent(areaCode)}`, {
    headers: { Accept: "text/csv", "User-Agent": "House-Ranker/1.6" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} loading NaPTAN area ${areaCode}: ${text.slice(0, 220)}`);

  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { rail: [], bus: [] };

  const headers = parseCsvLine(lines[0]);
  if (headers[0]) headers[0] = headers[0].replace(/^\uFEFF/, "");
  const idx = {
    name: headerIndex(headers, "CommonName"),
    lat: headerIndex(headers, "Latitude"),
    lon: headerIndex(headers, "Longitude"),
    type: headerIndex(headers, "StopType"),
    status: headerIndex(headers, "Status"),
    atco: headerIndex(headers, "ATCOCode"),
  };

  if (idx.name < 0 || idx.lat < 0 || idx.lon < 0 || idx.type < 0) {
    throw new Error(`NaPTAN area ${areaCode} returned an unexpected CSV schema`);
  }

  const rail: any[] = [];
  const bus: any[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const row = parseCsvLine(lines[i]);
    const status = idx.status >= 0 ? String(row[idx.status] || "").trim().toLowerCase() : "active";
    if (status && status !== "active") continue;

    const stopLat = numberOrNull(row[idx.lat]);
    const stopLon = numberOrNull(row[idx.lon]);
    if (stopLat === null || stopLon === null) continue;

    const distanceMiles = haversineMiles(latitude, longitude, stopLat, stopLon);
    if (!Number.isFinite(distanceMiles) || distanceMiles > 20) continue;

    const stop = {
      name: String(row[idx.name] || "Unnamed stop").trim(),
      atcoCode: idx.atco >= 0 ? String(row[idx.atco] || "").trim() : "",
      latitude: stopLat,
      longitude: stopLon,
      distanceMiles: round2(distanceMiles),
      stopType: String(row[idx.type] || "").trim().toUpperCase(),
      areaCode,
    };

    if (stop.stopType === "RSE") rail.push(stop);
    else if (stop.stopType === "BCT") bus.push(stop);
  }

  return { rail, bus };
}

function dedupeByName(stops: any[]) {
  const map = new Map<string, any>();
  for (const stop of stops) {
    const key = normaliseStopName(stop.name) || stop.atcoCode || `${stop.latitude},${stop.longitude}`;
    const current = map.get(key);
    if (!current || stop.distanceMiles < current.distanceMiles) map.set(key, stop);
  }
  return [...map.values()].sort((a, b) => a.distanceMiles - b.distanceMiles);
}

async function publicTransport(latitude: number, longitude: number) {
  const rawBus: any[] = [];
  const rail: any[] = [];
  const failures: string[] = [];

  const busResults = await Promise.allSettled(
    BUS_ATCO_AREAS.map(areaCode => loadNaptanArea(areaCode, latitude, longitude))
  );

  busResults.forEach((result, index) => {
    const areaCode = BUS_ATCO_AREAS[index];
    if (result.status === "fulfilled") rawBus.push(...result.value.bus);
    else failures.push(`${areaCode}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  });

  try {
    const result = await loadNaptanArea(RAIL_ATCO_AREA, latitude, longitude);
    rail.push(...result.rail);
  } catch (error) {
    failures.push(`${RAIL_ATCO_AREA}: ${error instanceof Error ? error.message : String(error)}`);
  }

  rawBus.sort((a, b) => a.distanceMiles - b.distanceMiles);
  rail.sort((a, b) => a.distanceMiles - b.distanceMiles);

  const busLocations = dedupeByName(rawBus);
  const railStations = dedupeByName(rail);
  const nearestRail = railStations[0] || null;
  const nearestBus = busLocations[0] || null;

  const rawBusStopPointsHalfMile = rawBus.filter(stop => stop.distanceMiles <= 0.5).length;
  const busStopLocationsHalfMile = busLocations.filter(stop => stop.distanceMiles <= 0.5).length;

  const rs = nearestRail ? railScore(nearestRail.distanceMiles) : null;
  const bds = nearestBus ? busDistanceScore(nearestBus.distanceMiles) : null;
  const bcs = busCountScore(busStopLocationsHalfMile);

  let score: number | null = null;
  let status = "error";
  if (rs !== null && bds !== null) {
    score = clamp(Math.round(0.5 * rs + 0.2 * bds + 0.3 * bcs));
    status = failures.length ? "partial" : "matched";
  } else if (rs !== null) {
    score = rs;
    status = "partial";
  } else if (bds !== null) {
    score = clamp(Math.round(0.4 * bds + 0.6 * bcs));
    status = "partial";
  }

  return {
    status,
    score,
    nearestRail,
    nearestBus,
    busStopsHalfMile: busStopLocationsHalfMile,
    busStopLocationsHalfMile,
    rawBusStopPointsHalfMile,
    railScore: rs,
    busDistanceScore: bds,
    busCountScore: bcs,
    failures,
  };
}

async function qmcRoute(latitude: number, longitude: number) {
  const coordinates = `${longitude},${latitude};${QMC.longitude},${QMC.latitude}`;
  const url = `${OSRM_BASE}/route/v1/driving/${coordinates}?overview=false&steps=false`;
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "House-Ranker/1.6" },
  });
  const text = await response.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}

  if (!response.ok || payload?.code !== "Ok" || !payload?.routes?.length) {
    throw new Error(`OSRM route unavailable: ${response.status} ${String(payload?.message || text).slice(0, 180)}`);
  }

  const route = payload.routes[0];
  const minutes = Math.max(1, Math.round(Number(route.duration || 0) / 60));
  const distanceMiles = round2(Number(route.distance || 0) / 1609.344);
  return { minutes, distanceMiles, score: commuteScore(minutes) };
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
    .eq("source", "transport")
    .eq("status", "running")
    .gte("started_at", activeSince)
    .limit(1);
  if (activeRuns?.length) return json({ status: "already_running", property });

  const { data: run } = await supabase
    .from("enrichment_runs")
    .insert({
      property_id: propertyId,
      source: "transport",
      status: "running",
      started_at: new Date().toISOString(),
      payload: { destination: QMC.name, version: "1.1" },
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
        commute_status: "needs_location",
        transport_status: "needs_location",
        commute_enriched_at: now,
        transport_enriched_at: now,
        updated_at: now,
      }).eq("id", propertyId).select("*").single();

      await finishRun("succeeded", { outcome: "needs_location" });
      return json({ status: "needs_location", property: updated });
    }

    const [routeResult, transportResult] = await Promise.allSettled([
      qmcRoute(location.latitude, location.longitude),
      publicTransport(location.latitude, location.longitude),
    ]);

    const route = routeResult.status === "fulfilled" ? routeResult.value : null;
    const transport = transportResult.status === "fulfilled" ? transportResult.value : null;
    const commuteStatus = route ? "matched" : "error";
    const transportStatus = transport?.status || "error";

    const metrics = { ...(property.metrics || {}) };
    if (route?.score !== undefined) metrics.commute = route.score;
    if (transport?.score !== null && transport?.score !== undefined) metrics.transport = transport.score;

    const updatePayload: Record<string, unknown> = {
      postcode: location.postcode || property.postcode || null,
      latitude: location.latitude,
      longitude: location.longitude,
      commute_status: commuteStatus,
      commute_score: route?.score ?? null,
      commute_distance_miles: route?.distanceMiles ?? null,
      commute_destination: QMC.name,
      commute_enriched_at: now,
      transport_status: transportStatus,
      transport_score: transport?.score ?? null,
      transport_nearest_rail_name: transport?.nearestRail?.name ?? null,
      transport_nearest_rail_miles: transport?.nearestRail?.distanceMiles ?? null,
      transport_nearest_bus_miles: transport?.nearestBus?.distanceMiles ?? null,
      transport_bus_stops_half_mile: transport?.busStopLocationsHalfMile ?? null,
      transport_enriched_at: now,
      metrics,
      updated_at: now,
    };
    if (route?.minutes !== undefined) updatePayload.commute_minutes = route.minutes;

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
      transport: {
        version: "1.1",
        status: route && transport?.score !== null
          ? (transportStatus === "matched" ? "matched" : "partial")
          : "partial",
        locationMethod: location.method,
        destination: QMC,
        commute: route ? {
          minutes: route.minutes,
          distanceMiles: route.distanceMiles,
          score: route.score,
          source: "OSRM demo routing service using OpenStreetMap road data",
          traffic: "No live traffic adjustment",
          formula: "100 up to 20 min; then progressively lower to 0 at 60+ min",
        } : {
          error: routeResult.status === "rejected"
            ? String(routeResult.reason?.message || routeResult.reason)
            : "Unavailable",
        },
        publicTransport: transport ? {
          score: transport.score,
          nearestRail: transport.nearestRail,
          nearestBus: transport.nearestBus,
          busStopsHalfMile: transport.busStopLocationsHalfMile,
          busStopLocationsHalfMile: transport.busStopLocationsHalfMile,
          rawBusStopPointsHalfMile: transport.rawBusStopPointsHalfMile,
          componentScores: {
            rail: transport.railScore,
            busDistance: transport.busDistanceScore,
            busCount: transport.busCountScore,
          },
          source: "Department for Transport NaPTAN",
          busAtcoAreas: BUS_ATCO_AREAS,
          railAtcoArea: RAIL_ATCO_AREA,
          formula: "50% rail proximity + 20% nearest bus stop + 30% distinct bus stop locations within 0.5 mile",
          limitations: "V1.1 measures access, not timetable frequency or punctuality. Bus stop counts are deduplicated by CommonName; national rail stations come from ATCO area 910.",
          failures: transport.failures,
        } : {
          error: transportResult.status === "rejected"
            ? String(transportResult.reason?.message || transportResult.reason)
            : "Unavailable",
        },
      },
    };

    const { error: areaError } = await supabase.from("area_metrics").upsert({
      property_id: propertyId,
      transport_score: transport?.score ?? null,
      raw_data: rawData,
      refreshed_at: now,
    }, { onConflict: "property_id" });
    if (areaError) throw areaError;

    const failures: string[] = [];
    if (!route) {
      failures.push(`Commute: ${routeResult.status === "rejected" ? String(routeResult.reason?.message || routeResult.reason) : "Unavailable"}`);
    }
    if (!transport) {
      failures.push(`Transport: ${transportResult.status === "rejected" ? String(transportResult.reason?.message || transportResult.reason) : "Unavailable"}`);
    } else {
      failures.push(...transport.failures.map((failure: string) => `NaPTAN ${failure}`));
    }

    const overallStatus = route && transport?.score !== null
      ? (transportStatus === "matched" ? "matched" : "partial")
      : "partial";

    await finishRun("succeeded", {
      outcome: overallStatus,
      version: "1.1",
      commuteMinutes: route?.minutes ?? null,
      commuteScore: route?.score ?? null,
      transportScore: transport?.score ?? null,
      nearestRail: transport?.nearestRail ?? null,
      busStopLocationsHalfMile: transport?.busStopLocationsHalfMile ?? null,
      rawBusStopPointsHalfMile: transport?.rawBusStopPointsHalfMile ?? null,
      failures,
    }, failures.length ? failures.join(" | ") : null);

    return json({
      status: overallStatus,
      version: "1.1",
      commuteStatus,
      transportStatus,
      commuteMinutes: route?.minutes ?? null,
      commuteDistanceMiles: route?.distanceMiles ?? null,
      commuteScore: route?.score ?? null,
      transportScore: transport?.score ?? null,
      nearestRail: transport?.nearestRail ?? null,
      nearestBus: transport?.nearestBus ?? null,
      busStopsHalfMile: transport?.busStopLocationsHalfMile ?? null,
      rawBusStopPointsHalfMile: transport?.rawBusStopPointsHalfMile ?? null,
      property: updated,
      failures,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const now = new Date().toISOString();
    await supabase.from("properties").update({
      commute_status: "error",
      transport_status: "error",
      commute_enriched_at: now,
      transport_enriched_at: now,
      updated_at: now,
    }).eq("id", propertyId);
    await finishRun("failed", { outcome: "error", version: "1.1" }, message);
    return json({ error: "Transport lookup failed", detail: message }, 502);
  }
});