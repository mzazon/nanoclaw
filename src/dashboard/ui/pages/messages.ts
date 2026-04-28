import { layout } from '../layout.js';

export function messagesPage(): string {
  return layout(
    'Messages',
    '/dashboard/messages',
    `
    <style>
      .msg-row { display: flex; margin-bottom: var(--space-2); }
      .msg-row.inbound { justify-content: flex-start; }
      .msg-row.outbound { justify-content: flex-end; }
      .msg-row.system { justify-content: center; }
      .msg-bubble { max-width: 75%; padding: var(--space-3) var(--space-4); border-radius: var(--radius-lg); font-size: var(--font-size-base); line-height: 1.5; }
      .msg-inbound { background: var(--bg-surface); border: 1px solid var(--border-subtle); }
      .msg-outbound { background: var(--accent-subtle); border: 1px solid var(--border-subtle); }
      .msg-system { max-width: 90%; margin: 0 auto; background: var(--bg-inset); border: 1px dashed var(--border-default); text-align: center; font-size: var(--font-size-sm); }
      .msg-sender { font-size: var(--font-size-xs); color: var(--text-muted); margin-bottom: 2px; font-weight: 500; }
      .msg-time { font-size: var(--font-size-xs); color: var(--text-muted); margin-top: 4px; }
      .msg-kind { font-size: var(--font-size-xs); color: var(--text-muted); font-style: italic; margin-bottom: 2px; }
      .msg-content { color: var(--text-primary); white-space: pre-wrap; word-break: break-word; }
      #conv-wrap { padding: 8px 0; }
    </style>
    <h2 class="page-title">Messages</h2>
    <div id="selector" style="margin-bottom:16px">
      <span style="color:var(--text-secondary);font-size:13px">Select a session from the </span>
      <a href="/dashboard/sessions">Sessions page</a>
      <span style="color:var(--text-secondary);font-size:13px"> to view messages, or use query params: ?agentGroupId=X&sessionId=Y</span>
    </div>
    <div id="content"></div>
    <script>
    (async () => {
      const params = new URLSearchParams(location.search);
      const agentGroupId = params.get('agentGroupId');
      const sessionId = params.get('sessionId');

      if (!agentGroupId || !sessionId) {
        // Load session list for quick selection
        try {
          const sessions = await api('/api/sessions');
          const active = sessions.filter(s => s.status === 'active');
          if (active.length > 0) {
            let html = '<h3 class="section-title">Active Sessions</h3><table><tr><th>Agent</th><th>Channel</th><th>Last Active</th><th></th></tr>';
            for (const s of active) {
              html += '<tr><td>' + esc(s.agent_group_name || s.agent_group_id) + '</td>' +
                '<td>' + (s.channel_type ? badge(s.channel_type, 'blue') : '-') + '</td>' +
                '<td>' + timeAgo(s.last_active) + '</td>' +
                '<td><a href="/dashboard/messages?agentGroupId=' + esc(s.agent_group_id) + '&sessionId=' + esc(s.id) + '">View messages</a></td></tr>';
            }
            html += '</table>';
            document.getElementById('content').innerHTML = html;
          }
        } catch (e) {}
        return;
      }

      document.getElementById('selector').innerHTML =
        '<a href="/dashboard/messages">&larr; Back</a> ' +
        '<span style="color:var(--text-muted);font-size:12px">Session: ' + esc(sessionId) + '</span>';

      document.getElementById('content').innerHTML = '<div class="loading">Loading messages...</div>';

      try {
        const data = await api('/api/messages?agentGroupId=' + encodeURIComponent(agentGroupId) + '&sessionId=' + encodeURIComponent(sessionId));

        // Merge inbound + outbound, sort by timestamp (ISO strings sort lexicographically)
        const all = [
          ...data.inbound.map(m => ({ ...m, direction: 'inbound' })),
          ...data.outbound.map(m => ({ ...m, direction: 'outbound' })),
        ].sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

        if (all.length === 0) {
          document.getElementById('content').innerHTML = '<div class="loading">No messages in this session</div>';
          return;
        }

        let html = '<div id="conv-wrap">';
        for (const m of all) {
          const isSystem = m.kind === 'system' || m.kind === 'task';
          const rowClass = isSystem ? 'system' : m.direction;
          const bubbleClass = isSystem ? 'msg-system' : (m.direction === 'inbound' ? 'msg-inbound' : 'msg-outbound');

          // Parse content JSON
          let content = m.content || '';
          let sender = '';
          try {
            const parsed = JSON.parse(content);
            sender = parsed.sender || parsed.senderId || parsed.user || '';
            if (parsed.text) {
              content = parsed.text;
            } else if (parsed.type) {
              content = '[' + parsed.type + '] ' + (parsed.text || JSON.stringify(parsed).slice(0, 300));
            } else {
              content = JSON.stringify(parsed).slice(0, 400);
            }
          } catch {
            content = content.slice(0, 400);
          }

          // Format timestamp to short HH:MM:SS
          let timeStr = '';
          if (m.timestamp) {
            try {
              timeStr = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            } catch {
              timeStr = m.timestamp;
            }
          }

          const kindLabel = m.kind && m.kind !== 'message' ? '<div class="msg-kind">' + esc(m.kind) + '</div>' : '';
          const senderLabel = sender ? '<div class="msg-sender">' + esc(sender) + '</div>' : '';
          const timeLabel = timeStr ? '<div class="msg-time">' + esc(timeStr) + '</div>' : '';

          html += '<div class="msg-row ' + rowClass + '">' +
            '<div class="msg-bubble ' + bubbleClass + '">' +
            senderLabel +
            kindLabel +
            '<div class="msg-content">' + esc(content) + '</div>' +
            timeLabel +
            '</div>' +
            '</div>';
        }
        html += '</div>';
        document.getElementById('content').innerHTML = html;
      } catch (e) {
        document.getElementById('content').innerHTML = '<div class="loading">Error: ' + esc(e.message) + '</div>';
      }
    })();
    </script>
  `,
  );
}
