# Live Translation — Korean ⇄ English

Web-based live captioning: speak into the microphone and see real-time translated
subtitles (Korean → English or English → Korean), powered by the Gemini Live API.

## Audio source — mic, system, or both

Use the **Mic / System / Both** selector in the header (before pressing Start) to choose
what gets translated:

- **Mic** — the microphone (default).
- **System** — audio playing on the machine, captured with `getDisplayMedia`. When you
  press Start, Chrome asks what to share:
  - **Udemy (or any browser video)**: pick the **Chrome Tab** playing it and tick
    **“Share tab audio”**. The tab keeps playing to your speakers while it's captured.
  - **Webex / a desktop app**: pick **Entire Screen** and tick **“Share system audio”**
    (Windows Chrome only — see limitations).
- **Both** — mixes mic + captured system audio into one stream, so a two-way call (you +
  the other side) is fully translated. **Use headphones**, otherwise the mic re-hears the
  speaker output and you get echoed/doubled captions.

The source is fixed for a running session; press Stop, change it, and Start again to switch.

## How it works

- The browser captures the chosen audio source (mic via `getUserMedia`, and/or system/tab
  audio via `getDisplayMedia`) through an `AudioWorklet`, mixes any sources together,
  converts to 16-bit PCM @ 16 kHz, and streams it over a Gemini Live API WebSocket session
  (`@google/genai`).
- A system instruction tells the model to act as a simultaneous interpreter and output
  only the translation.
- The Live API's automatic voice activity detection segments speech into utterances:
  while you speak, the original-language transcription streams in dim text; when you
  pause, the translation streams in below it.
- Sessions have a ~10-minute connection limit; the app reconnects automatically
  (on the server's `GoAway` notice and on unexpected drops, with capped backoff).
- If the model rejects text-only responses (native-audio Live models may only support
  the AUDIO response modality), the app transparently falls back to requesting audio
  plus `outputAudioTranscription` and uses the transcription as the caption — the
  audio itself is never played.

## Setup

1. Get a free Gemini API key at https://aistudio.google.com/apikey
2. ```
   npm install
   cp .env.example .env.local   # then paste your key into .env.local
   npm run dev
   ```
3. Open http://localhost:5173 in **Chrome**, press **Start**, allow the microphone,
   and speak. Use the **KO → EN / EN → KO** button to switch direction (this restarts
   the session; the transcript is kept).

## Deploying to Netlify (free)

The repo includes a Netlify function (`netlify/functions/token.mts`) that mints
single-use [ephemeral tokens](https://ai.google.dev/gemini-api/docs/ephemeral-tokens)
at `/api/token`. When `VITE_GEMINI_API_KEY` is **not** set at build time, the app
automatically fetches a token per connection instead — so the real key stays
server-side.

1. Push the repo to GitHub and [import it on Netlify](https://app.netlify.com/start)
   (build settings are read from `netlify.toml`), or use the CLI:
   `npm i -g netlify-cli && netlify deploy --prod`.
2. In the Netlify dashboard → Site configuration → **Environment variables**, add
   `GEMINI_API_KEY` = your AI Studio key. Do **not** add `VITE_GEMINI_API_KEY` —
   that would bake the key into the public bundle.
3. Redeploy. Open the site (HTTPS, so mic access works), press Start.

To test the function locally: `netlify dev` (runs Vite + the function together;
put `GEMINI_API_KEY` in `.env.local` for it and remove `VITE_GEMINI_API_KEY`).

## Notes & limitations (MVP)

- **Chrome only** — relies on `AudioContext({ sampleRate: 16000 })` + AudioWorklet
  behavior that is untested on Safari/Firefox.
- **System audio capture**: tab-audio sharing works cross-platform, but full **“Share
  system audio”** for an entire-screen share (needed for desktop apps like the Webex
  client) is **Windows Chrome only** — macOS Chrome can't capture system audio, though
  tab-share still works there for Udemy and other browser content.
- **Both mode**: without headphones the mic picks up the speaker output, producing echoed
  or duplicated captions. Mic echo-cancellation reduces but doesn't eliminate this.
- **Local dev key**: with `npm run dev`, the `VITE_GEMINI_API_KEY` from `.env.local`
  is inlined into the local bundle — fine on localhost, never set it on a deployed
  build (use the Netlify function path above instead).
- Translation arrives per utterance (after a pause), not word-by-word — that's the
  Live API's turn-based VAD model.
- Free-tier concurrent-session quota is small; the app closes sessions cleanly on
  Stop and direction changes.
