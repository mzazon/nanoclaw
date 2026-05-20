import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { ApprovalHandler } from '../approvals/index.js';

export const applyInfraFix: ApprovalHandler = async ({ session, payload, userId, notify }) => {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notify('infra_fix approved but agent group missing.');
    return;
  }

  writeSessionMessage(session.agent_group_id, session.id, {
    id: `fix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'task',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({
      prompt:
        'An infra fix you proposed has been approved. Execute it, verify, and report the result to ops. See the approved payload below.',
      approvedFix: {
        ...payload,
        approvedBy: userId,
      },
    }),
  });

  log.info('infra_fix approved — task written to session', {
    agentGroupId: session.agent_group_id,
    findingKey: payload.findingKey,
    userId,
  });
  notify(`Fix approved for ${payload.findingKey || 'unknown finding'}. Executing.`);
};
