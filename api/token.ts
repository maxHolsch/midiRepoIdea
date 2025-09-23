import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenAI } from '@google/genai';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'Server misconfiguration: GEMINI_API_KEY missing' });
      return;
    }

    const ai = new GoogleGenAI({ apiKey, apiVersion: 'v1alpha' });

    // Create an ephemeral token with default limits (short expiry, limited uses)
    const token = await ai.authTokens.create({});

    if (!token?.name) {
      res.status(500).json({ error: 'Failed to create auth token' });
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ token: token.name });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Internal Server Error' });
  }
}

