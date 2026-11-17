/**
 * Ad Recap: Google Ads → Google Sheet export.
 *
 * Use this if you don't have a Google Ads API developer token.
 * 1. Create an empty Google Sheet and copy its URL into SHEET_URL below.
 * 2. In Google Ads open Tools → Bulk actions → Scripts, add a new script and paste this file.
 * 3. Authorize, run it once, then schedule it to run daily (or hourly).
 * 4. In the sheet: File → Share → Publish to web → choose the first sheet and CSV → Publish.
 * 5. Paste the published CSV link into Ad Recap settings (Google Ads → Connection: Google Sheet).
 */
const SHEET_URL = 'PASTE_YOUR_SHEET_URL_HERE';
const PERIOD = 'LAST_30_DAYS'; // also: LAST_14_DAYS, LAST_7_DAYS, THIS_MONTH, LAST_MONTH

function main() {
  const query =
    'SELECT segments.date, campaign.name, metrics.impressions, metrics.clicks, ' +
    'metrics.cost_micros, metrics.conversions, metrics.conversions_value ' +
    'FROM campaign WHERE segments.date DURING ' + PERIOD + ' AND metrics.impressions > 0';

  const rows = [['date', 'campaign', 'impressions', 'clicks', 'cost', 'conversions', 'conversion_value']];
  const it = AdsApp.search(query);
  while (it.hasNext()) {
    const r = it.next();
    rows.push([
      r.segments.date,
      r.campaign.name,
      Number(r.metrics.impressions),
      Number(r.metrics.clicks),
      Number(r.metrics.costMicros) / 1e6,
      Number(r.metrics.conversions),
      Number(r.metrics.conversionsValue),
    ]);
  }

  const sheet = SpreadsheetApp.openByUrl(SHEET_URL).getSheets()[0];
  sheet.clearContents();
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  Logger.log('Exported ' + (rows.length - 1) + ' rows');
}
