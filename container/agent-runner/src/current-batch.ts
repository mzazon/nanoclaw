/**
 * Per-batch context the poll loop publishes for downstream consumers
 * (MCP tools, etc.) that don't sit on the poll-loop's call stack.
 *
 * Today the only field is `inReplyTo` — the id of the first inbound
 * message in the batch the agent is currently processing. MCP tools like
 * `send_message` and `send_file` read this and stamp it onto the outbound
 * row so the host's a2a return-path routing can correlate replies back to
 * the originating session.
 *
 * This is module-level state on purpose: the agent-runner is single-process
 * and processes one batch at a time. Poll-loop calls `setCurrentInReplyTo`
 * before invoking the provider and `clearCurrentInReplyTo` after the batch
 * completes (or errors out).
 */
let currentInReplyTo: string | null = null;

// Destinations the agent already delivered to via an MCP tool this turn
// (send_message, send_file). The end-of-turn XML <message> dispatcher
// checks this set and skips destinations already delivered, so an agent
// that does both paths in one turn doesn't post duplicates.
const mcpDeliveredDestinations: Set<string> = new Set();

export function setCurrentInReplyTo(id: string | null): void {
  currentInReplyTo = id;
}

export function clearCurrentInReplyTo(): void {
  currentInReplyTo = null;
  mcpDeliveredDestinations.clear();
}

export function getCurrentInReplyTo(): string | null {
  return currentInReplyTo;
}

// Dedup key is channel+platform only — thread_id is intentionally ignored.
// MCP send_message resolves thread via session_routing/destinations;
// the XML <message> dispatcher resolves thread via most-recent inbound on
// that channel. Those can differ even when "same destination" is meant.
// In one turn, delivering to the same (channel, platform) via both paths
// is the duplicate-instruction bug we're fixing — not legitimate work.
export function destinationKey(channelType: string, platformId: string): string {
  return `${channelType}:${platformId}`;
}

export function recordMcpDelivery(channelType: string, platformId: string): void {
  mcpDeliveredDestinations.add(destinationKey(channelType, platformId));
}

export function wasDeliveredViaMcp(channelType: string, platformId: string): boolean {
  return mcpDeliveredDestinations.has(destinationKey(channelType, platformId));
}

