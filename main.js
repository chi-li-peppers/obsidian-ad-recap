"use strict";

const obsidian = require("obsidian");
const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  Modal,
  SuggestModal,
  MarkdownRenderer,
  MarkdownRenderChild,
  MarkdownView,
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
  googleClientId: "",
  googleClientSecret: "",
  googleRefreshToken: "",
  googleCustomerIds: "",
  googleLoginCustomerId: "",
  googleSheetCsvUrl: "",

  metaEnabled: false,
  metaApiVersion: "v26.0",
  metaAccessToken: "",
  metaAdAccountIds: "",
  metaConversionActions: "purchase, lead",
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
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
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
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  return isFinite(n) ? n : 0;
}

function makeFormatter(currency) {
  const intFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
  const dec = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const c = currency || "";
  const isPrefix = c.length <= 1 || /^[^A-Za-z]/.test(c);
  return {
    money: (v) => (v === null || v === undefined ? "—" : isPrefix ? `${c}${dec.format(v)}` : `${dec.format(v)} ${c}`),
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

/** Merge rows with the same campaign name. */
function groupByCampaign(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = r.campaign || "(unnamed)";
    const cur = map.get(key) || { campaign: key, impressions: 0, clicks: 0, spend: 0, conversions: 0, value: 0 };
    cur.impressions += num(r.impressions);
    cur.clicks += num(r.clicks);
    cur.spend += num(r.spend);
    cur.conversions += num(r.conversions);
    cur.value += num(r.value);
    map.set(key, cur);
  }
  return [...map.values()];
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

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const s = String(text).replace(/^﻿/, "");
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
  let msg =
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

class GoogleAdsSource {
  constructor(plugin) {
    this.plugin = plugin;
    this.token = null;
    this.tokenExpires = 0;
  }
  get s() {
    return this.plugin.settings;
  }
  get name() {
    return "Google Ads";
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpires - 60000) return this.token;
    const s = this.s;
    if (!s.googleClientId || !s.googleClientSecret || !s.googleRefreshToken) {
      throw new Error("Google Ads: client ID, client secret and refresh token are required");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: s.googleClientId.trim(),
      client_secret: s.googleClientSecret.trim(),
      refresh_token: s.googleRefreshToken.trim(),
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

  async fetch(range) {
    return this.s.googleMode === "sheet" ? this.fetchSheet(range) : this.fetchApi(range);
  }

  async fetchApi(range) {
    const s = this.s;
    const ids = splitIds(s.googleCustomerIds);
    if (!ids.length) throw new Error("Google Ads: add at least one customer ID");
    if (!s.googleDeveloperToken) throw new Error("Google Ads: developer token is required");
    const token = await this.accessToken();
    const version = (s.googleApiVersion || "v26").trim();
    const query =
      "SELECT campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros, " +
      "metrics.conversions, metrics.conversions_value FROM campaign " +
      `WHERE segments.date BETWEEN '${range.since}' AND '${range.until}' AND metrics.impressions > 0`;

    const rows = [];
    for (const id of ids) {
      let pageToken = undefined;
      do {
        const headers = {
          Authorization: `Bearer ${token}`,
          "developer-token": s.googleDeveloperToken.trim(),
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
        if (res.status !== 200) throw apiError("Google Ads", res);
        for (const r of res.json?.results || []) {
          rows.push({
            campaign: r.campaign?.name,
            impressions: num(r.metrics?.impressions),
            clicks: num(r.metrics?.clicks),
            spend: num(r.metrics?.costMicros) / 1e6,
            conversions: num(r.metrics?.conversions),
            value: num(r.metrics?.conversionsValue),
          });
        }
        pageToken = res.json?.nextPageToken;
      } while (pageToken);
    }
    return groupByCampaign(rows);
  }

  async fetchSheet(range) {
    const url = (this.s.googleSheetCsvUrl || "").trim();
    if (!url) throw new Error("Google Ads: paste the published CSV link of your sheet");
    const res = await http({ url, method: "GET" });
    if (res.status !== 200) throw new Error(`Google Ads sheet: HTTP ${res.status}`);
    const table = parseCsv(res.text);
    if (table.length < 1) return [];
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
    for (const r of table.slice(1)) {
      const d = (r[iDate] || "").trim().slice(0, 10);
      if (d < range.since || d > range.until) continue;
      rows.push({
        campaign: r[iCamp],
        impressions: iImp >= 0 ? num(r[iImp]) : 0,
        clicks: iClk >= 0 ? num(r[iClk]) : 0,
        spend: num(r[iCost]),
        conversions: iConv >= 0 ? num(r[iConv]) : 0,
        value: iVal >= 0 ? num(r[iVal]) : 0,
      });
    }
    return groupByCampaign(rows);
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

  conversionTypes() {
    return (this.s.metaConversionActions || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }

  async fetch(range) {
    const s = this.s;
    const ids = splitIds(s.metaAdAccountIds);
    if (!s.metaAccessToken) throw new Error("Meta Ads: access token is required");
    if (!ids.length) throw new Error("Meta Ads: add at least one ad account ID");
    const version = (s.metaApiVersion || "v26.0").trim();
    const types = this.conversionTypes();
    const rows = [];

    for (const id of ids) {
      const params = new URLSearchParams({
        level: "campaign",
        fields: "campaign_name,impressions,clicks,spend,actions,action_values",
        time_range: JSON.stringify({ since: range.since, until: range.until }),
        limit: "500",
        access_token: s.metaAccessToken.trim(),
      });
      let url = `https://graph.facebook.com/${version}/act_${id}/insights?${params.toString()}`;
      while (url) {
        const res = await http({ url, method: "GET" });
        if (res.status !== 200) throw apiError("Meta Ads", res);
        for (const r of res.json?.data || []) {
          rows.push({
            campaign: r.campaign_name,
            impressions: num(r.impressions),
            clicks: num(r.clicks),
            spend: num(r.spend),
            conversions: sumActions(r.actions, types),
            value: sumActions(r.action_values, types),
          });
        }
        url = res.json?.paging?.next || null;
      }
    }
    return groupByCampaign(rows);
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
      const impressions = Math.round((2000 + rnd() * 8000) * range.days / (i + 1));
      const clicks = Math.round(impressions * (0.01 + rnd() * 0.05));
      const spend = +(clicks * (0.2 + rnd() * 1.2)).toFixed(2);
      const conversions = Math.round(clicks * (0.02 + rnd() * 0.08));
      const value = +(conversions * (15 + rnd() * 40)).toFixed(2);
      return { campaign: c, impressions, clicks, spend, conversions, value };
    });
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

function buildReport(results, range, settings) {
  const f = makeFormatter(settings.currency);
  const target = num(settings.targetCpa);
  const maxRows = Math.max(1, Math.floor(num(settings.maxCampaigns)) || 10);
  const out = [];
  const all = [];
  const allPrev = [];

  for (const res of results) {
    if (res.error) continue;
    all.push(...res.rows);
    if (res.prevRows) allPrev.push(...res.prevRows);
  }

  // Summary
  const tot = derive(sumRows(all, "Total"));
  const prev = allPrev.length || results.some((r) => r.prevRows) ? derive(sumRows(allPrev, "Prev")) : null;
  const parts = [`Spend **${f.money(tot.spend)}**${prev ? delta(tot.spend, prev.spend) : ""}`];
  parts.push(`Clicks ${f.int(tot.clicks)}${prev ? delta(tot.clicks, prev.clicks) : ""}`);
  parts.push(`Conversions ${f.conv(tot.conversions)}${prev ? delta(tot.conversions, prev.conversions) : ""}`);
  if (tot.cpa !== null) {
    parts.push(`CPA ${f.money(tot.cpa)}${prev ? delta(tot.cpa, prev.cpa) : ""}${cpaFlag(tot.cpa, target)}`);
  }
  if (tot.roas !== null) parts.push(`ROAS ${f.ratio(tot.roas)}`);
  if (settings.demoMode) {
    out.push("> [!info] Demo data");
    out.push("> These numbers are generated samples. Turn off demo mode in Ad Recap settings to see your accounts.");
    out.push("");
  }
  out.push(`*${range.label}*  `);
  out.push(parts.join(" · "));
  out.push("");

  for (const res of results) {
    out.push(`### ${res.name}`);
    if (res.error) {
      out.push(`> [!warning] ${res.error}`);
      out.push("");
      continue;
    }
    const rows = res.rows.map(derive).sort((a, b) => b.spend - a.spend);
    if (!rows.length) {
      out.push("_No spend in this period._");
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
        b(f.money(r.cpa)) + cpaFlag(r.cpa, target),
      ];
      if (hasValue) cells.push(f.ratio(r.roas));
      return `| ${cells.join(" | ")} |`;
    };
    for (const r of shown) out.push(line(r, false));
    out.push(line(derive(sumRows(res.rows, "Total")), true));
    out.push("");
  }

  return { markdown: out.join("\n").trim() + "\n", totals: tot };
}

function cpaFlag(cpa, target) {
  if (!target || cpa === null || cpa === undefined) return "";
  return cpa <= target ? " 🟢" : " 🔴";
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
          window.setTimeout(() => this.updateDailyNote(file, date, false), 2000);
        })
      );
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Guard against hand-edited data.json with "true"/"false" strings.
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      if (typeof v === "boolean") this.settings[k] = toBool(this.settings[k], v);
    }
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.cache.clear();
    // Redraw open live blocks so they never show data from the old settings.
    for (const redraw of this.blocks) redraw(true);
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
    const key = JSON.stringify([range.since, range.until, opts.source || "all", !!compare, !!this.settings.demoMode]);
    const hit = this.cache.get(key);
    if (hit && !opts.force && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;

    const results = await Promise.all(
      sources.map(async (src) => {
        try {
          const rows = await src.fetch(range);
          const prevRows = prev ? await src.fetch(prev) : null;
          return { name: src.name, rows, prevRows };
        } catch (e) {
          return { name: src.name, error: e.message || String(e) };
        }
      })
    );
    const value = { range, results, ...buildReport(results, range, this.settings) };
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
    const dn = this.app.internalPlugins?.getPluginById?.("daily-notes");
    const opts = (dn && dn.enabled && dn.instance && dn.instance.options) || {};
    return { folder: (opts.folder || "").replace(/^\/+|\/+$/g, ""), format: opts.format || "YYYY-MM-DD" };
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
      // The report in a daily note covers the day before the note.
      const day = ymd(addDays(date, -1));
      const rep = await this.collect(day, { force: interactive });
      const heading = (this.settings.heading || "## Ads").trim();
      const block = `${heading}\n${rep.markdown}`;
      await this.app.vault.process(file, (data) => replaceSection(data, heading, block));
      if (this.settings.writeProperties && rep.results.some((r) => !r.error)) {
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          fm.ads_spend = round2(rep.totals.spend);
          fm.ads_clicks = rep.totals.clicks;
          fm.ads_conversions = round2(rep.totals.conversions);
          fm.ads_cpa = rep.totals.cpa === null ? null : round2(rep.totals.cpa);
          if (rep.totals.roas !== null) fm.ads_roas = round2(rep.totals.roas);
        });
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

    const draw = async (force) => {
      el.empty();
      const bar = el.createDiv({ cls: "ad-recap-bar" });
      bar.createSpan({ cls: "ad-recap-title", text: "Ad Recap" });
      const btn = bar.createEl("button", { cls: "ad-recap-refresh", text: "Refresh" });
      btn.addEventListener("click", () => draw(true));
      const body = el.createDiv({ cls: "ad-recap-body" });
      body.createDiv({ cls: "ad-recap-loading", text: "Loading…" });
      try {
        const rep = await this.collect(opts.range || "last_7d", {
          source: opts.source || "all",
          compare: opts.compare === undefined ? undefined : !/^(false|no|off|0)$/i.test(opts.compare),
          force,
        });
        body.empty();
        await MarkdownRenderer.render(this.app, rep.markdown, body, ctx.sourcePath, child);
      } catch (e) {
        body.empty();
        body.createDiv({ cls: "ad-recap-error", text: e.message || String(e) });
      }
    };
    this.blocks.add(draw);
    child.onunload = () => this.blocks.delete(draw);
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
      const rows = await src.fetch(resolveRange("last_7d"));
      new Notice(`${src.name}: connected ✓ (${rows.length} campaign${rows.length === 1 ? "" : "s"} with spend in the last 7 days)`, 8000);
    } catch (e) {
      new Notice(e.message || String(e), 10000);
    } finally {
      notice.hide();
      this.testing = false;
      if (button) button.setDisabled(false);
    }
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

/** Replace the section that starts at `heading` (up to the next heading of the same or higher level), or append it. */
function replaceSection(data, heading, block) {
  const level = (/^(#+)\s/.exec(heading) || ["", "##"])[1].length;
  const lines = data.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) {
    const sep = data.length === 0 || data.endsWith("\n\n") ? "" : data.endsWith("\n") ? "\n" : "\n\n";
    return data + sep + block;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+)\s/.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
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

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = async () => this.plugin.saveSettings();
    containerEl.empty();

    const text = (setting, key, placeholder, secret) =>
      setting.addText((t) => {
        t.setPlaceholder(placeholder || "").setValue(String(s[key] ?? ""));
        if (secret) t.inputEl.type = "password";
        t.onChange(async (v) => {
          s[key] = v;
          await save();
        });
      });

    /* General */
    new Setting(containerEl)
      .setName("Demo mode")
      .setDesc("On: reports show generated sample data and are labelled “Demo data”. Off: reports use the accounts connected below.")
      .addToggle((t) =>
        t.setValue(s.demoMode === true).onChange(async (v) => {
          s.demoMode = v === true;
          await save();
          new Notice(`Ad Recap: demo mode ${s.demoMode ? "on, showing sample data" : "off, using your accounts"}`);
        })
      );

    text(new Setting(containerEl).setName("Currency").setDesc("Symbol or code shown next to money values, e.g. $, €, ₾ or GEL."), "currency", "$");

    new Setting(containerEl)
      .setName("Target CPA")
      .setDesc("Optional. Campaigns above it get 🔴, at or below it get 🟢. Leave 0 to turn off.")
      .addText((t) =>
        t.setValue(String(s.targetCpa || 0)).onChange(async (v) => {
          s.targetCpa = num(v);
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Campaigns per table")
      .setDesc("The rest are grouped into one “Other” row.")
      .addText((t) =>
        t.setValue(String(s.maxCampaigns)).onChange(async (v) => {
          s.maxCampaigns = Math.max(1, Math.floor(num(v)) || 10);
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Compare with previous period")
      .setDesc("Show ▲/▼ changes against the period of the same length just before.")
      .addToggle((t) => t.setValue(s.compare).onChange(async (v) => ((s.compare = v), await save())));

    new Setting(containerEl).setName("Daily notes").setHeading();

    new Setting(containerEl)
      .setName("Add report to new daily notes")
      .setDesc("When today's daily note is created, add yesterday's numbers to it automatically.")
      .addToggle((t) => t.setValue(s.autoDailyNote).onChange(async (v) => ((s.autoDailyNote = v), await save())));

    text(
      new Setting(containerEl).setName("Section heading").setDesc("The report goes under this heading. If it already exists, it is replaced."),
      "heading",
      "## Ads"
    );

    new Setting(containerEl)
      .setName("Save totals as note properties")
      .setDesc("Writes ads_spend, ads_clicks, ads_conversions, ads_cpa and ads_roas so you can chart them with Bases or Dataview.")
      .addToggle((t) => t.setValue(s.writeProperties).onChange(async (v) => ((s.writeProperties = v), await save())));

    /* Google */
    new Setting(containerEl).setName("Google Ads").setHeading();

    new Setting(containerEl)
      .setName("Enable Google Ads")
      .addToggle((t) =>
        t.setValue(s.googleEnabled).onChange(async (v) => {
          s.googleEnabled = v;
          await save();
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
              await save();
              this.display();
            })
        );

      if (s.googleMode === "sheet") {
        text(
          new Setting(containerEl).setName("Published CSV link").setDesc("File → Share → Publish to web → CSV in Google Sheets."),
          "googleSheetCsvUrl",
          "https://docs.google.com/spreadsheets/d/e/…/pub?output=csv"
        );
      } else {
        text(new Setting(containerEl).setName("Customer IDs").setDesc("One or more, comma separated. Dashes are fine."), "googleCustomerIds", "123-456-7890");
        text(new Setting(containerEl).setName("Manager account ID").setDesc("Only if you access the accounts through a manager (MCC) account."), "googleLoginCustomerId", "optional");
        text(new Setting(containerEl).setName("Developer token"), "googleDeveloperToken", "", true);
        text(new Setting(containerEl).setName("OAuth client ID"), "googleClientId", "….apps.googleusercontent.com");
        text(new Setting(containerEl).setName("OAuth client secret"), "googleClientSecret", "", true);
        text(new Setting(containerEl).setName("Refresh token"), "googleRefreshToken", "", true);
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
          await save();
          this.display();
        })
      );

    if (s.metaEnabled) {
      text(new Setting(containerEl).setName("Access token").setDesc("A system user or long-lived token with ads_read."), "metaAccessToken", "", true);
      text(new Setting(containerEl).setName("Ad account IDs").setDesc("One or more, comma separated, with or without act_."), "metaAdAccountIds", "act_1234567890");
      text(
        new Setting(containerEl)
          .setName("Conversion actions")
          .setDesc("Action types counted as conversions, comma separated. Examples: purchase, lead, offsite_conversion.fb_pixel_lead."),
        "metaConversionActions",
        "purchase, lead"
      );
      text(new Setting(containerEl).setName("API version"), "metaApiVersion", "v26.0");
      new Setting(containerEl).addButton((b) => b.setButtonText("Test Meta Ads").onClick(() => this.plugin.testSource("meta", b)));
    }

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Tokens are stored in this vault's plugin data file. If your vault syncs to other devices or is shared, the tokens go with it.",
    });
  }
}

module.exports = AdRecapPlugin;
module.exports.default = AdRecapPlugin;
// Exposed for tests.
module.exports._internals = { toBool, resolveRange, previousRange, buildReport, parseCsv, replaceSection, GoogleAdsSource, MetaAdsSource, DemoSource, groupByCampaign, sumActions };
