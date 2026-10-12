// Model prices for cost reporting (NFR-7). Prices change, so the table is configuration: MODEL_PRICES_JSON maps a
// model id (or a prefix of one) to US dollars per million tokens. Without an entry a call has no cost figure.
import type { Usage } from './types.ts';

export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
}

export type PriceTable = Record<string, ModelPrice>;

export function parsePriceTable(json: string | undefined): PriceTable {
  if (!json?.trim()) return {};
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('MODEL_PRICES_JSON must be an object keyed by model id');
  const table: PriceTable = {};
  for (const [model, price] of Object.entries(parsed as Record<string, unknown>)) {
    const p = price as Partial<ModelPrice> | null;
    if (!p || typeof p.inputPerMillion !== 'number' || typeof p.outputPerMillion !== 'number') throw new Error(`MODEL_PRICES_JSON: ${model} needs inputPerMillion and outputPerMillion`);
    table[model] = { inputPerMillion: p.inputPerMillion, outputPerMillion: p.outputPerMillion, ...(typeof p.cacheReadPerMillion === 'number' ? { cacheReadPerMillion: p.cacheReadPerMillion } : {}) };
  }
  return table;
}

/** The longest key that is a prefix of the model id wins. */
export function estimateCostUsd(model: string, usage: Usage, table: PriceTable): number | undefined {
  const key = Object.keys(table)
    .filter((candidate) => model.startsWith(candidate))
    .sort((a, b) => b.length - a.length)[0];
  if (key === undefined) return undefined;
  const price = table[key]!;
  const cached = usage.cacheReadTokens ?? 0;
  const input = Math.max(0, usage.inputTokens - cached);
  const cost = (input * price.inputPerMillion + usage.outputTokens * price.outputPerMillion + cached * (price.cacheReadPerMillion ?? price.inputPerMillion)) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
