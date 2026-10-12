// Splitting an entity's free text into retrieval chunks (FR-9.2): paragraph-aware pieces of at most `maxChars`
// with an overlap, the title in the first piece so title words match too. Pure.
import type { ChunkInput } from './types.ts';

export interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
}

const DEFAULT_MAX = 1500;
const DEFAULT_OVERLAP = 200;

/** Cut `text` into pieces at paragraph, then sentence, then word boundaries. */
export function splitText(text: string, maxChars = DEFAULT_MAX, overlapChars = DEFAULT_OVERLAP): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean.length === 0) return [];
  if (clean.length <= maxChars) return [clean];
  const units = clean.split(/\n{2,}/).flatMap((paragraph) => (paragraph.length <= maxChars ? [paragraph] : splitLong(paragraph, maxChars)));
  const pieces: string[] = [];
  let current = '';
  for (const unit of units) {
    const candidate = current ? `${current}\n\n${unit}` : unit;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) pieces.push(current);
    // Start the next piece with the tail of the previous one, so a fact cut at the boundary stays findable.
    const tail = overlapChars > 0 && current ? current.slice(-overlapChars).replace(/^\S*\s/, '') : '';
    current = tail && tail.length + 1 + unit.length <= maxChars ? `${tail} ${unit}` : unit;
  }
  if (current) pieces.push(current);
  return pieces;
}

function splitLong(paragraph: string, maxChars: number): string[] {
  const sentences = paragraph.match(/[^.!?\n]+[.!?]*\s*|\S+\s*/g) ?? [paragraph];
  const out: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (current) out.push(current.trim());
      current = '';
      for (let i = 0; i < sentence.length; i += maxChars) out.push(sentence.slice(i, i + maxChars).trim());
      continue;
    }
    if ((current + sentence).length > maxChars) {
      out.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Rough token count for budgets: about four characters per token. */
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** The chunks for an entity: its title heads the first piece; an entity with no text still gets one chunk of its title. */
export function chunkEntityText(title: string, text: string, options: ChunkOptions = {}): ChunkInput[] {
  const pieces = splitText(text, options.maxChars ?? DEFAULT_MAX, options.overlapChars ?? DEFAULT_OVERLAP);
  if (pieces.length === 0) return [{ ordinal: 0, text: title, tokens: approximateTokens(title) }];
  return pieces.map((piece, ordinal) => {
    const body = ordinal === 0 ? `${title}\n\n${piece}` : piece;
    return { ordinal, text: body, tokens: approximateTokens(body) };
  });
}
