/**
 * Thread creation — delivery action handler.
 *
 * When an agent writes a `create_forum_thread` system action, this handler
 * creates a new thread on the target platform. Discord uses the REST API to
 * create a forum thread; Slack and other adapter-based channels post a
 * top-level message whose platform ID becomes the thread_id.
 *
 * After creating the thread, the handler updates session_routing.thread_id
 * so subsequent tool-vis and default-routed messages flow to the new thread.
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerDeliveryAction } from '../delivery.js';
import { getChannelAdapter } from '../channels/channel-registry.js';
import { upsertSessionRouting } from '../db/session-db.js';
import { openInboundDb, writeSystemResponse } from '../session-manager.js'; // LOCAL-001

function updateSessionRouting(
  agentGroupId: string,
  sessionId: string,
  channelType: string,
  platformId: string,
  threadPlatformId: string,
): void {
  const db = openInboundDb(agentGroupId, sessionId);
  try {
    upsertSessionRouting(db, { channel_type: channelType, platform_id: platformId, thread_id: threadPlatformId });
  } finally {
    db.close();
  }
}

registerDeliveryAction('create_forum_thread', async (content, session) => {
  // LOCAL-001
  const platformId = content.platformId as string | undefined;
  const channelType = content.channelType as string | undefined;
  const title = content.title as string | undefined;
  const body = content.body as string | undefined;
  const requestId = content.requestId as string | undefined;

  if (!platformId || !title || !body) {
    throw new Error('create_forum_thread: platformId, title, and body are required');
  }

  // Discord: direct REST API call (forum thread creation)
  if (platformId.startsWith('discord:')) {
    const parts = platformId.split(':');
    const forumChannelId = parts[2];
    if (!forumChannelId) {
      throw new Error(`create_forum_thread: cannot extract channel ID from ${platformId}`);
    }

    const env = readEnvFile(['DISCORD_BOT_TOKEN']);
    const botToken = env.DISCORD_BOT_TOKEN;
    if (!botToken) {
      throw new Error('create_forum_thread: DISCORD_BOT_TOKEN not configured');
    }

    const response = await fetch(`https://discord.com/api/v10/channels/${forumChannelId}/threads`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: title.slice(0, 100),
        message: { content: body.slice(0, 2000) },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      if (requestId) {
        writeSystemResponse(session.agent_group_id, session.id, requestId, 'error', {
          error: `Discord API error ${response.status}: ${text}`,
        });
      }
      throw new Error(`Discord API error ${response.status}: ${text}`);
    }

    const thread = (await response.json()) as { id: string; name: string };
    const threadPlatformId = `${platformId}:${thread.id}`;
    log.info('Forum thread created', { threadId: thread.id, threadPlatformId, title: thread.name, forumChannelId });

    updateSessionRouting(session.agent_group_id, session.id, 'discord', platformId, threadPlatformId);

    if (requestId) {
      writeSystemResponse(session.agent_group_id, session.id, requestId, 'ok', {
        threadId: thread.id,
        threadPlatformId,
      });
    }
    return;
  }

  // Adapter-based path: post a top-level message, use its platform ID as thread_id
  if (!channelType) {
    throw new Error('create_forum_thread: channelType is required for non-Discord channels');
  }

  const adapter = getChannelAdapter(channelType);
  if (!adapter) {
    const errorMsg = `create_forum_thread: no active adapter for ${channelType}`;
    if (requestId) {
      writeSystemResponse(session.agent_group_id, session.id, requestId, 'error', { error: errorMsg });
    }
    throw new Error(errorMsg);
  }

  const markdown = `**${title}**\n\n${body}`;
  const msgId = await adapter.deliver(platformId, null, {
    kind: 'chat',
    content: { text: markdown },
  });

  if (!msgId) {
    const errorMsg = 'create_forum_thread: adapter did not return a message ID';
    if (requestId) {
      writeSystemResponse(session.agent_group_id, session.id, requestId, 'error', { error: errorMsg });
    }
    throw new Error(errorMsg);
  }

  const threadPlatformId = `${platformId}:${msgId}`;
  log.info('Thread created via adapter', { channelType, platformId, threadPlatformId, title });

  updateSessionRouting(session.agent_group_id, session.id, channelType, platformId, threadPlatformId);

  if (requestId) {
    writeSystemResponse(session.agent_group_id, session.id, requestId, 'ok', {
      threadId: msgId,
      threadPlatformId,
    });
  }
});
