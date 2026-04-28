import { layout } from '../layout.js';

export function auditPage(): string {
  return layout(
    'Audit',
    '/dashboard/audit',
    `
    <h2 class="page-title">Audit</h2>
    <div id="content"><div class="loading">Loading...</div></div>
    <script>
    (async () => {
      try {
        var results = await Promise.all([
          api('/api/audit/senders'),
          api('/api/audit/approvals'),
          api('/api/audit/questions'),
        ]);
        var senders = results[0] || [];
        var approvals = results[1] || [];
        var questions = results[2] || [];

        var html = '';

        // Unregistered Senders
        html += '<details open><summary class="section-title" style="cursor:pointer">Unregistered Senders (' + senders.length + ')</summary>';
        if (senders.length === 0) {
          html += '<div class="loading">None</div>';
        } else {
          html += '<table><tr>' +
            '<th>Channel</th>' +
            '<th>Sender</th>' +
            '<th>Reason</th>' +
            '<th>Messages</th>' +
            '<th>First Seen</th>' +
            '<th>Last Seen</th>' +
            '</tr>';
          for (var i = 0; i < senders.length; i++) {
            var s = senders[i];
            html += '<tr>' +
              '<td>' + badge(s.channel_type || '-', 'blue') + '</td>' +
              '<td>' + esc(s.sender_name || s.platform_id || '-') + '</td>' +
              '<td>' + esc(s.reason || '-') + '</td>' +
              '<td>' + esc(String(s.message_count || 0)) + '</td>' +
              '<td>' + (s.first_seen ? '<span title="' + esc(s.first_seen) + '">' + timeAgo(s.first_seen) + '</span>' : '<span style="color:var(--text-muted)">-</span>') + '</td>' +
              '<td>' + (s.last_seen ? '<span title="' + esc(s.last_seen) + '">' + timeAgo(s.last_seen) + '</span>' : '<span style="color:var(--text-muted)">-</span>') + '</td>' +
              '</tr>';
          }
          html += '</table>';
        }
        html += '</details>';

        // Pending Approvals
        html += '<details open><summary class="section-title" style="cursor:pointer;margin-top:16px">Pending Approvals (' + approvals.length + ')</summary>';
        if (approvals.length === 0) {
          html += '<div class="loading">None</div>';
        } else {
          html += '<table><tr>' +
            '<th>Type</th>' +
            '<th>Action</th>' +
            '<th>Title</th>' +
            '<th>Status</th>' +
            '<th>Created</th>' +
            '</tr>';
          for (var j = 0; j < approvals.length; j++) {
            var a = approvals[j];
            var typeColor = 'gray';
            if (a.approval_type === 'credential') typeColor = 'purple';
            else if (a.approval_type === 'sender') typeColor = 'yellow';
            else if (a.approval_type === 'channel') typeColor = 'blue';

            var statusColor = 'gray';
            if (a.status === 'pending') statusColor = 'yellow';
            else if (a.status === 'approved') statusColor = 'green';
            else if (a.status === 'denied') statusColor = 'red';

            html += '<tr>' +
              '<td>' + badge(a.approval_type || '-', typeColor) + '</td>' +
              '<td>' + esc(a.action || '-') + '</td>' +
              '<td>' + esc(a.title || '-') + '</td>' +
              '<td>' + badge(a.status || '-', statusColor) + '</td>' +
              '<td>' + (a.created_at ? '<span title="' + esc(a.created_at) + '">' + timeAgo(a.created_at) + '</span>' : '<span style="color:var(--text-muted)">-</span>') + '</td>' +
              '</tr>';
          }
          html += '</table>';
        }
        html += '</details>';

        // Pending Questions
        html += '<details open><summary class="section-title" style="cursor:pointer;margin-top:16px">Pending Questions (' + questions.length + ')</summary>';
        if (questions.length === 0) {
          html += '<div class="loading">None</div>';
        } else {
          html += '<table><tr>' +
            '<th>Session</th>' +
            '<th>Question</th>' +
            '<th>Options</th>' +
            '<th>Asked</th>' +
            '</tr>';
          for (var k = 0; k < questions.length; k++) {
            var q = questions[k];
            var opts = '';
            if (q.options && q.options.length > 0) {
              opts = q.options.map(function(o) { return badge(typeof o === 'string' ? o : (o.label || o.value || String(o)), 'gray'); }).join(' ');
            } else {
              opts = '<span style="color:var(--text-muted)">-</span>';
            }
            html += '<tr>' +
              '<td style="font-family:monospace;font-size:12px">' + esc(truncId(q.session_id || '-', 16)) + '</td>' +
              '<td>' + esc(q.title || '-') + '</td>' +
              '<td>' + opts + '</td>' +
              '<td>' + (q.created_at ? '<span title="' + esc(q.created_at) + '">' + timeAgo(q.created_at) + '</span>' : '<span style="color:var(--text-muted)">-</span>') + '</td>' +
              '</tr>';
          }
          html += '</table>';
        }
        html += '</details>';

        document.getElementById('content').innerHTML = html;

      } catch (e) {
        document.getElementById('content').innerHTML = '<div class="loading">Error: ' + esc(e.message) + '</div>';
      }
    })();
    </script>
  `,
  );
}
