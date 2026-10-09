# Marketing data sync

Keeps `dashboards/marketing-funnel-performance/data.json` current from the Google Sheet **Marketing_Unified_Database_Backend**
(work copy, file id `1Tq22vT4v6AIW0U7WIGq5hdrG0Af1pWhFJgBvRdGNxX4`). Runs on weekday mornings as a Claude scheduled task on Lucas's Mac.

`data.json` is public (GitHub Pages). `transform.py` only keeps fields the dashboard draws. It also removes any email address it finds in any text cell (a few GA4 "pages" are broken email links) before writing, and prints how many cells it cleaned. Never sync `Summer_STEAM_Feedback`
(parent names, emails and phone numbers), staff "Created By" names, free-text notes or subject lines.

## Steps

1. **Fetch (Composio workbench).** Read each tab in full with `GOOGLESHEETS_VALUES_GET` (range = the tab name in single quotes, no
   start/end rows: a bounded range is ignored and repeats rows). Tabs: `GA4_Executive_Overview`, `GA4_Traffic_Acquisition`,
   `GA4_Page_Engagement`, `GA4_Conversion_Attribution`, `GA4_Conversion_First_Touch`, `GA4_Conversion_Landing_Pairs`,
   `GA4_Landing_Page_Sessions`, `GA4_Funnel_Entry_To_Conversion`, `GA4_Funnel_Entry_To_Conversion_Daily`, `Paid Media`, `Email_Marketing_Data`, `In_Person_Outreach_Log`, `MCP_Enrollment_Data_SF`. Always pass `account="Work Sheets"` to `run_composio_tool` (two Google Sheets accounts are connected and the call fails without it). Save each as `/mnt/files/raw/<tab>.json` (the `values` list), zip them, call
   `upload_local_file`, and use the returned `s3_url`. Row counts on Oct 5, 2026: 180, 8184, 16905, 735, 313, 374, 1572, 510, 346, 423, 5674 (they only grow).
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

## Conversions tab (four tabs, written by Paul)

The Conversions tab shows what brought people to each conversion. It reads `GA4_Conversion_Attribution` (session view: channel, source / medium,
campaign, landing page), `GA4_Conversion_First_Touch` (first-ever touch, no landing page: GA4 has none), `GA4_Conversion_Landing_Pairs` (top 20
landing page and conversion pairs per week) and `GA4_Landing_Page_Sessions` (all sessions per landing page, the denominator for rates).
All are weekly, Monday to Sunday, complete weeks only (Paul appends the newest complete week; never the current partial one).
- **Tab names and headers belong to Paul.** `transform.py` looks columns up by header name, so a rename on the sheet breaks the sync and the
  dashboard. Route any rename through Lucas Blanco first.
- **Public file, so no query strings.** Landing pages are stored as path only. The source tabs hold query strings with tracking IDs
  (`_hsenc`, `hsa_acc`, `fbclid`). The Host column and the pairs tab's Sessions column are not carried either (see the comments in `transform.py`).
- `Channel (adjusted)` is Paul's rule (Peachjar, Flyer and chatgpt.com are shown by source, not left in Referral or Unassigned). The raw GA4
  channel is kept in `data.json` as `rawChannel` but the dashboard does not show it.
- `GA4_Isolated_Conversions` is **no longer synced**; the tab stays in the sheet. The dashboard has no use for it any more.
- Dashboard settings for this tab live in the `CONV_*` constants at the top of its block in `index.html`: the conversion list and labels
  (`CONV_EVENTS`), the tracking-gap lines (`CONV_GAP_THRESHOLD_SESSION` = 30, final; `CONV_GAP_THRESHOLD_FIRST_TOUCH` = 40, provisional) and
  the low-volume greying (`CONV_LOW_VOLUME_MIN` = 10, provisional).

## Funnel and course view (two more tabs, written by Paul)

`GA4_Funnel_Entry_To_Conversion` (weekly) and `GA4_Funnel_Entry_To_Conversion_Daily` (last 90 complete days, through yesterday) give, per entry page:
Sessions, Sessions Reaching Portal and Sessions With MCP Registration. `data.json` carries them as `date, landingPage, sessions, reachedPortal, registered`.
- Weekly rows are the top 50 pages per week plus any page with a portal visit or registration, so **column sums are not the site total**. The daily tab runs 2-3% above the weekly one.
- The daily tab is not weekly although its name starts with `GA4_`: `transform.py` (`DAILY_TABS`) keeps it out of the partial-week drop and the weekly anchor rule, and the page does the same.
- Both tabs are optional in `transform.py` (`OPTIONAL_TABS`): a pull without them still writes `data.json` and the page says the funnel is not synced yet. Add them to the fetch list in step 1.
- The Conversions tab uses the daily tab for "Last 7 days" and "This week so far", and the weekly tab for every other range. Course groupings (`CONV_COURSES`, `CONV_ADULT_PAGES`) are in `index.html`.
- Course registrations come from `MCP_Enrollment_Data_SF` (Salesforce), never from Google Analytics, and are shown without instructor names.

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
