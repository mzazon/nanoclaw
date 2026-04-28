import { layout } from '../layout.js';

export function agentGroupsPage(): string {
  return layout(
    'Agent Groups',
    '/dashboard/agent-groups',
    `
    <h2 class="page-title">Agent Groups</h2>
    <div id="content"><div class="loading">Loading...</div></div>
    <div id="detail" style="display:none"></div>
    <script>
    (async () => {
      const params = new URLSearchParams(location.search);
      const detailId = params.get('id');

      if (detailId) {
        await loadDetail(detailId);
      } else {
        await loadList();
      }
    })();

    async function loadList() {
      try {
        const groups = await api('/api/agent-groups');
        if (groups.length === 0) {
          document.getElementById('content').innerHTML = '<div class="loading">No agent groups configured</div>';
          return;
        }
        document.getElementById('content').innerHTML =
          '<table><tr><th>Name</th><th>Folder</th><th>Sessions</th><th>Running</th><th>Created</th></tr>' +
          groups.map(g =>
            '<tr><td><a href="/dashboard/agent-groups?id=' + esc(g.id) + '">' + esc(g.name) + '</a></td>' +
            '<td>' + esc(g.folder) + '</td>' +
            '<td>' + g.sessionCount + '</td>' +
            '<td>' + (g.runningSessions > 0 ? badge(g.runningSessions, 'green') : badge('0', 'gray')) + '</td>' +
            '<td style="color:var(--text-muted)">' + esc(g.created_at) + '</td></tr>'
          ).join('') + '</table>';
      } catch (e) {
        document.getElementById('content').innerHTML = '<div class="loading">Error: ' + esc(e.message) + '</div>';
      }
    }

    async function loadDetail(id) {
      document.getElementById('content').innerHTML = '<a href="/dashboard/agent-groups">&larr; Back to list</a>';
      document.getElementById('detail').style.display = 'block';

      // Render tabs bar
      const tabsHtml =
        '<div class="tabs" id="detail-tabs">' +
          '<div class="tab active" data-tab="details" onclick="switchTab(\'details\')">Details</div>' +
          '<div class="tab" data-tab="config" onclick="switchTab(\'config\')">Config</div>' +
        '</div>' +
        '<div id="tab-details"></div>' +
        '<div id="tab-config" style="display:none"></div>';
      document.getElementById('detail').innerHTML = tabsHtml;

      // Load the details tab content
      loadDetailsTab(id);
    }

    function switchTab(tab) {
      document.querySelectorAll('#detail-tabs .tab').forEach(function(el) {
        el.classList.toggle('active', el.getAttribute('data-tab') === tab);
      });
      document.getElementById('tab-details').style.display = tab === 'details' ? '' : 'none';
      document.getElementById('tab-config').style.display = tab === 'config' ? '' : 'none';
      if (tab === 'config' && !document.getElementById('tab-config').dataset.loaded) {
        const params = new URLSearchParams(location.search);
        const id = params.get('id');
        loadConfigTab(id);
      }
    }

    async function loadDetailsTab(id) {
      try {
        const data = await api('/api/agent-groups/' + encodeURIComponent(id));
        const g = data.group;
        let html = '<h2 class="page-title">' + esc(g.name) + '</h2>';

        // Info panel
        html += '<div class="detail-panel">';
        html += detailRow('ID', g.id);
        html += detailRow('Folder', g.folder);
        html += detailRow('Provider', g.agent_provider || 'default');
        html += detailRow('Created', g.created_at);
        if (g.container_config) {
          const cc = g.container_config;
          if (cc.packages) {
            const pkgs = [...(cc.packages.apt || []), ...(cc.packages.npm || [])];
            if (pkgs.length) html += detailRow('Packages', pkgs.join(', '));
          }
          if (cc.mcpServers) {
            html += detailRow('MCP Servers', Object.keys(cc.mcpServers).join(', '));
          }
        }
        html += '</div>';

        // Sessions
        html += '<h3 class="section-title">Sessions (' + data.sessions.length + ')</h3>';
        if (data.sessions.length > 0) {
          html += '<table><tr><th>ID</th><th>Status</th><th>Container</th><th>Last Active</th></tr>';
          for (const s of data.sessions) {
            const statusBadge = s.status === 'active' ? badge('active', 'green') : badge(s.status, 'gray');
            const containerBadge = s.container_status === 'running' ? badge('running', 'green') :
              s.container_status === 'idle' ? badge('idle', 'yellow') : badge(s.container_status, 'gray');
            html += '<tr><td style="font-size:11px;color:var(--text-muted)" title="' + esc(s.id) + '">' + esc(truncId(s.id, 28)) + '</td><td>' + statusBadge + '</td><td>' + containerBadge + '</td><td>' + timeAgo(s.last_active) + '</td></tr>';
          }
          html += '</table>';
        }

        // Messaging groups (wirings)
        html += '<h3 class="section-title">Channel Wirings (' + data.wirings.length + ')</h3>';
        if (data.wirings.length > 0) {
          html += '<table><tr><th>Channel</th><th>Name / ID</th><th>Policy</th><th>Priority</th></tr>';
          for (const w of data.wirings) {
            const wName = w.mg_name || friendlyId(w.channel_type, w.platform_id);
            const policy = w.unknown_sender_policy || 'strict';
            html += '<tr><td>' + badge(w.channel_type, 'blue') + '</td>' +
              '<td><span style="font-weight:500">' + esc(wName) + '</span><div style="font-size:11px;color:var(--text-muted)" title="' + esc(w.platform_id) + '">' + esc(truncId(w.platform_id, 35)) + '</div></td>' +
              '<td>' + badge(policy, policy === 'public' ? 'green' : policy === 'strict' ? 'red' : 'yellow') + '</td>' +
              '<td>' + w.priority + '</td></tr>';
          }
          html += '</table>';
        }

        // Destinations
        html += '<h3 class="section-title">Destinations (' + data.destinations.length + ')</h3>';
        if (data.destinations.length > 0) {
          html += '<table><tr><th>Name</th><th>Type</th><th>Target</th></tr>';
          for (const d of data.destinations) {
            html += '<tr><td>' + esc(d.local_name) + '</td><td>' + badge(d.target_type, d.target_type === 'channel' ? 'blue' : 'purple') + '</td><td style="font-size:11px" title="' + esc(d.target_id) + '">' + esc(truncId(d.target_id, 30)) + '</td></tr>';
          }
          html += '</table>';
        }

        // Members & Admins
        html += '<h3 class="section-title">Members (' + data.members.length + ') &amp; Admins (' + data.admins.length + ')</h3>';
        if (data.admins.length > 0 || data.members.length > 0) {
          html += '<table><tr><th>User</th><th>Role</th><th>Since</th></tr>';
          for (const a of data.admins) {
            html += '<tr><td>' + esc(a.display_name || a.user_id) + '</td><td>' + badge('admin', 'purple') + '</td><td>' + esc(a.granted_at) + '</td></tr>';
          }
          for (const m of data.members) {
            html += '<tr><td>' + esc(m.display_name || m.user_id) + '</td><td>' + badge('member', 'gray') + '</td><td>' + esc(m.added_at) + '</td></tr>';
          }
          html += '</table>';
        }

        document.getElementById('tab-details').innerHTML = html;
      } catch (e) {
        document.getElementById('tab-details').innerHTML = '<div class="loading">Error: ' + esc(e.message) + '</div>';
      }
    }

    async function loadConfigTab(id) {
      const el = document.getElementById('tab-config');
      el.innerHTML = '<div class="loading">Loading config...</div>';
      try {
        const data = await api('/api/agent-groups/' + encodeURIComponent(id) + '/config');
        el.dataset.loaded = '1';
        let html = '';

        // CLAUDE.md section
        html += collapsible('CLAUDE.md',
          data.claude_md
            ? '<pre class="code-block">' + esc(data.claude_md) + '</pre>'
            : '<div class="loading">No CLAUDE.md found</div>',
          true
        );

        // container.json section
        html += collapsible('container.json',
          data.container_json !== null
            ? '<pre class="code-block">' + esc(JSON.stringify(data.container_json, null, 2)) + '</pre>'
            : '<div class="loading">No container.json found</div>',
          true
        );

        // Skills section
        let skillsContent;
        if (data.skills && data.skills.length > 0) {
          skillsContent = '<ul style="list-style:none;padding:0;margin:0">';
          for (const sk of data.skills) {
            skillsContent += '<li style="padding:6px 0;border-bottom:1px solid var(--border-subtle);color:var(--text-secondary);font-size:var(--font-size-base)">' +
              '<span style="font-weight:500">' + esc(sk.name) + '</span>' +
              '<span style="color:var(--text-muted);font-size:var(--font-size-xs);margin-left:8px">' + sk.size + ' B</span>' +
              '</li>';
          }
          skillsContent += '</ul>';
        } else {
          skillsContent = '<div class="loading">No skills found</div>';
        }
        html += collapsible('Skills', skillsContent, true);

        el.innerHTML = html;
      } catch (e) {
        el.innerHTML = '<div class="loading">Error: ' + esc(e.message) + '</div>';
      }
    }

    function collapsible(title, content, open) {
      const id = 'collapse-' + title.replace(/[^a-z0-9]/gi, '-').toLowerCase();
      return '<div style="margin-bottom:16px;border:1px solid var(--border-subtle);border-radius:var(--radius-lg);background:var(--bg-surface)">' +
        '<div onclick="toggleCollapse(\'' + id + '\')" style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;cursor:pointer;font-weight:600;color:var(--text-secondary);font-size:var(--font-size-base)">' +
          '<span>' + esc(title) + '</span>' +
          '<span id="' + id + '-arrow" style="font-size:10px;color:var(--text-muted)">' + (open ? '&#9650;' : '&#9660;') + '</span>' +
        '</div>' +
        '<div id="' + id + '" style="' + (open ? '' : 'display:none;') + 'padding:0 16px 16px">' +
          content +
        '</div>' +
      '</div>';
    }

    function toggleCollapse(id) {
      const el = document.getElementById(id);
      const arrow = document.getElementById(id + '-arrow');
      if (el.style.display === 'none') {
        el.style.display = '';
        arrow.innerHTML = '&#9650;';
      } else {
        el.style.display = 'none';
        arrow.innerHTML = '&#9660;';
      }
    }

    function detailRow(label, value) {
      return '<div class="detail-row"><span class="detail-label">' + esc(label) + '</span><span class="detail-value">' + esc(String(value || '')) + '</span></div>';
    }
    </script>
  `,
  );
}
