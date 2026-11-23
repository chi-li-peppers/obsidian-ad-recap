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
// 90 days covers today, yesterday, last_30d + previous 30d comparison, and last_month.
const LOOKBACK_DAYS = 90;

function formatDate(d) {
  const tz = AdsApp.currentAccount().getTimeZone();
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}

function main() {
  const today = new Date();
  const start = new Date(today.getTime() - (LOOKBACK_DAYS - 1) * 86400000);
  const since = formatDate(start);
  const until = formatDate(today);

  const query =
    'SELECT segments.date, campaign.name, metrics.impressions, metrics.clicks, ' +
    'metrics.cost_micros, metrics.conversions, metrics.conversions_value ' +
    "FROM campaign WHERE segments.date BETWEEN '" + since + "' AND '" + until + "'";

  const rows = [['date', 'campaign', 'impressions', 'clicks', 'cost', 'conversions', 'conversion_value']];
  const it = AdsApp.search(query);
  while (it.hasNext()) {
    const r = it.next();
    const impressions = Number(r.metrics.impressions) || 0;
    const clicks = Number(r.metrics.clicks) || 0;
    const cost = (Number(r.metrics.costMicros) || 0) / 1e6;
    const conversions = Number(r.metrics.conversions) || 0;
    const value = Number(r.metrics.conversionsValue) || 0;
    if (impressions === 0 && clicks === 0 && cost === 0 && conversions === 0 && value === 0) continue;
    rows.push([
      String(r.segments.date),
      r.campaign.name,
      impressions,
      clicks,
      cost,
      conversions,
      value,
    ]);
  }

  const sheet = SpreadsheetApp.openByUrl(SHEET_URL).getSheets()[0];
  sheet.clearContents();
  // Format date column as plain text so Google Sheets never reformats YYYY-MM-DD into a locale date.
  sheet.getRange(1, 1, rows.length, 1).setNumberFormat('@');
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  Logger.log('Exported ' + (rows.length - 1) + ' rows (' + since + ' to ' + until + ')');
}
