/**
 * Google Calendar MCP server (stdio transport).
 *
 * Wraps the Calendar REST API. Does NOT set Authorization headers — requests
 * go through HTTPS_PROXY (OneCLI gateway) which injects the Bearer token
 * based on the host pattern (www.googleapis.com/calendar/*).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = 'https://www.googleapis.com/calendar/v3';

export async function calendarFetch(path: string, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Calendar API ${res.status}: ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

type EventFields = {
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  timeZone?: string;
  attendees?: string[];
};

function buildEventBody(fields: EventFields): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (fields.summary !== undefined) body.summary = fields.summary;
  if (fields.description !== undefined) body.description = fields.description;
  if (fields.location !== undefined) body.location = fields.location;
  if (fields.start !== undefined) {
    body.start = fields.start.length === 10
      ? { date: fields.start }
      : { dateTime: fields.start, ...(fields.timeZone ? { timeZone: fields.timeZone } : {}) };
  }
  if (fields.end !== undefined) {
    body.end = fields.end.length === 10
      ? { date: fields.end }
      : { dateTime: fields.end, ...(fields.timeZone ? { timeZone: fields.timeZone } : {}) };
  }
  if (fields.attendees !== undefined) {
    body.attendees = fields.attendees.map((email) => ({ email }));
  }
  return body;
}

const SEND_UPDATES = z
  .enum(['all', 'externalOnly', 'none'])
  .optional()
  .describe('Notify attendees: "all", "externalOnly", or "none" (default).');

const RFC3339_NOTE =
  'Use RFC3339 with timezone offset (e.g. "2026-04-28T15:00:00-05:00"), or an all-day "YYYY-MM-DD" date. Call get_current_time before guessing.';

export function registerTools(server: McpServer): void {
  server.tool(
    'calendar_list_calendars',
    'List all calendars the user has access to.',
    {},
    async () => {
      const data = await calendarFetch('/users/me/calendarList');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'calendar_list_events',
    'List events from a calendar within a time range. Defaults to primary calendar and next 7 days.',
    {
      calendarId: z.string().optional().describe('Calendar ID (default: "primary")'),
      timeMin: z.string().optional().describe('Start of range, RFC3339 (e.g. "2026-04-23T00:00:00Z"). Defaults to now.'),
      timeMax: z.string().optional().describe('End of range, RFC3339. Defaults to 7 days from now.'),
      maxResults: z.number().optional().describe('Max events to return (default 25)'),
    },
    async ({ calendarId, timeMin, timeMax, maxResults }) => {
      const cal = encodeURIComponent(calendarId ?? 'primary');
      const now = new Date();
      const min = timeMin ?? now.toISOString();
      const max = timeMax ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const limit = maxResults ?? 25;
      const data = await calendarFetch(
        `/calendars/${cal}/events?timeMin=${encodeURIComponent(min)}&timeMax=${encodeURIComponent(max)}&maxResults=${limit}&singleEvents=true&orderBy=startTime`,
      );
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'calendar_get_event',
    'Get details for a specific calendar event.',
    {
      calendarId: z.string().optional().describe('Calendar ID (default: "primary")'),
      eventId: z.string().describe('Event ID from calendar_list_events'),
    },
    async ({ calendarId, eventId }) => {
      const cal = encodeURIComponent(calendarId ?? 'primary');
      const data = await calendarFetch(`/calendars/${cal}/events/${eventId}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'calendar_create_event',
    `Create a calendar event. ${RFC3339_NOTE}`,
    {
      calendarId: z.string().optional().describe('Calendar ID (default: "primary")'),
      summary: z.string().describe('Event title'),
      start: z.string().describe('Start: RFC3339 dateTime or "YYYY-MM-DD" all-day'),
      end: z.string().describe('End: RFC3339 dateTime or "YYYY-MM-DD" all-day'),
      description: z.string().optional(),
      location: z.string().optional(),
      timeZone: z.string().optional().describe('IANA timezone (e.g. "America/Chicago"). Required if start/end omit offset.'),
      attendees: z.array(z.string()).optional().describe('Attendee email addresses'),
      sendUpdates: SEND_UPDATES,
    },
    async ({ calendarId, sendUpdates, ...fields }) => {
      const cal = encodeURIComponent(calendarId ?? 'primary');
      const qs = sendUpdates ? `?sendUpdates=${sendUpdates}` : '';
      const data = await calendarFetch(`/calendars/${cal}/events${qs}`, {
        method: 'POST',
        body: JSON.stringify(buildEventBody(fields)),
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'calendar_update_event',
    `Patch fields on an existing event. Only supplied fields are changed. ${RFC3339_NOTE}`,
    {
      calendarId: z.string().optional().describe('Calendar ID (default: "primary")'),
      eventId: z.string().describe('Event ID from calendar_list_events or calendar_create_event'),
      summary: z.string().optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      description: z.string().optional(),
      location: z.string().optional(),
      timeZone: z.string().optional(),
      attendees: z.array(z.string()).optional(),
      sendUpdates: SEND_UPDATES,
    },
    async ({ calendarId, eventId, sendUpdates, ...fields }) => {
      const cal = encodeURIComponent(calendarId ?? 'primary');
      const qs = sendUpdates ? `?sendUpdates=${sendUpdates}` : '';
      const data = await calendarFetch(`/calendars/${cal}/events/${eventId}${qs}`, {
        method: 'PATCH',
        body: JSON.stringify(buildEventBody(fields)),
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'calendar_delete_event',
    'Delete a calendar event. Returns no content on success.',
    {
      calendarId: z.string().optional().describe('Calendar ID (default: "primary")'),
      eventId: z.string().describe('Event ID to delete'),
      sendUpdates: SEND_UPDATES,
    },
    async ({ calendarId, eventId, sendUpdates }) => {
      const cal = encodeURIComponent(calendarId ?? 'primary');
      const qs = sendUpdates ? `?sendUpdates=${sendUpdates}` : '';
      await calendarFetch(`/calendars/${cal}/events/${eventId}${qs}`, { method: 'DELETE' });
      return { content: [{ type: 'text', text: `Deleted event ${eventId} from ${calendarId ?? 'primary'}.` }] };
    },
  );
}

if (import.meta.main) {
  const server = new McpServer({ name: 'calendar', version: '1.0.0' });
  registerTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
