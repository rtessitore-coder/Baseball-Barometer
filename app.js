'use strict';
/*
  Baseball Barometer. One script for all six pages; the page to run comes from <main data-page="...">.
  Anything a user types is added with textContent (via el()), never innerHTML, so posts can't inject code.
*/
const S = Store.get();

/* ---------- Small helpers ---------- */
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (tag === 'th') n.setAttribute('scope', 'col'); // every header here heads a column
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return n;
}
const money = m => (m < 0 ? '-' : '') + '$' + Math.abs(Math.round(m * 10) / 10).toFixed(1) + 'M';
const r1 = x => Math.round(x * 10) / 10;
// Dollar amounts in tables and counters: the "M" is smaller and lighter, so the number leads.
const fm = m => el('span', {}, (m < 0 ? '-' : '') + '$' + Math.abs(Math.round(m * 10) / 10).toFixed(1), el('span', { class: 'unit' }, 'M'));
// Colored data cells: teal for better than the midpoint, crimson for worse; the further away, the stronger the color.
function heat(text, v, mid, span) {
  const t = Math.max(-1, Math.min(1, (v - mid) / span));
  return el('span', { class: 'heat', style: `background: rgba(${t >= 0 ? '25,105,122' : '163,22,45'}, ${(Math.abs(t) * 0.5).toFixed(2)})` }, text);
}
const teamById = id => DATA.teams.find(t => t.id === id);
const teamName = id => { const t = teamById(id); return t.city + ' ' + t.name; };
const season = () => DATA.seasons[S.year];
const fmtDate = iso => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

function rosterOf(tid, lvls) {
  return DATA.players.filter(p => S.team[p.id] === tid && (!lvls || lvls.includes(S.lvl[p.id])));
}
function payroll(tid, yi) {
  return rosterOf(tid, ['MLB', '40']).reduce((sum, p) => sum + (p.salary[yi] || 0), 0);
}
function keyStat(p) {
  return p.kind === 'H' ? `${p.s.wrc} wRC+ · ${p.s.obp.toFixed(3)} OBP` : `${p.s.era.toFixed(2)} ERA · ${p.s.kpct.toFixed(1)} K%`;
}
function contractText(p, yi) {
  const now = p.salary[yi];
  if (!now) return p.lvl === 'FARM' && S.lvl[p.id] === 'FARM' ? 'Minor-league deal' : 'Expired';
  const left = p.salary.slice(yi).filter(x => x > 0).length;
  return [fm(now), ` · ${left} yr`];
}
function logMove(text) {
  S.moves.unshift({ t: new Date().toISOString(), team: S.teamId, text });
  S.moves = S.moves.slice(0, 60);
}

/* ---------- Projection model (Front Office page, shown on GM Mode too) ---------- */
const Model = {
  // OBP, SLG and wRC+ overlap (all measure offense), so each default is small; together they land near the demo WAR.
  defaults: { iH: 1.5, obp: 0.15, slg: 0.1, wrc: 0.6, ageH: -0.15, iP: 0, era: 0.05, k: 0.05, whip: 0.02, ageP: -0.1 },
  // Hitters: intercept + weight x (distance from a baseline). Baselines are round numbers, chosen so the weights are readable.
  score(p, w) {
    if (p.kind === 'H') {
      return r1(w.iH + w.obp * (p.s.obp - 0.320) * 100 + w.slg * (p.s.slg - 0.400) * 100
        + w.wrc * (p.s.wrc - 100) / 10 + w.ageH * Math.max(0, p.age - 30));
    }
    const raw = w.iP + w.era * (4.5 - p.s.era) / 0.1 + w.k * (p.s.kpct - 20)
      + w.whip * (1.30 - p.s.whip) / 0.01 + w.ageP * Math.max(0, p.age - 30);
    return r1(p.pos === 'SP' ? raw : raw * 0.35); // relievers throw about a third of a starter's innings
  },
};
/* ---------- Contract value model (the structure of the sample "MLB Contract Model" sheet) ----------
   baseline WAR = weighted average of career / last season / season before, using the user's weights
   WAR in contract year k = baseline minus the user's yearly decline for each year of age so far (never below 0)
   value = total contract WAR x dollars per WAR; surplus = value minus contract dollars */
const Contract = {
  defaults: { w: { career: 0.4, last: 0.4, prior: 0.2 }, dec: { young: 0.3, mid: 0.5, old: 0.8 }, price: 8, use: false, rows: [] },
  decline(age, d) { return age <= 30 ? d.young : age <= 33 ? d.mid : d.old; },
  baseline(r, w) {
    const sum = w.career + w.last + w.prior;
    return sum ? (w.career * r.career + w.last * r.last + w.prior * r.prior) / sum : 0;
  },
  yearly(base, age, years, d) {
    const out = []; let cur = base;
    for (let k = 0; k < years; k++) { cur = Math.max(0, cur - Contract.decline(age + k, d)); out.push(cur); }
    return out;
  },
  evaluate(r, m) {
    const base = Contract.baseline(r, m.w);
    const war = Contract.yearly(base, r.age, r.years, m.dec);
    const total = war.reduce((a, b) => a + b, 0), value = total * m.price, surplus = value - r.value;
    return { base, war, total, value, surplus, verdict: surplus < 0 ? 'OVERPAY' : 'UNDERPAY' };
  },
};
// Surplus for a demo-league player: the player's demo WAR is the baseline, salaries are the remaining contract.
function surplusFor(p, salaries, startAge) {
  const C = S.contract;
  if (!C || !C.use) return null;
  const sal = salaries.filter(x => x > 0);
  if (!sal.length) return null;
  const total = Contract.yearly(p.war, startAge, sal.length, C.dec).reduce((a, b) => a + b, 0);
  return r1(total * C.price - sal.reduce((a, b) => a + b, 0));
}
function contractLine(m) {
  return `baseline = weighted average of career / last season / season before (weights ${m.w.career} / ${m.w.last} / ${m.w.prior}); `
    + `WAR lost each year: ${m.dec.young} (age 30 and under), ${m.dec.mid} (31-33), ${m.dec.old} (34+); ${money(m.price)} per WAR.`;
}
function myProj(p) {
  if (S.csv[p.name] != null) return S.csv[p.name];
  return S.model ? Model.score(p, S.model.w) : null;
}

/* ---------- Player lists (GM Mode and Front Office) ----------
   Every player is a "strip": a position badge, the name with a short meta line, a row of labelled stat blocks,
   then action buttons. Groups get a small heading with a count, the way a team roster page sections its players. */
const statPairs = p => (p.kind === 'H'
  ? [['wRC+', String(p.s.wrc)], ['OBP', p.s.obp.toFixed(3)]]
  : [['ERA', p.s.era.toFixed(2)], ['K%', p.s.kpct.toFixed(1)]]);

function playerList(entries, opts = {}) {
  if (!entries.length) return el('p', { class: 'muted' }, opts.empty != null ? opts.empty : 'Nobody here.');
  const groupOf = e => (opts.group ? opts.group(e) : null);
  const list = entries.slice();
  if (opts.group && opts.order) list.sort((a, b) => opts.order.indexOf(groupOf(a)) - opts.order.indexOf(groupOf(b))); // stable
  const counts = {};
  if (opts.group) list.forEach(e => { counts[groupOf(e)] = (counts[groupOf(e)] || 0) + 1; });
  const box = el('div', { class: 'roster' });
  let last = null;
  list.forEach(e => {
    const g = groupOf(e);
    if (opts.group && g !== last) { box.append(el('h3', { class: 'roster-group' }, g, el('span', { class: 'count' }, ` · ${counts[g]}`))); last = g; }
    const name = e.name || e.p.name, pos = e.pos || e.p.pos;
    const kind = e.kind || (e.p ? e.p.kind : null);
    const strip = el('div', { class: 'strip' + (e.onClick ? ' pickable' : '') + (e.selected ? ' picked' : ''), draggable: e.drag ? 'true' : null },
      e.lead != null ? el('span', { class: 'lead' }, e.lead) : null,
      el('span', { class: 'badge ' + (kind === 'H' ? 'hit' : kind === 'P' ? 'pit' : 'neutral') }, pos),
      el('div', { class: 's-who' }, el('div', { class: 's-name' }, name), el('div', { class: 's-meta' }, e.meta)),
      e.stats && e.stats.length ? el('dl', { class: 'stats' }, e.stats.map(([label, val]) => el('div', {}, el('dt', {}, label), el('dd', {}, val)))) : null,
      e.actions && e.actions.length ? el('div', { class: 'strip-actions' }, e.actions) : null);
    if (e.drag) strip.addEventListener('dragstart', ev => ev.dataTransfer.setData('text/plain', e.p.id));
    if (e.onClick) strip.addEventListener('click', ev => { if (!ev.target.closest('input, button, select')) e.onClick(); });
    box.append(strip);
  });
  return box;
}

