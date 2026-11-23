"use strict";

const obsidian = require("obsidian");
const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  SuggestModal,
  MarkdownRenderer,
  MarkdownRenderChild,
  TFile,
  requestUrl,
} = obsidian;

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
  currency: "$",
  targetCpa: 0,
  maxCampaigns: 10,
  compare: true,
  heading: "## Ads",
  autoDailyNote: false,
  writeProperties: true,
  demoMode: false,

  googleEnabled: false,
  googleMode: "api", // "api" | "sheet"
  googleApiVersion: "v26",
  googleDeveloperToken: "",
  googleDeveloperTokenSecret: "",
  googleClientId: "",
  googleClientSecret: "",
  googleClientSecretSecret: "",
  googleRefreshToken: "",
  googleRefreshTokenSecret: "",
  googleCustomerIds: "",
  googleLoginCustomerId: "",
  googleSheetCsvUrl: "",

  metaEnabled: false,
  metaApiVersion: "v27.0",
  metaAccessToken: "",
  metaAccessTokenSecret: "",
  metaAdAccountIds: "",
  metaConversionActions: "purchase, lead",
  metaClickMetric: "link", // "link" (inline_link_clicks) | "all" (clicks)
};

const RANGE_CHOICES = [
  { id: "yesterday", label: "Yesterday" },
  { id: "today", label: "Today so far" },
  { id: "last_7d", label: "Last 7 days" },
  { id: "last_14d", label: "Last 14 days" },
  { id: "last_30d", label: "Last 30 days" },
  { id: "this_month", label: "This month" },
  { id: "last_month", label: "Last month" },
];

const MAX_PAGES = 50;
const SHEET_CACHE_TTL_MS = 60 * 1000;
const REPORT_CACHE_TTL_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

function pad(n) {
  return String(n).padStart(2, "0");
}
function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}
function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}
function daysBetween(a, b) {
  return Math.round((addDays(b, 0) - addDays(a, 0)) / 86400000);
}
function prettyDate(d) {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Normalize a date cell from a Google Sheet CSV into YYYY-MM-DD (or null if unrecognised).
 * Supports ISO (YYYY-MM-DD, YYYY/MM/DD, YYYY.MM.DD, ISO timestamps), DD.MM.YYYY, and MM/DD/YYYY (or DD/MM/YYYY when day > 12).
 */
function normalizeSheetDate(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;

  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (iso) {
    const cand = `${iso[1]}-${pad(iso[2])}-${pad(iso[3])}`;
    return parseYmd(cand) ? cand : null;
  }

  const dmyDot = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s.*)?$/.exec(s);
  if (dmyDot) {
    const cand = `${dmyDot[3]}-${pad(dmyDot[2])}-${pad(dmyDot[1])}`;
    return parseYmd(cand) ? cand : null;
  }

  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s.*)?$/.exec(s);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    const y = slash[3];
    // If first part > 12 it must be DD/MM/YYYY; otherwise default to US Google Sheets MM/DD/YYYY.
    const [m, d] = a > 12 ? [b, a] : [a, b];
    const cand = `${y}-${pad(m)}-${pad(d)}`;
    return parseYmd(cand) ? cand : null;
  }

  return null;
}

/**
 * Resolve a range spec into concrete dates.
 * spec: yesterday | today | last_Nd | this_month | last_month | YYYY-MM-DD | YYYY-MM-DD..YYYY-MM-DD
 * anchor: the "today" to resolve against (Date).
 */
function resolveRange(spec, anchor) {
  const today = addDays(anchor || new Date(), 0);
  const s = String(spec || "yesterday").trim().toLowerCase();
  let since;
  let until;

  if (s === "today") {
    since = until = today;
  } else if (s === "yesterday") {
    since = until = addDays(today, -1);
  } else if (/^last_(\d+)d$/.test(s)) {
    const n = Number(/^last_(\d+)d$/.exec(s)[1]);
    if (n < 1 || n > 366) throw new Error(`Unsupported range "${spec}"`);
    until = addDays(today, -1);
    since = addDays(today, -n);
  } else if (s === "this_month") {
    since = new Date(today.getFullYear(), today.getMonth(), 1);
    until = today;
  } else if (s === "last_month") {
    since = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    until = new Date(today.getFullYear(), today.getMonth(), 0);
  } else if (s.includes("..")) {
    const [a, b] = s.split("..");
    since = parseYmd(a);
    until = parseYmd(b);
  } else {
    since = until = parseYmd(s);
  }

  if (!since || !until) throw new Error(`Unrecognised range "${spec}"`);
  if (since > until) [since, until] = [until, since];

  const label =
    ymd(since) === ymd(until) ? prettyDate(since) : `${prettyDate(since)} – ${prettyDate(until)}`;
  return { since: ymd(since), until: ymd(until), label, days: daysBetween(since, until) + 1 };
}

function previousRange(range) {
  const since = parseYmd(range.since);
  const prevUntil = addDays(since, -1);
  const prevSince = addDays(prevUntil, -(range.days - 1));
  return {
    since: ymd(prevSince),
    until: ymd(prevUntil),
    label: "previous period",
    days: range.days,
  };
}

/* ------------------------------------------------------------------ */
/* Numbers and formatting                                              */
/* ------------------------------------------------------------------ */

function num(v) {
  if (typeof v === "number") return isFinite(v) ? v : 0;
  if (v === null || v === undefined) return 0;
  let s = String(v).trim();
  if (!s) return 0;

  // Detect leading/trailing sign even around currency symbols (e.g. "-$12.50" or "$-12.50").
  const neg = /^-|^[^\d]*-/.test(s) || /^\(.*\)$/.test(s);
  // Strip everything except digits, dot, and comma.
  s = s.replace(/[^\d.,]/g, "");
  if (!s) return 0;

  const hasDot = s.includes(".");
  const hasComma = s.includes(",");

  if (hasDot && hasComma) {
    // Whichever separator appears last is the decimal separator.
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasComma) {
    const commas = (s.match(/,/g) || []).length;
    if (commas > 1 || /^[1-9]\d{0,2},\d{3}$/.test(s)) {
      // Thousands separators (e.g. "1,234,567" or "1,200").
      s = s.replace(/,/g, "");
    } else {
      // Decimal comma (e.g. "5,5", "12,34", "0,125").
      s = s.replace(",", ".");
    }
  } else if (hasDot) {
    const dots = (s.match(/\./g) || []).length;
    if (dots > 1) s = s.replace(/\./g, "");
  }

  const n = parseFloat(s);
  if (!isFinite(n)) return 0;
  return neg ? -Math.abs(n) : n;
}

function makeFormatter(currency) {
  const intFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
  const dec = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const c = currency || "";
  const isPrefix = c.length <= 1 || /^[^A-Za-z]/.test(c);
  return {
    money: (v) => {
      if (v === null || v === undefined) return "—";
      const sign = v < 0 ? "-" : "";
      const abs = dec.format(Math.abs(v));
      return isPrefix ? `${sign}${c}${abs}` : `${sign}${abs} ${c}`;
    },
    int: (v) => intFmt.format(v),
    conv: (v) => (Number.isInteger(v) ? intFmt.format(v) : dec.format(v)),
    pct: (v) => (v === null || v === undefined ? "—" : `${dec.format(v * 100)}%`),
    ratio: (v) => (v === null || v === undefined ? "—" : `${dec.format(v)}×`),
  };
}

