/**
 * Tests for the Calendar MCP server's fetch logic and tool wiring.
 *
 * Imports calendarFetch + registerTools from the sibling module. The module
 * only auto-starts the MCP server under `if (import.meta.main)`, so importing
 * here is side-effect-free.
 */
import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { calendarFetch, registerTools } from './calendar-mcp-stdio';

const BASE = 'https://www.googleapis.com/calendar/v3';

let fetchSpy: ReturnType<typeof spyOn>;

function mockFetchOk(data: unknown, status = 200) {
  fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(status === 204 ? null : JSON.stringify(data), { status }),
  );
}

function mockFetchError(status: number, body: string) {
  fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(body, { status }),
  );
}

afterEach(() => {
  fetchSpy?.mockRestore();
});

function lastFetchInit(): RequestInit {
  const calls = fetchSpy.mock.calls;
  return calls[calls.length - 1]?.[1] as RequestInit;
}

function lastFetchUrl(): string {
  const calls = fetchSpy.mock.calls;
  return calls[calls.length - 1]?.[0] as string;
}

describe('calendarFetch — read paths', () => {
  it('constructs correct URL for list calendars', async () => {
    mockFetchOk({ items: [{ id: 'primary', summary: 'My Calendar' }] });

    const result = await calendarFetch('/users/me/calendarList');

    expect(lastFetchUrl()).toBe(`${BASE}/users/me/calendarList`);
    expect(result).toEqual({ items: [{ id: 'primary', summary: 'My Calendar' }] });
  });

  it('constructs correct URL for list events with time range', async () => {
    mockFetchOk({ items: [] });

    const min = '2026-04-23T00:00:00Z';
    const max = '2026-04-30T00:00:00Z';
    await calendarFetch(
      `/calendars/primary/events?timeMin=${encodeURIComponent(min)}&timeMax=${encodeURIComponent(max)}&maxResults=25&singleEvents=true&orderBy=startTime`,
    );

    expect(lastFetchUrl()).toBe(
      `${BASE}/calendars/primary/events?timeMin=2026-04-23T00%3A00%3A00Z&timeMax=2026-04-30T00%3A00%3A00Z&maxResults=25&singleEvents=true&orderBy=startTime`,
    );
  });

  it('encodes non-primary calendar IDs', async () => {
    mockFetchOk({ items: [] });

    const cal = encodeURIComponent('user@example.com');
    await calendarFetch(`/calendars/${cal}/events?timeMin=x&timeMax=y`);

    expect(lastFetchUrl()).toContain('/calendars/user%40example.com/events?');
  });

  it('throws on non-ok response', async () => {
    mockFetchError(401, 'Unauthorized');

    await expect(calendarFetch('/users/me/calendarList')).rejects.toThrow(
      'Calendar API 401: Unauthorized',
    );
  });

  it('surfaces 403 with body details (insufficient scope signal)', async () => {
    mockFetchError(403, '{"error": {"message": "insufficient authentication scopes"}}');

    await expect(calendarFetch('/calendars/primary/events', { method: 'POST', body: '{}' }))
      .rejects.toThrow('Calendar API 403:');
  });
});

