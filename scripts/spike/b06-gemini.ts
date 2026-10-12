// B6 (Company Brain Phase 0): the Gemini API through the official SDK (@google/genai), with the key in
// GEMINI_API_KEY: which models the key can use, a chat call with a tool call and its result, and embeddings
// at 1536 dimensions. Needs no local stack. Run: pnpm tsx scripts/spike/b06-gemini.ts
// Prints facts only, never the key.
import { GoogleGenAI, type FunctionDeclaration, Type } from '@google/genai';
import { loadEnv } from '../lib/env.ts';

const env = loadEnv();
const apiKey = env.GEMINI_API_KEY;
if (!apiKey) {
  console.log('B6 not run: GEMINI_API_KEY is empty in .env');
  process.exit(0);
}
const ai = new GoogleGenAI({ apiKey });

// 1. Models available to this key.
const names: string[] = [];
const pager = await ai.models.list({ config: { pageSize: 100 } });
for await (const model of pager) names.push(model.name ?? '?');
const chatModels = names.filter((n) => /gemini-\d/.test(n) && !/embedding|tts|image|live|audio|native/.test(n));
const embeddingModels = names.filter((n) => /embedding/.test(n));
console.log(`models visible: ${names.length}`);
console.log(`chat models: ${chatModels.join(', ')}`);
console.log(`embedding models: ${embeddingModels.join(', ')}`);

// 2. Chat with a tool call: the model must call search_brain, we answer, it writes a reply.
const pick = (patterns: RegExp[]): string | undefined => patterns.map((p) => chatModels.find((n) => p.test(n))).find((n) => n !== undefined)?.replace(/^models\//, '');
const flash = pick([/gemini-3(\.\d+)?-flash(?!-lite)(?!-8b)[^-]*$/, /gemini-2\.5-flash$/, /flash/]);
const pro = pick([/gemini-3(\.\d+)?-pro[^-]*$/, /gemini-2\.5-pro$/, /pro/]);
console.log(`candidates: sweep model ${flash ?? '?'}, analysis model ${pro ?? '?'}`);
const searchBrain: FunctionDeclaration = {
  name: 'search_brain',
  description: 'Search the company brain for passages relevant to a question.',
  parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING, description: 'What to search for' } }, required: ['query'] },
};
for (const model of [flash, pro].filter((m): m is string => m !== undefined)) {
  try {
    const started = Date.now();
    const first = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: 'Use the search_brain tool to find who owns the ERP system, then answer in one sentence.' }] }],
      config: { systemInstruction: 'You are a careful analyst. Always use the tool before answering.', tools: [{ functionDeclarations: [searchBrain] }], temperature: 0 },
    });
    const call = first.functionCalls?.[0];
    const modelTurn = first.candidates?.[0]?.content;
    const signed = modelTurn?.parts?.some((part) => part.thoughtSignature !== undefined) ?? false;
    console.log(`${model}: first turn ${Date.now() - started} ms; tool call ${call ? `${call.name}(${JSON.stringify(call.args)})` : 'none'}; thought signature on the call: ${signed}; usage ${JSON.stringify(first.usageMetadata ? { prompt: first.usageMetadata.promptTokenCount, output: first.usageMetadata.candidatesTokenCount, thoughts: first.usageMetadata.thoughtsTokenCount } : null)}`);
    if (!call || !modelTurn) continue;
    // The model's turn is replayed verbatim (parts with their thought signatures): Gemini 3 refuses a rebuilt functionCall part.
    const second = await ai.models.generateContent({
      model,
      contents: [
        { role: 'user', parts: [{ text: 'Use the search_brain tool to find who owns the ERP system, then answer in one sentence.' }] },
        modelTurn,
        { role: 'user', parts: [{ functionResponse: { name: call.name ?? 'search_brain', response: { passages: [{ text: 'System "Acme ERP": business owner Deniz Kaya, technical owner Mert Can.', source: 'entity:sys-1' }] } } }] },
      ],
      config: { systemInstruction: 'You are a careful analyst. Always use the tool before answering.', tools: [{ functionDeclarations: [searchBrain] }], temperature: 0 },
    });
    console.log(`${model}: answer "${(second.text ?? '').trim().slice(0, 160)}"`);
  } catch (error) {
    console.log(`${model}: FAILED ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
  }
}

// 3. Embeddings at 1536 dimensions.
const embeddingModel = embeddingModels.find((n) => /gemini-embedding-001/.test(n))?.replace(/^models\//, '') ?? embeddingModels[0]?.replace(/^models\//, '');
if (embeddingModel) {
  try {
    const started = Date.now();
    const result = await ai.models.embedContent({
      model: embeddingModel,
      contents: ['Who owns the ERP system?', 'The ERP system is owned by Deniz Kaya.', 'The cafeteria menu changes on Mondays.'],
      config: { outputDimensionality: 1536, taskType: 'RETRIEVAL_DOCUMENT' },
    });
    const vectors = (result.embeddings ?? []).map((e) => e.values ?? []);
    const norm = (v: number[]): number => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    const cosine = (a: number[], b: number[]): number => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0) / (norm(a) * norm(b));
    console.log(`${embeddingModel}: ${vectors.length} vectors of ${vectors[0]?.length ?? 0} dims in ${Date.now() - started} ms; norms ${vectors.map((v) => norm(v).toFixed(3)).join(', ')}`);
    if (vectors.length === 3) console.log(`similarity question↔answer ${cosine(vectors[0]!, vectors[1]!).toFixed(3)}, question↔cafeteria ${cosine(vectors[0]!, vectors[2]!).toFixed(3)}`);
    const info = await ai.models.get({ model: embeddingModel });
    console.log(`${embeddingModel}: inputTokenLimit ${info.inputTokenLimit ?? '?'}, outputTokenLimit ${info.outputTokenLimit ?? '?'}`);
  } catch (error) {
    console.log(`${embeddingModel}: FAILED ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
  }
} else {
  console.log('no embedding model visible to this key');
}
