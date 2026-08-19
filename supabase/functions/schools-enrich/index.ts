import { createClient } from "npm:@supabase/supabase-js@2.111.0";

const GIAS_BASE = "https://ea-edubase-api-prod.azurewebsites.net/edubase/downloads/public";
const POSTCODE_API = "https://api.postcodes.io";
const OFSTED_PAGE = "https://www.gov.uk/government/statistical-data-sets/monthly-management-information-ofsteds-school-inspections-outcomes";
const OFSTED_CURRENT_FALLBACK = "https://assets.publishing.service.gov.uk/media/6a75d6aa5a472b60f4ea6d63/Management_information_-_state-funded_schools_-_latest_inspections_as_at_31_July_2026.csv";
const OFSTED_LEGACY = "https://assets.publishing.service.gov.uk/media/68bfd549223d92d088f01dd9/Management_information_-_state-funded_schools_-_latest_inspections_as_at_31_Aug_2025.csv";
const GIAS_SOURCE = "DfE Get Information About Schools daily public download";
const OFSTED_SOURCE = "Ofsted state-funded schools monthly management information";
const RUN_GUARD_MS = 4 * 60 * 1000;
const MAX_CANDIDATES_PER_PHASE = 20;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Candidate = {
  urn: string;
  name: string;
  phase: string;
  type: string;
  postcode: string;
  distanceMetres: number;
  distanceMiles: number;
};

type OfstedCurrent = {
  reportUrl: string | null;
  inspectionNumber: string | null;
  inspectionDate: string | null;
  publicationDate: string | null;
  safeguarding: string | null;
  inclusion: string | null;
  curriculumTeaching: string | null;
  achievement: string | null;
  attendanceBehaviour: string | null;
  personalDevelopment: string | null;
  categoryOfConcern: string | null;
};

