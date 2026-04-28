import { layout } from '../layout.js';

export function mountsPage(): string {
  return layout(
    'Mounts',
    '/dashboard/mounts',
    `
    <h2 class="page-title">Mounts</h2>
    <div id="content"><div class="loading">Loading...</div></div>
    <script>
    (async () => {
      try {
        var data = await api('/api/mounts');

        var html = '';

        // Allowlisted mounts
        html += '<h3 class="section-title">Allowlisted Paths</h3>';
        if (!data.entries || data.entries.length === 0) {
          html += '<div class="loading">No entries in mount allowlist (' +
            '<code style="background:var(--bg-elevated);padding:2px 6px;border-radius:3px;font-size:12px">~/.config/nanoclaw/mount-allowlist.json</code>)</div>';
        } else {
          html += '<table><tr>' +
            '<th>Path</th>' +
            '<th>Access</th>' +
            '<th>Used By</th>' +
            '</tr>';
          for (var i = 0; i < data.entries.length; i++) {
            var e = data.entries[i];
            var accessBadge = e.allowReadWrite
              ? badge('read-write', 'yellow')
              : badge('read-only', 'green');
            var usedBy = '';
            if (e.usedBy && e.usedBy.length > 0) {
              usedBy = e.usedBy.map(function(name) { return badge(name, 'blue'); }).join(' ');
            } else {
              usedBy = '<span style="color:var(--text-muted)">unused</span>';
            }
            html += '<tr>' +
              '<td><code style="font-family:var(--font-mono);font-size:12px;color:var(--text-primary)">' + esc(e.path) + '</code></td>' +
              '<td>' + accessBadge + '</td>' +
              '<td>' + usedBy + '</td>' +
              '</tr>';
          }
          html += '</table>';
        }

        // Mounts used by groups but not in the allowlist
        if (data.unlisted && data.unlisted.length > 0) {
          html += '<h3 class="section-title">Mounts Not in Allowlist</h3>';
          html += '<div style="background:var(--status-warning-bg);border:1px solid var(--status-warning);' +
            'color:var(--status-warning);border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:13px">' +
            'These paths are used in agent group container configs but are not listed in the mount allowlist. ' +
            'They will be blocked by the host at container launch time.' +
            '</div>';
          html += '<table><tr>' +
            '<th>Path</th>' +
            '<th>Used By</th>' +
            '</tr>';
          for (var j = 0; j < data.unlisted.length; j++) {
            var u = data.unlisted[j];
            var usedByU = u.usedBy.map(function(name) { return badge(name, 'red'); }).join(' ');
            html += '<tr>' +
              '<td><code style="font-family:var(--font-mono);font-size:12px;color:var(--status-warning)">' + esc(u.path) + '</code></td>' +
              '<td>' + usedByU + '</td>' +
              '</tr>';
          }
          html += '</table>';
        }

        document.getElementById('content').innerHTML = html;

      } catch (e) {
        document.getElementById('content').innerHTML = '<div class="loading">Error: ' + esc(e.message) + '</div>';
      }
    })();
    </script>
  `,
  );
}
