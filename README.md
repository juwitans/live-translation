# Live Translation — Korean ⇄ English

Web-based live captioning: speak into the microphone and see real-time translated
subtitles (Korean → English or English → Korean), powered by the Gemini Live API.

## How it works

- The browser captures mic audio (`AudioWorklet`), converts it to 16-bit PCM @ 16 kHz,
  and streams it over a Gemini Live API WebSocket session (`@google/genai`).
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

## Notes & limitations (MVP)

- **Chrome only** — relies on `AudioContext({ sampleRate: 16000 })` + AudioWorklet
  behavior that is untested on Safari/Firefox.
- **API key in the browser**: the key from `.env.local` is inlined into the local dev
  bundle. Fine for a local POC — do **not** deploy this as-is. The production path is
  a tiny server that mints ephemeral tokens
  (`ai.authTokens.create(...)`, see https://ai.google.dev/gemini-api/docs/ephemeral-tokens)
  and hands them to the browser, which then connects with the token instead of a key.
- Translation arrives per utterance (after a pause), not word-by-word — that's the
  Live API's turn-based VAD model.
- Free-tier concurrent-session quota is small; the app closes sessions cleanly on
  Stop and direction changes.
