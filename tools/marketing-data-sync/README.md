# Marketing data sync

Keeps `dashboards/marketing-funnel-performance/data.json` current from the Google Sheet **Marketing_Unified_Database_Backend**
(work copy, file id `1Tq22vT4v6AIW0U7WIGq5hdrG0Af1pWhFJgBvRdGNxX4`). Runs on weekday mornings as a Claude scheduled task on Lucas's Mac.

`data.json` is public (GitHub Pages). `transform.py` only keeps fields the dashboard draws. Never sync `Summer_STEAM_Feedback`
(parent names, emails and phone numbers), staff "Created By" names, free-text notes or subject lines.

## Steps

1. **Fetch (Composio workbench).** Read each tab in full with `GOOGLESHEETS_VALUES_GET` (range = the tab name in single quotes, no
   start/end rows: a bounded range is ignored and repeats rows). Tabs: `GA4_Executive_Overview`, `GA4_Traffic_Acquisition`,
   `GA4_Page_Engagement`, `GA4_Isolated_Conversions`, `Paid Media`, `Email_Marketing_Data`, `In_Person_Outreach_Log`,
   `MCP_Enrollment_Data`. Save each as `/mnt/files/raw/<tab>.json` (the `values` list), zip them, call
   `upload_local_file`, and use the returned `s3_url`. Row counts to expect today: 177, 7955, 16546, 882, 48, 344, 398, 5463.
   The Drive connector truncates big tabs; do not use it for this.
2. **Download and transform (local).**
   ```
   cd "/Users/lucas/Documents/Claude Code/team-tools" && git checkout main && git pull
   mkdir -p /tmp/mkt-raw && curl -sL -o /tmp/mkt-raw.zip "<s3_url>" && unzip -q -o /tmp/mkt-raw.zip -d /tmp/mkt-raw
   python3 tools/marketing-data-sync/transform.py /tmp/mkt-raw dashboards/marketing-funnel-performance/data.json --previous dashboards/marketing-funnel-performance/data.json
   ```
   Exit code 2 means the pull looked wrong (a tab shrank by more than 30% or the newest GA week went backwards). Stop, do not commit,
   and tell Lucas what the script printed.
3. **Publish.** If `git diff --quiet` shows no change in `data.json`, stop. Otherwise commit only that file
   (`Sync marketing data YYYY-MM-DD`) and `git push origin main`.

The transform drops the newest GA week when it is under 35% of the recent median (a mid-week pull) and records it in
`partialWeekDropped`; the dashboard says so in its footer.
