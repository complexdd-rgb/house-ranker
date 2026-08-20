const VERSION = "2.0";

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

function htmlDecode(value: string) {
  return value
    .replace(/&pound;/gi, "£")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function textFromHtml(html: string) {
  return cleanText(htmlDecode(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<\/p>|<\/li>|<\/div>|<\/h\d>/gi, " ")
    .replace(/<[^>]+>/g, " ")));
}

function cleanPostcode(value: unknown) {
  const raw = String(value ?? "").toUpperCase().replace(/\s+/g, "").trim();
  if (!/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(raw)) return "";
  return `${raw.slice(0, -3)} ${raw.slice(-3)}`;
}

function extractFullPostcode(value: unknown) {
  const match = String(value ?? "").toUpperCase().match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/);
  return match ? cleanPostcode(match[1]) : "";
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

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function advertisedStreet(address: unknown) {
  let first = cleanText(address).split(",")[0] || "";
  first = first.replace(/^\d+[A-Z]?\s+/i, "").trim();
  return first;
}

function extractCoordinates(source: string) {
  const pairs = [
    [/"latitude"\s*:\s*(-?\d{1,3}\.\d+)/i, /"longitude"\s*:\s*(-?\d{1,3}\.\d+)/i],
    [/"lat"\s*:\s*(-?\d{1,3}\.\d+)/i, /"lng"\s*:\s*(-?\d{1,3}\.\d+)/i],
    [/"lat"\s*:\s*(-?\d{1,3}\.\d+)/i, /"lon"\s*:\s*(-?\d{1,3}\.\d+)/i],
  ];
  for (const [latRe, lonRe] of pairs) {
    const latitude = toNumber(source.match(latRe)?.[1]);
    const longitude = toNumber(source.match(lonRe)?.[1]);
    if (latitude !== null && longitude !== null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) return { latitude, longitude };
  }
  return { latitude: null, longitude: null };
}

