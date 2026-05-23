/**
 * Host-side command gate. Classifies inbound slash commands and gates
 * them before they reach the container.
 *
 * - Filtered commands: dropped silently (never reach the container)
 * - Admin commands: checked against user_roles; denied senders get a
 *   "Permission denied" response written directly to messages_out
 * - Normal messages: pass through unchanged
 */
import { getDb, hasTable } from './db/connection.js';

// LOCAL-016: CC slash command passthrough via keystroke injection.
export type GateResult =
  | { action: 'pass' }
  | { action: 'filter' }
  | { action: 'deny'; command: string }
  | { action: 'inject'; command: string };

const FILTERED_COMMANDS = new Set(['/help', '/login', '/logout', '/doctor', '/config', '/remote-control']);
const ADMIN_COMMANDS = new Set(['/clear', '/compact', '/context', '/cost', '/files']);
const CC_CLI_COMMANDS = new Set(['/compact', '/context', '/clear', '/cost', '/model', '/status', '/memory', '/exit']);
const CC_CLI_TAKES_ARG = new Set(['/model', '/context']);

/**
 * Classify a message and decide whether it should reach the container.
 * Returns 'pass' for normal messages and authorized admin commands,
 * 'filter' for silently-dropped commands, 'deny' for unauthorized
 * admin commands, 'inject' for CC CLI commands on interactive runtimes.
 */
export function gateCommand(
  content: string,
  userId: string | null,
  agentGroupId: string,
  runtime?: string | null,
): GateResult {
  let text: string;
  try {
    const parsed = JSON.parse(content);
    text = (parsed.text || '').trim();
  } catch {
    text = content.trim();
  }

  if (!text.startsWith('/')) return { action: 'pass' };

  const command = text.split(/\s/)[0].toLowerCase();

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  // LOCAL-016: On interactive/cc-container runtimes, CC CLI commands are
  // injected as keystrokes rather than delivered as chat messages.
  // Only pass through command + first arg for commands that take one;
  // strips platform noise like "Sent using Claude" appended by connectors.
  const isInteractive = runtime === 'interactive' || runtime === 'cc-container';
  if (isInteractive && CC_CLI_COMMANDS.has(command)) {
    if (!isAdmin(userId, agentGroupId)) {
      return { action: 'deny', command };
    }
    const parts = text.split(/\s+/);
    const cleanCommand = CC_CLI_TAKES_ARG.has(command) && parts.length > 1 ? `${parts[0]} ${parts[1]}` : parts[0];
    return { action: 'inject', command: cleanCommand };
  }

  if (ADMIN_COMMANDS.has(command)) {
    if (isAdmin(userId, agentGroupId)) {
      return { action: 'pass' };
    }
    return { action: 'deny', command };
  }

  // Unknown slash commands pass through (the agent/SDK handles them)
  return { action: 'pass' };
}

function isAdmin(userId: string | null, agentGroupId: string): boolean {
  if (!userId) return false;
  if (!hasTable(getDb(), 'user_roles')) return true; // no permissions module = allow all
  const db = getDb();
  const row = db
    .prepare(
      `SELECT 1 FROM user_roles
       WHERE user_id = ?
         AND (role = 'owner' OR role = 'admin')
         AND (agent_group_id IS NULL OR agent_group_id = ?)
       LIMIT 1`,
    )
    .get(userId, agentGroupId);
  return row != null;
}
