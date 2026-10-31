/* VibeAviate — front end for the SB-* OpenFlights subset.
 * All data is loaded from /data/*.txt and queried in the browser. */
'use strict';

const STUDENT = { name: 'Rui Gao', id: '20731015', school: 'De Anza College', course: 'CIS 51' };

// [data key, i18n label key]
const AIRLINE_FIELDS = [
  ['id', 'f.airlineId'], ['name', 'f.name'], ['alias', 'f.alias'], ['iata', 'f.iata'],
  ['icao', 'f.icao'], ['callsign', 'f.callsign'], ['country', 'f.country'], ['active', 'f.active'],
];
const AIRPORT_FIELDS = [
  ['id', 'f.airportId'], ['name', 'f.name'], ['city', 'f.city'], ['country', 'f.country'],
  ['iata', 'f.iata'], ['icao', 'f.icao'], ['lat', 'f.lat'], ['lon', 'f.lon'],
  ['alt', 'f.alt'], ['tzOffset', 'f.tzOffset'], ['dst', 'f.dst'],
  ['tz', 'f.tz'], ['type', 'f.type'], ['source', 'f.source'],
];
const ROUTE_FIELDS = ['airline', 'airlineId', 'src', 'srcId', 'dst', 'dstId', 'codeshare', 'stops', 'equipment'];

const DB = {
  airlines: [], airports: [], routes: [],
  airline: new Map(), airport: new Map(),
  routesByAirline: new Map(), routesByAirport: new Map(),
  directByPair: new Map(), directFrom: new Map(),
};

let activeMap = null;
let activeCharts = [];

/* ---------------- Data loading ---------------- */

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const toObj = (fields, row) => Object.fromEntries(fields.map((f, i) => [f, row[i] ?? '']));
const pushTo = (map, key, val) => { if (!map.has(key)) map.set(key, []); map.get(key).push(val); };

async function loadData() {
  const files = ['SB-airlines.txt', 'SB-airports.txt', 'SB-routes.txt'];
  const [al, ap, rt] = await Promise.all(files.map(async f => {
    const res = await fetch('data/' + f);
    if (!res.ok) throw new Error(t('err.fetch', { f, s: res.status }));
    return parseCSV(await res.text());
  }));

  DB.airlines = al.map(r => toObj(AIRLINE_FIELDS.map(f => f[0]), r));
  DB.airports = ap.map(r => {
    const o = toObj(AIRPORT_FIELDS.map(f => f[0]), r);
    o.latN = parseFloat(o.lat); o.lonN = parseFloat(o.lon);
    return o;
  });
  DB.routes = rt.map(r => toObj(ROUTE_FIELDS, r));

  DB.airlines.forEach(a => DB.airline.set(a.iata, a));
  DB.airports.forEach(a => DB.airport.set(a.iata, a));
  for (const r of DB.routes) {
    pushTo(DB.routesByAirline, r.airline, r);
    pushTo(DB.routesByAirport, r.src, r);
    if (r.dst !== r.src) pushTo(DB.routesByAirport, r.dst, r);
    if (r.stops === '0') {
      pushTo(DB.directByPair, r.src + '>' + r.dst, r);
      pushTo(DB.directFrom, r.src, r);
    }
  }

  document.getElementById('airline-codes').innerHTML =
    [...DB.airlines].sort(byKey('iata')).map(a => `<option value="${esc(a.iata)}">${esc(a.name)}</option>`).join('');
  document.getElementById('airport-codes').innerHTML =
    [...DB.airports].sort(byKey('iata')).map(a => `<option value="${esc(a.iata)}">${esc(a.name)} — ${esc(a.city)}</option>`).join('');
}

/* ---------------- Helpers ---------------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const byKey = k => (a, b) => a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0;
const isNull = v => v === '\\N' || v === '';
const show = v => isNull(v) ? `<span class="null" title="${esc(t('null.title'))}">—</span>` : esc(v);
const fmt = n => n.toLocaleString('en-US');
const norm = s => (s || '').trim().toUpperCase();

function haversineMiles(a, b) {
  const R = 3958.8, rad = Math.PI / 180;
  const dLat = (b.latN - a.latN) * rad, dLon = (b.lonN - a.lonN) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latN * rad) * Math.cos(b.latN * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Points along the great circle between two airports, with longitudes unwrapped
// so Leaflet draws a continuous line across the antimeridian.
function greatCircle(a, b, n = 64) {
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const [φ1, λ1, φ2, λ2] = [a.latN * rad, a.lonN * rad, b.latN * rad, b.lonN * rad];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2));
  if (d === 0) return [[a.latN, a.lonN], [b.latN, b.lonN]];
  const pts = [];
  let prevLon = null;
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    let lon = Math.atan2(y, x) * deg;
    const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) * deg;
    if (prevLon !== null) while (lon - prevLon > 180) lon -= 360;
    if (prevLon !== null) while (prevLon - lon > 180) lon += 360;
    prevLon = lon;
    pts.push([lat, lon]);
  }
  return pts;
}

function codeLink(type, code) {
  return `<a class="code-link" href="#/lookup?type=${type}&code=${encodeURIComponent(code)}">${esc(code)}</a>`;
}

function setTitle(s) { document.title = s ? `${s} · VibeAviate` : t('title.default'); }

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function cleanup() {
  if (activeMap) { activeMap.remove(); activeMap = null; }
  activeCharts.forEach(c => c.destroy());
  activeCharts = [];
}

function makeMap(el, opts = {}) {
  // maxBounds keeps the view between the poles so no empty band shows above or below the tiles.
  const map = L.map(el, {
    worldCopyJump: true, scrollWheelZoom: false, minZoom: 1, zoomSnap: .25,
    maxBounds: [[-85, -720], [85, 720]], maxBoundsViscosity: 1, ...opts,
  });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  activeMap = map;
  return map;
}

function pin(latlng, cls, label, zIndexOffset = 0) {
  return L.marker(latlng, {
    zIndexOffset,
    icon: L.divIcon({ className: '', html: `<div class="map-pin ${cls}">${esc(label)}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
  });
}

/**
 * A longitude frame for one map. The map's seam (180° from its centre) is put in the widest
 * gap between the airports shown, so e.g. a US–Asia network is drawn across the Pacific.
 * ll(ap) places an airport in the frame; path([a, b, …]) returns great-circle polylines that
 * stay continuous, plus a shifted copy when a route crosses the seam, so every line meets
 * its markers.
 */
function geoFrame(airports) {
  const lons = airports.map(a => ((a.lonN % 360) + 540) % 360 - 180).sort((x, y) => x - y);
  let widest = -1, seam = 180;
  lons.forEach((lon, i) => {
    const next = i + 1 < lons.length ? lons[i + 1] : lons[0] + 360;
    if (next - lon > widest) { widest = next - lon; seam = lon + widest / 2; }
  });
  const center = seam - 180;
  const wrap = lon => lon - 360 * Math.round((lon - center) / 360);
  return {
    ll: ap => [ap.latN, wrap(ap.lonN)],
    path(aps, n = 48) {
      let pts = [];
      for (let i = 0; i + 1 < aps.length; i++) {
        const seg = greatCircle(aps[i], aps[i + 1], n);
        const from = pts.length ? pts[pts.length - 1][1] : wrap(aps[0].lonN);
        const off = Math.round((from - seg[0][1]) / 360) * 360;
        const shifted = seg.map(([lat, lon]) => [lat, lon + off]);
        pts = pts.concat(pts.length ? shifted.slice(1) : shifted);
      }
      const lonsP = pts.map(q => q[1]);
      const out = [pts];
      if (Math.min(...lonsP) < center - 180) out.push(pts.map(([lat, lon]) => [lat, lon + 360]));
      if (Math.max(...lonsP) > center + 180) out.push(pts.map(([lat, lon]) => [lat, lon - 360]));
      return out;
    },
  };
}

// onClick(index) makes each bar a link; the cursor turns into a pointer over bars.
function makeBarChart(canvas, labels, values, label, onClick) {
  Chart.defaults.color = cssVar('--muted');
  Chart.defaults.font.family = 'Inter, sans-serif';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', labels.slice(0, 12).map((l, i) => `${l}: ${values[i]}`).join('; '));
  const chart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label, data: values, backgroundColor: cssVar('--accent'), borderRadius: 6, maxBarThickness: 28 }] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      onClick: onClick && ((_, els) => { if (els.length) onClick(els[0].index); }),
      onHover: onClick && ((e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; }),
      plugins: { legend: { display: false }, tooltip: onClick ? { callbacks: { footer: () => t('chart.click') } } : {} },
      scales: {
        x: { grid: { color: cssVar('--border') }, beginAtZero: true },
        y: { grid: { display: false } },
      },
    },
  });
  activeCharts.push(chart);
  return chart;
}

