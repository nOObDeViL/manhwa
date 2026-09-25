import { getGemini, listAvailableModels, rankModels, withGeminiModel } from './gemini';

/**
 * Recap script generation — two engines, both called straight from the browser:
 *   1. Google Gemini via @google/genai (free tier key from aistudio.google.com)
 *   2. Any OpenAI-compatible endpoint (Groq, OpenRouter, …) as a fallback
 */

export interface Beat {
  n: number;
  title?: string;
  narration: string;
  visual?: string;
  seconds?: number;
}

export interface RecapScript {
  app: 'manhwa-recap-studio';
  version: 1;
  title: string;
  series?: string;
  chapter?: string;
  tone: string;
  language: string;
  targetSeconds: number;
  engine: string;
  model: string;
  createdAt: string;
  beats: Beat[];
}

export const TONES = [
  'Dramatic & cinematic',
  'Hype / high energy',
  'Dark & suspenseful',
  'Comedic & sarcastic',
  'Casual storyteller',
  'Wholesome & emotional',
  'Epic narrator (trailer voice)',
];

export const LENGTH_PRESETS = [
  { seconds: 60, label: '1 min (Short)' },
  { seconds: 180, label: '3 min' },
  { seconds: 300, label: '5 min' },
  { seconds: 480, label: '8 min' },
  { seconds: 600, label: '10 min' },
  { seconds: 900, label: '15 min' },
];

/** ~150 spoken words per minute is a comfortable recap pace. */
export const WORDS_PER_SECOND = 2.5;

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

export function estimateSeconds(text: string): number {
  return Math.max(1, Math.round(wordCount(text) / WORDS_PER_SECOND));
}

export function totalSeconds(script: Pick<RecapScript, 'beats'>): number {
  return script.beats.reduce((sum, b) => sum + estimateSeconds(b.narration), 0);
}

export interface ScriptRequest {
  series?: string;
  synopsis?: string;
  chapter?: string;
  sourceText: string;
  targetSeconds: number;
  tone: string;
  language: string;
  includeOutro: boolean;
  /** Base64 panel images (Gemini only), in reading order. */
  images?: Array<{ mimeType: string; data: string }>;
}

export function buildPrompt(req: ScriptRequest) {
  const beatCount = Math.min(60, Math.max(4, Math.round(req.targetSeconds / 12)));
  const words = Math.round(req.targetSeconds * WORDS_PER_SECOND);

  const system = [
    'You are a top YouTube manhwa recap scriptwriter.',
    'You turn chapter content into a gripping, spoiler-heavy narrated recap that a text-to-speech voice will read aloud.',
    'Rules:',
    '- Narration is plain spoken prose: no markdown, no emojis, no stage directions, no speaker labels, no bracketed notes.',
    '- Third person, present tense, vivid but clear. Use character names consistently.',
    '- Beat 1 is a hook that makes viewers stay. Beats follow the story in chronological order.',
    '- Each beat is 1–4 sentences and matches one moment/panel group of the chapter.',
    '- "visual" briefly describes which panel or scene should be on screen for that beat.',
    '- "seconds" is your estimate of how long the narration takes to read aloud.',
    req.includeOutro
      ? '- The final beat is a short outro teasing what comes next and asking viewers to like and subscribe.'
      : '- Do not add a call-to-action outro.',
    '- Respond with JSON only, matching the requested schema.',
  ].join('\n');

  const user = [
    req.series ? `Series: ${req.series}` : null,
    req.chapter ? `Chapter / arc: ${req.chapter}` : null,
    req.synopsis ? `Series synopsis (background only, do not recap it):\n${req.synopsis}` : null,
    `Tone: ${req.tone}`,
    `Narration language: ${req.language}`,
    `Target video length: ${req.targetSeconds} seconds (about ${words} words total, roughly ${beatCount} beats).`,
    req.images?.length
      ? `${req.images.length} panel images are attached in reading order. Use them to understand what happens and reference them in "visual".`
      : null,
    req.sourceText.trim() ? `Chapter content / summary / raw text:\n"""\n${req.sourceText.trim()}\n"""` : null,
    '',
    'Return JSON: {"title": string, "beats": [{"n": number, "title": string, "narration": string, "visual": string, "seconds": number}]}',
  ]
    .filter((line) => line !== null)
    .join('\n\n');

  return { system, user, beatCount, words };
}

function parseLooseJson(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('The model did not return valid JSON. Try again or pick a different model.');
  }
}

