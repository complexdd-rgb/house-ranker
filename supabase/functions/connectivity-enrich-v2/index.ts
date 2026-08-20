import { createClient } from "npm:@supabase/supabase-js@2.111.0";
import { Unzip, UnzipInflate } from "npm:fflate@0.8.2";

const VERSION = "2.0";
const FIXED_ZIP = "https://www.ofcom.org.uk/siteassets/resources/documents/research-and-data/multi-sector/infrastructure-research/connected-nations-spring-2026/202601_fixed_broadband_coverage_and_full_fibre_take-up-r1.zip?v=422620";
const MOBILE_ZIP = "https://www.ofcom.org.uk/siteassets/resources/documents/research-and-data/multi-sector/infrastructure-research/connected-nations-spring-2026/202601_mobile_coverage_r1.zip?v=417690";
const POSTCODES_IO = "https://api.postcodes.io/postcodes";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const j = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, "Content-Type": "application/json" },
});

const clamp = (v: number) => Math.max(0, Math.min(100, v));
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const pc = (v: unknown) => {
  const x = String(v ?? "").toUpperCase().replace(/\s+/g, "");
  return x.length > 3 ? `${x.slice(0, -3)} ${x.slice(-3)}` : x;
};
const fullPc = (v: unknown) => /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(String(v ?? "").trim());
const key = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

function postcodeArea(postcode: string) {
  return postcode.replace(/\s+/g, "").match(/^[A-Z]{1,2}/i)?.[0]?.toUpperCase() || "";
}

function parseCsvLine(line: string) {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out;
}

function parseCsv(text: string) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(line => line.trim().length);
  if (!lines.length) return [] as Record<string, string>[];
  const headers = parseCsvLine(lines[0]).map(key);
  return lines.slice(1).map(line => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
  });
}