/* ---------- Page shell: header, demo strip, footer ---------- */
const NAV = [['index.html', 'home', 'Home'], ['gm.html', 'gm', 'GM Mode'], ['front-office.html', 'fo', 'Front Office'],
  ['forum.html', 'forum', 'Forum'], ['stats.html', 'stats', 'Stats'], ['profile.html', 'profile', 'My Profile']];

function shell(page) {
  const head = document.getElementById('site-header');
  // On phones the menu folds behind one button so the page content starts near the top of the screen.
  const nav = el('nav', { class: 'nav', id: 'nav', 'aria-label': 'Main' },
    NAV.map(([href, id, label]) => el('a', Object.assign({ href }, id === page ? { 'aria-current': 'page' } : {}), label)));
  const toggle = el('button', { class: 'menu-btn', 'aria-expanded': 'false', 'aria-controls': 'nav',
    onclick: () => { const open = nav.classList.toggle('open'); toggle.setAttribute('aria-expanded', String(open)); } }, 'Menu');
  head.replaceChildren(
    el('div', { class: 'demo-strip' }, el('div', { class: 'wrap' }, 'Demo league: all teams, players and stats are fictional.')),
    el('div', { class: 'site-head' }, el('div', { class: 'wrap' },
      el('a', { class: 'brand', href: 'index.html' }, 'Baseball ', el('span', {}, 'Barometer')), toggle, nav)));
  document.getElementById('site-foot').replaceChildren(el('div', { class: 'wrap' },
    el('p', {}, 'Free to use, with no paywall. Your teams, posts and model are saved only in this browser.'),
    el('p', {}, el('a', { href: 'README.md' }, 'How real data would plug in')),
    el('p', {}, 'Not affiliated with Major League Baseball, Baseball Reference or Baseball Savant. Demo data is fictional.')));
}

function tabs(list, current, onPick) {
  return el('div', { class: 'tabs', role: 'tablist' }, list.map(([id, label]) =>
    el('button', { class: 'tab', role: 'tab', 'aria-selected': String(id === current), onclick: () => onPick(id) }, label)));
}

/* ---------- Forum helpers (used by Forum, Home, Front Office, GM Mode) ---------- */
function snapshot() {
  const c = S.card[S.teamId];
  return {
    team: teamName(S.teamId), season: season(), payroll: r1(payroll(S.teamId, S.year)), taxLine: S.taxLine,
    lineup: c.lineup.filter(Boolean).map(id => DATA.byId[id].name),
    rotation: c.rotation.filter(Boolean).map(id => DATA.byId[id].name),
  };
}
function addPost(type, title, body, attach) {
  S.posts.unshift({ id: 'u' + (S.nextId++), demo: false, type, author: S.user.name, date: new Date().toISOString(), title, body, attach: attach || null, replies: [] });
  Store.save();
}
const TYPE_LABEL = { roster: 'Roster', fa: 'Free agency', model: 'Model' };

function postCard(post, onChange) {
  const voted = !!S.votes[post.id];
  const votes = (post.votes || 0) + (voted ? 1 : 0);
  const a = post.attach;
  return el('article', { class: 'post' },
    el('div', { class: 'meta' },
      el('span', { class: 'tag' }, TYPE_LABEL[post.type] || post.type),
      post.demo ? el('span', { class: 'tag demo' }, 'Demo') : null,
      el('span', {}, post.author), el('span', {}, fmtDate(post.date))),
    el('h3', {}, post.title),
    el('div', { class: 'post-body' }, post.body),
    a && a.snap ? el('div', { class: 'attach' },
      el('strong', {}, `${a.snap.team}, ${a.snap.season}`),
      ` · payroll ${money(a.snap.payroll)} of ${money(a.snap.taxLine)} demo tax line`,
      el('div', {}, 'Lineup: ' + (a.snap.lineup.join(', ') || 'empty')),
      el('div', {}, 'Rotation: ' + (a.snap.rotation.join(', ') || 'empty'))) : null,
    a && a.model ? el('div', { class: 'attach' }, el('strong', {}, 'Model weights: '), modelLine(a.model)) : null,
    a && a.contract ? el('div', { class: 'attach' }, el('strong', {}, 'Contract model: '), contractLine(a.contract.params),
      a.contract.results.map(line => el('div', {}, line))) : null,
    el('div', { class: 'row' },
      el('button', { class: 'btn alt small', 'aria-pressed': String(voted), onclick: () => { voted ? delete S.votes[post.id] : (S.votes[post.id] = true); Store.save(); onChange(); } },
        voted ? `Upvoted (${votes})` : `Upvote (${votes})`),
      post.demo ? null : el('button', { class: 'btn alt small', onclick: () => {
        if (!confirm('Delete this post? It cannot be undone.')) return;
        S.posts = S.posts.filter(x => x.id !== post.id); Store.save(); onChange();
      } }, 'Delete post')),
    el('details', {},
      el('summary', {}, `Replies (${post.replies.length})`),
      post.replies.map(rp => el('div', { class: 'reply' }, el('div', { class: 'small muted' }, rp.author + ' · ' + fmtDate(rp.date)), el('div', {}, rp.text))),
      replyForm(post, onChange)));
}
function replyForm(post, onChange) {
  const box = el('input', { type: 'text', 'aria-label': 'Write a reply', placeholder: 'Write a reply' });
  return el('form', { class: 'row', onsubmit: e => {
    e.preventDefault();
    const text = box.value.trim();
    if (!text) return;
    post.replies.push({ author: S.user.name, date: new Date().toISOString(), text });
    Store.save(); onChange();
  } }, el('div', { class: 'field' }, box), el('button', { class: 'btn small', type: 'submit' }, 'Post reply'));
}
function modelLine(m) {
  const w = m.w;
  return `hitters: ${w.obp} WAR per +10 OBP pts, ${w.slg} per +10 SLG pts, ${w.wrc} per +10 wRC+, ${w.ageH} per year over 30. `
    + `pitchers: ${w.era} per 0.10 ERA under 4.50, ${w.k} per K% over 20, ${w.whip} per .01 WHIP under 1.30, ${w.ageP} per year over 30.`;
}

/* =====================================================================
   HOME
   ===================================================================== */
// All six teams' payroll against the tax line for the selected season. Trades and signings in GM Mode change it.
function leagueBoard() {
  const cap = S.taxLine * 1.25;
  const rows = DATA.teams.map(t => ({ t, pay: payroll(t.id, S.year) })).sort((a, b) => b.pay - a.pay);
  return el('section', { class: 'panel' },
    el('h2', {}, `League payrolls, ${season()}`),
    el('p', { class: 'small muted' }, `The dark line is the ${money(S.taxLine)} demo tax line. Red means over it.`),
    el('div', { class: 'board' }, rows.map(({ t, pay }) => {
      const over = pay > S.taxLine;
      return el('div', { class: 'board-row' },
        el('strong', {}, teamName(t.id) + (t.id === S.teamId ? ' (yours)' : '')),
        el('div', { class: 'bar', role: 'img', 'aria-label': `${teamName(t.id)} payroll ${money(pay)}` },
          el('div', { class: 'bar-fill' + (over ? ' over' : ''), style: `width:${Math.min(100, pay / cap * 100)}%` }),
          el('div', { class: 'bar-line', style: `left:${S.taxLine / cap * 100}%` })),
        el('span', { style: over ? 'color:var(--signal);font-weight:600' : '' }, fm(pay), over ? [' (', fm(pay - S.taxLine), ' over)'] : null),
        t.id === S.teamId ? el('a', { class: 'btn small', href: 'gm.html' }, 'Open my card')
          : el('button', { class: 'btn alt small', 'aria-label': 'Manage ' + teamName(t.id), onclick: () => { S.teamId = t.id; Store.save(); location.href = 'gm.html'; } }, 'Manage team'));
    })));
}

// The site's central object, shown on the first screen: your team's real card from GM Mode, not a picture of one.
function miniCard() {
  const c = S.card[S.teamId];
  return el('aside', { class: 'lineup-card mini', 'aria-label': 'Your lineup card' },
    el('h2', {}, teamName(S.teamId)),
    el('p', { class: 'small muted' }, `${season()} batting order`),
    el('ol', { class: 'mini-list' }, c.lineup.map(id => { const p = id && DATA.byId[id];
      return el('li', {}, p ? [el('span', { class: 'pos' }, p.pos), p.name] : el('span', { class: 'muted' }, 'Empty spot')); })),
    el('p', { class: 'small muted' }, 'Starting rotation: ' + (c.rotation.filter(Boolean).map(id => DATA.byId[id].name).join(', ') || 'empty')));
}

