# Canvas Sticky

A small always-on-top note for your desktop that pulls your Canvas LMS assignments and shows what's due, soonest first.

- Your active courses, with the course code on every item
- Every unsubmitted assignment, quiz, and graded discussion due in the next 30 days
- A one-line summary of each task, taken from the assignment's own description
- Sorted strictly by nearest deadline, with overdue work pinned at the top in red
- Anything you've already submitted is hidden automatically

Read-only. It never writes anything back to Canvas.

## Setup

```bash
npm install
```

### Get an access token

1. Log in to Canvas in your browser.
2. Go to **Account → Settings**.
3. Scroll to **Approved Integrations** and click **+ New Access Token**.
4. Purpose: `Canvas Sticky`. Leave the expiry blank for a token that doesn't expire, or set a date.
5. Click **Generate Token** and copy it. **Canvas shows the token only once** — if you lose it, delete that entry and make a new one.

### Run it

```bash
npm start
```

On first launch the note asks for two things:

- **Canvas address** — e.g. `yourschool.instructure.com` (pasting a full URL is fine, it gets trimmed)
- **Access token** — the string you copied above

Click **Connect**. The token is checked against Canvas immediately, so a typo shows up right away instead of as a mysteriously empty note.

## Where your token is stored

`%APPDATA%\canvas-sticky\config.json`, encrypted with Electron's `safeStorage`, which on Windows is DPAPI tied to your Windows user account. Another account on the same machine cannot decrypt it.

That path is deliberately outside this project folder, so the token can never be swept into a commit. `.gitignore` also covers `.env` and `config.json` as a second line of defence.

To remove it: **Settings → Remove token from this computer**, which deletes the config and the cached task list. Revoking the token itself is done in Canvas, under the same Approved Integrations page.

## Using the note

| Action | How |
|---|---|
| Move it | Drag the yellow header strip |
| Resize | Drag any edge |
| Show / hide | `Ctrl+Shift+C`, or click the tray icon |
| Hide | The `—` button, or `Esc` |
| Refresh | The ↻ button, `F5`, or the tray menu (it also auto-refreshes every 15 minutes) |
| Expand a task | Click it — shows the full description and an **Open in Canvas** link |
| Filter to one course | The dropdown in the header |
| Quit properly | Right-click the tray icon → **Quit Canvas Sticky** |

Closing the window hides it to the tray rather than quitting, so it stays out of your way but is one keystroke away.

**Start with Windows** is a checkbox in Settings.

## How it decides what to show

Canvas is asked for each course's `upcoming` and `overdue` assignment buckets. Both are needed — `upcoming` alone covers only work due in the future, so overdue items would be invisible.

An item is shown when it is published, not yet submitted (Canvas's own submission record decides this), and due between 14 days ago and 30 days from now. Undated work is kept but sorts to the bottom.

Colour bands: **red** overdue · **orange** under 24h · **amber** under 3 days · **blue** under a week · **grey** beyond.

## If something goes wrong

| Message | Cause |
|---|---|
| "Canvas rejected the access token" | Token expired or was revoked. Generate a new one and paste it in Settings. |
| "Canvas endpoint not found" | The Canvas address is wrong — check the hostname. |
| "Could not reach Canvas" | No network. The note keeps showing the last data it fetched and says how old it is. |
| "Canvas is rate limiting requests" | Too many refreshes. Wait a minute; the cached list stays on screen. |

## Notes

- Requires Node 18+ (uses the built-in `fetch`). Built and tested on Node 24.
- All Canvas calls happen in Electron's main process. This is required — the Canvas API sends no CORS headers, so a browser page cannot call it — and it also means the token never enters the page context.
- The UI has no Node access (`contextIsolation`, `sandbox`, no `nodeIntegration`), and all assignment text is inserted as text rather than HTML, since descriptions are authored by other people.
