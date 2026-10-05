// ============================================================================
// Tournament engine — shared by Mexicano and Americano
// ============================================================================
// Both formats play in pairs and score individually: whatever your pair scores
// in a round is added to your own total. They differ only in how each round's
// pairings are chosen:
//
//   Mexicano  — round 1 is a draw, every round after is seeded from the live
//               standings (ranks 1-4 to court 1, 5-8 to court 2, …), so you end
//               up against people playing at your level that day.
//   Americano — pairings ignore the score entirely and aim for maximum variety:
//               ideally everyone partners everyone exactly once.
//
// On top of that both formats here enforce three things the naive versions get
// wrong: partners and opponents don't repeat while fresh combinations exist,
// rest is shared out strictly evenly, and players can withdraw mid-tournament
// without corrupting the schedule or the table.

export const FORMATS = { MEXICANO: "mexicano", AMERICANO: "americano" };

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// ---------------------------------------------------------------------------
// Who is still in
// ---------------------------------------------------------------------------
// A withdrawal (injury, had to leave) takes a player out of all future rounds
// but keeps every point they already earned — they stay in the table with the
// games they actually played.
export function activePlayerIds(tournament) {
  const out = new Set((tournament.withdrawals || []).map((w) => w.playerId));
  return (tournament.playerIds || []).filter((id) => !out.has(id));
}

// ---------------------------------------------------------------------------
// History: who has already played with and against whom
// ---------------------------------------------------------------------------
export function buildHistory(tournament) {
  const partner = {};   // pairKey -> times they were partners
  const opponent = {};  // pairKey -> times they faced each other
  const sitOuts = {};   // playerId -> rounds sat out
  const lastSat = {};   // playerId -> index of the last round they sat out
  const played = {};    // playerId -> rounds actually on court

  (tournament.playerIds || []).forEach((id) => { sitOuts[id] = 0; played[id] = 0; lastSat[id] = -1; });

  (tournament.rounds || []).forEach((round, ri) => {
    (round.sitting || []).forEach((id) => {
      if (sitOuts[id] === undefined) return;
      sitOuts[id]++;
      lastSat[id] = ri;
    });
    (round.matches || []).forEach((m) => {
      const t1 = m.team1 || [], t2 = m.team2 || [];
      [...t1, ...t2].forEach((id) => { if (played[id] !== undefined) played[id]++; });
      if (t1.length === 2) partner[pairKey(t1[0], t1[1])] = (partner[pairKey(t1[0], t1[1])] || 0) + 1;
      if (t2.length === 2) partner[pairKey(t2[0], t2[1])] = (partner[pairKey(t2[0], t2[1])] || 0) + 1;
      t1.forEach((a) => t2.forEach((b) => { opponent[pairKey(a, b)] = (opponent[pairKey(a, b)] || 0) + 1; }));
    });
  });

  return { partner, opponent, sitOuts, lastSat, played };
}

// ---------------------------------------------------------------------------
// How many can be on court, and who rests
// ---------------------------------------------------------------------------
export function playingCount(totalPlayers, courts) {
  return Math.min(Math.floor(totalPlayers / 4) * 4, courts * 4);
}

// Rest is allocated strictly, not approximately. Everyone with the fewest
// sit-outs so far is a candidate to sit next; ties go to whoever sat longest
// ago. Crucially the score is never consulted — letting points influence rest
// is what makes leaders quietly skip their turn and produces the 1-vs-3 spread
// that a naive implementation ends up with over a long tournament.
export function selectSitters(active, history, courts) {
  const n = active.length;
  const toPlay = playingCount(n, courts);
  const need = n - toPlay;
  if (need <= 0) return [];
  const ranked = [...active].sort((a, b) => {
    const sa = history.sitOuts[a] || 0, sb = history.sitOuts[b] || 0;
    if (sa !== sb) return sa - sb;                         // fewest rests sits next
    const la = history.lastSat[a] ?? -1, lb = history.lastSat[b] ?? -1;
    if (la !== lb) return la - lb;                         // longest since last rest
    return String(a).localeCompare(String(b));             // stable, reproducible
  });
  return ranked.slice(0, need);
}

// ---------------------------------------------------------------------------
// Scoring a proposed set of matches: lower is better
// ---------------------------------------------------------------------------
// A repeated partnership is the thing players notice first, so it costs far
// more than a repeated opponent. Squaring the counts means a third meeting is
// penalised much harder than a second, which spreads repeats out once they
// become unavoidable instead of piling them onto the same two people.
function costOf(matches, history) {
  let cost = 0;
  matches.forEach((m) => {
    const [a, b] = m.team1, [c, d] = m.team2;
    const pc1 = history.partner[pairKey(a, b)] || 0;
    const pc2 = history.partner[pairKey(c, d)] || 0;
    cost += 10 * (pc1 * pc1 + pc2 * pc2);
    [[a, c], [a, d], [b, c], [b, d]].forEach(([x, y]) => {
      const oc = history.opponent[pairKey(x, y)] || 0;
      cost += oc * oc;
    });
  });
  return cost;
}

