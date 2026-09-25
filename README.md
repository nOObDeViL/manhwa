# Manhwa Recap Studio Cloud

This is a **serverless, browser-only** studio for making manhwa recap videos. Nothing needs to be installed on your
computer. You deploy it once to Vercel or Netlify, then open it on your MacBook, tablet or phone.

```
Discover (AniList) ─► Project folder in Drive ─► Slice .cbz into panels ─► Gemini script
       ─► ElevenLabs / Google TTS narration ─► Ken Burns + FFmpeg.wasm ─► MP4 in Drive
```

| Module | How it runs without a backend |
| --- | --- |
| Google Drive storage | Drive v3 REST API with OAuth 2.0 (Google Identity Services token popup). `project.json` in each project folder acts as the database. |
| Discovery | AniList GraphQL (free, no key), Korean-origin manga = manhwa, trending, popular, search, genres, recommendations. |
| Script generator | `@google/genai` called from the browser with your free Gemini key. An OpenAI-compatible fallback engine is also available (Groq, OpenRouter…). Output is numbered beats, saved as `.json` and `.txt`. |
| Panel slicer | `jszip` extracts `.cbz` and `.zip` files. Pages are treated as one continuous strip on a hidden `<canvas>`. Row-by-row pixel analysis finds white, black or flat-colour gutters and cuts panels, even ones that span two image files. |
| Voice | A ~40-line **edge function** (`/api/tts`) calls ElevenLabs or Google Cloud TTS. You can also call the provider directly from the browser. Clips are stitched with the **Web Audio API** and encoded to MP3 with FFmpeg.wasm. |
| Video | The Ken Burns effect (zoom-in, zoom-out, pan down or up, crossfades, blurred backdrop) is drawn on a canvas. Frames are fed to **FFmpeg.wasm** (H.264 + AAC) in small chunks so memory stays flat. The finished file is uploaded to **Final Exports**. |

## Drive layout

```
My Drive/
└── Manhwa Recap Studio/
    └── Projects/
        └── Solo Leveling/
            ├── project.json        ← metadata, panel order, effect overrides
            ├── Source/             ← your .cbz / .zip / page images
            ├── Scripts/            ← script_*.json + script_*.txt
            ├── Sliced Panels/      ← panel_0001.jpg …
            ├── Audio/              ← narration_*.mp3 + narration_*.timeline.json
            └── Final Exports/      ← *_recap_1920x1080_*.mp4
```

---

## 1. Google Cloud setup (≈10 minutes)

Follow **[docs/GOOGLE_CLOUD_SETUP.md](docs/GOOGLE_CLOUD_SETUP.md)**. You'll end up with:

- an **OAuth Client ID** (required)
- a **Gemini API key** (required for scripts)
- an **ElevenLabs** key *or* a **Google TTS** API key (for narration)

You'll add your deployed URL to the OAuth client's *Authorized JavaScript origins* in step 3 below.

## 2. Deploy without installing anything

### Put the code on GitHub (web upload)

1. Create a free account at <https://github.com>, then **New repository**. Choose **Private** (recommended, because it
   contains your Drive account email as a default setting). Tick "Add a README" so the repo isn't empty.
2. In the repo, choose **Add file → Upload files**, then drag the **contents** of the `manhwa-recap-studio` folder into
   the page (`src/`, `docs/`, `public/`, `package.json`, …). Chrome and Edge keep the folder structure when you drag folders.
   **Commit changes**.

### Option A: Vercel (recommended)