function derive(r) {
  return {
    ...r,
    ctr: r.impressions > 0 ? r.clicks / r.impressions : null,
    cpc: r.clicks > 0 ? r.spend / r.clicks : null,
    cpa: r.conversions > 0 ? r.spend / r.conversions : null,
    roas: r.spend > 0 && r.value > 0 ? r.value / r.spend : null,
  };
}

function hasActivity(r) {
  return r.impressions > 0 || r.clicks > 0 || r.spend !== 0 || r.conversions > 0 || r.value > 0;
}

function sumRows(rows, name) {
  const t = { campaign: name, impressions: 0, clicks: 0, spend: 0, conversions: 0, value: 0 };
  for (const r of rows) {
    t.impressions += r.impressions;
    t.clicks += r.clicks;
    t.spend += r.spend;
    t.conversions += r.conversions;
    t.value += r.value;
  }
  return t;
}

/**
 * Merge rows belonging to the same (account, campaign).
 * If the same campaign name appears in multiple distinct accounts, disambiguate as "Campaign (Account)".
 */
function groupByCampaign(rows) {
  const byAccAndName = new Map();
  const accountsByName = new Map();

  for (const r of rows) {
    const name = r.campaign || "(unnamed)";
    const accKey = r.accountId || "";
    const accLabel = r.accountName || accKey;
    const composite = `${accKey}\0${name}`;

    if (!accountsByName.has(name)) accountsByName.set(name, new Set());
    accountsByName.get(name).add(accKey);

    const cur = byAccAndName.get(composite) || {
      campaign: name,
      accountId: accKey,
      accountLabel: accLabel,
      impressions: 0,
      clicks: 0,
      spend: 0,
      conversions: 0,
      value: 0,
    };
    cur.impressions += num(r.impressions);
    cur.clicks += num(r.clicks);
    cur.spend += num(r.spend);
    cur.conversions += num(r.conversions);
    cur.value += num(r.value);
    byAccAndName.set(composite, cur);
  }

  const out = [];
  for (const row of byAccAndName.values()) {
    const collides = (accountsByName.get(row.campaign)?.size || 0) > 1 && row.accountLabel;
    out.push({
      campaign: collides ? `${row.campaign} (${row.accountLabel})` : row.campaign,
      impressions: row.impressions,
      clicks: row.clicks,
      spend: row.spend,
      conversions: row.conversions,
      value: row.value,
    });
  }
  return out;
}

