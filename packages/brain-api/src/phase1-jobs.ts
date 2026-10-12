// The recurring jobs Phase 1 adds (plan section 11), registered with the job runner at start-up: the daily
// people sync (FR-2.1). Later tasks add stale projects (FR-1.5), reminders (FR-11.2) and word statistics (Q24).
import type { BrainStore } from '@brain/brain';
import type { ChatClient, Logger } from '@brain/shared';
import type { BrainApiConfig } from './config.ts';
import type { JobRunner } from './jobs.ts';
import type { PeopleService } from './people.ts';
import { dailyPeriod } from './schedule.ts';
import type { WorkspaceService } from './workspaces.ts';

export interface Phase1JobDeps {
  config: BrainApiConfig;
  store: BrainStore;
  people: PeopleService;
  chat: ChatClient;
  jobs: JobRunner;
  log: Logger;
  botUserId: string;
  workspaces?: WorkspaceService;
}

export function registerPhase1Jobs(deps: Phase1JobDeps): void {
  const { config, people, jobs, workspaces } = deps;
  if (config.BRAIN_FEATURE_PEOPLE) {
    jobs.register({ name: 'people-sync', due: (now) => dailyPeriod(now, config.BRAIN_TIMEZONE, 3), run: () => people.syncAll() });
  }
  if (config.BRAIN_FEATURE_PROJECTS && workspaces) {
    jobs.register({ name: 'stale-projects', due: (now) => dailyPeriod(now, config.BRAIN_TIMEZONE, 7), run: () => workspaces.markStaleProjects() });
  }
}
