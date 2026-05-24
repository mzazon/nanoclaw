/**
 * Tests for the Gmail MCP server's fetch logic.
 *
 * Mocks globalThis.fetch to return canned responses and verifies
 * gmailFetch constructs correct URLs and handles errors.
 */
import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import { gmailFetch } from './gmail-mcp-stdio';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

let fetchSpy: ReturnType<typeof spyOn>;

function mockFetchOk(data: unknown) {
  fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(data), { status: 200 }),
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

describe('gmailFetch', () => {
  it('constructs correct URL for thread search', async () => {
    mockFetchOk({ threads: [{ id: 't1', snippet: 'hello' }] });

    const result = await gmailFetch('/threads?q=from%3Aalice&maxResults=5');

    expect(fetchSpy).toHaveBeenCalledWith(
      `${BASE}/threads?q=from%3Aalice&maxResults=5`,
    );
    expect(result).toEqual({ threads: [{ id: 't1', snippet: 'hello' }] });
  });

  it('constructs correct URL for get thread', async () => {
    mockFetchOk({ id: 't1', messages: [] });

    await gmailFetch('/threads/t1?format=full');

    expect(fetchSpy).toHaveBeenCalledWith(`${BASE}/threads/t1?format=full`);
  });

  it('constructs correct URL for get message', async () => {
    mockFetchOk({ id: 'm1' });

    await gmailFetch('/messages/m1?format=full');

    expect(fetchSpy).toHaveBeenCalledWith(`${BASE}/messages/m1?format=full`);
  });

  it('constructs correct URL for get attachment', async () => {
    mockFetchOk({ data: 'base64data' });

    await gmailFetch('/messages/m1/attachments/a1');

    expect(fetchSpy).toHaveBeenCalledWith(`${BASE}/messages/m1/attachments/a1`);
  });

  it('constructs correct URL for list labels', async () => {
    mockFetchOk({ labels: [{ id: 'INBOX', name: 'INBOX' }] });

    await gmailFetch('/labels');

    expect(fetchSpy).toHaveBeenCalledWith(`${BASE}/labels`);
  });

  it('throws on non-ok response with status and body', async () => {
    mockFetchError(401, 'Unauthorized');

    await expect(gmailFetch('/labels')).rejects.toThrow('Gmail API 401: Unauthorized');
  });

  it('throws on 403 with error details', async () => {
    mockFetchError(403, '{"error": "insufficient_scope"}');

    await expect(gmailFetch('/threads?q=test')).rejects.toThrow(
      'Gmail API 403: {"error": "insufficient_scope"}',
    );
  });
});

describe('tool URL construction', () => {
  it('search threads encodes query and applies maxResults', async () => {
    mockFetchOk({ threads: [] });

    const query = 'from:alice subject:meeting';
    const maxResults = 5;
    await gmailFetch(`/threads?q=${encodeURIComponent(query)}&maxResults=${maxResults}`);

    expect(fetchSpy).toHaveBeenCalledWith(
      `${BASE}/threads?q=from%3Aalice%20subject%3Ameeting&maxResults=5`,
    );
  });

  it('search threads defaults maxResults to 10', async () => {
    mockFetchOk({ threads: [] });

    const query = 'test';
    const maxResults = 10;
    await gmailFetch(`/threads?q=${encodeURIComponent(query)}&maxResults=${maxResults}`);

    expect(fetchSpy).toHaveBeenCalledWith(
      `${BASE}/threads?q=test&maxResults=10`,
    );
  });
});