function escapeCell(s) {
  return String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function delta(cur, prev) {
  if (prev === null || prev === undefined || cur === null || cur === undefined) return "";
  if (prev === 0) return cur === 0 ? "" : " (new)";
  const d = (cur - prev) / prev;
  if (Math.abs(d) < 0.005) return " (±0%)";
  const arrow = d > 0 ? "▲" : "▼";
  return ` (${arrow}${Math.abs(d * 100).toFixed(0)}%)`;
}

function normalizeApiVersion(raw, fallback, withMinor) {
  const s = String(raw || "").trim() || fallback;
  const cleaned = s.startsWith("v") || s.startsWith("V") ? "v" + s.slice(1) : "v" + s;
  if (withMinor) {
    const normalized = /^v\d+$/.test(cleaned) ? `${cleaned}.0` : cleaned;
    if (!/^v\d+\.\d+$/.test(normalized)) {
      throw new Error(`Invalid API version "${raw}". Expected format like ${fallback}.`);
    }
    return normalized;
  }
  if (!/^v\d+(?:\.\d+)?$/.test(cleaned)) {
    throw new Error(`Invalid API version "${raw}". Expected format like ${fallback}.`);
  }
  return cleaned;
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const s = String(text).replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

async function http(opts) {
  const res = await requestUrl({ throw: false, ...opts });
  let json = null;
  try {
    json = res.json;
  } catch (e) {
    json = null;
  }
  return { status: res.status, json, text: res.text };
}

function apiError(platform, res) {
  const j = res.json || {};
  const msg =
    j?.error?.details?.[0]?.errors?.[0]?.message ||
    j?.error?.message ||
    j?.error_description ||
    (typeof j?.error === "string" ? j.error : "") ||
    (res.text || "").slice(0, 200);
  return new Error(`${platform}: ${msg || "HTTP " + res.status}`);
}

/* ------------------------------------------------------------------ */
/* Sources                                                             */
/* ------------------------------------------------------------------ */

function resolveAccountIds(configuredStr, accountFilter) {
  const configured = splitIds(configuredStr);
  if (!accountFilter) return configured;
  const wanted = splitIds(accountFilter);
  if (!wanted.length) return configured;
  // If user specified explicit account ID(s) in a live block, intersect with configured if non-empty,
  // or use the explicit IDs directly when matching.
  const matched = configured.filter((id) => wanted.includes(id));
  return matched.length ? matched : wanted;
}

class GoogleAdsSource {
  constructor(plugin) {
    this.plugin = plugin;
    this.token = null;
    this.tokenExpires = 0;
    this.sheetCache = null; // { url, at, table }
  }
  get s() {
    return this.plugin.settings;
  }
  get name() {
    return "Google Ads";
  }
  resetToken() {
    this.token = null;
    this.tokenExpires = 0;
  }
  resetSheetCache() {
    this.sheetCache = null;
  }
  secret(secretKey, plainKey) {
    if (typeof this.plugin.getSecretValue === "function") {
      return this.plugin.getSecretValue(secretKey, plainKey);
    }
    return String(this.s[plainKey] || "");
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpires - 60000) return this.token;
    const clientId = String(this.s.googleClientId || "").trim();
    const clientSecret = this.secret("googleClientSecretSecret", "googleClientSecret").trim();
    const refreshToken = this.secret("googleRefreshTokenSecret", "googleRefreshToken").trim();
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error("Google Ads: client ID, client secret and refresh token are required");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }).toString();
    const res = await http({
      url: "https://oauth2.googleapis.com/token",
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body,
    });
    if (res.status !== 200 || !res.json?.access_token) throw apiError("Google OAuth", res);
    this.token = res.json.access_token;
    this.tokenExpires = Date.now() + num(res.json.expires_in || 3600) * 1000;
    return this.token;
  }

  async fetch(range, opts = {}) {
    const detailed = await this.fetchDetailed(range, opts);
    return detailed.rows;
  }

  async fetchDetailed(range, opts = {}) {
    return this.s.googleMode === "sheet" ? this.fetchSheet(range, opts) : this.fetchApi(range, opts);
  }

  async fetchApi(range, opts = {}) {
    const s = this.s;
    const ids = resolveAccountIds(s.googleCustomerIds, opts.account);
    if (!ids.length) throw new Error("Google Ads: add at least one customer ID");
    const devToken = this.secret("googleDeveloperTokenSecret", "googleDeveloperToken").trim();
    if (!devToken) throw new Error("Google Ads: developer token is required");
    const token = await this.accessToken();
    const version = normalizeApiVersion(s.googleApiVersion, "v26", false);
    const query =
      "SELECT customer.descriptive_name, customer.currency_code, campaign.name, " +
      "metrics.impressions, metrics.clicks, metrics.cost_micros, " +
      "metrics.conversions, metrics.conversions_value FROM campaign " +
      `WHERE segments.date BETWEEN '${range.since}' AND '${range.until}'`;

    const rows = [];
    const warnings = [];
    const currencies = new Set();
    let succeeded = 0;
    let firstError = null;

    for (const id of ids) {
      try {
        let pageToken = undefined;
        let pages = 0;
        do {
          if (++pages > MAX_PAGES) {
            warnings.push(`Google Ads (${id}): stopped after ${MAX_PAGES} pages`);
            break;
          }
          const headers = {
            Authorization: `Bearer ${token}`,
            "developer-token": devToken,
          };
          const login = digits(s.googleLoginCustomerId);
          if (login) headers["login-customer-id"] = login;
          const res = await http({
            url: `https://googleads.googleapis.com/${version}/customers/${id}/googleAds:search`,
            method: "POST",
            headers,
            contentType: "application/json",
            body: JSON.stringify(pageToken ? { query, pageToken } : { query }),
          });
          if (res.status !== 200) throw apiError(`Google Ads (${id})`, res);
          for (const r of res.json?.results || []) {
            if (r.customer?.currencyCode) currencies.add(r.customer.currencyCode);
            const row = {
              accountId: id,
              accountName: r.customer?.descriptiveName || "",
              campaign: r.campaign?.name,
              impressions: num(r.metrics?.impressions),
              clicks: num(r.metrics?.clicks),
              spend: num(r.metrics?.costMicros) / 1e6,
              conversions: num(r.metrics?.conversions),
              value: num(r.metrics?.conversionsValue),
            };
            if (hasActivity(row)) rows.push(row);
          }
          pageToken = res.json?.nextPageToken;
        } while (pageToken);
        succeeded++;
      } catch (e) {
        if (!firstError) firstError = e;
        warnings.push(e.message || String(e));
      }
    }

    if (succeeded === 0 && firstError) throw firstError;
    return { rows: groupByCampaign(rows), warnings, currencies: [...currencies] };
  }

  async loadSheetTable(url, force) {
    if (!/^https:\/\//i.test(url)) {
      throw new Error("Google Ads sheet: URL must start with https://");
    }
    if (
      !force &&
      this.sheetCache &&
      this.sheetCache.url === url &&
      Date.now() - this.sheetCache.at < SHEET_CACHE_TTL_MS
    ) {
      return this.sheetCache.table;
    }
    const res = await http({ url, method: "GET" });
    if (res.status !== 200) throw new Error(`Google Ads sheet: HTTP ${res.status}`);
    const table = parseCsv(res.text);
    this.sheetCache = { url, at: Date.now(), table };
    return table;
  }

  async fetchSheet(range, opts = {}) {
    const url = (this.s.googleSheetCsvUrl || "").trim();
    if (!url) throw new Error("Google Ads: paste the published CSV link of your sheet");
    const table = await this.loadSheetTable(url, !!opts.force);
    if (table.length < 1) return { rows: [], warnings: [], currencies: [] };
    const head = table[0].map((h) => h.trim().toLowerCase());
    const col = (...names) => head.findIndex((h) => names.includes(h));
    const iDate = col("date", "day", "segments.date");
    const iCamp = col("campaign", "campaign_name", "campaign.name");
    const iImp = col("impressions", "impr");
    const iClk = col("clicks");
    const iCost = col("cost", "spend");
    const iConv = col("conversions", "conv");
    const iVal = col("conversion_value", "conversions_value", "value");
    if (iDate < 0 || iCamp < 0 || iCost < 0) {
      throw new Error("Google Ads sheet: needs at least date, campaign and cost columns");
    }
    const rows = [];
    let validDates = 0;
    let unparsedDates = 0;
    for (const r of table.slice(1)) {
      const d = normalizeSheetDate(r[iDate]);
      if (!d) {
        if ((r[iDate] || "").trim()) unparsedDates++;
        continue;
      }
      validDates++;
      if (d < range.since || d > range.until) continue;
      const row = {
        campaign: r[iCamp],
        impressions: iImp >= 0 ? num(r[iImp]) : 0,
        clicks: iClk >= 0 ? num(r[iClk]) : 0,
        spend: num(r[iCost]),
        conversions: iConv >= 0 ? num(r[iConv]) : 0,
        value: iVal >= 0 ? num(r[iVal]) : 0,
      };
      if (hasActivity(row)) rows.push(row);
    }
    if (validDates === 0 && unparsedDates > 0) {
      throw new Error("Google Ads sheet: could not parse dates in the date column (use YYYY-MM-DD)");
    }
    return { rows: groupByCampaign(rows), warnings: [], currencies: [] };
  }
}

class MetaAdsSource {
  constructor(plugin) {
    this.plugin = plugin;
  }
  get s() {
    return this.plugin.settings;
  }
  get name() {
    return "Meta Ads";
  }
  secret(secretKey, plainKey) {
    if (typeof this.plugin.getSecretValue === "function") {
      return this.plugin.getSecretValue(secretKey, plainKey);
    }
    return String(this.s[plainKey] || "");
  }