type OfstedLegacy = {
  reportUrl: string | null;
  overallEffectiveness: string | null;
  inspectionDate: string | null;
  publicationDate: string | null;
  ungradedOutcome: string | null;
  ungradedDate: string | null;
  categoryOfConcern: string | null;
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

function cleanCell(value: unknown) {
  const text = String(value ?? "").trim();
  return !text || text.toUpperCase() === "NULL" ? null : text;
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function formatDateCompact(date: Date) {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

function isoDateFromAssetUrl(url: string) {
  const match = url.match(/as_at_(\d{1,2})_([A-Za-z]+)_(\d{4})/i);
  if (!match) return null;
  const months: Record<string, number> = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
    may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
    september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
  };
  const month = months[match[2].toLowerCase()];
  if (!month) return null;
  return `${match[3]}-${String(month).padStart(2, "0")}-${String(Number(match[1])).padStart(2, "0")}`;
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

async function processCsv(response: Response, encoding: string, onHeader: (headers: string[]) => void, onRow: (row: string[]) => boolean | void) {
  if (!response.body) throw new Error("CSV response had no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder(encoding);
  let buffer = "";
  let headerSeen = false;

  const consume = async (line: string) => {
    const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!clean) return true;
    const row = parseCsvLine(clean);
    if (!headerSeen) {
      headerSeen = true;
      if (row[0]) row[0] = row[0].replace(/^\uFEFF/, "");
      onHeader(row);
      return true;
    }
    return onRow(row) !== false;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const keepGoing = await consume(line);
      if (!keepGoing) {
        await reader.cancel();
        return;
      }
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer) await consume(buffer);
}

function headerIndex(headers: string[], name: string) {
  const index = headers.findIndex(header => header.trim().toLowerCase() === name.toLowerCase());
  if (index < 0) throw new Error(`CSV column missing: ${name}`);
  return index;
}

async function fetchJson(url: string) {
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "House-Ranker/1.3" } });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} from ${new URL(url).hostname}: ${body.slice(0, 180)}`);
  }
  return response.json();
}

async function resolveGrid(postcode: string, existingLat: unknown, existingLng: unknown) {
  if (isFullPostcode(postcode)) {
    const compact = postcode.replace(/\s+/g, "");
    const payload = await fetchJson(`${POSTCODE_API}/postcodes/${encodeURIComponent(compact)}`);
    const result = payload?.result;
    const eastings = toNumber(result?.eastings);
    const northings = toNumber(result?.northings);
    if (eastings !== null && northings !== null) {
      return {
        postcode: cleanPostcode(result?.postcode || postcode), eastings, northings,
        lat: toNumber(result?.latitude), lng: toNumber(result?.longitude), method: "full_postcode",
      };
    }
  }

  const lat = toNumber(existingLat);
  const lng = toNumber(existingLng);
  if (lat !== null && lng !== null) {
    const payload = await fetchJson(`${POSTCODE_API}/postcodes?lon=${encodeURIComponent(lng)}&lat=${encodeURIComponent(lat)}&limit=1`);
    const result = Array.isArray(payload?.result) ? payload.result[0] : null;
    const eastings = toNumber(result?.eastings);
    const northings = toNumber(result?.northings);
    if (eastings !== null && northings !== null) {
      return {
        postcode: cleanPostcode(result?.postcode || postcode), eastings, northings,
        lat: toNumber(result?.latitude) ?? lat, lng: toNumber(result?.longitude) ?? lng, method: "nearest_postcode_from_coordinates",
      };
    }
  }
  return null;
}

async function getRecentGiasResponse() {
  for (let offset = 0; offset < 5; offset += 1) {
    const date = new Date(Date.now() - offset * 24 * 60 * 60 * 1000);
    const compact = formatDateCompact(date);
    const url = `${GIAS_BASE}/edubasealldata${compact}.csv`;
    const response = await fetch(url, { headers: { Accept: "text/csv", "User-Agent": "House-Ranker/1.3" } });
    if (response.ok) return { response, url, dataDate: `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}` };
    if (response.status !== 404) {
      const body = await response.text().catch(() => "");
      throw new Error(`${response.status} loading GIAS: ${body.slice(0, 180)}`);
    }
  }
  throw new Error("Could not find a recent GIAS daily download");
}

function keepNearest(list: Candidate[], item: Candidate) {
  list.push(item);
  list.sort((a, b) => a.distanceMetres - b.distanceMetres);
  if (list.length > MAX_CANDIDATES_PER_PHASE) list.length = MAX_CANDIDATES_PER_PHASE;
}

function isMainstream(type: string, group: string) {
  const text = `${type} ${group}`.toLowerCase();
  return !/(special|pupil referral|alternative provision|independent school|nursery school|further education|secure unit|offshore)/.test(text);
}

async function nearestSchools(eastings: number, northings: number) {
  const { response, url, dataDate } = await getRecentGiasResponse();
  const primary: Candidate[] = [];
  const secondary: Candidate[] = [];
  let indexes: Record<string, number> = {};

  await processCsv(response, "windows-1252", headers => {
    indexes = {
      urn: headerIndex(headers, "URN"),
      name: headerIndex(headers, "EstablishmentName"),
      type: headerIndex(headers, "TypeOfEstablishment (name)"),
      group: headerIndex(headers, "EstablishmentTypeGroup (name)"),
      status: headerIndex(headers, "EstablishmentStatus (name)"),
      phase: headerIndex(headers, "PhaseOfEducation (name)"),
      postcode: headerIndex(headers, "Postcode"),
      eastings: headerIndex(headers, "Easting"),
      northings: headerIndex(headers, "Northing"),
    };
  }, row => {
    if (String(row[indexes.status] || "").trim().toLowerCase() !== "open") return;
    const type = String(row[indexes.type] || "").trim();
    const group = String(row[indexes.group] || "").trim();
    if (!isMainstream(type, group)) return;

    const phase = String(row[indexes.phase] || "").trim();
    const phaseLower = phase.toLowerCase();
    const isPrimary = phaseLower === "primary" || phaseLower.includes("deemed primary") || phaseLower === "all-through";
    const isSecondary = phaseLower === "secondary" || phaseLower.includes("deemed secondary") || phaseLower === "all-through";
    if (!isPrimary && !isSecondary) return;

    const schoolE = toNumber(row[indexes.eastings]);
    const schoolN = toNumber(row[indexes.northings]);
    if (schoolE === null || schoolN === null) return;
    const distanceMetres = Math.hypot(schoolE - eastings, schoolN - northings);
    if (!Number.isFinite(distanceMetres) || distanceMetres > 25000) return;

    const candidate: Candidate = {
      urn: String(row[indexes.urn] || "").trim(),
      name: String(row[indexes.name] || "").trim(),
      phase,
      type,
      postcode: cleanPostcode(row[indexes.postcode]),
      distanceMetres,
      distanceMiles: round2(distanceMetres / 1609.344),
    };
    if (!candidate.urn || !candidate.name) return;
    if (isPrimary) keepNearest(primary, candidate);
    if (isSecondary) keepNearest(secondary, candidate);
  });

  return { primary, secondary, url, dataDate };
}

async function discoverCurrentOfstedUrl() {
  try {
    const response = await fetch(OFSTED_PAGE, { headers: { Accept: "text/html", "User-Agent": "House-Ranker/1.3" } });
    if (!response.ok) return OFSTED_CURRENT_FALLBACK;
    const html = await response.text();
    const matches = [...html.matchAll(/https:\/\/assets\.publishing\.service\.gov\.uk\/media\/[^"'<>\s]+\/Management_information_-_state-funded_schools_-_latest_inspections_as_at_[^"'<>\s]+\.csv/gi)];
    return matches[0]?.[0]?.replace(/&amp;/g, "&") || OFSTED_CURRENT_FALLBACK;
  } catch {
    return OFSTED_CURRENT_FALLBACK;
  }
}

async function openCsv(url: string) {
  const response = await fetch(url, { headers: { Accept: "text/csv", "User-Agent": "House-Ranker/1.3" } });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${response.status} loading ${new URL(url).hostname}: ${body.slice(0, 180)}`);
  }
  return response;
}

