import { createClient } from "npm:@supabase/supabase-js@2.111.0";

const VERSION = "1.1";
const RUN_GUARD_MS = 60 * 1000;
const HMLR_ENDPOINT = "https://landregistry.data.gov.uk/landregistry/query";
const NEUTRAL_MARKET = 60;
const NEUTRAL_BUDGET = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  const raw = String(value ?? "").toUpperCase().replace(/\s+/g, " ").trim();
  const match = raw.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i);
  if (!match) return null;
  const compact = match[1].replace(/\s+/g, "");
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`.toUpperCase();
}

function postcodeFromProperty(row: any) {
  const candidates = [
    row?.postcode,
    row?.listing_data?.postcode,
    row?.listing_data?.resolvedAddress,
    row?.listing_data?.address,
    row?.address,
  ];
  for (const candidate of candidates) {
    const postcode = normalizePostcode(candidate);
    if (postcode) return postcode;
  }
  return null;
}

function normalizeType(value: unknown) {
  const raw = decodeURIComponent(String(value ?? "")).toLowerCase();
  if (raw.includes("semi")) return "semi";
  if (raw.includes("detached")) return "detached";
  if (raw.includes("terr")) return "terraced";
  if (raw.includes("flat") || raw.includes("maisonette") || raw.includes("apartment")) return "flat";
  if (raw.includes("bungalow")) return "bungalow";
  return "other";
}

function typeFactor(type: string) {
  return ({ detached: 1.25, semi: 1.00, terraced: 0.90, flat: 0.78, bungalow: 1.05, other: 1.00 } as Record<string, number>)[type] ?? 1;
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

function shapeAdjustment(type: string, areaInput: unknown, bedsInput: unknown) {
  const shape = typicalShape(type);
  const area = num(areaInput);
  const beds = num(bedsInput);
  const parts: number[] = [];
  if (area && area > 0) parts.push(Math.sqrt(area / shape.area));
  if (beds && beds > 0) parts.push(Math.pow(beds / shape.beds, 0.25));
  if (!parts.length) return 1;
  return Math.max(0.90, Math.min(1.10, parts.reduce((a, b) => a + b, 0) / parts.length));
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
};

async function fetchComparables(postcode: string): Promise<Comparable[]> {
  const query = `
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX lrppi: <http://landregistry.data.gov.uk/def/ppi/>
PREFIX lrcommon: <http://landregistry.data.gov.uk/def/common/>
SELECT ?amount ?date ?propertyType ?paon ?saon ?street
WHERE {
  VALUES ?postcode {"${sparqlEscape(postcode)}"^^xsd:string}
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
LIMIT 100`;

  const params = new URLSearchParams({ queryLn: "SPARQL", query, limit: "none", infer: "true", output: "json" });
  const response = await fetch(`${HMLR_ENDPOINT}?${params.toString()}`, {
    headers: {
      Accept: "application/sparql-results+json, application/json;q=0.9",
      "User-Agent": "House-Ranker/1.1 price-value comparable lookup",
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`HM Land Registry returned ${response.status}`);
  const payload = await response.json();
  const bindings = payload?.results?.bindings ?? [];
  const rows: Comparable[] = bindings.map((b: any) => ({
    price: Number(b?.amount?.value ?? 0),
    date: String(b?.date?.value ?? ""),
    propertyType: normalizeType(b?.propertyType?.value),
    paon: String(b?.paon?.value ?? ""),
    saon: String(b?.saon?.value ?? ""),
    street: String(b?.street?.value ?? ""),
  })).filter((row: Comparable) => row.price > 0 && /^\d{4}-\d{2}-\d{2}/.test(row.date));

  const latestByAddress = new Map<string, Comparable>();
  for (const row of rows) {
    const key = `${row.paon}|${row.saon}|${row.street}`.toUpperCase();
    const existing = latestByAddress.get(key);
    if (!existing || new Date(row.date).getTime() > new Date(existing.date).getTime()) latestByAddress.set(key, row);
  }
  return [...latestByAddress.values()].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

function selectEvidence(rows: Comparable[], targetType: string) {
  const now = Date.now();
  const withinYears = (years: number) => rows.filter(row => {
    const age = now - new Date(row.date).getTime();
    return age >= 0 && age <= years * 365.25 * DAY_MS;
  });

  let pool = withinYears(4);
  let windowYears = 4;
  if (pool.length < 3) { pool = withinYears(7); windowYears = 7; }
  if (pool.length < 3) { pool = withinYears(12); windowYears = 12; }

  const sameType = pool.filter(row => row.propertyType === targetType);
  const useSameType = targetType !== "other" && sameType.length >= 3;
  const chosen = (useSameType ? sameType : pool).slice(0, 30);
  return { chosen, sameTypeCount: sameType.length, useSameType, windowYears };
}

function recencyWeight(date: string) {
  const ageDays = Math.max(0, (Date.now() - new Date(date).getTime()) / DAY_MS);
  const halfLifeDays = 548;
  return Math.max(0.05, Math.pow(0.5, ageDays / halfLifeDays));
}

function normalizedComparablePrice(row: Comparable, targetType: string, useSameType: boolean) {
  if (useSameType) return row.price;
  return row.price * (typeFactor(targetType) / typeFactor(row.propertyType));
}

function recencyWeightedBenchmark(rows: Comparable[], targetType: string, useSameType: boolean) {
  if (!rows.length) return null;
  const points = rows.map(row => ({
    value: normalizedComparablePrice(row, targetType, useSameType),
    weight: recencyWeight(row.date),
  })).filter(point => Number.isFinite(point.value) && point.value > 0 && point.weight > 0)
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
    .select("id,address,postcode,price,bedrooms,property_type,floor_area_m2,listing_data,metrics,value_enriched_at")
    .eq("id", propertyId)
    .single();
  if (propertyError || !property) return json({ error: "Property not found" }, 404);

  const activeSince = new Date(Date.now() - RUN_GUARD_MS).toISOString();
  const { data: activeRuns } = await supabase.from("enrichment_runs")
    .select("id")
    .eq("property_id", propertyId)
    .eq("source", "value")
    .eq("status", "running")
    .gte("started_at", activeSince)
    .limit(1);
  if (activeRuns?.length) return json({ status: "already_running", property });

  const { data: run } = await supabase.from("enrichment_runs").insert({
    property_id: propertyId,
    source: "value",
    status: "running",
    started_at: new Date().toISOString(),
    payload: { version: VERSION, source: "HM Land Registry Price Paid Data + saved budget" },
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
    const price = Number(property.price || 0);
    if (!(price > 0)) throw new Error("Property asking price is missing");

    const postcode = postcodeFromProperty(property);
    const targetType = normalizeType(property.property_type);
    const { data: prefs } = await supabase.from("user_preferences")
      .select("rules")
      .eq("user_id", userData.user.id)
      .maybeSingle();
    const maxBudget = num(prefs?.rules?.maxBudget);
    const budget = budgetScore(price, maxBudget);

    let allComparables: Comparable[] = [];
    let sourceError: string | null = null;
    if (postcode) {
      try { allComparables = await fetchComparables(postcode); }
      catch (error) { sourceError = error instanceof Error ? error.message : String(error); }
    }

    const evidence = selectEvidence(allComparables, targetType);
    const benchmark = recencyWeightedBenchmark(evidence.chosen, targetType, evidence.useSameType);
    const adjustment = shapeAdjustment(targetType, property.floor_area_m2, property.bedrooms);
    const expectedPrice = benchmark === null ? null : Math.round(benchmark * adjustment);
    const ratio = expectedPrice && expectedPrice > 0 ? price / expectedPrice : null;
    const market = ratio === null ? NEUTRAL_MARKET : interpolateScore(ratio);
    const score = clamp(Math.round(market * 0.80 + budget.score * 0.20));

    let confidence = 0;
    if (postcode) confidence += 25;
    const count = evidence.chosen.length;
    if (count === 1) confidence += 15;
    else if (count === 2) confidence += 25;
    else if (count <= 4 && count >= 3) confidence += 40;
    else if (count <= 7 && count >= 5) confidence += 50;
    else if (count >= 8) confidence += 55;
    if (evidence.useSameType) confidence += 10;
    if (budget.known) confidence += 10;
    if (count >= 3 && evidence.windowYears <= 4) confidence += 5;
    confidence = clamp(confidence);

    const status = expectedPrice !== null && confidence >= 75 ? "matched" : "partial";
    const floorArea = num(property.floor_area_m2);
    const pricePerM2 = floorArea && floorArea > 0 ? Math.round((price / floorArea) * 100) / 100 : null;
    const now = new Date().toISOString();
    const compactComparables = evidence.chosen.slice(0, 8).map(row => ({
      price: row.price,
      date: row.date.slice(0, 10),
      propertyType: row.propertyType,
      address: [row.paon, row.saon, row.street].filter(Boolean).join(" "),
      recencyWeight: Math.round(recencyWeight(row.date) * 1000) / 1000,
    }));
    const metrics = { ...(property.metrics || {}), value: score };

    const updatePayload = {
      value_status: status,
      value_score: score,
      value_market_score: market,
      value_budget_score: budget.score,
      value_data_confidence: confidence,
      value_comparable_count: count,
      value_median_price: benchmark === null ? null : Math.round(benchmark),
      value_expected_price: expectedPrice,
      value_price_vs_expected_pct: ratio === null ? null : Math.round((ratio - 1) * 10000) / 100,
      value_price_per_m2: pricePerM2,
      value_postcode: postcode,
      value_comparables: compactComparables,
      value_enriched_at: now,
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
      outcome: status,
      version: VERSION,
      score,
      marketScore: market,
      budgetScore: budget.score,
      postcode,
      comparableCount: count,
      sameTypeCount: evidence.sameTypeCount,
      windowYears: evidence.windowYears,
      benchmark,
      expectedPrice,
      ratio,
      confidence,
      sourceError,
      method: "recency-weighted median with ~18 month half-life",
    });

    return json({
      status,
      version: VERSION,
      score,
      marketScore: market,
      budgetScore: budget.score,
      confidence,
      postcode,
      comparableCount: count,
      benchmark,
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
    await supabase.from("properties").update({
      value_status: "error",
      value_enriched_at: now,
      updated_at: now,
    }).eq("id", propertyId);
    await finishRun("failed", { outcome: "error", version: VERSION }, message);
    return json({ error: "Price & Value scoring failed", detail: message, version: VERSION }, 502);
  }
});
