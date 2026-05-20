import { getAgentGroup } from '../../db/agent-groups.js';
import { getPendingApprovalsByAction } from '../../db/sessions.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import type { RawOption } from '../../channels/ask-question.js';
import { notifyAgent, requestApproval } from './primitive.js';

function hasPendingApproval(action: string, dedupKey: string): boolean {
  const pending = getPendingApprovalsByAction(action);
  return pending.some((row) => {
    try {
      const payload = JSON.parse(row.payload);
      return (payload.findingKey ?? payload.dedupKey) === dedupKey;
    } catch {
      return false;
    }
  });
}

export async function handleGenericApprovalRequest(content: Record<string, unknown>, session: Session): Promise<void> {
  const approvalAction = content.approvalAction as string;
  if (!approvalAction) {
    log.warn('request_approval missing approvalAction', { sessionId: session.id });
    return;
  }

  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'Approval request failed: agent group not found.');
    return;
  }

  const title = (content.title as string) || `${agentGroup.name}: ${approvalAction}`;
  const description = (content.description as string) || '';
  const payload = (content.payload as Record<string, unknown>) || {};
  const options = content.options as RawOption[] | undefined;

  const dedupKey = (payload.findingKey ?? payload.dedupKey) as string | undefined;
  if (dedupKey && hasPendingApproval(approvalAction, dedupKey)) {
    notifyAgent(session, `Duplicate — approval already pending for ${dedupKey}.`);
    return;
  }

  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: approvalAction,
    payload,
    title,
    question: description,
    options,
  });
}