/**
 * Renders a scrollable, sortable table. columns: [{label, render(row, i), num?, hl?}]
 * csv: file name for the "Download CSV" button (exports the rows currently shown, in current order).
 */
function table(columns, rows, { filter = false, id = '', csv = '' } = {}) {
  const head = columns.map((c, ci) => `<th class="${c.num ? 'num' : ''}" aria-sort="none">
    <button type="button" class="th-sort" data-col="${ci}" data-num="${c.num ? 1 : 0}">${esc(c.label)}<span class="sort-ind" aria-hidden="true"></span></button></th>`).join('');
  const body = rows.map((r, i) => `<tr data-i="${i}">${columns.map(c =>
    `<td class="${c.num ? 'num' : ''} ${c.hl ? 'hl' : ''}">${c.render(r, i)}</td>`).join('')}</tr>`).join('');
  return `
    <div class="table-meta">
      <span class="count" data-count-for="${id}">${t('tbl.rows', { n: fmt(rows.length) })}</span>
      <span class="table-tools">
        ${filter ? `<input type="search" placeholder="${t('tbl.filter')}" data-filter-for="${id}" aria-label="${t('tbl.filter')}">` : ''}
        ${csv ? `<button type="button" class="btn ghost small" data-csv-for="${id}" data-file="${esc(csv)}">⬇ CSV</button>` : ''}
      </span>
    </div>
    <div class="table-wrap"><table id="${id}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const cellNum = td => parseFloat(td.textContent.replace(/[^0-9.\-]/g, ''));

function wireTables(root) {
  root.querySelectorAll('[data-filter-for]').forEach(input => {
    const id = input.dataset.filterFor;
    const tbl = document.getElementById(id);
    const count = root.querySelector(`[data-count-for="${id}"]`);
    const rows = [...tbl.tBodies[0].rows];
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      let n = 0;
      rows.forEach(tr => {
        const hit = !q || tr.textContent.toLowerCase().includes(q);
        tr.hidden = !hit;
        if (hit) n++;
      });
      count.textContent = q ? t('tbl.rowsOf', { n: fmt(n), total: fmt(rows.length) }) : t('tbl.rowsPlain', { n: fmt(rows.length) });
    });
  });

  root.querySelectorAll('table').forEach(tbl => {
    tbl.querySelectorAll('.th-sort').forEach(btn => btn.addEventListener('click', () => {
      const col = +btn.dataset.col, num = btn.dataset.num === '1';
      const th = btn.parentElement;
      const dir = th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
      tbl.querySelectorAll('th').forEach(h => h.setAttribute('aria-sort', 'none'));
      th.setAttribute('aria-sort', dir);
      const sign = dir === 'ascending' ? 1 : -1;
      const body = tbl.tBodies[0];
      const sorted = [...body.rows].sort((a, b) => {
        const x = a.cells[col], y = b.cells[col];
        if (num) {
          const nx = cellNum(x), ny = cellNum(y);
          if (isNaN(nx) !== isNaN(ny)) return isNaN(nx) ? 1 : -1; // blanks last
          return sign * ((nx - ny) || (+a.dataset.i - +b.dataset.i));
        }
        return sign * x.textContent.trim().localeCompare(y.textContent.trim()) || (+a.dataset.i - +b.dataset.i);
      });
      body.append(...sorted);
    }));
  });

  root.querySelectorAll('[data-csv-for]').forEach(btn => btn.addEventListener('click', () => {
    const tbl = document.getElementById(btn.dataset.csvFor);
    const q = v => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const line = cells => [...cells].map(c => q(c.textContent.replace(/\s+/g, ' ').trim().replace(/^—$/, ''))).join(',');
    const lines = [line(tbl.tHead.rows[0].cells), ...[...tbl.tBodies[0].rows].filter(r => !r.hidden).map(r => line(r.cells))];
    const url = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: btn.dataset.file });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }));
}

/**
 * Turns user input into an IATA code. Accepts an IATA code, an ICAO code, or part of a
 * name / city / country / callsign. Returns {code} on a unique match, else {matches}.
 */
function resolveCode(type, input) {
  const map = type === 'airline' ? DB.airline : DB.airport;
  const list = type === 'airline' ? DB.airlines : DB.airports;
  const q = norm(input);
  if (!q) return { matches: [] };
  if (map.has(q)) return { code: q };
  const byIcao = list.find(x => x.icao === q);
  if (byIcao) return { code: byIcao.iata };
  const lq = q.toLowerCase();
  const fields = type === 'airline' ? ['name', 'alias', 'callsign', 'country'] : ['name', 'city', 'country'];
  const matches = list.filter(x => fields.some(f => !isNull(x[f]) && x[f].toLowerCase().includes(lq)))
    .sort((a, b) => (DB[type === 'airline' ? 'routesByAirline' : 'routesByAirport'].get(b.iata)?.length || 0) -
                    (DB[type === 'airline' ? 'routesByAirline' : 'routesByAirport'].get(a.iata)?.length || 0));
  return matches.length === 1 ? { code: matches[0].iata } : { matches };
}

// role: '' | 'src' | 'dst' (which one-hop input the message is about)
function notFound(type, input, matches, hrefFor, role = '') {
  const r = role ? t('role.' + role) : '';
  if (!matches.length) {
    return `<div class="msg error">${t('search.none', { q: esc(input), role: r, ex: type === 'airline' ? 'AA' : 'SJC' })}</div>`;
  }
  const shown = matches.slice(0, 16);
  return `<div class="msg">
    ${t('search.many', { n: fmt(matches.length), q: esc(input), role: r })}
    <div class="chips">${shown.map(m => `<a class="chip pick" href="${hrefFor(m.iata)}"><b>${esc(m.iata)}</b> ${esc(type === 'airline' ? m.name : `${m.city} · ${m.name}`)}</a>`).join('')}
    ${matches.length > shown.length ? `<span class="chip">${t('search.more', { n: fmt(matches.length - shown.length) })}</span>` : ''}</div>
  </div>`;
}

const airlineCols = () => AIRLINE_FIELDS.map(([k, key]) => ({
  label: t(key), render: a => k === 'iata' ? codeLink('airline', a.iata) : show(a[k]),
}));
const airportCols = () => AIRPORT_FIELDS.map(([k, key]) => ({
  label: t(key), num: ['id', 'lat', 'lon', 'alt'].includes(k),
  render: a => k === 'iata' ? codeLink('airport', a.iata) : show(a[k]),
}));
const rankCol = { label: '#', num: true, render: (_, i) => i + 1 };

/* ---------------- Queries ---------------- */

// 2.1a — airports reached by an airline, with # of the airline's routes to/from each.
function airlineRouteReport(code) {
  const counts = new Map();
  for (const r of DB.routesByAirline.get(code) || []) {
    counts.set(r.src, (counts.get(r.src) || 0) + 1);
    if (r.dst !== r.src) counts.set(r.dst, (counts.get(r.dst) || 0) + 1);
  }
  return [...counts].map(([iata, n]) => ({ ...DB.airport.get(iata), iata, routeCount: n }))
    .sort((a, b) => b.routeCount - a.routeCount || byKey('iata')(a, b));
}

// 2.1b — airlines serving an airport, with # of each airline's routes to/from it.
function airportRouteReport(code) {
  const counts = new Map();
  for (const r of DB.routesByAirport.get(code) || []) counts.set(r.airline, (counts.get(r.airline) || 0) + 1);
  return [...counts].map(([iata, n]) => ({ ...(DB.airline.get(iata) || { name: '(not in airline table)' }), iata, routeCount: n }))
    .sort((a, b) => b.routeCount - a.routeCount || byKey('iata')(a, b));
}

// Additional 1 — all S→X / X→D route pairs where both legs have 0 stops.
function oneHop(S, D, sameAirline) {
  const s = DB.airport.get(S), d = DB.airport.get(D);
  const pairs = [];
  for (const r1 of DB.directFrom.get(S) || []) {
    const X = r1.dst;
    if (X === S || X === D) continue;
    for (const r2 of DB.directByPair.get(X + '>' + D) || []) {
      if (sameAirline && r1.airline !== r2.airline) continue;
      const x = DB.airport.get(X);
      const leg1 = haversineMiles(s, x), leg2 = haversineMiles(x, d);
      pairs.push({ r1, r2, via: x, leg1, leg2, total: leg1 + leg2 });
    }
  }
  pairs.sort((a, b) => a.total - b.total || byKey('iata')(a.via, b.via) ||
    (a.r1.airline + a.r2.airline).localeCompare(b.r1.airline + b.r2.airline));

  const byVia = new Map();
  for (const p of pairs) {
    const v = byVia.get(p.via.iata) || { airport: p.via, count: 0, total: p.total };
    v.count++;
    byVia.set(p.via.iata, v);
  }
  const top = [...byVia.values()].sort((a, b) => b.count - a.count || a.total - b.total).slice(0, 5);
  const direct = (DB.directByPair.get(S + '>' + D) || []);
  return { pairs, top, viaCount: byVia.size, direct, directMiles: haversineMiles(s, d) };
}

/* ---------------- Recent searches ---------------- */

// Stored as {hash, kind, a, b} so labels can be rendered in the current language.
const RECENT_MAX = 8;
function getRecent() {
  try {
    const list = JSON.parse(localStorage.getItem('recent')) || [];
    return Array.isArray(list) ? list.filter(r => typeof r.hash === 'string' && r.hash.startsWith('#/')) : [];
  } catch { return []; }
}
function addRecent(item) {
  const list = [item, ...getRecent().filter(r => r.hash !== item.hash)].slice(0, RECENT_MAX);
  try { localStorage.setItem('recent', JSON.stringify(list)); } catch { /* storage unavailable */ }
}
function recentLabel(r) {
  if (r.kind === 'hop') return `${r.a} → ${r.b}`;
  if (r.kind === 'report') return t('recent.report', { code: r.a });
  return r.a;
}
function recentChips() {
  const list = getRecent();
  if (!list.length) return '';
  return `<div class="recent"><span class="recent-label">${t('recent.title')}</span>
    ${list.map(r => `<a class="chip" href="${esc(r.hash)}">${esc(recentLabel(r))}</a>`).join('')}
    <button type="button" class="chip recent-clear">${t('recent.clear')}</button></div>`;
}
function wireRecent(root) {
  root.querySelectorAll('.recent-clear').forEach(btn => btn.addEventListener('click', () => {
    try { localStorage.removeItem('recent'); } catch { /* storage unavailable */ }
    root.querySelectorAll('.recent').forEach(el => el.remove());
  }));
}

/* ---------------- Pages ---------------- */

function renderHome(root) {
  const perAirline = DB.airlines.map(a => ({ a, n: (DB.routesByAirline.get(a.iata) || []).length })).sort((x, y) => y.n - x.n);
  const busiest = [...DB.routesByAirport].map(([k, v]) => ({ k, n: v.length })).sort((x, y) => y.n - x.n).slice(0, 10);
  const countries = new Set(DB.airports.map(a => a.country)).size;
  setTitle('');

  root.innerHTML = `
    <section class="hero">
      <svg class="trail" viewBox="0 0 800 300" preserveAspectRatio="none" aria-hidden="true">
        <path d="M-20 260 C 200 120, 420 280, 820 60" stroke="#fff" stroke-width="2" fill="none" stroke-dasharray="6 8"/>
        <path d="M-20 120 C 260 40, 520 220, 820 180" stroke="#fff" stroke-width="2" fill="none" stroke-dasharray="6 8"/>
      </svg>
      <svg class="plane" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>
      <h1>${t('home.h1')}</h1>
      <p>${t('home.lead')}</p>
      <div class="hero-actions">
        <a class="btn" href="#/onehop?src=SJC&dst=BOS">${t('home.ctaHop')}</a>
        <a class="btn ghost" href="#/reports?type=airline&code=SB">${t('home.ctaSB')}</a>
      </div>
    </section>

    <div class="stats">
      <div class="stat"><div class="num">${fmt(DB.airlines.length)}</div><div class="lbl">${t('stat.airlines')}</div></div>
      <div class="stat"><div class="num">${fmt(DB.airports.length)}</div><div class="lbl">${t('stat.airports')}</div></div>
      <div class="stat"><div class="num">${fmt(DB.routes.length)}</div><div class="lbl">${t('stat.routes')}</div></div>
      <div class="stat"><div class="num">${fmt(countries)}</div><div class="lbl">${t('stat.countries')}</div></div>
    </div>

    ${getRecent().length ? `<div class="card">${recentChips()}</div>` : ''}

    <div class="feature-grid" style="margin-bottom:1.25rem">
      <a class="feature" href="#/lookup"><div class="ico">🔎</div><h2>${t('nav.lookup')}</h2><p>${t('feat.lookup')}</p></a>
      <a class="feature" href="#/reports"><div class="ico">📊</div><h2>${t('nav.reports')}</h2><p>${t('feat.reports')}</p></a>
      <a class="feature" href="#/directory"><div class="ico">📇</div><h2>${t('nav.directory')}</h2><p>${t('feat.directory')}</p></a>
      <a class="feature" href="#/onehop"><div class="ico">🗺️</div><h2>${t('nav.onehop')}</h2><p>${t('feat.onehop')}</p></a>
    </div>

    <div class="grid grid-2">
      <div class="card"><h2>${t('home.chartAirlines')}</h2><div class="chart-box"><canvas id="c-airlines"></canvas></div></div>
      <div class="card"><h2>${t('home.chartAirports')}</h2><div class="chart-box"><canvas id="c-airports"></canvas></div></div>
    </div>
    <div class="card" style="margin-top:1.25rem">
      <h2>${t('home.mapTitle')}</h2>
      <div class="chips map-filter" role="group" aria-label="${t('home.mapFilter')}">
        <button type="button" class="chip active" data-airline="" aria-pressed="true">${t('home.mapAll')}</button>
        ${[...DB.airlines].sort(byKey('iata')).map(a => `<button type="button" class="chip" data-airline="${esc(a.iata)}" aria-pressed="false"><i class="swatch" style="background:${AIRLINE_COLORS[a.iata] || 'var(--accent)'}"></i>${esc(a.iata)}</button>`).join('')}
      </div>
      <div class="chips map-region" role="group" aria-label="${t('region.label')}">
        ${['world', 'na', 'eu', 'ap'].map(r => `<button type="button" class="chip${r === 'world' ? ' active' : ''}" data-region="${r}" aria-pressed="${r === 'world'}">${t('region.' + r)}</button>`).join('')}
      </div>
      <p class="hint" id="home-map-hint" aria-live="polite"></p>
      <div id="home-map" class="map tall"></div>
    </div>`;

  makeBarChart(root.querySelector('#c-airlines'), perAirline.map(x => `${x.a.iata} · ${x.a.name}`), perAirline.map(x => x.n), t('chart.routes'),
    i => { location.hash = `#/reports?type=airline&code=${perAirline[i].a.iata}`; });
  makeBarChart(root.querySelector('#c-airports'), busiest.map(x => `${x.k} · ${DB.airport.get(x.k)?.city ?? ''}`), busiest.map(x => x.n), t('chart.routes'),
    i => { location.hash = `#/reports?type=airport&code=${busiest[i].k}`; });

  const net = homeNetworkMap(root.querySelector('#home-map'), root.querySelector('#home-map-hint'));
  const toggleGroup = (sel, btn) => root.querySelectorAll(sel).forEach(b => {
    b.classList.toggle('active', b === btn);
    b.setAttribute('aria-pressed', String(b === btn));
  });
  root.querySelectorAll('.map-filter .chip').forEach(btn => btn.addEventListener('click', () => {
    toggleGroup('.map-filter .chip', btn);
    net.draw(btn.dataset.airline);
  }));
  root.querySelectorAll('.map-region .chip').forEach(btn => btn.addEventListener('click', () => {
    toggleGroup('.map-region .chip', btn);
    net.zoomTo(btn.dataset.region);
  }));
  net.draw('');
  wireRecent(root);
}

