import { createClient } from "npm:@supabase/supabase-js@2.111.0";

const VERSION = "1.2";
const RUN_GUARD_MS = 60 * 1000;
const HMLR_ENDPOINT = "https://landregistry.data.gov.uk/landregistry/query";
const POSTCODES_IO = "https://api.postcodes.io/postcodes";
const EPC_BASE_URL = "https://api.get-energy-performance-data.communities.gov.uk";
const NEUTRAL_MARKET = 60;
const NEUTRAL_BUDGET = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const NEARBY_RADIUS_M = 1200;

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

function cleanText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function interpolateScore(ratio: number) {
  const points = [
    [0.80, 100], [0.85, 98], [0.90, 94], [0.95, 88], [1.00, 80],
    [1.05, 70], [1.10, 60], [1.15, 50], [1.20, 40], [1.30, 25],
    [1.40, 15], [1.60, 8],
  ];
  if (ratio <= points[0][0]) return points[0][1];
  if (ratio >= points[points.length - 1][0]) return points[points.length - 1][1];
  for (let i = 1; i < points.length; i++) {
    const [x2, y2] = points[i];
    const [x1, y1] = points[i - 1];
    if (ratio <= x2) {
      const t = (ratio - x1) / (x2 - x1);
      return Math.round(y1 + (y2 - y1) * t);
    }
  }
  return 8;
}

function budgetScore(price: number, maxBudget: number | null) {
  if (!maxBudget || maxBudget <= 0) return { score: NEUTRAL_BUDGET, known: false, ratio: null };
  const ratio = price / maxBudget;
  let score = 15;
  if (ratio <= 0.80) score = 100;
  else if (ratio <= 0.90) score = 95;
  else if (ratio <= 0.95) score = 90;
  else if (ratio <= 1.00) score = 82;
  else if (ratio <= 1.05) score = 65;
  else if (ratio <= 1.10) score = 50;
  else if (ratio <= 1.20) score = 30;
  return { score, known: true, ratio };
}

