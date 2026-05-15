// LOCAL-010: Host-agent runtime path abstraction.
// In container mode, paths are hardcoded (/workspace, /app, /home/node).
// In host mode, they're resolved from env vars set by spawnHostProcess().
const HOST_MODE = process.env.NANOCLAW_HOST_MODE === 'true';

export const WORKSPACE = HOST_MODE ? process.env.NANOCLAW_WORKSPACE! : '/workspace';
export const AGENT_DIR = HOST_MODE ? process.env.NANOCLAW_AGENT_DIR! : '/workspace/agent';
export const EXTRA_DIR = HOST_MODE ? process.env.NANOCLAW_EXTRA_DIR ?? `${WORKSPACE}/extra` : '/workspace/extra';
export const GLOBAL_DIR = HOST_MODE ? process.env.NANOCLAW_GLOBAL_DIR ?? `${WORKSPACE}/global` : '/workspace/global';
export const SKILLS_DIR = HOST_MODE ? process.env.NANOCLAW_SKILLS_DIR! : '/app/skills';

export const CONFIG_PATH = `${AGENT_DIR}/container.json`;
export const INBOUND_DB = `${WORKSPACE}/inbound.db`;
export const OUTBOUND_DB = `${WORKSPACE}/outbound.db`;
export const HEARTBEAT_PATH = `${WORKSPACE}/.heartbeat`;
export const OUTBOX_DIR = `${WORKSPACE}/outbox`;
export const CONVERSATIONS_DIR = `${AGENT_DIR}/conversations`;

export { HOST_MODE };