function pageHome(main) {
  const snap = snapshot();
  main.replaceChildren(el('div', { class: 'wrap stack' },
    el('div', { class: 'hero-grid' },
      el('section', { class: 'hero' },
        el('h1', {}, 'An Armchair GM\'s Dream'),
        el('p', {}, 'Build the roster, sign the free agents, and write your own projection model. No paywall, no messaging, nothing hidden.'),
        el('a', { class: 'btn', href: 'gm.html' }, 'Open GM Mode')),
      miniCard()),
    leagueBoard(),
    el('div', { class: 'split' },
      el('section', {}, el('h2', {}, 'From the forum'), el('div', { id: 'feed', style: 'margin-top:12px' })),
      el('aside', { class: 'stack' },
        el('div', { class: 'panel' },
          el('h2', {}, 'Your team'),
          el('p', { style: 'margin-top:8px' }, el('strong', {}, snap.team), ` · ${snap.season}`),
          el('p', {}, `Payroll ${money(snap.payroll)} of the ${money(snap.taxLine)} demo tax line.`),
          el('a', { class: 'btn small', href: 'gm.html' }, 'Back to my card')),
        el('div', { class: 'panel' },
          el('h2', {}, 'Your recent moves'),
          S.moves.length
            ? el('ul', { class: 'log', style: 'margin-top:8px' }, S.moves.slice(0, 6).map(m => el('li', {}, m.text)))
            : el('p', { class: 'muted', style: 'margin-top:8px' }, 'No moves yet. Open GM Mode and sign or trade someone.'))))));
  const feed = document.getElementById('feed');
  const draw = () => feed.replaceChildren(...S.posts.slice(0, 4).map(p => postCard(p, draw)));
  draw();
}

/* =====================================================================
   GM MODE
   ===================================================================== */
