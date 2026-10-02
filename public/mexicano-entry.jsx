import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";

// ---------- design tokens (kept in sync with the main app) ----------
const C = {
  paper: "#F5F3ED",
  paperDim: "#EFEDE4",
  card: "#FFFFFF",
  ink: "#1A1B1D",
  slate: "#4A4D52",
  slateFaint: "#8A8D93",
  rule: "#DFDBCF",
  court: "#2E9E6F",
  action: "#2F6DB3",
  rust: "#B5603A",
  positive: "#2E9E6F",
  negative: "#C0493B",
};
const FONT_DISPLAY = "'Montserrat', sans-serif";
const FONT_BODY = "'PT Sans', system-ui, sans-serif";
const FONT_MONO = "'IBM Plex Mono', ui-monospace, monospace";

const fullName = (p) => [p.firstName, p.lastName].filter(Boolean).join(" ").trim() || "Без имени";

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error((json && (json.detail || json.error)) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// ============================================================================
// Mexicano rotation engine
// ============================================================================
// Round 1 is a random draw. Every round after is built from the live standings:
// players are ranked by current personal points, then grouped four at a time —
// ranks 1-4 go to court 1, ranks 5-8 to court 2, and so on. Within each group of
// four the default pairing is 1+4 vs 2+3, which produces the most even match;
// 1+3 vs 2+2 is the other variant organisers use, so it's a setting rather than
// hardcoded. Scoring is personal: whatever your pair scores in a round is added
// to your own total, so your partner changes but the points stay yours.

// How many players can actually be on court this round.
function playingCount(totalPlayers, courts) {
  return Math.min(Math.floor(totalPlayers / 4) * 4, courts * 4);
}

// Who sits this round. Players who have sat out most so far get priority to play,
// so across a tournament the breaks spread evenly instead of landing on the same
// people. Only matters when the squad isn't a clean multiple of four, or when
// there are more players than courts.
function selectPlaying(players, standings, courts) {
  const n = playingCount(players.length, courts);
  if (n === players.length) return { playing: [...players], sitting: [] };
  const ordered = [...players].sort((a, b) => {
    const sa = standings[a.id]?.sitOuts || 0;
    const sb = standings[b.id]?.sitOuts || 0;
    if (sa !== sb) return sb - sa;                       // sat out more -> plays first
    return (standings[b.id]?.points || 0) - (standings[a.id]?.points || 0);
  });
  return { playing: ordered.slice(0, n), sitting: ordered.slice(n) };
}

function buildRound(players, standings, courts, seeding, roundIndex) {
  const { playing, sitting } = selectPlaying(players, standings, courts);

  let ranked;
  if (roundIndex === 0) {
    // Opening draw is random — nobody has a record yet to seed from.
    ranked = [...playing].sort(() => Math.random() - 0.5);
  } else {
    ranked = [...playing].sort((a, b) => {
      const pa = standings[a.id]?.points || 0;
      const pb = standings[b.id]?.points || 0;
      if (pa !== pb) return pb - pa;
      return fullName(a).localeCompare(fullName(b)); // stable, predictable tiebreak
    });
  }

  const matches = [];
  for (let i = 0; i + 3 < ranked.length; i += 4) {
    const [r1, r2, r3, r4] = ranked.slice(i, i + 4);
    const pairing = seeding === "1+3"
      ? { team1: [r1, r3], team2: [r2, r4] }
      : { team1: [r1, r4], team2: [r2, r3] };
    matches.push({
      court: matches.length + 1,
      team1: pairing.team1.map((p) => p.id),
      team2: pairing.team2.map((p) => p.id),
      score1: null,
      score2: null,
    });
  }
  return { matches, sitting: sitting.map((p) => p.id) };
}

// Personal totals rebuilt from scratch off the recorded rounds, so standings can
// never drift out of sync with the scores actually entered.
function computeStandings(tournament, playersById) {
  const standings = {};
  (tournament.playerIds || []).forEach((id) => {
    standings[id] = { id, points: 0, conceded: 0, played: 0, sitOuts: 0, wins: 0 };
  });
  (tournament.rounds || []).forEach((round) => {
    (round.sitting || []).forEach((id) => { if (standings[id]) standings[id].sitOuts++; });
    (round.matches || []).forEach((m) => {
      if (m.score1 === null || m.score2 === null) return;
      const s1 = Number(m.score1) || 0;
      const s2 = Number(m.score2) || 0;
      m.team1.forEach((id) => {
        if (!standings[id]) return;
        standings[id].points += s1;
        standings[id].conceded += s2;
        standings[id].played++;
        if (s1 > s2) standings[id].wins++;
      });
      m.team2.forEach((id) => {
        if (!standings[id]) return;
        standings[id].points += s2;
        standings[id].conceded += s1;
        standings[id].played++;
        if (s2 > s1) standings[id].wins++;
      });
    });
  });
  return standings;
}

function sortedStandings(standings, playersById) {
  return Object.values(standings).sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    const da = a.points - a.conceded;
    const db = b.points - b.conceded;
    if (db !== da) return db - da;                        // point difference
    if (b.wins !== a.wins) return b.wins - a.wins;
    const pa = playersById[a.id], pb = playersById[b.id];
    return fullName(pa || {}).localeCompare(fullName(pb || {}));
  });
}

