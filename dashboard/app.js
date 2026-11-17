// Token Launch Radar — the dashboard page.
//
// Reads window.RADAR (data.js, written beside dashboard/ by main.ts from the same
// board board.json carries) and renders: the ranked board, a Live view that sets
// token-bearing protocols aside with their real market caps, filters (search,
// category, chain, watchlist-only), sortable columns, and a per-protocol detail
// drawer with the full valuation breakdown and the farm plan. No network: every
// byte shown was computed by main.ts from the sealed snapshot.
//
// The valuation model lives in lib/model.ts; this page carries the same arithmetic
// in impliedOf() and recomputes every row it opens, so a reader can check that the
// code and the board agree. No protocol name is special-cased anywhere: change the
// snapshot and every rank, multiple and plan on this page changes with it.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', wl: false, tab: 'pre', sort: 'implied', dir: -1, selected: null };

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) { return 'x' + Number(n).toFixed(3); }

  // The comparable multiple a row's category carries: its own live set's shrunk
  // median, or the global median when the category has no live comparable.
  function categoryMultiple(row) {
    if (row.comps_n > 0) return row.category_multiple;
    var m = DATA.model;
    return Math.min(m.mult_max, Math.max(m.mult_min, DATA.global.median));
  }
  // The model, recomputed in the page from the snapshot figures alone.
  function impliedOf(row) {
    var m = DATA.model;
    var g = row.change_7d === null || row.change_7d === undefined ? 0 : Math.min(m.growth_cap, Math.max(m.growth_floor, row.change_7d));
    var growthMult = 1 + (g / 100) * m.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? m.unknown_age_days : row.age_days;
    var maturityMult = m.maturity_base + m.maturity_range * (1 - Math.exp(-Math.max(0, age) / m.maturity_tau_days));
    var breadthMult = 1 + m.breadth_per_chain * Math.min(Math.max((row.chains || []).length - 1, 0), m.breadth_max_extra);
    return Math.max(1, Math.round(row.tvl_usd * categoryMultiple(row) * growthMult * maturityMult * breadthMult));
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('wl') === '1') state.wl = true;
    if (params.get('tab') === 'live') state.tab = 'live';
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.wl) params.set('wl', '1');
    if (state.tab === 'live') params.set('tab', 'live');
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.wl && !r.on_watchlist) return false;
      if (state.category !== 'all' && (r.category || 'Uncategorised') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category || '', (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'mult') { av = a.category_multiple; bv = b.category_multiple; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.rank - b.rank;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Token Launch Radar' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: 'model ' + DATA.model_version })
      )
    );
  }

  function lede() {
    var total = DATA.rows.reduce(function (s, r) { return s + r.implied_value_usd; }, 0);
    var median = DATA.rows.length ? DATA.rows[Math.floor(DATA.rows.length / 2)].implied_value_usd : 0;
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.counts.ranked + ' pre-token protocols, ranked by what a launch would be worth' }),
        el('p', null,
          'Every protocol that records no token was tested against the wrapper and exchange filters, then priced off the market caps of comparable protocols that already trade. ',
          el('b', { text: 'The watchlist is the floor, not the ceiling: ' }),
          'all ' + DATA.counts.watchlist + ' watchlist protocols are ranked here, alongside ' + (DATA.counts.ranked - DATA.counts.watchlist) + ' earlier finds below the $' + Math.round(DATA.floor_usd / 1e6) + 'M floor. Implied value is this board\u2019s model claim, never a prediction that a token will launch.'
        )
      ),
      el('div', { class: 'stats' },
        el('div', { class: 'stat' }, el('span', { text: 'Ranked candidates' }), el('b', { text: String(DATA.counts.ranked) }), el('em', { text: 'of ' + DATA.counts.protocols + ' protocols scanned' })),
        el('div', { class: 'stat' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.counts.watchlist + ' / ' + DATA.counts.watchlist }), el('em', { text: 'every slug, ranked' })),
        el('div', { class: 'stat' }, el('span', { text: 'Total implied value' }), el('b', { text: fmtUsd(total) }), el('em', { text: 'median row ' + fmtUsd(median) })),
        el('div', { class: 'stat' }, el('span', { text: 'Filtered out' }), el('b', { text: String(DATA.counts.filtered_out) }), el('em', { text: 'wrappers, exchanges, versions' }))
      )
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Uncategorised'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var catSel = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    catSel.addEventListener('change', function () { state.category = catSel.value; writeHash(); render(); });
    var chainSel = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); })
    );
    chainSel.addEventListener('change', function () { state.chain = chainSel.value; writeHash(); render(); });
    var wlBox = el('input', { type: 'checkbox', id: 'wl', 'aria-label': 'Watchlist only' });
    if (state.wl) wlBox.setAttribute('checked', '');
    wlBox.addEventListener('change', function () { state.wl = wlBox.checked; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre' ? 'true' : 'false', text: 'Pre-token board', onclick: function () { state.tab = 'pre'; writeHash(); render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live tokens', onclick: function () { state.tab = 'live'; writeHash(); render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), catSel),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSel),
      el('div', { class: 'field' }, el('span', { class: 'lab', text: 'Watchlist' }), el('label', { class: 'check' }, wlBox, 'Watchlist only')),
      el('div', { class: 'field' }, el('span', { class: 'lab', text: 'View' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: state.tab === 'pre' ? rows().length + ' of ' + DATA.counts.ranked + ' rows' : DATA.live.length + ' live shown' })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = key === 'name' ? 1 : -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' \u25bc' : ' \u25b2' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or widen the filters to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.wl = false; writeHash(); render(); } })
      ));
    }
    var max = 0;
    list.forEach(function (r) { if (r.implied_value_usd > max) max = r.implied_value_usd; });
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Uncategorised') + ' \u00b7 ' + (r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') : 'chain n/a') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: fmtMult(r.category_multiple) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / (max || 1)) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', { class: 'num range', text: fmtUsd(r.value_low_usd) + ' \u2013 ' + fmtUsd(r.value_high_usd) }),
        el('td', null, r.on_watchlist ? el('span', { class: 'badge', text: 'watchlist' }) : el('span', { class: 'badge grey', text: 'early' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { text: 'Pre-token protocols ranked by implied value. The range is the category\u2019s 25th\u201375th percentile band. Select any row for its valuation breakdown and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', '#'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('mult', 'Cat \u00d7'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Range' }),
            el('th', { scope: 'col', text: 'List' })
          )),
          tbody
        )
      )
    );
  }

  // A live ratio outside the model's trim band is shown as the outlier it is:
  // it stays a fact in this view but never enters the comparable sets.
  function liveRatio(r) {
    if (!r.mcap_usd || !r.tvl_usd) return 'n/a';
    var ratio = r.mcap_usd / r.tvl_usd;
    if (ratio > DATA.model.ratio_max) return 'x' + DATA.model.ratio_max + '+ outlier';
    if (ratio < DATA.model.ratio_min) return 'near 0 outlier';
    return fmtMult(ratio);
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Uncategorised') + ' \u00b7 ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'chain n/a') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: liveRatio(r) }),
        el('td', null, el('span', { class: 'badge grey', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { text: 'Set aside, not ranked: these protocols already have a token, so their market cap is a market fact, not a model output. Their market-cap/TVL ratios are exactly the comparables the pre-token model prices from (top ' + DATA.live.length + ' by market cap shown of ' + DATA.counts.live + ').' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Mcap/TVL' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function modelPanel() {
    var m = DATA.model;
    var topCats = DATA.categories.slice(0, 14);
    var catRows = el('tbody');
    topCats.forEach(function (c) {
      catRows.appendChild(el('tr', null,
        el('td', { text: c.category }),
        el('td', { class: 'num', text: String(c.live_n) }),
        el('td', { class: 'num', text: fmtMult(c.median) }),
        el('td', { class: 'num', text: fmtMult(c.applied) })
      ));
    });
    var reasons = DATA.filter_reasons || {};
    var reasonText = Object.keys(reasons).map(function (k) {
      var label = { 'wrapper-category': 'bridge / staking / exchange categories', 'versioned-name': 'versioned names', 'wrapper-name': 'wrapped or staked name words', 'exchange-name': 'exchange name prefixes' }[k] || k;
      return reasons[k] + ' by ' + label;
    }).join('; ');
    return el('section', { class: 'panel model', id: 'model' },
      el('h2', { text: 'How implied value is computed \u2014 model ' + DATA.model_version }),
      el('div', { class: 'cols' },
        el('div', null,
          el('div', { class: 'formula', text: 'implied = TVL \u00d7 categoryMultiple \u00d7 (1 + clamp(7d change, ' + m.growth_floor + ', +' + m.growth_cap + ')/100 \u00d7 ' + m.growth_weight + ') \u00d7 (' + m.maturity_base + ' + ' + m.maturity_range + ' \u00d7 (1 \u2212 e^\u2212age/' + m.maturity_tau_days + ')) \u00d7 (1 + ' + m.breadth_per_chain + ' \u00d7 min(chains\u22121, ' + m.breadth_max_extra + '))' }),
          el('ul', null,
            el('li', null, el('b', { text: 'Category multiple: ' }), 'the median market-cap/TVL of the live-token protocols in the same category in this snapshot (' + DATA.global.live_n + ' usable ratios; global median ' + fmtMult(DATA.global.median) + '), shrunk toward the global median so a category with one or two comparables cannot price itself, and clamped to ' + fmtMult(m.mult_min) + '\u2013' + fmtMult(m.mult_max) + '. The 25th\u201375th percentile band becomes each row\u2019s range.'),
            el('li', null, el('b', { text: 'Growth: ' }), 'seven-day TVL momentum, damped at half weight and clamped, so one hot week moves a value by at most +30%.'),
            el('li', null, el('b', { text: 'Maturity: ' }), 'how long the protocol has run while recording no token; unknown listing dates use ' + m.unknown_age_days + ' days. Longer survival earns up to +10%, never more.'),
            el('li', null, el('b', { text: 'Breadth: ' }), '+1.5% per extra chain, capped at +12%: a multi-chain footprint is real distribution, not a promise.')
          )
        ),
        el('div', null,
          el('h3', { text: 'Category comparables (live-token sets)' }),
          el('table', { class: 'mini' },
            el('thead', null, el('tr', null, el('th', { text: 'Category' }), el('th', { text: 'Live n' }), el('th', { text: 'Median' }), el('th', { text: 'Applied' }))),
            catRows
          ),
          el('p', { class: 'note', text: 'Filtered out before ranking: ' + DATA.counts.filtered_out + ' protocols that record no token but are wrappers, exchange books or versions of a parent (' + reasonText + '). "Records no token" is DefiLlama\u2019s record, not proof a token does not exist.' })
        )
      )
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function splitStep(s) {
    var ci = s.indexOf(' Cost: ');
    var ti = s.lastIndexOf(' Time: ');
    if (ci < 0 || ti < ci) return { action: s, tail: '' };
    var action = s.slice(0, ci);
    if (!/\.$/.test(action)) action += '.';
    return { action: action, tail: s.slice(ci + 1, ti) + ' \u00b7 ' + s.slice(ti + 1) };
  }

  function openDetail(slug) {
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === slug) row = r; });
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var recomputed = impliedOf(row);
    var agrees = Math.abs(recomputed - row.implied_value_usd) <= Math.max(2, row.implied_value_usd * 0.001);
    var compNote = row.comps_n > 0
      ? 'priced from ' + row.comps_n + ' live comparable' + (row.comps_n === 1 ? '' : 's') + ' in ' + (row.category || 'Uncategorised')
      : 'no live comparable in its category: the global median prices this row';
    var rangeSpan = Math.max(1, row.value_high_usd - row.value_low_usd);
    var dotAt = Math.min(98, Math.max(0, ((row.implied_value_usd - row.value_low_usd) / rangeSpan) * 100));
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'sub', text: 'Rank ' + row.rank + ' of ' + DATA.counts.ranked + (row.on_watchlist ? ' \u00b7 watchlist' : ' \u00b7 early find below the floor') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Uncategorised') + ' \u00b7 ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'chain n/a') + ' \u00b7 records no token' })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Valuation breakdown' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL (snapshot)' }), el('b', { text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Category multiple (' + compNote + ')' }), el('b', { text: fmtMult(categoryMultiple(row)) })),
        el('div', null, el('span', { text: 'Growth \u00d7 (7d ' + fmtPct(row.change_7d) + ')' }), el('b', { text: fmtMult(row.growth_multiplier) })),
        el('div', null, el('span', { text: 'Maturity \u00d7 (age ' + fmtAge(row.age_days) + ' with no token)' }), el('b', { text: fmtMult(row.maturity_multiplier) })),
        el('div', null, el('span', { text: 'Breadth \u00d7 (' + (row.chains ? row.chains.length : 0) + ' chains)' }), el('b', { text: fmtMult(row.breadth_multiplier) })),
        el('div', { class: 'total' }, el('span', { text: 'Implied value' }), el('b', { text: fmtUsd(row.implied_value_usd) }))
      ),
      el('div', { class: 'rangebar', 'aria-hidden': 'true' },
        el('i', { style: 'left:0;width:100%' }),
        el('b', { style: 'left:' + dotAt + '%' })
      ),
      el('p', { class: 'note', text: 'Range ' + fmtUsd(row.value_low_usd) + ' \u2013 ' + fmtUsd(row.value_high_usd) + ': the same arithmetic at the category\u2019s 25th and 75th percentile multiples. ' + (row.comps_n <= 2 ? 'Few comparables price this category, so the band is honestly wide. ' : '') + 'This page recomputes the row from the snapshot figures as ' + fmtUsd(recomputed) + (agrees ? ', which matches the board.' : ', which differs from the board beyond rounding: treat the data as stale.') + ' An implied value is a model claim about a launch that may never happen, not a price.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan \u2014 ' + row.farm_steps.length + ' steps' }),
      el('ol', { class: 'steps' }, row.farm_steps.map(function (s) {
        var parts = splitStep(s);
        return el('li', null, el('b', { text: parts.action }), parts.tail ? el('span', { class: 'cost', text: parts.tail }) : null);
      })),
      el('p', { class: 'note', text: 'Steps are generated from this protocol\u2019s category, chains, TVL and age \u2014 the same text board.json carries. Costs are estimates in USD; capital stays yours and at smart-contract risk throughout.' })
    ));
    if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
    else dialog.setAttribute('open', '');
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre' ? boardTable() : liveTable());
    if (state.tab === 'pre') shell.appendChild(modelPanel());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
