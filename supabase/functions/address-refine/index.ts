const VERSION = "1.0";
const EPC_BASE_URL = "https://api.get-energy-performance-data.communities.gov.uk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

const cleanText = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
const num = (value: unknown) => value === null || value === undefined || value === "" ? null : (Number.isFinite(Number(value)) ? Number(value) : null);

function cleanPostcode(value: unknown) {
  const raw = cleanText(value).toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(raw)) return "";
  return `${raw.slice(0, -3)} ${raw.slice(-3)}`;
}

function normalizeAddress(value: unknown) {
  return cleanText(value).toUpperCase()
    .replace(/\b(UNIT|APARTMENT)\b/g, "FLAT")
    .replace(/\bROAD\b/g, "RD").replace(/\bSTREET\b/g, "ST")
    .replace(/\bAVENUE\b/g, "AVE").replace(/\bDRIVE\b/g, "DR")
    .replace(/\bLANE\b/g, "LN").replace(/\bCLOSE\b/g, "CL")
    .replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function streetName(value: unknown) {
  return cleanText(value).split(",")[0].replace(/^FLAT\s+[A-Z0-9-]+\s+/i, "").replace(/^\d+[A-Z]?\s+/i, "").trim();
}

function normalizeType(value: unknown) {
  const text = cleanText(value).toLowerCase();
  if (!text) return null;
  if (text.includes("semi")) return "Semi-detached";
  if (text.includes("bungalow")) return "Bungalow";
  if (text.includes("terrace")) return "Terraced";
  if (text.includes("flat") || text.includes("apartment") || text.includes("maisonette")) return "Flat";
  if (text.includes("detached")) return "Detached";
  return null;
}

function listingType(listing: any) {
  const explicit = normalizeType(listing?.propertyTypeRaw) || normalizeType(listing?.propertyType);
  const text = `${(listing?.keyFeatures || []).join(" ")} ${listing?.description || ""}`.toLowerCase();
  if (/\bsemi[- ]detached\b/.test(text)) return "Semi-detached";
  if (/\bdetached\s+(?:family\s+)?(?:home|house|property|bungalow)\b/.test(text)) return text.includes("bungalow") ? "Bungalow" : "Detached";
  return explicit;
}

function parseDate(value: unknown) {
  const raw = cleanText(value);
  if (!raw) return null;
  let match = raw.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (match) return new Date(`${match[3]}-${String(match[2]).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}T12:00:00Z`);
  match = raw.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (match) return new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00Z`);
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date : null;
}

const iso = (date: Date | null) => date ? date.toISOString().slice(0, 10) : null;
const dayDiff = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / 86400000);

async function rightmoveListedDate(listing: any) {
  const explicit = parseDate(listing?.listedDate ?? listing?.addedDate ?? listing?.listingDate);
  if (explicit) return explicit;
  const url = cleanText(listing?.url);
  if (!/^https?:\/\/(?:www\.)?rightmove\.co\.uk\/properties\/\d+/i.test(url)) return null;
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-GB,en;q=0.9",
      },
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) return null;
    const html = await response.text();
    const raw = html.match(/Added\s+on\s+(\d{1,2}\/\d{1,2}\/20\d{2})/i)?.[1]
      || html.match(/"firstVisibleDate"\s*:\s*"([^"]+)"/i)?.[1]
      || html.match(/"datePublished"\s*:\s*"([^"]+)"/i)?.[1];
    return parseDate(raw);
  } catch { return null; }
}

async function epcGet(path: string, params: URLSearchParams, token: string) {
  const response = await fetch(`${EPC_BASE_URL}${path}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`EPC API returned ${response.status}`);
  return response.json();
}

function rows(payload: any): any[] {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.items)) return payload.items;
  return Array.isArray(payload) ? payload : [];
}

function rowAddress(row: any) {
  return [row.addressLine1, row.addressLine2, row.addressLine3, row.addressLine4, row.postTown].map(cleanText).filter(Boolean).join(", ");
}
const rowUprn = (row: any) => cleanText(row.uprn);
const rowCert = (row: any) => cleanText(row.certificateNumber ?? row.certificate_number);
const rowDate = (row: any) => parseDate(row.registrationDate ?? row.registration_date ?? row.inspectionDate ?? row.inspection_date);
const rowBand = (row: any) => cleanText(row.currentEnergyEfficiencyBand ?? row.current_energy_efficiency_band).toUpperCase() || null;
const rowType = (row: any) => normalizeType(row.builtForm ?? row.built_form ?? row.propertyType ?? row.property_type);
const rowArea = (row: any) => num(row.totalFloorArea ?? row.total_floor_area ?? row.floorArea ?? row.floor_area);

