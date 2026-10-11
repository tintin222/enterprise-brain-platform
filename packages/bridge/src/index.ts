// Mattermost <-> Buzz relay mirror (docs/bridge-spec.md).
export { Bridge, type BridgeDeps } from './bridge.ts';
export { bridgeConfigSchema, type BridgeConfig } from './config.ts';
export { BRIDGE_MIGRATIONS_DIR, BridgeStore, type ChannelRow, type MessageRow } from './store.ts';
