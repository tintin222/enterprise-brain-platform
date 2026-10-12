// Reading scanned pages and images with the model provider (FR-5.2, D65): the document's bytes go to Gemini as
// inline data with one instruction, and the text comes back. The brain calls this only for documents that are
// neither confidential nor marked no-ai, and only when BRAIN_FEATURE_OCR_MODEL is on.
import { GoogleGenAI } from '@google/genai';
import type { GeminiModelsApi } from './gemini.ts';

export interface OcrProvider {
  readonly name: string;
  /** Media types this provider reads. */
  accepts(mediaType: string): boolean;
  /** The text of the pages or the image, in reading order; tables as Markdown tables. */
  readText(bytes: Uint8Array, mediaType: string): Promise<string>;
}

const OCR_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);
const INSTRUCTION =
  'Transcribe every piece of text in this document in reading order. Keep headings and lists as Markdown, render tables as Markdown tables, and write numbers, codes and names exactly as they appear. Output only the transcription, no commentary. If the document holds no text, answer with an empty response.';
/** Gemini's inline limit is 20 MB per request; larger scans are left to a later file-API path. */
const MAX_INLINE_BYTES = 19 * 1024 * 1024;

export class GeminiOcrProvider implements OcrProvider {
  readonly name = 'gemini';
  readonly #api: GeminiModelsApi;
  readonly #model: string;

  constructor(options: { apiKey?: string | undefined; model: string; api?: GeminiModelsApi }) {
    this.#api = options.api ?? new GoogleGenAI({ ...(options.apiKey ? { apiKey: options.apiKey } : {}) }).models;
    this.#model = options.model;
  }

  accepts(mediaType: string): boolean {
    return OCR_TYPES.has(mediaType);
  }

  async readText(bytes: Uint8Array, mediaType: string): Promise<string> {
    if (bytes.byteLength > MAX_INLINE_BYTES) throw new Error(`The file is too large to read with the model (${bytes.byteLength} bytes; the limit is ${MAX_INLINE_BYTES})`);
    const response = await this.#api.generateContent({
      model: this.#model,
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: mediaType, data: Buffer.from(bytes).toString('base64') } }, { text: INSTRUCTION }] }],
      config: { maxOutputTokens: 60_000, temperature: 0 },
    });
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    return parts
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
  }
}

/** A provider for tests: returns the text it was given per media type, and records what it was asked to read. */
export class FakeOcrProvider implements OcrProvider {
  readonly name = 'fake';
  readonly calls: { mediaType: string; bytes: number }[] = [];
  readonly #answer: (mediaType: string, bytes: Uint8Array) => string;

  constructor(answer: (mediaType: string, bytes: Uint8Array) => string = () => 'fake ocr text') {
    this.#answer = answer;
  }

  accepts(mediaType: string): boolean {
    return OCR_TYPES.has(mediaType);
  }

  readText(bytes: Uint8Array, mediaType: string): Promise<string> {
    this.calls.push({ mediaType, bytes: bytes.byteLength });
    return Promise.resolve(this.#answer(mediaType, bytes));
  }
}

/** The OCR provider the configuration allows: Gemini with the key, otherwise none. */
export function ocrProviderFromConfig(config: { GEMINI_API_KEY?: string | undefined; GEMINI_MODEL_FAST: string }): OcrProvider | undefined {
  return config.GEMINI_API_KEY ? new GeminiOcrProvider({ apiKey: config.GEMINI_API_KEY, model: config.GEMINI_MODEL_FAST }) : undefined;
}