// The three ways to split four players into two pairs. The seat numbers travel
// with the split: the group arrives in standings order, so g[0] is seed 1 of
// that court, g[1] seed 2 and so on. Recording them on the match means the
// round can show which seed each player was even when repeat-avoidance picked
// a scheme other than the configured one.
function splitsOfFour(g) {
  const [r1, r2, r3, r4] = g;
  return [
    { team1: [r1, r4], team2: [r2, r3], seeds1: [1, 4], seeds2: [2, 3], scheme: "1+4" },
    { team1: [r1, r3], team2: [r2, r4], seeds1: [1, 3], seeds2: [2, 4], scheme: "1+3" },
    { team1: [r1, r2], team2: [r3, r4], seeds1: [1, 2], seeds2: [3, 4], scheme: "1+2" },
  ];
}

// ---------------------------------------------------------------------------
// Mexicano round
// ---------------------------------------------------------------------------
// The standings seeding is the format, so the grouping into fours is fixed:
// ranks 1-4 play court 1, 5-8 court 2, and so on. The only freedom is how each
// four splits into two pairs — so that's where repeats get avoided. The
// configured scheme (1+4 by default) wins whenever it doesn't repeat anything.
function buildMexicanoRound(activePlayers, standings, history, courts, seeding, roundIndex) {
  const sitters = selectSitters(activePlayers.map((p) => p.id), history, courts);
  const sitSet = new Set(sitters);
  const playing = activePlayers.filter((p) => !sitSet.has(p.id));

  let ranked;
  if (roundIndex === 0) {
    ranked = [...playing].sort(() => Math.random() - 0.5);
  } else {
    ranked = [...playing].sort((a, b) => {
      const pa = standings[a.id]?.points || 0, pb = standings[b.id]?.points || 0;
      if (pa !== pb) return pb - pa;
      return String(a.id).localeCompare(String(b.id));
    });
  }

  // Pick the cheapest of the three ways to split one group of four, preferring
  // the configured scheme when nothing repeats either way.
  const bestSplitFor = (group) => {
    const options = splitsOfFour(group).sort((x, y) => {
      if (x.scheme === seeding && y.scheme !== seeding) return -1;
      if (y.scheme === seeding && x.scheme !== seeding) return 1;
      return 0;
    });
    let best = options[0], bestCost = costOf([options[0]], history);
    options.slice(1).forEach((opt) => {
      const c = costOf([opt], history);
      if (c < bestCost) { bestCost = c; best = opt; }
    });
    return { split: best, cost: bestCost };
  };

  let order = ranked.map((p) => p.id);
  const groupsOf = (ids) => {
    const gs = [];
    for (let i = 0; i + 3 < ids.length; i += 4) gs.push(ids.slice(i, i + 4));
    return gs;
  };
  const totalCost = (ids) => groupsOf(ids).reduce((sum, g) => sum + bestSplitFor(g).cost, 0);

  // Strict rank grouping leaves only three pairings per court, so once the same
  // four players meet again a repeat becomes unavoidable — even when plenty of
  // fresh combinations still exist elsewhere. Swapping players whose ranks are
  // close enough to be interchangeable (within three places, so nobody is moved
  // out of their competitive bracket) breaks those forced repeats while leaving
  // the standings-based seeding essentially intact.
  let current = totalCost(order);
  for (let pass = 0; pass < 4 && current > 0; pass++) {
    let improved = false;
    for (let i = 0; i < order.length && !improved; i++) {
      for (let j = i + 1; j < Math.min(order.length, i + 4); j++) {
        if (Math.floor(i / 4) === Math.floor(j / 4)) continue; // same court: splits already cover it
        const candidate = [...order];
        [candidate[i], candidate[j]] = [candidate[j], candidate[i]];
        const c = totalCost(candidate);
        if (c < current) { order = candidate; current = c; improved = true; break; }
      }
    }
    if (!improved) break;
  }

  const matches = groupsOf(order).map((g, idx) => {
    const { split } = bestSplitFor(g);
    return {
      court: idx + 1,
      team1: split.team1, team2: split.team2,
      seeds1: split.seeds1, seeds2: split.seeds2, scheme: split.scheme,
      score1: null, score2: null,
    };
  });
  return { matches, sitting: sitters };
}

