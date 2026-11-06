# Content Studio board

Single-file board for the ReDefiners marketing team (ideas, pipeline, calendar, content visits, content mix, monthly topics, document map).

- `index.html` holds the layout and code only. **No board content is stored in this repo.**
- After "Sign in with Google" (an @redefinerswl.org account), the page loads the board from a private Apps Script back end and saves edits back to it.
- `apps-script/` is that back end (`Code.gs`, `appsscript.json`). It checks the Google ID token on every request (signature, audience, domain) before returning or saving anything. The client id, domain and spreadsheet id are Script Properties, not code.
- Storage: only the tab **Board backup data** of the team's existing Content Matrix spreadsheet (columns collection | id | data | updated at | updated by, one row per item). The script never sorts, filters, inserts or deletes rows there, never writes past the tab's grid and never touches other tabs. Do not sort, filter or hand-edit the Board backup tabs.
- Until `SETTINGS.apiUrl` in `index.html` is filled with the deployed web app address, the page shows "Not connected yet".
- Presence (who is on the board) comes from the same back end: each open board sends a heartbeat about every 18 seconds, so joins and leaves show up within roughly 20 to 45 seconds. Nobody signed in means nobody is shown. `?presenceDemo=N` shows sample people for layout testing only.

Several editors: each save sends only the items that changed and the back end applies them one by one under a lock. Different items never overwrite each other; for the same item the later save wins. Pages reload the board when a newer revision exists and the person is not in the middle of an edit.