describe('calendarFetch — write paths', () => {
  it('forwards method + JSON body + content-type on POST', async () => {
    mockFetchOk({ id: 'ev_new', summary: 'Test' });

    await calendarFetch('/calendars/primary/events', {
      method: 'POST',
      body: JSON.stringify({ summary: 'Test' }),
    });

    const init = lastFetchInit();
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"summary":"Test"}');
    const headers = new Headers(init.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('does not set Content-Type when no body (e.g. DELETE)', async () => {
    mockFetchOk(null, 204);

    await calendarFetch('/calendars/primary/events/ev1', { method: 'DELETE' });

    const init = lastFetchInit();
    expect(init.method).toBe('DELETE');
    const headers = new Headers(init.headers);
    expect(headers.has('Content-Type')).toBe(false);
  });

  it('returns null (does not parse JSON) on 204', async () => {
    mockFetchOk(null, 204);

    const result = await calendarFetch('/calendars/primary/events/ev1', { method: 'DELETE' });

    expect(result).toBeNull();
  });

  it('does not override caller-provided Content-Type', async () => {
    mockFetchOk({ ok: true });

    await calendarFetch('/calendars/primary/events', {
      method: 'POST',
      body: 'raw',
      headers: { 'Content-Type': 'text/plain' },
    });

    const headers = new Headers(lastFetchInit().headers);
    expect(headers.get('Content-Type')).toBe('text/plain');
  });
});

// To exercise the tool handlers, we register them on a real McpServer and
// inspect the registered tool map. This catches schema or wiring regressions
// without spinning up stdio.
describe('registerTools', () => {
  function makeServer(): {
    server: McpServer;
    tools: Map<string, { description: string; handler: (args: unknown) => Promise<unknown> }>;
  } {
    const tools = new Map<string, { description: string; handler: (args: unknown) => Promise<unknown> }>();
    const server = new McpServer({ name: 'calendar-test', version: '0.0.0' });
    const orig = (server as unknown as { tool: (...args: unknown[]) => unknown }).tool.bind(server);
    (server as unknown as { tool: (...args: unknown[]) => unknown }).tool = (
      name: string,
      description: string,
      _schema: unknown,
      handler: (args: unknown) => Promise<unknown>,
    ): unknown => {
      tools.set(name, { description, handler });
      return orig(name, description, _schema, handler);
    };
    registerTools(server);
    return { server, tools };
  }

  it('registers all six tools', () => {
    const { tools } = makeServer();
    expect([...tools.keys()].sort()).toEqual([
      'calendar_create_event',
      'calendar_delete_event',
      'calendar_get_event',
      'calendar_list_calendars',
      'calendar_list_events',
      'calendar_update_event',
    ]);
  });

  it('calendar_create_event POSTs canonical event body to primary calendar', async () => {
    const { tools } = makeServer();
    mockFetchOk({ id: 'ev_new' });

    await tools.get('calendar_create_event')!.handler({
      summary: 'Sync',
      start: '2026-05-01T15:00:00-05:00',
      end: '2026-05-01T15:30:00-05:00',
      description: 'weekly',
      attendees: ['a@x.com', 'b@x.com'],
    });

    expect(lastFetchUrl()).toBe(`${BASE}/calendars/primary/events`);
    const init = lastFetchInit();
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      summary: 'Sync',
      description: 'weekly',
      start: { dateTime: '2026-05-01T15:00:00-05:00' },
      end: { dateTime: '2026-05-01T15:30:00-05:00' },
      attendees: [{ email: 'a@x.com' }, { email: 'b@x.com' }],
    });
  });

  it('calendar_create_event treats YYYY-MM-DD as all-day', async () => {
    const { tools } = makeServer();
    mockFetchOk({ id: 'ev_allday' });

    await tools.get('calendar_create_event')!.handler({
      summary: 'Holiday',
      start: '2026-07-04',
      end: '2026-07-05',
    });

    const body = JSON.parse(lastFetchInit().body as string);
    expect(body.start).toEqual({ date: '2026-07-04' });
    expect(body.end).toEqual({ date: '2026-07-05' });
  });

  it('calendar_create_event includes timeZone in start/end when provided', async () => {
    const { tools } = makeServer();
    mockFetchOk({ id: 'ev_tz' });

    await tools.get('calendar_create_event')!.handler({
      summary: 'TZ',
      start: '2026-05-01T15:00:00',
      end: '2026-05-01T15:30:00',
      timeZone: 'America/Chicago',
    });

    const body = JSON.parse(lastFetchInit().body as string);
    expect(body.start).toEqual({ dateTime: '2026-05-01T15:00:00', timeZone: 'America/Chicago' });
    expect(body.end).toEqual({ dateTime: '2026-05-01T15:30:00', timeZone: 'America/Chicago' });
  });

  it('calendar_create_event appends sendUpdates as query param', async () => {
    const { tools } = makeServer();
    mockFetchOk({ id: 'ev_su' });

    await tools.get('calendar_create_event')!.handler({
      summary: 'Notify',
      start: '2026-05-01T15:00:00-05:00',
      end: '2026-05-01T15:30:00-05:00',
      sendUpdates: 'all',
    });

    expect(lastFetchUrl()).toBe(`${BASE}/calendars/primary/events?sendUpdates=all`);
  });

  it('calendar_create_event honors non-default calendarId', async () => {
    const { tools } = makeServer();
    mockFetchOk({ id: 'ev_cal' });

    await tools.get('calendar_create_event')!.handler({
      calendarId: 'work@example.com',
      summary: 'X',
      start: '2026-05-01T15:00:00Z',
      end: '2026-05-01T16:00:00Z',
    });

    expect(lastFetchUrl()).toBe(`${BASE}/calendars/work%40example.com/events`);
  });

  it('calendar_update_event PATCHes only supplied fields', async () => {
    const { tools } = makeServer();
    mockFetchOk({ id: 'ev1', summary: 'New title' });

    await tools.get('calendar_update_event')!.handler({
      eventId: 'ev1',
      summary: 'New title',
    });

    expect(lastFetchUrl()).toBe(`${BASE}/calendars/primary/events/ev1`);
    const init = lastFetchInit();
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ summary: 'New title' });
    expect(body).not.toHaveProperty('start');
    expect(body).not.toHaveProperty('end');
  });

  it('calendar_update_event passes sendUpdates query param', async () => {
    const { tools } = makeServer();
    mockFetchOk({ id: 'ev1' });

    await tools.get('calendar_update_event')!.handler({
      eventId: 'ev1',
      summary: 'x',
      sendUpdates: 'externalOnly',
    });

    expect(lastFetchUrl()).toBe(
      `${BASE}/calendars/primary/events/ev1?sendUpdates=externalOnly`,
    );
  });

  it('calendar_delete_event DELETEs and returns success message on 204', async () => {
    const { tools } = makeServer();
    mockFetchOk(null, 204);

    const result = (await tools.get('calendar_delete_event')!.handler({
      eventId: 'ev1',
    })) as { content: { type: string; text: string }[] };

    expect(lastFetchUrl()).toBe(`${BASE}/calendars/primary/events/ev1`);
    expect(lastFetchInit().method).toBe('DELETE');
    expect(result.content[0].text).toContain('Deleted event ev1');
  });

  it('calendar_delete_event passes sendUpdates query param', async () => {
    const { tools } = makeServer();
    mockFetchOk(null, 204);

    await tools.get('calendar_delete_event')!.handler({
      eventId: 'ev1',
      sendUpdates: 'all',
    });

    expect(lastFetchUrl()).toBe(`${BASE}/calendars/primary/events/ev1?sendUpdates=all`);
  });
});
