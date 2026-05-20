import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const requestApproval: McpToolDefinition = {
  tool: {
    name: 'request_approval',
    description:
      "Propose an action that requires human approval. Sends a Block Kit card to the admin's Slack DM with the title, description, and Approve/Reject buttons (or custom options). Fire-and-forget: you'll be notified when the admin responds.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          description:
            'Action identifier for routing (e.g. "infra_fix", "deploy", "code_change"). Determines which handler processes the approval.',
        },
        title: {
          type: 'string',
          description: 'Card title shown to the admin (e.g. "Fix Proposal — vault-search down")',
        },
        description: {
          type: 'string',
          description:
            'Rich text body — diagnosis, proposed commands, context. This is the main content the admin reads to make a decision.',
        },
        payload: {
          type: 'object',
          description:
            'Opaque JSON payload carried through to the handler on approval. Include findingKey or dedupKey for dedup.',
        },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Button text' },
              value: { type: 'string', description: 'Value returned on selection' },
              selectedLabel: { type: 'string', description: 'Text shown after selection' },
            },
            required: ['label', 'value'],
          },
          description: 'Custom button options. Default: Approve/Reject.',
        },
      },
      required: ['action', 'title', 'description'],
    },
  },
  async handler(args) {
    const action = args.action as string;
    const title = args.title as string;
    const description = args.description as string;
    if (!action || !title || !description) {
      return err('action, title, and description are required');
    }

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'request_approval',
        approvalAction: action,
        title,
        description,
        payload: (args.payload as Record<string, unknown>) || {},
        options: args.options || undefined,
      }),
    });

    console.error(`[mcp-tools] request_approval: ${requestId} → action=${action} title="${title}"`);
    return ok(`Approval request submitted (action: ${action}). You will be notified when the admin responds.`);
  },
};

registerTools([requestApproval]);