// Rough boxes (original lon/lat) used by the region buttons on the home map.
const REGIONS = {
  na: ap => ap.lonN > -170 && ap.lonN < -50 && ap.latN > 7,
  eu: ap => ap.lonN > -25 && ap.lonN < 45 && ap.latN > 34,
  ap: ap => ap.lonN > 60 || ap.lonN < -170,
};

const AIRLINE_COLORS = { AA: '#2563eb', B6: '#0d9488', DL: '#dc2626', SB: '#16a34a', SY: '#db2777', UA: '#7c3aed', WN: '#f59e0b' };

/**
 * Home-page network map. draw('') shows every airport plus the routes flown by 2+ airlines;
 * draw(code) shows one airline's network in its colour. The biggest hubs are labelled, and
 * hovering (or tapping) an airport highlights all of its routes.
 */
function homeNetworkMap(el, hintEl) {
  const map = makeMap(el);
  const geo = geoFrame(DB.airports);
  map.fitBounds(L.latLngBounds(DB.airports.map(geo.ll)), { padding: [10, 10] });
  const base = L.layerGroup().addTo(map);
  const focus = L.layerGroup().addTo(map);
  const labels = L.layerGroup().addTo(map);
  let airline = '', pinned = false, region = 'world', ranked = [], max = 1;

  const radius = n => 2.5 + 11 * Math.sqrt(n / max);

  // Label the biggest airports that fit without overlapping; re-run on every zoom/pan.
  function placeLabels() {
    labels.clearLayers();
    const size = map.getSize(), placed = [];
    for (const { ap, n } of ranked.slice(0, 40)) {
      const pt = map.latLngToContainerPoint(geo.ll(ap));
      if (pt.x < 0 || pt.y < 0 || pt.x > size.x || pt.y > size.y) continue;
      if (placed.some(q => Math.abs(q.x - pt.x) < 36 && Math.abs(q.y - pt.y) < 16)) continue;
      placed.push(pt);
      L.marker(geo.ll(ap), {
        interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'hub-label', html: esc(ap.iata), iconSize: [36, 14], iconAnchor: [18, radius(n) + 14] }),
      }).addTo(labels);
    }
  }
  map.on('zoomend moveend', placeLabels);

  function zoomTo(r) {
    region = r;
    const inRegion = ranked.filter(x => r === 'world' || REGIONS[r](x.ap));
    const pts = (inRegion.length ? inRegion : ranked).map(x => geo.ll(x.ap));
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [20, 20], maxZoom: 6 });
  }

  const routesOf = iata => (DB.routesByAirport.get(iata) || []).filter(r => !airline || r.airline === airline);

  function showRoutes(ap) {
    focus.clearLayers();
    const color = airline ? AIRLINE_COLORS[airline] : cssVar('--accent-strong');
    const others = new Set(routesOf(ap.iata).map(r => (r.src === ap.iata ? r.dst : r.src)));
    for (const code of others) {
      const o = DB.airport.get(code);
      if (!o) continue;
      L.polyline(geo.path([ap, o], 32), { color, weight: 1.6, opacity: .85, interactive: false }).addTo(focus);
      L.circleMarker(geo.ll(o), { radius: 3, color, weight: 1, fillColor: color, fillOpacity: 1, interactive: false }).addTo(focus);
    }
  }

  function draw(code) {
    airline = code;
    pinned = false;
    map.closePopup();
    base.clearLayers();
    focus.clearLayers();
    const color = code ? AIRLINE_COLORS[code] : cssVar('--accent');
    const routes = code ? DB.routesByAirline.get(code) || [] : DB.routes;

    const perAirport = new Map(), pairs = new Map();
    for (const r of routes) {
      perAirport.set(r.src, (perAirport.get(r.src) || 0) + 1);
      if (r.dst !== r.src) perAirport.set(r.dst, (perAirport.get(r.dst) || 0) + 1);
      const key = [r.src, r.dst].sort().join('-');
      if (!pairs.has(key)) pairs.set(key, new Set());
      pairs.get(key).add(r.airline);
    }

    // Lines: the whole network for one airline; for all airlines only routes 2+ airlines compete on.
    let lineCount = 0;
    for (const [key, airlines] of pairs) {
      if (!code && airlines.size < 2) continue;
      const [a, b] = key.split('-').map(c => DB.airport.get(c));
      if (!a || !b) continue;
      lineCount++;
      L.polyline(geo.path([a, b], 24), {
        color, interactive: false,
        weight: code ? 1 : .7 + .6 * (airlines.size - 1), opacity: code ? .3 : .3 + .15 * (airlines.size - 2),
      }).addTo(base);
    }

    ranked = [...perAirport].map(([iata, n]) => ({ ap: DB.airport.get(iata), n })).filter(x => x.ap)
      .sort((x, y) => y.n - x.n);
    max = ranked[0]?.n || 1;
    for (const { ap, n } of [...ranked].reverse()) { // small dots on top of big ones
      const dot = L.circleMarker(geo.ll(ap), {
        radius: radius(n), color, weight: 1, fillColor: color, fillOpacity: .45,
      }).bindPopup(`<b>${esc(ap.iata)}</b> · ${esc(ap.name)}<br>${esc(ap.city)}, ${esc(ap.country)}<br>${t('pop.routes', { n: fmt(n) })}<br><a href="#/lookup?type=airport&code=${esc(ap.iata)}">${t('pop.details')}</a>`);
      dot.on('mouseover', () => { if (!pinned) showRoutes(ap); });
      dot.on('mouseout', () => { if (!pinned) focus.clearLayers(); });
      dot.on('popupopen', () => { pinned = true; showRoutes(ap); });
      dot.on('popupclose', () => { pinned = false; focus.clearLayers(); });
      dot.addTo(base);
    }

    hintEl.textContent = code
      ? t('home.mapHintAirline', { name: DB.airline.get(code)?.name || code, n: fmt(ranked.length), r: fmt(routes.length) })
      : t('home.mapHint', { n: fmt(ranked.length), l: fmt(lineCount) });
    zoomTo(region);
    placeLabels();
  }

  return { draw, zoomTo };
}

