/**
 * Dedup between MCP send_message and end-of-turn XML <message> dispatch.
 *
 * Some prompts tell the agent to use the send_message MCP tool while the
 * agent-runner base instructions tell it to wrap output in <message to="X">
 * blocks. An agent that obeys both writes the same content twice to outbound.
 * The dedup tracks destinations delivered via MCP this turn and skips them
 * in dispatchResultText so the user gets one message, not two.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import {
  clearCurrentInReplyTo,
  setCurrentInReplyTo,
  recordMcpDelivery,
  wasDeliveredViaMcp,
} from './current-batch.js';
import { sendMessage } from './mcp-tools/core.js';
import { dispatchResultText } from './poll-loop.js';

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('sentinel', 'Sentinel', 'channel', 'slack', 'C-SENT-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  clearCurrentInReplyTo();
  closeSessionDb();
});

describe('current-batch dedup state', () => {
  it('records and looks up an MCP delivery by (channel_type, platform_id)', () => {
    expect(wasDeliveredViaMcp('slack', 'C-SENT-1')).toBe(false);
    recordMcpDelivery('slack', 'C-SENT-1');
    expect(wasDeliveredViaMcp('slack', 'C-SENT-1')).toBe(true);
  });

  it('different channel types do not collide', () => {
    recordMcpDelivery('slack', 'C-SENT-1');
    expect(wasDeliveredViaMcp('discord', 'C-SENT-1')).toBe(false);
  });

  it('clearCurrentInReplyTo also clears delivered destinations', () => {
    setCurrentInReplyTo('m1');
    recordMcpDelivery('slack', 'C-SENT-1');
    expect(wasDeliveredViaMcp('slack', 'C-SENT-1')).toBe(true);
    clearCurrentInReplyTo();
    expect(wasDeliveredViaMcp('slack', 'C-SENT-1')).toBe(false);
  });
});

describe('dispatchResultText skips MCP-delivered destinations', () => {
  const routing = {
    platformId: 'C-SENT-1',
    channelType: 'slack',
    threadId: null,
    inReplyTo: 'inbound-msg-1',
  };

  it('agent calls send_message + wraps final text → only one outbound row', async () => {
    setCurrentInReplyTo('inbound-msg-1');

    // Mid-turn MCP delivery
    await sendMessage.handler({ to: 'sentinel', text: 'Infra Pulse — 1 finding' });
    expect(getUndeliveredMessages()).toHaveLength(1);

    // End-of-turn XML dispatch of the same content
    const result = dispatchResultText(
      '<message to="sentinel">Infra Pulse — 1 finding</message>',
      routing,
    );

    // sent counter still bumps so the unwrapped-nudge does not fire
    expect(result.sent).toBe(1);
    expect(result.hasUnwrapped).toBe(false);

    // But only the MCP write is in outbound — the XML block was skipped
    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it('XML dispatch alone still writes outbound (no false positives)', () => {
    setCurrentInReplyTo('inbound-msg-1');

    const result = dispatchResultText(
      '<message to="sentinel">Plain XML reply</message>',
      routing,
    );

    expect(result.sent).toBe(1);
    expect(getUndeliveredMessages()).toHaveLength(1);
    expect(JSON.parse(getUndeliveredMessages()[0].content).text).toBe('Plain XML reply');
  });

  it('clear between turns lets the next turn write again', async () => {
    // Turn 1: MCP delivery then XML duplicate (skipped)
    setCurrentInReplyTo('m1');
    await sendMessage.handler({ to: 'sentinel', text: 'turn 1' });
    dispatchResultText('<message to="sentinel">turn 1</message>', routing);
    expect(getUndeliveredMessages()).toHaveLength(1);

    clearCurrentInReplyTo();

    // Turn 2: XML-only delivery should land
    setCurrentInReplyTo('m2');
    dispatchResultText('<message to="sentinel">turn 2</message>', routing);
    expect(getUndeliveredMessages()).toHaveLength(2);
  });
});
