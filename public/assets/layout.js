// Shared top bar (brand + navigation) for all pages. Include with a plain <script src="assets/layout.js">
// where the old <nav class="topnav"> used to be; it renders the bar in place, synchronously (no flash).
(function () {
  var MAIN = [
    ['index.html', 'Home'], ['dashboard.html', 'Dashboard'], ['listing.html', 'Listing'], ['portfolio.html', 'Portfolio'],
    ['analyser.html', 'Analyser'], ['asset_comparison.html', 'Comparison'], ['tasks.html', 'Tasks']
  ];
  var EDITORS = [
    ['master_editor.html', 'Master Data'], ['price_editor.html', 'Prices'], ['transactions_editor.html', 'Transactions'],
    ['distribution_editor.html', 'Distributions'], ['parameters_editor.html', 'Parameters'], ['security_data.html', 'Security Data'],
    ['aa.html', 'Asset Allocation'], ['admin.html', 'Admin']
  ];
  var cur = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  if (cur === '') cur = 'index.html';
  function link(it) { return '<a href="' + it[0] + '"' + (it[0] === cur ? ' class="active"' : '') + '>' + it[1] + '</a>'; }
  var inEditors = EDITORS.some(function (it) { return it[0] === cur; });

  var html = '<header class="sd-topbar">' +
    '<a class="sd-brand" href="index.html">Munotstadt <span>Security</span></a>' +
    '<div class="sd-right"><nav class="sd-nav">' + MAIN.map(link).join('') +
    '<div class="sd-dd' + (inEditors ? ' active-group' : '') + '" id="sdEditors"><button type="button" class="sd-toggle" id="sdEditorsToggle">Editors ▾</button></div>' +
    '</nav><a class="sd-logout" href="/cdn-cgi/access/logout">Logout</a></div></header>';

  var s = document.currentScript;
  s.insertAdjacentHTML('beforebegin', html);

  // The menu lives on <body> so the horizontally scrolling nav can never clip it.
  var menu = document.createElement('div');
  menu.className = 'sd-menu';
  menu.innerHTML = EDITORS.map(link).join('');
  document.body.appendChild(menu);
  var dd = document.getElementById('sdEditors'), toggle = document.getElementById('sdEditorsToggle');
  function close() { dd.classList.remove('open'); menu.classList.remove('show'); }
  function open() {
    var r = toggle.getBoundingClientRect();
    menu.style.top = (r.bottom + 4) + 'px';
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 200)) + 'px';
    dd.classList.add('open'); menu.classList.add('show');
  }
  toggle.addEventListener('click', function (e) { e.stopPropagation(); menu.classList.contains('show') ? close() : open(); });
  document.addEventListener('click', function (e) { if (!menu.contains(e.target)) close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  window.addEventListener('resize', close);
  window.addEventListener('scroll', close, { passive: true });
})();
