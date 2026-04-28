import { layout } from '../layout.js';

export function containersPage(): string {
  return layout(
    'Containers',
    '/dashboard/containers',
    `
    <h2 class="page-title">Containers</h2>
    <div id="content"><div class="loading">Loading...</div></div>
    <script>
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

          html += '<tr>' +
            '<td><a href="/dashboard/agent-groups?id=' + esc(c.agent_group_id) + '">' + esc(c.agent_group_name || c.agent_group_id) + '</a></td>' +
            '<td style="font-family:monospace;font-size:12px">' + esc(truncId(c.container_id, 12)) + '</td>' +
            '<td>' + statusBadge + '</td>' +
            '<td style="font-size:12px">' + esc(c.image || '-') + '</td>' +
            '<td>' + cpuCell + '</td>' +
            '<td>' + memCell + '</td>' +
            '<td>' + toolCell + '</td>' +
            '<td>' + hbCell + '</td>' +
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
