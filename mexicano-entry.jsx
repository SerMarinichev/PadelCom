import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  FORMATS, buildRound, computeStandings, sortedStandings, buildHistory,
  activePlayerIds, recommendedRounds, restIsEven, playingCount,
} from "./engine.js";

// ---------- design tokens (kept in sync with the main app) ----------
const C = {
  paper: "#F5F3ED", paperDim: "#EFEDE4", card: "#FFFFFF", ink: "#1A1B1D",
  slate: "#4A4D52", slateFaint: "#8A8D93", rule: "#DFDBCF",
  court: "#2E9E6F", action: "#2F6DB3", rust: "#B5603A",
  positive: "#2E9E6F", negative: "#C0493B",
};
const FONT_DISPLAY = "'Montserrat', sans-serif";
const FONT_BODY = "'PT Sans', system-ui, sans-serif";
const FONT_MONO = "'IBM Plex Mono', ui-monospace, monospace";

const fullName = (p) => [p.firstName, p.lastName].filter(Boolean).join(" ").trim() || "Без имени";
const FORMAT_LABEL = { [FORMATS.MEXICANO]: "Mexicano", [FORMATS.AMERICANO]: "Americano" };

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

// 16px on every field is deliberate: below that iOS Safari zooms the viewport
// on focus and, in standalone mode, frequently fails to zoom back out.
const inputStyle = {
  fontSize: 16, border: `1px solid ${C.rule}`, borderRadius: 7,
  padding: "8px 10px", background: C.paper, fontFamily: FONT_BODY, color: C.ink,
};
const btn = (bg, color = "#fff") => ({
  fontSize: 14, fontWeight: 600, color, background: bg, border: "none",
  borderRadius: 8, padding: "9px 16px", cursor: "pointer",
});

