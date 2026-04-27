/**
 * Forum thread creation — delivery action handler.
 *
 * When an agent writes a `create_forum_thread` system action, this handler
 * calls the Discord REST API to create a new forum thread. The thread then
 * routes back to the agent via normal channel wiring (messaging_group_agents).
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerDeliveryAction } from '../delivery.js';
import { writeSystemResponse } from '../session-manager.js'; // LOCAL-001

registerDeliveryAction('create_forum_thread', async (content, session) => {
  // LOCAL-001
  const platformId = content.platformId as string | undefined;
  const title = content.title as string | undefined;
  const body = content.body as string | undefined;
  const requestId = content.requestId as string | undefined;

  if (!platformId || !title || !body) {
    throw new Error('create_forum_thread: platformId, title, and body are required');
  }

  if (!platformId.startsWith('discord:')) {
    throw new Error(`create_forum_thread only supports Discord (got ${platformId})`);
  }

  // platformId format: "discord:{guildId}:{channelId}"
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

  // LOCAL-001
  if (requestId) {
    writeSystemResponse(session.agent_group_id, session.id, requestId, 'ok', {
      threadId: thread.id,
      threadPlatformId,
    });
  }
});
