// Registry of spikes, in the order `pnpm spike` runs them.
import { a01 } from './a01-http-multi-key.ts';
import { a02 } from './a02-channel-create.ts';
import { a03 } from './a03-mentions.ts';
import { a04 } from './a04-edits.ts';
import { a05 } from './a05-created-at.ts';
import { a06 } from './a06-membership.ts';
import { a07 } from './a07-subscriptions.ts';
import { a08 } from './a08-profiles.ts';
import { a09 } from './a09-custom-tags.ts';
import { a10 } from './a10-mattermost-events.ts';
import { a11 } from './a11-bot-accounts.ts';
import { a12 } from './a12-media.ts';
import { acceptanceMm } from './acceptance-mm.ts';
import { acceptanceRelay } from './acceptance-relay.ts';
import type { Spike } from './lib/spike.ts';
import { x01 } from './x01-xpubkey.ts';
import { x02 } from './x02-user-limit.ts';
import { x03 } from './x03-no-user-limit.ts';

export const spikes: Spike[] = [acceptanceRelay, acceptanceMm, a01, a02, a03, a04, a05, a06, a07, a08, a09, a10, a11, a12, x01, x02, x03];