1. Go to <https://vercel.com>, sign in with GitHub, then **Add New… → Project** and import the repo.
2. Framework preset: **Next.js** (auto-detected). Leave the build settings at their defaults.
3. **Environment Variables** (optional, since you can paste everything in the app's Settings page instead):

   | Name | Value |
   | --- | --- |
   | `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | your OAuth Client ID |
   | `NEXT_PUBLIC_DRIVE_ACCOUNT` | `info.killer12131@gmail.com` |
   | `ELEVENLABS_API_KEY` / `GOOGLE_TTS_API_KEY` | server-side TTS key (keeps it out of the browser) |
   | `ALLOWED_EMAILS` | `info.killer12131@gmail.com` (**required** if you set a server TTS key) |

4. **Deploy**. You get a URL like `https://manhwa-recap-studio.vercel.app`.

### Option B: Netlify

1. Go to <https://app.netlify.com>, then **Add new site → Import an existing project → GitHub** and pick the repo.
2. Netlify detects Next.js and uses its Next.js runtime automatically (the included `netlify.toml` sets the build).
3. Add the same environment variables under **Site configuration → Environment variables**, then **Deploy**.

## 3. Connect Google Drive

1. Copy your deployed URL (for example `https://manhwa-recap-studio.vercel.app`) into the OAuth client's
   **Authorized JavaScript origins** in Google Cloud Console. Wait a few minutes.
2. Open the app, go to **Settings**, and paste the **Client ID** (skip this if you set the env var), your **Gemini key**
   and your **TTS key**.
3. Tap **Connect Google Drive** and choose **info.killer12131@gmail.com**. Accept the "unverified app" warning
   (it's your own app in Testing mode).
4. The app creates **Manhwa Recap Studio / Projects** in that Drive.

**Account lock.** Drive storage is locked to `info.killer12131@gmail.com`. The sign-in popup pre-selects it, and if you
sign in with any other Google account the app signs you straight back out without touching that account's Drive.
You can change the address on the Settings page. If `NEXT_PUBLIC_DRIVE_ACCOUNT` is set, it takes priority.

## 4. Use it on your tablet and phone

Open the same URL in Chrome on the Xiaomi Pad or Android phone. Then tap **⋮ → Add to Home screen** to get an app icon
(the site ships a web manifest). Settings and keys are stored **per browser**, so enter them once on each device.
Google sign-in lasts about an hour. After that, tap **Reconnect** in the top bar.

## Workflow

1. **Discover**: browse trending manhwa, then tap **Create Project folder in Drive**. Or create a blank project from the project picker.
2. **Drive Files**: upload `.cbz`, `.zip`, `.jpg` or `.png` files (drag and drop on desktop), or add them from the Drive app. Tap ✂ to slice.
3. **Panel Slicer**: tune gutter colour, tolerance and minimum sizes, preview the cuts, remove bad ones, then **Upload to Drive**.
4. **Panels**: drag the grip handle to reorder (works with touch), delete bad panels, then **Save order**.
5. **Script**: paste the chapter text or summary (optionally let Gemini look at your panels), pick a length and tone, edit the beats, then **Save to Drive**.
6. **Voice**: pick a voice, generate every beat, stitch, then **Save MP3 to Drive**. A timeline file with beat timings is saved alongside.
7. **Composer**: preview the Ken Burns animation synced to the narration, override effects per panel, then **Render**. The MP4 uploads to **Final Exports**.

## Performance notes

- FFmpeg.wasm uses the **single-threaded** core. The multi-threaded build needs cross-origin-isolation headers,
  which break Google's sign-in popup. Rendering is slower than desktop FFmpeg. Use **720p + Fast** for drafts and 1080p for finals.
  The progress bar shows live frames/second and an ETA.
- Keep the tab in the foreground while rendering. The app asks for a screen wake lock, but mobile browsers
  still pause background tabs.
- The first render or MP3 encode downloads the ~31 MB FFmpeg core from a CDN. After that it comes from the browser cache.
- Memory stays flat: frames are encoded in 90-frame chunks and deleted, and panels are decoded a few at a time.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `origin_mismatch` / `redirect_uri_mismatch` | Add the exact origin shown on the Settings page to *Authorized JavaScript origins*. Wait 5 minutes. |
| `access_denied` / "app not verified" blocked | Add your Google account under OAuth consent screen → **Test users**. |
| "Drive access was not granted" | On the consent screen, tick the Google Drive checkbox. |
| "Drive storage is locked to …" | You picked a different Google account. Sign in again with the pinned one, or change it in Settings. |
| Popup blocked | Allow popups for the site. Sign-in must start from a tap. |
| ElevenLabs "unusual activity / free tier disabled" | ElevenLabs blocks free-tier requests from cloud servers. Settings → TTS transport → **Direct**. |
| Google TTS "billing" error | Link a billing account to the Cloud project (the free tier still applies). |
| Gemini "model not found" | Settings → **List models** and pick one your key supports. |
| A work (Google Workspace) account is blocked | Workspace admins can block unverified apps and Drive scopes. Use a personal Gmail account. |
| Slicer cuts inside panels | Lower the **tolerance**, raise **Min gutter height**, or switch the gutter colour to White or Black. |
| Slicer misses cuts | Raise the **tolerance**, lower **Row coverage** a little, or lower **Min gutter height**. |

## Developing without a local install

Open the repo in **GitHub Codespaces** (Code → Codespaces → Create) or on **StackBlitz** (`https://stackblitz.com/github/<you>/<repo>`).
Both run Node in the cloud or in the browser:

```bash
npm install
npm run dev        # http://localhost:3000, so add that origin to the OAuth client
npm run typecheck  # strict TypeScript check
```

`next.config.mjs` sets `typescript.ignoreBuildErrors` so that a stray type error never blocks a cloud deploy.
Run `npm run typecheck` in a cloud IDE to see any.

## Security and privacy

- There is no server-side storage. Your files go straight from the browser to your own Google Drive.
- API keys you enter are kept in this browser's `localStorage`. They're sent only to their own provider,
  or to your own `/api/tts` edge function when the transport is "Edge".
- Server-side TTS keys are used only for Google accounts in `ALLOWED_EMAILS`. The edge function checks this by asking Google
  who owns the caller's OAuth token.
- Deleting in the app moves files to Drive's **trash** (recoverable for 30 days). It never permanently deletes.

## Project structure

```
src/
  app/                 Next.js App Router pages (dashboard, drive, discover, script, slicer, panels, voice, compose, settings)
  app/api/tts/         Edge functions: synthesize, list voices, config
  components/          App shell, UI kit, Drive picker, project picker
  lib/
    auth.ts            Google Identity Services token flow + account lock
    drive.ts           Drive v3 REST client (multipart + resumable uploads with progress)
    projects.ts        Folder layout + project.json "database"
    anilist.ts         AniList GraphQL client
    script.ts          Gemini / OpenAI-compatible script generation
    cbz.ts, slicer.ts  JSZip extraction + canvas gutter-detection slicer
    tts.ts, ttsClient.ts, ttsServer.ts   TTS providers, chunking, edge auth
    audio.ts           Web Audio decode/stitch/normalize + WAV encoder
    kenburns.ts        Timeline + Ken Burns canvas renderer (preview and export)
    ffmpeg.ts, render.ts   FFmpeg.wasm loader, MP3 encode, chunked MP4 pipeline
```
