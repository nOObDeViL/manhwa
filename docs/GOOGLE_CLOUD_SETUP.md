# Google Cloud Console setup (Drive + OAuth)

You only do this once. Everything happens in a web browser. Your MacBook, tablet or phone all work.

> **Use the Drive account you want to store files in.** The app is locked to
> `info.killer12131@gmail.com` by default. Do the steps below while signed in to that
> account, so the Cloud project, the OAuth app and the Drive storage all belong to it.

## 1. Create a project

1. Open <https://console.cloud.google.com/> and sign in as **info.killer12131@gmail.com**.
2. Use the project picker at the top, then **New project**. Name it `Manhwa Recap Studio`, then **Create**.
3. Make sure the new project is selected in the top bar.

## 2. Enable the APIs

Go to **APIs & Services → Library** and enable:

| API | Needed for |
| --- | --- |
| **Google Drive API** | Required: all storage |
| **Cloud Text-to-Speech API** | Optional: only if you use Google TTS instead of ElevenLabs |

## 3. Configure the OAuth consent screen

**APIs & Services → OAuth consent screen**. Newer consoles call this **Google Auth Platform → Branding / Audience / Data access**.

1. **User type: External**, then **Create**.
2. App name `Manhwa Recap Studio`. Set the support email and developer email to your address.
3. **Scopes / Data access**: add `https://www.googleapis.com/auth/drive`. It's listed as *"See, edit, create, and delete all of your Google Drive files"*.
4. **Test users / Audience**: add **info.killer12131@gmail.com**.
5. Leave the publishing status as **Testing**. For a personal tool that's all you need. You'll see a
   "Google hasn't verified this app" screen when you sign in. Click **Continue**. That's expected for your own app.

> Why the full `drive` scope? It lets the in-app explorer see files you add to the studio folder
> from the Google Drive app on your phone, for example dropping a `.cbz` from Android. If you only upload
> through the app, you can change `DRIVE_SCOPE` in `src/lib/auth.ts` to
> `https://www.googleapis.com/auth/drive.file`. That's narrower, but files added outside the app become invisible to it.

## 4. Create the OAuth Client ID

**APIs & Services → Credentials → Create credentials → OAuth client ID**

1. **Application type:** Web application
2. **Name:** `Recap Studio web`
3. **Authorized JavaScript origins:** add every URL you'll open the app from. Use the exact origin, with no path and no trailing slash:
   - `https://YOUR-APP.vercel.app` (or `https://YOUR-SITE.netlify.app`)
   - `http://localhost:3000` (only if you ever run it in a cloud IDE / locally)
4. **Authorized redirect URIs:** leave empty. The app uses the Google Identity Services token popup, which doesn't use redirects.
5. **Create**, then copy the **Client ID**. It looks like `1234567890-abc123.apps.googleusercontent.com`.
   There's no client secret to keep, because the browser flow doesn't use one.

Changes to origins can take 5 minutes, and sometimes longer, to apply. `Error 400: redirect_uri_mismatch` or
`origin_mismatch` means the origin isn't listed exactly as the app's URL. The app's **Settings** page
shows the exact origin to copy.

## 5. (Optional) Google Text-to-Speech API key

1. Cloud TTS requires a **billing account** linked to the project, even though usage within the monthly
   free tier costs nothing. **Billing → Link a billing account**. Consider setting a budget alert.
2. **Credentials → Create credentials → API key**.
3. **Edit the key → API restrictions → Restrict key → Cloud Text-to-Speech API**.
4. If you use TTS transport **Direct**, also add **Application restrictions → Websites**:
   `https://YOUR-APP.vercel.app/*`. Don't add a website restriction if you use the **Edge** transport, because
   server-side calls don't send a referrer.

## 6. Gemini API key (script generator)

Go to <https://aistudio.google.com/apikey>, then **Create API key**. The free tier is enough for recap scripts.
Paste it into the app's **Settings** page.

## 7. ElevenLabs API key (optional)

Go to <https://elevenlabs.io>, then **Profile → API Keys**. The free plan includes 10,000 credits a month (1 character = 1 credit).
The free plan requires attribution and doesn't include a commercial licence. For monetised YouTube videos you need a paid plan.
