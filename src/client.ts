import { GoogleGenAI } from '@google/genai';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('GEMINI_API_KEY environment variable is required');
  process.exit(1);
}

export const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3-flash-preview';

export const ai = new GoogleGenAI({ apiKey });