function pageGM(main) {
  let tab = 'roster';
  let partner = DATA.teams.find(t => t.id !== S.teamId).id;
  let pickMine = new Set(), pickTheirs = new Set();
  let msg = null;
  const say = (text, bad) => { msg = { text, bad }; };

  function counts() {
    const mlb = rosterOf(S.teamId, ['MLB']).length;
    const forty = rosterOf(S.teamId, ['MLB', '40']).length;
    return { mlb, forty };
  }
  function setLevel(p, lvl, note) {
    S.lvl[p.id] = lvl;
    logMove(`${teamName(S.teamId)}: ${p.name} ${note}.`);
    Store.fillCard(S, S.teamId);
    Store.save(); say(`${p.name} ${note}.`); render();
  }
  function promote(p) {
    if (counts().mlb >= 26) return say('The 26-man is full. Option or release someone first.', true), render();
    setLevel(p, 'MLB', 'promoted to the 26-man');
  }
  function addTo40(p) {
    if (counts().forty >= 40) return say('The 40-man is full. Release or trade someone first.', true), render();
    setLevel(p, '40', 'added to the 40-man');
  }
  function release(p) {
    delete S.team[p.id]; S.lvl[p.id] = 'FA';
    p.faYear = Math.min(p.faYear || season(), season());
    logMove(`${teamName(S.teamId)} released ${p.name}.`);
    Store.fillCard(S, S.teamId); Store.save(); say(`${p.name} released. He is back in the free-agent pool.`); render();
  }
  function sign(p, yrs) {
    const c = counts();
    if (c.forty >= 40) return say('The 40-man is full. Make room before signing.', true), render();
    const aav = p.salary.find(x => x > 0);
    p.salary = Array(S.year).fill(0).concat(Array(yrs).fill(aav)); // contract starts this season
    S.team[p.id] = S.teamId;
    S.lvl[p.id] = c.mlb < 26 ? 'MLB' : '40';
    logMove(`${teamName(S.teamId)} signed ${p.name}: ${yrs} yr, ${money(aav)} a year.`);
    Store.fillCard(S, S.teamId); Store.save();
    say(`Signed ${p.name} for ${yrs} year${yrs > 1 ? 's' : ''} at ${money(aav)}. ${S.lvl[p.id] === 'MLB' ? 'On the 26-man.' : '26-man was full, so he is on the 40-man.'}`);
    render();
  }
  const value = p => Math.max(p.war, p.pot != null ? p.pot * 0.6 : p.war);
  function trade() {
    if (!pickMine.size && !pickTheirs.size) return say('Pick at least one player to trade.', true), render();
    const out = [...pickMine].map(id => DATA.byId[id]), inn = [...pickTheirs].map(id => DATA.byId[id]);
    const give = out.reduce((s, p) => s + value(p), 0), get = inn.reduce((s, p) => s + value(p), 0);
    // Demo rule, stated plainly: the other team accepts if it gets at least 5% more value than it gives.
    if (give < get * 1.05) {
      say(`${teamName(partner)} said no. They would get ${r1(give)} of value for ${r1(get)} leaving. Add more value.`, true);
      return render();
    }
    out.forEach(p => { S.team[p.id] = partner; });
    inn.forEach(p => { S.team[p.id] = S.teamId; });
    logMove(`Trade with ${teamName(partner)}: sent ${out.map(p => p.name).join(', ') || 'nobody'}; got ${inn.map(p => p.name).join(', ') || 'nobody'}.`);
    pickMine.clear(); pickTheirs.clear();
    Store.fillCard(S, S.teamId); Store.fillCard(S, partner); Store.save();
    const c = counts();
    say('Trade accepted.' + (c.mlb > 26 || c.forty > 40 ? ' Your roster is now over a limit; fix it before the season.' : ''), c.mlb > 26 || c.forty > 40);
    render();
  }

  /* ----- pieces ----- */
  function payrollBlock() {
    const pay = payroll(S.teamId, S.year), over = pay > S.taxLine, cap = S.taxLine * 1.25;
    const c = counts();
    return el('section', { class: 'payroll' },
      el('h2', {}, `${season()} payroll`),
      el('div', { class: 'bar', role: 'img', 'aria-label': `Payroll ${money(pay)} against a ${money(S.taxLine)} tax line` },
        el('div', { class: 'bar-fill' + (over ? ' over' : ''), style: `width:${Math.min(100, pay / cap * 100)}%` }),
        el('div', { class: 'bar-line', style: `left:${S.taxLine / cap * 100}%` })),
      el('p', {}, el('strong', {}, fm(pay)), ` of the ${money(S.taxLine)} demo tax line. `,
        over ? el('strong', { style: 'color:var(--signal)' }, `${money(pay - S.taxLine)} over.`) : `${money(S.taxLine - pay)} under.`),
      el('div', { class: 'counts' },
        el('span', { class: c.mlb > 26 ? 'bad' : '' }, `26-man: ${c.mlb}`, el('span', { class: 'unit' }, '/26')),
        el('span', { class: c.forty > 40 ? 'bad' : '' }, `40-man: ${c.forty}`, el('span', { class: 'unit' }, '/40'))));
  }

  function card() {
    const c = S.card[S.teamId];
    const mlb = rosterOf(S.teamId, ['MLB']);
    const inRot = new Set(c.rotation);
    const bullpen = mlb.filter(p => p.kind === 'P' && !inRot.has(p.id));
    const inLine = new Set(c.lineup);
    const bench = mlb.filter(p => p.kind === 'H' && !inLine.has(p.id));
    function slotRow(list, i, label, accepts) {
      const id = list[i], p = id && DATA.byId[id];
      const row = el('div', { class: 'slot',
        ondragover: e => { e.preventDefault(); row.classList.add('over'); },
        ondragleave: () => row.classList.remove('over'),
        ondrop: e => {
          e.preventDefault(); row.classList.remove('over');
          const q = DATA.byId[e.dataTransfer.getData('text/plain')];
          if (!q || S.team[q.id] !== S.teamId) return;
          if (S.lvl[q.id] !== 'MLB') { say(`${q.name} is not on the 26-man. Promote him first.`, true); return render(); }
          if (!accepts(q)) { say(`${q.name} doesn't fit that part of the card.`, true); return render(); }
          const at = list.indexOf(q.id); if (at >= 0) list[at] = list[i];
          list[i] = q.id; Store.save(); render();
        } },
        el('span', { class: 'nth' }, label),
        el('span', { class: 'who' + (p ? '' : ' empty') }, p ? [el('span', { class: 'pos' }, p.pos), el('span', { class: 'nm' }, p.name)] : 'Empty. Drop or add a player.'),
        el('span', { class: 'stat' }, p ? keyStat(p).split(' · ')[0] : ''),
        // Move buttons are the touch and keyboard way to reorder; dragging does not work on phones.
        el('button', { class: 'x', 'aria-label': p ? `Move ${p.name} up` : 'Spot is empty', disabled: !p || i === 0, onclick: () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; Store.save(); render(); } }, '▲'),
        el('button', { class: 'x', 'aria-label': p ? `Move ${p.name} down` : 'Spot is empty', disabled: !p || i === list.length - 1, onclick: () => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; Store.save(); render(); } }, '▼'),
        el('button', { class: 'x', 'aria-label': p ? `Remove ${p.name} from this spot` : 'Spot is empty', disabled: !p, onclick: () => { list[i] = null; Store.save(); render(); } }, '×'));
      return row;
    }
    return el('section', { class: 'lineup-card' },
      el('h2', {}, teamName(S.teamId)),
      el('p', { class: 'small muted' }, 'Lineup card. Use "To lineup" in the roster to add a player, the arrows to reorder, or drag on a computer. Positions are not checked in the demo.'),
      el('h3', {}, 'Batting order'),
      ...c.lineup.map((_, i) => slotRow(c.lineup, i, String(i + 1), q => q.kind === 'H')),
      el('h3', {}, 'Rotation'),
      ...c.rotation.map((_, i) => slotRow(c.rotation, i, String(i + 1), q => q.pos === 'SP')),
      el('h3', {}, 'Bullpen'),
      el('p', { class: 'names' }, bullpen.length ? bullpen.map(p => p.name).join(', ') : 'No pitchers outside the rotation.'),
      el('h3', {}, 'Bench'),
      el('p', { class: 'names' }, bench.length ? bench.map(p => p.name).join(', ') : 'No bench bats.'),
      el('div', { class: 'row', style: 'margin-top:16px' },
        el('button', { class: 'btn alt small', onclick: () => { Store.fillCard(S, S.teamId); Store.save(); render(); } }, 'Fill empty spots'),
        el('button', { class: 'btn alt small', onclick: () => { S.card[S.teamId] = { lineup: Array(9).fill(null), rotation: Array(5).fill(null) }; Store.save(); render(); } }, 'Clear card')));
  }

  // Stat blocks shared by the lists. "My WAR" only appears once there is a model or import to show,
  // and the surplus block only when the contract model is switched on for GM Mode (Front Office page).
  const hasMine = !!S.model || Object.keys(S.csv).length > 0;
  const useSurplus = !!(S.contract && S.contract.use);
  const warBlock = p => ['Demo WAR', heat(p.war.toFixed(1), p.war, 1.5, 3.5)];
  const myBlock = p => { const v = myProj(p); return ['My WAR', v == null ? '–' : heat(Number(v).toFixed(1), Number(v), 1.5, 3.5)]; };
  const surplusBlock = (label, v) => [label, v == null ? '–' : heat((v >= 0 ? '+' : '') + v.toFixed(1), v, 0, 40)];
  const contractMeta = p => { const t = contractText(p, S.year); return Array.isArray(t) ? t : [t]; };
  const POS_GROUPS = ['Starting pitchers', 'Relief pitchers', 'Catchers', 'Infielders', 'Outfielders', 'Designated hitters and utility'];
  const posGroup = e => { const p = e.p; return p.pos === 'SP' ? POS_GROUPS[0] : p.kind === 'P' ? POS_GROUPS[1] : p.pos === 'C' ? POS_GROUPS[2]
    : ['1B', '2B', '3B', 'SS', 'IF'].includes(p.pos) ? POS_GROUPS[3] : ['LF', 'CF', 'RF', 'OF'].includes(p.pos) ? POS_GROUPS[4] : POS_GROUPS[5]; };

  function rosterTab() {
    const mine = rosterOf(S.teamId, ['MLB', '40']);
    const c = S.card[S.teamId];
    const entries = mine.map(p => {
      const lvl = S.lvl[p.id], btns = [];
      if (lvl === 'MLB') {
        if (p.kind === 'H') btns.push(el('button', { class: 'btn alt small', onclick: () => { if (c.lineup.includes(p.id)) return; const i = c.lineup.indexOf(null); if (i < 0) say('The batting order is full. Remove someone first.', true); else c.lineup[i] = p.id; Store.save(); render(); } }, 'To lineup'));
        else if (p.pos === 'SP') btns.push(el('button', { class: 'btn alt small', onclick: () => { if (c.rotation.includes(p.id)) return; const i = c.rotation.indexOf(null); if (i < 0) say('The rotation is full. Remove someone first.', true); else c.rotation[i] = p.id; Store.save(); render(); } }, 'To rotation'));
        btns.push(el('button', { class: 'btn alt small', onclick: () => setLevel(p, '40', 'optioned off the 26-man') }, 'Option'));
      } else {
        btns.push(el('button', { class: 'btn small', onclick: () => promote(p) }, 'Promote'));
        btns.push(el('button', { class: 'btn alt small', onclick: () => setLevel(p, 'FARM', 'sent to the minors') }, 'Send down'));
      }
      btns.push(el('button', { class: 'btn alt small', onclick: () => release(p) }, 'Release'));
      return { p, drag: true, meta: [`Age ${p.age} · `, ...contractMeta(p)],
        stats: [...statPairs(p), warBlock(p), ...(hasMine ? [myBlock(p)] : []),
          ...(useSurplus ? [surplusBlock('Surplus ($M)', surplusFor(p, p.salary.slice(S.year), p.age + S.year))] : [])],
        actions: btns };
    });
    return el('div', {}, el('p', { class: 'small muted' }, 'Everyone on the 40-man. Contracts that end before the selected season drop off payroll.'
      + (useSurplus ? ' Contract surplus applies your contract model to each remaining contract, using the demo WAR as the baseline.' : '')),
      playerList(entries, { group: posGroup, order: POS_GROUPS }));
  }
  function farmTab() {
    const entries = rosterOf(S.teamId, ['FARM']).map(p => ({ p, drag: true, meta: [`Age ${p.age}`],
      stats: [...statPairs(p), ['Ceiling WAR', p.pot.toFixed(1)]],
      actions: [el('button', { class: 'btn small', onclick: () => addTo40(p) }, 'Add to 40-man')] }));
    return el('div', {}, el('p', { class: 'small muted' }, 'Farm system. Prospects cost nothing against payroll until you add them to the 40-man. "Ceiling" is a fictional demo number.'),
      playerList(entries, { group: e => e.p.farm, order: DATA.farmLevels }));
  }
  function faTab() {
    const pool = DATA.players.filter(p => S.lvl[p.id] === 'FA' && (p.faYear || 0) <= season()).sort((a, b) => b.war - a.war);
    const entries = pool.map(p => {
      const ask = p.salary.find(x => x > 0) || 0;
      const years = el('select', { 'aria-label': `Years for ${p.name}`, style: 'width:auto;min-height:36px' },
        [1, 2, 3, 4, 5].map(n => el('option', { value: n }, n + ' yr')));
      return { p, meta: [`Age ${p.age} · Class of ${p.faYear || season()}`],
        stats: [...statPairs(p), warBlock(p), ...(hasMine ? [myBlock(p)] : []), ['Asking', [fm(ask), ' a year']],
          ...(useSurplus ? [surplusBlock('Surplus at full ask ($M)', surplusFor(p, p.salary, p.age + S.year))] : [])],
        actions: [years, el('button', { class: 'btn small', onclick: () => sign(p, Number(years.value)) }, 'Sign')] };
    });
    return el('div', {}, el('p', { class: 'small muted' }, `Free agents available in ${season()}. Class of 2028 appears when you move to 2028. Asking price is fixed in the demo; you choose the years.`),
      playerList(entries, {}));
  }
  function tradeTab() {
    const theirs = rosterOf(partner, ['MLB', '40', 'FARM']);
    const mine = rosterOf(S.teamId, ['MLB', '40', 'FARM']);
    const LEVELS = ['26-man', '40-man', 'Farm'];
    const levelOf = p => (S.lvl[p.id] === 'MLB' ? LEVELS[0] : S.lvl[p.id] === '40' ? LEVELS[1] : LEVELS[2]);
    const toggle = (set, id) => { set.has(id) ? set.delete(id) : set.add(id); render(); };
    // The whole strip is clickable, and the checkbox stays for keyboard and screen-reader users.
    const picker = (rows, set) => playerList(rows.map(p => ({ p, selected: set.has(p.id), onClick: () => toggle(set, p.id),
      lead: el('input', { type: 'checkbox', 'aria-label': `Select ${p.name}`, checked: set.has(p.id), style: 'width:22px;height:22px', onchange: () => toggle(set, p.id) }),
      meta: [...(S.lvl[p.id] === 'FARM' ? [p.farm + ' · '] : []), ...contractMeta(p)],
      stats: [['Value', r1(value(p)).toFixed(1)]] })), { group: e => levelOf(e.p), order: LEVELS });
    const partnerSel = el('select', { id: 'partner', onchange: e => { partner = e.target.value; pickTheirs.clear(); render(); } },
      DATA.teams.filter(t => t.id !== S.teamId).map(t => el('option', { value: t.id, selected: t.id === partner }, teamName(t.id))));
    const give = [...pickMine].reduce((s, id) => s + value(DATA.byId[id]), 0), get = [...pickTheirs].reduce((s, id) => s + value(DATA.byId[id]), 0);
    return el('div', {},
      el('p', { class: 'small muted' }, 'Demo rule: the other team says yes if it receives at least 5% more value than it gives. Value is projected WAR, or 60% of ceiling for prospects.'),
      el('div', { class: 'field', style: 'max-width:360px;margin-bottom:12px' }, el('label', { for: 'partner' }, 'Trade partner'), partnerSel),
      el('div', { class: 'stack' },
        el('div', {}, el('h3', {}, `You send (${r1(give)} value)`), picker(mine, pickMine)),
        el('div', {}, el('h3', {}, `You get (${r1(get)} value)`), picker(theirs, pickTheirs)),
        el('div', {}, el('button', { class: 'btn', onclick: trade }, 'Propose trade'))));
  }

  const TABS = [['roster', '40-man'], ['farm', 'Farm'], ['fa', 'Free agents'], ['trade', 'Trade']];
  function render() {
    const teamSel = el('select', { id: 'team', onchange: e => { S.teamId = e.target.value; partner = DATA.teams.find(t => t.id !== S.teamId).id; pickMine.clear(); pickTheirs.clear(); Store.save(); msg = null; render(); } },
      DATA.teams.map(t => el('option', { value: t.id, selected: t.id === S.teamId }, teamName(t.id))));
    const yearSel = el('select', { id: 'year', onchange: e => { S.year = Number(e.target.value); Store.save(); render(); } },
      DATA.seasons.map((y, i) => el('option', { value: i, selected: i === S.year }, String(y))));
    const body = { roster: rosterTab, farm: farmTab, fa: faTab, trade: tradeTab }[tab]();
    const keepFocus = document.activeElement && document.activeElement.id;
    main.replaceChildren(el('div', { class: 'wrap stack' },
      el('h1', {}, 'GM Mode'),
      el('div', { class: 'row' },
        el('div', { class: 'field' }, el('label', { for: 'team' }, 'Your team'), teamSel),
        el('div', { class: 'field' }, el('label', { for: 'year' }, 'Season'), yearSel),
        el('div', { class: 'field' }, el('label', { for: 'tax' }, 'Demo tax line ($M)'),
          el('input', { id: 'tax', type: 'text', inputmode: 'numeric', value: String(S.taxLine), onchange: e => { const v = Number(e.target.value); if (v > 0) S.taxLine = v; Store.save(); render(); } })),
        el('button', { class: 'btn alt', onclick: () => { addPost('roster', `${teamName(S.teamId)} ${season()} roster`, 'My current lineup card, posted from GM Mode.', { snap: snapshot() }); say('Posted to the forum.'); render(); } }, 'Post to forum')),
      msg ? el('p', { class: 'msg' + (msg.bad ? ' bad' : ''), role: 'status' }, msg.text) : null,
      payrollBlock(),
      el('div', { class: 'gm-grid' }, card(), el('section', {}, tabs(TABS, tab, id => { tab = id; msg = null; render(); }), body))));
    if (keepFocus) { const f = document.getElementById(keepFocus); if (f) f.focus(); }
  }
  render();
}

