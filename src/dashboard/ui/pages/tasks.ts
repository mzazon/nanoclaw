import { layout } from '../layout.js';

export function tasksPage(): string {
  return layout(
    'Scheduled Tasks',
    '/dashboard/tasks',
    `
    <h2 class="page-title">Scheduled Tasks</h2>
    <div id="content"><div class="loading">Loading...</div></div>
    <script>
    var taskActionInFlight = false;

    async function loadTasks() {
      try {
        var data = await api('/api/tasks');
        if (!data || data.length === 0) {
          document.getElementById('content').innerHTML = '<div class="loading">No scheduled tasks</div>';
          return;
        }

        var html = '<table><tr>' +
          '<th>Status</th>' +
          '<th>Agent Group</th>' +
          '<th>Prompt</th>' +
          '<th>Schedule</th>' +
          '<th>Next Run</th>' +
          '<th>Last Run</th>' +
          '<th>Tries</th>' +
          '<th>Actions</th>' +
          '</tr>';

        for (var i = 0; i < data.length; i++) {
          var t = data[i];

          var statusColor = 'gray';
          if (t.status === 'pending') statusColor = 'green';
          else if (t.status === 'processing') statusColor = 'blue';
          else if (t.status === 'paused') statusColor = 'yellow';
          else if (t.status === 'failed') statusColor = 'red';

          var scheduleCell = t.recurrence_human
            ? esc(t.recurrence_human)
            : (t.recurrence ? esc(t.recurrence) : '<span style="color:#666">once</span>');

          var nextRun = t.process_after
            ? '<span title="' + esc(t.process_after) + '">' + timeAgo(t.process_after) + '</span>'
            : '<span style="color:#666">-</span>';

          // For future dates, timeAgo shows negative — replace with a forward-looking label
          if (t.process_after) {
            var diff = new Date(t.process_after).getTime() - Date.now();
            if (diff > 0) {
              var secs = Math.floor(diff / 1000);
              var label = '';
              if (secs < 60) label = 'in ' + secs + 's';
              else if (secs < 3600) label = 'in ' + Math.floor(secs/60) + 'm';
              else if (secs < 86400) label = 'in ' + Math.floor(secs/3600) + 'h';
              else label = 'in ' + Math.floor(secs/86400) + 'd';
              nextRun = '<span title="' + esc(t.process_after) + '">' + esc(label) + '</span>';
            }
          }

          var lastRun = t.last_completed
            ? '<span title="' + esc(t.last_completed) + '">' + timeAgo(t.last_completed) + '</span>'
            : '<span style="color:#666">never</span>';

          var actions = '';
          if (t.status === 'pending') {
            actions += '<button onclick="taskAction(\\'' + escAttr(t.id) + '\\', \\'pause\\')" style="' + btnStyle('yellow') + '">Pause</button> ';
          }
          if (t.status === 'paused') {
            actions += '<button onclick="taskAction(\\'' + escAttr(t.id) + '\\', \\'resume\\')" style="' + btnStyle('green') + '">Resume</button> ';
          }
          if (t.status !== 'completed') {
            actions += '<button onclick="taskAction(\\'' + escAttr(t.id) + '\\', \\'cancel\\')" style="' + btnStyle('red') + '">Cancel</button>';
          }

          html += '<tr>' +
            '<td>' + badge(t.status, statusColor) + '</td>' +
            '<td><a href="/dashboard/agent-groups?id=' + esc(t.agent_group_id) + '">' + esc(t.agent_group_name) + '</a></td>' +
            '<td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(t.prompt_summary) + '">' + esc(t.prompt_summary) + '</td>' +
            '<td>' + scheduleCell + '</td>' +
            '<td>' + nextRun + '</td>' +
            '<td>' + lastRun + '</td>' +
            '<td>' + esc(String(t.tries)) + '</td>' +
            '<td style="white-space:nowrap">' + actions + '</td>' +
            '</tr>';
        }
        html += '</table>';
        document.getElementById('content').innerHTML = html;

      } catch (e) {
        document.getElementById('content').innerHTML = '<div class="loading">Error: ' + esc(e.message) + '</div>';
      }
    }

    function btnStyle(color) {
      var bg = { yellow: '#3a3a1a', green: '#1a3a1a', red: '#3a1a1a' };
      var fg = { yellow: '#facc15', green: '#4ade80', red: '#f87171' };
      return 'background:' + (bg[color]||'#2a2a2a') + ';color:' + (fg[color]||'#999') +
        ';border:1px solid ' + (fg[color]||'#555') + ';border-radius:4px;padding:3px 10px;font-size:11px;cursor:pointer;font-weight:600;text-transform:uppercase';
    }

    function escAttr(s) {
      return String(s).replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'").replace(/"/g,'&quot;');
    }

    async function taskAction(taskId, action) {
      if (taskActionInFlight) return;
      if (action === 'cancel' && !confirm('Cancel this task? This cannot be undone.')) return;
      taskActionInFlight = true;
      try {
        var resp = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/' + action, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + TOKEN }
        });
        var result = await resp.json();
        if (!resp.ok) {
          alert('Error: ' + (result.error || resp.status));
        }
      } catch (e) {
        alert('Request failed: ' + e.message);
      } finally {
        taskActionInFlight = false;
      }
      loadTasks();
    }

    loadTasks();
    </script>
  `,
  );
}
