const VERSION = "1.0";
const EPC_BASE_URL = "https://api.get-energy-performance-data.communities.gov.uk";
const POSTCODES_IO = "https://api.postcodes.io/postcodes";
const UPRNS_IO = "https://api.uprns.io/uprns";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

function cleanText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function compactPostcode(value: unknown) {
  return cleanText(value).toUpperCase().replace(/\s+/g, "");
}

function cleanPostcode(value: unknown) {
  const raw = compactPostcode(value);
  if (!/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(raw)) return "";
  return `${raw.slice(0, -3)} ${raw.slice(-3)}`;
}

function extractPostcode(value: unknown) {
  const match = cleanText(value).toUpperCase().match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/);
  return match ? cleanPostcode(match[1]) : "";
}

function extractOutcode(value: unknown) {
  const full = cleanPostcode(value) || extractPostcode(value);
  if (full) return full.split(" ")[0];
  const matches = cleanText(value).toUpperCase().match(/\b([A-Z]{1,2}\d[A-Z\d]?)\b/g) || [];
  return matches.length ? matches[matches.length - 1] : "";
}

function toNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeAddress(value: unknown) {
  return cleanText(value)
    .toUpperCase()
    .replace(/\b(UNIT|APARTMENT)\b/g, "FLAT")
    .replace(/\bROAD\b/g, "RD")
    .replace(/\bSTREET\b/g, "ST")
    .replace(/\bAVENUE\b/g, "AVE")
    .replace(/\bDRIVE\b/g, "DR")
    .replace(/\bLANE\b/g, "LN")
    .replace(/\bCLOSE\b/g, "CL")
    .replace(/\bCOURT\b/g, "CT")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string) {
  return new Set(normalizeAddress(value).split(" ").filter(token => token.length > 1));
}

function jaccard(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = new Set([...left, ...right]).size;
  return union ? intersection / union : 0;
}

function streetName(value: unknown) {
  let first = cleanText(value).split(",")[0] || "";
  first = first.replace(/^FLAT\s+[A-Z0-9-]+\s+/i, "").replace(/^\d+[A-Z]?\s+/i, "").trim();
  return first;
}

function houseIdentifier(value: unknown) {
  const first = normalizeAddress(cleanText(value).split(",")[0] || value);
  const flat = first.match(/\bFLAT\s+([A-Z0-9-]+)\b/);
  const house = first.match(/\b(\d+[A-Z]?)\b/);
  return `${flat?.[1] ?? ""}|${house?.[1] ?? ""}`;
}

function hasSpecificPremise(value: unknown) {
  return houseIdentifier(value) !== "|";
}

function normalizePropertyType(value: unknown) {
  const text = cleanText(value).toLowerCase();
  if (!text) return null;
  if (text.includes("semi")) return "Semi-detached";
  if (text.includes("bungalow")) return "Bungalow";
  if (text.includes("terrace")) return "Terraced";
  if (text.includes("flat") || text.includes("apartment") || text.includes("maisonette")) return "Flat";
  if (text.includes("detached")) return "Detached";
  return null;
}

function inferListingType(listing: any) {
  const explicit = normalizePropertyType(listing?.propertyTypeRaw) || normalizePropertyType(listing?.propertyType);
  const combined = `${(listing?.keyFeatures || []).join(" ")} ${listing?.description || ""}`.toLowerCase();
  if (/\bsemi[- ]detached\b/.test(combined)) return "Semi-detached";
  if (/\bdetached\s+(?:family\s+)?(?:home|house|property|bungalow)\b/.test(combined)) return combined.includes("bungalow") ? "Bungalow" : "Detached";
  return explicit;
}

function candidateAddress(row: Record<string, unknown>) {
  return [row.addressLine1, row.addressLine2, row.addressLine3, row.addressLine4, row.postTown]
    .map(cleanText).filter(Boolean).join(", ");
}

function candidatePostcode(row: Record<string, unknown>) {
  return cleanPostcode(row.postcode);
}

function candidateUprn(row: Record<string, unknown>) {
  return cleanText(row.uprn);
}

function candidateCertificate(row: Record<string, unknown>) {
  return cleanText(row.certificateNumber ?? row.certificate_number);
}

function candidateBand(row: Record<string, unknown>) {
  return cleanText(row.currentEnergyEfficiencyBand ?? row.current_energy_efficiency_band).toUpperCase();
}

function getSearchRows(payload: any): Record<string, unknown>[] {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload)) return payload;
  return [];
}