async function loadCurrentOfsted(url: string, targetUrns: Set<string>) {
  const result = new Map<string, OfstedCurrent>();
  if (!targetUrns.size) return result;
  const response = await openCsv(url);
  let idx: Record<string, number> = {};

  await processCsv(response, "utf-8", headers => {
    idx = {
      urn: headerIndex(headers, "URN"),
      reportUrl: headerIndex(headers, "Web Link (opens in new window)"),
      inspectionNumber: headerIndex(headers, "Inspection number of latest full inspection"),
      inspectionDate: headerIndex(headers, "Inspection start date"),
      publicationDate: headerIndex(headers, "Publication date"),
      category: headerIndex(headers, "Category of concern"),
      safeguarding: headerIndex(headers, "Safeguarding standards"),
      inclusion: headerIndex(headers, "Inclusion"),
      curriculum: headerIndex(headers, "Curriculum and teaching"),
      achievement: headerIndex(headers, "Achievement"),
      attendance: headerIndex(headers, "Attendance and behaviour"),
      personal: headerIndex(headers, "Personal development and wellbeing"),
    };
  }, row => {
    const urn = String(row[idx.urn] || "").trim();
    if (!targetUrns.has(urn)) return;
    result.set(urn, {
      reportUrl: cleanCell(row[idx.reportUrl]),
      inspectionNumber: cleanCell(row[idx.inspectionNumber]),
      inspectionDate: cleanCell(row[idx.inspectionDate]),
      publicationDate: cleanCell(row[idx.publicationDate]),
      categoryOfConcern: cleanCell(row[idx.category]),
      safeguarding: cleanCell(row[idx.safeguarding]),
      inclusion: cleanCell(row[idx.inclusion]),
      curriculumTeaching: cleanCell(row[idx.curriculum]),
      achievement: cleanCell(row[idx.achievement]),
      attendanceBehaviour: cleanCell(row[idx.attendance]),
      personalDevelopment: cleanCell(row[idx.personal]),
    });
    return result.size < targetUrns.size;
  });
  return result;
}

async function loadLegacyOfsted(targetUrns: Set<string>) {
  const result = new Map<string, OfstedLegacy>();
  if (!targetUrns.size) return result;
  const response = await openCsv(OFSTED_LEGACY);
  let idx: Record<string, number> = {};

  await processCsv(response, "utf-8", headers => {
    idx = {
      urn: headerIndex(headers, "URN"),
      reportUrl: headerIndex(headers, "Web link (opens in new window)"),
      overall: headerIndex(headers, "Overall effectiveness"),
      inspectionDate: headerIndex(headers, "Inspection start date"),
      publicationDate: headerIndex(headers, "Publication date"),
      ungradedOutcome: headerIndex(headers, "Ungraded inspection overall outcome"),
      ungradedDate: headerIndex(headers, "Date of latest ungraded inspection"),
      category: headerIndex(headers, "Category of concern"),
    };
  }, row => {
    const urn = String(row[idx.urn] || "").trim();
    if (!targetUrns.has(urn)) return;
    result.set(urn, {
      reportUrl: cleanCell(row[idx.reportUrl]),
      overallEffectiveness: cleanCell(row[idx.overall]),
      inspectionDate: cleanCell(row[idx.inspectionDate]),
      publicationDate: cleanCell(row[idx.publicationDate]),
      ungradedOutcome: cleanCell(row[idx.ungradedOutcome]),
      ungradedDate: cleanCell(row[idx.ungradedDate]),
      categoryOfConcern: cleanCell(row[idx.category]),
    });
    return result.size < targetUrns.size;
  });
  return result;
}