function typeTabs(base, type, code) {
  const q = t => `#/${base}?type=${t}${code && t === type ? '&code=' + encodeURIComponent(code) : ''}`;
  return `<nav class="tabs" aria-label="Entity type">
    <a href="${q('airline')}" class="${type === 'airline' ? 'active' : ''}">${t('type.airline')}</a>
    <a href="${q('airport')}" class="${type === 'airport' ? 'active' : ''}">${t('type.airport')}</a>
  </nav>`;
}

function codeForm(base, type, code, button) {
  const list = type === 'airline' ? 'airline-codes' : 'airport-codes';
  const examples = type === 'airline' ? ['AA', 'DL', 'UA', 'WN', 'B6', 'SY', 'SB'] : ['SJC', 'SFO', 'ORD', 'ATL', 'DEN', 'JFK', 'LHR'];
  return `
    <form class="form" data-base="${base}" data-type="${type}">
      <div class="field">
        <label for="code">${t('form.label.' + type)}</label>
        <input id="code" name="code" class="code" type="text" list="${list}" value="${esc(code)}"
          maxlength="60" placeholder="${t('form.ph.' + type)}" autocomplete="off" required>
        <small class="field-hint">${t('form.hint')}</small>
      </div>
      <button class="btn" type="submit">${button}</button>
    </form>
    <div class="chips">${examples.map(c => `<a class="chip" href="#/${base}?type=${type}&code=${c}">${c}</a>`).join('')}</div>`;
}

function wireCodeForm(root) {
  const form = root.querySelector('form[data-base]');
  if (!form) return;
  form.addEventListener('submit', e => {
    e.preventDefault();
    const code = form.code.value.trim();
    location.hash = `#/${form.dataset.base}?type=${form.dataset.type}&code=${encodeURIComponent(code)}`;
  });
}

// Resolves the ?code= param for lookup/reports. Redirects to the canonical IATA code when the
// input was an ICAO code or a unique name match; returns {code} or {html} for the error/choices.
function resolveParam(base, type, input) {
  const r = resolveCode(type, input);
  if (r.code && r.code !== input) {
    location.replace(`#/${base}?type=${type}&code=${r.code}`);
    return { redirect: true };
  }
  if (r.code) return { code: r.code };
  return { html: notFound(type, input, r.matches, c => `#/${base}?type=${type}&code=${c}`) };
}

function kv(fields, obj) {
  return `<dl class="kv">${fields.map(([k, label]) => `<div><dt>${esc(t(label))}</dt><dd>${show(obj[k])}</dd></div>`).join('')}</dl>`;
}

