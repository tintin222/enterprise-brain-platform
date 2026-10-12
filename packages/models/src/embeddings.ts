// Embeddings (D53, D56): Google's embedding model for installations with a Gemini key, and a deterministic
// mock for tests and demos. Vectors are unit length, so cosine similarity is a dot product.
import { GoogleGenAI, type EmbedContentParameters } from '@google/genai';
import type { EmbeddingProvider, EmbeddingPurpose } from './types.ts';

export function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  return norm === 0 ? vector : vector.map((x) => x / norm);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** FNV-1a, 32 bits. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A bag of hashed words and word pairs: the same text always gives the same vector, and shared words bring texts closer. */
export function mockEmbedding(text: string, dimensions: number): number[] {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const vector = new Array<number>(dimensions).fill(0);
  for (const [i, token] of tokens.entries()) {
    const h = hash(token);
    vector[h % dimensions]! += 1;
    vector[(h >>> 7) % dimensions]! += h & 1 ? 0.5 : -0.5;
    const next = tokens[i + 1];
    if (next !== undefined) vector[hash(`${token} ${next}`) % dimensions]! += 0.5;
  }
  if (tokens.length === 0) vector[0] = 1;
  return normalize(vector);
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'mock';
  readonly model: string;
  readonly dimensions: number;

  constructor(dimensions = 1536) {
    this.dimensions = dimensions;
    this.model = `mock-${dimensions}`;
  }

  // The purpose makes no difference to the mock: queries and documents share one space.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  embed(texts: string[], purpose: EmbeddingPurpose): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => mockEmbedding(text, this.dimensions)));
  }
}

/** The part of the SDK the provider uses, so tests can pass a fake. */
export interface GeminiEmbeddingApi {
  embedContent(params: EmbedContentParameters): Promise<{ embeddings?: { values?: number[] }[] }>;
}

export interface GeminiEmbeddingOptions {
  apiKey?: string | undefined;
  api?: GeminiEmbeddingApi;
  model?: string;
  dimensions?: number;
  /** Inputs are cut here; gemini-embedding-001 accepts 2,048 tokens (spike B6). */
  maxChars?: number;
  batchSize?: number;
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'google';
  readonly model: string;
  readonly dimensions: number;
  readonly #api: GeminiEmbeddingApi;
  readonly #maxChars: number;
  readonly #batchSize: number;

  constructor(options: GeminiEmbeddingOptions = {}) {
    this.#api = options.api ?? new GoogleGenAI({ ...(options.apiKey ? { apiKey: options.apiKey } : {}) }).models;
    this.model = options.model ?? 'gemini-embedding-001';
    this.dimensions = options.dimensions ?? 1536;
    this.#maxChars = options.maxChars ?? 7000;
    this.#batchSize = options.batchSize ?? 100;
  }

  async embed(texts: string[], purpose: EmbeddingPurpose): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += this.#batchSize) {
      const batch = texts.slice(start, start + this.#batchSize).map((text) => (text.length > this.#maxChars ? text.slice(0, this.#maxChars) : text) || ' ');
      const result = await this.#api.embedContent({
        model: this.model,
        contents: batch,
        config: { outputDimensionality: this.dimensions, taskType: purpose === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT' },
      });
      const embeddings = result.embeddings ?? [];
      if (embeddings.length !== batch.length) throw new Error(`Embedding provider returned ${embeddings.length} vectors for ${batch.length} texts`);
      for (const embedding of embeddings) {
        const values = embedding.values ?? [];
        if (values.length !== this.dimensions) throw new Error(`Embedding has ${values.length} dimensions, expected ${this.dimensions}`);
        vectors.push(normalize(values));
      }
    }
    return vectors;
  }
}