  conversionTypes() {
    return (this.s.metaConversionActions || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }

  async fetch(range, opts = {}) {
    const detailed = await this.fetchDetailed(range, opts);
    return detailed.rows;
  }

  async fetchDetailed(range, opts = {}) {
    const s = this.s;
    const ids = resolveAccountIds(s.metaAdAccountIds, opts.account);
    const token = this.secret("metaAccessTokenSecret", "metaAccessToken").trim();
    if (!token) throw new Error("Meta Ads: access token is required");
    if (!ids.length) throw new Error("Meta Ads: add at least one ad account ID");
    const version = normalizeApiVersion(s.metaApiVersion, "v27.0", true);
    const types = this.conversionTypes();
    const useAllClicks = s.metaClickMetric === "all";
    const rows = [];
    const warnings = [];
    const currencies = new Set();
    let succeeded = 0;
    let firstError = null;

    for (const id of ids) {
      try {
        const params = new URLSearchParams({
          level: "campaign",
          fields: "campaign_name,account_name,account_currency,impressions,clicks,inline_link_clicks,spend,actions,action_values",
          time_range: JSON.stringify({ since: range.since, until: range.until }),
          limit: "500",
        });
        let url = `https://graph.facebook.com/${version}/act_${id}/insights?${params.toString()}`;
        let pages = 0;
        while (url) {
          if (++pages > MAX_PAGES) {
            warnings.push(`Meta Ads (act_${id}): stopped after ${MAX_PAGES} pages`);
            break;
          }
          const res = await http({
            url,
            method: "GET",
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.status !== 200) throw apiError(`Meta Ads (act_${id})`, res);
          for (const r of res.json?.data || []) {
            if (r.account_currency) currencies.add(r.account_currency);
            const clicks = useAllClicks
              ? num(r.clicks)
              : num(r.inline_link_clicks !== undefined ? r.inline_link_clicks : r.clicks);
            const row = {
              accountId: id,
              accountName: r.account_name || "",
              campaign: r.campaign_name,
              impressions: num(r.impressions),
              clicks,
              spend: num(r.spend),
              conversions: sumActions(r.actions, types),
              value: sumActions(r.action_values, types),
            };
            if (hasActivity(row)) rows.push(row);
          }
          url = res.json?.paging?.next || null;
        }
        succeeded++;
      } catch (e) {
        if (!firstError) firstError = e;
        warnings.push(e.message || String(e));
      }
    }

    if (succeeded === 0 && firstError) throw firstError;
    return { rows: groupByCampaign(rows), warnings, currencies: [...currencies] };
  }
}

class DemoSource {
  constructor(name, seed) {
    this.name = name;
    this.seed = seed;
  }
  async fetch(range) {
    const campaigns =
      this.seed === 1
        ? ["Search · Brand", "Search · Generic", "Performance Max", "YouTube · Remarketing"]
        : ["Leads · Lookalike 1%", "Retargeting · 30d", "Advantage+ Shopping", "Reels · Awareness"];
    let h = 0;
    for (const ch of range.since + range.until + this.name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const rnd = () => {
      h = (h * 1664525 + 1013904223) >>> 0;
      return h / 4294967296;
    };
    return campaigns.map((c, i) => {
      const impressions = Math.round(((2000 + rnd() * 8000) * range.days) / (i + 1));
      const clicks = Math.round(impressions * (0.01 + rnd() * 0.05));
      const spend = +(clicks * (0.2 + rnd() * 1.2)).toFixed(2);
      const conversions = Math.round(clicks * (0.02 + rnd() * 0.08));
      const value = +(conversions * (15 + rnd() * 40)).toFixed(2);
      return { campaign: c, impressions, clicks, spend, conversions, value };
    });
  }
  async fetchDetailed(range) {
    return { rows: await this.fetch(range), warnings: [], currencies: [] };
  }
}

function splitIds(s) {
  return String(s || "")
    .split(/[,\s]+/)
    .map((x) => digits(x))
    .filter(Boolean);
}
function digits(s) {
  return String(s || "").replace(/^act_/i, "").replace(/\D/g, "");
}
function sumActions(list, types) {
  if (!Array.isArray(list) || !types.length) return 0;
  let total = 0;
  for (const a of list) if (types.includes(a.action_type)) total += num(a.value);
  return total;
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

function sortRows(rows, sortBy) {
  const key = String(sortBy || "spend").toLowerCase();
  const numericKey = {
    spend: (r) => r.spend,
    impressions: (r) => r.impressions,
    clicks: (r) => r.clicks,
    ctr: (r) => r.ctr ?? -1,
    cpc: (r) => r.cpc ?? -1,
    conversions: (r) => r.conversions,
    conv: (r) => r.conversions,
    cpa: (r) => (r.cpa === null ? -1 : r.cpa),
    roas: (r) => r.roas ?? -1,
  }[key];
  const getter = numericKey || ((r) => r.spend);
  return [...rows].sort((a, b) => getter(b) - getter(a));
}

function buildReport(results, range, settings, opts = {}) {
  const currency = opts.currency !== undefined ? opts.currency : settings.currency;
  const target = num(opts.targetCpa !== undefined ? opts.targetCpa : settings.targetCpa);
  const maxRows = Math.max(1, Math.floor(num(opts.limit !== undefined ? opts.limit : settings.maxCampaigns)) || 10);
  const filter = String(opts.filter || "").trim().toLowerCase();
  const sortBy = opts.sort || "spend";
  const subHeadingPrefix = "#".repeat(Math.min(6, Math.max(2, (opts.headingLevel || 2) + 1)));

  const f = makeFormatter(currency);
  const out = [];
  const all = [];
  const allPrev = [];
  const currencies = new Set();
  const bySource = {};

  const applyFilter = (rows) =>
    filter ? rows.filter((r) => String(r.campaign || "").toLowerCase().includes(filter)) : rows;

  let succeededCount = 0;
  let errorCount = 0;

  for (const res of results) {
    if (res.error) {
      errorCount++;
      continue;
    }
    succeededCount++;
    const filtered = applyFilter(res.rows || []);
    const filteredPrev = res.prevRows ? applyFilter(res.prevRows) : null;
    all.push(...filtered);
    if (filteredPrev) allPrev.push(...filteredPrev);
    for (const c of res.currencies || []) currencies.add(c);
    bySource[res.name] = derive(sumRows(filtered, res.name));
  }

  const partial = errorCount > 0 && succeededCount > 0;

  // Summary
  const tot = derive(sumRows(all, "Total"));
  const prev = allPrev.length || results.some((r) => !r.error && r.prevRows) ? derive(sumRows(allPrev, "Prev")) : null;
  const parts = [`Spend **${f.money(tot.spend)}**${prev ? delta(tot.spend, prev.spend) : ""}`];
  parts.push(`Clicks ${f.int(tot.clicks)}${prev ? delta(tot.clicks, prev.clicks) : ""}`);
  parts.push(`Conversions ${f.conv(tot.conversions)}${prev ? delta(tot.conversions, prev.conversions) : ""}`);
  if (tot.cpa !== null) {
    parts.push(`CPA ${f.money(tot.cpa)}${prev ? delta(tot.cpa, prev.cpa) : ""}${cpaFlag(tot.cpa, target, tot.spend, tot.conversions)}`);
  } else if (target > 0 && tot.conversions === 0 && tot.spend > target) {
    parts.push(`CPA — 🔴`);
  }
  if (tot.roas !== null) {
    parts.push(`ROAS ${f.ratio(tot.roas)}${prev ? delta(tot.roas, prev.roas) : ""}`);
  }

  if (settings.demoMode) {
    out.push("> [!info] Demo data");
    out.push("> These numbers are generated samples. Turn off demo mode in Ad Recap settings to see your accounts.");
    out.push("");
  }
  if (currencies.size > 1) {
    out.push(`> [!warning] Mixed account currencies (${[...currencies].join(", ")}). Totals sum raw values without FX conversion.`);
    out.push("");
  }

  out.push(`*${range.label}${partial ? " · partial" : ""}*  `);
  out.push(parts.join(" · "));
  out.push("");

  for (const res of results) {
    out.push(`${subHeadingPrefix} ${res.name}`);
    if (res.error) {
      out.push(`> [!warning] ${res.error}`);
      out.push("");
      continue;
    }
    if (res.warnings?.length) {
      for (const w of res.warnings) out.push(`> [!warning] ${w}`);
      out.push("");
    }
    const filtered = applyFilter(res.rows || []);
    const rows = sortRows(filtered.map(derive), sortBy);
    if (!rows.length) {
      out.push(filter ? `_No campaigns matching "${escapeCell(opts.filter)}" in this period._` : "_No spend in this period._");
      out.push("");
      continue;
    }
    let shown = rows;
    if (rows.length > maxRows) {
      const rest = rows.slice(maxRows - 1);
      shown = rows.slice(0, maxRows - 1).concat(derive(sumRows(rest, `Other (${rest.length})`)));
    }
    const hasValue = rows.some((r) => r.value > 0);
    const head = ["Campaign", "Spend", "Impr.", "Clicks", "CTR", "CPC", "Conv.", "CPA"];
    if (hasValue) head.push("ROAS");
    out.push(`| ${head.join(" | ")} |`);
    out.push(`|${head.map((_, i) => (i === 0 ? " --- " : " ---: ")).join("|")}|`);
    const line = (r, bold) => {
      const b = (x) => (bold ? `**${x}**` : x);
      const cells = [
        b(escapeCell(r.campaign)),
        b(f.money(r.spend)),
        f.int(r.impressions),
        f.int(r.clicks),
        f.pct(r.ctr),
        f.money(r.cpc),
        b(f.conv(r.conversions)),
        b(f.money(r.cpa)) + cpaFlag(r.cpa, target, r.spend, r.conversions),
      ];
      if (hasValue) cells.push(f.ratio(r.roas));
      return `| ${cells.join(" | ")} |`;
    };
    for (const r of shown) out.push(line(r, false));
    out.push(line(derive(sumRows(filtered, "Total")), true));
    out.push("");
  }

  return { markdown: out.join("\n").trim() + "\n", totals: tot, bySource, partial };
}

function cpaFlag(cpa, target, spend, conversions) {
  if (!target) return "";
  if (cpa !== null && cpa !== undefined) {
    return cpa <= target ? " 🟢" : " 🔴";
  }
  if (conversions === 0 && num(spend) > target) {
    return " 🔴";
  }
  return "";
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

class AdRecapPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.google = new GoogleAdsSource(this);
    this.meta = new MetaAdsSource(this);
    this.cache = new Map();
    this.blocks = new Set();
    this.testing = false;
    this._saveTimer = null;
    this._dailyTimers = new Set();

    this.addCommand({
      id: "insert-report-yesterday",
      name: "Insert report: yesterday",
      editorCallback: (editor) => this.insertAtCursor(editor, "yesterday"),
    });
    this.addCommand({
      id: "insert-report-last-7-days",
      name: "Insert report: last 7 days",
      editorCallback: (editor) => this.insertAtCursor(editor, "last_7d"),
    });
    this.addCommand({
      id: "insert-report-choose-range",
      name: "Insert report: choose period…",
      editorCallback: (editor) => {
        new RangeModal(this.app, (range) => this.insertAtCursor(editor, range)).open();
      },
    });
    this.addCommand({
      id: "update-current-daily-note",
      name: "Update report in current daily note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const date = file ? this.dailyNoteDate(file) : null;
        if (!date) return false;
        if (!checking) this.updateDailyNote(file, date, true);
        return true;
      },
    });
    this.addCommand({
      id: "insert-live-block",
      name: "Insert live report block",
      editorCallback: (editor) => {
        editor.replaceSelection("```ad-recap\nrange: last_7d\nsource: all\n```\n");
      },
    });

    this.registerMarkdownCodeBlockProcessor("ad-recap", (src, el, ctx) => this.renderBlock(src, el, ctx));

    this.addSettingTab(new AdRecapSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (!this.settings.autoDailyNote || !(file instanceof TFile) || file.extension !== "md") return;
          const date = this.dailyNoteDate(file);
          if (!date || ymd(date) !== ymd(new Date())) return;
          // Give templates a moment to fill the new note first.
          const timer = window.setTimeout(() => {
            this._dailyTimers.delete(timer);
            if (!this.app.vault.getAbstractFileByPath(file.path)) return;
            this.updateDailyNote(file, date, false);
          }, 2000);
          this._dailyTimers.add(timer);
        })
      );
    });
  }

  onunload() {
    if (this._saveTimer) {
      window.clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this.saveData(this.settings);
    }
    for (const t of this._dailyTimers || []) window.clearTimeout(t);
    this._dailyTimers?.clear();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Guard against hand-edited data.json with "true"/"false" strings.
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      if (typeof v === "boolean") this.settings[k] = toBool(this.settings[k], v);
    }
  }

  async saveSettings() {
    if (this._saveTimer) {
      window.clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    await this.saveData(this.settings);
    this.cache?.clear();
    this.google?.resetToken();
    this.google?.resetSheetCache();
    // Redraw open live blocks so they never show data from the old settings.
    for (const redraw of this.blocks || []) redraw(true);
  }

  scheduleSaveSettings(delayMs = 600) {
    if (this._saveTimer) window.clearTimeout(this._saveTimer);
    this._saveTimer = window.setTimeout(() => {
      this._saveTimer = null;
      this.saveSettings();
    }, delayMs);
  }

  getSecretValue(secretIdKey, plainKey) {
    const id = String(this.settings[secretIdKey] || "").trim();
    const ss = this.app?.secretStorage;
    if (id && ss) {
      const stored =
        typeof ss.getSecret === "function"
          ? ss.getSecret(id)
          : typeof ss.get === "function"
            ? ss.get(id)
            : null;
      if (stored) return stored;
    }
    return String(this.settings[plainKey] || "");
  }

  sources(filter) {
    const want = String(filter || "all").toLowerCase();
    const list = [];
    if (this.settings.demoMode) {
      if (want === "all" || want === "google") list.push(new DemoSource("Google Ads", 1));
      if (want === "all" || want === "meta") list.push(new DemoSource("Meta Ads", 2));
      return list;
    }
    if (this.settings.googleEnabled && (want === "all" || want === "google")) list.push(this.google);
    if (this.settings.metaEnabled && (want === "all" || want === "meta")) list.push(this.meta);
    return list;
  }

  /** Fetch every enabled source for a range (and the previous period when comparing). */
  async collect(rangeSpec, opts = {}) {
    const range = resolveRange(rangeSpec, opts.anchor);
    const sources = this.sources(opts.source);
    if (!sources.length) {
      throw new Error("No ad accounts connected. Open Settings → Ad Recap to connect Google Ads or Meta Ads, or turn on demo mode.");
    }
    const compare = opts.compare ?? this.settings.compare;
    const prev = compare ? previousRange(range) : null;
    const key = JSON.stringify([
      range.since,
      range.until,
      opts.source || "all",
      opts.account || "",
      opts.filter || "",
      opts.sort || "spend",
      opts.currency ?? "",
      opts.targetCpa ?? "",
      opts.limit ?? "",
      opts.headingLevel || 2,
      !!compare,
      !!this.settings.demoMode,
    ]);
    const hit = this.cache.get(key);
    if (hit && !opts.force && Date.now() - hit.at < REPORT_CACHE_TTL_MS) return hit.value;

    const results = await Promise.all(
      sources.map(async (src) => {
        try {
          const fetchOpts = { account: opts.account, force: opts.force };
          const cur = typeof src.fetchDetailed === "function"
            ? await src.fetchDetailed(range, fetchOpts)
            : { rows: await src.fetch(range, fetchOpts), warnings: [], currencies: [] };
          let prevRows = null;
          if (prev) {
            const p = typeof src.fetchDetailed === "function"
              ? await src.fetchDetailed(prev, { account: opts.account, force: false })
              : { rows: await src.fetch(prev, { account: opts.account, force: false }) };
            prevRows = p.rows;
          }
          return {
            name: src.name,
            rows: cur.rows,
            prevRows,
            warnings: cur.warnings || [],
            currencies: cur.currencies || [],
          };
        } catch (e) {
          return { name: src.name, error: e.message || String(e) };
        }
      })
    );
    const value = { range, results, ...buildReport(results, range, this.settings, opts) };
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  async insertAtCursor(editor, rangeSpec) {
    const notice = new Notice("Ad Recap: fetching…", 0);
    try {
      const rep = await this.collect(rangeSpec);
      editor.replaceSelection(rep.markdown);
      this.reportErrors(rep.results);
    } catch (e) {
      new Notice(`Ad Recap: ${e.message || e}`, 8000);
    } finally {
      notice.hide();
    }
  }

  reportErrors(results) {
    const errs = results.filter((r) => r.error);
    if (errs.length) new Notice(`Ad Recap: ${errs.map((r) => r.error).join("\n")}`, 10000);
  }

  /* ---------- Daily notes ---------- */

  dailyNoteSettings() {
    const dn = this.app?.internalPlugins?.getPluginById?.("daily-notes");
    if (dn && dn.enabled && dn.instance && dn.instance.options) {
      const opts = dn.instance.options;
      return { folder: (opts.folder || "").replace(/^\/+|\/+$/g, ""), format: opts.format || "YYYY-MM-DD" };
    }
    const pn = this.app?.plugins?.getPlugin?.("periodic-notes");
    if (pn && pn.settings && pn.settings.daily && pn.settings.daily.enabled) {
      const opts = pn.settings.daily;
      return { folder: (opts.folder || "").replace(/^\/+|\/+$/g, ""), format: opts.format || "YYYY-MM-DD" };
    }
    return { folder: "", format: "YYYY-MM-DD" };
  }

  dailyNoteDate(file) {
    if (!file || file.extension !== "md") return null;
    const { folder, format } = this.dailyNoteSettings();
    if (folder && !file.path.startsWith(folder + "/")) return null;
    const rel = folder ? file.path.slice(folder.length + 1, -3) : file.path.slice(0, -3);
    const m = obsidian.moment(rel, format, true);
    if (m.isValid()) return m.toDate();
    const m2 = obsidian.moment(file.basename, format, true);
    return m2.isValid() ? m2.toDate() : null;
  }

  async updateDailyNote(file, date, interactive) {
    const notice = interactive ? new Notice("Ad Recap: fetching…", 0) : null;
    try {
      const heading = (this.settings.heading || "## Ads").trim();
      // In automatic mode (e.g. file synced from another device), skip if the section already has a report.
      if (!interactive) {
        const existing = await this.app.vault.read(file);
        if (sectionHasContent(existing, heading)) return;
      }
      // The report in a daily note covers the day before the note.
      const day = ymd(addDays(date, -1));
      const rep = await this.collect(day, { force: interactive, headingLevel: headingLevel(heading) });
      const block = `${heading}\n${rep.markdown}`;
      await this.app.vault.process(file, (data) => replaceSection(data, heading, block));
      if (this.settings.writeProperties && !this.settings.demoMode && rep.results.some((r) => !r.error)) {
        if (rep.partial) {
          new Notice("Ad Recap: skipped updating note properties because one platform failed (partial data).", 8000);
        } else {
          await this.app.fileManager.processFrontMatter(file, (fm) => {
            applyFrontMatter(fm, rep);
          });
        }
      }
      this.reportErrors(rep.results);
      if (interactive) new Notice("Ad Recap: daily note updated");
    } catch (e) {
      new Notice(`Ad Recap: ${e.message || e}`, 8000);
    } finally {
      if (notice) notice.hide();
    }
  }

  /* ---------- Live block ---------- */

  async renderBlock(src, el, ctx) {
    const opts = {};
    for (const line of src.split("\n")) {
      const m = /^\s*([a-z_]+)\s*:\s*(.+?)\s*$/i.exec(line);
      if (m) opts[m[1].toLowerCase()] = m[2];
    }
    const child = new MarkdownRenderChild(el);
    ctx.addChild(child);
    el.addClass("ad-recap-block");

    let seq = 0;
    let unloaded = false;
    let lastMarkdown = "";

    const draw = async (force) => {
      if (unloaded) return;
      const mySeq = ++seq;
      el.empty();
      const bar = el.createDiv({ cls: "ad-recap-bar" });
      bar.createSpan({ cls: "ad-recap-title", text: "Ad Recap" });
      const actions = bar.createDiv({ cls: "ad-recap-actions" });
      const copyBtn = actions.createEl("button", { cls: "ad-recap-copy", text: "Copy" });
      copyBtn.disabled = true;
      copyBtn.addEventListener("click", async () => {
        if (!lastMarkdown) return;
        try {
          await navigator.clipboard.writeText(lastMarkdown);
          new Notice("Ad Recap: report copied to clipboard");
        } catch (e) {
          new Notice("Ad Recap: could not copy to clipboard");
        }
      });
      const btn = actions.createEl("button", { cls: "ad-recap-refresh", text: "Refresh" });
      btn.addEventListener("click", () => draw(true));
      const body = el.createDiv({ cls: "ad-recap-body" });
      body.createDiv({ cls: "ad-recap-loading", text: "Loading…" });
      try {
        const rep = await this.collect(opts.range || "last_7d", {
          source: opts.source || "all",
          account: opts.account,
          filter: opts.filter,
          sort: opts.sort,
          currency: opts.currency,
          targetCpa: opts.target_cpa !== undefined ? num(opts.target_cpa) : undefined,
          limit: opts.limit !== undefined ? num(opts.limit) : undefined,
          compare: opts.compare === undefined ? undefined : !/^(false|no|off|0)$/i.test(opts.compare),
          force,
        });
        if (unloaded || mySeq !== seq) return;
        lastMarkdown = rep.markdown;
        copyBtn.disabled = false;
        body.empty();
        await MarkdownRenderer.render(this.app, rep.markdown, body, ctx.sourcePath, child);
      } catch (e) {
        if (unloaded || mySeq !== seq) return;
        body.empty();
        body.createDiv({ cls: "ad-recap-error", text: e.message || String(e) });
      }
    };
    this.blocks.add(draw);
    child.onunload = () => {
      unloaded = true;
      this.blocks.delete(draw);
    };
    draw(false);
  }

  /* ---------- Connection test ---------- */

  async testSource(which, button) {
    const src = which === "google" ? this.google : this.meta;
    if (this.settings.demoMode) {
      new Notice(`Ad Recap: demo mode is on. Turn it off to test your real ${src.name} account.`, 8000);
      return;
    }
    if (this.testing) return;
    this.testing = true;
    if (button) button.setDisabled(true);
    const notice = new Notice(`Ad Recap: testing ${src.name}…`, 0);
    try {
      const { rows, warnings } = typeof src.fetchDetailed === "function"
        ? await src.fetchDetailed(resolveRange("last_7d"), { force: true })
        : { rows: await src.fetch(resolveRange("last_7d")), warnings: [] };
      const warnSuffix = warnings?.length ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})` : "";
      new Notice(`${src.name}: connected ✓ (${rows.length} campaign${rows.length === 1 ? "" : "s"} with activity in the last 7 days)${warnSuffix}`, 8000);
      if (warnings?.length) new Notice(warnings.join("\n"), 10000);
    } catch (e) {
      new Notice(e.message || String(e), 10000);
    } finally {
      notice.hide();
      this.testing = false;
      if (button) button.setDisabled(false);
    }
  }
}

function applyFrontMatter(fm, rep) {
  fm.ads_spend = round2(rep.totals.spend);
  fm.ads_impressions = rep.totals.impressions;
  fm.ads_clicks = rep.totals.clicks;
  fm.ads_conversions = round2(rep.totals.conversions);
  fm.ads_value = round2(rep.totals.value);
  fm.ads_cpa = rep.totals.cpa === null ? null : round2(rep.totals.cpa);
  fm.ads_roas = rep.totals.roas === null ? null : round2(rep.totals.roas);
  if (rep.bySource?.["Google Ads"]) {
    fm.ads_google_spend = round2(rep.bySource["Google Ads"].spend);
  }
  if (rep.bySource?.["Meta Ads"]) {
    fm.ads_meta_spend = round2(rep.bySource["Meta Ads"].spend);
  }
}

function toBool(v, fallback) {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === 1 || v === "1") return true;
  if (v === "false" || v === 0 || v === "0") return false;
  return fallback;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function headingLevel(heading) {
  const m = /^(#+)\s/.exec(String(heading || "").trim());
  return m ? m[1].length : 2;
}

function isFenceLine(line) {
  return /^\s*(?:```|~~~)/.test(line);
}