function renderLookup(root, params) {
  const type = params.get('type') === 'airport' ? 'airport' : 'airline';
  const input = (params.get('code') || '').trim();
  const res = input ? resolveParam('lookup', type, input) : {};
  if (res.redirect) return;
  const code = res.code || '';
  let result = res.html || '';
  setTitle(code ? `${code} · ${type === 'airline' ? DB.airline.get(code).name : DB.airport.get(code).name}` : t('lookup.title'));
  if (code) addRecent({ hash: `#/lookup?type=${type}&code=${code}`, kind: 'lookup', a: code });

  if (code && type === 'airline') {
    const a = DB.airline.get(code);
    {
      const routes = DB.routesByAirline.get(code) || [];
      const airports = airlineRouteReport(code).length;
      result = `
        <div class="card">
          <div class="entity-head"><span class="badge">${esc(a.iata)}</span><div><h2>${esc(a.name)}</h2><div class="sub">${t('lookup.airlineSub', { place: esc(a.country), n: AIRLINE_FIELDS.length })}</div></div></div>
          ${kv(AIRLINE_FIELDS, a)}
        </div>
        <div class="stats">
          <div class="stat"><div class="num">${fmt(routes.length)}</div><div class="lbl">${t('lookup.routesFlown')}</div></div>
          <div class="stat"><div class="num">${fmt(airports)}</div><div class="lbl">${t('lookup.airportsServed')}</div></div>
          <div class="stat"><div class="num">${fmt(routes.filter(r => r.codeshare === 'Y').length)}</div><div class="lbl">${t('lookup.codeshare')}</div></div>
        </div>
        <div class="card"><h3>${t('lookup.network')}</h3><div id="net-map" class="map"></div></div>
        <a class="btn ghost" href="#/reports?type=airline&code=${esc(code)}">${t('lookup.toAirlineReport')}</a>`;
    }
  } else if (code) {
    const a = DB.airport.get(code);
    {
      const routes = DB.routesByAirport.get(code) || [];
      const dests = new Set(routes.map(r => r.src === code ? r.dst : r.src));
      result = `
        <div class="grid grid-2">
          <div class="card">
            <div class="entity-head"><span class="badge">${esc(a.iata)}</span><div><h2>${esc(a.name)}</h2><div class="sub">${t('lookup.airportSub', { place: `${esc(a.city)}, ${esc(a.country)}`, n: AIRPORT_FIELDS.length })}</div></div></div>
            ${kv(AIRPORT_FIELDS, a)}
          </div>
          <div class="card">
            <h3>${t('lookup.connections')}</h3>
            <div id="ap-map" class="map small"></div>
            <div class="stats" style="margin:1rem 0 0">
              <div class="stat"><div class="num">${fmt(routes.length)}</div><div class="lbl">${t('lookup.routesInOut')}</div></div>
              <div class="stat"><div class="num">${fmt(dests.size)}</div><div class="lbl">${t('lookup.connected')}</div></div>
            </div>
          </div>
        </div>
        <a class="btn ghost" href="#/reports?type=airport&code=${esc(code)}">${t('lookup.toAirportReport')}</a>`;
    }
  }

  root.innerHTML = `
    <div class="page-head"><h1>${t('lookup.h1')}</h1><p>${t('lookup.lead')}</p></div>
    ${typeTabs('lookup', type, code)}
    <div class="card">${codeForm('lookup', type, code || input, t('lookup.btn'))}${recentChips()}</div>
    ${result}`;
  wireCodeForm(root);
  wireRecent(root);

  const mapEl = root.querySelector('#ap-map');
  if (mapEl) airportNetworkMap(mapEl, code);
  const netEl = root.querySelector('#net-map');
  if (netEl) airlineNetworkMap(netEl, code);
}

// Every airport an airline touches (dot size = # routes) and each airport pair it connects.
function airlineNetworkMap(el, code) {
  const map = makeMap(el);
  const accent = cssVar('--accent');
  const rows = airlineRouteReport(code).filter(r => !isNaN(r.latN));
  const geo = geoFrame(rows);
  const pairs = new Set();
  for (const r of DB.routesByAirline.get(code) || []) {
    const key = [r.src, r.dst].sort().join('-');
    if (pairs.has(key)) continue;
    pairs.add(key);
    const a = DB.airport.get(r.src), b = DB.airport.get(r.dst);
    if (a && b) L.polyline(geo.path([a, b], 24), { color: accent, weight: 1, opacity: .25, interactive: false }).addTo(map);
  }
  const max = rows[0]?.routeCount || 1;
  const dots = rows.map(r =>
    L.circleMarker(geo.ll(r), { radius: 3 + 9 * Math.sqrt(r.routeCount / max), color: accent, weight: 1, fillOpacity: .6 })
      .bindPopup(`<b>${esc(r.iata)}</b> · ${esc(r.name)}<br>${t('pop.airlineRoutes', { n: r.routeCount, code: esc(code) })}<br><a href="#/lookup?type=airport&code=${esc(r.iata)}">${t('pop.airportDetails')}</a>`));
  const group = L.featureGroup(dots).addTo(map);
  map.fitBounds(group.getBounds(), { padding: [20, 20], maxZoom: 6 });
}

// An airport and a great-circle line to every airport it connects to.
function airportNetworkMap(el, code) {
  const a = DB.airport.get(code);
  const map = makeMap(el);
  const accent = cssVar('--accent');
  const others = [...new Set((DB.routesByAirport.get(code) || []).map(r => r.src === code ? r.dst : r.src))]
    .map(c => DB.airport.get(c)).filter(Boolean);
  const geo = geoFrame([a, ...others]);
  const layers = [pin(geo.ll(a), 'src', a.iata, 1000)];
  for (const other of others) {
    layers.push(L.polyline(geo.path([a, other], 24), { color: accent, weight: 1, opacity: .35, interactive: false }));
    layers.push(L.circleMarker(geo.ll(other), { radius: 3, color: accent, weight: 1, fillOpacity: .7 })
      .bindPopup(`<b>${esc(other.iata)}</b> · ${esc(other.name)}<br><a href="#/lookup?type=airport&code=${esc(other.iata)}">${t('pop.details')}</a>`));
  }
  L.featureGroup(layers).addTo(map);
  if (others.length) map.fitBounds(L.latLngBounds([a, ...others].map(geo.ll)), { padding: [20, 20], maxZoom: 6 });
  else map.setView(geo.ll(a), 6);
}

function renderReports(root, params) {
  const type = params.get('type') === 'airport' ? 'airport' : 'airline';
  const input = (params.get('code') || '').trim();
  const res = input ? resolveParam('reports', type, input) : {};
  if (res.redirect) return;
  const code = res.code || '';
  let result = res.html || '';
  let chartData = null;
  setTitle(code ? t('reports.titleCode', { code }) : t('reports.title'));
  if (code) addRecent({ hash: `#/reports?type=${type}&code=${code}`, kind: 'report', a: code });

  if (code && type === 'airline') {
    const a = DB.airline.get(code);
    {
      const rows = airlineRouteReport(code);
      const max = rows[0]?.routeCount || 1;
      result = `
        <div class="card">
          <div class="entity-head"><span class="badge">${esc(a.iata)}</span><div><h2>${esc(a.name)}</h2>
            <div class="sub">${t('reports.airlineSub', { n: fmt(rows.length), r: fmt((DB.routesByAirline.get(code) || []).length) })}</div></div></div>
          ${table([rankCol,
            { label: t('col.routes'), num: true, hl: true, render: r => `<span class="bar" style="width:${Math.max(4, 60 * r.routeCount / max)}px"></span>${r.routeCount}` },
            ...airportCols()], rows, { filter: true, id: 't-report', csv: `${code}-airports-by-routes.csv` })}
        </div>`;
      const top = rows.slice(0, 15);
      chartData = { labels: top.map(r => `${r.iata} · ${r.city}`), values: top.map(r => r.routeCount), title: t('reports.topAirports', { name: a.name }),
        go: i => `#/lookup?type=airport&code=${top[i].iata}` };
    }
  } else if (code) {
    const a = DB.airport.get(code);
    {
      const rows = airportRouteReport(code);
      const max = rows[0]?.routeCount || 1;
      result = `
        <div class="card">
          <div class="entity-head"><span class="badge">${esc(a.iata)}</span><div><h2>${esc(a.name)}</h2>
            <div class="sub">${t('reports.airportSub', { place: `${esc(a.city)}, ${esc(a.country)}`, n: fmt(rows.length) })}</div></div></div>
          ${table([rankCol,
            { label: t('col.routes'), num: true, hl: true, render: r => `<span class="bar" style="width:${Math.max(4, 60 * r.routeCount / max)}px"></span>${r.routeCount}` },
            ...airlineCols()], rows, { id: 't-report', csv: `${code}-airlines-by-routes.csv` })}
        </div>`;
      chartData = { labels: rows.map(r => `${r.iata} · ${r.name}`), values: rows.map(r => r.routeCount), title: t('reports.airlinesAt', { code: a.iata }),
        go: i => `#/reports?type=airline&code=${rows[i].iata}` };
    }
  }

  root.innerHTML = `
    <div class="page-head"><h1>${t('reports.title')}</h1><p>${t('reports.lead')}</p></div>
    ${typeTabs('reports', type, code)}
    <div class="card">${codeForm('reports', type, code || input, t('reports.btn'))}${recentChips()}</div>
    ${result}
    ${chartData ? `<div class="grid grid-2">
      <div class="card"><h2>${esc(chartData.title)}</h2><div class="chart-box" style="height:${Math.max(240, chartData.labels.length * 26)}px"><canvas id="c-report"></canvas></div></div>
      <div class="card"><h2>${type === 'airline' ? t('lookup.network') : t('reports.dests', { code: esc(code) })}</h2><div id="report-map" class="map"></div></div>
    </div>` : ''}`;
  wireCodeForm(root);
  wireTables(root);
  wireRecent(root);
  if (chartData) {
    makeBarChart(root.querySelector('#c-report'), chartData.labels, chartData.values, t('col.routes'), i => { location.hash = chartData.go(i); });
    (type === 'airline' ? airlineNetworkMap : airportNetworkMap)(root.querySelector('#report-map'), code);
  }
}