/* =====================================================================
   FRONT OFFICE (projection model + CSV import)
   ===================================================================== */
const WEIGHTS = [
  { k: 'iH', label: 'Hitter baseline WAR', min: -1, max: 3, step: 0.1 },
  { k: 'obp', label: 'WAR per +10 points of OBP (over .320)', min: 0, max: 0.6, step: 0.05 },
  { k: 'slg', label: 'WAR per +10 points of SLG (over .400)', min: 0, max: 0.6, step: 0.05 },
  { k: 'wrc', label: 'WAR per +10 wRC+ (over 100)', min: 0, max: 1.5, step: 0.05 },
  { k: 'ageH', label: 'WAR per year over 30 (hitters)', min: -0.6, max: 0, step: 0.05 },
  { k: 'iP', label: 'Pitcher baseline WAR', min: -1, max: 3, step: 0.1 },
  { k: 'era', label: 'WAR per 0.10 ERA under 4.50', min: 0, max: 0.2, step: 0.01 },
  { k: 'k', label: 'WAR per K% point over 20', min: 0, max: 0.2, step: 0.01 },
  { k: 'whip', label: 'WAR per .01 WHIP under 1.30', min: 0, max: 0.05, step: 0.005 },
  { k: 'ageP', label: 'WAR per year over 30 (pitchers)', min: -0.6, max: 0, step: 0.05 },
];

function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

const CONTRACT_SLIDERS = [
  { g: 'w', k: 'career', label: 'Weight on career average WAR', min: 0, max: 1, step: 0.05 },
  { g: 'w', k: 'last', label: 'Weight on last season WAR', min: 0, max: 1, step: 0.05 },
  { g: 'w', k: 'prior', label: 'Weight on the season before', min: 0, max: 1, step: 0.05 },
  { g: 'dec', k: 'young', label: 'WAR lost per year, age 30 and under', min: 0, max: 1.5, step: 0.05 },
  { g: 'dec', k: 'mid', label: 'WAR lost per year, ages 31 to 33', min: 0, max: 1.5, step: 0.05 },
  { g: 'dec', k: 'old', label: 'WAR lost per year, age 34 and up', min: 0, max: 1.5, step: 0.05 },
  { g: '', k: 'price', label: 'Dollars per WAR ($M)', min: 2, max: 15, step: 0.5 },
];

