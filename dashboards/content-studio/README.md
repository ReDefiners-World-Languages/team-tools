# Content Studio board

Single-file board for the ReDefiners marketing team (ideas, pipeline, calendar, content visits, content mix, monthly topics, document map).

- `index.html` holds the layout and code only. **No board content is stored in this repo.**
- After "Sign in with Google" (an @redefinerswl.org account), the page loads the board from a private Apps Script back end and saves edits back to it.
- `apps-script/` is that back end (`Code.gs`, `appsscript.json`). It checks the Google ID token on every request (signature, audience, domain) before returning or saving anything. The client id, domain and spreadsheet id are Script Properties, not code.
- Storage: only the tab **Board backup data** of the team's existing Content Matrix spreadsheet (columns collection | id | data | updated at | updated by, one row per item). The script never sorts, filters, inserts or deletes rows there, never writes past the tab's grid and never touches other tabs. Do not sort, filter or hand-edit the Board backup tabs.
- Until `SETTINGS.apiUrl` in `index.html` is filled with the deployed web app address, the page shows "Not connected yet".
- Presence (who is on the board) comes from the same back end: each open board sends a heartbeat about every 18 seconds, so joins and leaves show up within roughly 20 to 45 seconds. Nobody signed in means nobody is shown. `?presenceDemo=N` shows sample people for layout testing only.

Several editors: each save sends only the items that changed and the back end applies them one by one under a lock. Different items never overwrite each other; for the same item the later save wins. Pages reload the board when a newer revision exists and the person is not in the middle of an edit.

Matrix sync (`apps-script/Sync.gs`): an optional one-way copy from the board into the Content Matrix tabs (monthly topics, content mix, document map, and the synced calendar months). It is off until the Script Property `SYNC_ENABLED` is `true`, has a dry-run mode (`SYNC_DRY_RUN`), and runs from a one-minute trigger that is installed by hand (`installSyncTrigger`). Saves only mark which tabs are affected; the trigger does the matrix work under its own lease, skips unchanged tabs, and touches only rows that carry a Board ID. It never writes Due Date, never empties a hand-typed cell and never changes a Published or Cancelled status. The board leads: each board stage maps to one matrix Status and the matrix is never read back into the board. Undated cards go to the Ideas (no date) tab and move to their month's calendar when they get a date. Eight board-mirror tabs (Campaigns, Personas, Pillars, Owners, Classes, Visits, Topics, Board Settings) are rewritten to match the board; a mirror tab with a hand-typed row is skipped with an error.