function renderDirectory(root, params) {
  const type = params.get('type') === 'airport' ? 'airport' : 'airline';
  const rows = type === 'airline'
    ? [...DB.airlines].sort(byKey('iata'))
    : [...DB.airports].sort(byKey('iata'));
  root.innerHTML = `
    <div class="page-head"><h1>${t('dir.h1')}</h1><p>${t('dir.lead.' + type)}</p></div>
    <nav class="tabs" aria-label="Entity type">
      <a href="#/directory?type=airline" class="${type === 'airline' ? 'active' : ''}">${t('dir.tab.airline', { n: DB.airlines.length })}</a>
      <a href="#/directory?type=airport" class="${type === 'airport' ? 'active' : ''}">${t('dir.tab.airport', { n: DB.airports.length })}</a>
    </nav>
    <div class="card">${table((type === 'airline' ? airlineCols : airportCols)(), rows, { filter: true, id: 't-dir', csv: `${type}s-by-iata.csv` })}</div>`;
  setTitle(t('dir.title.' + type));
  wireTables(root);
}

function renderOneHop(root, params) {
  const rawS = (params.get('src') || '').trim(), rawD = (params.get('dst') || '').trim();
  const same = params.get('same') === '1';
  const hopHref = (s, d) => `#/onehop?src=${encodeURIComponent(s)}&dst=${encodeURIComponent(d)}${same ? '&same=1' : ''}`;
  const rs = resolveCode('airport', rawS), rd = resolveCode('airport', rawD);
  if ((rawS || rawD) && ((rs.code && rs.code !== rawS) || (rd.code && rd.code !== rawD))) {
    location.replace(hopHref(rs.code || rawS, rd.code || rawD));
    return;
  }
  const S = rs.code || rawS, D = rd.code || rawD;
  let result = '', data = null;
  setTitle(S && D ? t('hop.titleCode', { s: S, d: D }) : t('hop.title'));

  if (rawS || rawD) {
    const errs = [];
    if (!rs.code) errs.push(rawS ? notFound('airport', rawS, rs.matches, c => hopHref(c, D), 'src')
      : `<div class="msg error">${t('hop.needSrc')}</div>`);
    if (!rd.code) errs.push(rawD ? notFound('airport', rawD, rd.matches, c => hopHref(S, c), 'dst')
      : `<div class="msg error">${t('hop.needDst')}</div>`);
    if (!errs.length && S === D) errs.push(`<div class="msg error">${t('hop.sameAirport')}</div>`);
    if (errs.length) result = `<div class="stack">${errs.join('')}</div>`;
    else {
      data = oneHop(S, D, same);
      addRecent({ hash: hopHref(S, D), kind: 'hop', a: S, b: D });
      const s = DB.airport.get(S), d = DB.airport.get(D);
      const directNote = data.direct.length
        ? `<div class="msg info">${t('hop.direct', { n: data.direct.length, s: esc(S), d: esc(D), airlines: data.direct.map(r => esc(r.airline)).join(', '), mi: fmt(Math.round(data.directMiles)) })}</div>`
        : `<div class="msg">${t('hop.noDirect', { s: esc(S), d: esc(D), mi: fmt(Math.round(data.directMiles)) })}</div>`;

      if (!data.pairs.length) {
        result = `${directNote}<div class="msg error" style="margin-top:1rem">${t(same ? 'hop.noneSame' : 'hop.none')}</div>`;
      } else {
        const airlineName = c => DB.airline.get(c)?.name || c;
        result = `
          <div class="stats">
            <div class="stat"><div class="num">${fmt(data.pairs.length)}</div><div class="lbl">${t('hop.pairs')}</div></div>
            <div class="stat"><div class="num">${fmt(data.viaCount)}</div><div class="lbl">${t('hop.vias')}</div></div>
            <div class="stat"><div class="num">${fmt(Math.round(data.pairs[0].total))}</div><div class="lbl">${t('hop.shortest')}</div></div>
            <div class="stat"><div class="num">${fmt(Math.round(data.directMiles))}</div><div class="lbl">${t('hop.directDist')}</div></div>
          </div>
          ${directNote}
          <div class="grid grid-2" style="margin-top:1.25rem">
            <div class="card">
              <h2>${t('hop.top5')}</h2>
              <p style="color:var(--muted);margin:0 0 .75rem;font-size:.9rem">${t('hop.top5Hint')}</p>
              <ol class="top-list">${data.top.map((v, i) => `
                <li><span class="rank">${i + 1}</span>
                  <div class="grow"><b>${esc(v.airport.city)}</b> ${codeLink('airport', v.airport.iata)}<small>${esc(v.airport.name)} · ${t('hop.miTotal', { mi: fmt(Math.round(v.total)) })}</small></div>
                  <b>${v.count}</b>&nbsp;<span style="color:var(--muted);font-size:.8rem">${t('hop.routesWord')}</span></li>`).join('')}
              </ol>
            </div>
            <div class="card">
              <div id="hop-map" class="map"></div>
              <div class="legend"><span><i style="background:var(--good)"></i>${t('legend.src', { c: esc(S) })}</span><span><i style="background:var(--bad)"></i>${t('legend.dst', { c: esc(D) })}</span><span><i style="background:var(--warm)"></i>${t('legend.top5')}</span><span><i style="background:var(--accent)"></i>${t('legend.sel')}</span></div>
            </div>
          </div>
          <div class="card" style="margin-top:1.25rem">
            <h2>${t('hop.allPairs')}</h2>
            <p class="hint">${t('hop.clickRow')}</p>
            ${table([
              rankCol,
              { label: t('col.via'), render: p => `${codeLink('airport', p.via.iata)} ${esc(p.via.city)}` },
              { label: t('col.leg1', { s: S }), render: p => `${codeLink('airline', p.r1.airline)} ${esc(airlineName(p.r1.airline))}${p.r1.codeshare === 'Y' ? ` <span class="null">${t('codeshare')}</span>` : ''}` },
              { label: t('col.leg1mi'), num: true, render: p => fmt(Math.round(p.leg1)) },
              { label: t('col.leg2', { d: D }), render: p => `${codeLink('airline', p.r2.airline)} ${esc(airlineName(p.r2.airline))}${p.r2.codeshare === 'Y' ? ` <span class="null">${t('codeshare')}</span>` : ''}` },
              { label: t('col.leg2mi'), num: true, render: p => fmt(Math.round(p.leg2)) },
              { label: t('col.total'), num: true, hl: true, render: p => fmt(Math.round(p.total)) },
              { label: t('col.equip'), render: p => `${show(p.r1.equipment)} / ${show(p.r2.equipment)}` },
            ], data.pairs, { filter: true, id: 't-hop', csv: `${S}-${D}-one-hop.csv` })}
          </div>`;
      }
      data.s = s; data.d = d;
    }
  }

  root.innerHTML = `
    <div class="page-head"><h1>${t('hop.title')}</h1><p>${t('hop.lead')}</p></div>
    <div class="card">
      <form class="form" id="hop-form">
        <div class="field"><label for="src">${t('hop.from')}</label><input id="src" name="src" class="code" type="text" list="airport-codes" value="${esc(S)}" placeholder="e.g. SJC" maxlength="4" autocomplete="off" required></div>
        <button class="btn ghost swap" type="button" id="swap" title="${t('hop.swap')}" aria-label="${t('hop.swap')}">⇄</button>
        <div class="field"><label for="dst">${t('hop.to')}</label><input id="dst" name="dst" class="code" type="text" list="airport-codes" value="${esc(D)}" placeholder="e.g. BOS" maxlength="4" autocomplete="off" required></div>
        <label class="check"><input type="checkbox" name="same" ${same ? 'checked' : ''}> ${t('hop.same')}</label>
        <button class="btn" type="submit">${t('hop.btn')}</button>
      </form>
      <div class="chips">${[['SJC', 'BOS'], ['SFO', 'JFK'], ['LAX', 'YYZ'], ['SEA', 'MIA'], ['ATL', 'DEN'], ['SFO', 'LHR']]
        .map(([a, b]) => `<a class="chip" href="#/onehop?src=${a}&dst=${b}">${a} → ${b}</a>`).join('')}</div>
      ${recentChips()}
    </div>
    ${result}`;

  const form = root.querySelector('#hop-form');
  form.addEventListener('submit', e => {
    e.preventDefault();
    location.hash = `#/onehop?src=${encodeURIComponent(norm(form.src.value))}&dst=${encodeURIComponent(norm(form.dst.value))}${form.same.checked ? '&same=1' : ''}`;
  });
  root.querySelector('#swap').addEventListener('click', () => {
    [form.src.value, form.dst.value] = [form.dst.value, form.src.value];
  });
  wireTables(root);
  wireRecent(root);

  const mapEl = root.querySelector('#hop-map');
  if (mapEl && data) {
    const map = makeMap(mapEl);
    const warm = cssVar('--warm');
    const geo = geoFrame([data.s, data.d, ...data.pairs.map(p => p.via)]);
    const layers = [];
    data.top.forEach((v, i) => {
      const w = 2 + 3 * (v.count / data.top[0].count);
      layers.push(L.polyline(geo.path([data.s, v.airport]), { color: warm, weight: w, opacity: .8 }).bindTooltip(`${data.s.iata} → ${v.airport.iata}`));
      layers.push(L.polyline(geo.path([v.airport, data.d]), { color: warm, weight: w, opacity: .8, dashArray: '6 6' }).bindTooltip(`${v.airport.iata} → ${data.d.iata}`));
      layers.push(pin(geo.ll(v.airport), 'via', i + 1, 100 - i).bindPopup(`<b>#${i + 1} ${esc(v.airport.city)} (${esc(v.airport.iata)})</b><br>${t('pop.pairs', { n: v.count })}<br>${t('hop.miTotal', { mi: fmt(Math.round(v.total)) })}`));
    });
    // Source and destination sit above the connection pins so they are never hidden.
    layers.push(pin(geo.ll(data.s), 'src', data.s.iata, 1000).bindPopup(`<b>${t('pop.source')}</b><br>${esc(data.s.name)}`));
    layers.push(pin(geo.ll(data.d), 'dst', data.d.iata, 1000).bindPopup(`<b>${t('pop.dest')}</b><br>${esc(data.d.name)}`));
    L.featureGroup(layers).addTo(map);
    const baseBounds = L.latLngBounds([data.s, data.d, ...data.top.map(v => v.airport)].map(geo.ll));
    map.fitBounds(baseBounds, { padding: [30, 30] });

    // Highlight one route pair (default: the shortest, row 1) when its table row is clicked.
    let hl = null;
    const tbody = root.querySelector('#t-hop tbody');
    const select = (i, focusMap) => {
      const p = data.pairs[i];
      if (hl) hl.remove();
      const accent = cssVar('--accent');
      hl = L.featureGroup([
        L.polyline(geo.path([data.s, p.via, data.d]), { color: accent, weight: 5, opacity: .95 }),
        L.circleMarker(geo.ll(p.via), { radius: 7, color: '#fff', weight: 2, fillColor: accent, fillOpacity: 1 }),
      ]).addTo(map);
      hl.bindTooltip(`#${i + 1}: ${data.s.iata} → ${p.via.iata} (${p.r1.airline}) → ${data.d.iata} (${p.r2.airline}) · ${fmt(Math.round(p.total))} ${t('unit.mi')}`,
        { direction: 'top', offset: [0, -10] }).openTooltip(geo.ll(p.via));
      tbody.querySelectorAll('tr.selected').forEach(tr => tr.classList.remove('selected'));
      tbody.querySelector(`tr[data-i="${i}"]`)?.classList.add('selected');
      if (focusMap) {
        map.fitBounds(L.latLngBounds([baseBounds.getSouthWest(), baseBounds.getNorthEast(), geo.ll(p.via)]), { padding: [30, 30] });
        const r = mapEl.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) mapEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    };
    tbody.addEventListener('click', e => {
      const tr = e.target.closest('tr');
      if (tr && !e.target.closest('a')) select(+tr.dataset.i, true);
    });
    select(0, false);
  }
}

