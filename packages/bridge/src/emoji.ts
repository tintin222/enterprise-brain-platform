// Reaction emoji between Mattermost names and relay (NIP-25) content (docs/bridge-spec.md sections 5 and 6).
import { EMOJI_NAMES } from './emoji-data.ts';

const toCharacters = (unified: string): string => String.fromCodePoint(...unified.split('-').map((hex) => Number.parseInt(hex, 16)));
/** Variation selector 16 is optional in practice ("❤" and "❤️"), so lookups ignore it. */
const withoutVariation = (text: string): string => text.replaceAll('️', '');

const characterByName = new Map<string, string>();
const nameByCharacter = new Map<string, string>();
for (const [name, unified] of EMOJI_NAMES) {
  const characters = toCharacters(unified);
  characterByName.set(name, characters);
  const key = withoutVariation(characters);
  if (!nameByCharacter.has(key)) nameByCharacter.set(key, name);
}

/** Relay reaction content for a Mattermost emoji name: the emoji itself, or `:name:` for a custom emoji. */
export function emojiForName(name: string): string {
  return characterByName.get(name) ?? `:${name}:`;
}

/** The Mattermost emoji name for relay reaction content, or undefined when there is none. */
export function nameForEmoji(content: string): string | undefined {
  const text = content.trim();
  // NIP-25: an empty or "+" reaction is a like, "-" a dislike.
  if (text === '' || text === '+') return '+1';
  if (text === '-') return '-1';
  const custom = /^:([a-z0-9_+-]{1,64}):$/i.exec(text);
  if (custom) return custom[1]!.toLowerCase();
  return nameByCharacter.get(withoutVariation(text));
}