/** Check if a note already contains a non-empty section under `heading` (or ad-recap markers). */
function sectionHasContent(data, heading) {
  if (/<!--\s*ad-recap:start\s*-->/.test(data)) return true;
  const level = headingLevel(heading);
  const lines = String(data || "").split("\n");
  let inFence = false;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isFenceLine(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && lines[i].trim() === heading) {
      start = i;
      break;
    }
  }
  if (start === -1) return false;
  for (let i = start + 1; i < lines.length; i++) {
    if (isFenceLine(lines[i])) inFence = !inFence;
    if (!inFence) {
      const m = /^(#+)\s/.exec(lines[i]);
      if (m && m[1].length <= level) break;
    }
    if (lines[i].trim() !== "") return true;
  }
  return false;
}

/** Replace the section that starts at `heading` (up to the next heading of the same or higher level), or append it. */
function replaceSection(data, heading, block) {
  const markerRe = /<!--\s*ad-recap:start\s*-->[\s\S]*?<!--\s*ad-recap:end\s*-->/;
  if (markerRe.test(data)) {
    const cleanBlock = block.replace(/\n+$/, "");
    return data.replace(markerRe, `<!-- ad-recap:start -->\n${cleanBlock}\n<!-- ad-recap:end -->`);
  }

  const level = headingLevel(heading);
  const lines = data.split("\n");
  let inFence = false;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isFenceLine(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && lines[i].trim() === heading) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    const sep = data.length === 0 || data.endsWith("\n\n") ? "" : data.endsWith("\n") ? "\n" : "\n\n";
    return data + sep + block;
  }
  let end = lines.length;
  inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (isFenceLine(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      const m = /^(#+)\s/.exec(lines[i]);
      if (m && m[1].length <= level) {
        end = i;
        break;
      }
    }
  }
  const after = lines.slice(end).join("\n");
  return [...lines.slice(0, start), block.replace(/\n+$/, "")].join("\n") + (after ? "\n\n" + after : "\n");
}

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

