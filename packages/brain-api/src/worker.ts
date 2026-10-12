// The embedding worker (plan section 7): chunks whose embedding is missing get one, in batches, with the
// configured provider; a chunk that changed meanwhile is left for the next round.
import type { BrainStore } from '@brain/brain';
import type { EmbeddingProvider } from '@brain/models';
import { counter, errorFields, gaugeFrom, histogram, type Logger } from '@brain/shared';

const embedded = counter('brain_embed_chunks_total', 'Chunks embedded, by outcome', ['outcome']);
const embedSeconds = histogram('brain_embed_seconds', 'Embedding provider latency per batch', [], [0.1, 0.25, 0.5, 1, 2, 5, 10, 30]);

export interface EmbeddingWorkerOptions {
  store: BrainStore;
  embeddings: EmbeddingProvider;
  log: Logger;
  intervalMs: number;
  batchSize: number;
}

export interface EmbeddingWorker {
  /** Embed everything pending now; resolves with how many chunks were embedded. */
  runOnce(): Promise<number>;
  stop(): Promise<void>;
}

export function startEmbeddingWorker(options: EmbeddingWorkerOptions): EmbeddingWorker {
  const { store, embeddings, log } = options;
  let running: Promise<number> | undefined;
  let stopped = false;
  let backoffUntil = 0;
  gaugeFrom('brain_embed_pending', 'Chunks waiting for an embedding', () => store.pendingEmbeddings());

  async function round(): Promise<number> {
    let total = 0;
    for (;;) {
      if (stopped || Date.now() < backoffUntil) return total;
      const chunks = await store.chunksToEmbed(options.batchSize);
      if (chunks.length === 0) return total;
      const started = Date.now();
      let vectors: number[][];
      try {
        vectors = await embeddings.embed(
          chunks.map((chunk) => chunk.text),
          'document',
        );
      } catch (error) {
        embedded.inc({ outcome: 'error' }, chunks.length);
        backoffUntil = Date.now() + 30_000;
        log.warn(errorFields(error), 'Embedding batch failed; pausing the worker for 30 s');
        return total;
      }
      embedSeconds.observe((Date.now() - started) / 1000);
      let savedThisRound = 0;
      for (const [i, chunk] of chunks.entries()) {
        const saved = await store.saveEmbedding(chunk.id, chunk.version, vectors[i]!, embeddings.model);
        embedded.inc({ outcome: saved ? 'saved' : 'stale' });
        if (saved) savedThisRound++;
      }
      total += savedThisRound;
      // A full batch that changed under us is left for the next tick rather than re-read in a loop.
      if (chunks.length < options.batchSize || savedThisRound === 0) return total;
    }
  }

  const runOnce = (): Promise<number> => {
    running ??= round().finally(() => (running = undefined));
    return running;
  };
  const timer = setInterval(() => void runOnce().catch((error: unknown) => log.error(errorFields(error), 'Embedding round failed')), options.intervalMs);
  void runOnce().catch((error: unknown) => log.error(errorFields(error), 'Embedding round failed'));
  return {
    runOnce,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await running?.catch(() => undefined);
    },
  };
}
