'use strict';
/*
  DEMO DATA. Every team, player, contract and stat below is generated and fictional.
  The generator is seeded, so everyone sees the same league. Nothing here describes a real MLB player.
  Real data would replace this file (see README.md, "Making it real").
*/
const DATA = (() => {
  // Seeded random numbers (mulberry32): same seed, same league every time.
  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const r = rng(2027);
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const gauss = () => (r() + r() + r() + r() - 2) / 0.577; // roughly mean 0, spread 1
  const pick = a => a[Math.floor(r() * a.length)];
  const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

  const FIRST = ['Mateo', 'Caleb', 'Jonah', 'Rafael', 'Tobias', 'Dante', 'Silas', 'Emmett', 'Hugo', 'Wes',
    'Andre', 'Cormac', 'Dalton', 'Ezra', 'Felix', 'Gideon', 'Hollis', 'Idris', 'Jules', 'Kai',
    'Lorenzo', 'Marcus', 'Nico', 'Otis', 'Pablo', 'Quincy', 'Reese', 'Sully', 'Theo', 'Ulises',
    'Vance', 'Wyatt', 'Xavier', 'Yusuf', 'Zane', 'Beau', 'Colt', 'Desmond', 'Elliot', 'Franco'];
  const LAST = ['Abernathy', 'Barrow', 'Castellan', 'Dunmore', 'Easterly', 'Fontaine', 'Garrity', 'Hollowell',
    'Ibarra', 'Jessup', 'Kestrel', 'Lindqvist', 'Maddox', 'Navarro', 'Okafor', 'Pruitt', 'Quill', 'Rourke',
    'Sandoval', 'Thackeray', 'Underhill', 'Varga', 'Whitlock', 'Yarbrough', 'Zielinski', 'Aldridge', 'Brannigan',
    'Cordero', 'Delacroix', 'Ellery', 'Fairbanks', 'Gallo', 'Hartigan', 'Iverson', 'Janssen', 'Kowalczyk',
    'Larkin', 'Merriweather', 'Nakamura', 'Oyelaran', 'Pemberton', 'Quarles', 'Rasmussen', 'Strand', 'Tarkington',
    'Ulloa', 'Vickers', 'Wexler', 'Yoon', 'Zamora', 'Ashby', 'Boone', 'Crandall', 'Dormer', 'Escobedo', 'Flynn',
    'Granger', 'Hobbs'];
  const used = new Set();
  function name() {
    for (;;) {
      const n = pick(FIRST) + ' ' + pick(LAST);
      if (!used.has(n)) { used.add(n); return n; }
    }
  }

  const teams = [
    { id: 'harbor', city: 'Harbor City', name: 'Lamplighters' },
    { id: 'pine', city: 'Pine Ridge', name: 'Loggers' },
    { id: 'salt', city: 'Saltmarsh', name: 'Herons' },
    { id: 'copper', city: 'Copper Basin', name: 'Prospectors' },
    { id: 'lake', city: 'Lakeshore', name: 'Ferrymen' },
    { id: 'mesa', city: 'Mesa Verde', name: 'Sunbirds' },
  ];
  const seasons = [2027, 2028, 2029, 2030, 2031];
  const FARM_LEVELS = ['AAA', 'AA', 'High-A', 'A'];

  const players = [];
  let n = 0;

  function contract(war, yrs, floor) {
    const aav = clamp(round(floor + Math.max(0, war) * 5.2 + r() * 2, 1), floor, 38);
    return Array(yrs).fill(aav);
  }

  function hitter(pos, tier) {
    const s = gauss() + tier;
    const avg = clamp(0.248 + 0.022 * s, 0.19, 0.34);
    const obp = clamp(avg + 0.068 + 0.012 * s, 0.26, 0.44);
    const slg = clamp(avg + 0.15 + 0.045 * s, 0.30, 0.65);
    const wrc = Math.round(100 + 16 * s);
    return {
      kind: 'H', pos, age: Math.round(clamp(27 + gauss() * 4, 21, 38)), bats: pick(['L', 'R', 'R', 'S']),
      s: { avg: round(avg, 3), obp: round(obp, 3), slg: round(slg, 3), wrc },
      war: round(clamp((wrc - 85) / 10 + (r() - 0.5) * 0.6, -1, 8.5), 1),
    };
  }
  function pitcher(pos, tier) {
    const s = gauss() + tier;
    const era = clamp(4.15 - 0.6 * s, 2.3, 6.2);
    const whip = clamp(1.28 - 0.12 * s, 0.88, 1.7);
    const kpct = clamp(21 + 3.5 * s, 12, 34);
    const sp = pos === 'SP';
    return {
      kind: 'P', pos, age: Math.round(clamp(28 + gauss() * 4, 21, 39)), bats: pick(['L', 'R', 'R']),
      s: { era: round(era, 2), whip: round(whip, 2), kpct: round(kpct, 1) },
      war: round(clamp(sp ? (4.7 - era) * 1.1 : (4.3 - era) * 0.4, -1, 7.5), 1),
    };
  }
  function add(base, team, lvl, extra) {
    const p = Object.assign({ id: 'p' + (++n), name: name(), team, lvl }, base, extra);
    players.push(p);
    return p;
  }

  const HIT_POS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH'];

  teams.forEach(t => {
    const strength = gauss() * 0.4; // some teams are better than others
    // 26-man: nine starters, four bench bats, five starters, eight relievers.
    HIT_POS.forEach(pos => { const p = add(hitter(pos, strength), t.id, 'MLB'); p.salary = contract(p.war, 1 + Math.floor(r() * 5), 0.8); });
    ['C', 'IF', 'OF', 'UT'].forEach(pos => { const p = add(hitter(pos, strength - 0.8), t.id, 'MLB'); p.salary = contract(p.war, 1 + Math.floor(r() * 3), 0.8); });
    for (let i = 0; i < 5; i++) { const p = add(pitcher('SP', strength), t.id, 'MLB'); p.salary = contract(p.war, 1 + Math.floor(r() * 5), 0.8); }
    for (let i = 0; i < 8; i++) { const p = add(pitcher('RP', strength - 0.3), t.id, 'MLB'); p.salary = contract(p.war, 1 + Math.floor(r() * 3), 0.8); }
    // 40-man players who are not on the 26-man.
    for (let i = 0; i < 7; i++) { const p = add(hitter(pick(['C', 'IF', 'OF', 'UT']), strength - 1.2), t.id, '40'); p.salary = [0.8, 0.8].slice(0, 1 + Math.floor(r() * 2)); }
    for (let i = 0; i < 7; i++) { const p = add(pitcher(i < 3 ? 'SP' : 'RP', strength - 1.2), t.id, '40'); p.salary = [0.8, 0.8].slice(0, 1 + Math.floor(r() * 2)); }
    // Farm system: no payroll cost until added to the 40-man.
    for (let i = 0; i < 16; i++) {
      const hit = i % 2 === 0;
      const p = add(hit ? hitter(pick(['C', 'IF', 'OF', 'SS', 'CF']), strength - 1.6) : pitcher(i % 4 === 1 ? 'SP' : 'RP', strength - 1.6), t.id, 'FARM');
      p.age = Math.round(clamp(21 + gauss() * 1.6, 18, 26));
      p.farm = FARM_LEVELS[Math.floor(i / 4)];
      p.pot = round(clamp(1.5 + gauss() * 1.4 + (p.farm === 'AAA' ? 0.5 : 0), 0, 6), 1); // demo "ceiling" in WAR
      p.salary = [0.8];
    }
  });

  // Free-agent classes: faYear is the first season each player can be signed.
  for (let i = 0; i < 36; i++) {
    const hit = i % 2 === 0;
    const tier = 0.6 + gauss() * 0.5;
    const p = add(hit ? hitter(pick(HIT_POS.concat(['IF', 'OF'])), tier) : pitcher(i % 4 === 1 ? 'SP' : 'RP', tier), null, 'FA');
    p.age = Math.round(clamp(29 + gauss() * 3, 25, 38));
    p.faYear = i < 24 ? 2027 : 2028;
    const yrs = clamp(Math.round(5 - (p.age - 27) * 0.4), 1, 5);
    p.salary = contract(p.war, yrs, 1.5);
  }

  const byId = {};
  players.forEach(p => { byId[p.id] = p; });

  // Seeded forum posts. All are labeled Demo and describe the fictional league only.
  const seedPosts = [
    {
      id: 'd1', demo: true, type: 'roster', author: 'demo_scorekeeper', date: '2026-10-21',
      title: 'Lamplighters 2028: pitching first, one bat short',
      body: 'I spent the whole free-agent class on three starters and let the DH walk. The rotation looks great on paper and the lineup card has a hole at nine. Would you spend the tax-line room on a bat or save it for the 2029 class?',
      replies: [{ author: 'demo_stat_nerd', date: '2026-10-22', text: 'Check your relievers before you decide. Mine were costing me more than the DH slot ever did.' }],
      votes: 5,
    },
    {
      id: 'd2', demo: true, type: 'fa', author: 'demo_armchair', date: '2026-10-19',
      title: 'How I used the 2027 class to rebuild the Herons',
      body: 'Step 1: option three bench bats to open 40-man room. Step 2: sign the two best relievers on one-year deals so nothing clogs 2029. Step 3: check the payroll bar for each season before pressing Sign. The bar is the whole game.',
      replies: [],
      votes: 8,
    },
    {
      id: 'd3', demo: true, type: 'model', author: 'demo_stat_nerd', date: '2026-10-17',
      title: 'A hitter model that cares more about OBP than slugging',
      body: 'Weights: 0.8 WAR per +10 points of OBP, 0.2 per +10 points of SLG, 0.3 per +10 wRC+, minus 0.15 per year over 30. These are my starting guesses, not fitted to anything. If you have a better way to fit them, post it.',
      replies: [],
      votes: 4,
    },
    {
      id: 'd4', demo: true, type: 'model', author: 'demo_war_lab', date: '2026-10-14',
      title: 'My home-made WAR calculator: three inputs, no magic',
      body: 'I wanted a WAR number I could explain to a friend, so mine is only: runs from hitting + runs from fielding + a position adjustment, divided by ten runs per win, minus replacement level. Every piece is a plain stat you can look up. It is rough, and I would rather have a rough number I understand than a precise one I do not.',
      replies: [{ author: 'demo_scorekeeper', date: '2026-10-15', text: 'Ten runs per win is the usual rule of thumb. Worth saying that the exact figure changes a little each season.' }],
      votes: 9,
    },
    {
      id: 'd5', demo: true, type: 'roster', author: 'demo_armchair', date: '2026-10-11',
      title: 'Saltmarsh is over the tax line. What would you cut?',
      body: 'The Herons start the 2027 season well past the demo tax line. I tried trading two mid-priced relievers for one prospect and the payroll bar barely moved. The real savings were in the long contracts of the older hitters. Has anyone found a trade partner that takes them?',
      replies: [],
      votes: 6,
    },
    {
      id: 'd6', demo: true, type: 'fa', author: 'demo_stat_nerd', date: '2026-10-08',
      title: 'Signing a starter: why I took one year instead of five',
      body: 'My age curve says a pitcher this age loses about half a win per year. Five years looked fine in year one and ugly by year four. A one-year deal costs more per year but leaves the books clean for the 2028 class. Run your own numbers in Front Office before you sign anyone long.',
      replies: [{ author: 'demo_war_lab', date: '2026-10-09', text: 'The contract model makes this easy to see. Try moving the age-decline sliders and watch the surplus flip.' }],
      votes: 11,
    },
    {
      id: 'd7', demo: true, type: 'roster', author: 'demo_scorekeeper', date: '2026-10-05',
      title: 'Batting order experiment: best OBP at the top, worst at nine',
      body: 'I sorted my lineup strictly by on-base percentage. It looks odd on the card (a catcher leading off) but the top of the order gets on base a lot. Not claiming it is optimal, just curious what others do.',
      replies: [],
      votes: 3,
    },
  ];

  // Stat glossary. Formulas are the standard published definitions.
  const glossary = [
    { id: 'avg', name: 'AVG', group: 'Hitting', plain: 'Hits divided by at-bats. How often a hitter gets a hit when a walk does not count.', formula: 'AVG = H / AB', adv: 'Ignores walks and treats every hit the same, so it misses most of what makes a hitter valuable. Use it as a starting point, not a verdict.' },
    { id: 'obp', name: 'OBP', group: 'Hitting', plain: 'How often a hitter reaches base safely, counting walks and hit-by-pitches.', formula: 'OBP = (H + BB + HBP) / (AB + BB + HBP + SF)', adv: 'Getting on base is the point of an at-bat, which is why front offices weight OBP above AVG.' },
    { id: 'slg', name: 'SLG', group: 'Hitting', plain: 'Total bases per at-bat. A home run counts four, a single counts one.', formula: 'SLG = TB / AB, where TB = 1B + 2(2B) + 3(3B) + 4(HR)', adv: 'It is not a percentage and can be above 1.000. It measures power, not frequency of contact.' },
    { id: 'ops', name: 'OPS', group: 'Hitting', plain: 'OBP plus SLG. A quick way to put getting on base and power in one number.', formula: 'OPS = OBP + SLG', adv: 'It adds two rates with different denominators and gives them equal weight, though OBP is worth more per point. That flaw is why wOBA exists.' },
    { id: 'iso', name: 'ISO', group: 'Hitting', plain: 'Isolated power: the extra bases a hitter gets beyond singles.', formula: 'ISO = SLG - AVG', adv: 'Separates power from a high batting average, so a slap hitter and a slugger with the same AVG look different.' },
    { id: 'babip', name: 'BABIP', group: 'Hitting', plain: 'Batting average on balls in play. Home runs and strikeouts are removed.', formula: 'BABIP = (H - HR) / (AB - K - HR + SF)', adv: 'Used to spot luck. A hitter far above his usual BABIP may be due for a fall, but speed and contact quality are real reasons it can stay high.' },
    { id: 'woba', name: 'wOBA', group: 'Hitting', plain: 'Weighted on-base average. It counts each way of reaching base by how much it is actually worth in runs.', formula: 'wOBA = (wBB x uBB + wHBP x HBP + w1B x 1B + w2B x 2B + w3B x 3B + wHR x HR) / (AB + BB - IBB + SF + HBP)', adv: 'The weights (the w terms) are recalculated each season from league data, so they are not fixed numbers. The scale is set to look like OBP.' },
    { id: 'wrcplus', name: 'wRC+', group: 'Hitting', plain: 'Total offensive value compared to the league. 100 is average; 120 is 20% better than average.', formula: 'Built from wRC (runs created), then adjusted for park and league and scaled so 100 = league average.', adv: 'The park and league adjustment lets you compare a hitter in a pitcher-friendly park with one in a hitter-friendly park. Derived from wOBA.' },
    { id: 'kpct', name: 'K% and BB%', group: 'Hitting', plain: 'The share of plate appearances that end in a strikeout (K%) or a walk (BB%).', formula: 'K% = K / PA     BB% = BB / PA', adv: 'These stabilize faster than most stats, so a small sample can already tell you something about a hitter\'s approach.' },
    { id: 'era', name: 'ERA', group: 'Pitching', plain: 'Earned runs a pitcher allows per nine innings.', formula: 'ERA = 9 x ER / IP', adv: 'Depends on defense and luck with balls in play, which is why many analysts also look at FIP.' },
    { id: 'whip', name: 'WHIP', group: 'Pitching', plain: 'Walks plus hits allowed per inning. Lower is better.', formula: 'WHIP = (BB + H) / IP', adv: 'A fast read on traffic on the bases. It does not distinguish a single from a home run.' },
    { id: 'fip', name: 'FIP', group: 'Pitching', plain: 'Fielding-independent pitching: an ERA-style number built only from things the pitcher controls.', formula: 'FIP = (13 x HR + 3 x (BB + HBP) - 2 x K) / IP + C', adv: 'C is a constant set each season so league FIP matches league ERA. It leaves out balls in play, so it can differ from a pitcher\'s real results.' },
    { id: 'war', name: 'WAR', group: 'Value', plain: 'Wins Above Replacement: how many wins a player adds compared to a freely available minor-league-level player.', formula: 'No single formula. Hitters: batting + baserunning + fielding + position + replacement level, converted from runs to wins.', adv: 'Baseball Reference, FanGraphs and Baseball Prospectus each calculate it differently, so the same player can have different WAR. Always say which one you mean.' },
    { id: 'xwoba', name: 'xwOBA', group: 'Statcast', plain: 'The wOBA a hitter would be expected to have from the speed and angle of his batted balls, ignoring defense and luck.', formula: 'Model output, not a formula you can compute by hand.', adv: 'When xwOBA is far above wOBA, a hitter may have been unlucky. It comes from Statcast tracking, shown on Baseball Savant.' },
    { id: 'ev', name: 'Exit velocity and launch angle', group: 'Statcast', plain: 'How fast the ball leaves the bat, and the vertical angle it leaves at.', formula: 'Measured by Statcast tracking, not calculated.', adv: 'Hard-hit balls at the right angles become line drives and home runs; the combination matters more than either alone.' },
    { id: 'barrel', name: 'Barrel%', group: 'Statcast', plain: 'The share of batted balls hit with the best mix of speed and angle, the kind that usually turn into extra-base hits.', formula: 'Defined by Statcast with minimum exit velocity and a launch-angle range.', adv: 'Check the current definition on Baseball Savant, because the exact thresholds are set by MLB and described there.' },
    { id: 'oaa', name: 'OAA', group: 'Statcast', plain: 'Outs Above Average: how many outs a fielder saved compared to an average fielder, based on how hard each ball was to reach.', formula: 'Model output from Statcast tracking.', adv: 'It credits difficulty, not just whether a play was made, which is the main improvement over older fielding stats.' },
  ];

  return { teams, seasons, players, byId, seedPosts, glossary, farmLevels: FARM_LEVELS };
})();