// ============================================================================
// UI
// ============================================================================
const btn = (bg, color = "#fff") => ({
  fontSize: 13, fontWeight: 600, color, background: bg, border: "none",
  borderRadius: 8, padding: "9px 16px", cursor: "pointer",
});
const inputStyle = {
  fontSize: 14, border: `1px solid ${C.rule}`, borderRadius: 7,
  padding: "8px 10px", background: C.paper, fontFamily: FONT_BODY, color: C.ink,
};

function Avatar({ player, size = 26 }) {
  if (!player) return null;
  const initials = `${(player.firstName || "?")[0] || ""}${(player.lastName || "")[0] || ""}`;
  if (player.photo) {
    return <span style={{ width: size, height: size, flex: "0 0 auto", borderRadius: "50%", backgroundImage: `url(${player.photo})`, backgroundSize: "cover", backgroundPosition: "center", display: "inline-block" }} />;
  }
  return (
    <span style={{ width: size, height: size, flex: "0 0 auto", borderRadius: "50%", background: player.gender === "female" ? "#F3DDD5" : "#D8E3F0", color: C.ink, fontSize: size * 0.38, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{initials}</span>
  );
}

function CreateForm({ players, onCreate, onCancel, busy }) {
  const [name, setName] = useState("Mexicano");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [pointsPerMatch, setPointsPerMatch] = useState(24);
  const [courts, setCourts] = useState(1);
  const [seeding, setSeeding] = useState("1+4");
  const [selected, setSelected] = useState([]);

  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const enough = selected.length >= 4;
  const willPlay = playingCount(selected.length, courts);
  const willSit = selected.length - willPlay;

  return (
    <div style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
      <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 16, marginBottom: 14 }}>Новый турнир Mexicano</div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
        <div style={{ flex: "1 1 160px" }}>
          <div style={{ fontSize: 11, color: C.slateFaint, marginBottom: 4 }}>Название</div>
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ ...inputStyle, width: "100%" }} />
        </div>
        <div style={{ flex: "0 0 150px" }}>
          <div style={{ fontSize: 11, color: C.slateFaint, marginBottom: 4 }}>Дата</div>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ ...inputStyle, width: "100%" }} />
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
        <div style={{ flex: "0 0 140px" }}>
          <div style={{ fontSize: 11, color: C.slateFaint, marginBottom: 4 }}>Матч до скольки очков</div>
          <select value={pointsPerMatch} onChange={(e) => setPointsPerMatch(Number(e.target.value))} style={{ ...inputStyle, width: "100%" }}>
            {/* Multiples of 4 only: service rotates every 2 or 4 points, so a target
                divisible by 4 gives all four players an equal number of serves —
                and keeps a draw (12:12 at 24) a reachable, legitimate result. */}
            {[12, 16, 20, 24, 28, 32].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div style={{ flex: "0 0 110px" }}>
          <div style={{ fontSize: 11, color: C.slateFaint, marginBottom: 4 }}>Кортов</div>
          <select value={courts} onChange={(e) => setCourts(Number(e.target.value))} style={{ ...inputStyle, width: "100%" }}>
            {[1, 2, 3, 4, 5, 6].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div style={{ flex: "0 0 170px" }}>
          <div style={{ fontSize: 11, color: C.slateFaint, marginBottom: 4 }}>Схема пар</div>
          <select value={seeding} onChange={(e) => setSeeding(e.target.value)} style={{ ...inputStyle, width: "100%" }}>
            <option value="1+4">1+4 против 2+3</option>
            <option value="1+3">1+3 против 2+4</option>
          </select>
        </div>
      </div>

      <div style={{ fontSize: 11, color: C.slateFaint, marginBottom: 6 }}>
        Участники — выбрано {selected.length}
        {selected.length > 0 && !enough && <span style={{ color: C.rust }}> · нужно минимум 4</span>}
        {enough && <span> · играют {willPlay}{willSit > 0 ? `, отдыхают ${willSit}` : ""}</span>}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14, maxHeight: 220, overflowY: "auto" }}>
        {players.map((p) => {
          const on = selected.includes(p.id);
          return (
            <button key={p.id} onClick={() => toggle(p.id)} style={{
              display: "flex", alignItems: "center", gap: 6, fontSize: 12.5,
              background: on ? C.court : C.paper, color: on ? "#fff" : C.ink,
              border: `1px solid ${on ? C.court : C.rule}`, borderRadius: 999,
              padding: "5px 11px", cursor: "pointer",
            }}>
              <Avatar player={p} size={20} /> {fullName(p)}
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button disabled={!enough || busy} onClick={() => onCreate({ name, date, pointsPerMatch, courts, seeding, playerIds: selected })}
          style={{ ...btn(C.court), opacity: !enough || busy ? 0.45 : 1 }}>Создать турнир</button>
        <button onClick={onCancel} style={{ ...btn("none", C.slateFaint), border: `1px solid ${C.rule}` }}>Отмена</button>
      </div>
    </div>
  );
}

function StandingsTable({ standings, playersById }) {
  const rows = sortedStandings(standings, playersById);
  return (
    <div style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", padding: "9px 14px", background: C.paperDim, fontSize: 11, color: C.slateFaint, textTransform: "uppercase", letterSpacing: "0.05em" }}>
        <span style={{ width: 26 }}>#</span>
        <span style={{ flex: 1 }}>Игрок</span>
        <span style={{ width: 52, textAlign: "right" }}>Очки</span>
        <span style={{ width: 46, textAlign: "right" }}>Разн.</span>
        <span style={{ width: 40, textAlign: "right" }}>Игр</span>
      </div>
      {rows.map((r, i) => {
        const p = playersById[r.id];
        return (
          <div key={r.id} style={{ display: "flex", alignItems: "center", padding: "9px 14px", borderTop: `1px solid ${C.rule}`, background: i === 0 ? "#F6FBF8" : C.card }}>
            <span style={{ width: 26, fontFamily: FONT_MONO, fontSize: 12.5, color: i === 0 ? C.court : C.slateFaint, fontWeight: i === 0 ? 700 : 400 }}>{i + 1}</span>
            <span style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, minWidth: 0 }}>
              <Avatar player={p} size={24} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p ? fullName(p) : "—"}</span>
            </span>
            <span style={{ width: 52, textAlign: "right", fontFamily: FONT_MONO, fontWeight: 700, fontSize: 14 }}>{r.points}</span>
            <span style={{ width: 46, textAlign: "right", fontFamily: FONT_MONO, fontSize: 12, color: r.points - r.conceded >= 0 ? C.positive : C.negative }}>
              {r.points - r.conceded >= 0 ? "+" : ""}{r.points - r.conceded}
            </span>
            <span style={{ width: 40, textAlign: "right", fontFamily: FONT_MONO, fontSize: 12, color: C.slateFaint }}>{r.played}</span>
          </div>
        );
      })}
    </div>
  );
}

