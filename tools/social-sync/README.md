# Social media data sync

Keeps `dashboards/social-media-analytics/data.json` current from the Google Sheet **ReDefiners_social_media_metrics**
(work copy, file id `1OyLZajKnk_J7kVUvpO1qUa4_kvWK7gZ4LiItuNN_BTw`). The sheet itself is filled by Paul (analytics-expert) in the
daily task `paul-social-media-daily-sync` (1 PM Eastern), so this sync runs after it. The dashboard loads `data.json` next to it.

`data.json` is public (GitHub Pages). It holds public post text and links, follower counts and aggregate demographics only.
Not synced: `LinkedIn_Competitors`, `LinkedIn_Visitors_*`, `TikTok_Viewers_Daily`, `TikTok_Overview_Daily`.

## Steps

1. **Fetch (Composio workbench).** Read each tab in full with `GOOGLESHEETS_VALUES_GET`, account `Work Sheets`, range = the tab name
   in single quotes (no start/end rows), `value_render_option='UNFORMATTED_VALUE'` (the formatted option turns 3.17 into "3,17").
   Tabs: `Posts_Unified`, `YouTube_Videos_Unified`, `YouTube_Channel_Snapshot`, `Facebook_Followers_Daily`, `Instagram_Followers_Daily`,
   `TikTok_Followers_Daily`, `LinkedIn_Followers_Daily`, `Instagram_Audience_Demographics`, `LinkedIn_Followers_Demographics`,
   `Best_Time_To_Post_Heatmap`. Save each as `/mnt/files/rawsoc/<tab>.json` (the `values` list), zip, `upload_local_file`, use the `s3_url`.
2. **Download and transform (local).**
   ```
   cd "/Users/lucas/Documents/Claude Code/team-tools" && git checkout main && git pull
   mkdir -p /tmp/soc-raw && curl -sL -o /tmp/soc.zip "<s3_url>" && unzip -q -o /tmp/soc.zip -d /tmp/soc-raw
   python3 tools/social-sync/transform.py /tmp/soc-raw dashboards/social-media-analytics/data.json --previous dashboards/social-media-analytics/data.json
   ```
   Exit code 2 means the pull looks wrong (missing/empty tab, a series shrank, or the newest Instagram/Facebook follower date went
   backwards). Stop, do not commit, report what the script printed.
3. **Publish.** If `git diff --quiet` shows no change in `data.json`, stop. Otherwise commit only that file and push to main.

## How the numbers are built

- Posts: every row of `Posts_Unified` per platform (titles whitespace-collapsed, cut to 200 characters) plus `YouTube_Videos_Unified`.
- Followers: the daily tabs as they are. LinkedIn's `Total_Followers_That_Day` is a daily gain, so a running total is rebuilt backwards from
  the follower total in `LinkedIn_Followers_Demographics` (sum of its Location rows). YouTube is a single snapshot. X has no data.
- Top locations: Instagram top 10 cities and LinkedIn top 10 locations as a share of the tab's total.
- Best times to post: score = a row's `Avg_Engagement_per_Post` divided by that platform's highest value, rounded to 4 decimals.
- "Last changed" dates (heatmap, demographics): the sheet has no per-tab edit date, so the script hashes each section and records the
  first day it saw different content (`sectionUpdated` in `data.json`). Needs `--previous` to keep the date from resetting.
- Running it twice on the same sheet gives an identical file, so an unchanged sheet makes no commit.
