# ReDefiners Media Library page

A page where staff file class and program photos and videos into the ReDefiners Media Library in Google Drive, with context, and later find them again.

Everything needs a sign-in with an @redefinerswl.org Google account (decided 2026-10-22). The uploader's name and email come from that sign-in.

- **Add media**: pick the destination (Program, Course, Sub course where the course has them, Site), drop the files, say what they show, confirm. Files go straight from the browser to Drive with resumable uploads.
- **Find media**: search (file names, folder path and context text) with filters, or browse the folders.

Spec: `Executive Assistant/Media Library Spec for Ringo.md`. Folder rules: the `redefiners-asset-filing` skill (it wins if the two disagree).

## How it works

```
Browser (this page, GitHub Pages)
  |  1. config / startUpload / finishUpload / search / browse / thumbnail  (JSON over POST)
  v
Apps Script web app (runs as the Drive owner, always on, Google's cloud)
  |  checks the Google sign-in on every call (@redefinerswl.org only)
  |  checks every choice against the lists, finds or creates the folders,
  |  picks a free file name, opens a resumable upload session in Drive
  v
Google Drive  <---- 2. the browser sends the file bytes here directly, 8 MB at a time
```

- Nothing runs on a laptop. No Drive for desktop, no routines.
- The page never receives a Drive access token. For each file it gets a one-time upload address for that file only.
- Nothing is deleted, overwritten, renamed or shared. A name that already exists in the folder gets `name (2).jpg`, `name (3).jpg`, ...
- Folders are created only when a file goes in, and only after looking for an existing folder with the exact same name.
- Context and the uploader (from the sign-in) are saved in the Drive file description (readable in Drive, searchable) and in the `Upload Log` tab of the admin sheet. Each file also carries properties (program, course, site, year, month, type) used by the search filters.
- A dropped connection picks up where it stopped. If the page is reloaded, adding the same file again with the same destination (same month) continues the same upload.
- Files that were in Drive before this page existed have no context or properties: they show under **Browse folders**, not in search filters.

## Files

| File | What it is |
|---|---|
| `index.html` | The page. Two settings at the top: `apiUrl` and `googleClientId`. |
| `preview-mock.js` | Preview mode only (when `apiUrl` is empty or the address has `?preview=1`). Fakes the back end; nothing is uploaded. |
| `apps-script/Code.gs` | The API. |
| `apps-script/Setup.gs` | `setup()` creates the admin sheet; `refreshConfig()`; `checkMcpSites()`. |
| `apps-script/Defaults.gs` | Starting lists (copied into the admin sheet once). No folder ids: those live in script properties and the admin sheet. |
| `apps-script/appsscript.json` | Manifest: Drive, Sheets and external-request scopes; web app runs as the owner, open to anyone. |

## Admin sheet (the one editable configuration)

`setup()` creates **ReDefiners Media Library Admin** in the owner's My Drive (move it anywhere; the id stays the same).

| Tab | Holds |
|---|---|
| `Collections` | One row per destination: id, label, Drive root folder id, path pattern, context fields, Active. |
| `Steps` | The picker steps per collection, their order, which step each one depends on, and the folder used for **Other** (empty = no Other). |
| `Options` | Every allowed value: collection, step, parent value, value. A name not in this tab cannot be chosen. |
| `Upload Log` | One row per uploaded file: when, where, names, size, type and the context. |

Edits show up within 5 minutes (or run `refreshConfig()`).

- **New MCP site**: add a row in `Options` (`classes`, `site`, `MCP`, the name). `checkMcpSites()` lists sheet sites whose name no longer appears on https://redefinerswl.org/learn-in-florida.
- **New GEP site**: add a row (`classes`, `site`, `GEP`, the cohort name) from the Salesforce GEP program cohorts.
- **New collection (for example Events)**: one row in `Collections` (root folder id, path like `{event}/{year}/{month}`, context fields), its rows in `Steps` and `Options`. No code change. `{year}` and `{month}` are filled from the upload date; any other `{step}` comes from the picker.

Context fields available: `what` (required), `date`, `staff`, `notes`. The uploader is always taken from the sign-in. The "which site or class do you think this is?" note appears by itself when someone picks Other on a step marked `Ask Note When Other`.

## Deploy (once, by the owner of the Media Library folders)

Nothing below has been done yet. Each step is in the Google account that owns the Media Library folders.

1. **Apps Script project.** script.google.com > New project, named `ReDefiners Media Library API`, signed in as the owner of the Media Library folders. Project Settings > tick "Show appsscript.json". Paste the four files from `apps-script/` (same names).
2. **Folder id.** Project Settings > Script properties > add `CLASSES_ROOT_FOLDER_ID` = the id of the `Classes and Programs` folder (the last part of its Drive address). It is kept out of this public repo on purpose.
3. **Run `setup()`** once from the editor and accept the permissions. The log prints the admin sheet address.
4. **Sign-in client (free, no billing).** console.cloud.google.com > create a project (for example `redefiners-media-library`) > Google Auth Platform / OAuth consent screen: **Internal** > Clients > Create client > Web application > Authorized JavaScript origin `https://redefiners-world-languages.github.io`. Copy the client id.
5. **Script properties** (Project Settings > Script properties): `GOOGLE_CLIENT_ID` = that client id. `setup()` already set `STAFF_DOMAIN` = `redefinerswl.org`, `ALLOWED_ORIGINS` = `https://redefiners-world-languages.github.io`, `MAX_FILE_GB` = `10`.
6. **Deploy** > New deployment > Web app > Execute as: Me > Who has access: Anyone. (Google does not limit this to staff itself; the script refuses every call without a staff sign-in.) Copy the `/exec` address. (If "Anyone" is not offered, the Workspace admin setting for Apps Script web apps blocks it.)
7. Put the `/exec` address and the client id in `SETTINGS` at the top of `index.html`, merge, and the page is live at `https://redefiners-world-languages.github.io/team-tools/tools/media-library/`.

After a code change in Apps Script: Deploy > Manage deployments > edit > New version (the address stays the same).

## First live test (before anyone else gets the link)

These parts can only be proven against real Google services:

1. Upload a small photo. Check that it lands in the right folder with its description, and that `Upload Log` has the row.
2. Upload a large video and switch the Wi-Fi off half way, then back on: it must continue, not restart. (This depends on Drive answering the browser's upload requests from the page's address; the session is opened with that address so it should, but it has to be seen working.)
3. Upload the same file twice: the second one is `name (2).ext`.
4. Pick Other for site and sub course: files go to `Unknown Course/Site Unknown`.
5. In a private window, open the page: nothing can be added or seen until you sign in with a redefinerswl.org account; a personal Gmail account is refused.
6. Check that the Upload Log and the file description show your name and email from the sign-in.
7. Search for a word you typed in "What happened".
8. In Drive, check that the files and folders are still private (owner only, nothing shared).

## Preview

Serve the folder (for example `python3 -m http.server`) and open `index.html`. With `apiUrl` empty the page runs in preview mode (a "Preview" badge and a fake sign-in button). A file whose name contains `drop` loses its connection once at about half way, to show the resume.
