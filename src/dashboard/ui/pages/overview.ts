import { layout } from '../layout.js';

export function overviewPage(): string {
  return layout(
    'Overview',
    '/dashboard',
    `
    <h2 class="page-title">Overview</h2>
    <div id="cards" class="cards"><div class="loading">Loading...</div></div>

    <h3 class="section-title">Host Health</h3>
    <div id="health" class="cards"><div class="loading">Loading...</div></div>

    <h3 class="section-title">Token Usage</h3>
    <div id="tokens" class="cards"><div class="loading">Loading...</div></div>
    <div id="token-detail"></div>

    <h3 class="section-title">Context Windows</h3>
    <div id="context"><div class="loading">Loading...</div></div>

    <h3 class="section-title">Message Activity</h3>
    <div class="tabs" id="activity-tabs">
      <span class="tab active" data-range="24h" onclick="switchRange('24h')">24h</span>
      <span class="tab" data-range="7d" onclick="switchRange('7d')">7d</span>
      <span class="tab" data-range="30d" onclick="switchRange('30d')">30d</span>
    </div>
    <div id="chart" class="chart-container"><div class="loading">Loading...</div></div>

    <h3 class="section-title">Agent Groups</h3>
    <div id="groups"></div>
    <script>
    var currentRange = '24h';

    function switchRange(range) {
      currentRange = range;
      document.querySelectorAll('#activity-tabs .tab').forEach(function(t) {
        t.classList.toggle('active', t.dataset.range === range);
      });
      loadActivityChart(range);
    }

    async function loadActivityChart(range) {
      document.getElementById('chart').innerHTML = '<div class="loading">Loading...</div>';
      try {
        var activity = await api('/api/activity?range=' + range);
        renderActivityChart(activity.buckets || [], range);
      } catch (e) {
        document.getElementById('chart').innerHTML = '<div class="loading">Error: ' + esc(e.message) + '</div>';
      }
    }

    function renderActivityChart(buckets, range) {
      var maxVal = Math.max(1, Math.max.apply(null, buckets.map(function(b) { return Math.max(b.inbound, b.outbound); })));
      if (buckets.length === 0) {
        document.getElementById('chart').innerHTML = '<div class="loading">No activity data</div>';
        return;
      }
      var isDaily = (range === '7d' || range === '30d');
      document.getElementById('chart').innerHTML =
        '<div style="display:flex;gap:12px;margin-bottom:10px;font-size:11px">' + badge('inbound', 'blue') + ' ' + badge('outbound', 'green') + '</div>' +
        buckets.map(function(b) {
          var label = isDaily
            ? b.hour.slice(5, 10).replace('-', '/')
            : b.hour.slice(11, 13) + ':00';
          var inW = Math.max(2, (b.inbound / maxVal) * 300);
          var outW = Math.max(2, (b.outbound / maxVal) * 300);
          return '<div class="chart-bar-row">' +
            '<span class="chart-label" style="width:50px">' + label + '</span>' +
            '<div class="chart-bar chart-bar-in" style="width:' + inW + 'px"></div>' +
            '<div class="chart-bar chart-bar-out" style="width:' + outW + 'px"></div>' +
            '<span class="chart-value">' + b.inbound + '/' + b.outbound + '</span>' +
            '</div>';
        }).join('');
    }

    (async () => {
      try {
        const [data, activity, tokenData, ctxData, health] = await Promise.all([
          api('/api/overview'),
          api('/api/activity'),
          api('/api/tokens/summary'),
          api('/api/context'),
          api('/api/host-health').catch(function() { return null; }),
        ]);

        // Cards
        document.getElementById('cards').innerHTML = [
          cardHtml('Agent Groups', data.agentGroups.total),
          cardHtml('Active Sessions', data.sessions.active, data.sessions.running + ' running'),
          cardHtml('Live Channels', data.channels.live.length, data.channels.live.join(', ') || 'none'),
          cardHtml('Messaging Groups', data.channels.messagingGroups),
          cardHtml('Users', data.users.total, data.users.owners + ' owners, ' + data.users.globalAdmins + ' admins'),
          cardHtml('Uptime', formatUptime(data.uptime), data.assistantName),
        ].join('');

        // Host health
        if (health) {
          var fmtB = function(b) { return b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(0) + ' MB'; };
          var healthCards = [
            cardHtml('Load', health.load_avg.map(function(v) { return v.toFixed(2); }).join(' / '), '1m / 5m / 15m'),
            cardHtml('Memory', health.memory_percent + '%', fmtB(health.memory_used) + ' / ' + fmtB(health.memory_total)),
          ];
          if (health.disk) {
            for (var di = 0; di < health.disk.length; di++) {
              healthCards.push(cardHtml('Disk ' + health.disk[di].mount, health.disk[di].percent + '%', fmtB(health.disk[di].used) + ' / ' + fmtB(health.disk[di].total)));
            }
          }
          document.getElementById('health').innerHTML = healthCards.join('');
        } else {
          document.getElementById('health').innerHTML = '<div class="loading">Health data unavailable</div>';
        }

        // Token summary cards
        var t = tokenData.totals || {};
        var cacheHitRate = (t.cacheReadTokens && (t.inputTokens + t.cacheReadTokens + t.cacheCreationTokens))
          ? Math.round(t.cacheReadTokens / (t.inputTokens + t.cacheReadTokens + t.cacheCreationTokens) * 100) : 0;

        document.getElementById('tokens').innerHTML = [
          cardHtml('API Requests', formatNum(t.requests || 0)),
          cardHtml('Input Tokens', formatNum(t.inputTokens || 0)),
          cardHtml('Output Tokens', formatNum(t.outputTokens || 0)),
          cardHtml('Cache Read', formatNum(t.cacheReadTokens || 0), cacheHitRate + '% cache hit rate'),
          cardHtml('Cache Created', formatNum(t.cacheCreationTokens || 0)),
        ].join('');

        // Token by model + group breakdown
        var detailHtml = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">';

        // By model
        detailHtml += '<div class="detail-panel"><h4 style="color:var(--text-secondary);margin-bottom:8px">By Model</h4>';
        var models = tokenData.byModel || {};
        detailHtml += '<table><tr><th>Model</th><th>Requests</th><th>In</th><th>Out</th><th>Cache Read</th><th>Cache Write</th></tr>';
        for (var m in models) {
          var mv = models[m];
          detailHtml += '<tr><td>' + badge(m, 'blue') + '</td><td>' + formatNum(mv.requests) + '</td>' +
            '<td>' + formatNum(mv.inputTokens) + '</td><td>' + formatNum(mv.outputTokens) + '</td>' +
            '<td style="color:var(--status-success)">' + formatNum(mv.cacheReadTokens) + '</td>' +
            '<td style="color:var(--status-warning)">' + formatNum(mv.cacheCreationTokens) + '</td></tr>';
        }
        detailHtml += '</table></div>';

        // By group
        detailHtml += '<div class="detail-panel"><h4 style="color:var(--text-secondary);margin-bottom:8px">By Agent Group</h4>';
        var groups = tokenData.byGroup || {};
        detailHtml += '<table><tr><th>Group</th><th>Requests</th><th>In</th><th>Out</th><th>Cache Read</th><th>Cache Write</th></tr>';
        for (var gid in groups) {
          var gv = groups[gid];
          detailHtml += '<tr><td><a href="/dashboard/agent-groups?id=' + esc(gid) + '">' + esc(gv.name) + '</a></td>' +
            '<td>' + formatNum(gv.requests) + '</td>' +
            '<td>' + formatNum(gv.inputTokens) + '</td><td>' + formatNum(gv.outputTokens) + '</td>' +
            '<td style="color:var(--status-success)">' + formatNum(gv.cacheReadTokens) + '</td>' +
            '<td style="color:var(--status-warning)">' + formatNum(gv.cacheCreationTokens) + '</td></tr>';
        }
        detailHtml += '</table></div></div>';
        document.getElementById('token-detail').innerHTML = detailHtml;

        // Context windows
        var ctxSessions = (ctxData.sessions || []);
        if (ctxSessions.length === 0) {
          document.getElementById('context').innerHTML = '<div class="loading">No active sessions with context data</div>';
        } else {
          var ctxHtml = '';
          for (var ci = 0; ci < ctxSessions.length; ci++) {
            var cs = ctxSessions[ci];
            var pct = cs.usagePercent;
            var barColor = pct > 80 ? 'var(--status-error)' : pct > 50 ? 'var(--status-warning)' : 'var(--status-success)';
            var groupName = '';
            // try to find group name from overview data
            for (var gi = 0; gi < (data.agentGroups.list || []).length; gi++) {
              if (data.agentGroups.list[gi].id === cs.agentGroupId) {
                groupName = data.agentGroups.list[gi].name;
                break;
              }
            }
            ctxHtml += '<div class="detail-panel" style="margin-bottom:8px;padding:12px 16px">' +
              '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
              '<div><span style="font-weight:500;color:var(--text-primary)">' + esc(groupName || cs.agentGroupId) + '</span> ' +
              badge(cs.model, 'blue') + '</div>' +
              '<div style="font-size:12px;color:var(--text-secondary)">' + formatNum(cs.contextTokens) + ' / ' + formatNum(cs.maxContext) + ' tokens' +
              ' <span style="color:' + barColor + ';font-weight:600">' + pct + '%</span></div></div>' +
              '<div style="background:var(--border-default);border-radius:4px;height:8px;overflow:hidden">' +
              '<div style="background:' + barColor + ';height:100%;width:' + Math.min(pct, 100) + '%;border-radius:4px;transition:width 0.3s"></div></div>' +
              '<div style="display:flex;gap:16px;margin-top:6px;font-size:11px;color:var(--text-muted)">' +
              '<span>Cache read: <span style="color:var(--status-success)">' + formatNum(cs.cacheReadTokens) + '</span></span>' +
              '<span>Cache write: <span style="color:var(--status-warning)">' + formatNum(cs.cacheCreationTokens) + '</span></span>' +
              '<span>Output: ' + formatNum(cs.outputTokens) + '</span>' +
              '<span>' + timeAgo(cs.timestamp) + '</span></div></div>';
          }
          document.getElementById('context').innerHTML = ctxHtml;
        }

        // Activity chart — initial 24h render
        renderActivityChart(activity.buckets || [], '24h');

        // Groups list
        var groupsList = data.agentGroups.list || [];
        document.getElementById('groups').innerHTML = groupsList.length === 0
          ? '<div class="loading">No agent groups</div>'
          : '<table><tr><th>Name</th><th>Folder</th></tr>' +
            groupsList.map(function(g) {
              return '<tr><td><a href="/dashboard/agent-groups?id=' + esc(g.id) + '">' + esc(g.name) + '</a></td>' +
              '<td>' + esc(g.folder) + '</td></tr>';
            }).join('') + '</table>';

      } catch (e) {
        document.getElementById('cards').innerHTML = '<div class="loading">Error: ' + esc(e.message) + '</div>';
      }
    })();

    function cardHtml(label, value, sub) {
      return '<div class="card"><div class="label">' + esc(label) + '</div><div class="value">' + esc(String(value)) + '</div>' +
        (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + '</div>';
    }
    function formatUptime(s) {
      var h = Math.floor(s / 3600);
      var m = Math.floor((s % 3600) / 60);
      return h + 'h ' + m + 'm';
    }
    </script>
  `,
  );
}