function renderAbout(root) {
  setTitle(t('about.title'));
  const li = keys => keys.map(k => `<li>${t(k)}</li>`).join('');
  root.innerHTML = `
    <div class="page-head"><h1>${t('about.title')}</h1><p>${t('about.lead')}</p></div>
    <div class="card">
      <div class="id-card">
        <img class="avatar" src="assets/me.jpg" alt="${esc(t('about.photoAlt', { name: STUDENT.name }))}"
          onerror="this.outerHTML='<div class=&quot;avatar&quot; aria-hidden=&quot;true&quot;>RG</div>'">
        <div>
          <div style="color:var(--muted);font-size:.85rem;text-transform:uppercase;letter-spacing:.06em;font-weight:600">${t('about.idLabel', { school: esc(STUDENT.school) })}</div>
          <div class="idnum">${esc(STUDENT.id)}</div>
          <h2 style="margin:.25rem 0 0">${esc(STUDENT.name)}</h2>
          <div style="color:var(--muted)">${t('about.role', { course: esc(STUDENT.course) })}</div>
          <div class="verify">${t('about.verify', { name: esc(STUDENT.name), id: esc(STUDENT.id) })}</div>
        </div>
      </div>
    </div>
    <div class="grid grid-2">
      <div class="card">
        <h2>${t('about.project')}</h2>
        <p>${t('about.projectText')}</p>
        <ul class="clean">${li(['about.f1', 'about.f2', 'about.f3', 'about.f4'])}</ul>
        <h3 style="margin-top:1rem">${t('about.extras')}</h3>
        <ul class="clean">${li(['about.e1', 'about.e2', 'about.e3', 'about.e4', 'about.e5', 'about.e6'])}</ul>
      </div>
      <div class="card">
        <h2>${t('about.data')}</h2>
        <ul class="clean">
          <li>${t('about.d1', { a: fmt(DB.airlines.length), p: fmt(DB.airports.length), r: fmt(DB.routes.length) })}</li>
          <li>${t('about.d2')}</li>
          <li>${t('about.d3', { n: DB.routes.filter(r => r.stops !== '0').length })}</li>
          ${li(['about.d4', 'about.d5', 'about.d6'])}
        </ul>
      </div>
    </div>`;
}

function shortcutsList() {
  const row = (keys, text) => `<div><dt>${keys}</dt><dd>${text}</dd></div>`;
  return `<dl class="kb-list">
    ${row('<kbd>/</kbd>', t('kb.search'))}
    ${row('<kbd>?</kbd>', t('kb.help'))}
    ${row('<kbd>t</kbd>', t('kb.theme'))}
    ${row(`<kbd>g</kbd> ${t('kb.then')} …`, t('kb.go'))}
    ${row('<kbd>Esc</kbd>', t('kb.esc'))}
  </dl>`;
}

function renderHelp(root) {
  setTitle(t('help.title'));
  const qa = [1, 2, 3, 4, 5, 6].map(i =>
    `<details class="faq"${i === 1 ? ' open' : ''}><summary>${t('help.q' + i)}</summary><p>${t('help.a' + i)}</p></details>`).join('');
  root.innerHTML = `
    <div class="page-head"><h1>${t('help.title')}</h1><p>${t('help.lead')}</p></div>
    <div class="grid grid-2">
      <div class="card">${qa}</div>
      <div class="card"><h2>${t('kb.title')}</h2>${shortcutsList()}</div>
    </div>`;
}

const REPO_URL = 'https://github.com/gaoruius/vibe-aviate';