function RoundCard({ round, roundIndex, playersById, pointsPerMatch, onScore, editable }) {
  const nameOf = (id) => (playersById[id] ? fullName(playersById[id]) : "—");
  return (
    <div style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 12, padding: 14, marginBottom: 12 }}>
      <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Раунд {roundIndex + 1}</div>
      {round.matches.map((m, mi) => {
        const done = m.score1 !== null && m.score2 !== null;
        return (
          <div key={mi} style={{ borderTop: mi === 0 ? "none" : `1px solid ${C.rule}`, paddingTop: mi === 0 ? 0 : 10, marginTop: mi === 0 ? 0 : 10 }}>
            <div style={{ fontSize: 10.5, color: C.slateFaint, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>Корт {m.court}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span style={{ flex: 1, fontSize: 13.5, fontWeight: done && m.score1 > m.score2 ? 700 : 400 }}>
                {m.team1.map(nameOf).join(" / ")}
              </span>
              <input type="number" min="0" max={pointsPerMatch} disabled={!editable}
                value={m.score1 === null ? "" : m.score1}
                onChange={(e) => onScore(roundIndex, mi, "score1", e.target.value)}
                style={{ ...inputStyle, width: 56, textAlign: "center", fontFamily: FONT_MONO, padding: "6px 4px" }} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ flex: 1, fontSize: 13.5, fontWeight: done && m.score2 > m.score1 ? 700 : 400 }}>
                {m.team2.map(nameOf).join(" / ")}
              </span>
              <input type="number" min="0" max={pointsPerMatch} disabled={!editable}
                value={m.score2 === null ? "" : m.score2}
                onChange={(e) => onScore(roundIndex, mi, "score2", e.target.value)}
                style={{ ...inputStyle, width: 56, textAlign: "center", fontFamily: FONT_MONO, padding: "6px 4px" }} />
            </div>
          </div>
        );
      })}
      {round.sitting && round.sitting.length > 0 && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.rule}`, fontSize: 11.5, color: C.slateFaint }}>
          Отдыхают: {round.sitting.map(nameOf).join(", ")}
        </div>
      )}
    </div>
  );
}

function TournamentView({ tournament, players, onBack, onUpdate, canEdit }) {
  const [local, setLocal] = useState(tournament);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => { setLocal(tournament); }, [tournament.id]);

  const playersById = {};
  players.forEach((p) => { playersById[p.id] = p; });
  const roster = (local.playerIds || []).map((id) => playersById[id]).filter(Boolean);
  const standings = computeStandings(local, playersById);

  const lastRound = local.rounds[local.rounds.length - 1];
  const lastComplete = !lastRound || lastRound.matches.every((m) => m.score1 !== null && m.score2 !== null);

  const persist = async (next) => {
    setLocal(next);
    setBusy(true);
    setMsg("");
    try {
      await api(`/api/mexicano/${local.id}`, { method: "PUT", body: next });
      onUpdate(next);
    } catch (e) {
      setMsg(e.status === 403 ? "Нужен вход через Telegram" : `Не сохранилось: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  // Every match runs to a fixed total, so one side's score fully determines the
  // other: typing 16 in a race to 24 means the opponents got 8. Filling the
  // second box automatically removes half the taps on court and makes it
  // impossible to record a pair of scores that don't add up. Typing into either
  // box recalculates the other, so a correction works from whichever side is
  // more natural; clearing a box clears both.
  const onScore = (ri, mi, field, value) => {
    const total = Number(local.pointsPerMatch) || 0;
    const other = field === "score1" ? "score2" : "score1";

    let v = null;
    let counterpart = null;
    if (value !== "") {
      v = Math.min(Math.max(0, Math.floor(Number(value) || 0)), total);
      counterpart = total - v;
    }

    const next = { ...local, rounds: local.rounds.map((r, i) => (i !== ri ? r : {
      ...r, matches: r.matches.map((m, j) => (j !== mi ? m : { ...m, [field]: v, [other]: counterpart })),
    })) };
    setLocal(next); // keep typing responsive; persisted via the explicit save button
  };

  const saveScores = () => persist(local);

  const nextRound = () => {
    const round = buildRound(roster, computeStandings(local, playersById), local.courts, local.seeding, local.rounds.length);
    persist({ ...local, rounds: [...local.rounds, round] });
  };

  const finish = () => persist({ ...local, finished: !local.finished });

  const winner = sortedStandings(standings, playersById)[0];

  return (
    <div>
      <button onClick={onBack} style={{ ...btn("none", C.action), border: "none", padding: "4px 0", marginBottom: 10 }}>← К списку турниров</button>

      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
        <h2 style={{ fontFamily: FONT_DISPLAY, fontSize: 20, margin: 0 }}>{local.name}</h2>
        {local.finished && <span style={{ fontSize: 11, color: C.court, border: `1px solid ${C.court}`, borderRadius: 999, padding: "2px 9px" }}>завершён</span>}
      </div>
      <div style={{ fontSize: 12, color: C.slateFaint, marginBottom: 16, fontFamily: FONT_MONO }}>
        {local.date} · до {local.pointsPerMatch} очков · кортов: {local.courts} · {roster.length} игроков · схема {local.seeding === "1+3" ? "1+3 / 2+4" : "1+4 / 2+3"}
      </div>

      {local.finished && winner && (
        <div style={{ background: "#F6FBF8", border: `1px solid ${C.court}`, borderRadius: 12, padding: 14, marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: C.slateFaint, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>Победитель</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Avatar player={playersById[winner.id]} size={34} />
            <span style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 17 }}>{playersById[winner.id] ? fullName(playersById[winner.id]) : "—"}</span>
            <span style={{ fontFamily: FONT_MONO, fontWeight: 700, fontSize: 17, color: C.court, marginLeft: "auto" }}>{winner.points}</span>
          </div>
        </div>
      )}

      <h3 style={{ fontSize: 12, color: C.slate, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Таблица</h3>
      <StandingsTable standings={standings} playersById={playersById} />

      <h3 style={{ fontSize: 12, color: C.slate, textTransform: "uppercase", letterSpacing: "0.06em", margin: "22px 0 10px" }}>
        Раунды {local.rounds.length > 0 && <span style={{ color: C.slateFaint }}>· {local.rounds.length}</span>}
      </h3>

      {local.rounds.length === 0 && (
        <div style={{ background: C.card, border: `1px dashed ${C.rule}`, borderRadius: 12, padding: 22, textAlign: "center", fontSize: 13.5, color: C.slateFaint, marginBottom: 12 }}>
          Турнир создан. Нажмите «Сформировать раунд», чтобы сделать первую жеребьёвку.
        </div>
      )}

      {local.rounds.map((r, i) => (
        <RoundCard key={i} round={r} roundIndex={i} playersById={playersById}
          pointsPerMatch={local.pointsPerMatch} onScore={onScore} editable={canEdit && !local.finished} />
      ))}

      {msg && <div style={{ fontSize: 12.5, color: C.negative, marginBottom: 10 }}>{msg}</div>}

      {canEdit && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14, marginBottom: 30 }}>
          {!local.finished && local.rounds.length > 0 && (
            <button onClick={saveScores} disabled={busy} style={{ ...btn(C.action), opacity: busy ? 0.5 : 1 }}>
              {busy ? "Сохранение…" : "Сохранить счёт"}
            </button>
          )}
          {!local.finished && (
            <button onClick={nextRound} disabled={busy || !lastComplete}
              title={!lastComplete ? "Сначала введите счёт всех матчей текущего раунда" : ""}
              style={{ ...btn(C.court), opacity: busy || !lastComplete ? 0.45 : 1 }}>
              Сформировать раунд
            </button>
          )}
          <button onClick={finish} disabled={busy} style={{ ...btn("none", local.finished ? C.court : C.slate), border: `1px solid ${C.rule}` }}>
            {local.finished ? "Вернуть в игру" : "Завершить турнир"}
          </button>
        </div>
      )}
      {!canEdit && (
        <div style={{ fontSize: 12.5, color: C.rust, background: `${C.rust}14`, border: `1px solid ${C.rust}`, borderRadius: 10, padding: "9px 12px", marginTop: 14 }}>
          Режим просмотра — войдите через Telegram в основном приложении, чтобы вести турнир.
        </div>
      )}
    </div>
  );
}