function contractSection() {
  const C = S.contract || (S.contract = JSON.parse(JSON.stringify(Contract.defaults)));
  const results = el('div', {}), formula = el('p', { class: 'small muted' }), note = el('div', {});
  const get = d => (d.g ? C[d.g][d.k] : C[d.k]);
  const put = (d, v) => { if (d.g) C[d.g][d.k] = v; else C[d.k] = v; };

  function draw() {
    formula.textContent = contractLine(C);
    if (!C.rows.length) {
      results.replaceChildren(el('p', { class: 'muted' }, 'No players yet. Add one below, or import a CSV in the same layout as the sample sheet.'));
      return;
    }
    const evals = C.rows.map(r => ({ r, e: Contract.evaluate(r, C) }));
    const maxWar = Math.max(0.1, ...evals.flatMap(x => x.e.war)); // one scale for every player's year bars
    const yearBars = war => el('span', { class: 'yearbars', role: 'img', 'aria-label': 'WAR by year: ' + war.map((w, i) => `year ${i + 1} ${w.toFixed(1)}`).join(', ') },
      war.slice(0, 10).map(w => el('span', { class: 'yb', 'aria-hidden': 'true' },
        el('span', { class: 'yb-bar', style: `height:${Math.max(2, Math.round(w / maxWar * 28))}px` }), el('span', { class: 'yb-val' }, w.toFixed(1)))));
    results.replaceChildren(playerList(evals.map(({ r, e }, idx) => {
      const [nm, ps] = r.name.split('/'), pos = (ps || '').trim();
      const tone = e.surplus < 0 ? 'loss' : 'gain';
      return { name: nm.trim(), pos: pos || '–', kind: ['SP', 'RP', 'P', 'CP'].includes(pos) ? 'P' : pos ? 'H' : null,
        meta: [`Age ${r.age} · ${r.years} yr · `, fm(r.value)],
        stats: [['WAR by year', yearBars(e.war)], ['Baseline WAR', e.base.toFixed(1)], ['Total WAR', e.total.toFixed(1)], ['Value', fm(e.value)],
          ['Surplus', el('span', { class: tone }, (e.surplus >= 0 ? '+' : ''), fm(e.surplus))], ['Verdict', el('span', { class: tone }, e.verdict)]],
        actions: [el('button', { class: 'btn alt small', 'aria-label': 'Remove ' + r.name, onclick: () => { C.rows.splice(idx, 1); Store.save(); draw(); } }, 'Remove')] };
    })));
  }

  const sliders = CONTRACT_SLIDERS.map(d => {
    const out = el('output', { for: 'c-' + d.g + d.k }, String(get(d)));
    return el('div', { class: 'field weight' }, el('label', { for: 'c-' + d.g + d.k }, d.label + ': ', out),
      el('input', { type: 'range', id: 'c-' + d.g + d.k, min: d.min, max: d.max, step: d.step, value: String(get(d)),
        oninput: e => { put(d, Number(e.target.value)); out.textContent = e.target.value; draw(); },
        onchange: () => Store.save() }));
  });

  // Add-a-player form
  const f = {};
  const field = (key, label, ph) => { f[key] = el('input', { type: 'text', id: 'cf-' + key, inputmode: key === 'name' ? 'text' : 'decimal', placeholder: ph }); return el('div', { class: 'field' }, el('label', { for: 'cf-' + key }, label), f[key]); };
  const form = el('form', { class: 'row', onsubmit: e => {
    e.preventDefault();
    const row = { name: f.name.value.trim(), career: parseFloat(f.career.value), last: parseFloat(f.last.value), prior: parseFloat(f.prior.value),
      age: parseInt(f.age.value, 10), years: parseInt(f.years.value, 10), value: parseFloat(f.value.value) };
    const bad = !row.name || [row.career, row.last, row.prior, row.age, row.years, row.value].some(x => isNaN(x)) || row.years < 1 || row.years > 10;
    if (bad) { note.replaceChildren(el('p', { class: 'msg bad', role: 'alert' }, 'Fill every box with a number (years between 1 and 10).')); return; }
    C.rows.push(row); Store.save(); form.reset(); note.replaceChildren(); draw();
  } },
    field('name', 'Player and position', 'e.g. Sample Player/SP'), field('career', 'Career avg WAR', '3.3'), field('last', 'Last season WAR', '2.9'),
    field('prior', 'Season before WAR', '1.1'), field('age', 'Age at signing', '31'), field('years', 'Contract years', '5'), field('value', 'Contract value ($M)', '100'),
    el('button', { class: 'btn', type: 'submit' }, 'Add player'));

  // CSV import: reads the first table in the sample sheet's layout.
  const file = el('input', { type: 'file', id: 'ccsv', accept: '.csv,text/csv' });
  file.addEventListener('change', async () => {
    const g = file.files[0]; if (!g) return;
    const rows = parseCSV(await g.text());
    // The header is the first row with a "Player" cell and several other filled cells (this skips the sheet's one-cell title row).
    const hi = rows.findIndex(r => r.some(c => c.toLowerCase().includes('player')) && r.filter(c => c.trim()).length >= 4);
    if (hi < 0) { note.replaceChildren(el('p', { class: 'msg bad', role: 'alert' }, 'No header row with a "Player" column was found.')); return; }
    const head = rows[hi].map(h => h.trim().toLowerCase().replace(/\s+/g, ' '));
    const col = test => head.findIndex(test);
    const ix = { name: col(h => h.includes('player')), career: col(h => h.includes('career')), last: col(h => h.includes('2025')),
      prior: col(h => h === '2024' || h.includes('2024')), age: col(h => h.startsWith('age at signing')),
      years: col(h => h.includes('contract length')), value: col(h => h.includes('contract value')) };
    const missing = Object.entries(ix).filter(([, v]) => v < 0).map(([k]) => k);
    if (missing.length) { note.replaceChildren(el('p', { class: 'msg bad', role: 'alert' }, 'Could not find columns for: ' + missing.join(', ') + '.')); return; }
    let added = 0;
    for (const r of rows.slice(hi + 1)) {
      if (!(r[ix.name] || '').trim()) break; // the table ends at the first blank row
      const row = { name: r[ix.name].trim(), career: parseFloat(r[ix.career]), last: parseFloat(r[ix.last]), prior: parseFloat(r[ix.prior]),
        age: parseInt(r[ix.age], 10), years: parseInt(r[ix.years], 10), value: parseFloat(r[ix.value]) };
      if ([row.career, row.last, row.prior, row.age, row.years, row.value].some(x => isNaN(x))) continue;
      if (C.rows.some(x => x.name === row.name)) continue;
      C.rows.push(row); added++;
    }
    Store.save(); draw();
    note.replaceChildren(el('p', { class: 'msg', role: 'status' }, `Loaded ${added} player${added === 1 ? '' : 's'}. The sheet's "2025" and "2024" columns became "last season" and "season before". Check the numbers against your source before trusting them.`));
  });

  const useBox = el('input', { type: 'checkbox', id: 'cuse', checked: !!C.use, style: 'width:22px;height:22px',
    onchange: e => { C.use = e.target.checked; Store.save(); } });

  const sec = el('section', { class: 'panel stack' },
    el('h2', {}, 'Contract value model'),
    el('p', { style: 'max-width:62ch' }, 'Is a contract a good deal? Set how you weigh a player\'s history, how fast you think players decline with age, and what a win is worth. The page projects WAR each year of the deal and compares it to the money. The starting numbers are placeholders, not fitted to anything.'),
    el('div', { class: 'model-grid' }, sliders), formula,
    el('h3', {}, 'Players to evaluate'), results,
    el('h3', {}, 'Add a player'), form,
    el('div', { class: 'field', style: 'max-width:420px' }, el('label', { for: 'ccsv' }, 'Or import a CSV in the sample sheet\'s layout'), file),
    note,
    el('label', { for: 'cuse' }, useBox, ' Use this model in GM Mode (adds a contract-surplus column for the demo league)'),
    el('div', { class: 'row' },
      el('button', { class: 'btn', onclick: () => {
        if (!C.rows.length) { note.replaceChildren(el('p', { class: 'msg bad', role: 'alert' }, 'Add at least one player first.')); return; }
        const params = { w: Object.assign({}, C.w), dec: Object.assign({}, C.dec), price: C.price };
        const lines = C.rows.map(r => { const e = Contract.evaluate(r, C); return `${r.name}: ${r.years} yr, ${money(r.value)} contract, ${e.total.toFixed(1)} projected WAR worth ${money(e.value)}, ${e.verdict} by ${money(Math.abs(e.surplus))}`; });
        addPost('model', `Contract model: ${C.rows.length} player${C.rows.length === 1 ? '' : 's'} evaluated`, 'How my contract model grades these deals. Tell me where my age curve is wrong.', { contract: { params, results: lines } });
        note.replaceChildren(el('p', { class: 'msg', role: 'status' }, 'Posted to the forum. ', el('a', { href: 'forum.html' }, 'See it')));
      } }, 'Publish to forum'),
      el('button', { class: 'btn alt', onclick: () => { Object.assign(C, JSON.parse(JSON.stringify(Contract.defaults)), { rows: C.rows }); Store.save(); const parent = sec.parentNode; parent.replaceChild(contractSection(), sec); } }, 'Reset weights')));
  draw();
  return sec;
}

