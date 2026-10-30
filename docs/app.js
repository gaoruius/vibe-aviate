/* VibeAviate — front end for the SB-* OpenFlights subset.
 * All data is loaded from /data/*.txt and queried in the browser. */
'use strict';

const STUDENT = { name: 'Rui Gao', id: '20731015', school: 'De Anza College', course: 'CIS 51' };

const AIRLINE_FIELDS = [
  ['id', 'Airline ID'], ['name', 'Name'], ['alias', 'Alias'], ['iata', 'IATA'],
  ['icao', 'ICAO'], ['callsign', 'Callsign'], ['country', 'Country'], ['active', 'Active'],
];
const AIRPORT_FIELDS = [
  ['id', 'Airport ID'], ['name', 'Name'], ['city', 'City'], ['country', 'Country'],
  ['iata', 'IATA'], ['icao', 'ICAO'], ['lat', 'Latitude'], ['lon', 'Longitude'],
  ['alt', 'Altitude (ft)'], ['tzOffset', 'Timezone (UTC offset)'], ['dst', 'DST'],
  ['tz', 'Tz database'], ['type', 'Type'], ['source', 'Source'],
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
    if (!res.ok) throw new Error(`Could not load ${f} (${res.status})`);
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
const show = v => isNull(v) ? '<span class="null" title="No value in source data (\\N)">—</span>' : esc(v);
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

function setTitle(t) { document.title = t ? `${t} · VibeAviate` : 'VibeAviate · Air Travel Explorer'; }

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function cleanup() {
  if (activeMap) { activeMap.remove(); activeMap = null; }
  activeCharts.forEach(c => c.destroy());
  activeCharts = [];
}

function makeMap(el, opts = {}) {
  const map = L.map(el, { worldCopyJump: true, scrollWheelZoom: false, ...opts });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  activeMap = map;
  return map;
}

function pin(ap, cls, label) {
  return L.marker([ap.latN, ap.lonN], {
    icon: L.divIcon({ className: '', html: `<div class="map-pin ${cls}">${esc(label)}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
  });
}

// onClick(index) makes each bar a link; the cursor turns into a pointer over bars.
function makeBarChart(canvas, labels, values, label, onClick) {
  Chart.defaults.color = cssVar('--muted');
  Chart.defaults.font.family = 'Inter, sans-serif';
  const chart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label, data: values, backgroundColor: cssVar('--accent'), borderRadius: 6, maxBarThickness: 28 }] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      onClick: onClick && ((_, els) => { if (els.length) onClick(els[0].index); }),
      onHover: onClick && ((e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; }),
      plugins: { legend: { display: false }, tooltip: onClick ? { callbacks: { footer: () => 'Click for details' } } : {} },
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
      <span class="count" data-count-for="${id}">${fmt(rows.length)} rows · click a column header to sort</span>
      <span class="table-tools">
        ${filter ? `<input type="search" placeholder="Filter rows…" data-filter-for="${id}" aria-label="Filter rows">` : ''}
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
      count.textContent = q ? `${fmt(n)} of ${fmt(rows.length)} rows` : `${fmt(rows.length)} rows`;
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

function notFound(type, input, matches, hrefFor, role = '') {
  if (!matches.length) {
    return `<div class="msg error">No ${role}${type} matches <b>${esc(input)}</b>. Enter an IATA code (e.g. ${type === 'airline' ? 'AA' : 'SJC'}), an ICAO code, or part of a name or city.</div>`;
  }
  const shown = matches.slice(0, 16);
  return `<div class="msg">
    <b>${fmt(matches.length)} ${type}s</b> match ${role ? 'the ' + role : ''}“${esc(input)}” — pick one:
    <div class="chips">${shown.map(m => `<a class="chip pick" href="${hrefFor(m.iata)}"><b>${esc(m.iata)}</b> ${esc(type === 'airline' ? m.name : `${m.city} · ${m.name}`)}</a>`).join('')}
    ${matches.length > shown.length ? `<span class="chip">+${fmt(matches.length - shown.length)} more — be more specific</span>` : ''}</div>
  </div>`;
}

const airlineCols = AIRLINE_FIELDS.map(([k, label]) => ({
  label, render: a => k === 'iata' ? codeLink('airline', a.iata) : show(a[k]),
}));
const airportCols = AIRPORT_FIELDS.map(([k, label]) => ({
  label, num: ['id', 'lat', 'lon', 'alt'].includes(k),
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
      <h1>Explore airlines, airports &amp; routes</h1>
      <p>Look up any airline or airport by IATA code, see who flies where, browse the full directory, and find the shortest one-stop connections between two cities.</p>
      <div class="hero-actions">
        <a class="btn" href="#/onehop?src=SJC&dst=BOS">✈ Try the One-Hop Finder</a>
        <a class="btn ghost" href="#/reports?type=airline&code=SB">SkyBridge route report</a>
      </div>
    </section>

    <div class="stats">
      <div class="stat"><div class="num">${fmt(DB.airlines.length)}</div><div class="lbl">Airlines</div></div>
      <div class="stat"><div class="num">${fmt(DB.airports.length)}</div><div class="lbl">Airports</div></div>
      <div class="stat"><div class="num">${fmt(DB.routes.length)}</div><div class="lbl">Routes</div></div>
      <div class="stat"><div class="num">${fmt(countries)}</div><div class="lbl">Countries</div></div>
    </div>

    <div class="feature-grid" style="margin-bottom:1.25rem">
      <a class="feature" href="#/lookup"><div class="ico">🔎</div><h3>Lookup</h3><p>Full airline or airport record from an IATA code.</p></a>
      <a class="feature" href="#/reports"><div class="ico">📊</div><h3>Route Reports</h3><p>Airports by airline, or airlines by airport, ranked by # routes.</p></a>
      <a class="feature" href="#/directory"><div class="ico">📇</div><h3>Directory</h3><p>Every airline and airport, ordered by IATA code.</p></a>
      <a class="feature" href="#/onehop"><div class="ico">🗺️</div><h3>One-Hop Finder</h3><p>All S → X → D connections, ranked by air miles, on a map.</p></a>
    </div>

    <div class="grid grid-2">
      <div class="card"><h2>Routes per airline</h2><div class="chart-box"><canvas id="c-airlines"></canvas></div></div>
      <div class="card"><h2>Busiest airports (routes in + out)</h2><div class="chart-box"><canvas id="c-airports"></canvas></div></div>
    </div>
    <div class="card" style="margin-top:1.25rem"><h2>Network map</h2><p class="hint">All ${fmt(DB.airports.length)} airports — dot size reflects the number of routes. Click a dot for details.</p><div id="home-map" class="map"></div></div>`;

  makeBarChart(root.querySelector('#c-airlines'), perAirline.map(x => `${x.a.iata} · ${x.a.name}`), perAirline.map(x => x.n), 'Routes',
    i => { location.hash = `#/reports?type=airline&code=${perAirline[i].a.iata}`; });
  makeBarChart(root.querySelector('#c-airports'), busiest.map(x => `${x.k} · ${DB.airport.get(x.k)?.city ?? ''}`), busiest.map(x => x.n), 'Routes',
    i => { location.hash = `#/reports?type=airport&code=${busiest[i].k}`; });

  const map = makeMap(root.querySelector('#home-map')).setView([30, -40], 2);
  const accent = cssVar('--accent');
  for (const ap of DB.airports) {
    const n = (DB.routesByAirport.get(ap.iata) || []).length;
    L.circleMarker([ap.latN, ap.lonN], { radius: 2 + Math.sqrt(n) / 2.2, color: accent, weight: 1, fillOpacity: .45 })
      .bindPopup(`<b>${esc(ap.iata)}</b> · ${esc(ap.name)}<br>${esc(ap.city)}, ${esc(ap.country)}<br>${fmt(n)} routes<br><a href="#/lookup?type=airport&code=${esc(ap.iata)}">Details →</a>`)
      .addTo(map);
  }
}

function typeTabs(base, type, code) {
  const q = t => `#/${base}?type=${t}${code && t === type ? '&code=' + encodeURIComponent(code) : ''}`;
  return `<nav class="tabs" aria-label="Entity type">
    <a href="${q('airline')}" class="${type === 'airline' ? 'active' : ''}">Airline</a>
    <a href="${q('airport')}" class="${type === 'airport' ? 'active' : ''}">Airport</a>
  </nav>`;
}

function codeForm(base, type, code, button) {
  const list = type === 'airline' ? 'airline-codes' : 'airport-codes';
  const examples = type === 'airline' ? ['AA', 'DL', 'UA', 'WN', 'B6', 'SY', 'SB'] : ['SJC', 'SFO', 'ORD', 'ATL', 'DEN', 'JFK', 'LHR'];
  return `
    <form class="form" data-base="${base}" data-type="${type}">
      <div class="field">
        <label for="code">${type === 'airline' ? 'Airline' : 'Airport'} IATA code</label>
        <input id="code" name="code" class="code" type="text" list="${list}" value="${esc(code)}"
          maxlength="60" placeholder="${type === 'airline' ? 'e.g. AA or Delta' : 'e.g. SJC or Chicago'}" autocomplete="off" required>
        <small class="field-hint">Code, ICAO, name or city</small>
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
  return `<dl class="kv">${fields.map(([k, label]) => `<div><dt>${esc(label)}</dt><dd>${show(obj[k])}</dd></div>`).join('')}</dl>`;
}

function renderLookup(root, params) {
  const type = params.get('type') === 'airport' ? 'airport' : 'airline';
  const input = (params.get('code') || '').trim();
  const res = input ? resolveParam('lookup', type, input) : {};
  if (res.redirect) return;
  const code = res.code || '';
  let result = res.html || '';
  setTitle(code ? `${code} · ${type === 'airline' ? DB.airline.get(code).name : DB.airport.get(code).name}` : 'Lookup');

  if (code && type === 'airline') {
    const a = DB.airline.get(code);
    {
      const routes = DB.routesByAirline.get(code) || [];
      const airports = airlineRouteReport(code).length;
      result = `
        <div class="card">
          <div class="entity-head"><span class="badge">${esc(a.iata)}</span><div><h2>${esc(a.name)}</h2><div class="sub">${esc(a.country)} · Airline entity (all ${AIRLINE_FIELDS.length} fields)</div></div></div>
          ${kv(AIRLINE_FIELDS, a)}
        </div>
        <div class="stats">
          <div class="stat"><div class="num">${fmt(routes.length)}</div><div class="lbl">Routes flown</div></div>
          <div class="stat"><div class="num">${fmt(airports)}</div><div class="lbl">Airports served</div></div>
          <div class="stat"><div class="num">${fmt(routes.filter(r => r.codeshare === 'Y').length)}</div><div class="lbl">Codeshare routes</div></div>
        </div>
        <div class="card"><h3>Route network</h3><div id="net-map" class="map"></div></div>
        <a class="btn ghost" href="#/reports?type=airline&code=${esc(code)}">See airports ranked by # routes →</a>`;
    }
  } else if (code) {
    const a = DB.airport.get(code);
    {
      const routes = DB.routesByAirport.get(code) || [];
      const dests = new Set(routes.map(r => r.src === code ? r.dst : r.src));
      result = `
        <div class="grid grid-2">
          <div class="card">
            <div class="entity-head"><span class="badge">${esc(a.iata)}</span><div><h2>${esc(a.name)}</h2><div class="sub">${esc(a.city)}, ${esc(a.country)} · Airport entity (all ${AIRPORT_FIELDS.length} fields)</div></div></div>
            ${kv(AIRPORT_FIELDS, a)}
          </div>
          <div class="card">
            <h3>Connections</h3>
            <div id="ap-map" class="map small"></div>
            <div class="stats" style="margin:1rem 0 0">
              <div class="stat"><div class="num">${fmt(routes.length)}</div><div class="lbl">Routes in + out</div></div>
              <div class="stat"><div class="num">${fmt(dests.size)}</div><div class="lbl">Connected airports</div></div>
            </div>
          </div>
        </div>
        <a class="btn ghost" href="#/reports?type=airport&code=${esc(code)}">See airlines ranked by # routes →</a>`;
    }
  }

  root.innerHTML = `
    <div class="page-head"><h1>Entity Lookup</h1><p>Enter an OpenFlights IATA code to return the complete Airline or Airport entity. ICAO codes, names and cities work too.</p></div>
    ${typeTabs('lookup', type, code)}
    <div class="card">${codeForm('lookup', type, code || input, 'Look up')}</div>
    ${result}`;
  wireCodeForm(root);

  const mapEl = root.querySelector('#ap-map');
  if (mapEl) airportNetworkMap(mapEl, code);
  const netEl = root.querySelector('#net-map');
  if (netEl) airlineNetworkMap(netEl, code);
}

// Every airport an airline touches (dot size = # routes) and each airport pair it connects.
function airlineNetworkMap(el, code) {
  const map = makeMap(el);
  const accent = cssVar('--accent');
  const pairs = new Set();
  for (const r of DB.routesByAirline.get(code) || []) {
    const key = [r.src, r.dst].sort().join('-');
    if (pairs.has(key)) continue;
    pairs.add(key);
    const a = DB.airport.get(r.src), b = DB.airport.get(r.dst);
    if (a && b) L.polyline(greatCircle(a, b, 24), { color: accent, weight: 1, opacity: .25, interactive: false }).addTo(map);
  }
  const rows = airlineRouteReport(code);
  const max = rows[0]?.routeCount || 1;
  const dots = rows.filter(r => !isNaN(r.latN)).map(r =>
    L.circleMarker([r.latN, r.lonN], { radius: 3 + 9 * Math.sqrt(r.routeCount / max), color: accent, weight: 1, fillOpacity: .6 })
      .bindPopup(`<b>${esc(r.iata)}</b> · ${esc(r.name)}<br>${r.routeCount} ${esc(code)} routes<br><a href="#/lookup?type=airport&code=${esc(r.iata)}">Airport details →</a>`));
  const group = L.featureGroup(dots).addTo(map);
  map.fitBounds(group.getBounds(), { padding: [20, 20], maxZoom: 6 });
}

// An airport and a great-circle line to every airport it connects to.
function airportNetworkMap(el, code) {
  const a = DB.airport.get(code);
  const map = makeMap(el);
  const accent = cssVar('--accent');
  const layers = [pin(a, 'src', a.iata)];
  const seen = new Set();
  for (const r of DB.routesByAirport.get(code) || []) {
    const other = DB.airport.get(r.src === code ? r.dst : r.src);
    if (!other || seen.has(other.iata)) continue;
    seen.add(other.iata);
    layers.push(L.polyline(greatCircle(a, other, 24), { color: accent, weight: 1, opacity: .35, interactive: false }));
    layers.push(L.circleMarker([other.latN, other.lonN], { radius: 3, color: accent, weight: 1, fillOpacity: .7 })
      .bindPopup(`<b>${esc(other.iata)}</b> · ${esc(other.name)}<br><a href="#/lookup?type=airport&code=${esc(other.iata)}">Details →</a>`));
  }
  const group = L.featureGroup(layers).addTo(map);
  if (seen.size) map.fitBounds(group.getBounds(), { padding: [20, 20], maxZoom: 6 });
  else map.setView([a.latN, a.lonN], 6);
}

function renderReports(root, params) {
  const type = params.get('type') === 'airport' ? 'airport' : 'airline';
  const input = (params.get('code') || '').trim();
  const res = input ? resolveParam('reports', type, input) : {};
  if (res.redirect) return;
  const code = res.code || '';
  let result = res.html || '';
  let chartData = null;
  setTitle(code ? `${code} route report` : 'Route Reports');

  if (code && type === 'airline') {
    const a = DB.airline.get(code);
    {
      const rows = airlineRouteReport(code);
      const max = rows[0]?.routeCount || 1;
      result = `
        <div class="card">
          <div class="entity-head"><span class="badge">${esc(a.iata)}</span><div><h2>${esc(a.name)}</h2>
            <div class="sub">${fmt(rows.length)} airports reached by ${fmt((DB.routesByAirline.get(code) || []).length)} routes, ordered by # routes to/from each airport</div></div></div>
          ${table([rankCol,
            { label: '# Routes', num: true, hl: true, render: r => `<span class="bar" style="width:${Math.max(4, 60 * r.routeCount / max)}px"></span>${r.routeCount}` },
            ...airportCols], rows, { filter: true, id: 't-report', csv: `${code}-airports-by-routes.csv` })}
        </div>`;
      const top = rows.slice(0, 15);
      chartData = { labels: top.map(r => `${r.iata} · ${r.city}`), values: top.map(r => r.routeCount), title: `Top airports for ${a.name}`,
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
            <div class="sub">${esc(a.city)}, ${esc(a.country)} · ${fmt(rows.length)} airlines, ordered by # routes to/from this airport</div></div></div>
          ${table([rankCol,
            { label: '# Routes', num: true, hl: true, render: r => `<span class="bar" style="width:${Math.max(4, 60 * r.routeCount / max)}px"></span>${r.routeCount}` },
            ...airlineCols], rows, { id: 't-report', csv: `${code}-airlines-by-routes.csv` })}
        </div>`;
      chartData = { labels: rows.map(r => `${r.iata} · ${r.name}`), values: rows.map(r => r.routeCount), title: `Airlines at ${a.iata}`,
        go: i => `#/reports?type=airline&code=${rows[i].iata}` };
    }
  }

  root.innerHTML = `
    <div class="page-head"><h1>Route Reports</h1><p>Ranked by number of routes. For an airline: every airport its routes touch. For an airport: every airline flying to or from it.</p></div>
    ${typeTabs('reports', type, code)}
    <div class="card">${codeForm('reports', type, code || input, 'Run report')}</div>
    ${result}
    ${chartData ? `<div class="grid grid-2">
      <div class="card"><h2>${esc(chartData.title)}</h2><div class="chart-box" style="height:${Math.max(240, chartData.labels.length * 26)}px"><canvas id="c-report"></canvas></div></div>
      <div class="card"><h2>${type === 'airline' ? 'Route network' : `Destinations from ${esc(code)}`}</h2><div id="report-map" class="map"></div></div>
    </div>` : ''}`;
  wireCodeForm(root);
  wireTables(root);
  if (chartData) {
    makeBarChart(root.querySelector('#c-report'), chartData.labels, chartData.values, '# Routes', i => { location.hash = chartData.go(i); });
    (type === 'airline' ? airlineNetworkMap : airportNetworkMap)(root.querySelector('#report-map'), code);
  }
}

function renderDirectory(root, params) {
  const type = params.get('type') === 'airport' ? 'airport' : 'airline';
  const rows = type === 'airline'
    ? [...DB.airlines].sort(byKey('iata'))
    : [...DB.airports].sort(byKey('iata'));
  root.innerHTML = `
    <div class="page-head"><h1>Directory</h1><p>Every ${type} entry in the database, ordered by IATA code, with all fields.</p></div>
    <nav class="tabs" aria-label="Entity type">
      <a href="#/directory?type=airline" class="${type === 'airline' ? 'active' : ''}">Airlines (${DB.airlines.length})</a>
      <a href="#/directory?type=airport" class="${type === 'airport' ? 'active' : ''}">Airports (${DB.airports.length})</a>
    </nav>
    <div class="card">${table(type === 'airline' ? airlineCols : airportCols, rows, { filter: true, id: 't-dir', csv: `${type}s-by-iata.csv` })}</div>`;
  setTitle(type === 'airline' ? 'All airlines' : 'All airports');
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
  setTitle(S && D ? `${S} → ${D} one-hop` : 'One-Hop Finder');

  if (rawS || rawD) {
    const errs = [];
    if (!rs.code) errs.push(rawS ? notFound('airport', rawS, rs.matches, c => hopHref(c, D), 'source ')
      : '<div class="msg error">Enter a source airport (S).</div>');
    if (!rd.code) errs.push(rawD ? notFound('airport', rawD, rd.matches, c => hopHref(S, c), 'destination ')
      : '<div class="msg error">Enter a destination airport (D).</div>');
    if (!errs.length && S === D) errs.push('<div class="msg error">Source and destination must be different airports.</div>');
    if (errs.length) result = `<div class="stack">${errs.join('')}</div>`;
    else {
      data = oneHop(S, D, same);
      const s = DB.airport.get(S), d = DB.airport.get(D);
      const directNote = data.direct.length
        ? `<div class="msg info">There are also ${data.direct.length} nonstop route(s) ${esc(S)} → ${esc(D)} (${data.direct.map(r => esc(r.airline)).join(', ')}), ${fmt(Math.round(data.directMiles))} mi.</div>`
        : `<div class="msg">No nonstop route ${esc(S)} → ${esc(D)} exists in the data; great-circle distance is ${fmt(Math.round(data.directMiles))} mi.</div>`;

      if (!data.pairs.length) {
        result = `${directNote}<div class="msg error" style="margin-top:1rem">No one-hop connections found${same ? ' on a single airline' : ''}.</div>`;
      } else {
        const airlineName = c => DB.airline.get(c)?.name || c;
        result = `
          <div class="stats">
            <div class="stat"><div class="num">${fmt(data.pairs.length)}</div><div class="lbl">Route pairs</div></div>
            <div class="stat"><div class="num">${fmt(data.viaCount)}</div><div class="lbl">Intermediate airports</div></div>
            <div class="stat"><div class="num">${fmt(Math.round(data.pairs[0].total))}</div><div class="lbl">Shortest total (mi)</div></div>
            <div class="stat"><div class="num">${fmt(Math.round(data.directMiles))}</div><div class="lbl">Direct distance (mi)</div></div>
          </div>
          ${directNote}
          <div class="grid grid-2" style="margin-top:1.25rem">
            <div class="card">
              <h2>Top 5 intermediate cities</h2>
              <p style="color:var(--muted);margin:0 0 .75rem;font-size:.9rem">Ranked by # of route pairs through each connecting airport.</p>
              <ol class="top-list">${data.top.map((v, i) => `
                <li><span class="rank">${i + 1}</span>
                  <div class="grow"><b>${esc(v.airport.city)}</b> ${codeLink('airport', v.airport.iata)}<small>${esc(v.airport.name)} · ${fmt(Math.round(v.total))} mi total</small></div>
                  <b>${v.count}</b>&nbsp;<span style="color:var(--muted);font-size:.8rem">routes</span></li>`).join('')}
              </ol>
            </div>
            <div class="card">
              <div id="hop-map" class="map"></div>
              <div class="legend"><span><i style="background:var(--good)"></i>Source ${esc(S)}</span><span><i style="background:var(--bad)"></i>Destination ${esc(D)}</span><span><i style="background:var(--warm)"></i>Top 5 connections (number = rank)</span><span><i style="background:var(--accent)"></i>Selected route pair</span></div>
            </div>
          </div>
          <div class="card" style="margin-top:1.25rem">
            <h2>All route pairs, ordered by total air miles</h2>
            <p class="hint">Click a row to show that route pair on the map.</p>
            ${table([
              rankCol,
              { label: 'Via', render: p => `${codeLink('airport', p.via.iata)} ${esc(p.via.city)}` },
              { label: `Leg 1 airline (${S}→X)`, render: p => `${codeLink('airline', p.r1.airline)} ${esc(airlineName(p.r1.airline))}${p.r1.codeshare === 'Y' ? ' <span class="null">codeshare</span>' : ''}` },
              { label: 'Leg 1 mi', num: true, render: p => fmt(Math.round(p.leg1)) },
              { label: `Leg 2 airline (X→${D})`, render: p => `${codeLink('airline', p.r2.airline)} ${esc(airlineName(p.r2.airline))}${p.r2.codeshare === 'Y' ? ' <span class="null">codeshare</span>' : ''}` },
              { label: 'Leg 2 mi', num: true, render: p => fmt(Math.round(p.leg2)) },
              { label: 'Total mi', num: true, hl: true, render: p => fmt(Math.round(p.total)) },
              { label: 'Equipment', render: p => `${show(p.r1.equipment)} / ${show(p.r2.equipment)}` },
            ], data.pairs, { filter: true, id: 't-hop', csv: `${S}-${D}-one-hop.csv` })}
          </div>`;
      }
      data.s = s; data.d = d;
    }
  }

  root.innerHTML = `
    <div class="page-head"><h1>One-Hop Finder</h1><p>Finds every route pair S → X and X → D where both legs are nonstop (0 stops), computes total air miles from airport GPS coordinates (great-circle), and orders the pairs from shortest to longest.</p></div>
    <div class="card">
      <form class="form" id="hop-form">
        <div class="field"><label for="src">From (S)</label><input id="src" name="src" class="code" type="text" list="airport-codes" value="${esc(S)}" placeholder="e.g. SJC" maxlength="4" autocomplete="off" required></div>
        <button class="btn ghost swap" type="button" id="swap" title="Swap" aria-label="Swap source and destination">⇄</button>
        <div class="field"><label for="dst">To (D)</label><input id="dst" name="dst" class="code" type="text" list="airport-codes" value="${esc(D)}" placeholder="e.g. BOS" maxlength="4" autocomplete="off" required></div>
        <label class="check"><input type="checkbox" name="same" ${same ? 'checked' : ''}> Same airline on both legs</label>
        <button class="btn" type="submit">Find connections</button>
      </form>
      <div class="chips">${[['SJC', 'BOS'], ['SFO', 'JFK'], ['LAX', 'YYZ'], ['SEA', 'MIA'], ['ATL', 'DEN'], ['SFO', 'LHR']]
        .map(([a, b]) => `<a class="chip" href="#/onehop?src=${a}&dst=${b}">${a} → ${b}</a>`).join('')}</div>
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

  const mapEl = root.querySelector('#hop-map');
  if (mapEl && data) {
    const map = makeMap(mapEl);
    const warm = cssVar('--warm');
    const layers = [];
    data.top.forEach((v, i) => {
      const w = 2 + 3 * (v.count / data.top[0].count);
      layers.push(L.polyline(greatCircle(data.s, v.airport), { color: warm, weight: w, opacity: .8 }).bindTooltip(`${data.s.iata} → ${v.airport.iata}`));
      layers.push(L.polyline(greatCircle(v.airport, data.d), { color: warm, weight: w, opacity: .8, dashArray: '6 6' }).bindTooltip(`${v.airport.iata} → ${data.d.iata}`));
      layers.push(pin(v.airport, 'via', i + 1).bindPopup(`<b>#${i + 1} ${esc(v.airport.city)} (${esc(v.airport.iata)})</b><br>${v.count} route pairs<br>${fmt(Math.round(v.total))} mi total`));
    });
    layers.push(pin(data.s, 'src', data.s.iata).bindPopup(`<b>Source</b><br>${esc(data.s.name)}`));
    layers.push(pin(data.d, 'dst', data.d.iata).bindPopup(`<b>Destination</b><br>${esc(data.d.name)}`));
    const group = L.featureGroup(layers).addTo(map);
    map.fitBounds(group.getBounds(), { padding: [30, 30] });

    // Highlight one route pair (default: the shortest, row 1) when its table row is clicked.
    let hl = null;
    const tbody = root.querySelector('#t-hop tbody');
    const select = (i, focusMap) => {
      const p = data.pairs[i];
      if (hl) hl.remove();
      const accent = cssVar('--accent');
      hl = L.featureGroup([
        L.polyline([...greatCircle(data.s, p.via), ...greatCircle(p.via, data.d).slice(1)], { color: accent, weight: 5, opacity: .95 }),
        L.circleMarker([p.via.latN, p.via.lonN], { radius: 7, color: '#fff', weight: 2, fillColor: accent, fillOpacity: 1 }),
      ]).addTo(map);
      hl.bindTooltip(`#${i + 1}: ${data.s.iata} → ${p.via.iata} (${p.r1.airline}) → ${data.d.iata} (${p.r2.airline}) · ${fmt(Math.round(p.total))} mi`,
        { direction: 'top', offset: [0, -10] }).openTooltip([p.via.latN, p.via.lonN]);
      tbody.querySelectorAll('tr.selected').forEach(tr => tr.classList.remove('selected'));
      tbody.querySelector(`tr[data-i="${i}"]`)?.classList.add('selected');
      if (focusMap) {
        map.fitBounds(L.featureGroup([group, hl]).getBounds(), { padding: [30, 30] });
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
  setTitle('Get ID');
  root.innerHTML = `
    <div class="page-head"><h1>Get ID</h1><p>Site ownership verification.</p></div>
    <div class="card">
      <div class="id-card">
        <img class="avatar" src="assets/me.jpg" alt="Photo of ${esc(STUDENT.name)}"
          onerror="this.outerHTML='<div class=&quot;avatar&quot; aria-hidden=&quot;true&quot;>RG</div>'">
        <div>
          <div style="color:var(--muted);font-size:.85rem;text-transform:uppercase;letter-spacing:.06em;font-weight:600">${esc(STUDENT.school)} Student ID</div>
          <div class="idnum">${esc(STUDENT.id)}</div>
          <h2 style="margin:.25rem 0 0">${esc(STUDENT.name)}</h2>
          <div style="color:var(--muted)">${esc(STUDENT.course)} · Vibe Coding Assignment — creative genius behind this site</div>
          <div class="verify">✔ This site is owned and published by ${esc(STUDENT.name)} (${esc(STUDENT.id)})</div>
        </div>
      </div>
    </div>
    <div class="grid grid-2">
      <div class="card">
        <h2>About this project</h2>
        <p>VibeAviate is a browser front end for an air-travel database built from an OpenFlights subset. It was built by vibe coding — collaborating with an AI advisor.</p>
        <ul class="clean">
          <li><b>Lookup</b> — full Airline / Airport entity by IATA code</li>
          <li><b>Route Reports</b> — airports by airline and airlines by airport, ranked by # routes</li>
          <li><b>Directory</b> — all airlines and airports ordered by IATA code</li>
          <li><b>One-Hop Finder</b> — S → X → D nonstop pairs ranked by great-circle miles, top 5 connections on a map</li>
        </ul>
        <h3 style="margin-top:1rem">Extras</h3>
        <ul class="clean">
          <li>Search by IATA, ICAO, name or city, with “did you mean” suggestions</li>
          <li>Sortable, filterable tables with CSV download</li>
          <li>Route-network maps, clickable charts, click-to-map one-hop results</li>
          <li>Light / dark theme, mobile layout, shareable URLs for every result</li>
        </ul>
      </div>
      <div class="card">
        <h2>Data &amp; method</h2>
        <ul class="clean">
          <li>${fmt(DB.airlines.length)} airlines, ${fmt(DB.airports.length)} airports, ${fmt(DB.routes.length)} routes</li>
          <li>Routes are directional; "# routes" counts every route that starts or ends at the airport.</li>
          <li>One-hop pairs require 0 stops on both legs; the ${DB.routes.filter(r => r.stops !== '0').length} routes with stops are excluded.</li>
          <li>Air miles use the haversine formula (Earth radius 3,958.8 mi).</li>
          <li><code>\\N</code> in the source data means "no value" and is shown as —.</li>
          <li>Maps: Leaflet + OpenStreetMap. Charts: Chart.js.</li>
        </ul>
      </div>
    </div>`;
}

/* ---------------- Router ---------------- */

const PAGES = { home: renderHome, lookup: renderLookup, reports: renderReports, directory: renderDirectory, onehop: renderOneHop, about: renderAbout };

function route() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const page = PAGES[path] ? path : 'home';
  cleanup();
  const root = document.getElementById('app');
  const div = document.createElement('div');
  div.className = 'page';
  root.replaceChildren(div);
  PAGES[page](div, new URLSearchParams(qs || ''));
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === page));
  document.querySelector('.nav').classList.remove('open');
  document.querySelector('.menu-toggle').setAttribute('aria-expanded', 'false');
  window.scrollTo(0, 0);
  if (document.activeElement === document.body || !root.contains(document.activeElement)) root.focus({ preventScroll: true });
}

/* ---------------- Theme ---------------- */

const THEME_ICONS = { system: '◐', light: '☀', dark: '☾' };
function getTheme() { try { return localStorage.getItem('theme') || 'system'; } catch { return 'system'; } }
function applyTheme(t) {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const btn = document.querySelector('.theme-toggle');
  btn.textContent = THEME_ICONS[t];
  btn.setAttribute('aria-label', `Theme: ${t} (click to change)`);
  btn.title = `Theme: ${t}`;
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

document.querySelector('.menu-toggle').addEventListener('click', e => {
  const open = document.querySelector('.nav').classList.toggle('open');
  e.currentTarget.setAttribute('aria-expanded', String(open));
});

loadData()
  .then(() => { window.addEventListener('hashchange', route); route(); })
  .catch(err => {
    const hint = location.protocol === 'file:'
      ? ' Browsers block loading data files from a page opened directly from disk — serve the folder instead, e.g. <code>python3 -m http.server</code>.'
      : '';
    document.getElementById('app').innerHTML = `<div class="msg error">Failed to load data: ${esc(err.message)}.${hint}</div>`;
  });