class RangeModal extends SuggestModal {
  constructor(app, onChoose) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Choose a period, or type YYYY-MM-DD..YYYY-MM-DD");
  }
  getSuggestions(query) {
    const q = query.trim().toLowerCase();
    const list = RANGE_CHOICES.filter((r) => !q || r.label.toLowerCase().includes(q) || r.id.includes(q));
    if (q && !list.length) {
      try {
        const r = resolveRange(q);
        return [{ id: q, label: `Custom: ${r.label}` }];
      } catch (e) {
        return [];
      }
    }
    return list;
  }
  renderSuggestion(item, el) {
    el.createDiv({ text: item.label });
  }
  onChooseSuggestion(item) {
    this.onChoose(item.id);
  }
}

class AdRecapSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  hasSecretStorage() {
    return !!(
      this.app?.secretStorage &&
      obsidian.SecretComponent &&
      typeof Setting.prototype?.addComponent === "function"
    );
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const saveNow = async () => this.plugin.saveSettings();
    const saveDebounced = () => this.plugin.scheduleSaveSettings();
    containerEl.empty();

    const intro = containerEl.createDiv({ cls: "setting-item-description ad-recap-intro" });
    intro.appendText("⭐ Enjoying Ad Recap? A star on ");
    intro.createEl("a", { text: "GitHub", href: "https://github.com/chi-li-peppers/obsidian-ad-recap" });
    intro.appendText(" helps other people find it. Found a bug or have an idea? ");
    intro.createEl("a", { text: "Open an issue", href: "https://github.com/chi-li-peppers/obsidian-ad-recap/issues" });
    intro.appendText(".");

