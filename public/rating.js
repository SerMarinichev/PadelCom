// ============================================================================
// Player rating
// ============================================================================
// Deliberately a metric a player can verify by hand, because the first running
// of the tournament produced questions about the results. Anything involving a
// hidden Elo-style adjustment would have made those questions worse, not
// better, so the headline number is simply:
//
//     доля очков = очки игрока ÷ все очки, разыгранные в его матчах
//
// In a 16:8 match everyone in the winning pair banks 16 of the 24 points on the
// table, i.e. 66.7%. Averaged over every game someone has played, that single
// percentage works across formats, across different match lengths, and across
// players who have played a different number of games — which raw point totals
// do not, since they mostly reward whoever turned up most often.
//
// Two data sources feed it:
//   * tournament rounds — rotating partners, so individual contribution comes
//     through strongly once a few rounds have been played;
//   * the Matches section — fixed pairs, so partner effects are baked in. Still
//     counted, but it is the weaker signal of the two.

export const MIN_GAMES_RELIABLE = 5;

const emptyRow = (id) => ({
  id,
  pointsFor: 0, pointsAgainst: 0,
  games: 0, wins: 0, losses: 0, draws: 0,
  tournamentGames: 0, matchGames: 0,
});

function applyGame(row, scored, conceded) {
  row.pointsFor += scored;
  row.pointsAgainst += conceded;
  row.games += 1;
  if (scored > conceded) row.wins += 1;
  else if (scored < conceded) row.losses += 1;
  else row.draws += 1;
}

// ---------------------------------------------------------------------------
// Collect raw totals
// ---------------------------------------------------------------------------
export function collectStats(data, opts = {}) {
  const includeTournaments = opts.includeTournaments !== false;
  const includeMatches = opts.includeMatches !== false;
  const rows = {};
  const ensure = (id) => (rows[id] = rows[id] || emptyRow(id));

  if (includeTournaments) {
    (data.mexicanoTournaments || []).forEach((t) => {
      (t.rounds || []).forEach((round) => {
        (round.matches || []).forEach((m) => {
          if (m.score1 === null || m.score1 === undefined) return;
          if (m.score2 === null || m.score2 === undefined) return;
          const s1 = Number(m.score1) || 0, s2 = Number(m.score2) || 0;
          (m.team1 || []).forEach((id) => { const r = ensure(id); applyGame(r, s1, s2); r.tournamentGames += 1; });
          (m.team2 || []).forEach((id) => { const r = ensure(id); applyGame(r, s2, s1); r.tournamentGames += 1; });
        });
      });
    });
  }

  if (includeMatches) {
    (data.matchRecords || []).forEach((m) => {
      if (m.score1 === null || m.score1 === undefined) return;
      if (m.score2 === null || m.score2 === undefined) return;
      const s1 = Number(m.score1) || 0, s2 = Number(m.score2) || 0;
      if (s1 === 0 && s2 === 0) return;          // nothing was actually played
      (m.participant1 || []).forEach((id) => { const r = ensure(id); applyGame(r, s1, s2); r.matchGames += 1; });
      (m.participant2 || []).forEach((id) => { const r = ensure(id); applyGame(r, s2, s1); r.matchGames += 1; });
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Turn totals into a ranked table
// ---------------------------------------------------------------------------
export function buildRating(data, opts = {}) {
  const rows = collectStats(data, opts);
  const list = Object.values(rows).map((r) => {
    const total = r.pointsFor + r.pointsAgainst;
    return {
      ...r,
      share: total > 0 ? (r.pointsFor / total) * 100 : 0,   // the headline number
      winRate: r.games > 0 ? (r.wins / r.games) * 100 : 0,
      diff: r.pointsFor - r.pointsAgainst,
      reliable: r.games >= (opts.minGames || MIN_GAMES_RELIABLE),
    };
  });

  // Players with too few games are still listed — hiding them invites exactly
  // the "why am I not there" question — but they sort below everyone who has
  // played enough, and are flagged, so a 100% record from one lucky game can't
  // sit on top of the table.
  list.sort((a, b) => {
    if (a.reliable !== b.reliable) return a.reliable ? -1 : 1;
    if (b.share !== a.share) return b.share - a.share;
    if (b.diff !== a.diff) return b.diff - a.diff;
    return b.games - a.games;
  });
  return list;
}

// Short, plain-language explanation of one player's number, so the table can
// show its own arithmetic instead of asking people to trust it.
export function explainRow(row) {
  const total = row.pointsFor + row.pointsAgainst;
  return `${row.pointsFor} из ${total} разыгранных очков в ${row.games} играх`;
}
