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

function cleanText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function cleanPostcode(value: unknown) {
  const raw = String(value ?? "").toUpperCase().replace(/\s+/g, "").trim();
  if (!raw) return "";
  return raw.length > 3 ? `${raw.slice(0, -3)} ${raw.slice(-3)}` : raw;
}

function toNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const numeric = Number(String(value).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(numeric) ? numeric : null;
}

function parseMoney(value: unknown) {
  const number = toNumber(value);
  return number === null ? null : Math.round(number);
}

function isRightmoveUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (host === "rightmove.co.uk" || host.endsWith(".rightmove.co.uk")) && /\/properties\/\d+/.test(url.pathname);
  } catch {
    return false;
  }
}

function canonicalRightmoveUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function extractBalancedObject(source: string, marker: string) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = source.indexOf("{", markerIndex + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function firstValue(source: any, paths: string[][]) {
  for (const path of paths) {
    let current = source;
    for (const key of path) current = current?.[key];
    if (current !== undefined && current !== null && current !== "") return current;
  }
  return null;
}

function normalizePropertyType(value: unknown) {
  const text = cleanText(value).toLowerCase();
  if (!text) return "Other";
  if (text.includes("semi")) return "Semi-detached";
  if (text.includes("detached") && text.includes("bungalow")) return "Bungalow";
  if (text.includes("bungalow")) return "Bungalow";
  if (text.includes("terrace")) return "Terraced";
  if (text.includes("flat") || text.includes("apartment") || text.includes("maisonette")) return "Flat";
  if (text.includes("detached")) return "Detached";
  return "Other";
}

function extractFloorAreaM2(sizings: any) {
  if (!Array.isArray(sizings)) return null;
  for (const sizing of sizings) {
    const unit = cleanText(sizing?.unit ?? sizing?.units ?? sizing?.unitOfMeasure).toLowerCase();
    const min = toNumber(sizing?.minimumSize ?? sizing?.minSize ?? sizing?.minimum ?? sizing?.size);
    const max = toNumber(sizing?.maximumSize ?? sizing?.maxSize ?? sizing?.maximum);
    const value = max ?? min;
    if (value === null) continue;
    if (unit.includes("sq m") || unit.includes("sqm") || unit.includes("square metre") || unit.includes("m²")) return Math.round(value * 10) / 10;
    if (unit.includes("sq ft") || unit.includes("sqft") || unit.includes("square foot") || unit.includes("ft²")) return Math.round(value * 0.092903 * 10) / 10;
  }
  return null;
}

function recursiveFindRating(value: any, depth = 0): { band: string | null; rating: number | null } | null {
  if (!value || depth > 6) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = recursiveFindRating(item, depth + 1);
      if (found?.band || found?.rating !== null) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  let band: string | null = null;
  let rating: number | null = null;
  for (const [key, raw] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if ((lower.includes("band") || lower.includes("rating")) && typeof raw === "string" && /^[A-G]$/i.test(raw.trim())) band = raw.trim().toUpperCase();
    if ((lower.includes("rating") || lower.includes("efficiency")) && rating === null) {
      const number = toNumber(raw);
      if (number !== null && number >= 0 && number <= 100) rating = Math.round(number);
    }
  }
  if (band || rating !== null) return { band, rating };
  for (const raw of Object.values(value)) {
    const found = recursiveFindRating(raw, depth + 1);
    if (found?.band || found?.rating !== null) return found;
  }
  return null;
}

function extractFallback(html: string, url: string) {
  const title = cleanText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/&pound;/gi, "£").replace(/&amp;/gi, "&");
  const address = cleanText(title.replace(/^\d+\s+bedroom[^]*?for sale in\s+/i, "").replace(/\s*[-|].*$/, ""));
  const bedrooms = toNumber(title.match(/(\d+)\s+bedroom/i)?.[1]);
  const priceText = html.match(/£\s?[0-9][0-9,]*/)?.[0] ?? "";
  return { source: "rightmove", listingId: url.match(/\/properties\/(\d+)/)?.[1] ?? null, url, address: address || null, postcode: null, price: parseMoney(priceText), priceQualifier: null, bedrooms: bedrooms === null ? null : Math.round(bedrooms), bathrooms: null, propertyType: "Other", tenure: null, councilTaxBand: null, parking: null, garden: null, floorAreaM2: null, advertisedEpcBand: null, advertisedEpcRating: null, latitude: null, longitude: null, description: null, keyFeatures: [], confidence: "partial" };
}