    const text = (setting, key, placeholder, secret) =>
      setting.addText((t) => {
        t.setPlaceholder(placeholder || "").setValue(String(s[key] ?? ""));
        if (secret) t.inputEl.type = "password";
        t.onChange((v) => {
          s[key] = v;
          saveDebounced();
        });
      });

    const secretField = (setting, secretIdKey, plainKey, suggestedId) => {
      const canUseSecrets = this.hasSecretStorage();
      const hasLegacyPlain = !!(s[plainKey] && !s[secretIdKey]);

      if (canUseSecrets && !hasLegacyPlain) {
        setting.addComponent((el) =>
          new obsidian.SecretComponent(this.app, el)
            .setValue(String(s[secretIdKey] || ""))
            .onChange(async (v) => {
              s[secretIdKey] = v;
              if (v) s[plainKey] = "";
              await saveNow();
            })
        );
        return;
      }

      text(setting, plainKey, "", true);
      if (canUseSecrets && hasLegacyPlain && typeof this.app.secretStorage.setSecret === "function") {
        setting.addButton((b) =>
          b.setButtonText("Move to Secrets").onClick(async () => {
            this.app.secretStorage.setSecret(suggestedId, String(s[plainKey]).trim());
            s[secretIdKey] = suggestedId;
            s[plainKey] = "";
            await saveNow();
            new Notice(`Ad Recap: moved to Obsidian Secret Storage (${suggestedId})`);
            this.display();
          })
        );
      }
    };

    /* General */
    new Setting(containerEl)
      .setName("Demo mode")
      .setDesc("On: reports show generated sample data and are labelled “Demo data”. Off: reports use the accounts connected below.")
      .addToggle((t) =>
        t.setValue(s.demoMode === true).onChange(async (v) => {
          s.demoMode = v === true;
          await saveNow();
          new Notice(`Ad Recap: demo mode ${s.demoMode ? "on, showing sample data" : "off, using your accounts"}`);
        })
      );

