import { layout } from '../layout.js';

export function hostHealthPage(): string {
  return layout(
    'Host Health',
    '/dashboard/host-health',
    `
    <h2 class="page-title">Host Health</h2>
    <div id="cards" class="cards"><div class="loading">Loading...</div></div>

    <h3 class="section-title">Disk Usage</h3>
    <div id="disk"><div class="loading">Loading...</div></div>
    <script>
    (async () => {
      try {
        var data = await api('/api/host-health');

        // Cards: uptime, load average, memory
        var load = data.load_avg || [0, 0, 0];
        var memPct = data.memory_percent || 0;
        var memColor = memPct > 90 ? 'var(--status-error)' : memPct > 70 ? 'var(--status-warning)' : 'var(--status-success)';

        document.getElementById('cards').innerHTML = [
          cardHtml('Host Uptime', formatUptime(data.uptime)),
          cardHtml('Load Average', load[0].toFixed(2), '1m / 5m / 15m: ' + load[0].toFixed(2) + ' / ' + load[1].toFixed(2) + ' / ' + load[2].toFixed(2)),
          cardHtml('Memory', formatBytes(data.memory_used) + ' / ' + formatBytes(data.memory_total),
            progressBar(memPct, memColor) + '<div style="margin-top:4px;font-size:12px;color:var(--text-secondary)">' + memPct + '% used</div>')
        ].join('');

        // Disk table
        var disks = data.disk || [];
        if (disks.length === 0) {
          document.getElementById('disk').innerHTML = '<div class="loading">No disk data available</div>';
        } else {
          var diskHtml = '<table><tr><th>Mount</th><th>Total</th><th>Used</th><th>Usage</th></tr>';
          for (var i = 0; i < disks.length; i++) {
            var d = disks[i];
            var dColor = d.percent > 90 ? 'var(--status-error)' : d.percent > 70 ? 'var(--status-warning)' : 'var(--status-success)';
            diskHtml += '<tr><td>' + esc(d.mount) + '</td>' +
              '<td>' + formatBytes(d.total) + '</td>' +
              '<td>' + formatBytes(d.used) + '</td>' +
              '<td style="min-width:200px">' + progressBar(d.percent, dColor) +
              '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px">' + d.percent + '%</div></td></tr>';
          }
          diskHtml += '</table>';
          document.getElementById('disk').innerHTML = diskHtml;
        }

      } catch (e) {
        document.getElementById('cards').innerHTML = '<div class="loading">Error: ' + esc(e.message) + '</div>';
      }
    })();

    function cardHtml(label, value, sub) {
      return '<div class="card"><div class="label">' + esc(label) + '</div><div class="value">' + esc(String(value)) + '</div>' +
        (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>';
    }
    function formatUptime(s) {
      if (!s && s !== 0) return '?';
      var d = Math.floor(s / 86400);
      var h = Math.floor((s % 86400) / 3600);
      var m = Math.floor((s % 3600) / 60);
      if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
      return h + 'h ' + m + 'm';
    }
    function formatBytes(b) {
      if (b == null) return '?';
      if (b >= 1099511627776) return (b / 1099511627776).toFixed(1) + ' TB';
      if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
      if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
      if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
      return b + ' B';
    }
    function progressBar(pct, color) {
      return '<div style="background:var(--bg-hover);border-radius:4px;height:20px;margin-top:4px">' +
        '<div style="background:' + color + ';width:' + pct + '%;height:100%;border-radius:4px;min-width:2px"></div></div>';
    }
    </script>
  `,
  );
}
