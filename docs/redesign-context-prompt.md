# Canvas Sticky — UI/UX redesign context

Paste this whole document into a fresh Claude chat as context, then ask it to design mockups.

## What it is

"Canvas Sticky" is a Windows desktop app (Electron) — a small, always-on-top sticky note that shows a student's Canvas LMS assignments sorted by due date, with an optional AI chat assistant. It is NOT a website or mobile app — it's a native-feeling floating widget, frameless (no OS title bar), that the user drags around their desktop and leaves open alongside other windows.

## Physical constraints (important for mockups)

- Default size **360×540px**, resizable, minimum **300×260px**. Design should work down to the minimum and not assume a wide viewport — think "large sticky note / small widget," not "webpage" or "app window."
- Frameless: there is no OS-drawn title bar. The app draws its own header, including its own window controls (minimize/maximize/close).
- Always-on-top, no taskbar icon — it hides to the system tray rather than closing.
- Rounded corners, drop shadow, floats directly over the desktop/other windows.

## Current visual style (starting point, open to change)

- "Paper note" metaphor: warm cream/parchment background (`#fdf6e3`) in light mode, dark slate (`#242a38`) in dark mode.
- Header is a gradient banner using Canvas LMS's own real brand slate color (`#394b58` → `#5f7789`), meant to evoke the real Canvas nav bar.
- Small, dense UI typography (9–13px), Segoe UI / system font.
- Urgency color-coding: red (overdue) → orange (<24h) → amber (<3 days) → blue (<7 days) → grey (later), shown as a left-edge color bar on each task card plus a colored due-date pill.
- Course-code chips inherit each course's actual color from the user's real Canvas account (fetched via the Canvas API's `/users/self/colors`).
- Course cards show a very faint version of that course's own Canvas banner image behind just the card's header row (title/tags), not the description.
- Dark/light theme toggle (sun/moon icon), otherwise follows the Windows system theme automatically.

## Screens / states to design

1. **First-run / setup** — paste Canvas URL + access token, with an inline numbered "how to get a token" guide.
2. **Main list view** (the primary/default screen) — header (app name, refresh, window controls, theme toggle, settings gear, course filter dropdown, due-count badge, last-refreshed timestamp) + a scrolling list of task cards. Each card: course chip, due-date pill, title, points + individual/group tags, one-line AI-written summary. Clicking a card expands it into a bulleted breakdown + "Open in Canvas" link.
3. **Empty state** — nothing due.
4. **Settings** — Canvas credentials, favorites-only toggle, launch-on-login, sign out, and a separate "AI summaries" section for an optional Gemini API key (with its own inline "how to get a free key" guide).
5. **AI chat popup** — a small floating panel (not full-screen) anchored above a chat-bubble launcher icon in the note's own corner, with its own header (title, a usage-quota ring, close button), a scrolling message thread (user bubbles vs. assistant bubbles, suggested-prompt chips when empty), and an input row. Assistant replies can contain **bold** text and clickable links (e.g. a class's Zoom link).
6. Loading/refreshing, offline/error, and rate-limited states — currently a small dismissible footer notice bar.

## What the AI assistant actually knows (for chat-UI mockups)

Courses, current grades, pending assignments (with due dates, points, individual/group, instructor feedback), the course module/content outline, and recent announcements — all read-only from the student's own Canvas account. It never modifies anything in Canvas. Data privacy matters a lot here: everything stays between the user's machine, their own Canvas login, and (only if they opt in) their own Gemini API key — no backend server, no third-party analytics.

## Redesign goals / open questions to hand to Claude

Feel free to have Claude ask clarifying questions, but here's what's been in flux and worth exploring:
- Whether the "paper note" skeuomorphic metaphor should stay, or move to a flatter/more modern widget look.
- How to make the due-count / status row at the top feel more polished (it currently reads as an afterthought).
- Better visual hierarchy between overdue/urgent items vs. everything else — right now it's mostly a colored bar + colored pill.
- How prominent the AI chat entry point should be without it looking bolted-on.
- Whether per-course color/imagery (the Canvas-color chip, the faint banner image) should play a bigger or smaller role in the card design.
- Good use of the very limited vertical space — this is a small widget users will glance at often, not stare at.