    text(new Setting(containerEl).setName("Currency").setDesc("Symbol or code shown next to money values, e.g. $, €, ₾ or GEL."), "currency", "$");

    new Setting(containerEl)
      .setName("Target CPA")
      .setDesc("Optional. Campaigns above it (or spending over it with 0 conversions) get 🔴, at or below it get 🟢. Leave 0 to turn off.")
      .addText((t) =>
        t.setValue(String(s.targetCpa || 0)).onChange((v) => {
          s.targetCpa = num(v);
          saveDebounced();
        })
      );

    new Setting(containerEl)
      .setName("Campaigns per table")
      .setDesc("The rest are grouped into one “Other” row.")
      .addText((t) =>
        t.setValue(String(s.maxCampaigns)).onChange((v) => {
          s.maxCampaigns = Math.max(1, Math.floor(num(v)) || 10);
          saveDebounced();
        })
      );

    new Setting(containerEl)
      .setName("Compare with previous period")
      .setDesc("Show ▲/▼ changes against the period of the same length just before.")
      .addToggle((t) => t.setValue(s.compare).onChange(async (v) => ((s.compare = v), await saveNow())));

    new Setting(containerEl).setName("Daily notes").setHeading();

    new Setting(containerEl)
      .setName("Add report to new daily notes")
      .setDesc("When today's daily note is created, add yesterday's numbers to it automatically. Works with core Daily notes and Periodic Notes.")
      .addToggle((t) => t.setValue(s.autoDailyNote).onChange(async (v) => ((s.autoDailyNote = v), await saveNow())));

    text(
      new Setting(containerEl).setName("Section heading").setDesc("The report goes under this heading. If it already exists, it is replaced."),
      "heading",
      "## Ads"
    );

    new Setting(containerEl)
      .setName("Save totals as note properties")
      .setDesc("Writes ads_spend, ads_impressions, ads_clicks, ads_conversions, ads_value, ads_cpa, ads_roas and per-platform spend so you can chart them with Bases or Dataview.")
      .addToggle((t) => t.setValue(s.writeProperties).onChange(async (v) => ((s.writeProperties = v), await saveNow())));

    /* Google */
    new Setting(containerEl).setName("Google Ads").setHeading();

    new Setting(containerEl)
      .setName("Enable Google Ads")
      .addToggle((t) =>
        t.setValue(s.googleEnabled).onChange(async (v) => {
          s.googleEnabled = v;
          await saveNow();
          this.display();
        })
      );

    if (s.googleEnabled) {
      new Setting(containerEl)
        .setName("Connection")
        .setDesc("API needs a developer token. Sheet works without one: a Google Ads script fills a Google Sheet that the plugin reads. See the README for both.")
        .addDropdown((d) =>
          d
            .addOption("api", "Google Ads API")
            .addOption("sheet", "Google Sheet (no developer token)")
            .setValue(s.googleMode)
            .onChange(async (v) => {
              s.googleMode = v;
              await saveNow();
              this.display();
            })
        );

      if (s.googleMode === "sheet") {
        text(
          new Setting(containerEl).setName("Published CSV link").setDesc("File → Share → Publish to web → CSV in Google Sheets (must be https://)."),
          "googleSheetCsvUrl",
          "https://docs.google.com/spreadsheets/d/e/…/pub?output=csv"
        );
      } else {
        text(new Setting(containerEl).setName("Customer IDs").setDesc("One or more, comma separated. Dashes are fine."), "googleCustomerIds", "123-456-7890");
        text(new Setting(containerEl).setName("Manager account ID").setDesc("Only if you access the accounts through a manager (MCC) account."), "googleLoginCustomerId", "optional");
        secretField(new Setting(containerEl).setName("Developer token"), "googleDeveloperTokenSecret", "googleDeveloperToken", "ad-recap-google-dev-token");
        text(new Setting(containerEl).setName("OAuth client ID"), "googleClientId", "….apps.googleusercontent.com");
        secretField(new Setting(containerEl).setName("OAuth client secret"), "googleClientSecretSecret", "googleClientSecret", "ad-recap-google-client-secret");
        secretField(new Setting(containerEl).setName("Refresh token"), "googleRefreshTokenSecret", "googleRefreshToken", "ad-recap-google-refresh-token");
        text(new Setting(containerEl).setName("API version"), "googleApiVersion", "v26");
      }
      new Setting(containerEl).addButton((b) => b.setButtonText("Test Google Ads").onClick(() => this.plugin.testSource("google", b)));
    }

    /* Meta */
    new Setting(containerEl).setName("Meta Ads").setHeading();

    new Setting(containerEl)
      .setName("Enable Meta Ads")
      .addToggle((t) =>
        t.setValue(s.metaEnabled).onChange(async (v) => {
          s.metaEnabled = v;
          await saveNow();
          this.display();
        })
      );

    if (s.metaEnabled) {
      secretField(
        new Setting(containerEl).setName("Access token").setDesc("A system user or long-lived token with ads_read."),
        "metaAccessTokenSecret",
        "metaAccessToken",
        "ad-recap-meta-access-token"
      );
      text(new Setting(containerEl).setName("Ad account IDs").setDesc("One or more, comma separated, with or without act_."), "metaAdAccountIds", "act_1234567890");
      text(
        new Setting(containerEl)
          .setName("Conversion actions")
          .setDesc("Action types counted as conversions, comma separated. Examples: purchase, lead, offsite_conversion.fb_pixel_lead."),
        "metaConversionActions",
        "purchase, lead"
      );
      new Setting(containerEl)
        .setName("Click metric")
        .setDesc("Link clicks (inline_link_clicks) match ad destination clicks and compare cleanly with Google Ads. All clicks includes likes, comments and profile taps.")
        .addDropdown((d) =>
          d
            .addOption("link", "Link clicks (recommended)")
            .addOption("all", "All clicks")
            .setValue(s.metaClickMetric || "link")
            .onChange(async (v) => {
              s.metaClickMetric = v;
              await saveNow();
            })
        );
      text(new Setting(containerEl).setName("API version"), "metaApiVersion", "v27.0");
      new Setting(containerEl).addButton((b) => b.setButtonText("Test Meta Ads").onClick(() => this.plugin.testSource("meta", b)));
    }

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: this.hasSecretStorage()
        ? "Tokens stored in Obsidian Secret Storage are kept out of data.json so they are not synced with your vault files."
        : "Tokens are stored in this vault's plugin data file. If your vault syncs to other devices or is shared, the tokens go with it.",
    });
  }
}

module.exports = AdRecapPlugin;
module.exports.default = AdRecapPlugin;
// Exposed for tests.
module.exports._internals = {
  toBool,
  num,
  normalizeSheetDate,
  normalizeApiVersion,
  resolveRange,
  previousRange,
  buildReport,
  parseCsv,
  replaceSection,
  sectionHasContent,
  headingLevel,
  applyFrontMatter,
  cpaFlag,
  makeFormatter,
  GoogleAdsSource,
  MetaAdsSource,
  DemoSource,
  groupByCampaign,
  sumActions,
};