function pageFO(main) {
  const w = Object.assign({}, Model.defaults, S.model ? S.model.w : {});
  let sortMode = 'top', csvMsg = null, savedMsg = null;

  const tableBox = el('div', {}), formulaBox = el('p', { class: 'small muted' });
  function drawTable() {
    const rows = DATA.players.map(p => ({ p, mine: Model.score(p, w) }));
    rows.sort(sortMode === 'top' ? (a, b) => b.mine - a.mine : (a, b) => Math.abs(b.mine - b.p.war) - Math.abs(a.mine - a.p.war));
    formulaBox.textContent = modelLine({ w });
    tableBox.replaceChildren(playerList(rows.slice(0, 14).map(({ p, mine }, i) => {
      const gap = r1(mine - p.war);
      return { p, lead: String(i + 1), meta: [`Age ${p.age} · ${S.team[p.id] ? teamName(S.team[p.id]) : 'Free agent'}`],
        stats: [...statPairs(p), ['Demo WAR', p.war.toFixed(1)], ['My model', heat(mine.toFixed(1), mine, 1.5, 3.5)],
          ['Gap', el('span', { class: gap >= 0 ? 'gain' : 'loss' }, (gap >= 0 ? '+' : '') + gap.toFixed(1))]] };
    })));
  }

  const sliders = WEIGHTS.map(def => {
    const out = el('output', { for: 'w-' + def.k }, String(w[def.k]));
    const input = el('input', { type: 'range', id: 'w-' + def.k, min: def.min, max: def.max, step: def.step, value: String(w[def.k]),
      oninput: e => { w[def.k] = Number(e.target.value); out.textContent = String(w[def.k]); drawTable(); } });
    return el('div', { class: 'field weight' }, el('label', { for: 'w-' + def.k }, def.label + ': ', out), input);
  });

  const fileIn = el('input', { type: 'file', id: 'csv', accept: '.csv,text/csv' });
  const csvOut = el('div', {});
  function drawCsv() {
    csvOut.replaceChildren(
      csvMsg ? el('p', { class: 'msg' + (csvMsg.bad ? ' bad' : ''), role: 'status' }, csvMsg.text) : null,
      Object.keys(S.csv).length ? el('p', {}, `${Object.keys(S.csv).length} imported projections are active and show as "My WAR" in GM Mode. `,
        el('button', { class: 'btn alt small', onclick: () => { S.csv = {}; Store.save(); csvMsg = { text: 'Imported projections cleared.' }; drawCsv(); } }, 'Clear imported projections')) : null);
  }
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0]; if (!f) return;
    const rows = parseCSV(await f.text());
    const head = (rows.shift() || []).map(h => h.trim().toLowerCase());
    const ni = head.indexOf('name'), wi = head.findIndex(h => h === 'proj_war' || h === 'war');
    if (ni < 0 || wi < 0) { csvMsg = { text: 'The file needs a "name" column and a "proj_war" column in the first row.', bad: true }; return drawCsv(); }
    const byName = {}; DATA.players.forEach(p => { byName[p.name.toLowerCase()] = p; });
    let hit = 0; const miss = [];
    rows.forEach(r => {
      const p = byName[(r[ni] || '').trim().toLowerCase()], v = parseFloat(r[wi]);
      if (p && !isNaN(v)) { S.csv[p.name] = v; hit++; } else if (r[ni]) miss.push(r[ni].trim());
    });
    Store.save();
    csvMsg = { text: `Matched ${hit} of ${rows.length} rows to demo players.` + (miss.length ? ` Not found (demo league only has fictional players): ${miss.slice(0, 8).join(', ')}${miss.length > 8 ? '...' : ''}.` : ''), bad: !hit };
    drawCsv();
  });

  const name = el('input', { type: 'text', id: 'mname', value: S.model ? S.model.name : 'My model', 'aria-label': 'Model name' });
  const status = el('div', {});
  main.replaceChildren(el('div', { class: 'wrap stack' },
    el('h1', {}, 'Front Office'),
    el('p', { class: 'muted', style: 'max-width:60ch' }, 'Build your own models, the way a front-office analyst would. Start with a contract value model, then a player projection model. The starting numbers are placeholders I chose, not fitted to anything.'),
    contractSection(),
    el('section', { class: 'panel stack' },
      el('h2', {}, 'Player projection model'),
      el('p', { class: 'small muted' }, 'Weights below re-rank the fictional demo league.'),
      el('div', { class: 'model-grid' }, sliders),
      formulaBox,
      el('div', { class: 'row' },
        el('div', { class: 'field' }, el('label', { for: 'mname' }, 'Model name'), name),
        el('button', { class: 'btn', onclick: () => { S.model = { name: name.value.trim() || 'My model', w: Object.assign({}, w) }; Store.save(); status.replaceChildren(el('p', { class: 'msg', role: 'status' }, 'Saved. "My WAR" now shows this model in GM Mode.')); } }, 'Save model'),
        el('button', { class: 'btn alt', onclick: () => {
          const m = { name: name.value.trim() || 'My model', w: Object.assign({}, w) };
          S.model = m; addPost('model', `Model: ${m.name}`, 'Here are my weights. Tell me what you would change.', { model: m });
          status.replaceChildren(el('p', { class: 'msg', role: 'status' }, 'Posted to the forum. ', el('a', { href: 'forum.html' }, 'See it'))); } }, 'Publish to forum'),
        el('button', { class: 'btn alt', onclick: () => { Object.assign(w, Model.defaults); main.replaceChildren(); pageFO(main); } }, 'Reset weights')),
      status),
    el('section', { class: 'stack' },
      el('h2', {}, 'How your model compares'),
      el('div', { class: 'tabs', role: 'group', 'aria-label': 'Sort' },
        [['top', 'Highest by my model'], ['gap', 'Biggest gap vs. demo']].map(([id, label]) =>
          el('button', { class: 'tab', 'aria-pressed': String(sortMode === id), 'aria-selected': String(sortMode === id), onclick: () => { sortMode = id; document.querySelectorAll('[aria-label=Sort] .tab').forEach(b => b.setAttribute('aria-selected', String(b.textContent === label))); drawTable(); } }, label))),
      tableBox),
    el('section', { class: 'panel stack' },
      el('h2', {}, 'Import your own projections'),
      el('p', {}, 'Upload a CSV with a header row containing "name" and "proj_war". Matching players get your number as "My WAR". The demo league only has fictional players, so real names will not match until real data is added (see README).'),
      el('div', { class: 'field', style: 'max-width:420px' }, el('label', { for: 'csv' }, 'Projection CSV'), fileIn),
      csvOut)));
  drawTable(); drawCsv();
  // The tab buttons above use aria-selected for the sort toggle; set initial state.
  document.querySelectorAll('[aria-label=Sort] .tab').forEach((b, i) => b.setAttribute('aria-selected', String(i === 0)));
}

/* =====================================================================
   FORUM
   ===================================================================== */
