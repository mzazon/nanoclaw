import { layout } from '../layout.js';

export function credentialsPage(): string {
  return layout(
    'Credentials',
    '/dashboard/credentials',
    `
    <h2 class="page-title">Credentials</h2>
    <div id="content"><div class="loading">Loading...</div></div>
    <script>
    (async () => {
      try {
        var data = await api('/api/credentials');

        if (!data || !data.available) {
          document.getElementById('content').innerHTML =
            '<div style="background:#3a3a1a;border:1px solid #facc15;color:#facc15;border-radius:8px;padding:16px;margin-bottom:24px">' +
            'OneCLI is not available. Configure ONECLI_URL in .env to enable credential management.' +
            '</div>';
          return;
        }

        var html = '';

        // Agents table
        html += '<h3 class="section-title">Agents</h3>';
        if (data.agents.length === 0) {
          html += '<div class="loading">No agents registered</div>';
        } else {
          html += '<table><tr>' +
            '<th>Name</th>' +
            '<th>Agent Group</th>' +
            '<th>Secret Mode</th>' +
            '<th>Secrets</th>' +
            '</tr>';
          for (var i = 0; i < data.agents.length; i++) {
            var a = data.agents[i];
            var modeColor = a.secret_mode === 'all' ? 'green' : (a.secret_mode === 'none' ? 'red' : 'yellow');
            html += '<tr>' +
              '<td>' + esc(a.name) + '</td>' +
              '<td><a href="/dashboard/agent-groups?id=' + esc(a.agent_group_id) + '">' + esc(a.agent_group_id) + '</a></td>' +
              '<td>' + badge(a.secret_mode, modeColor) + '</td>' +
              '<td>' + esc(String(a.secret_count)) + '</td>' +
              '</tr>';
          }
          html += '</table>';
        }

        // Vault Secrets table
        html += '<h3 class="section-title">Vault Secrets</h3>';
        if (data.secrets.length === 0) {
          html += '<div class="loading">No secrets in vault</div>';
        } else {
          html += '<table><tr>' +
            '<th>Name</th>' +
            '<th>Host Patterns</th>' +
            '</tr>';
          for (var j = 0; j < data.secrets.length; j++) {
            var s = data.secrets[j];
            var patterns = '';
            if (s.host_patterns && s.host_patterns.length > 0) {
              patterns = s.host_patterns.map(function(p) { return '<code style="background:#2a2a2a;padding:2px 6px;border-radius:3px;font-size:12px">' + esc(p) + '</code>'; }).join(' ');
            } else {
              patterns = '<span style="color:#666">none</span>';
            }
            html += '<tr>' +
              '<td>' + esc(s.name) + '</td>' +
              '<td>' + patterns + '</td>' +
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
