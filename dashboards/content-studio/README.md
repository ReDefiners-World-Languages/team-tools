# Content Studio board

Single-file board for the ReDefiners marketing team (ideas, pipeline, calendar, content visits, content mix, monthly topics, document map).

- `index.html` holds the layout and code only. **No board content is stored in this repo.**
- After "Sign in with Google" (an @redefinerswl.org account), the page loads the board from a private Apps Script back end and saves edits back to it automatically. Until `SETTINGS.apiUrl` in `index.html` is filled with the deployed web app address, the page shows "Not connected yet".
- Dropdown values (formats, platforms, stages, kinds, document levels and statuses and so on) come from the **Lists** tab of the board's workbook and are sent with the board, so the page and the workbook always agree.

## Where the data lives (two layers, one direction)

1. **Board store.** The master copy is one tab of the team's private workbook, one row per board item (the item as JSON). The board loads from it and every save writes to it first, under a script lock, with a revision number. Two people editing different items never overwrite each other; for the same item the later save wins. Pages reload the board when a newer revision exists and the person is not in the middle of an edit.
2. **Typed tables.** The same data is mirrored, one way, into the workbook's typed tables (cards, card links, card notes, topics, months, themes, campaigns, pillars, personas, people, documents, classes, visits, visit shots, settings): typed dates, times and percents, month keys as text, several values in one cell separated by a comma and a space. A one-minute trigger writes only the items that changed since the last run, by id, and skips rows that are already equal. **Nothing in a table is ever read back into the board.** A hand edit in a table is overwritten the next time that item is saved on the board. The only way table data enters the store is a one-time (or on-request) import that is run by hand from the script editor.

Values that are not in the Lists tab, text with a comma where the tables keep several values in one cell, and items too large for one cell are refused at save time with a clear message and are not written.

`apps-script/` is the back end:

| File | What it holds |
|------|---------------|
| `Code.gs` | Web app, Google ID token check (signature, audience, domain), the Board store, saves, validation against Lists, presence, `setup()` |
| `Codec.gs` | The typed tables (tab names, headers, types) and the conversion between board items and table rows |
| `TableSync.gs` | The one-way mirror: dirty list, one-minute trigger, `syncNow`, `verifyStoreAgainstTables`, `fullSyncToTablesDryRun`, `fullSyncToTables` |
| `Import.gs` | `importFromTables`, `importFromTablesReplace` (editor only, never reachable from the web) |
| `SalesforceClasses.gs` | Daily class-level pull from Salesforce into the board's classes (JWT Bearer login, dry run, daily trigger in Eastern time) |
| `appsscript.json` | Manifest |
| `deprecated/Sync.gs.txt` | The first design (copy into the Content Matrix). Not used, not part of the project, kept for reference |
| `tests/` | Node tests with a fake workbook and a stubbed Salesforce API, and a local mock back end for browser tests |

The OAuth client id, the staff domain, the workbook id and the Salesforce credentials are Script Properties, never code. The workbook id and the setup steps live in the team's private setup guide.

## Presence

Each open board sends a heartbeat about every 18 seconds. The back end keeps who called in the last 45 seconds in the script cache and never touches a spreadsheet for it, so joins and leaves show up within roughly 20 to 45 seconds. Nobody signed in means nobody is shown. `?presenceDemo=N` shows sample people for layout testing only.

## Classes from Salesforce

Class-level data only (name, program, site, day, time, end date, enrolled, attendance percent and number of attendance records). No student, parent or teacher names, emails or phone numbers are read, stored or logged, and no Salesforce id is kept. The script writes to the Board store, so the same one-way mirror fills the Classes table, and the board shows classes read-only. Days follow the workbook: 1 = Monday to 7 = Sunday.

## Tests

```
node --test dashboards/content-studio/apps-script/tests/*.test.js
```

The tests run the real `.gs` files in Node against a fake workbook built from the real tab names, headers, formats and capacities (including the Sheets behaviour that turns `2026-11` into a date unless the cell is formatted as text). They cannot test real Google sign-in, the real Sheets and Apps Script runtime, quotas, deployment or real Salesforce.

`node dashboards/content-studio/apps-script/tests/mock-server.js 8765` serves the page and answers its API with the real back end code on the fake workbook, for browser checks at phone, tablet and desktop widths (`/reset?data=empty` or `/reset?data=loaded` switches the data).
