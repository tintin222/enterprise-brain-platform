// Mention extraction. Mattermost's `posted.mentions` lists only the receiving user (spike A10), so the
// bridge parses @username tokens from the text itself and resolves them through the Mattermost API.

const SPECIAL = new Set(['all', 'channel', 'here']);

/** Remove fenced and inline code, where @mentions do not notify anyone. */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

/** Lowercased usernames mentioned as @username, without duplicates or special mentions. */
export function extractMentionUsernames(message: string): string[] {
  const found = new Set<string>();
  for (const match of stripCode(message).matchAll(/(^|[^a-z0-9_.@-])@([a-z][a-z0-9._-]{0,63})/gi)) {
    const username = match[2]!.toLowerCase().replace(/[._-]+$/, '');
    if (username && !SPECIAL.has(username)) found.add(username);
  }
  return [...found];
}