function dedupeLatest(input: any[]) {
  const map = new Map<string, any>();
  for (const row of input) {
    const key = rowUprn(row) || normalizeAddress(rowAddress(row));
    if (!key) continue;
    const old = map.get(key);
    if (!old || (rowDate(row)?.getTime() ?? 0) > (rowDate(old)?.getTime() ?? 0)) map.set(key, row);
  }
  return [...map.values()];
}

function pick(detail: any, ...keys: string[]) {
  for (const key of keys) {
    const value = detail?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

async function detail(cert: string, token: string) {
  if (!cert) return null;
  try {
    const payload = await epcGet("/api/certificate", new URLSearchParams({ certificate_number: cert }), token);
    return payload?.data ?? payload ?? null;
  } catch { return null; }
}

function detailType(d: any, row: any) {
  return normalizeType(pick(d, "built_form", "builtForm")) || normalizeType(pick(d, "property_type", "propertyType")) || rowType(row);
}
function detailArea(d: any, row: any) { return num(pick(d, "total_floor_area", "totalFloorArea")) ?? rowArea(row); }
function detailBand(d: any, row: any) { return cleanText(pick(d, "current_energy_efficiency_band", "currentEnergyEfficiencyBand")).toUpperCase() || rowBand(row); }
function detailDate(d: any, row: any) { return parseDate(pick(d, "registration_date", "registrationDate", "inspection_date", "inspectionDate")) || rowDate(row); }

function recency(listed: Date | null, epc: Date | null) {
  if (!listed || !epc) return { points: 0, strong: false, days: null as number | null };
  const days = dayDiff(epc, listed);
  if (days >= -45 && days <= 7) return { points: 28, strong: true, days };
  if (days >= -120 && days < -45) return { points: 15, strong: false, days };
  if (days > 7 && days <= 30) return { points: 8, strong: false, days };
  if (days >= -365 && days < -120) return { points: 5, strong: false, days };
  return { points: 0, strong: false, days };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const listing = body?.listing;
  const previous = body?.resolution;
  if (!listing || !previous) return json({ error: "listing and resolution are required" }, 400);
  if (previous.status === "exact") return json({ status: "ok", resolution: previous });

  const postcode = cleanPostcode(previous.postcode || listing.postcode);
  const targetStreet = streetName(listing.address || previous.advertisedAddress);
  if (!postcode || !targetStreet) return json({ status: "ok", resolution: previous });

  const token = Deno.env.get("EPC_BEARER_TOKEN") || "";
  if (!token) return json({ status: "ok", resolution: previous });

  const listedDate = await rightmoveListedDate(listing);
  const lType = listingType(listing);
  const lArea = num(listing.floorAreaM2);
  const lBand = cleanText(listing.advertisedEpcBand).toUpperCase() || null;
  const centroidPin = Number(previous?.reversePostcode?.distanceM) <= 8;

  let searchRows: any[] = [];
  try {
    const payload = await epcGet("/api/domestic/search", new URLSearchParams({ postcode, page_size: "500" }), token);
    searchRows = dedupeLatest(rows(payload)).filter(row => normalizeAddress(streetName(rowAddress(row))) === normalizeAddress(targetStreet));
  } catch {
    return json({ status: "ok", resolution: { ...previous, version: `${previous.version || "1.0"}+refine-${VERSION}` } });
  }

  const candidates = searchRows.map(row => {
    const rDate = rowDate(row);
    const r = recency(listedDate, rDate);
    let score = 45;
    if (cleanPostcode(row.postcode) === postcode) score += 20;
    const type = rowType(row);
    const area = rowArea(row);
    const band = rowBand(row);
    let typeMatch = false, floorMatch = false, bandMatch = false;
    if (lType && type) { typeMatch = lType === type; score += typeMatch ? 18 : -22; }
    if (lArea !== null && area !== null && lArea > 0) {
      const delta = Math.abs(area - lArea) / lArea;
      floorMatch = delta <= .18;
      score += delta <= .08 ? 18 : delta <= .18 ? 12 : delta <= .30 ? 4 : delta > .45 ? -12 : 0;
    }
    if (lBand && band) { bandMatch = lBand === band; score += bandMatch ? 10 : -6; }
    score += r.points;
    return { row, address: rowAddress(row), postcode: cleanPostcode(row.postcode), uprn: rowUprn(row), certificate: rowCert(row), score, propertyType: type, floorAreaM2: area, epcBand: band, registrationDate: rDate, recent: r.strong, epcDaysFromListing: r.days, typeMatch, floorMatch, bandMatch, detail: null as any };
  }).sort((a,b) => b.score-a.score).slice(0, 12);

  const details = await Promise.all(candidates.slice(0, 8).map(async c => ({ c, d: await detail(c.certificate, token) })));
  for (const { c, d } of details) {
    c.detail = d;
    const type = detailType(d, c.row);
    const area = detailArea(d, c.row);
    const band = detailBand(d, c.row);
    const date = detailDate(d, c.row);
    c.propertyType = type; c.floorAreaM2 = area; c.epcBand = band; c.registrationDate = date;
    if (lType && type && !rowType(c.row)) { c.typeMatch = lType === type; c.score += c.typeMatch ? 18 : -22; }
    if (lArea !== null && area !== null && lArea > 0 && rowArea(c.row) === null) {
      const delta = Math.abs(area-lArea)/lArea; c.floorMatch = delta <= .18; c.score += delta <= .08 ? 18 : delta <= .18 ? 12 : delta <= .30 ? 4 : delta > .45 ? -12 : 0;
    }
    if (lBand && band && !rowBand(c.row)) { c.bandMatch = lBand === band; c.score += c.bandMatch ? 10 : -6; }
    const r = recency(listedDate, date); c.recent = r.strong; c.epcDaysFromListing = r.days;
  }
  candidates.sort((a,b) => b.score-a.score);

  const top = candidates[0];
  const second = candidates[1];
  const gap = top ? top.score - (second?.score ?? 0) : 0;
  const signals = top ? [top.typeMatch, top.floorMatch, top.bandMatch, top.recent].filter(Boolean).length : 0;

  const strongSignature = Boolean(top && top.score >= 100 && gap >= 18 && signals >= 2 && (top.recent || top.floorMatch));
  if (!strongSignature) {
    return json({ status: "ok", resolution: {
      ...previous,
      version: `${previous.version || "1.0"}+refine-${VERSION}`,
      listedDate: iso(listedDate),
      coordinatePrecision: centroidPin ? "postcode_centroid" : "approximate",
      refinement: { status: "needs_review", gap: Math.round(gap), signals, reason: centroidPin ? "postcode_centroid_requires_property_signature" : "insufficient_property_signature" },
      candidates: candidates.slice(0, 8).map(c => ({ address:c.address, postcode:c.postcode, uprn:c.uprn, score:Math.round(c.score), propertyType:c.propertyType, floorAreaM2:c.floorAreaM2, epcBand:c.epcBand, registrationDate:iso(c.registrationDate), epcDaysFromListing:c.epcDaysFromListing, signals:{propertyType:c.typeMatch,floorArea:c.floorMatch,epcBand:c.bandMatch,recentEpc:c.recent} })),
      warnings: [...new Set([...(previous.warnings || []), ...(centroidPin ? ["Rightmove map pin is postcode-level and was not used to choose the house number"] : [])])],
    }});
  }

  const exactPostcode = top.postcode || postcode;
  return json({ status: "ok", resolution: {
    ...previous,
    version: `${previous.version || "1.0"}+refine-${VERSION}`,
    status: "exact",
    address: `${top.address}${exactPostcode && !normalizeAddress(top.address).includes(normalizeAddress(exactPostcode)) ? `, ${exactPostcode}` : ""}`,
    postcode: exactPostcode,
    uprn: top.uprn || null,
    confidence: Math.min(98, Math.round(88 + Math.min(6, gap/5) + Math.min(4, signals))),
    method: "epc_recent_property_signature_match",
    listedDate: iso(listedDate),
    coordinatePrecision: centroidPin ? "postcode_centroid" : "approximate",
    propertyType: top.propertyType || lType || null,
    floorAreaM2: top.floorAreaM2 || lArea || null,
    epcBand: top.epcBand || lBand || null,
    candidates: candidates.slice(0,8).map(c => ({ address:c.address, postcode:c.postcode, uprn:c.uprn, score:Math.round(c.score), propertyType:c.propertyType, floorAreaM2:c.floorAreaM2, epcBand:c.epcBand, registrationDate:iso(c.registrationDate), epcDaysFromListing:c.epcDaysFromListing, signals:{propertyType:c.typeMatch,floorArea:c.floorMatch,epcBand:c.bandMatch,recentEpc:c.recent} })),
    warnings: [...new Set([...(previous.warnings || []), ...(centroidPin ? ["Rightmove map pin was postcode-level; exact match came from independent property evidence"] : [])])],
    sources: [...new Set([...(previous.sources || []), "Rightmove listing date", "MHCLG EPC property signature"])],
  }});
});
