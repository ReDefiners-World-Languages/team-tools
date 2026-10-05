# Marketing data sync

Keeps `dashboards/marketing-funnel-performance/data.json` current from the Google Sheet **Marketing_Unified_Database_Backend**
(work copy, file id `1Tq22vT4v6AIW0U7WIGq5hdrG0Af1pWhFJgBvRdGNxX4`). Runs on weekday mornings as a Claude scheduled task on Lucas's Mac.

`data.json` is public (GitHub Pages). `transform.py` only keeps fields the dashboard draws. It also removes any email address it finds in any text cell (a few GA4 "pages" are broken email links) before writing, and prints how many cells it cleaned. Never sync `Summer_STEAM_Feedback`
(parent names, emails and phone numbers), staff "Created By" names, free-text notes or subject lines.

## Steps

1. **Fetch (Composio workbench).** Read each tab in full with `GOOGLESHEETS_VALUES_GET` (range = the tab name in single quotes, no
   start/end rows: a bounded range is ignored and repeats rows). Tabs: `GA4_Executive_Overview`, `GA4_Traffic_Acquisition`,
   `GA4_Page_Engagement`, `GA4_Isolated_Conversions`, `Paid Media`, `Email_Marketing_Data`, `In_Person_Outreach_Log`,
   `MCP_Enrollment_Data_SF`. Always pass `account="Work Sheets"` to `run_composio_tool` (two Google Sheets accounts are connected and the call fails without it). Save each as `/mnt/files/raw/<tab>.json` (the `values` list), zip them, call
   `upload_local_file`, and use the returned `s3_url`. Row counts on Sep 30, 2026: 180, 8130, 16818, 887, 48, 344, 398, 5608 (they only grow).
   The Drive connector truncates big tabs; do not use it for this.
2. **Download and transform (local).**
   ```
   cd "/Users/lucas/Documents/Claude Code/team-tools" && git checkout main && git pull
   mkdir -p /tmp/mkt-raw && curl -sL -o /tmp/mkt-raw.zip "<s3_url>" && unzip -q -o /tmp/mkt-raw.zip -d /tmp/mkt-raw
   python3 tools/marketing-data-sync/transform.py /tmp/mkt-raw dashboards/marketing-funnel-performance/data.json --previous dashboards/marketing-funnel-performance/data.json --mcp-tab MCP_Enrollment_Data_SF
   ```
   Exit code 2 means the pull looked wrong (a tab shrank by more than 30% or the newest GA week went backwards). Stop, do not commit,
   and tell Lucas what the script printed.
3. **Publish.** If `git diff --quiet` shows no change in `data.json`, stop. Otherwise commit only that file
   (`Sync marketing data YYYY-MM-DD`) and `git push origin main`.

The transform drops the newest GA week when it is under 35% of the recent median (a mid-week pull) and records it in
`partialWeekDropped`; the dashboard says so in its footer.

## Enrollment tab

The Enrollments view reads `MCP_Enrollment_Data_SF`, which refreshes from Salesforce every 4 hours and has a `Class: Fiscal Year`
column. On Sep 30, 2026 it held 5,607 rows, FY22-23 to FY26-27. (Earlier that day it was capped at 2,000 rows and the shrink check
refused it.) The older export tab `MCP_Enrollment_Data` is no longer used and can be deleted.

## Email tab dates

`Email_Marketing_Data` has a `Delivery Date` column (S) that is filled on every row since 2026-10-02. The dashboard filters, sorts and
labels emails by it, not by `Created Date`.
- **One-off emails** (`BATCH`, `BATCH (localtime)`, `AB`): Delivery Date is the real send date (HubSpot `hs_publish_date`, New York date).
- **Automated emails** (`AUTOMATED`): Delivery Date is the HubSpot activation (last publish) date, not a send date, because automated
  emails send continuously. Their Notes cell says so. The transform records this as `dateKind` (`sent`, `activated`, or `created` when
  Delivery Date is blank or the column is missing) and the dashboard shows "Sent", "Activated" or "Created" in front of each date.
  In a short window an automated email only appears if it was activated in that window.
- Do not rely on row order in the sheet (batch emails first, automated block last). The transform and dashboard sort by date.
- The Notes column is free text and is not synced.

## Date window and comparisons

The dashboard's range buttons (last 7 days, 30 days, and so on) count back from the newest data in **any** tab, capped at today.
Weekly tabs (GA4, Paid Media) count to the end of their newest week. The newest tab is therefore never cut off, even when another
tab lags a week or two behind. `anchorDate` in `data.json` records the same rule; the page recomputes it from `latest`.

Period-over-period badges for weekly data compare the weeks present in the window with the **same number of weeks** right
before the earliest of them (for example "vs. previous 3 weeks"), so a lagging tab is not read as a drop. Daily or event data
(email, outreach) compares with the same-length calendar window before.
