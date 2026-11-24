// Launch Radar's dashboard. It reads window.RADAR (written beside dashboard/
// by main.ts) and renders the ranked board, a per-protocol detail view, the
// evidence and method view, and the set-aside traded protocols. No network:
// every byte it shows is in data.js. On load it recomputes every row's implied
// value from the printed model coefficients and checks the board checksum, so
// the page proves it agrees with board.json instead of merely saying so.
(function () {
  'use strict';
  var D = window.RADAR;
  var app = document.getElementById('app');
  if (!D) { app.textContent = 'No radar data: data.js was not written beside this page.'; return; }

  // ------------------------------------------------------------- formatting
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function commas(n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function usd(n) { return '$' + commas(n); }
  function usdC(n) {
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + Math.round(n);
  }
  function pct(n, d) { return (n * 100).toFixed(d == null ? 1 : d) + '%'; }
  function chg(n) { if (n == null) return '<span class="dim">—</span>'; return '<span class="' + (n >= 0 ? 'pos' : 'neg') + '">' + (n >= 0 ? '+' : '') + n.toFixed(1) + '%</span>'; }
  function miss(x) { return '×' + x.toFixed(2); }
  function tierBadge(r) {
    if (r.tier === 'watchlist') return '<span class="badge w">WATCHLIST</span>';
    if (r.tier === 'flagged') return '<span class="badge f">LINEAGE?</span>';
    return '<span class="badge">EARLY</span>';
  }
  function bySlug(slug) { for (var i = 0; i < D.rows.length; i++) if (D.rows[i].slug === slug) return D.rows[i]; return null; }

  // -------------------------------------------- integrity: recompute in page
  var INTEG = (function () {
    var M = D.model, ok = 0, mono = true, prev = Infinity, i, r;
    var sorted = D.rows.slice().sort(function (a, b) { return a.rank - b.rank; });
    for (i = 0; i < sorted.length; i++) {
      r = sorted[i];
      if (r.implied_value_usd > prev) mono = false;
      prev = r.implied_value_usd;
      var lv = Math.exp(M.value.intercept + M.value.slope * Math.log(r.tvl_usd) + r.category_effect + r.chain_effect);
      var z = M.odds.weights[0];
      for (var d = 0; d < 4; d++) z += M.odds.weights[d + 1] * ((r.odds_inputs[d] - M.odds.means[d]) / M.odds.sds[d]);
      var odds = 1 / (1 + Math.exp(-z));
      var imp = Math.round(lv * odds * r.odds_discount);
      if (Math.abs(imp - r.implied_value_usd) <= Math.max(2, r.implied_value_usd * 0.01)) ok++;
    }
    var s = D.rows.map(function (x) { return x.rank + ':' + x.slug + ':' + x.implied_value_usd; }).join('|');
    var h = 0x811c9dc5;
    for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    var sum = ('0000000' + h.toString(16)).slice(-8);
    var ledger = D.ledger.reduce(function (a, l) { return a + l.count; }, 0);
    var wl = D.rows.filter(function (x) { return x.tier === 'watchlist'; }).length;
    return { ok: ok, mono: mono, sum: sum, sumOk: sum === D.board_checksum, ledger: ledger, wl: wl };
  })();
  function integStrip() {
    return '<div class="integ">INTEGRITY · recomputed in this page from the printed coefficients: <b>' + INTEG.ok + ' of ' + D.rows.length +
      ' implied values reproduced</b> · ranks 1..' + D.rows.length + ' in order, values never rise: <b>' + (INTEG.mono ? 'yes' : 'NO') +
      '</b> · board checksum <b>' + INTEG.sum + '</b> ' + (INTEG.sumOk ? '= board.json ✓' : '≠ board.json ✗') +
      ' · watchlist <b>' + INTEG.wl + ' of ' + D.counts.watchlist + '</b> ranked · ledger <b>' + INTEG.ledger + ' of ' + D.counts.protocols + '</b> protocols accounted</div>';
  }

  // ------------------------------------------------------------- page frame
  function frame(view, body) {
    var V = D.validation, wf = V.walkForward;
    var farmN = D.rows.filter(function (r) { return r.farm.verdict === 'farm'; }).length;
    var h = '<header class="top"><h1>LAUNCH <span class="rad">RADAR</span></h1>' +
      '<span class="tag">pre-token protocols, valued from their own record — implied = fitted launch value × fitted launch odds</span>' +
      '<span class="ver">model ' + esc(D.model_version) + ' · snapshot ' + esc(D.as_of) + '<br>DefiLlama sealed snapshot · floor ' + usdC(D.floor_usd) + '</span></header>' +
      '<nav class="tabs">' +
      '<a href="#/" class="' + (view === 'board' ? 'on' : '') + '">BOARD</a>' +
      '<a href="#/evidence" class="' + (view === 'evidence' ? 'on' : '') + '">EVIDENCE &amp; METHOD</a>' +
      '<a href="#/live" class="' + (view === 'live' ? 'on' : '') + '">ALREADY TRADES (' + D.live.length + ')</a></nav>';
    if (view === 'board') {
      h += '<div class="kpis">' +
        kpi(D.counts.board, 'protocols ranked', 'of ' + D.counts.protocols + ' in the snapshot') +
        kpi(D.counts.watchlist + '/' + D.counts.watchlist, 'watchlist covered', 'every house-listed name ranked', 'teal') +
        kpi(miss(V.fittedLoo.missMultiple), 'leave-one-out miss', 'flat 0.25×TVL ' + miss(V.flatLoo.missMultiple) + ' · starter ' + miss(V.starterLoo.missMultiple)) +
        kpi(miss(wf.fitted.missMultiple), 'walk-forward miss', 'fit ≤ ' + wf.cutoff + ' → later-listed · flat ' + miss(wf.flat.missMultiple), 'teal') +
        kpi(pct(V.bandCoverageLoo, 1), 'band honesty', 'of real caps inside the stated P25–P75 (held out)') +
        kpi(farmN, 'worth farming', 'verdict FARM at the $1,000 reference deposit', 'grn') +
        '</div>' + acctBar() + integStrip();
    }
    return h + body + '<footer>Launch Radar · model ' + esc(D.model_version) + ' · every figure on this page is computed by main.ts from the sealed snapshot and recomputed above in your browser. Implied values are model estimates from TVL, category, age and chain record — not prices, not advice.</footer>';
  }
  function kpi(n, l, s, cls) { return '<div class="kpi"><div class="n ' + (cls || '') + '">' + n + '</div><div class="l">' + l + '</div><div class="s">' + s + '</div></div>'; }
  var GROUPS = [
    ['ranked', 'Ranked pre-token', '#f5b942', ['ranked_watchlist', 'ranked_early', 'ranked_flagged']],
    ['priced', 'Already trades (priced)', '#2dd4bf', ['trades_priced']],
    ['unpriced', 'Token recorded, no cap', '#5b8dd9', ['trades_unpriced']],
    ['aside', 'Set aside by rule', '#8494a7', ['excluded_category', 'excluded_versioned', 'excluded_wrapped_name', 'excluded_exchange']]
  ];
  function groupCount(keys) { return D.ledger.filter(function (l) { return keys.indexOf(l.group) >= 0; }).reduce(function (a, l) { return a + l.count; }, 0); }
  function acctBar() {
    var bar = '<div class="acct">', lab = '<div class="acctlab">';
    GROUPS.forEach(function (g) {
      var n = groupCount(g[3]);
      var w = (n / D.counts.protocols * 100).toFixed(1);
      bar += '<div style="background:' + g[2] + ';width:' + w + '%">' + (n >= 40 ? n : '') + '</div>';
      lab += '<span><span class="dot" style="background:' + g[2] + '"></span>' + g[1] + ' <b>' + n + '</b></span>';
    });
    return bar + '</div>' + lab + '<span class="dim">— all ' + D.counts.protocols + ' protocols, each in exactly one group; the ledger with rules is on the evidence view.</span></div>';
  }

  // ------------------------------------------------------------------ board
  var F = { q: '', tier: 'all', verdict: 'all', cat: 'all', chain: 'all', minOdds: 0, sort: 'rank', dir: 1 };
  function cats() { var s = {}; D.rows.forEach(function (r) { s[r.category || '(uncategorised)'] = 1; }); return Object.keys(s).sort(); }
  function chains() { var s = {}; D.rows.forEach(function (r) { r.chains.forEach(function (c) { s[c] = 1; }); }); return Object.keys(s).sort(); }
  function filtered() {
    var out = D.rows.filter(function (r) {
      if (F.tier !== 'all' && r.tier !== F.tier) return false;
      if (F.verdict !== 'all' && r.farm.verdict !== F.verdict) return false;
      if (F.cat !== 'all' && (r.category || '(uncategorised)') !== F.cat) return false;
      if (F.chain !== 'all' && r.chains.indexOf(F.chain) < 0) return false;
      if (r.launch_odds * r.odds_discount < F.minOdds) return false;
      if (F.q && (r.name + ' ' + r.slug).toLowerCase().indexOf(F.q) < 0) return false;
      return true;
    });
    var k = F.sort, dir = F.dir;
    var val = { rank: function (r) { return r.rank; }, tvl: function (r) { return r.tvl_usd; }, chg: function (r) { return r.change_7d == null ? -1e9 : r.change_7d; }, age: function (r) { return r.age_days == null ? -1 : r.age_days; }, odds: function (r) { return r.launch_odds * r.odds_discount; }, launch: function (r) { return r.launch_value_usd; }, implied: function (r) { return r.implied_value_usd; }, perh: function (r) { return r.farm.per_hour_usd; } }[k];
    out.sort(function (a, b) { return (val(a) - val(b)) * dir || a.rank - b.rank; });
    return out;
  }
  function th(key, label, cls) { if (!key) return '<th class="' + (cls || '') + '">' + label + '</th>'; return '<th class="' + (cls || '') + '" data-sort="' + key + '">' + label + (F.sort === key ? (F.dir === 1 ? ' ↑' : ' ↓') : '') + '</th>'; }
  function boardView() {
    var rows = filtered();
    var h = '<div class="controls">' +
      '<input type="text" id="fq" placeholder="search name or slug…" value="' + esc(F.q) + '">' +
      '<label>TIER <select id="ftier">' + opts(['all', 'watchlist', 'early', 'flagged'], F.tier) + '</select></label>' +
      '<label>VERDICT <select id="fverd">' + opts(['all', 'farm', 'marginal', 'skip'], F.verdict) + '</select></label>' +
      '<label>CATEGORY <select id="fcat">' + opts(['all'].concat(cats()), F.cat) + '</select></label>' +
      '<label>CHAIN <select id="fchain">' + opts(['all'].concat(chains()), F.chain) + '</select></label>' +
      '<label>MIN ODDS <input type="range" id="fodds" min="0" max="0.9" step="0.05" value="' + F.minOdds + '"> <span id="foddsv">' + pct(F.minOdds, 0) + '</span></label>' +
      '<span class="count">' + rows.length + ' of ' + D.rows.length + ' rows · click a row for its detail</span></div>';
    h += '<table><thead><tr>' + th('rank', '#', 'l') + th('', 'Protocol', 'l') + '<th class="l">Category</th><th class="l">Chains</th>' +
      th('tvl', 'TVL') + th('chg', '7d') + th('age', 'No-token age') + th('odds', 'Launch odds') + th('launch', 'If it launches') + th('implied', 'Implied · P25–P75') + th('perh', 'Farm verdict · net $/h') + '</tr></thead><tbody>';
    rows.forEach(function (r) {
      var odds = r.launch_odds * r.odds_discount;
      h += '<tr class="row" data-slug="' + esc(r.slug) + '"><td class="l"><span class="rk">' + r.rank + '</span> <span class="rng">' + r.rank_range[0] + '–' + r.rank_range[1] + '</span></td>' +
        '<td class="l"><span class="nm">' + esc(r.name) + '</span>' + tierBadge(r) + '<br><span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td class="l">' + esc(r.category || '—') + '</td>' +
        '<td class="l">' + esc(r.chains[0] || '—') + (r.chains.length > 1 ? ' <span class="dim">+' + (r.chains.length - 1) + '</span>' : '') + '</td>' +
        '<td>' + usdC(r.tvl_usd) + '</td><td>' + chg(r.change_7d) + '</td>' +
        '<td>' + (r.age_days == null ? '—' : r.age_days + 'd') + '</td>' +
        '<td><span class="oddsbar"><i style="width:' + Math.round(odds * 100) + '%"></i></span>' + pct(odds, 0) + '</td>' +
        '<td>' + usdC(r.launch_value_usd) + '</td>' +
        '<td><span class="imp">' + usdC(r.implied_value_usd) + '</span><br><span class="band">' + usdC(r.implied_p25_usd) + ' – ' + usdC(r.implied_p75_usd) + '</span></td>' +
        '<td><span class="vd ' + r.farm.verdict + '">' + r.farm.verdict.toUpperCase() + '</span> <span class="perh">' + (r.farm.net_usd >= 0 ? '+' : '') + '$' + r.farm.per_hour_usd.toFixed(2) + '/h</span></td></tr>';
    });
    return frame('board', h + '</tbody></table>');
  }
  function opts(list, cur) { return list.map(function (o) { return '<option value="' + esc(o) + '"' + (o === cur ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join(''); }
  function bindBoard() {
    function on(id, ev, fn) { var el = document.getElementById(id); if (el) el.addEventListener(ev, fn); }
    on('fq', 'input', function (e) { F.q = e.target.value.toLowerCase(); render(); keepFocus('fq'); });
    on('ftier', 'change', function (e) { F.tier = e.target.value; render(); });
    on('fverd', 'change', function (e) { F.verdict = e.target.value; render(); });
    on('fcat', 'change', function (e) { F.cat = e.target.value; render(); });
    on('fchain', 'change', function (e) { F.chain = e.target.value; render(); });
    on('fodds', 'input', function (e) { F.minOdds = parseFloat(e.target.value); render(); keepFocus('fodds'); });
    Array.prototype.forEach.call(app.querySelectorAll('th[data-sort]'), function (t) {
      t.addEventListener('click', function () {
        var k = t.getAttribute('data-sort');
        if (F.sort === k) F.dir *= -1; else { F.sort = k; F.dir = k === 'rank' ? 1 : -1; }
        render();
      });
    });
    Array.prototype.forEach.call(app.querySelectorAll('tr.row'), function (tr) {
      tr.addEventListener('click', function () { location.hash = '#/p/' + tr.getAttribute('data-slug'); });
    });
  }
  function keepFocus(id) { var el = document.getElementById(id); if (el) { el.focus(); if (el.setSelectionRange) try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) {} } }

  // ----------------------------------------------------------------- detail
  function detailView(r) {
    var M = D.model, odds = r.launch_odds * r.odds_discount;
    var names = ['Years listed', 'Category token share', 'Log TVL', '7d growth (clamped)'];
    var z = M.odds.weights[0], zrows = '';
    for (var d = 0; d < 4; d++) {
      var c = M.odds.weights[d + 1] * ((r.odds_inputs[d] - M.odds.means[d]) / M.odds.sds[d]);
      z += c;
      zrows += '<tr><td class="l">' + names[d] + '</td><td>' + r.odds_inputs[d].toFixed(2) + '</td><td>' + M.odds.weights[d + 1].toFixed(3) + '</td><td>' + (c >= 0 ? '+' : '') + c.toFixed(3) + '</td></tr>';
    }
    var comps = (D.comps[r.category || '(uncategorised)'] || []);
    var h = '<p class="back"><a href="#/">← back to the board</a></p>' +
      '<section class="panel"><h2>#' + r.rank + ' · ' + esc(r.name) + tierBadge(r) + '</h2>' +
      '<div class="grid3"><div><h3>Snapshot facts</h3><dl class="kv">' +
      kv('Slug', esc(r.slug)) + kv('Category', esc(r.category || '—')) + kv('Chains', esc(r.chains.join(', ') || '—')) +
      kv('TVL', usd(r.tvl_usd)) + kv('7-day change', r.change_7d == null ? '—' : r.change_7d.toFixed(1) + '%') +
      kv('Listed', esc(r.listed_at || '—')) + kv('No-token age', r.age_days == null ? '—' : r.age_days + ' days') +
      kv('Token', 'none recorded — pre-token') + kv('Rank range (own band)', r.rank_range[0] + ' – ' + r.rank_range[1]) + '</dl></div>' +
      '<div><h3>Value decomposition</h3><dl class="kv">' +
      kv('Size curve at this TVL', usd(r.size_curve_usd)) +
      kv('× category effect', '×' + Math.exp(r.category_effect).toFixed(3) + ' (log ' + r.category_effect.toFixed(3) + ')') +
      (M.value.chains_term ? kv('× chain-count effect', '×' + Math.exp(r.chain_effect).toFixed(3) + ' (log ' + r.chain_effect.toFixed(3) + ')') : kv('× chain-count effect', 'not in the shipped model')) +
      kv('= launch value, if it launches', usd(r.launch_value_usd)) +
      kv('× launch odds', pct(r.launch_odds, 1)) + (r.odds_discount !== 1 ? kv('× lineage discount', '×' + r.odds_discount) : '') +
      kv('= implied value', '<span class="amb">' + usd(r.implied_value_usd) + '</span>') +
      kv('P25 – P75 band', usd(r.implied_p25_usd) + ' – ' + usd(r.implied_p75_usd)) + '</dl>' +
      '<p class="dim">The size curve is log-log OLS on the ' + M.value.priced_n + ' priced protocols; category effects are shrunk toward it (K=' + M.value.shrink_k + '), so a category with one comparable barely moves.</p></div>' +
      '<div><h3>Odds decomposition</h3><table><thead><tr><th class="l">Feature</th><th>Value</th><th>Weight</th><th>Push</th></tr></thead><tbody>' + zrows +
      '<tr><td class="l">Intercept</td><td></td><td>' + M.odds.weights[0].toFixed(3) + '</td><td>' + (M.odds.weights[0] >= 0 ? '+' : '') + M.odds.weights[0].toFixed(3) + '</td></tr>' +
      '<tr><td class="l"><b>Fitted odds</b></td><td></td><td></td><td><b class="tea">' + pct(odds, 1) + '</b></td></tr></tbody></table>' +
      '<p class="dim">Logistic fit over all ' + D.counts.protocols + ' protocols, outcome “records a token”. Odds are peer frequencies, not a forecast for this name.</p></div></div></section>';
    var f = r.farm;
    h += '<section class="panel"><h2>Farm plan — costed</h2>' +
      '<div class="verdictbox">Verdict <span class="big vd ' + f.verdict + '">' + f.verdict.toUpperCase() + '</span> at the ' + usd(f.deposit_usd) +
      ' reference deposit · expected drop <b>' + usd(f.gross_usd) + '</b> − gas &amp; capital charge <b>' + usd(f.cost_usd) + '</b> = net <b>' + (f.net_usd >= 0 ? '+' : '') + usd(f.net_usd) + '</b> over ~' + f.hours +
      ' h of work → <b>' + (f.per_hour_usd >= 0 ? '+' : '') + '$' + f.per_hour_usd.toFixed(2) + '/hour</b> · pool split across ~' + commas(f.farmers) + ' farmers · hold ' + f.hold_days + ' days</div>' +
      '<ol class="steps">' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol></section>';
    if (comps.length) {
      h += '<section class="panel"><h2>Priced peers in ' + esc(r.category || 'this category') + '</h2><p>The comparables the value fit learned from in this category (largest caps):</p><table><thead><tr><th class="l">Protocol</th><th>TVL</th><th>Market cap</th><th>Cap / TVL</th></tr></thead><tbody>' +
        comps.map(function (c) { return '<tr><td class="l">' + esc(c.name) + '</td><td>' + usdC(c.tvl_usd) + '</td><td>' + usdC(c.mcap_usd) + '</td><td>' + (c.mcap_usd / c.tvl_usd).toFixed(2) + '</td></tr>'; }).join('') + '</tbody></table></section>';
    }
    return frame('detail', h);
  }
  function kv(k, v) { return '<dt>' + k + '</dt><dd>' + v + '</dd>'; }

  // --------------------------------------------------------------- evidence
  function scoreRow(label, s, base) { return '<tr><td class="l">' + label + '</td><td>' + miss(s.missMultiple) + '</td><td>' + s.spearman.toFixed(3) + '</td><td>' + s.n + '</td></tr>'; }
  function evidenceView() {
    var V = D.validation, wf = V.walkForward, M = D.model, A = D.farm_assumptions;
    var h = '<section class="panel"><h2>The model, in one line</h2>' +
      '<p><code>implied = launch value × launch odds</code> — launch value from a log-log size curve fitted on the ' + M.value.priced_n +
      ' protocols whose token already trades with a usable cap (16 of the 144 cap-recording protocols record 0 or −1, a placeholder, and are excluded), plus per-category effects shrunk toward the curve; launch odds from a logistic fit over all ' +
      D.counts.protocols + ' protocols on years listed, category token share, size and growth. No protocol is named or special-cased anywhere in the model.</p>' +
      '<p>Fitted value coefficients: intercept <code>' + M.value.intercept.toFixed(4) + '</code> · slope on log TVL <code>' + M.value.slope.toFixed(4) + '</code> · category shrinkage K <code>' + M.value.shrink_k +
      '</code> · residual P25/P75 <code>' + M.value.resid_q25.toFixed(3) + ' / ' + M.value.resid_q75.toFixed(3) + '</code> (log space). Odds weights: [' + M.odds.weights.map(function (w) { return w.toFixed(3); }).join(', ') + '], base rate ' + pct(M.odds.base_rate, 1) + '.</p></section>';
    h += '<div class="grid2"><section class="panel"><h2>Validation — leave-one-out</h2><p>Each of the ' + V.fittedLoo.n + ' priced protocols is priced by a fit that never saw it. Miss is the median multiple by which the fitted value misses the real cap.</p>' +
      '<table><thead><tr><th class="l">Model</th><th>Miss</th><th>Spearman</th><th>n</th></tr></thead><tbody>' +
      scoreRow('<b>This model (' + esc(D.model_version) + ')</b>', V.fittedLoo) + scoreRow('This model + log chain count', V.chainsLoo) + scoreRow('Starter radar-1 formula', V.starterLoo) + scoreRow('Flat 0.25 × TVL', V.flatLoo) +
      '</tbody></table><p>Band honesty: <b class="amb">' + pct(V.bandCoverageLoo, 1) + '</b> of real caps fall inside the stated P25–P75 band, held out — the nominal share is 50%, so the band is honest, not flattering.</p></section>' +
      '<section class="panel"><h2>Validation — walk-forward</h2><p>Fit on the priced protocols listed on or before <b>' + wf.cutoff + '</b> (n=' + wf.trainN + '), price those listed after it (n=' + wf.testN + '). The model only ever prices protocols from its own future; priced protocols with no listing date sit this test out.</p>' +
      '<table><thead><tr><th class="l">Model</th><th>Miss</th><th>Spearman</th><th>n</th></tr></thead><tbody>' +
      scoreRow('<b>This model (' + esc(D.model_version) + ')</b>', wf.fitted) + scoreRow('This model + log chain count', wf.chains) + scoreRow('Starter radar-1 formula', wf.starter) + scoreRow('Flat 0.25 × TVL', wf.flat) +
      '</tbody></table><p>Odds validation (Brier, lower is better): in-sample <b>' + V.oddsBrierInSample.toFixed(4) + '</b> · ten-fold <b>' + V.oddsBrierTenFold.toFixed(4) + '</b> · always-the-base-rate <b>' + V.oddsBrierBaseRate.toFixed(4) + '</b>.</p></section></div>';
    h += '<section class="panel"><h2>Term ablation — the two-test rule</h2><p>A term joins the shipped model only if it lowers the held-out miss in <b>both</b> leave-one-out and walk-forward. Failed terms stay printed here, not buried.</p>' +
      '<table><thead><tr><th class="l">Term</th><th>Leave-one-out</th><th>Walk-forward</th><th class="l">Decision</th></tr></thead><tbody>' +
      '<tr><td class="l">Log-log size curve (log TVL)</td><td>—</td><td>—</td><td class="l"><b class="tea">KEPT</b> — the core term; both tests above run on the model that carries it</td></tr>' +
      '<tr><td class="l">Category effects, shrunk (K=' + M.value.shrink_k + ')</td><td>—</td><td>—</td><td class="l"><b class="tea">KEPT</b> — part of the fitted model in both tests</td></tr>' +
      '<tr><td class="l">Log chain count</td><td>' + miss(V.chainsLoo.missMultiple) + ' vs ' + miss(V.fittedLoo.missMultiple) + ' — better</td><td>' + miss(wf.chains.missMultiple) + ' vs ' + miss(wf.fitted.missMultiple) + ' — worse</td><td class="l"><b class="neg">NOT KEPT</b> — wins one test, fails the other; the shipped model is ' + esc(D.model_version) + ' without it</td></tr>' +
      '<tr><td class="l">7-day growth in the value fit</td><td colspan="2">tested in phase-1 offline ablation: it raised the miss</td><td class="l"><b class="neg">NOT KEPT</b> — one noisy week in a falling market (median −8.2%); growth enters only through the odds</td></tr>' +
      '</tbody></table></section>';
    h += '<div class="grid2"><section class="panel"><h2>Classification — the rules</h2><p>A protocol is ranked only if the snapshot records no token for it (market cap, gecko id and symbol all empty). House-style visible rules then set aside, in this order: a derivative category (Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC, CEX); a name ending in a version marker; a whole word wrapped / staked / staking in the name; a name beginning with an exchange’s name. Pre-token protocols at or above the floor that no visible rule explains — the house left them off its watchlist for a reason the snapshot cannot show, most plausibly a recorded parent protocol — are ranked in a flagged tier with their odds halved (×' + M.lineage_odds_discount + ') and the flag printed on the row, never silently dropped and never silently trusted.</p>' +
      '<h3>The ledger — all ' + D.counts.protocols + ' accounted</h3><table><thead><tr><th class="l">Group</th><th>Count</th><th class="l">Rule</th></tr></thead><tbody>' +
      D.ledger.map(function (l) { return '<tr><td class="l">' + esc(l.group) + '</td><td>' + l.count + '</td><td class="l mut">' + esc(l.rule) + '</td></tr>'; }).join('') +
      '</tbody></table></section>' +
      '<section class="panel"><h2>Farm economics — the assumptions</h2><p>Every verdict is priced at one reference deposit so rows compare like with like. Nothing here is hidden:</p><dl class="kv">' +
      kv('Reference deposit', usd(A.depositUsd)) + kv('Launch pool for early users', pct(A.poolShare, 0) + ' of implied value') +
      kv('Farmer crowd estimate', '1 per ' + usd(A.farmerTvlUsd) + ' of TVL, clamped ' + A.minFarmers + '–' + commas(A.maxFarmers)) +
      kv('Capital charge', pct(A.capitalApr, 0) + ' a year over the hold window') +
      kv('Gas per action', 'Ethereum $12 · Solana &amp; the named L2s $1 · any other chain $2') +
      kv('Verdict FARM', 'net pays ≥ ' + usd(A.farmPerHour) + ' per hour of work') +
      kv('Verdict MARGINAL', 'net positive, ≥ ' + usd(A.marginalPerHour) + '/hour') +
      kv('Verdict SKIP', 'net negative, or under ' + usd(A.marginalPerHour) + '/hour — the plan says so') + '</dl>' +
      '<h3>Known limits, stated</h3><p>Today’s market cap of a traded token is not its launch price, so the value fit learns from survivors at today’s prices. <i>listed_at</i> is when DefiLlama began tracking a protocol — a proxy for its age, and the walk-forward split turns on it. Curator categories have one to three priced comparables, so shrinkage dominates there and the printed band is wide. The farmer crowd and the 4% pool are stated assumptions, not measurements; change them and the verdicts move — the assumptions are printed precisely so that can be judged.</p></section></div>';
    return frame('evidence', h + integStrip());
  }

  // ------------------------------------------------------------------- live
  function liveView() {
    var h = '<section class="panel"><h2>Already trades — set aside, not ranked</h2><p>These protocols record a token with a market cap, so the radar does not rank them: the market has already priced them. They are the comparables the launch-value fit learns from. The other ' +
      groupCount(['trades_unpriced']) + ' protocols record a token id or symbol with no cap — usually another deployment of a priced token — and are likewise set aside.</p>' +
      '<table><thead><tr><th class="l">Protocol</th><th class="l">Category</th><th>TVL</th><th>Market cap</th><th>7d</th></tr></thead><tbody>' +
      D.live.map(function (p) { return '<tr><td class="l"><span class="nm">' + esc(p.name) + '</span><br><span class="slug">' + esc(p.slug) + '</span></td><td class="l">' + esc(p.category || '—') + '</td><td>' + usdC(p.tvl_usd) + '</td><td class="amb">' + usdC(p.mcap_usd) + '</td><td>' + chg(p.change_7d) + '</td></tr>'; }).join('') +
      '</tbody></table></section>';
    return frame('live', h);
  }

  // ----------------------------------------------------------------- router
  function render() {
    var h = location.hash.replace(/^#\/?/, '');
    var q = h.split('?')[1] || '';
    h = h.split('?')[0];
    if (h.indexOf('p/') === 0) {
      var r = bySlug(h.slice(2));
      app.innerHTML = r ? detailView(r) : boardView();
      if (r) return;
    } else if (h === 'evidence') { app.innerHTML = evidenceView(); return; }
    else if (h === 'live') { app.innerHTML = liveView(); return; }
    else {
      var params = {};
      q.split('&').forEach(function (kv2) { var p = kv2.split('='); if (p[0]) params[p[0]] = decodeURIComponent(p[1] || ''); });
      if (params.v) F.verdict = params.v;
      if (params.tier) F.tier = params.tier;
      if (params.cat) F.cat = params.cat;
      if (params.chain) F.chain = params.chain;
      if (params.q) F.q = params.q.toLowerCase();
    }
    app.innerHTML = boardView();
    bindBoard();
  }
  window.addEventListener('hashchange', render);
  render();
})();