function dedupeRows(rows: Record<string, unknown>[]) {
  const seen = new Set<string>();
  return rows.filter(row => {
    const key = candidateCertificate(row) || candidateUprn(row) || `${candidateAddress(row)}|${candidatePostcode(row)}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 8000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${new URL(url).hostname} returned ${response.status}`);
  return response.json();
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

function addressVariants(address: string) {
  const parts = cleanText(address).split(",").map(x => x.trim()).filter(Boolean);
  const variants = [parts.slice(0, 2).join(", "), parts[0], streetName(address)];
  return [...new Set(variants.filter(v => v.length >= 3))];
}

function haversineMetres(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000;
  const rad = (n: number) => n * Math.PI / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function reversePostcode(latitude: number | null, longitude: number | null, outcode: string) {
  if (latitude === null || longitude === null) return null;
  try {
    const payload = await fetchJson(`${POSTCODES_IO}?lon=${encodeURIComponent(longitude)}&lat=${encodeURIComponent(latitude)}&radius=500&limit=20`, {
      headers: { "User-Agent": "House-Ranker/1.0" },
    });
    const rows = Array.isArray(payload?.result) ? payload.result : [];
    const filtered = outcode ? rows.filter((row: any) => extractOutcode(row?.postcode) === outcode) : rows;
    const best = (filtered.length ? filtered : rows)[0];
    if (!best?.postcode) return null;
    return { postcode: cleanPostcode(best.postcode), distanceM: toNumber(best.distance), latitude: toNumber(best.latitude), longitude: toNumber(best.longitude) };
  } catch {
    return null;
  }
}

async function uprnPoint(uprn: string) {
  if (!uprn) return null;
  try {
    const payload = await fetchJson(`${UPRNS_IO}/${encodeURIComponent(uprn)}`, {
      headers: { "User-Agent": "House-Ranker/1.0" },
    }, 6000);
    const latitude = toNumber(payload?.latitude ?? payload?.lat ?? payload?.geo?.latitude);
    const longitude = toNumber(payload?.longitude ?? payload?.lng ?? payload?.lon ?? payload?.geo?.longitude);
    if (latitude === null || longitude === null) return null;
    return { latitude, longitude };
  } catch {
    return null;
  }
}

async function certificateDetail(certificateNumber: string, token: string) {
  if (!certificateNumber) return null;
  try {
    const payload = await epcGet("/api/certificate", new URLSearchParams({ certificate_number: certificateNumber }), token);
    return (payload?.data ?? payload ?? null) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

function pick(source: Record<string, unknown> | null, ...keys: string[]) {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function detailAddress(detail: Record<string, unknown> | null, fallback: Record<string, unknown>) {
  if (!detail) return candidateAddress(fallback);
  const address = [
    pick(detail, "address1", "address_line_1", "addressLine1"),
    pick(detail, "address2", "address_line_2", "addressLine2"),
    pick(detail, "address3", "address_line_3", "addressLine3"),
    pick(detail, "posttown", "post_town", "postTown"),
  ].map(cleanText).filter(Boolean).join(", ");
  return address || candidateAddress(fallback);
}

function detailPostcode(detail: Record<string, unknown> | null, fallback: Record<string, unknown>) {
  return cleanPostcode(pick(detail, "postcode") ?? fallback.postcode);
}

function detailPropertyType(detail: Record<string, unknown> | null) {
  if (!detail) return null;
  const built = normalizePropertyType(pick(detail, "built_form", "builtForm"));
  const property = normalizePropertyType(pick(detail, "property_type", "propertyType"));
  return built || property;
}

function detailFloorArea(detail: Record<string, unknown> | null) {
  return toNumber(pick(detail, "total_floor_area", "totalFloorArea"));
}

function detailBand(detail: Record<string, unknown> | null) {
  return cleanText(pick(detail, "current_energy_efficiency_band", "currentEnergyEfficiencyBand")).toUpperCase() || null;
}

function detailRating(detail: Record<string, unknown> | null) {
  return toNumber(pick(detail, "current_energy_efficiency", "currentEnergyEfficiency", "energy_rating_current", "energyRatingCurrent"));
}

function sourceOutcode(listing: any) {
  return extractOutcode(listing?.postcode) || extractOutcode(listing?.address);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let listing: any;
  try { listing = (await req.json())?.listing; }
  catch { return json({ error: "Invalid JSON body" }, 400); }
  if (!listing || typeof listing !== "object") return json({ error: "listing is required" }, 400);

  const advertisedAddress = cleanText(listing.address);
  const latitude = toNumber(listing.latitude);
  const longitude = toNumber(listing.longitude);
  const listingType = inferListingType(listing);
  const listingFloorArea = toNumber(listing.floorAreaM2);
  const listingBand = cleanText(listing.advertisedEpcBand).toUpperCase();
  const fullFromListing = cleanPostcode(listing.postcode) || extractPostcode(advertisedAddress);
  const outcode = sourceOutcode(listing);
  const reverse = await reversePostcode(latitude, longitude, outcode);
  const reversePc = reverse?.postcode || "";

  const epcToken = Deno.env.get("EPC_BEARER_TOKEN") || "";
  const warnings: string[] = [];
  if (!epcToken) warnings.push("EPC token unavailable; exact-address matching is limited");

  let rows: Record<string, unknown>[] = [];
  if (epcToken) {
    const postcodes = [...new Set([fullFromListing, reversePc].filter(Boolean))];
    for (const postcode of postcodes) {
      try {
        const payload = await epcGet("/api/domestic/search", new URLSearchParams({ postcode, page_size: "500" }), epcToken);
        rows.push(...getSearchRows(payload));
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (!rows.length && advertisedAddress) {
      for (const variant of addressVariants(advertisedAddress)) {
        try {
          const payload = await epcGet("/api/domestic/search", new URLSearchParams({ address: variant, page_size: "500" }), epcToken);
          const found = getSearchRows(payload).filter(row => !outcode || extractOutcode(candidatePostcode(row)) === outcode);
          rows.push(...found);
          if (found.length) break;
        } catch (error) {
          warnings.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  rows = dedupeRows(rows);
  const targetStreet = streetName(advertisedAddress);
  const targetHouse = houseIdentifier(advertisedAddress);
  const targetHasHouse = hasSpecificPremise(advertisedAddress);

  let candidates = rows.map(row => {
    const address = candidateAddress(row);
    const postcode = candidatePostcode(row);
    const streetSimilarity = jaccard(tokens(targetStreet), tokens(streetName(address)));
    let score = streetSimilarity * 45;
    if (fullFromListing && postcode === fullFromListing) score += 20;
    else if (reversePc && postcode === reversePc) score += 12;
    if (outcode && extractOutcode(postcode) === outcode) score += 8;
    if (targetHasHouse) score += houseIdentifier(address) === targetHouse ? 30 : -30;
    if (listingBand && candidateBand(row) === listingBand) score += 8;
    return { row, address, postcode, uprn: candidateUprn(row), certificateNumber: candidateCertificate(row), streetSimilarity, score, distanceM: null as number | null, detail: null as Record<string, unknown> | null };
  }).filter(item => item.streetSimilarity >= 0.18 || item.postcode === fullFromListing || item.postcode === reversePc)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);

  if (latitude !== null && longitude !== null && candidates.length) {
    const points = await Promise.all(candidates.map(async candidate => ({ candidate, point: await uprnPoint(candidate.uprn) })));
    for (const { candidate, point } of points) {
      if (!point) continue;
      const distance = haversineMetres(latitude, longitude, point.latitude, point.longitude);
      candidate.distanceM = Math.round(distance * 10) / 10;
      if (distance <= 15) candidate.score += 50;
      else if (distance <= 30) candidate.score += 42;
      else if (distance <= 50) candidate.score += 32;
      else if (distance <= 80) candidate.score += 20;
      else if (distance <= 120) candidate.score += 10;
      else if (distance <= 200) candidate.score += 4;
      else candidate.score -= 8;
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  if (epcToken && candidates.length) {
    const detailTargets = candidates.slice(0, 6);
    const details = await Promise.all(detailTargets.map(async candidate => ({ candidate, detail: await certificateDetail(candidate.certificateNumber, epcToken) })));
    for (const { candidate, detail } of details) {
      candidate.detail = detail;
      const resolvedType = detailPropertyType(detail);
      const floorArea = detailFloorArea(detail);
      const band = detailBand(detail);
      if (listingType && resolvedType) candidate.score += listingType === resolvedType ? 12 : -8;
      if (listingBand && band) candidate.score += listingBand === band ? 10 : -5;
      if (listingFloorArea !== null && floorArea !== null && listingFloorArea > 0) {
        const delta = Math.abs(floorArea - listingFloorArea) / listingFloorArea;
        if (delta <= .05) candidate.score += 22;
        else if (delta <= .10) candidate.score += 16;
        else if (delta <= .20) candidate.score += 8;
        else if (delta > .35) candidate.score -= 10;
      }
    }
    candidates.sort((a, b) => b.score - a.score);
  }

  const top = candidates[0] || null;
  const second = candidates[1] || null;
  const gap = top ? top.score - (second?.score ?? 0) : 0;
  const sameStreet = Boolean(top && top.streetSimilarity >= .45);
  const topHouseMatches = Boolean(top && targetHasHouse && houseIdentifier(top.address) === targetHouse);
  const metadataMatches = top ? [
    listingType && detailPropertyType(top.detail) ? listingType === detailPropertyType(top.detail) : false,
    listingBand && detailBand(top.detail) ? listingBand === detailBand(top.detail) : false,
    listingFloorArea !== null && detailFloorArea(top.detail) !== null ? Math.abs(Number(detailFloorArea(top.detail)) - listingFloorArea) / listingFloorArea <= .15 : false,
  ].filter(Boolean).length : 0;

  let exact = false;
  let method = "";
  if (top && sameStreet && topHouseMatches) {
    exact = true;
    method = "advertised_premise_epc_match";
  } else if (top && sameStreet && top.distanceM !== null && top.distanceM <= 20 && gap >= 10) {
    exact = true;
    method = "epc_uprn_coordinate_match";
  } else if (top && sameStreet && top.distanceM !== null && top.distanceM <= 35 && gap >= 8 && metadataMatches >= 1) {
    exact = true;
    method = "epc_uprn_coordinate_and_property_match";
  } else if (top && sameStreet && candidates.filter(item => item.streetSimilarity >= .55 && item.postcode === top.postcode).length === 1 && (top.postcode === fullFromListing || top.postcode === reversePc)) {
    exact = true;
    method = "unique_epc_street_postcode_match";
  }

  let resolvedPostcode = "";
  let postcodeMethod = "";
  if (exact && top?.postcode) {
    resolvedPostcode = top.postcode;
    postcodeMethod = method;
  } else if (fullFromListing) {
    resolvedPostcode = fullFromListing;
    postcodeMethod = "rightmove_full_postcode";
  } else {
    const plausible = candidates.filter(item => item.streetSimilarity >= .45).map(item => item.postcode).filter(Boolean);
    const unique = [...new Set(plausible)];
    if (unique.length === 1) {
      resolvedPostcode = unique[0];
      postcodeMethod = "epc_street_postcode";
    } else if (reversePc && (reverse?.distanceM === null || Number(reverse?.distanceM) <= 150)) {
      resolvedPostcode = reversePc;
      postcodeMethod = "rightmove_coordinate_postcode";
    }
  }

  const resolvedAddress = exact && top ? `${detailAddress(top.detail, top.row)}${detailPostcode(top.detail, top.row) ? `, ${detailPostcode(top.detail, top.row)}` : ""}` : null;
  const resolvedUprn = exact && top ? (cleanText(pick(top.detail, "uprn")) || top.uprn || null) : null;
  const confidence = exact
    ? Math.min(99, Math.round(82 + Math.min(10, Math.max(0, gap)) + Math.min(7, metadataMatches * 3)))
    : resolvedPostcode
      ? (postcodeMethod === "rightmove_full_postcode" ? 95 : postcodeMethod === "epc_street_postcode" ? 82 : 68)
      : 35;

  const resolution = {
    version: VERSION,
    status: exact ? "exact" : resolvedPostcode ? "postcode_only" : candidates.length ? "ambiguous" : "unresolved",
    advertisedAddress: advertisedAddress || null,
    address: resolvedAddress,
    postcode: resolvedPostcode || null,
    uprn: resolvedUprn,
    confidence,
    method: exact ? method : postcodeMethod || "none",
    rightmoveCoordinates: latitude !== null && longitude !== null ? { latitude, longitude } : null,
    reversePostcode: reverse,
    propertyType: exact && top ? (detailPropertyType(top.detail) || listingType || null) : null,
    floorAreaM2: exact && top ? detailFloorArea(top.detail) : null,
    epcBand: exact && top ? detailBand(top.detail) : null,
    epcRating: exact && top ? detailRating(top.detail) : null,
    candidates: candidates.slice(0, 6).map(item => ({
      address: item.address,
      postcode: item.postcode || null,
      uprn: item.uprn || null,
      distanceM: item.distanceM,
      score: Math.round(item.score),
      streetSimilarity: Math.round(item.streetSimilarity * 100),
      propertyType: detailPropertyType(item.detail),
      floorAreaM2: detailFloorArea(item.detail),
      epcBand: detailBand(item.detail) || candidateBand(item.row) || null,
    })),
    warnings: [...new Set(warnings)].slice(0, 5),
    sources: ["Rightmove advert", "MHCLG EPC data", "Postcodes.io", "OS Open UPRN via uprns.io"],
  };

  return json({ status: "ok", resolution });
});
