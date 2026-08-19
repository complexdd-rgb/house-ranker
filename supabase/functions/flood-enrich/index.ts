import { createClient } from "npm:@supabase/supabase-js@2.111.0";

const DATASET_PACKAGE_API = "https://ckan.publishing.service.gov.uk/api/3/action/package_show?id=flood-risk-postcode-search-tool-data";
const SOURCE_PAGE = "https://environment.data.gov.uk/flood-risk-postcode-tool";
const OFFICIAL_CHECKER = "https://www.gov.uk/check-long-term-flood-risk";
const SOURCE_NAME = "Environment Agency Flood risk: Postcode search tool data";
const RUN_GUARD_MS = 4 * 60 * 1000;

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

function cleanPostcode(value: unknown) {
  const raw = String(value ?? "").toUpperCase().replace(/\s+/g, "").trim();
  if (!raw) return "";
  return raw.length > 3 ? `${raw.slice(0, -3)} ${raw.slice(-3)}` : raw;
}

function isFullPostcode(value: unknown) {
  return /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(String(value ?? "").trim());
}

function toInt(value: unknown) {
  const number = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
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

function normaliseHeader(value: unknown) {
  return String(value ?? "").replace(/^\uFEFF/, "").trim().toLowerCase();
}

function findHeader(headers: string[], candidates: string[]) {
  const normalised = headers.map(normaliseHeader);
  for (const candidate of candidates) {
    const index = normalised.indexOf(candidate.toLowerCase());
    if (index >= 0) return index;
  }
  throw new Error(`CSV column missing: ${candidates[0]}`);
}

async function fetchJson(url: string) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "House-Ranker/1.4" },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${response.status} from ${new URL(url).hostname}: ${body.slice(0, 220)}`);
  }
  return response.json();
}

async function discoverDataset() {
  const payload = await fetchJson(DATASET_PACKAGE_API);
  const resources = Array.isArray(payload?.result?.resources) ? payload.result.resources : [];
  const resource = resources.find((item: any) => {
    const text = `${item?.name ?? ""} ${item?.url ?? ""}`;
    return String(item?.format ?? "").toUpperCase() === "CSV" &&
      /Postcodes_Risk_Assessment_All\.csv/i.test(text);
  });
  if (!resource?.url) throw new Error("Environment Agency postcode flood CSV was not found in the current dataset package");

  const rawDate = String(resource.last_modified || resource.created || payload?.result?.metadata_modified || "");
  const dataDate = /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? rawDate.slice(0, 10) : null;
  return { url: String(resource.url), dataDate };
}

async function findPostcodeRow(url: string, targetPostcode: string) {
  const response = await fetch(url, {
    headers: {
      Accept: "text/csv,application/octet-stream;q=0.9,*/*;q=0.5",
      "User-Agent": "House-Ranker/1.4",
    },
  });
  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => "");
    throw new Error(`${response.status} loading Environment Agency flood postcode data: ${body.slice(0, 220)}`);
  }

  const target = targetPostcode.replace(/\s+/g, "").toUpperCase();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let indexes: Record<string, number> | null = null;

  const consume = async (line: string) => {
    const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!clean) return null;
    const row = parseCsvLine(clean);

    if (!indexes) {
      indexes = {
        postcode: findHeader(row, ["postcode"]),
        high: findHeader(row, ["high_cnt", "high count"]),
        medium: findHeader(row, ["med_cnt", "medium_cnt", "medium count"]),
        low: findHeader(row, ["low_cnt", "low count"]),
        groundwater: findHeader(row, ["gwtr_risk", "groundwater"]),
      };
      return null;
    }

    const postcode = cleanPostcode(row[indexes.postcode]);
    if (!postcode || postcode.replace(/\s+/g, "").toUpperCase() !== target) return null;
    return {
      postcode,
      highCount: toInt(row[indexes.high]),
      mediumCount: toInt(row[indexes.medium]),
      lowCount: toInt(row[indexes.low]),
      groundwaterRisk: String(row[indexes.groundwater] ?? "").trim() || null,
    };
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const match = await consume(line);
      if (match) {
        await reader.cancel();
        return match;
      }
      newline = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  if (buffer) {
    const match = await consume(buffer);
    if (match) return match;
  }
  return null;
}

function headlineBand(highCount: number, mediumCount: number, lowCount: number) {
  if (highCount > 0) return "high";
  if (mediumCount > 0) return "medium";
  if (lowCount > 0) return "low";
  return "very_low";
}

function scoreFlood(band: string, groundwaterRisk: string | null) {
  const base: Record<string, number> = { very_low: 95, low: 78, medium: 50, high: 20 };
  let score = base[band] ?? 50;
  if (band === "very_low" && /possible|yes/i.test(String(groundwaterRisk || ""))) score -= 8;
  return Math.max(5, Math.min(100, score));
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
  } catch {}

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
    .select("id,address,postcode,metrics,flood_status,flood_enriched_at")
    .eq("id", propertyId)
    .single();
  if (propertyError || !property) return json({ error: "Property not found" }, 404);

  const activeSince = new Date(Date.now() - RUN_GUARD_MS).toISOString();
  const { data: activeRuns } = await supabase
    .from("enrichment_runs")
    .select("id,started_at")
    .eq("property_id", propertyId)
    .eq("source", "flood")
    .eq("status", "running")
    .gte("started_at", activeSince)
    .order("started_at", { ascending: false })
    .limit(1);

  if (activeRuns?.length) return json({ status: "already_running", property });

  const startedAt = new Date().toISOString();
  const { data: run } = await supabase
    .from("enrichment_runs")
    .insert({
      property_id: propertyId,
      source: "flood",
      status: "running",
      started_at: startedAt,
      payload: { postcode: property.postcode || null, source: SOURCE_NAME },
    })
    .select("id")
    .single();

  const finishRun = async (
    status: "succeeded" | "failed",
    payload: Record<string, unknown>,
    errorMessage: string | null = null,
  ) => {
    if (!run?.id) return;
    await supabase.from("enrichment_runs")
      .update({ status, finished_at: new Date().toISOString(), payload, error_message: errorMessage })
      .eq("id", run.id);
  };

  try {
    const postcode = cleanPostcode(property.postcode);
    const now = new Date().toISOString();

    if (!isFullPostcode(postcode)) {
      const { data: updated } = await supabase
        .from("properties")
        .update({ flood_status: "not_found", flood_enriched_at: now, updated_at: now })
        .eq("id", propertyId)
        .select("*")
        .single();
      await finishRun("succeeded", { outcome: "not_found", reason: "full_postcode_required", postcode: postcode || null });
      return json({ status: "not_found", reason: "full_postcode_required", property: updated });
    }

    const dataset = await discoverDataset();
    const row = await findPostcodeRow(dataset.url, postcode);

    if (!row) {
      const { data: updated } = await supabase
        .from("properties")
        .update({
          flood_status: "not_found",
          flood_score: null,
          flood_band: null,
          flood_high_count: null,
          flood_medium_count: null,
          flood_low_count: null,
          flood_groundwater_risk: null,
          flood_data_date: dataset.dataDate,
          flood_enriched_at: now,
          updated_at: now,
        })
        .eq("id", propertyId)
        .select("*")
        .single();
      await finishRun("succeeded", { outcome: "not_found", postcode, dataDate: dataset.dataDate });
      return json({ status: "not_found", postcode, dataDate: dataset.dataDate, property: updated });
    }

    const band = headlineBand(row.highCount, row.mediumCount, row.lowCount);
    const score = scoreFlood(band, row.groundwaterRisk);
    const collapsedRisk = band === "very_low" ? "low" : band;
    const metrics = { ...(property.metrics ?? {}), environment: score };

    const { data: updatedProperty, error: updateError } = await supabase
      .from("properties")
      .update({
        flood_status: "matched",
        flood_score: score,
        flood_band: band,
        flood_high_count: row.highCount,
        flood_medium_count: row.mediumCount,
        flood_low_count: row.lowCount,
        flood_groundwater_risk: row.groundwaterRisk,
        flood_data_date: dataset.dataDate,
        flood_enriched_at: now,
        flood_risk: collapsedRisk,
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
      flood: {
        source: SOURCE_NAME,
        sourcePage: SOURCE_PAGE,
        officialChecker: OFFICIAL_CHECKER,
        postcode,
        dataDate: dataset.dataDate,
        headlineBand: band,
        score,
        highCount: row.highCount,
        mediumCount: row.mediumCount,
        lowCount: row.lowCount,
        groundwaterRisk: row.groundwaterRisk,
        scoreMethod: "Very low 95; low 78; medium 50; high 20; -8 if groundwater is possible while other risk is very low.",
        bandMethod: "Highest non-zero Environment Agency postcode risk count across rivers/sea and surface water; groundwater is reported separately.",
        caveat: "This is postcode-level long-term flood screening for the area around addresses, not a prediction that this individual building will flood. Very-low property counts are not published in this dataset.",
      },
    };

    const { error: areaError } = await supabase
      .from("area_metrics")
      .upsert(
        { property_id: propertyId, environment_score: score, raw_data: rawData, refreshed_at: now },
        { onConflict: "property_id" },
      );
    if (areaError) throw areaError;

    await finishRun("succeeded", {
      outcome: "matched",
      postcode,
      band,
      score,
      highCount: row.highCount,
      mediumCount: row.mediumCount,
      lowCount: row.lowCount,
      groundwaterRisk: row.groundwaterRisk,
      dataDate: dataset.dataDate,
    });

    return json({
      status: "matched",
      postcode,
      band,
      score,
      highCount: row.highCount,
      mediumCount: row.mediumCount,
      lowCount: row.lowCount,
      groundwaterRisk: row.groundwaterRisk,
      dataDate: dataset.dataDate,
      property: updatedProperty,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const now = new Date().toISOString();
    await supabase
      .from("properties")
      .update({ flood_status: "error", flood_enriched_at: now, updated_at: now })
      .eq("id", propertyId);
    await finishRun("failed", { outcome: "error" }, message);
    return json({ error: "Flood lookup failed", detail: message }, 502);
  }
});