async function extractZipText(url: string, matcher: (name: string) => boolean, timeoutMs = 30000) {
  const response = await fetch(url, {
    headers: { "User-Agent": "House-Ranker/2.0 open Ofcom data" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok || !response.body) throw new Error(`Ofcom download returned ${response.status}`);

  let found = false;
  let resolveFile!: (value: string) => void;
  let rejectFile!: (reason?: unknown) => void;
  const filePromise = new Promise<string>((resolve, reject) => { resolveFile = resolve; rejectFile = reject; });

  const unzip = new Unzip(file => {
    if (!matcher(file.name)) return;
    found = true;
    const chunks: Uint8Array[] = [];
    file.ondata = (err, chunk, final) => {
      if (err) { rejectFile(err); return; }
      if (chunk?.length) chunks.push(chunk);
      if (final) {
        const size = chunks.reduce((sum, item) => sum + item.length, 0);
        const joined = new Uint8Array(size);
        let offset = 0;
        for (const item of chunks) { joined.set(item, offset); offset += item.length; }
        resolveFile(new TextDecoder().decode(joined));
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);

  const reader = response.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) unzip.push(value, false);
  }
  unzip.push(new Uint8Array(0), true);
  if (!found) throw new Error("Requested Ofcom file was not found in archive");
  return await filePromise;
}

function field(row: Record<string, string>, names: string[]) {
  for (const name of names) {
    const value = row[key(name)];
    if (value !== undefined && value !== "") return value;
  }
  return null;
}

function pct(row: Record<string, string>, names: string[]) {
  const value = num(field(row, names));
  return value === null ? null : clamp(value);
}

async function freeBroadband(postcode: string) {
  const area = postcodeArea(postcode);
  if (!area) throw new Error("Could not resolve postcode area");
  const target = postcode.replace(/\s+/g, "").toUpperCase();
  const csv = await extractZipText(
    FIXED_ZIP,
    name => name.toLowerCase().includes("postcode_res_files/") && name.toLowerCase().endsWith(`_${area.toLowerCase()}.csv`),
    35000,
  );
  const rows = parseCsv(csv);
  const row = rows.find(item => String(item.postcode || "").toUpperCase() === target || String(item.postcodespace || "").replace(/\s+/g, "").toUpperCase() === target);
  if (!row) throw new Error(`No Ofcom residential broadband row found for ${postcode}`);

  const sfbb30 = pct(row, ["SFBB availability (% premises)"]);
  const ufbb100 = pct(row, ["UFBB (100Mbit/s) availability (% premises)"]);
  const ufbb300 = pct(row, ["UFBB availability (% premises)"]);
  const gigabit = pct(row, ["Gigabit availability (% premises)"]);
  const unable10 = pct(row, ["% of premises unable to receive 10Mbit/s"]);
  const decent = unable10 === null ? null : clamp(100 - unable10);

  const weighted: Array<[number | null, number]> = [[gigabit, 0.40], [ufbb300, 0.30], [ufbb100, 0.20], [sfbb30, 0.10]];
  const known = weighted.filter(([value]) => value !== null) as Array<[number, number]>;
  if (!known.length) throw new Error("Ofcom broadband row did not contain coverage percentages");
  const totalWeight = known.reduce((sum, [, weight]) => sum + weight, 0);
  const score = clamp(Math.round(known.reduce((sum, [value, weight]) => sum + value * weight, 0) / totalWeight));

  return {
    mode: "open_dataset",
    source: "Ofcom Connected Nations Spring 2026 fixed broadband postcode data",
    postcode,
    score,
    coverage: { sfbb30, ufbb100, ufbb300, gigabit, decent },
    gigabit: gigabit === null ? null : gigabit >= 90,
    fullFibre: null,
    maxDownloadMbps: null,
    maxUploadMbps: null,
  };
}

async function postcodeAdmin(postcode: string) {
  const compact = postcode.replace(/\s+/g, "");
  const response = await fetch(`${POSTCODES_IO}/${encodeURIComponent(compact)}`, {
    headers: { "User-Agent": "House-Ranker/2.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Postcodes.io returned ${response.status}`);
  const payload = await response.json();
  const result = payload?.result;
  const code = String(result?.codes?.admin_district || result?.codes?.admin_county || "");
  const name = String(result?.admin_district || result?.admin_county || "");
  if (!code) throw new Error("Could not resolve local authority for postcode");
  return { code, name };
}

function operatorIndex(row: Record<string, string>, prefix: string) {
  let any = false;
  let weighted = 0;
  for (let n = 0; n <= 4; n++) {
    const value = pct(row, [`${prefix}_${n}`]);
    if (value !== null) { any = true; weighted += n * value; }
  }
  return any ? clamp(weighted / 4) : null;
}

async function freeMobile(postcode: string) {
  const admin = await postcodeAdmin(postcode);
  const csv = await extractZipText(MOBILE_ZIP, name => name.toLowerCase().endsWith("202601_mobile_coverage_laua_r01.csv"), 15000);
  const rows = parseCsv(csv);
  const row = rows.find(item => String(item.laua || "").toUpperCase() === admin.code.toUpperCase());
  if (!row) throw new Error(`No Ofcom mobile row found for ${admin.code}`);

  const indoor4gIndex = operatorIndex(row, "4G_prem_in");
  const outdoor5gIndex = operatorIndex(row, "5G_high_confidence_prem_out");
  const indoor4gNone = pct(row, ["4G_prem_in_0"]);
  const indoor4gAll = pct(row, ["4G_prem_in_4"]);
  const outdoor5gNone = pct(row, ["5G_high_confidence_prem_out_0"]);
  const indoor4gAny = indoor4gNone === null ? null : clamp(100 - indoor4gNone);
  const outdoor5gAny = outdoor5gNone === null ? null : clamp(100 - outdoor5gNone);

  let score: number | null = null;
  if (indoor4gIndex !== null && outdoor5gIndex !== null) score = clamp(Math.round(0.70 * indoor4gIndex + 0.30 * outdoor5gIndex));
  else score = indoor4gIndex ?? outdoor5gIndex;
  if (score === null) throw new Error("Ofcom mobile row did not contain usable coverage percentages");

  return {
    mode: "open_dataset_area",
    source: "Ofcom Connected Nations Spring 2026 mobile local-authority data",
    score,
    localAuthority: admin,
    indoor4gNetworkIndex: indoor4gIndex,
    outdoor5gNetworkIndex: outdoor5gIndex,
    indoor4gAnyPct: indoor4gAny,
    indoor4gAllFourPct: indoor4gAll,
    outdoor5gAnyPct: outdoor5gAny,
  };
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return j({ error: "Method not allowed" }, 405);
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return j({ error: "Authentication required" }, 401);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  let clientKey = anon;
  try { clientKey = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}").default || anon; } catch {}
  const sb = createClient(url, clientKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: auth } },
  });
  const token = auth.replace(/^Bearer\s+/i, "");
  const { data: ud, error: ue } = await sb.auth.getUser(token);
  if (ue || !ud.user) return j({ error: "Invalid session" }, 401);

  let propertyId = "";
  try { propertyId = String((await req.json())?.propertyId ?? ""); }
  catch { return j({ error: "Invalid JSON body" }, 400); }
  if (!propertyId) return j({ error: "propertyId is required" }, 400);

  const { data: p, error: pe } = await sb.from("properties")
    .select("id,address,postcode,metrics")
    .eq("id", propertyId)
    .single();
  if (pe || !p) return j({ error: "Property not found" }, 404);

  const activeSince = new Date(Date.now() - 120000).toISOString();
  const { data: active } = await sb.from("enrichment_runs")
    .select("id")
    .eq("property_id", propertyId)
    .eq("source", "connectivity")
    .eq("status", "running")
    .gte("started_at", activeSince)
    .limit(1);
  if (active?.length) return j({ status: "already_running", property: p });

  const { data: run } = await sb.from("enrichment_runs").insert({
    property_id: propertyId,
    source: "connectivity",
    status: "running",
    started_at: new Date().toISOString(),
    payload: { version: VERSION, source: "Ofcom Connected Nations Spring 2026 open datasets" },
  }).select("id").single();

  const finish = async (status: string, payload: unknown, msg: string | null = null) => {
    if (run?.id) await sb.from("enrichment_runs").update({ status, finished_at: new Date().toISOString(), payload, error_message: msg }).eq("id", run.id);
  };

  try {
    const postcode = pc(p.postcode);
    const now = new Date().toISOString();
    if (!fullPc(postcode)) {
      const { data: updated } = await sb.from("properties").update({
        connectivity_status: "needs_location",
        connectivity_enriched_at: now,
        updated_at: now,
      }).eq("id", propertyId).select("*").single();
      await finish("succeeded", { outcome: "needs_location", version: VERSION });
      return j({ status: "needs_location", property: updated });
    }

    const [bbResult, mobileResult] = await Promise.allSettled([freeBroadband(postcode), freeMobile(postcode)]);
    const broadband = bbResult.status === "fulfilled" ? bbResult.value : null;
    const mobile = mobileResult.status === "fulfilled" ? mobileResult.value : null;
    const broadbandError = bbResult.status === "rejected" ? String((bbResult.reason as any)?.message || bbResult.reason) : null;
    const mobileError = mobileResult.status === "rejected" ? String((mobileResult.reason as any)?.message || mobileResult.reason) : null;

    const bs = broadband?.score ?? null;
    const ms = mobile?.score ?? null;
    let score: number | null = null;
    if (bs !== null && ms !== null) score = clamp(Math.round(0.75 * bs + 0.25 * ms));
    else score = bs ?? ms;

    if (score === null) throw new Error([broadbandError, mobileError].filter(Boolean).join(" | ") || "No open Ofcom connectivity data returned");

    const status = "partial";
    const metrics = { ...(p.metrics ?? {}), connectivity: score };
    const { data: updated, error: upErr } = await sb.from("properties").update({
      connectivity_status: status,
      connectivity_score: score,
      broadband_score: bs,
      mobile_score: ms,
      broadband_max_download_mbps: null,
      broadband_max_upload_mbps: null,
      broadband_full_fibre: null,
      broadband_gigabit: broadband?.gigabit ?? null,
      mobile_likely_indoor_networks: null,
      mobile_likely_outdoor_networks: null,
      connectivity_enriched_at: now,
      metrics,
      updated_at: now,
    }).eq("id", propertyId).select("*").single();
    if (upErr) throw upErr;

    const { data: area } = await sb.from("area_metrics").select("raw_data").eq("property_id", propertyId).maybeSingle();
    const raw = { ...(area?.raw_data ?? {}), connectivity: {
      source: "Ofcom Connected Nations Spring 2026 open data",
      licence: "Open Government Licence",
      version: VERSION,
      postcode,
      status,
      score,
      scoreMethod: "75% postcode broadband + 25% local-authority mobile",
      broadband: broadband ?? { mode: "open_dataset", error: broadbandError },
      mobile: mobile ?? { mode: "open_dataset_area", error: mobileError },
      note: "Broadband is postcode-level residential availability. Mobile is local-authority-level coverage, so House Ranker marks this result as partial rather than an exact-premises match.",
    }};
    const { error: ae } = await sb.from("area_metrics").upsert({
      property_id: propertyId,
      connectivity_score: score,
      raw_data: raw,
      refreshed_at: now,
    }, { onConflict: "property_id" });
    if (ae) throw ae;

    const warnings = [broadbandError ? `Broadband: ${broadbandError}` : null, mobileError ? `Mobile: ${mobileError}` : null].filter(Boolean);
    await finish("succeeded", { outcome: status, version: VERSION, score, broadbandScore: bs, mobileScore: ms, warnings }, warnings.join(" | ") || null);
    return j({ status, version: VERSION, score, broadbandScore: bs, mobileScore: ms, broadband, mobile, property: updated, warnings });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const now = new Date().toISOString();
    await sb.from("properties").update({ connectivity_status: "error", connectivity_enriched_at: now, updated_at: now }).eq("id", propertyId);
    await finish("failed", { outcome: "error", version: VERSION }, msg);
    return j({ error: "Connectivity lookup failed", detail: msg, version: VERSION }, 502);
  }
});