function parseRightmovePage(html: string, url: string) {
  const rawModel = extractBalancedObject(html, "window.PAGE_MODEL");
  if (!rawModel) return extractFallback(html, url);
  const pageModel = JSON.parse(rawModel);
  const pd = pageModel?.propertyData ?? pageModel?.property ?? null;
  if (!pd) return extractFallback(html, url);
  const addressInfo = pd.address ?? {};
  const outcode = cleanText(addressInfo.outcode);
  const incode = cleanText(addressInfo.incode);
  const postcode = cleanPostcode([outcode, incode].filter(Boolean).join(" ")) || null;
  const displayAddress = cleanText(addressInfo.displayAddress ?? pd.displayAddress);
  const priceRaw = firstValue(pd, [["prices", "primaryPrice"], ["price", "amount"], ["price"]]);
  const qualifier = cleanText(firstValue(pd, [["prices", "displayPriceQualifier"], ["price", "qualifier"]]));
  const propertyTypeRaw = firstValue(pd, [["propertySubType"], ["propertyTypeFullDescription"], ["propertyType"]]);
  const features = (pd.keyFeatures ?? pd.features ?? []).map((item: any) => cleanText(typeof item === "string" ? item : item?.feature ?? item?.text)).filter(Boolean);
  const description = cleanText(firstValue(pd, [["text", "description"], ["description"]]));
  const combinedText = `${features.join(" ")} ${description}`.toLowerCase();
  const parking = /off[ -]?road parking|driveway|parking|garage|car port|carport/.test(combinedText);
  const garden = /garden|rear yard|courtyard|patio/.test(combinedText);
  const epc = recursiveFindRating(pd.epcGraphs ?? pd.epc ?? pd.energyPerformance ?? null);
  return {
    source: "rightmove",
    listingId: String(pd.id ?? url.match(/\/properties\/(\d+)/)?.[1] ?? "") || null,
    url,
    address: displayAddress || null,
    postcode,
    price: parseMoney(priceRaw),
    priceQualifier: qualifier || null,
    bedrooms: toNumber(pd.bedrooms) === null ? null : Math.round(Number(pd.bedrooms)),
    bathrooms: toNumber(pd.bathrooms) === null ? null : Math.round(Number(pd.bathrooms)),
    propertyType: normalizePropertyType(propertyTypeRaw),
    propertyTypeRaw: cleanText(propertyTypeRaw) || null,
    tenure: cleanText(firstValue(pd, [["tenure", "tenureType"], ["tenure", "displayText"], ["tenure"]])) || null,
    councilTaxBand: cleanText(firstValue(pd, [["livingCosts", "councilTaxBand"], ["councilTax", "band"], ["councilTaxBand"]])) || null,
    parking,
    garden,
    floorAreaM2: extractFloorAreaM2(pd.sizings),
    advertisedEpcBand: epc?.band ?? null,
    advertisedEpcRating: epc?.rating ?? null,
    latitude: toNumber(firstValue(pd, [["location", "latitude"], ["latitude"]])),
    longitude: toNumber(firstValue(pd, [["location", "longitude"], ["longitude"]])),
    description: description || null,
    keyFeatures: features,
    confidence: postcode && displayAddress && parseMoney(priceRaw) !== null ? "high" : "partial",
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let listingUrl = "";
  try { const body = await req.json(); listingUrl = cleanText(body?.url); }
  catch { return json({ error: "Invalid JSON body" }, 400); }
  if (!listingUrl) return json({ error: "url is required" }, 400);
  if (!isRightmoveUrl(listingUrl)) return json({ error: "Paste a Rightmove property URL", code: "UNSUPPORTED_URL" }, 400);
  const canonicalUrl = canonicalRightmoveUrl(listingUrl);
  try {
    const response = await fetch(canonicalUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
        "Cache-Control": "no-cache",
      },
    });
    const html = await response.text();
    if (!response.ok) {
      console.error("Rightmove fetch failed", { status: response.status, body: html.slice(0, 300) });
      return json({ error: "Rightmove did not return the listing page", code: "LISTING_FETCH_FAILED", status: response.status }, 502);
    }
    const listing = parseRightmovePage(html, canonicalUrl);
    if (!listing.address && listing.price === null && listing.bedrooms === null) return json({ error: "The listing page loaded but its property data could not be read", code: "LISTING_PARSE_FAILED" }, 422);
    return json({ status: "ok", listing });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("Listing import failed", { canonicalUrl, detail });
    return json({ error: "Listing import failed", detail, code: "LISTING_IMPORT_FAILED" }, 502);
  }
});
