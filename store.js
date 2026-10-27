'use strict';
/*
  The only file that touches localStorage. Pages call Store.get() and Store.save().
  To move to a real backend later, replace the inside of load() and save() and nothing else changes.
*/
const Store = (() => {
  const KEY = 'open-front-office.v1';
  let persistent = true;
  let state = null;

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { persistent = false; return null; } // private window or blocked storage: run in memory
  }

  function fresh() {
    const team = {}, lvl = {};
    DATA.players.forEach(p => { if (p.team) team[p.id] = p.team; lvl[p.id] = p.lvl; });
    const s = {
      user: { name: 'guest_gm' },
      teamId: DATA.teams[0].id,
      year: 0,          // index into DATA.seasons
      taxLine: 200,     // $M, fictional demo threshold
      team, lvl,
      card: {},         // per team: { lineup: [9 ids], rotation: [5 ids] }
      moves: [],        // transaction log
      posts: JSON.parse(JSON.stringify(DATA.seedPosts)),
      votes: {},        // postId -> true
      model: null,      // { name, w: {...} }
      csv: {},          // player name -> imported projected WAR
      nextId: 1,
    };
    DATA.teams.forEach(t => fillCard(s, t.id));
    return s;
  }

  // Drops anyone who left the 26-man, then fills empty slots with the best available.
  function fillCard(s, tid) {
    const c = s.card[tid] || (s.card[tid] = { lineup: Array(9).fill(null), rotation: Array(5).fill(null) });
    const onMlb = id => s.team[id] === tid && s.lvl[id] === 'MLB';
    c.lineup = c.lineup.map(id => (id && onMlb(id) && DATA.byId[id].kind === 'H' ? id : null));
    c.rotation = c.rotation.map(id => (id && onMlb(id) && DATA.byId[id].pos === 'SP' ? id : null));
    const mlb = DATA.players.filter(p => onMlb(p.id));
    const hitters = mlb.filter(p => p.kind === 'H' && !c.lineup.includes(p.id)).sort((a, b) => b.s.obp - a.s.obp);
    const starters = mlb.filter(p => p.pos === 'SP' && !c.rotation.includes(p.id)).sort((a, b) => b.war - a.war);
    c.lineup = c.lineup.map(id => id || (hitters.length ? hitters.shift().id : null));
    c.rotation = c.rotation.map(id => id || (starters.length ? starters.shift().id : null));
  }

  return {
    get() {
      if (!state) {
        state = load() || fresh();
        // Starter posts added in later versions reach returning visitors too; their own posts are untouched.
        DATA.seedPosts.forEach(sp => { if (!state.posts.some(p => p.id === sp.id)) state.posts.push(JSON.parse(JSON.stringify(sp))); });
      }
      return state;
    },
    save() {
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { persistent = false; }
    },
    reset() {
      try { localStorage.removeItem(KEY); } catch (e) { /* nothing to remove */ }
      state = fresh();
      this.save();
    },
    fillCard,
    get persistent() { return persistent; },
  };
})();
