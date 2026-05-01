/**
 * Gmail read-only MCP server (stdio transport).
 *
 * Wraps the Gmail REST API. Does NOT set Authorization headers — requests
 * go through HTTPS_PROXY (OneCLI gateway) which injects the Bearer token
 * based on the host pattern (gmail.googleapis.com).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export async function gmailFetch(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gmail API ${res.status}: ${body}`);
  }
  return res.json();
}

export function registerTools(server: McpServer): void {
  server.tool(
    'gmail_search_threads',
    'Search Gmail threads using Gmail query syntax (e.g. "from:alice subject:meeting after:2026/04/01"). Returns thread IDs and snippets.',
    { query: z.string().describe('Gmail search query'), maxResults: z.number().optional().describe('Max threads to return (default 10)') },
    async ({ query, maxResults }) => {
      const max = maxResults ?? 10;
      const data = await gmailFetch(`/threads?q=${encodeURIComponent(query)}&maxResults=${max}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'gmail_get_thread',
    'Get a full Gmail thread with all messages. Returns subject, sender, date, and body for each message.',
    { threadId: z.string().describe('Thread ID from gmail_search_threads') },
    async ({ threadId }) => {
      const data = await gmailFetch(`/threads/${threadId}?format=full`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'gmail_get_message',
    'Get a single Gmail message by ID. Returns headers, body, and attachment metadata.',
    { messageId: z.string().describe('Message ID') },
    async ({ messageId }) => {
      const data = await gmailFetch(`/messages/${messageId}?format=full`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'gmail_get_attachment',
    'Download a Gmail attachment by ID. Returns base64-encoded data.',
    {
      messageId: z.string().describe('Message ID containing the attachment'),
      attachmentId: z.string().describe('Attachment ID from the message parts'),
    },
    async ({ messageId, attachmentId }) => {
      const data = await gmailFetch(`/messages/${messageId}/attachments/${attachmentId}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'gmail_list_labels',
    'List all Gmail labels (inbox, sent, custom labels, etc.).',
    {},
    async () => {
      const data = await gmailFetch('/labels');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );
}

if (import.meta.main) {
  const server = new McpServer({ name: 'gmail', version: '1.0.0' });
  registerTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
