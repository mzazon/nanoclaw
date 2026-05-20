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
        'An infra fix you proposed has been approved by the admin. Execute the commands in the approved payload, verify the result, and report to default destination. This approved-fix task temporarily overrides the REMEDIATION RULE — you MAY run the specific commands listed in the payload.',
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
  notify(
    `Fix approved for ${payload.findingKey || 'unknown finding'}. A task has been queued — the fix will execute on your next wake.`,
  );
};