const REPORT_CARD_SCORES: Record<string, number> = {
  "exceptional": 100,
  "strong standard": 90,
  "expected standard": 75,
  "needs attention": 45,
  "urgent improvement": 15,
};

function reportCardGradeScore(value: string | null) {
  if (!value) return null;
  return REPORT_CARD_SCORES[value.trim().toLowerCase()] ?? null;
}

function hasMeaningfulCurrentInspection(row: OfstedCurrent | undefined) {
  if (!row?.inspectionNumber) return false;
  return [row.inclusion, row.curriculumTeaching, row.achievement, row.attendanceBehaviour, row.personalDevelopment]
    .some(value => reportCardGradeScore(value) !== null);
}

function qualityForSchool(current: OfstedCurrent | undefined, legacy: OfstedLegacy | undefined) {
  if (hasMeaningfulCurrentInspection(current)) {
    const gradeEntries = [
      ["Inclusion", current?.inclusion],
      ["Curriculum & teaching", current?.curriculumTeaching],
      ["Achievement", current?.achievement],
      ["Attendance & behaviour", current?.attendanceBehaviour],
      ["Personal development", current?.personalDevelopment],
    ] as Array<[string, string | null | undefined]>;
    const numeric = gradeEntries.map(([, value]) => reportCardGradeScore(value ?? null)).filter((value): value is number => value !== null);
    let score = numeric.length ? mean(numeric) : 65;
    const safeguarding = current?.safeguarding?.trim().toLowerCase() || "";
    if (safeguarding && safeguarding !== "met" && safeguarding !== "not set") score = Math.min(score, 30);
    const concern = current?.categoryOfConcern?.trim().toLowerCase() || "";
    if (concern && concern !== "not set") score = Math.min(score, 30);
    return {
      score: Math.round(clamp(score)),
      model: "report_card",
      label: gradeEntries.filter(([, value]) => reportCardGradeScore(value ?? null) !== null).map(([label, value]) => `${label}: ${value}`).join(" · "),
      inspectionDate: current?.inspectionDate || null,
      publicationDate: current?.publicationDate || null,
      reportUrl: current?.reportUrl || null,
      safeguarding: current?.safeguarding || null,
    };
  }

  const overall = Number(legacy?.overallEffectiveness);
  const legacyScores: Record<number, number> = { 1: 100, 2: 82, 3: 55, 4: 25 };
  let legacyScore = legacyScores[overall] ?? null;
  let gradeLabel = ({ 1: "Outstanding", 2: "Good", 3: "Requires improvement", 4: "Inadequate" } as Record<number, string>)[overall] || null;
  const outcome = legacy?.ungradedOutcome?.toLowerCase() || "";
  if (legacyScore === null && outcome.includes("outstanding")) { legacyScore = 100; gradeLabel = "Outstanding"; }
  if (legacyScore === null && outcome.includes("good")) { legacyScore = 82; gradeLabel = "Good"; }
  if (legacyScore !== null) {
    const concern = legacy?.categoryOfConcern?.trim().toLowerCase() || "";
    if (concern && concern !== "not set") legacyScore = Math.min(legacyScore, 30);
    return {
      score: Math.round(clamp(legacyScore)),
      model: "legacy_overall",
      label: legacy?.ungradedOutcome && legacy.ungradedOutcome.toLowerCase() !== "not set" ? `${gradeLabel} · ${legacy.ungradedOutcome}` : gradeLabel,
      inspectionDate: legacy?.ungradedDate || legacy?.inspectionDate || null,
      publicationDate: legacy?.publicationDate || null,
      reportUrl: legacy?.reportUrl || null,
      safeguarding: null,
    };
  }

  return {
    score: 65,
    model: "unrated",
    label: "No current published grade used",
    inspectionDate: null,
    publicationDate: null,
    reportUrl: current?.reportUrl || legacy?.reportUrl || null,
    safeguarding: current?.safeguarding || null,
  };
}