function extractLinks(html: string) {
  const urls: string[] = [];
  const re = /href=["']([^"']+)["']/gi;
  for (const match of html.matchAll(re)) {
    const href = htmlDecode(match[1]);
    if (/^https?:\/\//i.test(href)) urls.push(href);
  }
  return [...new Set(urls)];
}

function agentDetailsLink(html: string) {
  const links = extractLinks(html);
  return links.find(url => /williamhbrown\.co\.uk\/property\//i.test(url))
    || links.find(url => /sequencehome\.co\.uk\/property\//i.test(url))
    || null;
}

function brochureLink(html: string) {
  return extractLinks(html).find(url => /media\.rightmove\.co\.uk\/property-brochure\/.+\.pdf(?:$|\?)/i.test(url)) || null;
}

function extractReference(text: string) {
  return cleanText(text.match(/Property reference\s+([A-Z0-9-]+)/i)?.[1] ?? "") || null;
}

function extractExactAddress(source: string, street: string) {
  if (!street) return null;
  const text = textFromHtml(source);
  const streetRe = escapeRegex(street).replace(/\s+/g, "\\s+");
  const pattern = new RegExp(`\\b(\\d+[A-Z]?)\\s+${streetRe}\\b.{0,140}?\\b([A-Z]{1,2}\\d[A-Z\\d]?\\s*\\d[A-Z]{2})\\b`, "i");
  const match = text.match(pattern);
  if (!match) return null;
  const postcode = cleanPostcode(match[2]);
  if (!postcode) return null;
  const between = cleanText(match[0].replace(new RegExp(`^${escapeRegex(match[1])}\\s+`, "i"), "").replace(new RegExp(`${escapeRegex(match[2])}$`, "i"), ""));
  return { houseNumber: match[1].toUpperCase(), postcode, address: `${match[1]} ${between.replace(/[,\s]+$/g, "")}, ${postcode}` };
}

function extractFullPostcodeNearStreet(source: string, street: string) {
  if (!street) return "";
  const text = textFromHtml(source);
  const streetRe = escapeRegex(street).replace(/\s+/g, "\\s+");
  const match = text.match(new RegExp(`${streetRe}.{0,160}?\\b([A-Z]{1,2}\\d[A-Z\\d]?\\s*\\d[A-Z]{2})\\b`, "i"));
  return match ? cleanPostcode(match[1]) : "";
}

function extractSectionText(text: string, startLabel: string, endLabels: string[]) {
  const start = text.toLowerCase().indexOf(startLabel.toLowerCase());
  if (start < 0) return "";
  let end = text.length;
  for (const label of endLabels) {
    const index = text.toLowerCase().indexOf(label.toLowerCase(), start + startLabel.length);
    if (index >= 0 && index < end) end = index;
  }
  return cleanText(text.slice(start + startLabel.length, end));
}

function extractLastChoice(windowText: string, choices: string[]) {
  let best: { index: number; value: string } | null = null;
  for (const choice of choices) {
    for (const match of windowText.matchAll(new RegExp(`\\b${escapeRegex(choice)}\\b`, "gi"))) {
      if (!best || Number(match.index) > best.index) best = { index: Number(match.index), value: choice };
    }
  }
  return best?.value || null;
}

function extractSemanticFallback(html: string, url: string) {
  const text = textFromHtml(html);
  const title = cleanText(htmlDecode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""));
  const address = cleanText(title.replace(/^\d+\s+bedroom[^]*?for sale in\s+/i, "").replace(/\s*[-|].*$/, ""));
  const street = advertisedStreet(address);
  const bedrooms = toNumber(title.match(/(\d+)\s+bedroom/i)?.[1] ?? text.match(/BEDROOMS\s+(\d+)/i)?.[1]);
  const bathrooms = toNumber(text.match(/BATHROOMS\s+(\d+)/i)?.[1]);
  const propertyTypeRaw = title.match(/\d+\s+bedroom\s+(.+?)\s+for sale/i)?.[1] || text.match(/PROPERTY TYPE\s+(.+?)\s+BEDROOMS/i)?.[1] || "";
  const tenureWindow = text.match(/TENURE(.{0,700}?)(?:Key features|Description|Council Tax|PARKING|GARDEN)/i)?.[1] || "";
  const tenure = extractLastChoice(tenureWindow, ["Freehold", "Leasehold", "Commonhold"]);
  const councilTaxBand = cleanText(text.match(/Council Tax Band\s*:?\s*([A-H])/i)?.[1] ?? text.match(/Band\s*:\s*([A-H])\s+PARKING/i)?.[1] ?? "").toUpperCase() || null;
  const featureText = extractSectionText(text, "Key features", ["Description"]);
  const description = extractSectionText(text, "Description", ["Brochures", "COUNCIL TAX", "Affordability"]);
  const combined = `${featureText} ${description}`.toLowerCase();
  const priceText = text.match(/£\s?[0-9][0-9,]*/)?.[0] ?? "";
  const priceQualifier = text.match(/\b(Guide Price|Offers Over|Offers in Excess of|Offers in Region of|Fixed Price)\b/i)?.[1] || null;
  const coordinates = extractCoordinates(html);
  const exact = extractExactAddress(html, street);
  const postcode = exact?.postcode || extractFullPostcodeNearStreet(html, street) || null;
  const agentUrl = agentDetailsLink(html);
  const brochureUrl = brochureLink(html);
  const reference = extractReference(text);
  return {
    source: "rightmove",
    parserVersion: VERSION,
    listingId: url.match(/\/properties\/(\d+)/)?.[1] ?? null,
    url,
    address: exact?.address || address || null,
    postcode,
    price: parseMoney(priceText),
    priceQualifier,
    bedrooms: bedrooms === null ? null : Math.round(bedrooms),
    bathrooms: bathrooms === null ? null : Math.round(bathrooms),
    propertyType: normalizePropertyType(propertyTypeRaw),
    propertyTypeRaw: cleanText(propertyTypeRaw) || null,
    tenure,
    councilTaxBand,
    parking: /off[ -]?street parking|off[ -]?road parking|driveway|garage|car port|carport/.test(combined) ? true : null,
    garden: /garden|rear yard|courtyard|patio/.test(combined) ? true : null,
    floorAreaM2: null,
    advertisedEpcBand: null,
    advertisedEpcRating: null,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    description: description || null,
    keyFeatures: featureText ? [featureText.slice(0, 1200)] : [],
    agentReference: reference,
    agentDetailsUrl: agentUrl,
    brochureUrl,
    exactAddressSource: exact ? "rightmove_html" : null,
    confidence: exact && postcode ? "high" : "partial",
  };
}

function parseRightmovePage(html: string, url: string) {
  const rawModel = extractBalancedObject(html, "window.PAGE_MODEL");
  if (!rawModel) return extractSemanticFallback(html, url);
  try {
    const pageModel = JSON.parse(rawModel);
    const pd = pageModel?.propertyData ?? pageModel?.property ?? null;
    if (!pd) return extractSemanticFallback(html, url);
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
    const epc = recursiveFindRating(pd.epcGraphs ?? pd.epc ?? pd.energyPerformance ?? null);
    return {
      source: "rightmove",
      parserVersion: VERSION,
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
      parking: /off[ -]?road parking|driveway|parking|garage|car port|carport/.test(combinedText),
      garden: /garden|rear yard|courtyard|patio/.test(combinedText),
      floorAreaM2: extractFloorAreaM2(pd.sizings),
      advertisedEpcBand: epc?.band ?? null,
      advertisedEpcRating: epc?.rating ?? null,
      latitude: toNumber(firstValue(pd, [["location", "latitude"], ["latitude"]])),
      longitude: toNumber(firstValue(pd, [["location", "longitude"], ["longitude"]])),
      description: description || null,
      keyFeatures: features,
      agentReference: extractReference(textFromHtml(html)),
      agentDetailsUrl: agentDetailsLink(html),
      brochureUrl: brochureLink(html),
      confidence: postcode && displayAddress && parseMoney(priceRaw) !== null ? "high" : "partial",
    };
  } catch {
    return extractSemanticFallback(html, url);
  }
}

function safeExternalUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || /^127\.|^10\.|^192\.168\.|^169\.254\./.test(host)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function fetchExternalHtml(url: string) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.9",
    },
  });
  if (!response.ok) throw new Error(`${new URL(url).hostname} returned ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) throw new Error("Agent full details did not return HTML");
  return response.text();
}

async function enrichFromAgentPage(listing: any) {
  const url = safeExternalUrl(listing?.agentDetailsUrl || null);
  if (!url) return listing;
  try {
    const html = await fetchExternalHtml(url);
    const street = advertisedStreet(listing.address);
    const exact = extractExactAddress(html, street);
    const nearPostcode = extractFullPostcodeNearStreet(html, street);
    const coordinates = extractCoordinates(html);
    listing.agentPageFetched = true;
    listing.agentPageUrl = url;
    if (exact) {
      listing.address = exact.address;
      listing.postcode = exact.postcode;
      listing.exactAddressSource = "agent_full_details";
      listing.agentAddressEvidence = { houseNumber: exact.houseNumber, postcode: exact.postcode };
      listing.confidence = "high";
    } else if (!listing.postcode && nearPostcode) {
      listing.postcode = nearPostcode;
      listing.postcodeSource = "agent_full_details";
    }
    if (listing.latitude == null && coordinates.latitude != null) listing.latitude = coordinates.latitude;
    if (listing.longitude == null && coordinates.longitude != null) listing.longitude = coordinates.longitude;
    const agentText = textFromHtml(html);
    if (!listing.councilTaxBand) listing.councilTaxBand = cleanText(agentText.match(/Council Tax Band\s*:?\s*([A-H])/i)?.[1] ?? "").toUpperCase() || null;
    if (!listing.tenure) listing.tenure = extractLastChoice(agentText, ["Freehold", "Leasehold", "Commonhold"]);
  } catch (error) {
    listing.agentPageFetched = false;
    listing.agentPageError = error instanceof Error ? error.message : String(error);
  }
  return listing;
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
      signal: AbortSignal.timeout(10000),
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
    let listing = parseRightmovePage(html, canonicalUrl);
    listing = await enrichFromAgentPage(listing);
    if (!listing.address && listing.price === null && listing.bedrooms === null) return json({ error: "The listing page loaded but its property data could not be read", code: "LISTING_PARSE_FAILED" }, 422);
    return json({ status: "ok", version: VERSION, listing });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("Listing import failed", { canonicalUrl, detail });
    return json({ error: "Listing import failed", detail, code: "LISTING_IMPORT_FAILED" }, 502);
  }
});
