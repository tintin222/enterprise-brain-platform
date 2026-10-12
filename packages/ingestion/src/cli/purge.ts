// pnpm ingest:purge --channel <relay channel id> | --author <pubkey>
// Removes a channel's or an author's content from the brain and keeps it out (docs/agents-and-ingestion.md B.4).
import { parseArgs } from 'node:util';
import { baseConfigSchema, createPool, loadDotEnv, parseConfig, PostgresBrainClient } from '@brain/shared';
import { purgeAuthor, purgeChannel } from '../ingestion.ts';

const { values } = parseArgs({ options: { channel: { type: 'string' }, author: { type: 'string' } } });
if (!values.channel === !values.author) {
  console.error('Usage: pnpm ingest:purge --channel <relay channel id> | --author <pubkey>');
  process.exit(2);
}

loadDotEnv();
const config = parseConfig(baseConfigSchema);
const pool = createPool(config.STATE_DATABASE_URL);
try {
  const brain = new PostgresBrainClient(pool);
  await brain.init();
  if (values.channel) {
    const threads = await purgeChannel({ pool, brain }, values.channel);
    console.log(`Removed ${threads} threads of channel ${values.channel}; it will not be indexed again.`);
  } else if (values.author) {
    const threads = await purgeAuthor({ pool, brain }, values.author);
    console.log(`Removed ${values.author}'s messages from ${threads} threads; the running ingestion re-indexes them without that author.`);
  }
} finally {
  await pool.end();
}