function distanceScore(miles: number, phase: "primary" | "secondary") {
  const penalty = phase === "primary" ? 18 : 14;
  return Math.round(clamp(100 - miles * penalty, 20, 100));
}

function phaseSummary(candidates: Candidate[], phase: "primary" | "secondary", current: Map<string, OfstedCurrent>, legacy: Map<string, OfstedLegacy>) {
  const enriched = candidates.map(candidate => ({ ...candidate, quality: qualityForSchool(current.get(candidate.urn), legacy.get(candidate.urn)) }));
  const top = enriched.slice(0, 3);
  if (!top.length) return null;
  const quality = mean(top.map(school => school.quality.score));
  const distance = mean(top.map(school => distanceScore(school.distanceMiles, phase)));
  const choiceRadius = phase === "primary" ? 3 : 5;
  const goodChoices = enriched.filter(school => school.distanceMiles <= choiceRadius && school.quality.score >= 75).length;
  const choice = clamp((Math.min(goodChoices, 3) / 3) * 100);
  const score = Math.round(0.60 * quality + 0.30 * distance + 0.10 * choice);
  return {
    score,
    qualityScore: Math.round(quality),
    distanceScore: Math.round(distance),
    choiceScore: Math.round(choice),
    goodChoices,
    choiceRadiusMiles: choiceRadius,
    nearestMiles: top[0].distanceMiles,
    schools: top.map(school => ({
      urn: school.urn,
      name: school.name,
      type: school.type,
      phase: school.phase,
      postcode: school.postcode,
      distanceMiles: school.distanceMiles,
      qualityScore: school.quality.score,
      qualityModel: school.quality.model,
      qualityLabel: school.quality.label,
      inspectionDate: school.quality.inspectionDate,
      publicationDate: school.quality.publicationDate,
      safeguarding: school.quality.safeguarding,
      reportUrl: school.quality.reportUrl,
    })),
  };
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

  const { data: property, error: propertyError } = await supabase.from("properties")
    .select("id,address,postcode,latitude,longitude,metrics,schools_status,schools_enriched_at")
    .eq("id", propertyId).single();
  if (propertyError || !property) return json({ error: "Property not found" }, 404);

  const activeSince = new Date(Date.now() - RUN_GUARD_MS).toISOString();
  const { data: activeRuns } = await supabase.from("enrichment_runs")
    .select("id,started_at").eq("property_id", propertyId).eq("source", "schools").eq("status", "running")
    .gte("started_at", activeSince).order("started_at", { ascending: false }).limit(1);
  if (activeRuns?.length) return json({ status: "already_running", property });

  const startedAt = new Date().toISOString();
  const { data: run } = await supabase.from("enrichment_runs").insert({
    property_id: propertyId, source: "schools", status: "running", started_at: startedAt,
    payload: { postcode: property.postcode || null, method: "gias_nearest_plus_ofsted" },
  }).select("id").single();

  const finishRun = async (status: "succeeded" | "failed", payload: Record<string, unknown>, errorMessage: string | null = null) => {
    if (!run?.id) return;
    await supabase.from("enrichment_runs").update({ status, finished_at: new Date().toISOString(), payload, error_message: errorMessage }).eq("id", run.id);
  };

  try {
    const postcode = cleanPostcode(property.postcode);
    const grid = await resolveGrid(postcode, property.latitude, property.longitude);
    if (!grid) {
      const now = new Date().toISOString();
      const { data: updated } = await supabase.from("properties")
        .update({ schools_status: "needs_location", schools_enriched_at: now })
        .eq("id", propertyId).select("*").single();
      await finishRun("succeeded", { outcome: "needs_location", postcode: postcode || null });
      return json({ status: "needs_location", property: updated });
    }

    const nearby = await nearestSchools(grid.eastings, grid.northings);
    if (!nearby.primary.length && !nearby.secondary.length) throw new Error("GIAS returned no nearby mainstream primary or secondary schools");

    const targetUrns = new Set([...nearby.primary, ...nearby.secondary].map(school => school.urn));
    const currentOfstedUrl = await discoverCurrentOfstedUrl();
    const currentOfsted = await loadCurrentOfsted(currentOfstedUrl, targetUrns);
    const legacyTargets = new Set([...targetUrns].filter(urn => !hasMeaningfulCurrentInspection(currentOfsted.get(urn))));
    const legacyOfsted = await loadLegacyOfsted(legacyTargets);

    const primary = phaseSummary(nearby.primary, "primary", currentOfsted, legacyOfsted);
    const secondary = phaseSummary(nearby.secondary, "secondary", currentOfsted, legacyOfsted);
    const availableScores = [primary?.score, secondary?.score].filter((value): value is number => typeof value === "number");
    const schoolsScore = Math.round(mean(availableScores));
    const metrics = { ...(property.metrics ?? {}), schools: schoolsScore };
    const now = new Date().toISOString();

    const { data: updatedProperty, error: updateError } = await supabase.from("properties").update({
      postcode: grid.postcode || postcode || property.postcode,
      latitude: grid.lat ?? property.latitude,
      longitude: grid.lng ?? property.longitude,
      schools_status: "matched",
      schools_score: schoolsScore,
      schools_primary_score: primary?.score ?? null,
      schools_secondary_score: secondary?.score ?? null,
      schools_nearest_primary_miles: primary?.nearestMiles ?? null,
      schools_nearest_secondary_miles: secondary?.nearestMiles ?? null,
      schools_enriched_at: now,
      metrics,
      updated_at: now,
    }).eq("id", propertyId).select("*").single();
    if (updateError) throw updateError;

    const { data: existingAreaMetrics } = await supabase.from("area_metrics").select("raw_data").eq("property_id", propertyId).maybeSingle();
    const currentOfstedDataDate = isoDateFromAssetUrl(currentOfstedUrl);
    const rawData = {
      ...(existingAreaMetrics?.raw_data ?? {}),
      schools: {
        source: { directory: GIAS_SOURCE, inspections: OFSTED_SOURCE },
        directoryDataDate: nearby.dataDate,
        directoryUrl: nearby.url,
        currentOfstedDataDate,
        currentOfstedUrl,
        legacyOfstedReferenceDate: "2025-08-31",
        score: schoolsScore,
        formula: "overall = mean(primary, secondary); phase = 60% quality + 30% distance + 10% choice",
        qualityScale: {
          reportCard: { exceptional: 100, strongStandard: 90, expectedStandard: 75, needsAttention: 45, urgentImprovement: 15 },
          legacyOverall: { outstanding: 100, good: 82, requiresImprovement: 55, inadequate: 25 },
          unratedFallback: 65,
        },
        location: {
          postcode: grid.postcode,
          coordinateMethod: grid.method,
          eastings: grid.eastings,
          northings: grid.northings,
          note: "Distances are straight-line approximations from British National Grid coordinates. Nearby school does not mean in catchment or guaranteed admission.",
        },
        primary,
        secondary,
      },
    };

    const { error: areaError } = await supabase.from("area_metrics").upsert({
      property_id: propertyId, schools_score: schoolsScore, raw_data: rawData, refreshed_at: now,
    }, { onConflict: "property_id" });
    if (areaError) throw areaError;

    await finishRun("succeeded", {
      outcome: "matched", schoolsScore,
      primaryScore: primary?.score ?? null, secondaryScore: secondary?.score ?? null,
      nearestPrimaryMiles: primary?.nearestMiles ?? null, nearestSecondaryMiles: secondary?.nearestMiles ?? null,
      directoryDataDate: nearby.dataDate, currentOfstedDataDate,
    });

    return json({
      status: "matched", score: schoolsScore,
      primaryScore: primary?.score ?? null, secondaryScore: secondary?.score ?? null,
      nearestPrimaryMiles: primary?.nearestMiles ?? null, nearestSecondaryMiles: secondary?.nearestMiles ?? null,
      property: updatedProperty,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const now = new Date().toISOString();
    await supabase.from("properties").update({ schools_status: "error", schools_enriched_at: now }).eq("id", propertyId);
    await finishRun("failed", { outcome: "error" }, message);
    console.error("Schools enrichment failed", { propertyId, message });
    return json({ error: "Schools enrichment failed", detail: message }, 502);
  }
});
