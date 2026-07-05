// Mints a single-use ephemeral token for the Gemini Live API so the real
// API key never reaches the browser. The key lives in the GEMINI_API_KEY
// environment variable (set in the Netlify dashboard, never committed).
import { GoogleGenAI } from '@google/genai';

export default async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'GEMINI_API_KEY is not configured on the server' },
      { status: 500 }
    );
  }

  const ai = new GoogleGenAI({ apiKey });
  const token = await ai.authTokens.create({
    config: {
      uses: 1, // one Live API connection per token
      expireTime: new Date(Date.now() + 30 * 60_000).toISOString(),
      newSessionExpireTime: new Date(Date.now() + 60_000).toISOString(),
      httpOptions: { apiVersion: 'v1alpha' },
    },
  });

  return Response.json({ token: token.name });
};

export const config = { path: '/api/token' };