export function normalizeScript(raw: unknown, req: ScriptRequest, engine: string, model: string): RecapScript {
  const obj = (raw ?? {}) as { title?: unknown; beats?: unknown };
  const beatsIn = Array.isArray(obj.beats) ? obj.beats : [];
  const beats: Beat[] = beatsIn
    .map((b) => (b ?? {}) as Record<string, unknown>)
    .map((b) => ({
      n: 0,
      title: typeof b.title === 'string' ? b.title.trim() : undefined,
      narration: String(b.narration ?? b.text ?? '').trim(),
      visual: typeof b.visual === 'string' ? b.visual.trim() : undefined,
    }))
    .filter((b) => b.narration)
    .map((b, i) => ({ ...b, n: i + 1, seconds: estimateSeconds(b.narration) }));
  if (!beats.length) throw new Error('The model returned no usable beats. Add more chapter content and try again.');
  return {
    app: 'manhwa-recap-studio',
    version: 1,
    title: typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : `${req.series ?? 'Manhwa'} recap`,
    series: req.series,
    chapter: req.chapter,
    tone: req.tone,
    language: req.language,
    targetSeconds: req.targetSeconds,
    engine,
    model,
    createdAt: new Date().toISOString(),
    beats,
  };
}

export async function generateWithGemini(
  req: ScriptRequest,
  apiKey: string,
  model: string,
  onStatus?: (message: string) => void,
  onModel?: (model: string) => void,
  lastGoodModel?: string,
): Promise<RecapScript> {
  const { ai, Type } = await getGemini(apiKey);
  const { system, user } = buildPrompt(req);
  const parts: Array<Record<string, unknown>> = [{ text: user }];
  for (const img of req.images ?? []) parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });

  // Tries your chosen model, then the last one that worked, then the best free-tier models your key has.
  const { result, model: used } = await withGeminiModel(
    apiKey,
    'text',
    [model, lastGoodModel],
    async (m) => {
      const response = await ai.models.generateContent({
        model: m,
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction: system,
          temperature: 0.9,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              beats: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    n: { type: Type.INTEGER },
                    title: { type: Type.STRING },
                    narration: { type: Type.STRING },
                    visual: { type: Type.STRING },
                    seconds: { type: Type.NUMBER },
                  },
                  required: ['n', 'narration'],
                },
              },
            },
            required: ['title', 'beats'],
          },
        },
      });
      const text = response.text;
      if (!text) throw new Error('Gemini returned an empty response (it may have been blocked by safety filters).');
      return normalizeScript(parseLooseJson(text), req, 'gemini', m);
    },
    onStatus,
  );
  onModel?.(used);
  return result;
}

/** Text models your key can use, best (free-tier friendly) first. */
export async function listGeminiModels(apiKey: string): Promise<string[]> {
  return rankModels(await listAvailableModels(apiKey), 'text');
}

export async function generateWithOpenAI(req: ScriptRequest, baseUrl: string, apiKey: string, model: string): Promise<RecapScript> {
  if (!apiKey) throw new Error('Add an API key for the OpenAI-compatible engine on the Settings page.');
  const { system, user } = buildPrompt({ ...req, images: undefined });
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.9,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Script engine error (${res.status}): ${json?.error?.message || res.statusText}`);
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error('The engine returned an empty response.');
  return normalizeScript(parseLooseJson(content), req, 'openai-compatible', model);
}

export function scriptToText(script: RecapScript): string {
  const lines = [
    script.title,
    [script.series, script.chapter].filter(Boolean).join(' — '),
    `Tone: ${script.tone} | Target: ${Math.round(script.targetSeconds / 60)} min | Beats: ${script.beats.length} | Est. read: ${Math.round(
      totalSeconds(script),
    )}s`,
    '',
  ];
  for (const b of script.beats) {
    lines.push(`[${String(b.n).padStart(2, '0')}] ${b.title ?? ''} (~${estimateSeconds(b.narration)}s)`.trim());
    lines.push(b.narration);
    if (b.visual) lines.push(`    Visual: ${b.visual}`);
    lines.push('');
  }
  return lines.filter((l, i) => !(i === 1 && !l)).join('\n');
}

/** Downscale panel images for multimodal prompts to keep requests small. */
export async function blobToPromptImage(blob: Blob, maxSide = 768): Promise<{ mimeType: string; data: string }> {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
  canvas.width = canvas.height = 0;
  return { mimeType: 'image/jpeg', data: dataUrl.split(',')[1] };
}
