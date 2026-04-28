import { layout } from '../layout.js';

export function containersPage(): string {
  return layout(
    'Containers',
    '/dashboard/containers',
    `
    <style>
      .log-panel {
        background: var(--bg-inset);
        border: 1px solid var(--border-default);
        border-radius: var(--radius-lg);
        padding: var(--space-3);
        margin-top: var(--space-4);
      }
      .log-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--space-3);
      }
      .log-panel-title {
        font-size: var(--font-size-sm);
        font-weight: 600;
        color: var(--text-secondary);
      }
      .log-panel-body {
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        padding: var(--space-3);
        font-family: var(--font-mono);
        font-size: var(--font-size-sm);
        height: 360px;
        overflow-y: auto;
        line-height: 1.6;
      }
      .log-panel-body .log-line { white-space: pre-wrap; word-break: break-all; }
      .log-panel-body .log-line:hover { background: var(--bg-hover); }
      .log-status {
        font-size: var(--font-size-xs);
        color: var(--text-muted);
        font-style: italic;
      }
    </style>
    <h2 class="page-title">Containers</h2>
    <div id="content"><div class="loading">Loading...</div></div>
    <div id="log-panel" style="display:none"></div>
    <script>
    var _logInterval = null;
    var _logSessionId = null;

    function closeLogs() {
      if (_logInterval) { clearInterval(_logInterval); _logInterval = null; }
      _logSessionId = null;
      document.getElementById('log-panel').style.display = 'none';
      document.getElementById('log-panel').innerHTML = '';
    }

    function openLogs(sessionId, agentName) {
      // If same session already open, just close it (toggle)
      if (_logSessionId === sessionId) { closeLogs(); return; }
      // Clear any prior poll before starting new one
      if (_logInterval) { clearInterval(_logInterval); _logInterval = null; }

      _logSessionId = sessionId;
      var panel = document.getElementById('log-panel');
      panel.innerHTML =
        '<div class="log-panel">' +
        '<div class="log-panel-header">' +
        '<span class="log-panel-title">Logs — ' + esc(agentName) + '</span>' +
        '<div style="display:flex;align-items:center;gap:8px">' +
        '<span class="log-status" id="log-status">Loading...</span>' +
        '<button class="btn btn-outline btn-sm" onclick="closeLogs()">Close</button>' +
        '</div>' +
        '</div>' +
        '<div class="log-panel-body" id="log-body"></div>' +
        '</div>';
      panel.style.display = 'block';

      async function fetchLogs() {
        if (_logSessionId !== sessionId) return; // stale
        try {
          var data = await api('/api/containers/' + encodeURIComponent(sessionId) + '/logs?tail=200');
          if (_logSessionId !== sessionId) return; // stale after await
          var body = document.getElementById('log-body');
          if (!body) return;
          var atBottom = body.scrollHeight - body.scrollTop <= body.clientHeight + 40;
          body.innerHTML = data.lines.map(function(l) {
            return '<div class="log-line">' + esc(l) + '</div>';
          }).join('');
          if (atBottom) body.scrollTop = body.scrollHeight;
          var statusEl = document.getElementById('log-status');
          if (statusEl) statusEl.textContent = 'Refreshed ' + new Date().toLocaleTimeString();
        } catch (e) {
          var statusEl2 = document.getElementById('log-status');
          if (statusEl2) statusEl2.textContent = 'Error: ' + esc(e.message);
        }
      }

      fetchLogs();
      _logInterval = setInterval(fetchLogs, 5000);
    }

    (async () => {
      try {
        var data = await api('/api/containers');
        if (!data || data.length === 0) {
          document.getElementById('content').innerHTML = '<div class="loading">No running containers</div>';
          return;
        }

        var html = '<table><tr>' +
          '<th>Agent Group</th>' +
          '<th>Container ID</th>' +
          '<th>Status</th>' +
          '<th>Image</th>' +
          '<th>CPU%</th>' +
          '<th>Memory</th>' +
          '<th>Current Tool</th>' +
          '<th>Heartbeat</th>' +
          '<th>Logs</th>' +
          '</tr>';

        for (var i = 0; i < data.length; i++) {
          var c = data[i];

          var statusBadge = c.status === 'running' ? badge('running', 'green') : badge(c.status || 'stopped', 'gray');

          var cpuCell = c.cpu_percent != null ? esc(c.cpu_percent.toFixed(1) + '%') : '<span style="color:var(--text-muted)">-</span>';

          var memCell = '<span style="color:var(--text-muted)">-</span>';
          if (c.memory_usage != null) {
            memCell = esc(fmtBytes(c.memory_usage));
            if (c.memory_limit) memCell += ' / ' + esc(fmtBytes(c.memory_limit));
          }

          var toolCell = '<span style="color:var(--text-muted)">idle</span>';
          if (c.current_tool) {
            var elapsed = '';
            if (c.tool_started_at) {
              var secs = Math.floor((Date.now() - new Date(c.tool_started_at).getTime()) / 1000);
              elapsed = ' (' + secs + 's)';
            }
            toolCell = badge(c.current_tool, 'blue') + '<span style="color:var(--text-secondary);font-size:11px">' + esc(elapsed) + '</span>';
          }

          var hbCell = '<span style="color:var(--text-muted)">-</span>';
          if (c.heartbeat_age != null) {
            var age = c.heartbeat_age;
            var hbColor = age < 60 ? 'green' : age < 120 ? 'yellow' : 'red';
            hbCell = badge(age + 's', hbColor);
          }

          var logsCell = '<span style="color:var(--text-muted)">-</span>';
          if (c.status === 'running' && c.session_id) {
            logsCell = '<button class="btn btn-outline btn-sm" onclick="openLogs(' +
              JSON.stringify(c.session_id) + ',' +
              JSON.stringify(c.agent_group_name || c.agent_group_id) +
              ')">Logs</button>';
          }

          html += '<tr>' +
            '<td><a href="/dashboard/agent-groups?id=' + esc(c.agent_group_id) + '">' + esc(c.agent_group_name || c.agent_group_id) + '</a></td>' +
            '<td style="font-family:monospace;font-size:12px">' + esc(truncId(c.container_id, 12)) + '</td>' +
            '<td>' + statusBadge + '</td>' +
            '<td style="font-size:12px">' + esc(c.image || '-') + '</td>' +
            '<td>' + cpuCell + '</td>' +
            '<td>' + memCell + '</td>' +
            '<td>' + toolCell + '</td>' +
            '<td>' + hbCell + '</td>' +
            '<td>' + logsCell + '</td>' +
            '</tr>';
        }
        html += '</table>';
        document.getElementById('content').innerHTML = html;

      } catch (e) {
        document.getElementById('content').innerHTML = '<div class="loading">Error: ' + esc(e.message) + '</div>';
      }
    })();

    function fmtBytes(b) {
      if (b == null) return '?';
      if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GiB';
      if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MiB';
      if (b >= 1024) return (b / 1024).toFixed(1) + ' KiB';
      return b + ' B';
    }
    </script>
  `,
  );
}
