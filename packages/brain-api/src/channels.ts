// Linking a Mattermost channel to a container (FR-1.7 groundwork, D50, D57): the link row, @brain in the
// channel so it is captured, and a pinned post that points at the container's page.
import type { BrainStore, ChannelLink, ChannelRole, Container, WriteContext } from '@brain/brain';
import { errorFields, type ChatClient, type Logger } from '@brain/shared';
import { AccessError, type AccessService, type Principal } from './access.ts';
import { containerUrl } from './present.ts';

export interface ChannelLinkerDeps {
  store: BrainStore;
  chat: ChatClient;
  access: AccessService;
  botUserId: string;
  publicUrl: string;
  log: Logger;
}

export class ChannelLinker {
  readonly #deps: ChannelLinkerDeps;

  constructor(deps: ChannelLinkerDeps) {
    this.#deps = deps;
  }

  /** Link `mmChannelId` to `container` as `principal`, who must be in the channel (admins and the service always may). */
  async attach(container: Container, mmChannelId: string, role: ChannelRole, principal: Principal, ctx: WriteContext): Promise<ChannelLink> {
    const { store, chat, access, botUserId, log } = this.#deps;
    const channel = await chat.getChannel(mmChannelId);
    if (!channel || channel.delete_at !== 0 || (channel.type !== 'O' && channel.type !== 'P')) throw new AccessError(404, 'No such open or private channel');
    if (principal.kind === 'person' && !principal.isAdmin && !(await chat.isChannelMember(mmChannelId, principal.userId))) throw new AccessError(403, 'Only members of the channel can link it');
    const existing = await store.channelLinkByMm(mmChannelId);
    if (existing && existing.containerId !== container.id) throw new AccessError(409, `The channel already feeds another container (${existing.containerId}); unlink it first`);
    const link = await store.linkChannel(container.id, mmChannelId, role, ctx);
    if (!(await chat.isChannelMember(mmChannelId, botUserId))) {
      try {
        await chat.addChannelMember(mmChannelId, botUserId);
      } catch (error) {
        log.warn({ mmChannelId, ...errorFields(error) }, 'Could not add @brain to the linked channel');
      }
    }
    if (principal.kind === 'person') access.invalidate(principal.userId);
    if (!existing) await this.#pin(container, mmChannelId);
    return link;
  }

  async #pin(container: Container, mmChannelId: string): Promise<void> {
    const { chat, log, publicUrl } = this.#deps;
    try {
      const post = await chat.createPost({
        channel_id: mmChannelId,
        message: `This channel now feeds the ${container.kind} **${container.title}** in the brain: its threads become that ${container.kind}'s conversations. ${containerUrl({ publicUrl }, container.id)}`,
        props: { brain: { containerId: container.id, kind: 'channel-link' } },
      });
      await chat.pinPost(post.id);
    } catch (error) {
      log.warn({ mmChannelId, ...errorFields(error) }, 'Could not post the pinned brain note');
    }
  }
}
