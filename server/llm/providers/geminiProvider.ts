import { GoogleGenAI } from '@google/genai';

export async function askGemini(
  apiKey: string,
  model: string,
  prompt: string,
  temperature: number,
  timeoutMs = 60_000
): Promise<string> {
  const ai = new GoogleGenAI({
    apiKey,
    // The SDK supports a native HTTP timeout — the underlying request is
    // aborted after timeoutMs (no orphaned in-flight request).
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' }, timeout: timeoutMs },
  });

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      temperature,
      responseMimeType: 'application/json',
    },
  });

  const text = response.text;
  if (!text) {
    throw new Error('No response from Gemini');
  }

  return text;
}
