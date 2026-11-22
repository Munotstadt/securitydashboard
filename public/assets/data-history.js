// Historie einer security_data-Kennzahl (P/E, P/B, Total Net Assets, Spread, Std. Dev. 3y, ...).
// security_data speichert pro Stichtag (AsOfDate) eine eigene Zeile; dieses Modul gruppiert die Zeilen
// einer Kennzahl und zeigt sie als Liniendiagramm (eine Linie pro Source) plus Tabelle in einem Dialog.
// Genutzt von security_data.html und security.html. Keine Abhängigkeiten ausser optional fmtDecimal (db-data.js).
(function (global) {
  'use strict';

  const PALETTE = ['#E30613', '#2C6FBB', '#1F8A6E', '#D9A441', '#7A5FC0', '#3FA7A0', '#B5793A', '#6F7B8C'];

  // Eine Kennzahl = DataType + FieldNameID (bzw. Name, wenn keine ParameterID gesetzt ist).
  function keyOf(row) {
    const id = row.FieldNameID !== null && row.FieldNameID !== undefined && row.FieldNameID !== ''
      ? 'id:' + row.FieldNameID
      : 'n:' + String(row.ParameterName || row.FieldName || '').trim().toLowerCase();
    return String(row.DataType || '') + '|' + id;
  }

  // ISO-Datum (yyyy-mm-dd, optional mit Zeit). Ältere Zeilen hatten dd.mm.yyyy - auch das wird gelesen.
  function isoDate(value) {
    const s = String(value || '').trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return null;
  }

  function isNum(v) { return v !== null && v !== undefined && v !== '' && !isNaN(Number(v)); }

  // Alle Zeilen derselben Kennzahl, chronologisch (älteste zuerst).
  function seriesFor(rows, key) {
    return rows
      .filter(r => keyOf(r) === key)
      .map(r => Object.assign({}, r, { _date: isoDate(r.AsOfDate) }))
      .filter(r => r._date)
      .sort((a, b) => a._date.localeCompare(b._date) || String(a.Source || '').localeCompare(String(b.Source || '')));
  }

  // Anzahl Stichtage mit Zahlenwert je Kennzahl (für die 📈-Badges).
  function countsByKey(rows) {
    const out = new Map();
    for (const r of rows) {
      if (!isNum(r.NumericValue)) continue;
      const k = keyOf(r);
      out.set(k, (out.get(k) || 0) + 1);
    }
    return out;
  }

  function fmtNum(v, dec) {
    if (typeof global.fmtDecimal === 'function') return global.fmtDecimal(v, dec);
    return Number(v).toLocaleString('de-CH', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }
  // Achsenbeschriftung: grosse Beträge (Market Cap, Total Assets) kompakt.
  function fmtCompact(v) {
    const a = Math.abs(v);
    if (a >= 1e12) return fmtNum(v / 1e12, 2) + ' Bio';
    if (a >= 1e9) return fmtNum(v / 1e9, 2) + ' Mrd';
    if (a >= 1e6) return fmtNum(v / 1e6, 2) + ' Mio';
    if (a >= 1e4) return fmtNum(v / 1e3, 1) + 'k';
    if (a >= 100) return fmtNum(v, 0);
    return fmtNum(v, a >= 10 ? 1 : 2);
  }
  function fmtValue(r) {
    if (isNum(r.NumericValue)) {
      const v = Number(r.NumericValue);
      const dec = r.Unit === '%' ? 2 : (Math.abs(v) >= 1000 ? 0 : 2);
      return fmtNum(v, dec) + (r.Unit ? ' ' + r.Unit : '');
    }
    return r.FieldValue || '—';
  }
  function fmtDdMm(iso) { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}.${m[2]}.${m[1]}` : (iso || '—'); }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function niceTicks(min, max, count) {
    if (min === max) { const pad = Math.abs(min) * 0.05 || 1; min -= pad; max += pad; }
    const raw = (max - min) / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(s => s >= raw) || raw;
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Number(t.toFixed(10)));
    return { lo, hi, ticks };
  }

  function chartSvg(series) {
    const pts = series.filter(r => isNum(r.NumericValue));
    if (!pts.length) return '<div class="dh-empty">Keine Zahlenwerte – nur Text-Einträge vorhanden.</div>';
    const vals = pts.map(r => Number(r.NumericValue));
    const { lo, hi, ticks } = niceTicks(Math.min(...vals), Math.max(...vals), 4);
    // Left margin grows with the longest y-axis label (e.g. "107.50 Mrd").
    const L = Math.max(44, Math.max(...ticks.map(t => fmtCompact(t).length)) * 7.2 + 14);
    const W = 640, H = 240, R = 14, T = 12, B = 30;
    const times = pts.map(r => Date.parse(r._date + 'T00:00:00Z'));
    let t0 = Math.min(...times), t1 = Math.max(...times);
    if (t0 === t1) { t0 -= 86400000 * 15; t1 += 86400000 * 15; }
    const x = t => L + (t - t0) / (t1 - t0) * (W - L - R);
    const y = v => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);

    let g = '';
    for (const tv of ticks) {
      g += `<line x1="${L}" x2="${W - R}" y1="${y(tv).toFixed(1)}" y2="${y(tv).toFixed(1)}" class="dh-grid"/>`;
      g += `<text x="${L - 6}" y="${(y(tv) + 4).toFixed(1)}" text-anchor="end" class="dh-axis">${esc(fmtCompact(tv))}</text>`;
    }
    // x-Achse: erstes, mittleres, letztes Datum
    const xs = [...new Set([t0, (t0 + t1) / 2, t1])];
    xs.forEach((t, i) => {
      const iso = new Date(t).toISOString().slice(0, 10);
      const anchor = i === 0 ? 'start' : (i === xs.length - 1 ? 'end' : 'middle');
      g += `<text x="${x(t).toFixed(1)}" y="${H - 8}" text-anchor="${anchor}" class="dh-axis">${fmtDdMm(iso)}</text>`;
    });

    const bySource = new Map();
    pts.forEach((r, i) => {
      const s = r.Source || '—';
      if (!bySource.has(s)) bySource.set(s, []);
      bySource.get(s).push({ r, t: times[i] });
    });
    let lines = '', legend = '';
    [...bySource.entries()].forEach(([src, list], i) => {
      const color = PALETTE[i % PALETTE.length];
      const d = list.map((p, j) => `${j ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(Number(p.r.NumericValue)).toFixed(1)}`).join(' ');
      if (list.length > 1) lines += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;
      lines += list.map(p => `<circle cx="${x(p.t).toFixed(1)}" cy="${y(Number(p.r.NumericValue)).toFixed(1)}" r="3.5" fill="${color}"><title>${esc(fmtDdMm(p.r._date))} · ${esc(fmtValue(p.r))} · ${esc(src)}</title></circle>`).join('');
      legend += `<span class="dh-leg"><span class="dh-sw" style="background:${color}"></span>${esc(src)} (${list.length})</span>`;
    });
    return `<svg class="dh-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Verlauf">${g}${lines}</svg>`
      + `<div class="dh-legend" style="margin-left:${(L / W * 100).toFixed(1)}%">${legend}</div>`;
  }

  // Veränderung erster -> letzter Zahlenwert (nur bei einer einzigen Source eindeutig).
  function changeLine(series) {
    const pts = series.filter(r => isNum(r.NumericValue));
    const sources = new Set(pts.map(r => r.Source || '—'));
    if (pts.length < 2 || sources.size > 1) return '';
    const a = Number(pts[0].NumericValue), b = Number(pts[pts.length - 1].NumericValue);
    const pct = a !== 0 ? ((b - a) / Math.abs(a)) * 100 : null;
    const cls = b > a ? 'dh-up' : (b < a ? 'dh-down' : '');
    return `<div class="dh-change">Veränderung ${fmtDdMm(pts[0]._date)} → ${fmtDdMm(pts[pts.length - 1]._date)}: `
      + `<span class="${cls}">${esc(fmtValue(pts[0]))} → ${esc(fmtValue(pts[pts.length - 1]))}${pct !== null ? ` (${pct > 0 ? '+' : ''}${fmtNum(pct, 1)}%)` : ''}</span></div>`;
  }

  const CSS = `
  .dh-overlay{position:fixed;inset:0;background:rgba(20,22,26,.45);z-index:2000;display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;overflow-y:auto;}
  .dh-dialog{background:var(--bg,#fff);color:var(--text,#1A1D22);border:1px solid var(--line,#E3E6EA);border-radius:6px;box-shadow:0 12px 32px rgba(0,0,0,.18);width:100%;max-width:720px;padding:18px 18px 14px;font-family:'Inter',system-ui,sans-serif;}
  .dh-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;border-bottom:2px solid var(--accent,#E30613);padding-bottom:10px;margin-bottom:10px;}
  .dh-title{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:18px;margin:0;}
  .dh-sub{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--muted,#767E8A);margin-top:3px;}
  .dh-close{background:none;border:1px solid var(--line,#E3E6EA);border-radius:3px;color:var(--muted,#767E8A);font-size:14px;padding:4px 9px;cursor:pointer;}
  .dh-close:hover{color:var(--text,#1A1D22);border-color:var(--muted,#767E8A);}
  .dh-svg{width:100%;height:auto;display:block;}
  .dh-grid{stroke:var(--line,#E3E6EA);stroke-width:1;}
  .dh-axis{font-family:'IBM Plex Mono',monospace;font-size:11px;fill:var(--muted,#767E8A);}
  .dh-legend{display:flex;flex-wrap:wrap;gap:12px;font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--muted,#767E8A);margin:4px 0 0;}
  .dh-leg{display:inline-flex;align-items:center;gap:5px;}
  .dh-sw{width:10px;height:10px;border-radius:2px;display:inline-block;}
  .dh-change{font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--muted,#767E8A);margin:10px 0 2px;}
  .dh-up{color:var(--gain,#1F8A6E);} .dh-down{color:var(--loss,#C0293D);}
  .dh-empty{padding:24px 6px;text-align:center;color:var(--muted,#767E8A);font-family:'IBM Plex Mono',monospace;font-size:13px;}
  .dh-table{width:100%;border-collapse:collapse;font-size:13px;margin-top:10px;}
  .dh-table th{text-align:left;font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted,#767E8A);padding:7px 6px;border-bottom:1px solid var(--line,#E3E6EA);}
  .dh-table td{padding:6px;border-bottom:1px solid var(--line,#E3E6EA);}
  .dh-table .num{text-align:right;font-family:'IBM Plex Mono',monospace;white-space:nowrap;}
  .dh-table .muted{color:var(--muted,#767E8A);font-size:12px;}
  .dh-table a{text-decoration:none;color:var(--muted,#767E8A);margin-left:6px;font-size:12px;}
  .dh-table a:hover{color:var(--accent,#E30613);}
  .dh-wrap{max-height:280px;overflow-y:auto;}
  .dh-btn{background:none;border:0;cursor:pointer;font-size:12px;padding:0 0 0 6px;color:var(--muted,#767E8A);text-decoration:none;white-space:nowrap;font-family:'IBM Plex Mono',monospace;}
  .dh-btn:hover{color:var(--accent,#E30613);}
  `;
  let cssInjected = false;
  function injectCss() {
    if (cssInjected) return;
    cssInjected = true;
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  let current = null;
  function close() {
    if (!current) return;
    current.remove();
    current = null;
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }

  // opts: { title, subtitle?, rows (alle security_data-Zeilen), key, actions?: { edit(rowId), del(rowId) } }
  function open(opts) {
    injectCss();
    close();
    const series = seriesFor(opts.rows || [], opts.key);
    const desc = [...series].reverse();
    const actions = opts.actions || null;
    const tableRows = desc.map(r => `<tr>
        <td>${esc(fmtDdMm(r._date))}</td>
        <td class="num">${esc(fmtValue(r))}</td>
        <td class="muted">${esc(r.Source || '')}</td>
        ${actions ? `<td class="num"><a href="#" data-dh-edit="${esc(r.RowId)}" title="Bearbeiten">✏️</a><a href="#" data-dh-del="${esc(r.RowId)}" title="Löschen">✕</a></td>` : ''}
      </tr>`).join('');
    const ov = document.createElement('div');
    ov.className = 'dh-overlay';
    ov.innerHTML = `<div class="dh-dialog" role="dialog" aria-modal="true">
      <div class="dh-head">
        <div><h3 class="dh-title">${esc(opts.title || 'Historie')}</h3>
          <div class="dh-sub">${esc(opts.subtitle || '')}${opts.subtitle ? ' · ' : ''}${series.length} Stichtag(e)</div></div>
        <button type="button" class="dh-close" aria-label="Schliessen">✕</button>
      </div>
      ${series.length ? chartSvg(series) + changeLine(series) : '<div class="dh-empty">Keine Werte vorhanden.</div>'}
      ${series.length ? `<div class="dh-wrap"><table class="dh-table"><thead><tr><th>Date</th><th class="num">Value</th><th>Source</th>${actions ? '<th></th>' : ''}</tr></thead><tbody>${tableRows}</tbody></table></div>` : ''}
    </div>`;
    ov.addEventListener('click', e => {
      if (e.target === ov || e.target.closest('.dh-close')) { close(); return; }
      const ed = e.target.closest('[data-dh-edit]');
      if (ed && actions && actions.edit) { e.preventDefault(); close(); actions.edit(ed.dataset.dhEdit); return; }
      const dl = e.target.closest('[data-dh-del]');
      if (dl && actions && actions.del) { e.preventDefault(); close(); actions.del(dl.dataset.dhDel); }
    });
    document.body.appendChild(ov);
    document.addEventListener('keydown', onKey);
    current = ov;
  }

  // Kleiner 📈-Button für Tabellenzeilen / Kacheln. Nur wenn mind. ein Zahlenwert existiert.
  function buttonHtml(key, count) {
    if (!count) return '';
    return `<button type="button" class="dh-btn" data-hist-key="${esc(key)}" title="Historie anzeigen (${count} Stichtag${count === 1 ? '' : 'e'})">📈${count > 1 ? ' ' + count : ''}</button>`;
  }

  global.DataHistory = { keyOf, isoDate, seriesFor, countsByKey, open, close, buttonHtml, injectCss, fmtCompact };
})(typeof window !== 'undefined' ? window : globalThis);