function Avatar({ player, size = 26, dim }) {
  if (!player) return null;
  const initials = `${(player.firstName || "?")[0] || ""}${(player.lastName || "")[0] || ""}`;
  const base = { width: size, height: size, flex: "0 0 auto", borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", opacity: dim ? 0.45 : 1 };
  if (player.photo) return <span style={{ ...base, backgroundImage: `url(${player.photo})`, backgroundSize: "cover", backgroundPosition: "center" }} />;
  return <span style={{ ...base, background: player.gender === "female" ? "#F3DDD5" : "#D8E3F0", color: C.ink, fontSize: size * 0.38, fontWeight: 700 }}>{initials}</span>;
}

// ============================================================================
// Create form
// ============================================================================
function CreateForm({ players, onCreate, onCancel, busy }) {
  const [format, setFormat] = useState(FORMATS.MEXICANO);
  const [name, setName] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [pointsPerMatch, setPointsPerMatch] = useState(24);
  const [courts, setCourts] = useState(1);
  const [seeding, setSeeding] = useState("1+4");
  const [selected, setSelected] = useState([]);
  const [targetRounds, setTargetRounds] = useState("");
  const [touchedRounds, setTouchedRounds] = useState(false);

  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const enough = selected.length >= 4;
  const willPlay = playingCount(selected.length, courts);
  const willSit = selected.length - willPlay;
  const rec = enough ? recommendedRounds(format, selected.length, courts) : null;

  // Keep the round box on the recommendation until the organiser overrides it.
  useEffect(() => {
    if (!touchedRounds && rec) setTargetRounds(String(rec.rounds));
  }, [rec && rec.rounds, touchedRounds]);

  const roundsNum = Number(targetRounds) || 0;
  const evenRest = enough && roundsNum > 0 ? restIsEven(selected.length, courts, roundsNum) : true;

  return (
    <div style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
      <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 16, marginBottom: 14 }}>Новый турнир</div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {[FORMATS.MEXICANO, FORMATS.AMERICANO].map((f) => (
          <button key={f} onClick={() => { setFormat(f); setTouchedRounds(false); }} style={{
            flex: 1, fontSize: 14, fontWeight: 600, padding: "10px 8px", cursor: "pointer", borderRadius: 8,
            background: format === f ? C.court : C.paper, color: format === f ? "#fff" : C.ink,
            border: `1px solid ${format === f ? C.court : C.rule}`,
          }}>{FORMAT_LABEL[f]}</button>
        ))}
      </div>
      <div style={{ fontSize: 12, color: C.slateFaint, marginBottom: 14, lineHeight: 1.45 }}>
        {format === FORMATS.MEXICANO
          ? "Соперников подбирает таблица: чем лучше идёт игра, тем сильнее соперники."
          : "Фиксированная ротация: каждый сыграет в паре с каждым, счёт на состав не влияет."}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
        <div style={{ flex: "1 1 160px" }}>
          <div style={{ fontSize: 11, color: C.slateFaint, marginBottom: 4 }}>Название</div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={FORMAT_LABEL[format]} style={{ ...inputStyle, width: "100%" }} />
        </div>
        <div style={{ flex: "0 0 155px" }}>
          <div style={{ fontSize: 11, color: C.slateFaint, marginBottom: 4 }}>Дата</div>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ ...inputStyle, width: "100%" }} />
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
        <div style={{ flex: "0 0 145px" }}>
          <div style={{ fontSize: 11, color: C.slateFaint, marginBottom: 4 }}>Матч до скольки очков</div>
          <select value={pointsPerMatch} onChange={(e) => setPointsPerMatch(Number(e.target.value))} style={{ ...inputStyle, width: "100%" }}>
            {[12, 16, 20, 24, 28, 32].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div style={{ flex: "0 0 110px" }}>
          <div style={{ fontSize: 11, color: C.slateFaint, marginBottom: 4 }}>Кортов</div>
          <select value={courts} onChange={(e) => { setCourts(Number(e.target.value)); setTouchedRounds(false); }} style={{ ...inputStyle, width: "100%" }}>
            {[1, 2, 3, 4, 5, 6].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        {format === FORMATS.MEXICANO && (
          <div style={{ flex: "0 0 175px" }}>
            <div style={{ fontSize: 11, color: C.slateFaint, marginBottom: 4 }}>Схема пар</div>
            <select value={seeding} onChange={(e) => setSeeding(e.target.value)} style={{ ...inputStyle, width: "100%" }}>
              <option value="1+4">1+4 против 2+3</option>
              <option value="1+3">1+3 против 2+4</option>
            </select>
          </div>
        )}
        <div style={{ flex: "0 0 130px" }}>
          <div style={{ fontSize: 11, color: C.slateFaint, marginBottom: 4 }}>Раундов</div>
          <input type="number" min="1" max="40" value={targetRounds}
            onChange={(e) => { setTouchedRounds(true); setTargetRounds(e.target.value); }}
            style={{ ...inputStyle, width: "100%" }} />
        </div>
      </div>

      {rec && (
        <div style={{ fontSize: 12, color: evenRest ? C.slate : C.rust, background: evenRest ? C.paperDim : `${C.rust}12`, border: `1px solid ${evenRest ? C.rule : C.rust}`, borderRadius: 8, padding: "8px 11px", marginBottom: 12, lineHeight: 1.45 }}>
          Рекомендуется <b>{rec.rounds}</b> — {rec.reason}.
          {!evenRest && roundsNum > 0 && <> При {roundsNum} раундах отдых распределится неравномерно.</>}
        </div>
      )}

      <div style={{ fontSize: 11, color: C.slateFaint, marginBottom: 6 }}>
        Участники — выбрано {selected.length}
        {selected.length > 0 && !enough && <span style={{ color: C.rust }}> · нужно минимум 4</span>}
        {enough && <span> · играют {willPlay}{willSit > 0 ? `, отдыхают ${willSit}` : ""}</span>}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14, maxHeight: 230, overflowY: "auto" }}>
        {players.map((p) => {
          const on = selected.includes(p.id);
          return (
            <button key={p.id} onClick={() => toggle(p.id)} style={{
              display: "flex", alignItems: "center", gap: 6, fontSize: 13,
              background: on ? C.court : C.paper, color: on ? "#fff" : C.ink,
              border: `1px solid ${on ? C.court : C.rule}`, borderRadius: 999,
              padding: "5px 11px", cursor: "pointer",
            }}><Avatar player={p} size={20} /> {fullName(p)}</button>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button disabled={!enough || busy}
          onClick={() => onCreate({ format, name: name.trim() || FORMAT_LABEL[format], date, pointsPerMatch, courts, seeding, playerIds: selected, targetRounds: roundsNum || null })}
          style={{ ...btn(C.court), opacity: !enough || busy ? 0.45 : 1 }}>Создать турнир</button>
        <button onClick={onCancel} style={{ ...btn("none", C.slateFaint), border: `1px solid ${C.rule}` }}>Отмена</button>
      </div>
    </div>
  );
}

// ============================================================================
// Standings
// ============================================================================
function StandingsTable({ tournament, standings, playersById }) {
  const nameOf = (id) => (playersById[id] ? fullName(playersById[id]) : "—");
  const rows = sortedStandings(standings, nameOf);
  const withdrawnIds = new Set((tournament.withdrawals || []).map((w) => w.playerId));
  const reasonOf = (id) => (tournament.withdrawals || []).find((w) => w.playerId === id)?.reason;

  return (
    <div style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", padding: "9px 14px", background: C.paperDim, fontSize: 11, color: C.slateFaint, textTransform: "uppercase", letterSpacing: "0.05em" }}>
        <span style={{ width: 24 }}>#</span>
        <span style={{ flex: 1 }}>Игрок</span>
        <span style={{ width: 50, textAlign: "right" }}>Очки</span>
        <span style={{ width: 44, textAlign: "right" }}>Разн.</span>
        <span style={{ width: 34, textAlign: "right" }}>Игр</span>
        <span style={{ width: 62, textAlign: "right" }}>Пропуск</span>
      </div>
      {rows.map((r, i) => {
        const p = playersById[r.id];
        const out = withdrawnIds.has(r.id);
        return (
          <div key={r.id} style={{ display: "flex", alignItems: "center", padding: "9px 14px", borderTop: `1px solid ${C.rule}`, background: i === 0 && !out ? "#F6FBF8" : C.card, opacity: out ? 0.55 : 1 }}>
            <span style={{ width: 24, fontFamily: FONT_MONO, fontSize: 12.5, color: i === 0 && !out ? C.court : C.slateFaint, fontWeight: i === 0 && !out ? 700 : 400 }}>{i + 1}</span>
            <span style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, minWidth: 0 }}>
              <Avatar player={p} size={24} dim={out} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: out ? "line-through" : "none" }}>
                {p ? fullName(p) : "—"}
              </span>
              {out && <span title={reasonOf(r.id) || "выбыл"} style={{ fontSize: 10, color: C.rust, border: `1px solid ${C.rust}`, borderRadius: 999, padding: "0 6px", flex: "0 0 auto" }}>выбыл</span>}
            </span>
            <span style={{ width: 50, textAlign: "right", fontFamily: FONT_MONO, fontWeight: 700, fontSize: 14 }}>{r.points}</span>
            <span style={{ width: 44, textAlign: "right", fontFamily: FONT_MONO, fontSize: 12, color: r.points - r.conceded >= 0 ? C.positive : C.negative }}>
              {r.points - r.conceded >= 0 ? "+" : ""}{r.points - r.conceded}
            </span>
            <span style={{ width: 34, textAlign: "right", fontFamily: FONT_MONO, fontSize: 12, color: C.slateFaint }}>{r.played}</span>
            <span style={{ width: 62, textAlign: "right", fontFamily: FONT_MONO, fontSize: 12, color: r.sitOuts > 0 ? C.rust : C.slateFaint }}>{r.sitOuts}</span>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// One round
// ============================================================================
function RoundCard({ round, roundIndex, playersById, pointsPerMatch, onScore, canEnter, canEditSaved }) {
  const nameOf = (id) => (playersById[id] ? fullName(playersById[id]) : "—");
  return (
    <div style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 12, padding: 14, marginBottom: 12 }}>
      <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Раунд {roundIndex + 1}</div>
      {round.matches.map((m, mi) => {
        const saved = m.score1 !== null && m.score1 !== undefined && m.score2 !== null && m.score2 !== undefined;
        // Entering a result the first time is part of running the tournament.
        // Changing one that's already recorded is a correction, and corrections
        // are an admin action — otherwise anyone could quietly rewrite history.
        const editable = saved ? canEditSaved : canEnter;
        return (
          <div key={mi} style={{ borderTop: mi === 0 ? "none" : `1px solid ${C.rule}`, paddingTop: mi === 0 ? 0 : 10, marginTop: mi === 0 ? 0 : 10 }}>
            <div style={{ fontSize: 10.5, color: C.slateFaint, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>Корт {m.court}</div>
            {[["team1", "score1", "score2", "seeds1"], ["team2", "score2", "score1", "seeds2"]].map(([team, fld, other, seedKey]) => (
              <div key={fld} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: fld === "score1" ? 6 : 0 }}>
                <span style={{ flex: 1, fontSize: 13.5, fontWeight: saved && Number(m[fld]) > Number(m[other]) ? 700 : 400, display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                  {(m[team] || []).map((pid, k) => {
                    const seed = m[seedKey] ? m[seedKey][k] : null;
                    return (
                      <span key={pid} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        {k > 0 && <span style={{ color: C.slateFaint, marginRight: 1 }}>/</span>}
                        {nameOf(pid)}
                        {/* Seat number within this court's group of four, so the
                            1+4 / 2+3 pairing the schedule used is visible rather
                            than something players have to infer. */}
                        {seed != null && (
                          <span style={{
                            display: "inline-flex", alignItems: "center", justifyContent: "center",
                            width: 17, height: 17, borderRadius: "50%", flex: "0 0 auto",
                            border: `1px solid ${C.slateFaint}`, color: C.slate,
                            fontSize: 10, fontFamily: FONT_MONO, lineHeight: 1,
                          }}>{seed}</span>
                        )}
                      </span>
                    );
                  })}
                </span>
                <input type="number" min="0" max={pointsPerMatch} disabled={!editable}
                  value={m[fld] === null || m[fld] === undefined ? "" : m[fld]}
                  onChange={(e) => onScore(roundIndex, mi, fld, e.target.value)}
                  style={{ ...inputStyle, width: 58, textAlign: "center", fontFamily: FONT_MONO, padding: "6px 4px", opacity: editable ? 1 : 0.6 }} />
              </div>
            ))}
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

// ============================================================================
// Tournament view
// ============================================================================
function TournamentView({ tournament, players, onBack, onUpdate, canEdit, isAdmin }) {
  const [local, setLocal] = useState(tournament);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [withdrawFor, setWithdrawFor] = useState(null);
  const [withdrawReason, setWithdrawReason] = useState("Травма");

  useEffect(() => { setLocal(tournament); }, [tournament.id]);

  const playersById = {};
  players.forEach((p) => { playersById[p.id] = p; });
  const standings = computeStandings(local);
  const active = activePlayerIds(local);
  const history = buildHistory(local);

  const lastRound = local.rounds[local.rounds.length - 1];
  const lastComplete = !lastRound || lastRound.matches.every((m) => m.score1 !== null && m.score1 !== undefined && m.score2 !== null && m.score2 !== undefined);
  const reachedTarget = local.targetRounds ? local.rounds.length >= local.targetRounds : false;
  const tooFewActive = active.length < 4;

  const persist = async (next) => {
    setLocal(next); setBusy(true); setMsg("");
    try {
      await api(`/api/mexicano/${local.id}`, { method: "PUT", body: next });
      onUpdate(next);
    } catch (e) {
      setMsg(e.status === 403 ? "Нужен вход через Telegram или в админ-панель" : `Не сохранилось: ${e.message}`);
    } finally { setBusy(false); }
  };

  const onScore = (ri, mi, field, value) => {
    const total = Number(local.pointsPerMatch) || 0;
    const other = field === "score1" ? "score2" : "score1";
    let v = null, counterpart = null;
    if (value !== "") {
      v = Math.min(Math.max(0, Math.floor(Number(value) || 0)), total);
      counterpart = total - v;
    }
    setLocal({ ...local, rounds: local.rounds.map((r, i) => (i !== ri ? r : {
      ...r, matches: r.matches.map((m, j) => (j !== mi ? m : { ...m, [field]: v, [other]: counterpart })),
    })) });
  };

  const nextRound = () => {
    const round = buildRound(local, playersById, computeStandings(local));
    persist({ ...local, rounds: [...local.rounds, round] });
  };

  const doWithdraw = () => {
    const next = {
      ...local,
      withdrawals: [...(local.withdrawals || []), { playerId: withdrawFor, reason: withdrawReason.trim() || "выбыл", round: local.rounds.length }],
    };
    setWithdrawFor(null); setWithdrawReason("Травма");
    persist(next);
  };
  const undoWithdraw = (pid) => persist({ ...local, withdrawals: (local.withdrawals || []).filter((w) => w.playerId !== pid) });

  const nameOf = (id) => (playersById[id] ? fullName(playersById[id]) : "—");
  const winner = sortedStandings(standings, nameOf)[0];

  return (
    <div>
      <button onClick={onBack} style={{ ...btn("none", C.action), border: "none", padding: "4px 0", marginBottom: 10 }}>← К списку турниров</button>

      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
        <h2 style={{ fontFamily: FONT_DISPLAY, fontSize: 20, margin: 0 }}>{local.name}</h2>
        <span style={{ fontSize: 11, color: C.action, border: `1px solid ${C.action}`, borderRadius: 999, padding: "2px 9px" }}>{FORMAT_LABEL[local.format] || "Mexicano"}</span>
        {local.finished && <span style={{ fontSize: 11, color: C.court, border: `1px solid ${C.court}`, borderRadius: 999, padding: "2px 9px" }}>завершён</span>}
      </div>
      <div style={{ fontSize: 12, color: C.slateFaint, marginBottom: 16, fontFamily: FONT_MONO }}>
        {local.date} · до {local.pointsPerMatch} · кортов {local.courts} · {active.length} в игре
        {local.targetRounds ? ` · раунд ${local.rounds.length}/${local.targetRounds}` : ` · раундов ${local.rounds.length}`}
      </div>

      {local.finished && winner && (
        <div style={{ background: "#F6FBF8", border: `1px solid ${C.court}`, borderRadius: 12, padding: 14, marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: C.slateFaint, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>Победитель</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Avatar player={playersById[winner.id]} size={34} />
            <span style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 17 }}>{nameOf(winner.id)}</span>
            <span style={{ fontFamily: FONT_MONO, fontWeight: 700, fontSize: 17, color: C.court, marginLeft: "auto" }}>{winner.points}</span>
          </div>
        </div>
      )}

      <h3 style={{ fontSize: 12, color: C.slate, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Таблица</h3>
      <StandingsTable tournament={local} standings={standings} playersById={playersById} />

      {canEdit && !local.finished && (
        <div style={{ marginTop: 12, background: C.card, border: `1px solid ${C.rule}`, borderRadius: 12, padding: 13 }}>
          <div style={{ fontSize: 11.5, color: C.slateFaint, marginBottom: 8 }}>Снять игрока с турнира (травма, уход)</div>
          {withdrawFor ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{nameOf(withdrawFor)}</span>
              <input value={withdrawReason} onChange={(e) => setWithdrawReason(e.target.value)} placeholder="Причина"
                style={{ ...inputStyle, flex: "1 1 150px" }} />
              <button onClick={doWithdraw} disabled={busy} style={btn(C.rust)}>Снять</button>
              <button onClick={() => setWithdrawFor(null)} style={{ ...btn("none", C.slateFaint), border: `1px solid ${C.rule}` }}>Отмена</button>
            </div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {active.map((id) => (
                <button key={id} onClick={() => setWithdrawFor(id)} style={{
                  fontSize: 12.5, background: C.paper, color: C.ink, border: `1px solid ${C.rule}`,
                  borderRadius: 999, padding: "5px 11px", cursor: "pointer",
                }}>{nameOf(id)}</button>
              ))}
              {active.length === 0 && <span style={{ fontSize: 12.5, color: C.slateFaint }}>Все игроки сняты.</span>}
            </div>
          )}
          {(local.withdrawals || []).length > 0 && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.rule}` }}>
              {(local.withdrawals || []).map((w) => (
                <div key={w.playerId} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: C.slate, marginBottom: 4 }}>
                  <span style={{ textDecoration: "line-through" }}>{nameOf(w.playerId)}</span>
                  <span style={{ color: C.rust }}>{w.reason}</span>
                  <span style={{ color: C.slateFaint, fontFamily: FONT_MONO, fontSize: 11 }}>с раунда {(w.round || 0) + 1}</span>
                  <button onClick={() => undoWithdraw(w.playerId)} style={{ marginLeft: "auto", fontSize: 11.5, background: "none", border: "none", color: C.action, cursor: "pointer" }}>вернуть</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <h3 style={{ fontSize: 12, color: C.slate, textTransform: "uppercase", letterSpacing: "0.06em", margin: "22px 0 10px" }}>
        Раунды {local.rounds.length > 0 && <span style={{ color: C.slateFaint }}>· {local.rounds.length}</span>}
      </h3>

      {local.rounds.length === 0 && (
        <div style={{ background: C.card, border: `1px dashed ${C.rule}`, borderRadius: 12, padding: 22, textAlign: "center", fontSize: 13.5, color: C.slateFaint, marginBottom: 12 }}>
          Турнир создан. Нажмите «Сформировать раунд» для первой жеребьёвки.
        </div>
      )}

      {local.rounds.map((r, i) => (
        <RoundCard key={i} round={r} roundIndex={i} playersById={playersById}
          pointsPerMatch={local.pointsPerMatch} onScore={onScore}
          canEnter={canEdit && !local.finished} canEditSaved={isAdmin} />
      ))}

      {msg && <div style={{ fontSize: 12.5, color: C.negative, marginBottom: 10 }}>{msg}</div>}

      {canEdit && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14, marginBottom: 30 }}>
          {local.rounds.length > 0 && (
            <button onClick={() => persist(local)} disabled={busy} style={{ ...btn(C.action), opacity: busy ? 0.5 : 1 }}>
              {busy ? "Сохранение…" : "Сохранить счёт"}
            </button>
          )}
          {!local.finished && (
            <button onClick={nextRound} disabled={busy || !lastComplete || tooFewActive}
              title={tooFewActive ? "В игре осталось меньше четырёх" : (!lastComplete ? "Сначала введите счёт всех матчей" : "")}
              style={{ ...btn(reachedTarget ? C.slate : C.court), opacity: busy || !lastComplete || tooFewActive ? 0.45 : 1 }}>
              {reachedTarget ? "Сыграть ещё раунд" : "Сформировать раунд"}
            </button>
          )}
          <button onClick={() => persist({ ...local, finished: !local.finished })} disabled={busy}
            style={{ ...btn("none", local.finished ? C.court : C.slate), border: `1px solid ${C.rule}` }}>
            {local.finished ? "Вернуть в игру" : "Завершить турнир"}
          </button>
        </div>
      )}

      {canEdit && !isAdmin && (
        <div style={{ fontSize: 11.5, color: C.slateFaint, marginBottom: 24, lineHeight: 1.45 }}>
          Исправление уже записанного счёта и удаление турнира доступны только в админ-панели.
        </div>
      )}

      {!canEdit && (
        <div style={{ fontSize: 12.5, color: C.rust, background: `${C.rust}14`, border: `1px solid ${C.rust}`, borderRadius: 10, padding: "9px 12px", marginTop: 14 }}>
          Режим просмотра — чтобы вести турнир, войдите через Telegram в приложении или в админ-панель.
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Root
// ============================================================================
function App() {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = () => {
    fetch("/api/data").then((r) => r.json()).then(setData).catch((e) => setLoadError(String(e)));
    fetch("/api/player/session").then((r) => r.json()).then(setSession).catch(() => setSession({ loggedIn: false }));
    fetch("/api/admin/session").then((r) => r.json()).then((s) => setIsAdmin(!!(s && s.authenticated))).catch(() => setIsAdmin(false));
  };
  useEffect(load, []);

  if (loadError) return <div style={{ padding: 24, fontFamily: FONT_BODY, color: C.negative }}>Не удалось загрузить данные: {loadError}</div>;
  if (!data) return <div style={{ minHeight: "60vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT_DISPLAY, fontSize: 22, color: C.court }}>PadelCom</div>;

  const canEdit = !!(session && session.loggedIn) || isAdmin;
  const players = (data.players || []).slice().sort((a, b) => fullName(a).localeCompare(fullName(b)));
  const tournaments = [...(data.mexicanoTournaments || [])].reverse();
  const open = tournaments.find((t) => t.id === openId);

  const create = async (payload) => {
    setBusy(true);
    try {
      const res = await api("/api/mexicano", { method: "POST", body: payload });
      setCreating(false);
      setData({ ...data, mexicanoTournaments: [...(data.mexicanoTournaments || []), res.tournament] });
      setOpenId(res.tournament.id);
    } catch (e) {
      alert(e.status === 403 ? "Нужен вход через Telegram или в админ-панель" : e.message);
    } finally { setBusy(false); }
  };

  const update = (next) => setData((d) => ({ ...d, mexicanoTournaments: (d.mexicanoTournaments || []).map((t) => (t.id === next.id ? next : t)) }));

  const remove = async (id) => {
    try {
      await api(`/api/mexicano/${id}`, { method: "DELETE" });
      setData((d) => ({ ...d, mexicanoTournaments: (d.mexicanoTournaments || []).filter((t) => t.id !== id) }));
      setConfirmDelete(null);
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
          <span style={{ fontSize: 12, color: C.slateFaint, borderLeft: `1px solid ${C.rule}`, paddingLeft: 10 }}>Турниры</span>
          {isAdmin && <span style={{ fontSize: 10.5, color: C.action, border: `1px solid ${C.action}`, borderRadius: 999, padding: "1px 8px" }}>админ</span>}
        </div>

        {open ? (
          <TournamentView tournament={open} players={players} canEdit={canEdit} isAdmin={isAdmin}
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
              const done = (t.rounds || []).reduce((n, r) => n + r.matches.filter((m) => m.score1 !== null && m.score1 !== undefined).length, 0);
              const out = (t.withdrawals || []).length;
              return (
                <div key={t.id} style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 12, padding: "13px 15px", marginBottom: 10, display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => setOpenId(t.id)}>
                    <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 2, display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                      {t.name}
                      <span style={{ fontSize: 10, fontWeight: 600, color: C.action, border: `1px solid ${C.action}`, borderRadius: 999, padding: "1px 7px" }}>{FORMAT_LABEL[t.format] || "Mexicano"}</span>
                      {t.finished && <span style={{ fontSize: 10, fontWeight: 400, color: C.court, border: `1px solid ${C.court}`, borderRadius: 999, padding: "1px 7px" }}>завершён</span>}
                    </div>
                    <div style={{ fontSize: 12, color: C.slateFaint, fontFamily: FONT_MONO }}>
                      {t.date} · {(t.playerIds || []).length} игроков{out > 0 ? ` (−${out})` : ""} · раундов {(t.rounds || []).length}{t.targetRounds ? `/${t.targetRounds}` : ""} · матчей {done}
                    </div>
                  </div>
                  {/* Deleting a tournament is destructive and permanent, so it is
                      an admin-only action rather than something any player
                      running a match can trigger by mistake. */}
                  {isAdmin && (
                    <button onClick={() => setConfirmDelete(t)} title="Удалить"
                      style={{ background: "none", border: "none", color: C.negative, cursor: "pointer", fontSize: 19, lineHeight: 1, padding: 4 }}>×</button>
                  )}
                </div>
              );
            })}
          </>
        )}

        {confirmDelete && (
          <>
            <div onClick={() => setConfirmDelete(null)} style={{ position: "fixed", inset: 0, zIndex: 900, background: "rgba(26,27,29,0.45)" }} />
            <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 901, background: C.card, borderRadius: 14, padding: 20, width: "min(92vw, 360px)" }}>
              <div style={{ fontSize: 14.5, marginBottom: 6 }}>Удалить турнир «{confirmDelete.name}»?</div>
              <div style={{ fontSize: 12.5, color: C.slateFaint, marginBottom: 16 }}>
                Будут удалены все раунды и результаты. Действие необратимо.
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => remove(confirmDelete.id)} style={{ ...btn(C.negative), flex: 1 }}>Удалить</button>
                <button onClick={() => setConfirmDelete(null)} style={{ ...btn("none", C.slate), border: `1px solid ${C.rule}`, flex: 1 }}>Отмена</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