function App() {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState(null);

  const load = () => {
    fetch("/api/data").then((r) => r.json()).then(setData).catch((e) => setLoadError(String(e)));
    fetch("/api/player/session").then((r) => r.json()).then(setSession).catch(() => setSession({ loggedIn: false }));
  };
  useEffect(load, []);

  if (loadError) return <div style={{ padding: 24, fontFamily: FONT_BODY, color: C.negative }}>Не удалось загрузить данные: {loadError}</div>;
  if (!data) return <div style={{ minHeight: "60vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT_DISPLAY, fontSize: 22, color: C.court }}>PadelCom</div>;

  const canEdit = !!(session && session.loggedIn);
  const players = (data.players || []).slice().sort((a, b) => fullName(a).localeCompare(fullName(b)));
  const tournaments = [...(data.mexicanoTournaments || [])].reverse();
  const open = tournaments.find((t) => t.id === openId);

  const create = async (payload) => {
    setBusy(true);
    try {
      const res = await api("/api/mexicano", { method: "POST", body: payload });
      setCreating(false);
      const next = { ...data, mexicanoTournaments: [...(data.mexicanoTournaments || []), res.tournament] };
      setData(next);
      setOpenId(res.tournament.id);
    } catch (e) {
      alert(e.status === 403 ? "Нужен вход через Telegram в основном приложении" : e.message);
    } finally { setBusy(false); }
  };

  const update = (next) => {
    setData((d) => ({ ...d, mexicanoTournaments: (d.mexicanoTournaments || []).map((t) => (t.id === next.id ? next : t)) }));
  };

  const remove = async (id) => {
    if (!confirm("Удалить этот турнир? Действие необратимо.")) return;
    try {
      await api(`/api/mexicano/${id}`, { method: "DELETE" });
      setData((d) => ({ ...d, mexicanoTournaments: (d.mexicanoTournaments || []).filter((t) => t.id !== id) }));
      setOpenId(null);
    } catch (e) { alert(e.message); }
  };

  return (
    <div style={{ fontFamily: FONT_BODY, color: C.ink, background: C.paper, minHeight: "100vh" }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "18px 16px 40px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
          <a href="/" style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 22, color: C.ink, textDecoration: "none" }}>
            Padel<span style={{ color: C.court }}>Com</span>
          </a>
          <span style={{ fontSize: 12, color: C.slateFaint, borderLeft: `1px solid ${C.rule}`, paddingLeft: 10 }}>Mexicano</span>
        </div>

        {open ? (
          <TournamentView tournament={open} players={players} canEdit={canEdit}
            onBack={() => setOpenId(null)} onUpdate={update} />
        ) : (
          <>
            {canEdit && !creating && (
              <button onClick={() => setCreating(true)} style={{ ...btn(C.ink), width: "100%", marginBottom: 16 }}>+ Новый турнир</button>
            )}
            {creating && <CreateForm players={players} onCreate={create} onCancel={() => setCreating(false)} busy={busy} />}

            {tournaments.length === 0 && !creating && (
              <div style={{ background: C.card, border: `1px dashed ${C.rule}`, borderRadius: 12, padding: 26, textAlign: "center", fontSize: 13.5, color: C.slateFaint }}>
                Турниров пока нет.
              </div>
            )}

            {tournaments.map((t) => {
              const done = (t.rounds || []).reduce((n, r) => n + r.matches.filter((m) => m.score1 !== null).length, 0);
              return (
                <div key={t.id} style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 12, padding: "13px 15px", marginBottom: 10, display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => setOpenId(t.id)}>
                    <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 2 }}>
                      {t.name} {t.finished && <span style={{ fontSize: 10.5, fontWeight: 400, color: C.court, border: `1px solid ${C.court}`, borderRadius: 999, padding: "1px 8px", marginLeft: 4 }}>завершён</span>}
                    </div>
                    <div style={{ fontSize: 12, color: C.slateFaint, fontFamily: FONT_MONO }}>
                      {t.date} · {(t.playerIds || []).length} игроков · раундов: {(t.rounds || []).length} · матчей сыграно: {done}
                    </div>
                  </div>
                  {canEdit && (
                    <button onClick={() => remove(t.id)} title="Удалить"
                      style={{ background: "none", border: "none", color: C.negative, cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 4 }}>×</button>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