function normalizePostcode(value: unknown) {
  const raw = cleanText(value).toUpperCase();
  const match = raw.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i);
  if (!match) return null;
  const compact = match[1].replace(/\s+/g, "");
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`.toUpperCase();
}

function postcodeFromProperty(row: any) {
  const candidates = [row?.postcode, row?.listing_data?.postcode, row?.listing_data?.resolvedAddress, row?.listing_data?.address, row?.address];
  for (const candidate of candidates) {
    const postcode = normalizePostcode(candidate);
    if (postcode) return postcode;
  }
  return null;
}

function normalizeType(value: unknown) {
  const raw = decodeURIComponent(String(value ?? "")).toLowerCase();
  if (raw.includes("semi")) return "semi";
  if (raw.includes("bungalow")) return "bungalow";
  if (raw.includes("detached")) return "detached";
  if (raw.includes("terr")) return "terraced";
  if (raw.includes("flat") || raw.includes("maisonette") || raw.includes("apartment")) return "flat";
  return "other";
}

function typeFactor(type: string) {
  return ({ detached: 1.12, semi: 1.00, terraced: 0.92, flat: 0.80, bungalow: 1.04, other: 1.00 } as Record<string, number>)[type] ?? 1;
}

function normalizeStreet(value: unknown) {
  return cleanText(value).toUpperCase()
    .replace(/^FLAT\s+[A-Z0-9-]+\s+/i, "")
    .replace(/^\d+[A-Z]?\s+/i, "")
    .replace(/\bROAD\b/g, "RD")
    .replace(/\bSTREET\b/g, "ST")
    .replace(/\bAVENUE\b/g, "AVE")
    .replace(/\bDRIVE\b/g, "DR")
    .replace(/\bLANE\b/g, "LN")
    .replace(/\bCLOSE\b/g, "CL")
    .replace(/\bCRESCENT\b/g, "CRES")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function streetFromProperty(row: any) {
  const raw = cleanText(row?.listing_data?.resolvedAddress || row?.address || row?.listing_data?.address);
  return normalizeStreet(raw.split(",")[0] || raw);
}

function typicalShape(type: string) {
  return ({
    detached: { area: 105, beds: 3.5 },
    semi: { area: 90, beds: 3.0 },
    terraced: { area: 78, beds: 2.7 },
    flat: { area: 65, beds: 2.0 },
    bungalow: { area: 85, beds: 2.5 },
    other: { area: 85, beds: 3.0 },
  } as Record<string, { area: number; beds: number }>)[type] ?? { area: 85, beds: 3 };
}

function fallbackShapeAdjustment(type: string, areaInput: unknown, bedsInput: unknown, tier: string, areaMatchedCount: number) {
  if (areaMatchedCount >= 2 || tier === "same_street_same_type") return 1;
  const shape = typicalShape(type);
  const area = num(areaInput);
  const beds = num(bedsInput);
  const parts: number[] = [];
  if (area && area > 0) parts.push(Math.pow(area / shape.area, 0.35));
  if (beds && beds > 0) parts.push(Math.pow(beds / shape.beds, 0.18));
  if (!parts.length) return 1;
  const raw = parts.reduce((a, b) => a + b, 0) / parts.length;
  const cap = tier.includes("mixed") ? 0.08 : 0.05;
  return Math.max(1 - cap, Math.min(1 + cap, raw));
}

function sparqlEscape(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

type Comparable = {
  price: number;
  date: string;
  propertyType: string;
  paon: string;
  saon: string;
  street: string;
  postcode: string;
  distanceM: number | null;
  floorAreaM2?: number | null;
  adjustedPrice?: number | null;
};

type Evidence = {
  chosen: Comparable[];
  tier: string;
  sameType: boolean;
  sameStreet: boolean;
  windowYears: number;
  removedOutliers: Comparable[];
};

async function nearbyPostcodes(latitude: number | null, longitude: number | null, exactPostcode: string) {
  const distances = new Map<string, number>();
  distances.set(exactPostcode, 0);
  if (latitude === null || longitude === null) return distances;
  try {
    const params = new URLSearchParams({ lon: String(longitude), lat: String(latitude), radius: String(NEARBY_RADIUS_M), limit: "30" });
    const response = await fetch(`${POSTCODES_IO}?${params.toString()}`, {
      headers: { "User-Agent": "House-Ranker/1.2 value postcode lookup" },
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) return distances;
    const payload = await response.json();
    for (const row of Array.isArray(payload?.result) ? payload.result : []) {
      const postcode = normalizePostcode(row?.postcode);
      const distance = num(row?.distance);
      if (postcode && distance !== null && distance <= NEARBY_RADIUS_M) distances.set(postcode, Math.round(distance));
    }
  } catch {}
  return distances;
}

async function fetchComparables(postcodes: string[], distanceMap: Map<string, number>): Promise<Comparable[]> {
  if (!postcodes.length) return [];
  const values = postcodes.map(postcode => `"${sparqlEscape(postcode)}"^^xsd:string`).join(" ");
  const query = `
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX lrppi: <http://landregistry.data.gov.uk/def/ppi/>
PREFIX lrcommon: <http://landregistry.data.gov.uk/def/common/>
SELECT ?amount ?date ?propertyType ?paon ?saon ?street ?postcode
WHERE {
  VALUES ?postcode { ${values} }
  ?addr lrcommon:postcode ?postcode.
  ?tx lrppi:propertyAddress ?addr ;
      lrppi:pricePaid ?amount ;
      lrppi:transactionDate ?date ;
      lrppi:propertyType ?propertyType ;
      lrppi:transactionCategory lrppi:standardPricePaidTransaction.
  OPTIONAL { ?addr lrcommon:paon ?paon }
  OPTIONAL { ?addr lrcommon:saon ?saon }
  OPTIONAL { ?addr lrcommon:street ?street }
}
ORDER BY DESC(?date)
LIMIT 400`;

  const params = new URLSearchParams({ queryLn: "SPARQL", query, limit: "none", infer: "true", output: "json" });
  const response = await fetch(`${HMLR_ENDPOINT}?${params.toString()}`, {
    headers: {
      Accept: "application/sparql-results+json, application/json;q=0.9",
      "User-Agent": "House-Ranker/1.2 price-value comparable lookup",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`HM Land Registry returned ${response.status}`);
  const payload = await response.json();
  const bindings = payload?.results?.bindings ?? [];
  const rows: Comparable[] = bindings.map((b: any) => {
    const postcode = normalizePostcode(b?.postcode?.value) || "";
    return {
      price: Number(b?.amount?.value ?? 0),
      date: String(b?.date?.value ?? ""),
      propertyType: normalizeType(b?.propertyType?.value),
      paon: String(b?.paon?.value ?? ""),
      saon: String(b?.saon?.value ?? ""),
      street: String(b?.street?.value ?? ""),
      postcode,
      distanceM: distanceMap.get(postcode) ?? null,
    };
  }).filter((row: Comparable) => row.price > 0 && row.postcode && /^\d{4}-\d{2}-\d{2}/.test(row.date));

  const latestByAddress = new Map<string, Comparable>();
  for (const row of rows) {
    const key = `${row.postcode}|${row.paon}|${row.saon}|${row.street}`.toUpperCase();
    const existing = latestByAddress.get(key);
    if (!existing || new Date(row.date).getTime() > new Date(existing.date).getTime()) latestByAddress.set(key, row);
  }
  return [...latestByAddress.values()].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

function comparableBaseValue(row: Comparable, targetType: string, sameType: boolean) {
  if (sameType || row.propertyType === targetType || targetType === "other") return row.price;
  const factor = typeFactor(targetType) / typeFactor(row.propertyType);
  return row.price * Math.max(0.85, Math.min(1.18, factor));
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function robustFilter(rows: Comparable[], targetType: string, sameType: boolean) {
  if (rows.length < 3) return { kept: rows, removed: [] as Comparable[] };
  const values = rows.map(row => comparableBaseValue(row, targetType, sameType));
  const med = median(values);
  if (!med || med <= 0) return { kept: rows, removed: [] as Comparable[] };
  const flagged = rows.filter(row => {
    const ratio = comparableBaseValue(row, targetType, sameType) / med;
    return ratio < 0.60 || ratio > 1.67;
  });
  if (!flagged.length) return { kept: rows, removed: [] as Comparable[] };
  const remaining = rows.filter(row => !flagged.includes(row));
  if (remaining.length < 2) return { kept: rows, removed: [] as Comparable[] };
  const remainingValues = remaining.map(row => comparableBaseValue(row, targetType, sameType));
  const remMin = Math.min(...remainingValues);
  const remMax = Math.max(...remainingValues);
  const clustered = remMin > 0 && remMax / remMin <= (rows.length === 3 ? 1.22 : 1.40);
  if (!clustered && rows.length < 5) return { kept: rows, removed: [] as Comparable[] };
  return { kept: remaining, removed: flagged };
}

function withinYears(rows: Comparable[], years: number) {
  const now = Date.now();
  return rows.filter(row => {
    const age = now - new Date(row.date).getTime();
    return age >= 0 && age <= years * 365.25 * DAY_MS;
  });
}

function selectEvidence(rows: Comparable[], targetType: string, targetStreet: string, exactPostcode: string): Evidence {
  const windows = [4, 7, 12];
  for (const windowYears of windows) {
    const pool = withinYears(rows, windowYears);
    const exact = pool.filter(row => row.postcode === exactPostcode);
    const street = exact.filter(row => normalizeStreet(row.street) === targetStreet);
    const tiers = [
      { tier: "same_street_same_type", rows: street.filter(row => row.propertyType === targetType), min: 3, sameType: true, sameStreet: true },
      { tier: "exact_postcode_same_type", rows: exact.filter(row => row.propertyType === targetType), min: 3, sameType: true, sameStreet: false },
      { tier: "nearby_same_type", rows: pool.filter(row => row.propertyType === targetType), min: 5, sameType: true, sameStreet: false },
      { tier: "exact_postcode_mixed", rows: exact, min: 4, sameType: false, sameStreet: false },
      { tier: "nearby_mixed", rows: pool, min: 5, sameType: false, sameStreet: false },
    ];
    for (const option of tiers) {
      if (targetType === "other" && option.sameType) continue;
      const filtered = robustFilter(option.rows, targetType, option.sameType);
      if (filtered.kept.length >= option.min) {
        return { chosen: filtered.kept.slice(0, 30), tier: option.tier, sameType: option.sameType, sameStreet: option.sameStreet, windowYears, removedOutliers: filtered.removed };
      }
    }
  }
  const fallbackPool = withinYears(rows, 12);
  const sameTypeRows = targetType === "other" ? [] : fallbackPool.filter(row => row.propertyType === targetType);
  const useSameType = sameTypeRows.length >= 2;
  const base = useSameType ? sameTypeRows : fallbackPool;
  const filtered = robustFilter(base, targetType, useSameType);
  return { chosen: filtered.kept.slice(0, 30), tier: useSameType ? "fallback_same_type" : "fallback_mixed", sameType: useSameType, sameStreet: false, windowYears: 12, removedOutliers: filtered.removed };
}

function recencyWeight(date: string) {
  const ageDays = Math.max(0, (Date.now() - new Date(date).getTime()) / DAY_MS);
  const halfLifeDays = 730;
  return Math.max(0.10, Math.pow(0.5, ageDays / halfLifeDays));
}

function epcRows(payload: any): any[] {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.items)) return payload.items;
  return Array.isArray(payload) ? payload : [];
}

function epcAddress(row: any) {
  return [row?.addressLine1, row?.addressLine2, row?.addressLine3, row?.addressLine4, row?.postTown].map(cleanText).filter(Boolean).join(", ");
}

function housePart(value: unknown) {
  const first = cleanText(value).split(",")[0] || "";
  const match = first.match(/^(?:FLAT\s+[A-Z0-9-]+\s+)?(\d+[A-Z]?)/i);
  return match?.[1]?.toUpperCase() || "";
}

async function epcSearch(postcode: string, token: string) {
  const params = new URLSearchParams({ postcode, page_size: "500" });
  const response = await fetch(`${EPC_BASE_URL}/api/domestic/search?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) return [];
  return epcRows(await response.json());
}

