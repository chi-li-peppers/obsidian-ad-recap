// Unit tests for Ad Recap. Run with: node tests/run.js (no dependencies needed)
// Test harness: fake "obsidian" module + mocked HTTP.
const Module = require("module");
const assert = require("assert");
const calls = [];
let responder = () => ({ status: 404, json: null, text: "" });

const fake = {
  Plugin: class {}, PluginSettingTab: class {}, Setting: class {}, Notice: class { hide() {} },
  Modal: class {}, SuggestModal: class {}, MarkdownRenderer: {}, MarkdownRenderChild: class {},
  MarkdownView: class {}, TFile: class {}, moment: null,
  requestUrl: async (o) => { calls.push(o); const r = responder(o); return { status: r.status, json: r.json, text: r.text ?? JSON.stringify(r.json) }; },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === "obsidian" ? fake : origLoad.call(this, req, ...rest); };

const P = require(require("path").join(__dirname, "..", "main.js"));
const I = P._internals;

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
console.log("ranges ok");

// --- csv
const csv = 'date,campaign,impressions,clicks,cost,conversions,conversion_value\n2026-11-16,"Brand, exact",100,10,5.5,1,20\n2026-11-16,Generic,200,4,3,0,0\n2026-11-15,Generic,50,1,1,0,0\n';
assert.strictEqual(I.parseCsv(csv)[1][1], "Brand, exact");
console.log("csv ok");

// --- sections
let note = "# 17 Nov\n\nSome text\n";
let out = I.replaceSection(note, "## Ads", "## Ads\nA\n");
assert.strictEqual(out, "# 17 Nov\n\nSome text\n\n## Ads\nA\n");
out = I.replaceSection(out + "\n## Tasks\n- x\n", "## Ads", "## Ads\nB\n");
assert.ok(out.includes("## Ads\nB\n\n## Tasks\n- x"), out);
assert.ok(!out.includes("\nA\n"));
console.log("sections ok");

// --- sources with mocked http
(async () => {
  const settings = {
    currency: "$", targetCpa: 5, maxCampaigns: 10, compare: true,
    googleMode: "api", googleApiVersion: "v26", googleDeveloperToken: "dev", googleClientId: "cid",
    googleClientSecret: "sec", googleRefreshToken: "rt", googleCustomerIds: "123-456-7890", googleLoginCustomerId: "999-000-1111",
    googleSheetCsvUrl: "https://sheet", metaApiVersion: "v26.0", metaAccessToken: "tok", metaAdAccountIds: "act_42, 43",
    metaConversionActions: "purchase, lead",
  };
  const plugin = { settings };
  const range = I.resolveRange("yesterday", anchor);

  responder = (o) => {
    if (o.url.includes("oauth2")) return { status: 200, json: { access_token: "AT", expires_in: 3600 } };
    if (o.url.includes("googleAds:search")) {
      const body = JSON.parse(o.body);
      if (!body.pageToken) return { status: 200, json: { results: [
        { campaign: { name: "Brand" }, metrics: { impressions: "1000", clicks: "50", costMicros: "25000000", conversions: 5, conversionsValue: 200 } },
      ], nextPageToken: "p2" } };
      return { status: 200, json: { results: [
        { campaign: { name: "Generic" }, metrics: { impressions: "3000", clicks: "60", costMicros: "48000000", conversions: 4, conversionsValue: 0 } },
      ] } };
    }
    if (o.url.includes("graph.facebook.com")) {
      if (o.url.includes("act_42")) return { status: 200, json: { data: [
        { campaign_name: "Leads | LAL", impressions: "5000", clicks: "120", spend: "60.00",
          actions: [{ action_type: "lead", value: "12" }, { action_type: "link_click", value: "120" }],
          action_values: [{ action_type: "lead", value: "0" }] },
      ], paging: {} } };
      return { status: 200, json: { data: [{ campaign_name: "Retarget", impressions: "800", clicks: "30", spend: "15.5", actions: [{ action_type: "purchase", value: "2" }], action_values: [{ action_type: "purchase", value: "90" }] }] } };
    }
    if (o.url === "https://sheet") return { status: 200, text: csv, json: null };
    return { status: 404, json: { error: { message: "nope" } } };
  };

  const g = new I.GoogleAdsSource(plugin);
  const gr = await g.fetch(range);
  assert.strictEqual(gr.length, 2);
  assert.strictEqual(gr.find((x) => x.campaign === "Brand").spend, 25);
  const adsCall = calls.find((c) => c.url.includes("googleAds:search"));
  assert.strictEqual(adsCall.url, "https://googleads.googleapis.com/v26/customers/1234567890/googleAds:search");
  assert.strictEqual(adsCall.headers["login-customer-id"], "9990001111");
  assert.ok(JSON.parse(adsCall.body).query.includes("BETWEEN '2026-11-16' AND '2026-11-16'"));
  console.log("google api ok");

  settings.googleMode = "sheet";
  const gs = await g.fetch(range);
  assert.strictEqual(gs.length, 2);
  assert.strictEqual(gs.find((x) => x.campaign === "Generic").clicks, 4); // 15th excluded
  settings.googleMode = "api";
  console.log("google sheet ok");

  const m = new I.MetaAdsSource(plugin);
  const mr = await m.fetch(range);
  assert.strictEqual(mr.length, 2);
  assert.strictEqual(mr.find((x) => x.campaign === "Leads | LAL").conversions, 12);
  assert.strictEqual(mr.find((x) => x.campaign === "Retarget").value, 90);
  const metaCall = calls.find((c) => c.url.includes("act_42"));
  const u = new URL(metaCall.url);
  assert.strictEqual(u.pathname, "/v26.0/act_42/insights");
  assert.strictEqual(u.searchParams.get("time_range"), '{"since":"2026-11-16","until":"2026-11-16"}');
  console.log("meta ok");

  // error path
  const bad = new I.MetaAdsSource({ settings: { ...settings, metaAdAccountIds: "" } });
  await assert.rejects(() => bad.fetch(range), /ad account/);
  responder = () => ({ status: 400, json: { error: { message: "Invalid OAuth access token." } } });
  await assert.rejects(() => m.fetch(range), /Invalid OAuth access token/);
  console.log("errors ok");

  // report
  const rep = I.buildReport(
    [
      { name: "Google Ads", rows: gr, prevRows: [{ campaign: "Brand", impressions: 900, clicks: 40, spend: 50, conversions: 6, value: 150 }] },
      { name: "Meta Ads", rows: mr, prevRows: [] },
      { name: "Broken", error: "Broken: token expired" },
    ],
    range,
    settings
  );
  
  assert.ok(rep.markdown.includes("Leads \\| LAL"));
  assert.ok(rep.markdown.includes("🔴") && rep.markdown.includes("🟢"));
  assert.ok(rep.markdown.includes("> [!warning] Broken: token expired"));
  assert.strictEqual(Math.round(rep.totals.spend * 100) / 100, 148.5);

  // demo + overflow rows
  const demo = new I.DemoSource("Google Ads", 1);
  const rows = await demo.fetch(I.resolveRange("last_7d", anchor));
  const rep2 = I.buildReport([{ name: "Google Ads", rows }], I.resolveRange("last_7d", anchor), { ...settings, maxCampaigns: 3 });
  assert.ok(rep2.markdown.includes("Other (2)"));
  console.log("all tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
