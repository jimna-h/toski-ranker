/**
 * EDH Bracket Ranker — read-only JSON proxy for a PRIVATE Google Sheet.
 *
 * Why this exists: the ranker is a static client-side app, so it can't hold
 * service-account credentials safely. This tiny web app runs AS YOU (the
 * sheet owner), so the sheet never needs to be link-shared. It exposes only
 * the cell values of the tabs — nothing else, and it can't write anything.
 *
 * SETUP (one time, ~2 minutes):
 * 1. Open the Google Sheet → Extensions → Apps Script.
 * 2. Replace the default code with this file. Save.
 * 3. Deploy → New deployment → type "Web app":
 *      Execute as:            Me
 *      Who has access:        Anyone
 *    ("Anyone" means anyone WITH THIS URL can read the deck list JSON —
 *     the /exec URL is a long unguessable token; the sheet itself stays
 *     private. If even that is too open, "Anyone with a Google account"
 *     also works but players must be signed in when the app fetches.)
 * 4. Copy the Web app URL (ends in /exec) into DATA_URL in
 *    js/config.js.
 *
 * NOTE: after editing this script later, you must create a NEW deployment
 * (or update the existing one) for changes to take effect — saving alone
 * doesn't republish.
 */
function doGet() {
  // Bound to the spreadsheet it was created from (step 1 above). If you'd
  // rather keep the script standalone, replace with:
  //   SpreadsheetApp.openById("YOUR_SHEET_ID")
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const sheets = ss.getSheets().map(function (sh) {
    return {
      title: sh.getName(),
      // getDisplayValues → strings exactly as shown in the sheet, which
      // matches what the Sheets API values endpoint returns.
      values: sh.getDataRange().getDisplayValues(),
    };
  });

  return ContentService.createTextOutput(
    JSON.stringify({ sheets: sheets })
  ).setMimeType(ContentService.MimeType.JSON);
}