// ---------------------------------------------------------------------------
// Americano round
// ---------------------------------------------------------------------------
// No seeding to respect here, so the whole playing set is free to be arranged.
// Finding the arrangement with fewest repeats exactly is a hard combinatorial
// problem, but a few hundred randomised attempts reliably find a zero-repeat
// round while any fresh combination exists, and degrade gracefully after that.
function buildAmericanoRound(activePlayers, history, courts, attempts = 400) {
  const sitters = selectSitters(activePlayers.map((p) => p.id), history, courts);
  const sitSet = new Set(sitters);
  const pool = activePlayers.filter((p) => !sitSet.has(p.id)).map((p) => p.id);

  let best = null, bestCost = Infinity;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const shuffled = [...pool];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const matches = [];
    for (let i = 0; i + 3 < shuffled.length; i += 4) {
      const group = shuffled.slice(i, i + 4);
      let bestSplit = null, bestSplitCost = Infinity;
      splitsOfFour(group).forEach((opt) => {
        const c = costOf([opt], history);
        if (c < bestSplitCost) { bestSplitCost = c; bestSplit = opt; }
      });
      matches.push({ court: matches.length + 1, team1: bestSplit.team1, team2: bestSplit.team2, score1: null, score2: null });
    }
    const cost = costOf(matches, history);
    if (cost < bestCost) { bestCost = cost; best = matches; }
    if (cost === 0) break; // perfect round, no point searching further
  }
  return { matches: best || [], sitting: sitters };
}

export function buildRound(tournament, playersById, standings) {
  const active = activePlayerIds(tournament).map((id) => playersById[id]).filter(Boolean);
  const history = buildHistory(tournament);
  const roundIndex = (tournament.rounds || []).length;
  if (tournament.format === FORMATS.AMERICANO) {
    return buildAmericanoRound(active, history, tournament.courts);
  }
  return buildMexicanoRound(active, standings, history, tournament.courts, tournament.seeding, roundIndex);
}

// ---------------------------------------------------------------------------
// Standings
// ---------------------------------------------------------------------------
export function computeStandings(tournament) {
  const standings = {};
  (tournament.playerIds || []).forEach((id) => {
    standings[id] = { id, points: 0, conceded: 0, played: 0, sitOuts: 0, wins: 0 };
  });
  (tournament.rounds || []).forEach((round) => {
    (round.sitting || []).forEach((id) => { if (standings[id]) standings[id].sitOuts++; });
    (round.matches || []).forEach((m) => {
      if (m.score1 === null || m.score1 === undefined || m.score2 === null || m.score2 === undefined) return;
      const s1 = Number(m.score1) || 0, s2 = Number(m.score2) || 0;
      (m.team1 || []).forEach((id) => {
        if (!standings[id]) return;
        standings[id].points += s1; standings[id].conceded += s2; standings[id].played++;
        if (s1 > s2) standings[id].wins++;
      });
      (m.team2 || []).forEach((id) => {
        if (!standings[id]) return;
        standings[id].points += s2; standings[id].conceded += s1; standings[id].played++;
        if (s2 > s1) standings[id].wins++;
      });
    });
  });
  return standings;
}

export function sortedStandings(standings, nameOf) {
  return Object.values(standings).sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    const da = a.points - a.conceded, db = b.points - b.conceded;
    if (db !== da) return db - da;
    if (b.wins !== a.wins) return b.wins - a.wins;
    return String(nameOf(a.id)).localeCompare(String(nameOf(b.id)));
  });
}

// ---------------------------------------------------------------------------
// How many rounds to play
// ---------------------------------------------------------------------------
// Two different questions depending on the format:
//
//   Americano — how many rounds until everyone has partnered everyone exactly
//               once. Every round creates (playing/4) × 2 partnerships and the
//               full set is C(n,2)/2 matches, which works out to n(n-1)/playing
//               rounds. For 8 players on 2 courts that's the familiar 7.
//
//   Mexicano  — there's no natural end, so the thing worth aligning to is rest:
//               with s people resting each round, rest only comes out exactly
//               level when the round count is a multiple of n/gcd(n, s).
export function recommendedRounds(format, playerCount, courts) {
  const n = playerCount;
  const playing = playingCount(n, courts);
  if (playing < 4) return null;
  const sitters = n - playing;

  if (format === FORMATS.AMERICANO) {
    const full = Math.round((n * (n - 1)) / playing);
    return { rounds: full, reason: "каждый сыграет с каждым в паре ровно один раз" };
  }

  if (sitters === 0) {
    return { rounds: 8, reason: "все играют каждый раунд, отдыха нет — число раундов любое" };
  }
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
  const cycle = n / gcd(n, sitters);          // rounds for rest to come out exactly level
  let r = cycle;
  while (r < 6) r += cycle;                    // aim for a sensible tournament length
  return { rounds: r, reason: `кратно ${cycle} — у всех будет поровну отдыха` };
}

// Does a given round count divide rest evenly?
export function restIsEven(playerCount, courts, rounds) {
  const playing = playingCount(playerCount, courts);
  const sitters = playerCount - playing;
  if (sitters === 0) return true;
  return (rounds * sitters) % playerCount === 0;
}
