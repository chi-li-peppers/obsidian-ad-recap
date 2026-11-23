// Unit tests for Ad Recap. Run with: node tests/run.js (no dependencies needed)
// Test harness: fake "obsidian" module + mocked HTTP.
const Module = require("module");
const assert = require("assert");
const calls = [];
let responder = () => ({ status: 404, json: null, text: "" });

const fake = {
  Plugin: class {
    async saveData() {}
    async loadData() { return {}; }
  },
  PluginSettingTab: class {},
  Setting: class {},
  Notice: class { hide() {} },
  SuggestModal: class {},
  MarkdownRenderer: {
    async render(_app, md, el) {
      el.rendered = md;
    },
  },
  MarkdownRenderChild: class {},
  TFile: class {},
  moment: null,
  requestUrl: async (o) => {
    calls.push(o);
    const r = responder(o);
    return { status: r.status, json: r.json, text: r.text ?? JSON.stringify(r.json) };
  },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  return req === "obsidian" ? fake : origLoad.call(this, req, ...rest);
};

const P = require(require("path").join(__dirname, "..", "main.js"));
const I = P._internals;

async function main() {
  // --- ranges
  const anchor = new Date(2026, 10, 17); // 17 Nov 2026
  let r = I.resolveRange("yesterday", anchor);
  assert.deepStrictEqual([r.since, r.until, r.days], ["2026-11-16", "2026-11-16", 1]);
  r = I.resolveRange("last_7d", anchor);
  assert.deepStrictEqual([r.since, r.until, r.days], ["2026-11-10", "2026-11-16", 7]);
  let p = I.previousRange(r);
  assert.deepStrictEqual([p.since, p.until], ["2026-11-03", "2026-11-09"]);
  r = I.resolveRange("last_month", anchor);
  assert.deepStrictEqual([r.since, r.until], ["2026-10-01", "2026-10-31"]);
  r = I.resolveRange("this_month", new Date(2026, 2, 1));
  assert.deepStrictEqual([r.since, r.until], ["2026-03-01", "2026-03-01"]);
  r = I.resolveRange("2026-11-05..2026-11-01", anchor);
  assert.deepStrictEqual([r.since, r.until, r.days], ["2026-11-01", "2026-11-05", 5]);
  assert.throws(() => I.resolveRange("garbage", anchor));
  assert.throws(() => I.resolveRange("2026-02-31", anchor));
  console.log("ranges ok");

  // --- numbers & formatting
  assert.strictEqual(I.num("1,234.56"), 1234.56);
  assert.strictEqual(I.num("1.234,56"), 1234.56);
  assert.strictEqual(I.num("1 234,56"), 1234.56);
  assert.strictEqual(I.num("$1,234.56"), 1234.56);
  assert.strictEqual(I.num("-$12.50"), -12.5);
  assert.strictEqual(I.num("$-12.50"), -12.5);
  assert.strictEqual(I.num("1,200"), 1200);
  assert.strictEqual(I.num("1,234,567"), 1234567);
  assert.strictEqual(I.num("0,125"), 0.125);
  assert.strictEqual(I.num("5,5"), 5.5);
  assert.strictEqual(I.num("—"), 0);

  const fmt = I.makeFormatter("$");
  assert.strictEqual(fmt.money(-12.5), "-$12.50");
  assert.strictEqual(fmt.money(12.5), "$12.50");
  const fmtCode = I.makeFormatter("GEL");
  assert.strictEqual(fmtCode.money(-12.5), "-12.50 GEL");
  console.log("numbers ok");

  // --- sheet dates & api versions
  assert.strictEqual(I.normalizeSheetDate("2026-11-16"), "2026-11-16");
  assert.strictEqual(I.normalizeSheetDate("2026-11-16T00:00:00Z"), "2026-11-16");
  assert.strictEqual(I.normalizeSheetDate("2026/11/16"), "2026-11-16");
  assert.strictEqual(I.normalizeSheetDate("11/16/2026"), "2026-11-16");
  assert.strictEqual(I.normalizeSheetDate("16/11/2026"), "2026-11-16");
  assert.strictEqual(I.normalizeSheetDate("16.11.2026"), "2026-11-16");
  assert.strictEqual(I.normalizeSheetDate("not-a-date"), null);

  assert.strictEqual(I.normalizeApiVersion("26", "v26", false), "v26");
  assert.strictEqual(I.normalizeApiVersion("v26", "v26", false), "v26");
  assert.strictEqual(I.normalizeApiVersion("27", "v27.0", true), "v27.0");
  assert.strictEqual(I.normalizeApiVersion("27.0", "v27.0", true), "v27.0");
  assert.throws(() => I.normalizeApiVersion("v26/evil", "v26", false));
  console.log("normalizers ok");

  // --- csv
  const csv = 'date,campaign,impressions,clicks,cost,conversions,conversion_value\n11/16/2026,"Brand, exact",100,10,"$1,205.50",1,20\n2026-11-16,Generic,200,4,3,0,0\n2026-11-15,Generic,50,1,1,0,0\n';
  assert.strictEqual(I.parseCsv(csv)[1][1], "Brand, exact");
  console.log("csv ok");

  // --- sections
  let note = "# 17 Nov\n\nSome text\n";
  let out = I.replaceSection(note, "## Ads", "## Ads\nA\n");
  assert.strictEqual(out, "# 17 Nov\n\nSome text\n\n## Ads\nA\n");
  out = I.replaceSection(out + "\n## Tasks\n- x\n", "## Ads", "## Ads\nB\n");
  assert.ok(out.includes("## Ads\nB\n\n## Tasks\n- x"), out);
  assert.ok(!out.includes("\nA\n"));

  // Deep heading (### Ads with #### Google Ads subheading) must replace cleanly without duplicating
  let deep = "# Daily\n\n### Ads\n#### Google Ads\nOld\n\n### Tasks\n- keep\n";
  let deepOut = I.replaceSection(deep, "### Ads", "### Ads\n#### Google Ads\nNew\n");
  assert.ok(deepOut.includes("#### Google Ads\nNew\n\n### Tasks\n- keep"), deepOut);
  assert.ok(!deepOut.includes("Old"));

  // Heading inside fenced code block must be ignored
  let fenced = "# Daily\n\n```md\n## Ads\n```\n\n## Ads\nOld\n\n## Next\n";
  let fencedOut = I.replaceSection(fenced, "## Ads", "## Ads\nNew\n");
  assert.ok(fencedOut.includes("```md\n## Ads\n```"));
  assert.ok(fencedOut.includes("## Ads\nNew\n\n## Next"));
  assert.ok(!fencedOut.includes("Old"));

  // HTML markers
  let marked = "# Daily\n\n<!-- ad-recap:start -->\nold\n<!-- ad-recap:end -->\n\nFooter\n";
  let markedOut = I.replaceSection(marked, "## Ads", "## Ads\nFresh\n");
  assert.ok(markedOut.includes("<!-- ad-recap:start -->\n## Ads\nFresh\n<!-- ad-recap:end -->"));
  assert.ok(!markedOut.includes("\nold\n"));

  // sectionHasContent
  assert.strictEqual(I.sectionHasContent("# Daily\n\n## Ads\n\n## Tasks\n", "## Ads"), false);
  assert.strictEqual(I.sectionHasContent("# Daily\n\n## Ads\nSpend **$10**\n", "## Ads"), true);
  console.log("sections ok");

  // --- sources with mocked http
  const settings = {
    currency: "$", targetCpa: 5, maxCampaigns: 10, compare: true,
    googleMode: "api", googleApiVersion: "v26", googleDeveloperToken: "dev", googleClientId: "cid",
    googleClientSecret: "sec", googleRefreshToken: "rt", googleCustomerIds: "123-456-7890", googleLoginCustomerId: "999-000-1111",
    googleSheetCsvUrl: "https://sheet", metaApiVersion: "v27.0", metaAccessToken: "tok", metaAdAccountIds: "act_42, 43",
    metaConversionActions: "purchase, lead", metaClickMetric: "link",
  };
  const plugin = { settings };
  const range = I.resolveRange("yesterday", anchor);

  responder = (o) => {
    if (o.url.includes("oauth2")) return { status: 200, json: { access_token: "AT", expires_in: 3600 } };
    if (o.url.includes("googleAds:search")) {
      const body = JSON.parse(o.body);
      if (!body.pageToken) return { status: 200, json: { results: [
        { customer: { descriptiveName: "Main", currencyCode: "USD" }, campaign: { name: "Brand" }, metrics: { impressions: "1000", clicks: "50", costMicros: "25000000", conversions: 5, conversionsValue: 200 } },
      ], nextPageToken: "p2" } };
      return { status: 200, json: { results: [
        // Delayed conversion with 0 impressions must NOT be dropped
        { customer: { descriptiveName: "Main", currencyCode: "USD" }, campaign: { name: "Generic" }, metrics: { impressions: "0", clicks: "0", costMicros: "48000000", conversions: 4, conversionsValue: 0 } },
      ] } };
    }
    if (o.url.includes("graph.facebook.com")) {
      if (o.url.includes("act_42")) return { status: 200, json: { data: [
        { campaign_name: "Leads | LAL", account_name: "Client A", account_currency: "USD", impressions: "5000", clicks: "300", inline_link_clicks: "120", spend: "60.00",
          actions: [{ action_type: "lead", value: "12" }, { action_type: "link_click", value: "120" }],
          action_values: [{ action_type: "lead", value: "0" }] },
      ], paging: {} } };
      return { status: 200, json: { data: [{ campaign_name: "Retarget", account_name: "Client B", account_currency: "USD", impressions: "800", clicks: "90", inline_link_clicks: "30", spend: "15.5", actions: [{ action_type: "purchase", value: "2" }], action_values: [{ action_type: "purchase", value: "90" }] }] } };
    }
    if (o.url === "https://sheet") return { status: 200, text: csv, json: null };
    return { status: 404, json: { error: { message: "nope" } } };
  };

  const g = new I.GoogleAdsSource(plugin);
  const gr = await g.fetch(range);
  assert.strictEqual(gr.length, 2);
  assert.strictEqual(gr.find((x) => x.campaign === "Brand").spend, 25);
  assert.strictEqual(gr.find((x) => x.campaign === "Generic").conversions, 4);
  const adsCall = calls.find((c) => c.url.includes("googleAds:search"));
  assert.strictEqual(adsCall.url, "https://googleads.googleapis.com/v26/customers/1234567890/googleAds:search");
  assert.strictEqual(adsCall.headers["login-customer-id"], "9990001111");
  assert.ok(JSON.parse(adsCall.body).query.includes("BETWEEN '2026-11-16' AND '2026-11-16'"));
  assert.ok(!JSON.parse(adsCall.body).query.includes("metrics.impressions > 0"), "GAQL must not drop 0-impression conversions");

  // Token reset must force re-auth
  g.resetToken();
  assert.strictEqual(g.token, null);
  console.log("google api ok");

  // Sheet mode: locale dates, currency numbers, and caching across compare calls
  settings.googleMode = "sheet";
  const sheetCallsBefore = calls.filter((c) => c.url === "https://sheet").length;
  const gs = await g.fetch(range);
  const gsPrev = await g.fetch(I.previousRange(range));
  const sheetCallsAfter = calls.filter((c) => c.url === "https://sheet").length;
  assert.strictEqual(sheetCallsAfter - sheetCallsBefore, 1, "Sheet CSV must be cached across current+previous period");
  assert.strictEqual(gs.length, 2);
  assert.strictEqual(gs.find((x) => x.campaign === "Brand, exact").spend, 1205.5);
  assert.strictEqual(gs.find((x) => x.campaign === "Generic").clicks, 4);
  assert.strictEqual(gsPrev.length, 1);
  assert.strictEqual(gsPrev[0].clicks, 1);

  // Sheet URL must be https://
  const badSheet = new I.GoogleAdsSource({ settings: { ...settings, googleSheetCsvUrl: "http://evil.local/x.csv" } });
  await assert.rejects(() => badSheet.fetch(range), /https:\/\//);
  settings.googleMode = "api";
  console.log("google sheet ok");

  // Meta: Bearer header (token not in URL), inline_link_clicks default, account filter
  const m = new I.MetaAdsSource(plugin);
  const mr = await m.fetch(range);
  assert.strictEqual(mr.length, 2);
  assert.strictEqual(mr.find((x) => x.campaign === "Leads | LAL").clicks, 120, "default Meta clicks must be inline_link_clicks");
  assert.strictEqual(mr.find((x) => x.campaign === "Leads | LAL").conversions, 12);
  assert.strictEqual(mr.find((x) => x.campaign === "Retarget").value, 90);
  const metaCall = calls.find((c) => c.url.includes("act_42"));
  const u = new URL(metaCall.url);
  assert.strictEqual(u.pathname, "/v27.0/act_42/insights");
  assert.strictEqual(u.searchParams.get("access_token"), null, "Meta token must NOT be in URL query string");
  assert.strictEqual(metaCall.headers.Authorization, "Bearer tok");
  assert.strictEqual(u.searchParams.get("time_range"), '{"since":"2026-11-16","until":"2026-11-16"}');

  // Meta "all" clicks mode
  settings.metaClickMetric = "all";
  const mrAll = await m.fetch(range);
  assert.strictEqual(mrAll.find((x) => x.campaign === "Leads | LAL").clicks, 300);
  settings.metaClickMetric = "link";

  // Account filter
  const mrFiltered = await m.fetch(range, { account: "43" });
  assert.strictEqual(mrFiltered.length, 1);
  assert.strictEqual(mrFiltered[0].campaign, "Retarget");
  console.log("meta ok");

  // Multi-account campaign name collision disambiguation
  const merged = I.groupByCampaign([
    { accountId: "1", accountName: "Client A", campaign: "Brand", impressions: 100, clicks: 10, spend: 10, conversions: 1, value: 0 },
    { accountId: "2", accountName: "Client B", campaign: "Brand", impressions: 200, clicks: 20, spend: 20, conversions: 2, value: 0 },
    { accountId: "1", accountName: "Client A", campaign: "Unique", impressions: 50, clicks: 5, spend: 5, conversions: 0, value: 0 },
  ]);
  assert.strictEqual(merged.length, 3);
  assert.ok(merged.find((x) => x.campaign === "Brand (Client A)"));
  assert.ok(merged.find((x) => x.campaign === "Brand (Client B)"));
  assert.ok(merged.find((x) => x.campaign === "Unique"));

  // Partial multi-account resilience (1 account works, 1 fails)
  responder = (o) => {
    if (o.url.includes("act_42")) return { status: 200, json: { data: [{ campaign_name: "OK", impressions: "100", inline_link_clicks: "10", spend: "5" }] } };
    return { status: 400, json: { error: { message: "Account disabled" } } };
  };
  const partialMeta = await m.fetchDetailed(range);
  assert.strictEqual(partialMeta.rows.length, 1);
  assert.strictEqual(partialMeta.warnings.length, 1);
  assert.ok(partialMeta.warnings[0].includes("Account disabled"));
  console.log("multi-account ok");

  // error path (all fail)
  const bad = new I.MetaAdsSource({ settings: { ...settings, metaAdAccountIds: "" } });
  await assert.rejects(() => bad.fetch(range), /ad account/);
  responder = () => ({ status: 400, json: { error: { message: "Invalid OAuth access token." } } });
  await assert.rejects(() => m.fetch(range), /Invalid OAuth access token/);
  console.log("errors ok");

  // report: ROAS delta, wasted spend red flag, partial marker, mixed currencies, dynamic heading depth, filter & sort
  const rep = I.buildReport(
    [
      {
        name: "Google Ads",
        rows: [
          ...gr,
          { campaign: "Wasted", impressions: 500, clicks: 20, spend: 30, conversions: 0, value: 0 },
        ],
        prevRows: [{ campaign: "Brand", impressions: 900, clicks: 40, spend: 50, conversions: 6, value: 150 }],
        currencies: ["USD"],
      },
      { name: "Meta Ads", rows: mr, prevRows: [], currencies: ["EUR"] },
      { name: "Broken", error: "Broken: token expired" },
    ],
    range,
    settings,
    { headingLevel: 3 }
  );

  assert.strictEqual(rep.partial, true);
  assert.ok(rep.markdown.includes("#### Google Ads"), "headingLevel 3 must render #### subheadings");
  assert.ok(rep.markdown.includes("· partial*"));
  assert.ok(rep.markdown.includes("Mixed account currencies (USD, EUR)"));
  assert.ok(rep.markdown.includes("Leads \\| LAL"));
  assert.ok(rep.markdown.includes("🔴") && rep.markdown.includes("🟢"));
  // Wasted campaign spent $30 > targetCpa $5 with 0 conversions => must get 🔴
  const wastedLine = rep.markdown.split("\n").find((l) => l.includes("| Wasted |"));
  assert.ok(wastedLine && wastedLine.includes("🔴"), `Wasted campaign must be flagged red: ${wastedLine}`);
  // ROAS must include delta against previous period
  assert.ok(/ROAS \d+\.\d+× \([▲▼±]/.test(rep.markdown), `ROAS delta missing in:\n${rep.markdown}`);
  assert.ok(rep.markdown.includes("> [!warning] Broken: token expired"));
  assert.strictEqual(Math.round(rep.totals.spend * 100) / 100, 178.5);

  // Filter & sort
  const filteredRep = I.buildReport(
    [{ name: "Google Ads", rows: gr }],
    range,
    settings,
    { filter: "brand" }
  );
  assert.ok(filteredRep.markdown.includes("| Brand |"));
  assert.ok(!filteredRep.markdown.includes("| Generic |"));

  // Frontmatter properties helper
  const fm = { ads_roas: 4.5 };
  I.applyFrontMatter(fm, {
    totals: { spend: 120.456, impressions: 5000, clicks: 150, conversions: 10, value: 0, cpa: 12.0456, roas: null },
    bySource: { "Google Ads": { spend: 70.1 }, "Meta Ads": { spend: 50.356 } },
  });
  assert.strictEqual(fm.ads_spend, 120.46);
  assert.strictEqual(fm.ads_impressions, 5000);
  assert.strictEqual(fm.ads_value, 0);
  assert.strictEqual(fm.ads_roas, null, "stale ads_roas must be cleared to null");
  assert.strictEqual(fm.ads_google_spend, 70.1);
  assert.strictEqual(fm.ads_meta_spend, 50.36);

  // demo + overflow rows
  const demo = new I.DemoSource("Google Ads", 1);
  const rows = await demo.fetch(I.resolveRange("last_7d", anchor));
  const rep2 = I.buildReport([{ name: "Google Ads", rows }], I.resolveRange("last_7d", anchor), { ...settings, maxCampaigns: 3 });
  assert.ok(rep2.markdown.includes("Other (2)"));
  console.log("report ok");

  // --- SecretStorage + Periodic Notes + 1.0.1 regressions
  const demoRep = I.buildReport([{ name: "Meta Ads", rows }], range, { currency: "$", demoMode: true });
  assert.ok(demoRep.markdown.includes("[!info] Demo data"));
  const realRep = I.buildReport([{ name: "Meta Ads", rows }], range, { currency: "$", demoMode: false });
  assert.ok(!realRep.markdown.includes("Demo data"));

  assert.strictEqual(I.toBool("false", true), false);
  assert.strictEqual(I.toBool("true", false), true);
  assert.strictEqual(I.toBool(undefined, true), true);

  let fetches = 0;
  const plug = new P();
  plug.app = {
    secretStorage: {
      getSecret(id) {
        return id === "my-meta-secret" ? "SECRET_TOK" : null;
      },
    },
    internalPlugins: { getPluginById: () => null },
    plugins: {
      getPlugin: (id) =>
        id === "periodic-notes"
          ? { settings: { daily: { enabled: true, folder: "Journal/Daily", format: "YYYY/YYYY-MM-DD" } } }
          : null,
    },
  };
  plug.settings = { demoMode: true, metaAccessTokenSecret: "my-meta-secret", metaAccessToken: "OLD_PLAIN" };
  assert.strictEqual(plug.getSecretValue("metaAccessTokenSecret", "metaAccessToken"), "SECRET_TOK");
  assert.strictEqual(plug.getSecretValue("missingKey", "metaAccessToken"), "OLD_PLAIN");
  assert.deepStrictEqual(plug.dailyNoteSettings(), { folder: "Journal/Daily", format: "YYYY/YYYY-MM-DD" });

  plug.meta = { name: "Meta Ads", fetch: async () => { fetches++; await new Promise((r) => setTimeout(r, 30)); return []; } };
  plug.google = plug.meta;
  plug.testing = false;
  await plug.testSource("meta");
  assert.strictEqual(fetches, 0, "demo mode must not call the API");
  plug.settings.demoMode = false;
  const btn = { disabled: false, setDisabled(v) { this.disabled = v; } };
  await Promise.all([plug.testSource("meta", btn), plug.testSource("meta", btn), plug.testSource("meta", btn)]);
  assert.strictEqual(fetches, 1, "three rapid clicks must run one test");
  assert.strictEqual(btn.disabled, false);

  console.log("all tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