async function epcDetail(certificateNumber: string, token: string) {
  if (!certificateNumber) return null;
  const params = new URLSearchParams({ certificate_number: certificateNumber });
  try {
    const response = await fetch(`${EPC_BASE_URL}/api/certificate?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(9000),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload?.data ?? payload ?? null;
  } catch { return null; }
}

function certificateNumber(row: any) {
  return cleanText(row?.certificateNumber ?? row?.certificate_number);
}

function detailFloorArea(detail: any, fallback: any) {
  return num(detail?.total_floor_area ?? detail?.totalFloorArea ?? fallback?.totalFloorArea ?? fallback?.total_floor_area);
}

async function addComparableAreas(rows: Comparable[], token: string, subjectArea: number | null) {
  if (!token || !subjectArea || subjectArea <= 0 || !rows.length) return { rows, matchedCount: 0 };
  const cache = new Map<string, any[]>();
  const candidates = rows.slice(0, 10);
  const enriched = await Promise.all(candidates.map(async row => {
    let searchRows = cache.get(row.postcode);
    if (!searchRows) {
      try { searchRows = await epcSearch(row.postcode, token); }
      catch { searchRows = []; }
      cache.set(row.postcode, searchRows);
    }
    const targetHouse = housePart(row.paon || row.saon);
    const targetStreet = normalizeStreet(row.street);
    const match = searchRows.find(candidate => {
      const address = epcAddress(candidate);
      const candidateHouse = housePart(address);
      const candidateStreet = normalizeStreet(address.split(",")[0]);
      return Boolean(targetHouse && candidateHouse === targetHouse && candidateStreet.includes(targetStreet));
    });
    if (!match) return { ...row, floorAreaM2: null };
    const detail = await epcDetail(certificateNumber(match), token);
    return { ...row, floorAreaM2: detailFloorArea(detail, match) };
  }));
  const byKey = new Map(enriched.map(row => [`${row.postcode}|${row.paon}|${row.saon}|${row.street}|${row.date}`, row]));
  const merged = rows.map(row => byKey.get(`${row.postcode}|${row.paon}|${row.saon}|${row.street}|${row.date}`) || row);
  return { rows: merged, matchedCount: enriched.filter(row => num(row.floorAreaM2) && Number(row.floorAreaM2) > 0).length };
}

function adjustedComparablePrice(row: Comparable, targetType: string, sameType: boolean, subjectArea: number | null) {
  let adjusted = comparableBaseValue(row, targetType, sameType);
  const compArea = num(row.floorAreaM2);
  if (subjectArea && subjectArea > 0 && compArea && compArea > 0) {
    const areaRatio = Math.pow(subjectArea / compArea, 0.72);
    adjusted *= Math.max(0.84, Math.min(1.19, areaRatio));
  }
  return adjusted;
}

function recencyWeightedBenchmark(rows: Comparable[], targetType: string, sameType: boolean, subjectArea: number | null) {
  if (!rows.length) return null;
  const points = rows.map(row => ({ value: adjustedComparablePrice(row, targetType, sameType, subjectArea), weight: recencyWeight(row.date) }))
    .filter(point => Number.isFinite(point.value) && point.value > 0 && point.weight > 0)
    .sort((a, b) => a.value - b.value);
  if (!points.length) return null;
  const totalWeight = points.reduce((sum, point) => sum + point.weight, 0);
  let cumulative = 0;
  for (const point of points) {
    cumulative += point.weight;
    if (cumulative >= totalWeight / 2) return point.value;
  }
  return points[points.length - 1].value;
}

function marketConfidence(evidence: Evidence, areaMatchedCount: number, postcodeCount: number, sourceError: string | null) {
  const baseByTier: Record<string, number> = {
    same_street_same_type: 72,
    exact_postcode_same_type: 66,
    nearby_same_type: 60,
    exact_postcode_mixed: 50,
    nearby_mixed: 46,
    fallback_same_type: 42,
    fallback_mixed: 34,
  };
  let confidence = baseByTier[evidence.tier] ?? 30;
  const count = evidence.chosen.length;
  confidence += Math.min(16, Math.max(0, count - 2) * 3);
  if (evidence.windowYears === 4) confidence += 8;
  else if (evidence.windowYears === 7) confidence += 2;
  else confidence -= 5;
  if (areaMatchedCount >= 4) confidence += 8;
  else if (areaMatchedCount >= 2) confidence += 5;
  if (postcodeCount >= 4 && evidence.tier.startsWith("nearby")) confidence += 3;
  if (evidence.removedOutliers.length) confidence -= Math.min(8, evidence.removedOutliers.length * 3);
  if (sourceError) confidence -= 10;
  return clamp(Math.round(confidence));
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
    .select("id,address,postcode,price,bedrooms,property_type,floor_area_m2,latitude,longitude,listing_data,metrics,value_enriched_at")
    .eq("id", propertyId)
    .single();
  if (propertyError || !property) return json({ error: "Property not found" }, 404);

  const activeSince = new Date(Date.now() - RUN_GUARD_MS).toISOString();
  const { data: activeRuns } = await supabase.from("enrichment_runs")
    .select("id").eq("property_id", propertyId).eq("source", "value").eq("status", "running").gte("started_at", activeSince).limit(1);
  if (activeRuns?.length) return json({ status: "already_running", property });

  const { data: run } = await supabase.from("enrichment_runs").insert({
    property_id: propertyId,
    source: "value",
    status: "running",
    started_at: new Date().toISOString(),
    payload: { version: VERSION, source: "HM Land Registry Price Paid Data + EPC floor area + saved budget" },
  }).select("id").single();

  const finishRun = async (status: string, payload: unknown, message: string | null = null) => {
    if (!run?.id) return;
    await supabase.from("enrichment_runs").update({ status, finished_at: new Date().toISOString(), payload, error_message: message }).eq("id", run.id);
  };

  try {
    const price = Number(property.price || 0);
    if (!(price > 0)) throw new Error("Property asking price is missing");

    const postcode = postcodeFromProperty(property);
    const targetType = normalizeType(property.property_type);
    const targetStreet = streetFromProperty(property);
    const subjectArea = num(property.floor_area_m2);
    const latitude = num(property.latitude);
    const longitude = num(property.longitude);

    const { data: prefs } = await supabase.from("user_preferences").select("rules").eq("user_id", userData.user.id).maybeSingle();
    const maxBudget = num(prefs?.rules?.maxBudget);
    const budget = budgetScore(price, maxBudget);

    let allComparables: Comparable[] = [];
    let sourceError: string | null = null;
    let distanceMap = new Map<string, number>();
    if (postcode) {
      distanceMap = await nearbyPostcodes(latitude, longitude, postcode);
      try { allComparables = await fetchComparables([...distanceMap.keys()], distanceMap); }
      catch (error) { sourceError = error instanceof Error ? error.message : String(error); }
    }

    const evidence = selectEvidence(allComparables, targetType, targetStreet, postcode || "");
    const epcToken = Deno.env.get("EPC_BEARER_TOKEN") || "";
    const areaResult = await addComparableAreas(evidence.chosen, epcToken, subjectArea);
    evidence.chosen = areaResult.rows;

    const benchmarkBase = recencyWeightedBenchmark(evidence.chosen, targetType, evidence.sameType, subjectArea);
    const shapeAdjustment = fallbackShapeAdjustment(targetType, subjectArea, property.bedrooms, evidence.tier, areaResult.matchedCount);
    const expectedPrice = benchmarkBase === null ? null : Math.round(benchmarkBase * shapeAdjustment);
    const ratio = expectedPrice && expectedPrice > 0 ? price / expectedPrice : null;
    const rawMarket = ratio === null ? NEUTRAL_MARKET : interpolateScore(ratio);
    const evidenceConfidence = marketConfidence(evidence, areaResult.matchedCount, distanceMap.size, sourceError);
    const reliability = 0.35 + 0.65 * (evidenceConfidence / 100);
    const market = Math.round(NEUTRAL_MARKET + (rawMarket - NEUTRAL_MARKET) * reliability);
    const score = clamp(Math.round(market * 0.80 + budget.score * 0.20));

    const overallConfidence = clamp(Math.round(evidenceConfidence * 0.88 + (budget.known ? 12 : 5)));
    const status = expectedPrice !== null && overallConfidence >= 70 ? "matched" : "partial";
    const pricePerM2 = subjectArea && subjectArea > 0 ? Math.round((price / subjectArea) * 100) / 100 : null;
    const now = new Date().toISOString();

    const compactComparables = evidence.chosen.slice(0, 10).map(row => ({
      price: row.price,
      date: row.date.slice(0, 10),
      propertyType: row.propertyType,
      address: [row.paon, row.saon, row.street].filter(Boolean).join(" "),
      postcode: row.postcode,
      distanceM: row.distanceM,
      floorAreaM2: num(row.floorAreaM2),
      adjustedPrice: Math.round(adjustedComparablePrice(row, targetType, evidence.sameType, subjectArea)),
      recencyWeight: Math.round(recencyWeight(row.date) * 1000) / 1000,
    }));

    const metrics = { ...(property.metrics || {}), value: score };
    const updatePayload = {
      value_status: status,
      value_score: score,
      value_market_score: market,
      value_budget_score: budget.score,
      value_data_confidence: overallConfidence,
      value_comparable_count: evidence.chosen.length,
      value_median_price: benchmarkBase === null ? null : Math.round(benchmarkBase),
      value_expected_price: expectedPrice,
      value_price_vs_expected_pct: ratio === null ? null : Math.round((ratio - 1) * 10000) / 100,
      value_price_per_m2: pricePerM2,
      value_postcode: postcode,
      value_comparables: compactComparables,
      value_enriched_at: now,
      metrics,
      updated_at: now,
    };

    const { data: updated, error: updateError } = await supabase.from("properties").update(updatePayload).eq("id", propertyId).select("*").single();
    if (updateError) throw updateError;

    await finishRun("succeeded", {
      outcome: status,
      version: VERSION,
      score,
      rawMarketScore: rawMarket,
      marketScore: market,
      marketReliability: Math.round(reliability * 1000) / 1000,
      budgetScore: budget.score,
      postcode,
      nearbyPostcodeCount: distanceMap.size,
      comparableCount: evidence.chosen.length,
      evidenceTier: evidence.tier,
      sameType: evidence.sameType,
      sameStreet: evidence.sameStreet,
      windowYears: evidence.windowYears,
      outliersRemoved: evidence.removedOutliers.map(row => ({ price: row.price, date: row.date.slice(0, 10), address: [row.paon, row.street].filter(Boolean).join(" ") })),
      areaMatchedCount: areaResult.matchedCount,
      benchmark: benchmarkBase,
      shapeAdjustment,
      expectedPrice,
      ratio,
      evidenceConfidence,
      confidence: overallConfidence,
      sourceError,
      method: "same-type locality tiers + robust outlier filtering + EPC floor-area adjustment + recency weighting + low-confidence damping",
    });

    return json({
      status,
      version: VERSION,
      score,
      rawMarketScore: rawMarket,
      marketScore: market,
      budgetScore: budget.score,
      confidence: overallConfidence,
      evidenceConfidence,
      postcode,
      comparableCount: evidence.chosen.length,
      evidenceTier: evidence.tier,
      outliersRemoved: evidence.removedOutliers.length,
      areaMatchedCount: areaResult.matchedCount,
      benchmark: benchmarkBase,
      expectedPrice,
      priceVsExpectedPct: ratio === null ? null : Math.round((ratio - 1) * 10000) / 100,
      pricePerM2,
      comparables: compactComparables,
      sourceError,
      property: updated,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const now = new Date().toISOString();
    await supabase.from("properties").update({ value_status: "error", value_enriched_at: now, updated_at: now }).eq("id", propertyId);
    await finishRun("failed", { outcome: "error", version: VERSION }, message);
    return json({ error: "Price & Value scoring failed", detail: message, version: VERSION }, 502);
  }
});
