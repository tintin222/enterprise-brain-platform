// Mattermost <-> Buzz relay mirror (docs/bridge-spec.md).
export { Bridge, type BridgeDeps, type ReconcileReport } from './bridge.ts';
export { bridgeConfigSchema, type BridgeConfig } from './config.ts';
export { emojiForName, nameForEmoji } from './emoji.ts';
export { BRIDGE_MIGRATIONS_DIR, BridgeStore, resetForRelayRebuild, type ChannelRow, type MessageRow, type MessageState, type ReactionRow } from './store.ts';