function renderContact(root) {
  setTitle(t('contact.title'));
  const ext = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text} ↗</a>`;
  root.innerHTML = `
    <div class="page-head"><h1>${t('contact.title')}</h1><p>${t('contact.lead')}</p></div>
    <div class="grid grid-2">
      <div class="card">
        <h2>${t('contact.issue')}</h2>
        <p class="hint">${t('contact.issueNote')}</p>
        <a class="btn" href="${REPO_URL}/issues/new" target="_blank" rel="noopener">GitHub Issues ↗</a>
      </div>
      <div class="card">
        <h2>${t('contact.author')}</h2>
        <p><b>${esc(STUDENT.name)}</b><br><span class="hint">${esc(STUDENT.school)} · ${esc(STUDENT.course)}</span></p>
        <ul class="clean">
          <li>${ext('https://github.com/gaoruius', t('contact.github'))}</li>
          <li>${ext(REPO_URL, t('contact.code'))}</li>
        </ul>
      </div>
    </div>`;
}

function renderPrivacy(root) {
  setTitle(t('privacy.title'));
  root.innerHTML = `
    <div class="page-head"><h1>${t('privacy.title')}</h1><p>${t('privacy.lead')}</p></div>
    <div class="card"><ul class="clean">${[1, 2, 3, 4, 5].map(i => `<li>${t('privacy.p' + i)}</li>`).join('')}</ul></div>`;
}

const CHANGELOG = [
  { v: '1.3', date: '2026-10-30', items: ['cl.13a', 'cl.13b', 'cl.13c'] },
  { v: '1.2', date: '2026-10-30', items: ['cl.12a'] },
  { v: '1.1', date: '2026-10-30', items: ['cl.11a', 'cl.11b', 'cl.11c'] },
  { v: '1.0', date: '2026-10-30', items: ['cl.10a', 'cl.10b'] },
];

function renderChangelog(root) {
  setTitle(t('cl.title'));
  root.innerHTML = `
    <div class="page-head"><h1>${t('cl.title')}</h1><p>${t('cl.lead')}</p></div>
    <ol class="timeline">${CHANGELOG.map(c => `
      <li class="card"><h2>v${c.v} <time datetime="${c.date}">${c.date}</time></h2>
        <ul class="clean">${c.items.map(k => `<li>${t(k)}</li>`).join('')}</ul></li>`).join('')}
    </ol>`;
}

function renderNotFound(root, params, path) {
  setTitle(t('nf.title'));
  const shown = params.get('path') || '#/' + path;
  root.innerHTML = `
    <div class="notfound card">
      <div class="nf-code" aria-hidden="true">404 ✈</div>
      <h1>${t('nf.title')}</h1>
      <p>${t('nf.text', { path: esc(shown) })}</p>
      <a class="btn" href="#/home">${t('nf.home')}</a>
    </div>`;
}

/* ---------------- Router ---------------- */

const PAGES = {
  home: renderHome, lookup: renderLookup, reports: renderReports, directory: renderDirectory, onehop: renderOneHop,
  about: renderAbout, help: renderHelp, contact: renderContact, privacy: renderPrivacy, changelog: renderChangelog,
};

function route() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const page = path === '' ? 'home' : Object.hasOwn(PAGES, path) ? path : null;
  cleanup();
  const root = document.getElementById('app');
  const div = document.createElement('div');
  div.className = 'page';
  root.replaceChildren(div);
  if (page) PAGES[page](div, new URLSearchParams(qs || ''));
  else renderNotFound(div, new URLSearchParams(qs || ''), path);
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === page));
  document.querySelector('.nav').classList.remove('open');
  document.querySelector('.menu-toggle').setAttribute('aria-expanded', 'false');
  window.scrollTo(0, 0);
  if (document.activeElement === document.body || !root.contains(document.activeElement)) root.focus({ preventScroll: true });
}

/* ---------------- Theme ---------------- */

const THEME_ICONS = { system: '◐', light: '☀', dark: '☾' };
function getTheme() { try { return localStorage.getItem('theme') || 'system'; } catch { return 'system'; } }
function applyTheme(mode) {
  if (mode === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
  const btn = document.querySelector('.theme-toggle');
  btn.textContent = THEME_ICONS[mode];
  btn.setAttribute('aria-label', t('theme.label', { t: t('theme.' + mode) }));
  btn.title = btn.getAttribute('aria-label');
}
document.querySelector('.theme-toggle').addEventListener('click', () => {
  const order = ['system', 'light', 'dark'];
  const next = order[(order.indexOf(getTheme()) + 1) % order.length];
  try { localStorage.setItem('theme', next); } catch { /* storage unavailable: theme lasts this visit */ }
  applyTheme(next);
  if (DB.routes.length) route(); // re-render so charts and maps pick up the new colors
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (getTheme() === 'system' && DB.routes.length) route();
});
applyTheme(getTheme());

/* ---------------- Language ---------------- */

// Text that lives in index.html (nav, footer) is tagged with data-i18n.
function applyStaticText() {
  document.documentElement.lang = HTML_LANG[LANG];
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); }); // our own markup only
  document.querySelectorAll('[data-i18n-label]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nLabel)); el.title = t(el.dataset.i18nLabel); });
  document.querySelector('.menu-toggle').setAttribute('aria-label', t('nav.menu'));
  const sel = document.querySelector('.lang-select');
  sel.value = LANG;
  sel.setAttribute('aria-label', t('nav.lang'));
  applyTheme(getTheme());
}
document.querySelector('.lang-select').addEventListener('change', e => {
  LANG = e.target.value;
  try { localStorage.setItem('lang', LANG); } catch { /* storage unavailable: language lasts this visit */ }
  applyStaticText();
  if (DB.routes.length) route();
});
applyStaticText();

document.querySelector('.menu-toggle').addEventListener('click', e => {
  const open = document.querySelector('.nav').classList.toggle('open');
  e.currentTarget.setAttribute('aria-expanded', String(open));
});

/* ---------------- Keyboard shortcuts ---------------- */

const GO_KEYS = { h: '#/home', l: '#/lookup', r: '#/reports', d: '#/directory', o: '#/onehop', i: '#/about' };
let gPressedAt = 0;

function openShortcuts() {
  let dlg = document.getElementById('kb-dialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'kb-dialog';
    dlg.setAttribute('aria-labelledby', 'kb-title');
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); }); // click on backdrop
    document.body.append(dlg);
  }
  dlg.innerHTML = `<h2 id="kb-title">${t('kb.title')}</h2>${shortcutsList()}
    <form method="dialog"><button class="btn">${t('kb.close')}</button></form>`;
  if (!dlg.open) dlg.showModal();
}

document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable], dialog')) return;
  if (gPressedAt && Date.now() - gPressedAt < 1500 && GO_KEYS[e.key]) {
    e.preventDefault();
    gPressedAt = 0;
    location.hash = GO_KEYS[e.key];
    return;
  }
  gPressedAt = 0;
  if (e.key === '/') {
    e.preventDefault();
    const focusInput = () => {
      const input = document.querySelector('#app input[type=text], #app input[type=search]');
      if (input) { input.focus(); input.select(); }
    };
    if (document.querySelector('#app input[type=text], #app input[type=search]')) focusInput();
    else { location.hash = '#/lookup'; setTimeout(focusInput, 50); }
  } else if (e.key === '?') {
    e.preventDefault();
    openShortcuts();
  } else if (e.key === 't') {
    document.querySelector('.theme-toggle').click();
  } else if (e.key === 'g') {
    gPressedAt = Date.now();
  }
});

/* ---------------- Page chrome: skip link, back to top, offline, install ---------------- */

document.querySelector('.skip-link').addEventListener('click', () => document.getElementById('app').focus());

const toTop = document.querySelector('.to-top');
addEventListener('scroll', () => { toTop.hidden = scrollY < Math.min(600, innerHeight / 2); }, { passive: true });
toTop.addEventListener('click', () => {
  scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  document.getElementById('app').focus({ preventScroll: true });
});

const offlineBar = document.querySelector('.offline-bar');
const updateOnline = () => { offlineBar.hidden = navigator.onLine; };
addEventListener('online', updateOnline);
addEventListener('offline', updateOnline);
updateOnline();

let installPrompt = null;
const installBtn = document.querySelector('.install-btn');
addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  installBtn.hidden = false;
});
installBtn.addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  installBtn.hidden = true;
});
addEventListener('appinstalled', () => { installBtn.hidden = true; });

// Offline support. Only on the deployed (https) site so local edits are never served stale.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => { /* offline mode unavailable */ }));
}

loadData()
  .then(() => { window.addEventListener('hashchange', route); route(); })
  .catch(err => {
    const hint = location.protocol === 'file:' ? t('err.file') : '';
    document.getElementById('app').innerHTML = `<div class="msg error">${t('err.load', { msg: esc(err.message) })}${hint}</div>`;
  });
