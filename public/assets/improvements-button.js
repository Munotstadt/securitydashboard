// Floating "✎" button + modal to capture an improvement idea from any page.
// Same-origin replacement for the old cross-site script (munotstadt.github.io/db_admin):
// it posts to /api/improvements on THIS host, so the Cloudflare Access cookie is first-party
// (no CORS, no third-party-cookie problem in Safari).
//
//   <script src="assets/improvements-button.js" data-app="securitydashboard"></script>
//   optional: data-position="right"   (default: left)
(function () {
  if (window.__improvementsButton) return;
  window.__improvementsButton = true;

  var script = document.currentScript;
  var app = (script && script.getAttribute('data-app')) || document.title || location.hostname;
  var right = script && script.getAttribute('data-position') === 'right';

  var css = [
    '.imp-fab{position:fixed;bottom:20px;' + (right ? 'right' : 'left') + ':20px;width:44px;height:44px;border-radius:50%;border:1px solid #d0d0d0;background:#fff;color:#555;font-size:18px;line-height:1;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.15);z-index:9998;opacity:.75}',
    '.imp-fab:hover,.imp-fab:focus{opacity:1;outline:none}',
    '.imp-back{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center;z-index:9999;padding:16px}',
    '.imp-back.show{display:flex}',
    '.imp-box{background:#fff;color:#222;border-radius:14px;width:100%;max-width:420px;padding:22px 24px;font:14px/1.4 -apple-system,Inter,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.3)}',
    '.imp-box h3{margin:0 0 14px;font-size:18px}',
    '.imp-box label{display:block;margin:10px 0 4px;color:#444}',
    '.imp-box input,.imp-box textarea,.imp-box select{width:100%;box-sizing:border-box;font:inherit;font-size:16px;padding:9px 10px;border:1px solid #ccc;border-radius:8px;background:#fff;color:#222}',
    '.imp-box textarea{min-height:90px;resize:vertical}',
    '.imp-msg{min-height:18px;margin:10px 0 0;color:#b00020;font-size:13px}',
    '.imp-msg.ok{color:#1b7f3b}',
    '.imp-row{display:flex;justify-content:flex-end;gap:10px;margin-top:14px}',
    '.imp-row button{font:inherit;padding:9px 16px;border-radius:8px;border:1px solid #ccc;background:#fff;color:#1a5fb4;cursor:pointer}',
    '.imp-row button.primary{background:#d32f2f;border-color:#d32f2f;color:#fff}',
    '.imp-row button[disabled]{opacity:.6;cursor:default}',
    '@media (prefers-color-scheme:dark){.imp-fab{background:#2a2a2a;color:#ddd;border-color:#444}.imp-box{background:#242424;color:#eee}.imp-box label{color:#bbb}.imp-box input,.imp-box textarea,.imp-box select{background:#1b1b1b;color:#eee;border-color:#555}.imp-row button{background:#2a2a2a;color:#8ab4f8;border-color:#555}.imp-row button.primary{background:#d32f2f;color:#fff}}'
  ].join('\n');
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var fab = document.createElement('button');
  fab.type = 'button'; fab.className = 'imp-fab'; fab.textContent = '✎';
  fab.title = 'Improvement erfassen'; fab.setAttribute('aria-label', 'Improvement erfassen');

  var back = document.createElement('div');
  back.className = 'imp-back';
  back.innerHTML =
    '<div class="imp-box" role="dialog" aria-modal="true" aria-labelledby="impTitle">' +
    '<h3 id="impTitle">Neuer Improvement-Task</h3>' +
    '<label for="impT">Titel</label><input id="impT" type="text" maxlength="200" autocomplete="off">' +
    '<label for="impN">Notiz</label><textarea id="impN" maxlength="4000"></textarea>' +
    '<label for="impP">Priorität</label><select id="impP"><option value="low">Niedrig</option><option value="normal" selected>Normal</option><option value="high">Hoch</option></select>' +
    '<div class="imp-msg" id="impM" role="status"></div>' +
    '<div class="imp-row"><button type="button" id="impC">Abbrechen</button><button type="button" id="impS" class="primary">Speichern</button></div>' +
    '</div>';

  function $(id) { return back.querySelector('#' + id); }
  function open() { back.classList.add('show'); setMsg(''); $('impT').focus(); }
  function close() { back.classList.remove('show'); }
  function setMsg(t, ok) { var m = $('impM'); m.textContent = t; m.className = 'imp-msg' + (ok ? ' ok' : ''); }

  async function save() {
    var title = $('impT').value.trim();
    if (!title) { setMsg('Bitte einen Titel eingeben.'); $('impT').focus(); return; }
    var btn = $('impS'); btn.disabled = true;
    try {
      var res = await fetch('/api/improvements', {
        method: 'POST', credentials: 'same-origin', redirect: 'manual',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceApp: app, sourceUrl: location.href, title: title, note: $('impN').value.trim(), priority: $('impP').value })
      });
      if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) throw new Error('Sitzung abgelaufen. Bitte die Seite neu laden (Google-Login) und nochmals speichern.');
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      setMsg('Gespeichert (#' + data.TaskID + ').', true);
      $('impT').value = ''; $('impN').value = ''; $('impP').value = 'normal';
      setTimeout(close, 900);
    } catch (e) {
      setMsg('Fehler: ' + (e && e.message ? e.message : e));
    } finally { btn.disabled = false; }
  }

  fab.addEventListener('click', open);
  back.addEventListener('click', function (e) { if (e.target === back) close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && back.classList.contains('show')) close(); });
  $('impC').addEventListener('click', close);
  $('impS').addEventListener('click', save);

  function mount() { document.body.appendChild(fab); document.body.appendChild(back); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
