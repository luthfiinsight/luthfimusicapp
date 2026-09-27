# Luthfi Music Web App

A dark, Apple Music-styled web music player: local files + Google Drive library,
real ID3 tag editing with online cover search, playlists, and installable PWA.

## 1. Run it locally first
Any static file server works — from this folder:
```bash
python3 -m http.server 8080
```
Then open `http://localhost:8080`. (Opening `index.html` directly with `file://`
will break the service worker and Google sign-in — always serve it over http/https.)

## 2. Set up Google Drive (required for the Drive features)
I can't create these for you — they're tied to your own Google account and billing/quota:

1. Go to https://console.cloud.google.com/ and create a project (or reuse one).
2. **APIs & Services → Library**: enable **Google Drive API** and **Google Picker API**.
3. **APIs & Services → OAuth consent screen**: set it to "External", add your own
   Google account as a **Test user** (this keeps it free and avoids Google's review,
   since it's just for your personal use).
4. **APIs & Services → Credentials**:
   - Create an **API key** (restrict it to the Drive API + Picker API if you want).
   - Create an **OAuth Client ID** of type "Web application". Add the exact URL
     you'll host the app on (e.g. `http://localhost:8080` while testing, and your
     real HTTPS domain later) to **Authorized JavaScript origins**.
5. In the app, go to **Settings**, paste the Client ID and API key, save.
6. Go to **Google Drive** in the sidebar → **Connect Account** → **Choose Folder**.

The Drive scope requested is broad (`.../auth/drive`) because the Tag Editor writes
corrected audio back into your existing files — a narrower `drive.file` scope only
allows editing files the app itself created, which wouldn't cover your existing library.

## 3. Deploy it somewhere real (for PWA install + phone access)
Any static HTTPS host works, e.g. **GitHub Pages**, **Netlify**, **Vercel**, or
Firebase Hosting — drag-and-drop this whole folder. Then add that HTTPS URL to your
OAuth Client's Authorized Origins (step 4 above) too.

## What's genuinely implemented (not mocked)
- Local file import with real ID3 parsing (title/artist/album/cover) via `jsmediatags`.
- ID3 tag **writing** via `browser-id3-writer` — actually rewrites the file's bytes.
  - Local files: overwritten in place via the File System Access API on Chrome/Edge
    desktop; other browsers get a corrected file downloaded for you to swap in
    manually (browsers don't allow silent overwrites of arbitrary local files —
    that's a security boundary, not a bug).
  - Drive files: the corrected audio is re-uploaded to the same Drive file.
- Cover art search via the free iTunes Search API (no key needed). Embedding the
  chosen cover into the file only works if that image host allows cross-origin
  fetches; when it doesn't, the app tells you and you can use "Upload" instead.
- Google Drive: OAuth connect, a real folder picker (Google Picker), manual "Sync
  Now", and optional polling ("Auto-check for new files") every 45s while the tab
  is open — this is a genuine Drive API call, not a webhook. True push notifications
  from Drive require a public server endpoint, which a static site doesn't have.
- Playlists, queue, shuffle/repeat, search, "Recently Played" and "last track"
  memory — all stored in IndexedDB in your browser.
- Installable PWA (manifest + service worker), Media Session API for lock-screen /
  hardware media-key controls.

## What I deliberately did not build
- **A YouTube Music / Spotify downloader.** Extracting audio from either service
  breaks their Terms of Service and copyright law. That's true regardless of intent,
  so it's not something I'll build even for personal/offline use. The **Import
  Audio** tab instead lets you pull in any file you already have rights to (a direct
  URL you control, or local upload) and it joins your library and Drive sync
  automatically.

## Honest limitations to know about
- **Background playback with the screen off** depends on the OS/browser, not just
  this app's code. Installed as a PWA on Android/desktop Chrome, audio generally
  keeps playing with the screen off and shows lock-screen controls (via Media
  Session). iOS Safari/PWA is more restrictive about backgrounded tabs — there's no
  web API that can force iOS to keep an unfocused page's audio alive beyond what
  Apple allows.
- Local files can't be "remembered" as live file handles across a browser restart
  the way Drive files can (browsers don't allow persistent raw filesystem access
  without you re-granting it) — this app instead stores the actual file bytes in
  IndexedDB, so your local library does survive reloads, just via a copy rather
  than a live link to the original file on disk.
- The Drive scope used is sensitive enough that Google will nag you about "unverified
  app" until you either keep your own account as a Test User (fine for personal use,
  as above) or go through Google's verification process (only needed if you plan to
  let other people use this with their own Drive accounts).
