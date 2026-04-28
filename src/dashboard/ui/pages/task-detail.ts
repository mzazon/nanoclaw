import { layout } from '../layout.js';

export function taskDetailPage(): string {
  return layout(
    'Task Detail',
    '/dashboard/tasks',
    `
    <div id="breadcrumb" class="breadcrumb" style="margin-bottom:16px;font-size:13px;color:var(--text-muted)">
      <a href="/dashboard/tasks">Tasks</a> &rsaquo; <span id="task-id-crumb">Loading...</span>
    </div>

    <div id="content"><div class="loading">Loading...</div></div>

    <script>
    var taskData = null;
    var editMode = false;
    var messagingGroups = [];

    function cronToHuman(cron) {
      var parts = cron.trim().split(/\\s+/);
      if (parts.length !== 5) return cron;
      var min = parts[0], hour = parts[1], dom = parts[2], mon = parts[3], dow = parts[4];
      if (dom === '*' && mon === '*' && dow === '*') {
        if (hour === '*') return min === '0' ? 'every hour' : 'every hour at :' + min.padStart(2, '0');
        if (min === '0') return 'daily at ' + hour + ':00';
        return 'daily at ' + hour + ':' + min.padStart(2, '0');
      }
      if (hour.indexOf('/') >= 0) return 'every ' + hour.split('/')[1] + ' hours';
      if (min.indexOf('/') >= 0) return 'every ' + min.split('/')[1] + ' minutes';
      return cron;
    }

    function getTaskId() {
      var m = window.location.pathname.match(/\\/dashboard\\/tasks\\/([^/]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    }

    function statusColor(s) {
      if (s === 'pending') return 'green';
      if (s === 'processing') return 'blue';
      if (s === 'paused') return 'yellow';
      if (s === 'failed') return 'red';
      if (s === 'completed') return 'green';
      return 'gray';
    }

    function successRate(t) {
      if (!t.total_runs) return '—';
      return Math.round((t.successful_runs / t.total_runs) * 100) + '%';
    }

    function renderView(t) {
      var channelBadge = t.channel_type
        ? badge(t.channel_type, 'blue') + ' <span style="color:var(--text-muted);font-size:12px">' + esc(t.platform_id || '') + '</span>'
        : '<span style="color:var(--text-muted)">none</span>';

      var threadInfo = t.thread_id
        ? '<div class="detail-row"><div class="detail-label">Thread ID</div><div class="detail-value" style="font-family:var(--font-mono);font-size:12px">' + esc(t.thread_id) + '</div></div>'
        : '';

      var scheduleDisplay = t.recurrence_human
        ? esc(t.recurrence_human) + ' <span style="color:var(--text-muted);font-size:11px">(' + esc(t.recurrence) + ')</span>'
        : (t.recurrence ? esc(t.recurrence) : '<span style="color:var(--text-muted)">once</span>');

      var nextRunDisplay = t.process_after
        ? '<span title="' + esc(t.process_after) + '">' + timeUntil(t.process_after, t.status) + '</span>'
        : '<span style="color:var(--text-muted)">—</span>';

      var lastRunDisplay = t.last_run
        ? '<span title="' + esc(t.last_run) + '">' + timeAgo(t.last_run) + '</span>'
        : '<span style="color:var(--text-muted)">never</span>';

      var isProcessing = t.status === 'processing';
      var isCompleted = t.status === 'completed';

      var actionBtns = '';
      if (t.status === 'pending') {
        actionBtns += '<button class="btn btn-warning btn-sm" onclick="doAction(\\'pause\\')">Pause</button> ';
      }
      if (t.status === 'paused') {
        actionBtns += '<button class="btn btn-success btn-sm" onclick="doAction(\\'resume\\')">Resume</button> ';
      }
      if (!isCompleted) {
        actionBtns += '<button class="btn btn-danger btn-sm" onclick="doAction(\\'cancel\\')">Cancel</button> ';
      }
      actionBtns += '<button class="btn btn-outline btn-sm" onclick="enterEdit()" ' + (isProcessing ? 'disabled title="Cannot edit while processing"' : '') + '>Edit</button>';

      var runsHtml = '';
      if (t.runs && t.runs.length > 0) {
        runsHtml = '<div class="section-title">Run History</div>';
        for (var i = 0; i < t.runs.length; i++) {
          var r = t.runs[i];
          var rc = r.status === 'completed' ? 'green' : 'red';
          runsHtml += '<div class="run-entry" style="display:flex;gap:12px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border-subtle)">' +
            badge(r.status, rc) +
            '<span style="color:var(--text-secondary);font-size:12px">' + esc(r.timestamp) + '</span>' +
            '<span style="color:var(--text-muted);font-size:11px">tries: ' + esc(String(r.tries)) + '</span>' +
            '</div>';
        }
      } else {
        runsHtml = '<div class="section-title">Run History</div><div class="loading">No completed runs yet</div>';
      }

      return \`
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap">
          <h2 class="page-title" style="margin-bottom:0">\${esc(t.id)}</h2>
          \${badge(t.status, statusColor(t.status))}
          <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">\${actionBtns}</div>
        </div>

        <div class="cards">
          \${metricCard('Total Runs', String(t.total_runs))}
          \${metricCard('Success Rate', successRate(t))}
          \${metricCard('Last Run', t.last_run ? timeAgo(t.last_run) : 'never')}
          \${metricCard('Next Run', t.process_after ? timeUntil(t.process_after, t.status) : '—')}
        </div>

        <div class="detail-panel">
          <div class="detail-row">
            <div class="detail-label">Agent Group</div>
            <div class="detail-value"><a href="/dashboard/agent-groups?id=\${esc(t.agent_group_id)}">\${esc(t.agent_group_name)}</a></div>
          </div>
          <div class="detail-row">
            <div class="detail-label">Channel</div>
            <div class="detail-value">\${channelBadge}</div>
          </div>
          \${threadInfo}
          <div class="detail-row">
            <div class="detail-label">Schedule</div>
            <div class="detail-value">\${scheduleDisplay}</div>
          </div>
          <div class="detail-row">
            <div class="detail-label">Next Run</div>
            <div class="detail-value">\${nextRunDisplay}</div>
          </div>
          <div class="detail-row">
            <div class="detail-label">Last Run</div>
            <div class="detail-value">\${lastRunDisplay}</div>
          </div>
          <div class="detail-row">
            <div class="detail-label">Series ID</div>
            <div class="detail-value" style="font-family:var(--font-mono);font-size:12px">\${esc(t.series_id)}</div>
          </div>
        </div>

        <div class="section-title">Prompt</div>
        <div class="code-block" style="margin-bottom:24px;max-height:400px;overflow-y:auto">\${esc(t.prompt)}</div>

        \${runsHtml}
      \`;
    }

    function renderEdit(t) {
      var mgOptions = '<option value="">— none —</option>';
      for (var i = 0; i < messagingGroups.length; i++) {
        var mg = messagingGroups[i];
        var sel = (t.channel_type === mg.channel_type && t.platform_id === mg.platform_id) ? ' selected' : '';
        var label = (mg.name || mg.platform_id) + ' (' + mg.channel_type + ')';
        mgOptions += '<option value="' + esc(mg.channel_type) + '|' + esc(mg.platform_id) + '"' + sel + '>' + esc(label) + '</option>';
      }

      // Determine the currently-selected value
      var currentChannelVal = (t.channel_type && t.platform_id) ? (t.channel_type + '|' + t.platform_id) : '';

      var cronPreview = t.recurrence ? cronToHuman(t.recurrence) : '';

      return \`
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap">
          <h2 class="page-title" style="margin-bottom:0">Edit Task</h2>
          \${badge(t.status, statusColor(t.status))}
          <div style="margin-left:auto;display:flex;gap:8px">
            <button class="btn btn-primary btn-sm" onclick="saveEdit()">Save</button>
            <button class="btn btn-outline btn-sm" onclick="cancelEdit()">Cancel</button>
          </div>
        </div>

        <div class="detail-panel">
          <div style="margin-bottom:16px">
            <div class="detail-label" style="margin-bottom:6px">Prompt</div>
            <textarea id="edit-prompt" class="textarea" style="width:100%;min-height:180px;background:var(--bg-inset);border:1px solid var(--border-default);border-radius:var(--radius-md);padding:10px;font-family:var(--font-mono);font-size:12px;color:var(--text-primary);resize:vertical">\${esc(t.prompt)}</textarea>
          </div>

          <div style="margin-bottom:16px">
            <div class="detail-label" style="margin-bottom:6px">Cron Schedule (leave blank to clear recurrence)</div>
            <input id="edit-cron" class="input" type="text" value="\${esc(t.recurrence || '')}"
              oninput="updateCronPreview()"
              placeholder="e.g. 0 9 * * *"
              style="width:280px;background:var(--bg-inset);border:1px solid var(--border-default);border-radius:var(--radius-md);padding:6px 10px;font-family:var(--font-mono);font-size:12px;color:var(--text-primary)" />
            <div id="cron-preview" style="margin-top:4px;font-size:11px;color:var(--text-muted)">\${esc(cronPreview)}</div>
          </div>

          <div style="margin-bottom:16px">
            <div class="detail-label" style="margin-bottom:6px">Channel</div>
            <select id="edit-channel" class="select-input"
              style="background:var(--bg-inset);border:1px solid var(--border-default);border-radius:var(--radius-md);padding:6px 10px;color:var(--text-primary);font-size:13px"
              onchange="updateThreadVisibility()">
              \${mgOptions}
            </select>
          </div>

          <div id="thread-row" style="margin-bottom:16px;display:\${t.channel_type ? 'block' : 'none'}">
            <div class="detail-label" style="margin-bottom:6px">Thread ID (optional)</div>
            <input id="edit-thread-id" class="input" type="text" value="\${esc(t.thread_id || '')}"
              placeholder="optional thread / topic ID"
              style="width:280px;background:var(--bg-inset);border:1px solid var(--border-default);border-radius:var(--radius-md);padding:6px 10px;font-size:13px;color:var(--text-primary)" />
          </div>
        </div>
      \`;
    }

    function metricCard(label, value, sub) {
      return '<div class="card"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + '</div>' + (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + '</div>';
    }

    function updateCronPreview() {
      var val = document.getElementById('edit-cron').value.trim();
      var preview = val ? cronToHuman(val) : '';
      document.getElementById('cron-preview').textContent = preview;
    }

    function updateThreadVisibility() {
      var sel = document.getElementById('edit-channel').value;
      document.getElementById('thread-row').style.display = sel ? 'block' : 'none';
    }

    async function enterEdit() {
      editMode = true;
      // Load messaging groups for picker
      try {
        messagingGroups = await api('/api/messaging-groups');
      } catch (e) {
        messagingGroups = [];
      }
      document.getElementById('content').innerHTML = renderEdit(taskData);
      // Set the select value after render
      var sel = document.getElementById('edit-channel');
      if (sel && taskData.channel_type && taskData.platform_id) {
        sel.value = taskData.channel_type + '|' + taskData.platform_id;
      }
    }

    function cancelEdit() {
      editMode = false;
      document.getElementById('content').innerHTML = renderView(taskData);
    }

    async function saveEdit() {
      var taskId = getTaskId();
      var prompt = document.getElementById('edit-prompt').value;
      var cron = document.getElementById('edit-cron').value.trim();
      var channelSel = document.getElementById('edit-channel').value;
      var threadId = document.getElementById('edit-thread-id') ? document.getElementById('edit-thread-id').value.trim() : '';

      var body = { prompt: prompt, recurrence: cron || null };
      if (channelSel) {
        var parts = channelSel.split('|');
        body.channel_type = parts[0];
        body.platform_id = parts[1];
        body.thread_id = threadId || null;
      } else {
        body.channel_type = null;
        body.platform_id = null;
        body.thread_id = null;
      }

      try {
        var resp = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/update', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        var result = await resp.json();
        if (!resp.ok) {
          alert('Error: ' + (result.error || resp.status));
          return;
        }
        editMode = false;
        await loadTask();
      } catch (e) {
        alert('Save failed: ' + e.message);
      }
    }

    async function doAction(action) {
      var taskId = getTaskId();
      if (action === 'cancel' && !confirm('Cancel this task? This cannot be undone.')) return;
      try {
        var resp = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/' + action, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + TOKEN }
        });
        var result = await resp.json();
        if (!resp.ok) {
          alert('Error: ' + (result.error || resp.status));
          return;
        }
        await loadTask();
      } catch (e) {
        alert('Request failed: ' + e.message);
      }
    }

    async function loadTask() {
      var taskId = getTaskId();
      if (!taskId) {
        document.getElementById('content').innerHTML = '<div class="loading">Invalid task ID in URL</div>';
        return;
      }
      document.getElementById('task-id-crumb').textContent = taskId;
      try {
        taskData = await api('/api/tasks/detail?id=' + encodeURIComponent(taskId));
        document.getElementById('content').innerHTML = editMode ? renderEdit(taskData) : renderView(taskData);
      } catch (e) {
        document.getElementById('content').innerHTML = '<div class="loading">Error loading task: ' + esc(e.message) + '</div>';
      }
    }

    loadTask();
    </script>
  `,
  );
}
