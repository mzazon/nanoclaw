import { layout } from '../layout.js';

export function settingsPage(): string {
  return layout(
    'Settings',
    '/dashboard/settings',
    `
    <h2 class="page-title">Settings</h2>

    <h3 class="section-title">Runtime Config</h3>
    <div id="runtime-config" class="detail-panel">
      <div class="loading">Loading...</div>
    </div>

    <h3 class="section-title">Environment File</h3>
    <div id="env-viewer" class="detail-panel">
      <div class="loading">Loading...</div>
    </div>

    <h3 class="section-title">Token Rotation</h3>
    <div class="detail-panel">
      <p style="color:var(--text-secondary);font-size:var(--font-size-base);margin-bottom:12px">
        Generate a new dashboard secret token. The new token is written to <code style="font-family:var(--font-mono);background:var(--bg-inset);padding:2px 5px;border-radius:var(--radius-sm)">.env</code> atomically and takes effect immediately — no restart required.
      </p>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <button class="btn btn-danger" id="rotate-btn" onclick="rotateToken()">Rotate Token</button>
        <span id="rotate-status" style="font-size:var(--font-size-sm);color:var(--text-muted)"></span>
      </div>
      <div id="new-token-panel" style="display:none;margin-top:8px">
        <div style="font-size:var(--font-size-sm);color:var(--text-secondary);margin-bottom:6px;font-weight:500">New token (copy before navigating away):</div>
        <div style="display:flex;align-items:center;gap:8px">
          <input
            id="new-token-input"
            type="text"
            readonly
            style="flex:1;background:var(--bg-inset);border:1px solid var(--border-default);border-radius:var(--radius-md);padding:8px 12px;font-family:var(--font-mono);font-size:var(--font-size-sm);color:var(--text-primary);outline:none"
          />
          <button class="btn btn-outline btn-sm" onclick="copyToken()">Copy</button>
        </div>
        <p style="font-size:var(--font-size-xs);color:var(--status-warning);margin-top:8px">
          Update your client configuration with this new token. The old token is no longer valid.
        </p>
      </div>
    </div>

    <script>
    // Keep a mutable reference so rotation can update it for subsequent API calls
    var currentToken = TOKEN;

    function apiWithToken(path, opts) {
      var headers = Object.assign({}, (opts && opts.headers) || {});
      if (currentToken) headers['Authorization'] = 'Bearer ' + currentToken;
      return fetch(path, Object.assign({}, opts || {}, { headers: headers }));
    }

    // ── Runtime Config ──
    (async function loadSettings() {
      try {
        var res = await apiWithToken('/api/settings');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var data = await res.json();

        var cfg = data.runtimeConfig || {};
        var rows = [
          ['Assistant Name', cfg.assistantName || '—'],
          ['Dashboard Port', cfg.dashboardPort || '—'],
          ['Container Install Label', cfg.containerInstallLabel || '—'],
          ['OneCLI URL', cfg.onecliUrl || '—'],
          ['Data Dir', cfg.dataDir || '—'],
          ['Node.js Version', cfg.nodeVersion || '—'],
          ['Process Uptime', formatUptime(cfg.uptime)],
        ];

        document.getElementById('runtime-config').innerHTML =
          rows.map(function(r) {
            return '<div class="detail-row"><span class="detail-label">' + esc(r[0]) + '</span>' +
              '<span class="detail-value" style="font-family:var(--font-mono);font-size:var(--font-size-sm)">' + esc(String(r[1])) + '</span></div>';
          }).join('');

        // ── Env Viewer ──
        var envKeys = data.envKeys || {};
        var keyCount = Object.keys(envKeys).length;
        if (keyCount === 0) {
          document.getElementById('env-viewer').innerHTML =
            '<div style="color:var(--text-muted);font-size:var(--font-size-sm)">.env file not found or empty.</div>';
        } else {
          document.getElementById('env-viewer').innerHTML =
            '<div style="font-size:var(--font-size-xs);color:var(--text-muted);margin-bottom:10px">' + keyCount + ' keys — sensitive values are masked</div>' +
            '<div style="display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;align-items:baseline">' +
            Object.entries(envKeys).map(function(e) {
              var isMasked = e[1] === '****';
              return '<span style="font-family:var(--font-mono);font-size:var(--font-size-sm);color:var(--text-secondary)">' + esc(e[0]) + '</span>' +
                '<span style="font-family:var(--font-mono);font-size:var(--font-size-sm);color:' +
                (isMasked ? 'var(--text-muted)' : 'var(--text-primary)') + '">' +
                esc(String(e[1])) + '</span>';
            }).join('') +
            '</div>';
        }
      } catch (err) {
        document.getElementById('runtime-config').innerHTML =
          '<div style="color:var(--status-error)">Error loading settings: ' + esc(err.message) + '</div>';
        document.getElementById('env-viewer').innerHTML = '';
      }
    })();

    // ── Token Rotation ──
    async function rotateToken() {
      if (!confirm('Rotate the dashboard token? The current token will stop working immediately.')) return;

      var btn = document.getElementById('rotate-btn');
      var status = document.getElementById('rotate-status');
      btn.disabled = true;
      status.textContent = 'Rotating...';
      status.style.color = 'var(--text-muted)';

      try {
        var res = await apiWithToken('/api/token/rotate', { method: 'POST' });
        if (!res.ok) {
          var errData = await res.json().catch(function() { return {}; });
          throw new Error(errData.error || 'HTTP ' + res.status);
        }
        var data = await res.json();
        var newToken = data.token;

        // Update current token so subsequent API calls use it
        currentToken = newToken;

        // Show the new token
        document.getElementById('new-token-input').value = newToken;
        document.getElementById('new-token-panel').style.display = 'block';
        status.textContent = 'Token rotated successfully';
        status.style.color = 'var(--status-success)';

        // Also update the page meta tag so the shared api() helper works
        var meta = document.querySelector('meta[name="dashboard-token"]');
        if (meta) meta.setAttribute('content', newToken);

      } catch (err) {
        status.textContent = 'Error: ' + esc(err.message);
        status.style.color = 'var(--status-error)';
      } finally {
        btn.disabled = false;
      }
    }

    function copyToken() {
      var input = document.getElementById('new-token-input');
      navigator.clipboard.writeText(input.value).then(function() {
        var btn = event.target;
        var orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(function() { btn.textContent = orig; }, 1500);
      }).catch(function() {
        input.select();
        document.execCommand('copy');
      });
    }

    function formatUptime(s) {
      if (!s && s !== 0) return '—';
      var h = Math.floor(s / 3600);
      var m = Math.floor((s % 3600) / 60);
      return h + 'h ' + m + 'm';
    }
    </script>
  `,
  );
}