function pageForum(main) {
  let filter = 'all', q = '', sort = 'new';
  const feed = el('div', {});
  const score = p => (p.votes || 0) + (S.votes[p.id] ? 1 : 0);
  function draw() {
    const list = S.posts
      .filter(p => (filter === 'all' || p.type === filter) && (p.title + ' ' + p.body + ' ' + p.author).toLowerCase().includes(q.toLowerCase()))
      .sort(sort === 'top' ? (a, b) => score(b) - score(a) : (a, b) => new Date(b.date) - new Date(a.date));
    feed.replaceChildren(...(list.length ? list.map(p => postCard(p, draw)) : [el('p', { class: 'muted' }, q ? 'No posts match that search.' : 'No posts here yet. Be the first.')]));
  }
  const title = el('input', { type: 'text', id: 'ptitle', maxlength: '120' });
  const kind = el('select', { id: 'ptype' }, Object.entries(TYPE_LABEL).map(([v, l]) => el('option', { value: v }, l)));
  const body = el('textarea', { id: 'pbody', maxlength: '3000' });
  const attachRoster = el('input', { type: 'checkbox', id: 'ar', style: 'width:22px;height:22px' });
  const attachModel = el('input', { type: 'checkbox', id: 'am', style: 'width:22px;height:22px' });
  const note = el('div', {});
  main.replaceChildren(el('div', { class: 'wrap stack' },
    el('h1', {}, 'Forum'),
    el('p', { class: 'muted', style: 'max-width:60ch' }, 'Share rosters, free-agency plans and models. In this version posts are saved only in your browser, and the seeded posts are fictional demos. A shared forum needs a server (see README).'),
    el('form', { class: 'panel stack', onsubmit: e => {
      e.preventDefault();
      if (!title.value.trim() || !body.value.trim()) { note.replaceChildren(el('p', { class: 'msg bad', role: 'alert' }, 'Add a title and some text first.')); return; }
      const attach = {};
      if (attachRoster.checked) attach.snap = snapshot();
      if (attachModel.checked && S.model) attach.model = S.model;
      addPost(kind.value, title.value.trim(), body.value.trim(), attach.snap || attach.model ? attach : null);
      title.value = ''; body.value = ''; note.replaceChildren(el('p', { class: 'msg', role: 'status' }, 'Posted.')); draw();
    } },
      el('h2', {}, 'New post'),
      el('div', { class: 'row' }, el('div', { class: 'field' }, el('label', { for: 'ptitle' }, 'Title'), title), el('div', { class: 'field', style: 'max-width:220px' }, el('label', { for: 'ptype' }, 'Type'), kind)),
      el('div', { class: 'field' }, el('label', { for: 'pbody' }, 'What did you do and why?'), body),
      el('label', { for: 'ar' }, attachRoster, ' Attach my current roster card'),
      el('label', { for: 'am' }, attachModel, S.model ? ` Attach my saved model (${S.model.name})` : ' Attach my saved model (none saved yet)'),
      el('div', {}, el('button', { class: 'btn', type: 'submit' }, 'Publish post')), note),
    tabs([['all', 'All'], ['roster', 'Rosters'], ['fa', 'Free agency'], ['model', 'Models']], 'all', id => { filter = id; document.querySelectorAll('.tabs .tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.id === id))); draw(); }),
    el('div', { class: 'row' },
      el('div', { class: 'field' }, el('label', { for: 'fq' }, 'Search posts'), el('input', { type: 'search', id: 'fq', placeholder: 'Try "tax line" or "WAR"', oninput: e => { q = e.target.value; draw(); } })),
      el('div', { class: 'field', style: 'max-width:220px' }, el('label', { for: 'fsort' }, 'Sort by'),
        el('select', { id: 'fsort', onchange: e => { sort = e.target.value; draw(); } }, el('option', { value: 'new' }, 'Newest'), el('option', { value: 'top' }, 'Most upvoted')))),
    feed));
  // tabs() above has no data-id; tag them so the selected state can follow the filter.
  const ids = ['all', 'roster', 'fa', 'model'];
  document.querySelectorAll('.tabs .tab').forEach((b, i) => { b.dataset.id = ids[i]; });
  draw();
}

/* =====================================================================
   PROFILE
   ===================================================================== */
function pageProfile(main) {
  const mine = () => S.posts.filter(p => !p.demo);
  const C = S.contract;
  const nameIn = el('input', { type: 'text', id: 'uname', value: S.user.name, maxlength: '30' });
  const out = el('div', {});
  main.replaceChildren(el('div', { class: 'wrap stack' },
    el('h1', {}, 'My Profile'),
    el('form', { class: 'panel stack', onsubmit: e => { e.preventDefault(); const v = nameIn.value.trim(); if (!v) return; S.user.name = v; Store.save(); out.replaceChildren(el('p', { class: 'msg', role: 'status' }, 'Name saved.')); } },
      el('div', { class: 'row' }, el('div', { class: 'field' }, el('label', { for: 'uname' }, 'Username'), nameIn), el('button', { class: 'btn', type: 'submit' }, 'Save name')), out),
    el('section', { class: 'panel' }, el('h2', {}, 'Your numbers'),
      el('p', { style: 'margin-top:8px' }, `Team: ${teamName(S.teamId)} · Moves made: ${S.moves.length} · Posts: ${mine().length} · Imported projections: ${Object.keys(S.csv).length}`),
      el('p', { class: 'small muted' }, Store.persistent ? 'Saved in this browser only.' : 'This browser is blocking storage, so nothing is saved after you close the page.')),
    el('section', { class: 'panel' }, el('h2', {}, 'Your models'),
      el('h3', { style: 'margin-top:12px' }, 'Player projection model'),
      S.model ? el('p', {}, el('strong', {}, S.model.name + ': '), modelLine(S.model)) : el('p', { class: 'muted' }, 'None saved yet.'),
      el('h3', {}, 'Contract value model'),
      C && C.rows.length ? el('p', {}, `${C.rows.length} player${C.rows.length === 1 ? '' : 's'} evaluated. `, contractLine(C)) : el('p', { class: 'muted' }, 'None saved yet.'),
      el('a', { class: 'btn small', href: 'front-office.html' }, 'Open Front Office')),
    el('section', { class: 'panel' }, el('h2', {}, 'Your recent moves'),
      S.moves.length ? el('ul', { class: 'log', style: 'margin-top:8px' }, S.moves.slice(0, 15).map(m => el('li', {}, `${fmtDate(m.t)}: ${m.text}`)))
        : el('p', { class: 'muted', style: 'margin-top:8px' }, 'No moves yet. Sign, trade or option someone in GM Mode.')),
    el('section', {}, el('h2', {}, 'Your posts'), el('div', { id: 'mine', style: 'margin-top:12px' })),
    el('section', { class: 'panel' }, el('h2', {}, 'Start over'),
      el('p', { style: 'margin-top:8px' }, 'This clears every move, post, model and imported projection saved in this browser and restores the demo league.'),
      el('button', { class: 'btn danger', onclick: () => { if (confirm('Erase everything saved in this browser and restart the demo?')) { Store.reset(); location.reload(); } } }, 'Erase my data'))));
  const box = document.getElementById('mine');
  const draw = () => box.replaceChildren(...(mine().length ? mine().map(p => postCard(p, draw)) : [el('p', { class: 'muted' }, 'You have not posted yet. Publish a roster from GM Mode or a model from Front Office.')]));
  draw();
}

/* =====================================================================
   STATS GLOSSARY
   ===================================================================== */
// "Try the math": type counting stats, see the rate stats the glossary defines.
function calcPanel() {
  function calc(title, hint, fields, compute) {
    const out = el('p', { class: 'muted', role: 'status' }, 'Fill in the first boxes to see results.');
    const inputs = {};
    const grid = el('div', { class: 'row' }, fields.map(([key, label, required]) => {
      inputs[key] = el('input', { type: 'text', inputmode: 'decimal', id: 'calc-' + title + key,
        oninput: () => {
          const v = {}; let missing = false;
          for (const [k, , req] of fields) {
            const raw = inputs[k].value.trim();
            if (raw === '') { if (req) missing = true; v[k] = 0; } else v[k] = Number(raw);
            if (isNaN(v[k]) || v[k] < 0) { out.textContent = 'Use numbers that are 0 or higher.'; return; }
          }
          out.textContent = missing ? 'Fill in the first boxes to see results.' : compute(v);
        } });
      return el('div', { class: 'field', style: 'flex:1 1 90px' }, el('label', { for: 'calc-' + title + key }, label + (required ? '' : ' (optional)')), inputs[key]);
    }));
    return el('div', { class: 'stack' }, el('h3', {}, title), el('p', { class: 'small muted' }, hint), grid, out);
  }
  const f3 = x => x.toFixed(3).replace(/^0/, '');
  const hit = calc('Hitting', 'Enter a hitter\'s season totals. Doubles, triples and home runs are included in hits.', [
    ['h', 'Hits', true], ['ab', 'At-bats', true], ['d2', 'Doubles', false], ['d3', 'Triples', false], ['hr', 'Home runs', false],
    ['bb', 'Walks', false], ['hbp', 'Hit by pitch', false], ['sf', 'Sac flies', false]], v => {
    if (v.ab <= 0) return 'At-bats must be above 0.';
    if (v.h > v.ab || v.d2 + v.d3 + v.hr > v.h) return 'Those totals do not add up: hits cannot exceed at-bats, and extra-base hits cannot exceed hits.';
    const avg = v.h / v.ab, obp = (v.h + v.bb + v.hbp) / (v.ab + v.bb + v.hbp + v.sf);
    const slg = (v.h + v.d2 + 2 * v.d3 + 3 * v.hr) / v.ab;
    return `AVG ${f3(avg)} · OBP ${f3(obp)} · SLG ${f3(slg)} · OPS ${f3(obp + slg)} · ISO ${f3(slg - avg)}`;
  });
  const pitch = calc('Pitching', 'Innings can be written the baseball way: 180.1 means 180 and one third.', [
    ['ip', 'Innings pitched', true], ['er', 'Earned runs', true], ['h', 'Hits allowed', true], ['bb', 'Walks', true]], v => {
    const whole = Math.floor(v.ip), third = Math.round((v.ip - whole) * 10);
    if (third > 2) return 'In innings, the digit after the dot can only be 0, 1 or 2 (thirds).';
    const ip = whole + third / 3;
    if (ip <= 0) return 'Innings must be above 0.';
    return `ERA ${(9 * v.er / ip).toFixed(2)} · WHIP ${((v.bb + v.h) / ip).toFixed(2)}`;
  });
  return el('section', { class: 'panel stack' }, el('h2', {}, 'Try the math'),
    el('div', { class: 'model-grid' }, hit, pitch));
}

function pageStats(main) {
  let q = '', group = 'All';
  const list = el('div', {});
  function draw() {
    const items = DATA.glossary.filter(g => (group === 'All' || g.group === group)
      && (g.name + ' ' + g.plain).toLowerCase().includes(q.toLowerCase()));
    list.replaceChildren(...(items.length ? items.map(g => el('article', { class: 'stat-entry', id: g.id },
      el('h2', {}, g.name), el('span', { class: 'small muted' }, g.group),
      el('p', { style: 'margin-top:8px' }, g.plain),
      el('div', { class: 'formula' }, g.formula),
      el('details', {}, el('summary', {}, 'Go deeper'), el('p', {}, g.adv)),
      el('p', { class: 'small muted' }, 'Check definitions against ', el('a', { href: 'https://www.mlb.com/glossary' }, 'the MLB glossary'), '.'))) : [el('p', { class: 'muted' }, 'No stat matches that search.')]));
  }
  const search = el('input', { type: 'search', id: 'q', placeholder: 'Search, e.g. OBP', oninput: e => { q = e.target.value; draw(); } });
  const groups = ['All', 'Hitting', 'Pitching', 'Value', 'Statcast'];
  main.replaceChildren(el('div', { class: 'wrap stack' },
    el('h1', {}, 'Stats'),
    el('p', { class: 'muted', style: 'max-width:60ch' }, 'Every stat used here: what it is in plain words, how it is calculated, and a deeper note for people who already live in spreadsheets.'),
    calcPanel(),
    el('div', { class: 'row' }, el('div', { class: 'field' }, el('label', { for: 'q' }, 'Search stats'), search)),
    el('div', { class: 'tabs', role: 'group', 'aria-label': 'Group' }, groups.map(g =>
      el('button', { class: 'tab', 'aria-selected': String(g === 'All'), onclick: e => { group = g; document.querySelectorAll('[aria-label=Group] .tab').forEach(b => b.setAttribute('aria-selected', String(b === e.currentTarget))); draw(); } }, g))),
    list));
  draw();
}

/* ---------- Start ---------- */
const page = document.querySelector('main').dataset.page;
shell(page);
({ home: pageHome, gm: pageGM, fo: pageFO, forum: pageForum, profile: pageProfile, stats: pageStats })[page](document.querySelector('main'));
