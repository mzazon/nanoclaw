import { layout } from '../layout.js';

export function errorsPage(): string {
  return layout(
    'Error Log',
    '/dashboard/errors',
    `
    <h2 class="page-title">Error Log</h2>
    <div style="display:flex;gap:12px;margin-bottom:16px;align-items:center">
      <input id="filter" type="text" placeholder="Filter errors..."
        style="background:#1a1a1a;color:#e0e0e0;border:1px solid #2a2a2a;border-radius:4px;padding:6px 10px;font-size:13px;flex:1;max-width:400px"
        oninput="applyFilter()">
      <button onclick="loadErrors()"
        style="background:#1a2a3a;color:#7eb8da;border:1px solid #7eb8da;border-radius:4px;padding:6px 14px;font-size:13px;cursor:pointer;font-weight:600">Refresh</button>
    </div>
    <div id="content"><div class="loading">Loading...</div></div>
    <script>
    var allErrors = [];

    async function loadErrors() {
      try {
        allErrors = await api('/api/errors');
        applyFilter();
      } catch (e) {
        document.getElementById('content').innerHTML = '<div class="loading">Error: ' + esc(e.message) + '</div>';
      }
    }

    function applyFilter() {
      var query = (document.getElementById('filter').value || '').toLowerCase();
      var filtered = allErrors;
      if (query) {
        filtered = allErrors.filter(function(e) {
          return (e.level + ' ' + e.message).toLowerCase().indexOf(query) !== -1;
        });
      }

      if (filtered.length === 0) {
        document.getElementById('content').innerHTML = '<div class="loading">No error log entries' +
          (query ? ' matching filter' : '') + '</div>';
        return;
      }

      var html = '<table><tr>' +
        '<th>Time</th>' +
        '<th>Level</th>' +
        '<th>Message</th>' +
        '</tr>';

      for (var i = 0; i < filtered.length; i++) {
        var e = filtered[i];
        var levelColor = 'gray';
        if (e.level === 'ERROR') levelColor = 'red';
        else if (e.level === 'WARN') levelColor = 'yellow';

        var timeCell = e.timestamp
          ? '<span title="' + esc(e.timestamp) + '">' + timeAgo(e.timestamp) + '</span>'
          : '<span style="color:#555">-</span>';

        html += '<tr>' +
          '<td style="white-space:nowrap">' + timeCell + '</td>' +
          '<td>' + badge(e.level, levelColor) + '</td>' +
          '<td style="font-family:monospace;font-size:12px;word-break:break-all">' + esc(e.message) + '</td>' +
          '</tr>';
      }
      html += '</table>';
      document.getElementById('content').innerHTML = html;
    }

    loadErrors();
    </script>
  `,
  );
}
