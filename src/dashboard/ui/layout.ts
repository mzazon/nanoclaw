/**
 * Shared HTML layout for dashboard pages.
 * CSS custom properties, theme toggle (Dark/Light/System), self-hosted fonts.
 */
import { getDashboardSecret } from '../server.js';

const NAV_GROUPS = [
  {
    label: 'System',
    items: [
      { label: 'Overview', path: '/dashboard' },
      { label: 'Host Health', path: '/dashboard/host-health' },
      { label: 'Containers', path: '/dashboard/containers' },
      { label: 'Errors', path: '/dashboard/errors' },
      { label: 'Logs', path: '/dashboard/logs' },
      { label: 'Settings', path: '/dashboard/settings' },
    ],
  },
  {
    label: 'Agents',
    items: [
      { label: 'Agent Groups', path: '/dashboard/agent-groups' },
      { label: 'Sessions', path: '/dashboard/sessions' },
      { label: 'Channels', path: '/dashboard/channels' },
      { label: 'Messages', path: '/dashboard/messages' },
      { label: 'Users', path: '/dashboard/users' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Tasks', path: '/dashboard/tasks' },
      { label: 'Mounts', path: '/dashboard/mounts' },
      { label: 'Credentials', path: '/dashboard/credentials' },
      { label: 'Audit', path: '/dashboard/audit' },
    ],
  },
];

const CSS = `
  /* ── Font Faces ── */
  @font-face {
    font-family: 'DM Sans';
    font-style: normal;
    font-weight: 400 700;
    font-display: swap;
    src: url('/fonts/dm-sans-latin-ext.woff2') format('woff2');
    unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
  }
  @font-face {
    font-family: 'DM Sans';
    font-style: normal;
    font-weight: 400 700;
    font-display: swap;
    src: url('/fonts/dm-sans-latin.woff2') format('woff2');
    unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
  }
  @font-face {
    font-family: 'JetBrains Mono';
    font-style: normal;
    font-weight: 400 500;
    font-display: swap;
    src: url('/fonts/jetbrains-mono-400-latin.woff2') format('woff2');
    unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
  }

  /* ── CSS Custom Properties — Dark (default) ── */
  :root {
    /* Typography */
    --font-body: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --font-mono: 'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace;
    --font-size-xs: 11px;
    --font-size-sm: 12px;
    --font-size-base: 13px;
    --font-size-md: 14px;
    --font-size-lg: 16px;
    --font-size-xl: 20px;
    --font-size-2xl: 28px;

    /* Spacing */
    --space-1: 4px;
    --space-2: 8px;
    --space-3: 12px;
    --space-4: 16px;
    --space-5: 20px;
    --space-6: 24px;
    --space-8: 32px;

    /* Radius */
    --radius-sm: 4px;
    --radius-md: 6px;
    --radius-lg: 8px;
    --radius-xl: 12px;

    /* Transitions */
    --transition-fast: 0.12s ease;
    --transition-base: 0.2s ease;

    /* Sidebar */
    --sidebar-width: 220px;

    /* Surfaces */
    --bg-base: #0c0c0c;
    --bg-surface: #151515;
    --bg-elevated: #1c1c1c;
    --bg-hover: #222222;
    --bg-inset: #0a0a0a;

    /* Borders */
    --border-subtle: #1e1e1e;
    --border-default: #2a2a2a;
    --border-strong: #383838;

    /* Text */
    --text-primary: #e8e8e8;
    --text-secondary: #a0a0a0;
    --text-muted: #666666;
    --text-inverse: #0c0c0c;

    /* Accent */
    --accent: #6aadcf;
    --accent-hover: #89c4e0;
    --accent-subtle: #1a2a35;

    /* Status */
    --status-success: #4ade80;
    --status-success-bg: #122b18;
    --status-warning: #f0c040;
    --status-warning-bg: #2a2510;
    --status-error: #f07070;
    --status-error-bg: #2b1218;
    --status-info: #6aadcf;
    --status-info-bg: #1a2a35;
    --status-neutral: #888888;
    --status-neutral-bg: #222222;
    --status-purple: #b888e0;
    --status-purple-bg: #241830;

    /* Chart */
    --chart-inbound: #4b8df8;
    --chart-outbound: #34c770;

    /* Overlay */
    --overlay: rgba(0, 0, 0, 0.6);
  }

  /* ── Light Theme ── */
  [data-theme="light"] {
    --bg-base: #f5f5f5;
    --bg-surface: #ffffff;
    --bg-elevated: #ffffff;
    --bg-hover: #f0f0f0;
    --bg-inset: #f0f0f0;

    --border-subtle: #e8e8e8;
    --border-default: #d8d8d8;
    --border-strong: #c0c0c0;

    --text-primary: #1a1a1a;
    --text-secondary: #555555;
    --text-muted: #888888;
    --text-inverse: #ffffff;

    --accent: #2570a0;
    --accent-hover: #1d5c85;
    --accent-subtle: #e8f2fa;

    --status-success: #18834a;
    --status-success-bg: #e6f5ec;
    --status-warning: #9a7a10;
    --status-warning-bg: #fef8e4;
    --status-error: #c43030;
    --status-error-bg: #fde8e8;
    --status-info: #2570a0;
    --status-info-bg: #e8f2fa;
    --status-neutral: #707070;
    --status-neutral-bg: #f0f0f0;
    --status-purple: #7c3aad;
    --status-purple-bg: #f3ecf8;

    --chart-inbound: #3070d8;
    --chart-outbound: #1a9a50;

    --overlay: rgba(0, 0, 0, 0.25);
  }

  /* ── Base ── */
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: var(--font-body);
    background: var(--bg-base);
    color: var(--text-primary);
    display: flex;
    min-height: 100vh;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { color: var(--accent-hover); text-decoration: underline; }

  /* ── Sidebar ── */
  .sidebar {
    width: var(--sidebar-width);
    background: var(--bg-surface);
    border-right: 1px solid var(--border-default);
    padding: 20px 0 0;
    flex-shrink: 0;
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .sidebar h1 {
    font-size: var(--font-size-lg);
    padding: 0 20px 16px;
    color: var(--text-primary);
    border-bottom: 1px solid var(--border-default);
    margin-bottom: 8px;
    letter-spacing: -0.02em;
  }
  .nav-group-label {
    color: var(--text-muted);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-weight: 600;
    padding: 14px 20px 4px;
  }
  .sidebar ul { margin: 0; list-style: none; }
  .sidebar-nav { flex: 1; }
  .sidebar nav a {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 20px;
    color: var(--text-secondary);
    font-size: var(--font-size-md);
    transition: background var(--transition-fast), color var(--transition-fast);
    border-left: 2px solid transparent;
  }
  .sidebar nav a:hover { background: var(--bg-hover); color: var(--text-primary); text-decoration: none; }
  .sidebar nav a.active { background: var(--accent-subtle); color: var(--accent); border-left-color: var(--accent); }

  /* ── Sidebar Footer (Theme Toggle) ── */
  .sidebar-footer {
    padding: 16px 20px;
    border-top: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }
  .theme-toggle {
    display: flex;
    background: var(--bg-inset);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    overflow: hidden;
    width: 100%;
  }
  .theme-toggle button {
    flex: 1;
    padding: 5px 0;
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-family: var(--font-body);
    font-size: var(--font-size-xs);
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition-fast);
  }
  .theme-toggle button:hover { color: var(--text-primary); }
  .theme-toggle button.active {
    background: var(--accent-subtle);
    color: var(--accent);
  }

  /* ── Main ── */
  .main {
    margin-left: var(--sidebar-width);
    padding: 24px 32px;
    flex: 1;
    min-width: 0;
  }
  .page-title {
    font-size: 22px;
    font-weight: 600;
    margin-bottom: 20px;
    color: var(--text-primary);
    letter-spacing: -0.02em;
  }

  /* ── Cards ── */
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card {
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    padding: 16px;
    transition: border-color var(--transition-fast);
  }
  .card:hover { border-color: var(--border-default); }
  .card .label { font-size: var(--font-size-xs); font-weight: 500; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .card .value { font-size: var(--font-size-2xl); font-weight: 700; color: var(--text-primary); margin-top: 4px; letter-spacing: -0.02em; }
  .card .sub { font-size: var(--font-size-xs); color: var(--text-muted); margin-top: 4px; }

  /* ── Tables ── */
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  th { text-align: left; padding: 10px 12px; font-size: var(--font-size-xs); font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid var(--border-default); }
  td { padding: 10px 12px; font-size: var(--font-size-base); border-bottom: 1px solid var(--border-subtle); color: var(--text-secondary); }
  tr:hover td { background: var(--bg-hover); }
  tr.clickable { cursor: pointer; }

  /* ── Badges ── */
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    line-height: 1.6;
  }
  .badge-green { background: var(--status-success-bg); color: var(--status-success); }
  .badge-yellow { background: var(--status-warning-bg); color: var(--status-warning); }
  .badge-red { background: var(--status-error-bg); color: var(--status-error); }
  .badge-blue { background: var(--status-info-bg); color: var(--status-info); }
  .badge-gray { background: var(--status-neutral-bg); color: var(--status-neutral); }
  .badge-purple { background: var(--status-purple-bg); color: var(--status-purple); }

  /* ── Section headers ── */
  .section-title { font-size: var(--font-size-lg); font-weight: 600; margin: 24px 0 12px; color: var(--text-secondary); }

  /* ── Chart container ── */
  .chart-container { background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); padding: 16px; margin-bottom: 24px; }
  .chart-bar-row { display: flex; align-items: center; gap: 8px; margin: 2px 0; }
  .chart-label { width: 40px; font-size: var(--font-size-xs); color: var(--text-muted); text-align: right; font-family: var(--font-mono); }
  .chart-bar { height: 20px; border-radius: 3px; min-width: 2px; transition: width 0.3s; }
  .chart-bar-in { background: var(--chart-inbound); }
  .chart-bar-out { background: var(--chart-outbound); }
  .chart-value { font-size: var(--font-size-xs); color: var(--text-muted); font-family: var(--font-mono); }

  /* ── Log viewer ── */
  .log-container {
    background: var(--bg-inset);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-lg);
    padding: 12px;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    height: calc(100vh - 140px);
    overflow-y: auto;
    line-height: 1.6;
  }
  .log-line { white-space: pre-wrap; word-break: break-all; }
  .log-line:hover { background: var(--bg-hover); }

  /* ── Detail panel ── */
  .detail-panel { background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); padding: 20px; margin-bottom: 16px; }
  .detail-row { display: flex; gap: 8px; margin: 6px 0; }
  .detail-label { color: var(--text-muted); min-width: 140px; font-size: var(--font-size-base); font-weight: 500; }
  .detail-value { color: var(--text-primary); font-size: var(--font-size-base); }

  /* ── Loading ── */
  .loading { color: var(--text-muted); font-style: italic; padding: 20px; }

  /* ── Select ── */
  select {
    background: var(--bg-surface);
    color: var(--text-primary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    padding: 6px 10px;
    font-family: var(--font-body);
    font-size: var(--font-size-base);
  }

  /* ── Tabs ── */
  .tabs { display: flex; gap: 0; margin-bottom: 20px; border-bottom: 1px solid var(--border-default); }
  .tab {
    padding: 8px 16px;
    font-size: var(--font-size-base);
    font-weight: 500;
    color: var(--text-muted);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: color var(--transition-fast), border-color var(--transition-fast);
  }
  .tab:hover { color: var(--text-primary); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }

  /* ── Buttons ── */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border-radius: var(--radius-md);
    font-family: var(--font-body);
    font-size: var(--font-size-xs);
    font-weight: 600;
    cursor: pointer;
    border: 1px solid transparent;
    transition: all var(--transition-fast);
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  .btn-primary {
    background: var(--accent);
    color: var(--text-inverse);
    border-color: var(--accent);
  }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-outline {
    background: transparent;
    color: var(--text-secondary);
    border-color: var(--border-default);
  }
  .btn-outline:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
    border-color: var(--border-strong);
  }
  .btn-danger {
    background: var(--status-error-bg);
    color: var(--status-error);
    border-color: var(--status-error-bg);
  }
  .btn-danger:hover { opacity: 0.85; }
  .btn-success {
    background: var(--status-success-bg);
    color: var(--status-success);
    border-color: var(--status-success-bg);
  }
  .btn-success:hover { opacity: 0.85; }
  .btn-warning {
    background: var(--status-warning-bg);
    color: var(--status-warning);
    border-color: var(--status-warning-bg);
  }
  .btn-warning:hover { opacity: 0.85; }
  .btn-sm {
    padding: 3px 8px;
    font-size: 10px;
  }

  /* ── Code block ── */
  .code-block {
    background: var(--bg-inset);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 16px;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    line-height: 1.7;
    color: var(--text-secondary);
    overflow-x: auto;
    white-space: pre-wrap;
  }

  /* ── Progress track ── */
  .progress-track {
    background: var(--border-subtle);
    border-radius: var(--radius-sm);
    height: 6px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    border-radius: var(--radius-sm);
    transition: width 0.3s;
  }

  /* ── Mobile hamburger ── */
  .menu-toggle {
    display: none;
    position: fixed;
    top: 12px;
    left: 12px;
    z-index: 1001;
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    font-size: 20px;
    width: 40px;
    height: 40px;
    cursor: pointer;
    align-items: center;
    justify-content: center;
  }

  @media (max-width: 768px) {
    .menu-toggle { display: flex; }
    .sidebar {
      transform: translateX(-100%);
      transition: transform 0.25s ease;
      z-index: 1000;
      width: 240px;
    }
    .sidebar.open { transform: translateX(0); }
    .sidebar-overlay {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: var(--overlay);
      z-index: 999;
    }
    .sidebar-overlay.open { display: block; }
    .main {
      margin-left: 0;
      padding: 64px 12px 16px;
    }
    .page-title { font-size: 18px; }
    .cards { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
    .card .value { font-size: 22px; }
    table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .detail-row { flex-direction: column; gap: 2px; }
    .detail-label { min-width: unset; }
    .log-container { height: calc(100vh - 120px); font-size: 11px; }
    .chart-container { overflow-x: auto; }
    .tabs { overflow-x: auto; flex-wrap: nowrap; }
    .tab { white-space: nowrap; padding: 8px 12px; font-size: 12px; }
  }
`;

/** Build a <button class="btn btn-{variant}"> element. */
export function btn(label: string, variant: string = 'outline', extra: string = ''): string {
  return `<button class="btn btn-${variant}"${extra ? ' ' + extra : ''}>${label}</button>`;
}

/** Build a metric card element. */
export function metricCard(label: string, value: string | number, sub?: string): string {
  return `<div class="card"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
}

/** Build a status badge element. */
export function statusBadge(status: string): string {
  const colorMap: Record<string, string> = {
    running: 'green', active: 'green', live: 'green', connected: 'green', completed: 'green', approved: 'green', success: 'green',
    idle: 'yellow', paused: 'yellow', pending: 'yellow', registered: 'yellow', warning: 'yellow',
    stopped: 'gray', offline: 'gray', none: 'gray', unknown: 'gray',
    error: 'red', failed: 'red', denied: 'red', disconnected: 'red',
    info: 'blue', processing: 'blue',
    admin: 'purple', owner: 'purple',
  };
  const color = colorMap[status.toLowerCase()] ?? 'gray';
  return `<span class="badge badge-${color}">${status}</span>`;
}

export function layout(title: string, activePath: string, bodyHtml: string): string {
  const token = getDashboardSecret() || '';
  const navHtml = NAV_GROUPS.map(
    (group) => `
  <div class="nav-group-label">${group.label}</div>
  <ul>
    ${group.items
      .map(
        (item) =>
          `<li><a href="${item.path}" class="${activePath === item.path || (item.path !== '/dashboard' && activePath.startsWith(item.path)) ? 'active' : ''}">${item.label}</a></li>`,
      )
      .join('')}
  </ul>`,
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="dashboard-token" content="${token}">
  <title>${title} — NanoClaw Dashboard</title>
  <script>
    (function() {
      var stored = localStorage.getItem('theme');
      var resolved;
      if (stored === 'light' || stored === 'dark') {
        resolved = stored;
      } else {
        resolved = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      }
      document.documentElement.setAttribute('data-theme', resolved);
    })();
  </script>
  <style>${CSS}</style>
  <script>
    const TOKEN = document.querySelector('meta[name="dashboard-token"]')?.content || '';
    async function api(path) {
      const headers = {};
      if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
      const res = await fetch(path, { headers });
      if (!res.ok) throw new Error('API error: ' + res.status);
      return res.json();
    }
    function badge(text, color) {
      return '<span class="badge badge-' + color + '">' + esc(text) + '</span>';
    }
    function esc(s) {
      if (s == null) return '';
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function timeAgo(ts) {
      if (!ts) return 'never';
      const d = new Date(ts);
      const s = Math.floor((Date.now() - d.getTime()) / 1000);
      if (s < 60) return s + 's ago';
      if (s < 3600) return Math.floor(s/60) + 'm ago';
      if (s < 86400) return Math.floor(s/3600) + 'h ago';
      return Math.floor(s/86400) + 'd ago';
    }
    function timeUntil(ts, status) {
      if (!ts) return '-';
      if (status === 'paused') return 'paused';
      // Parse as UTC if no timezone info
      var raw = String(ts);
      var d = new Date(raw.indexOf('T') >= 0 && raw.slice(-1) !== 'Z' && !raw.match(/[+-]\\d{2}:\\d{2}$/) ? raw + 'Z' : raw);
      var diff = d.getTime() - Date.now();
      if (diff <= 0) return timeAgo(ts);
      var secs = Math.floor(diff / 1000);
      if (secs < 60) return 'in ' + secs + 's';
      if (secs < 3600) return 'in ' + Math.floor(secs/60) + 'm';
      if (secs < 86400) return 'in ' + Math.floor(secs/3600) + 'h';
      return 'in ' + Math.floor(secs/86400) + 'd';
    }
    function formatNum(n) {
      if (n >= 1000000) return (n/1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n/1000).toFixed(1) + 'K';
      return String(n);
    }
    function truncId(s, max) {
      if (!s || s.length <= max) return s || '';
      return s.slice(0, max) + '\\u2026';
    }
    function friendlyId(channelType, pid) {
      if (!pid) return '?';
      if (channelType === 'discord' && pid.startsWith('discord:')) {
        var parts = pid.split(':');
        return '#' + (parts[2] || '').slice(-6);
      }
      if (channelType === 'whatsapp') return pid.replace(/@.*/, '');
      if (channelType === 'slack' && pid.startsWith('slack:')) return pid.slice(6);
      if (channelType === 'teams' && pid.startsWith('teams:')) return 'chat-' + pid.slice(6, 12);
      return truncId(pid, 20);
    }

    // ── Theme toggle ──
    function setTheme(t) {
      localStorage.setItem('theme', t);
      var resolved = t === 'system'
        ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
        : t;
      document.documentElement.setAttribute('data-theme', resolved);
      document.querySelectorAll('.theme-toggle button').forEach(function(b) {
        b.classList.toggle('active', b.dataset.theme === t);
      });
    }
    document.addEventListener('DOMContentLoaded', function() {
      var stored = localStorage.getItem('theme') || 'system';
      document.querySelectorAll('.theme-toggle button').forEach(function(b) {
        b.classList.toggle('active', b.dataset.theme === stored);
      });
    });
  </script>
</head>
<body>
  <button class="menu-toggle" onclick="document.querySelector('.sidebar').classList.toggle('open');document.querySelector('.sidebar-overlay').classList.toggle('open');">&#9776;</button>
  <div class="sidebar-overlay" onclick="document.querySelector('.sidebar').classList.remove('open');this.classList.remove('open');"></div>
  <div class="sidebar">
    <h1>NanoClaw</h1>
    <div class="sidebar-nav">
      <nav onclick="if(window.innerWidth<=768){document.querySelector('.sidebar').classList.remove('open');document.querySelector('.sidebar-overlay').classList.remove('open');}">${navHtml}</nav>
    </div>
    <div class="sidebar-footer">
      <div class="theme-toggle">
        <button data-theme="dark" onclick="setTheme('dark')">Dark</button>
        <button data-theme="light" onclick="setTheme('light')">Light</button>
        <button data-theme="system" onclick="setTheme('system')">Auto</button>
      </div>
    </div>
  </div>
  <div class="main">
    ${bodyHtml}
  </div>
</body>
</html>`;
}
