import React, { useState, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  FORMATS, buildRound, computeStandings, sortedStandings, buildHistory,
  activePlayerIds, recommendedRounds, restIsEven, playingCount, joinBaselineSitOuts,
} from "./engine.js";
import { computePCR } from "./pcr.js";

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

// Отметки времени приходят с сервера в UTC — показываем в ташкентском поясе,
// иначе вечерний турнир выглядел бы сыгранным днём.
const TZ = "Asia/Tashkent";
const fmtDateTime = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return d.toLocaleString("ru-RU", {
    timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
};
const fmtTime = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return d.toLocaleTimeString("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
};

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
function CreateForm({ players, teams, venues, onCreate, onCancel, busy }) {
  const [format, setFormat] = useState(FORMATS.MEXICANO);
  const [name, setName] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [pointsPerMatch, setPointsPerMatch] = useState(24);
  const [courts, setCourts] = useState(1);
  const [seeding, setSeeding] = useState("1+4");
  const [selected, setSelected] = useState([]);
  const [targetRounds, setTargetRounds] = useState("");
  const [touchedRounds, setTouchedRounds] = useState(false);
  const [teamId, setTeamId] = useState("");
  const [venueId, setVenueId] = useState("");
  const [manual, setManual] = useState(false);
  const [startTime, setStartTime] = useState("");

  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  // A team is a roster filter over the general player list, nothing more: the
  // organiser still ticks who actually turned up. Picking a team never drops
  // anyone already selected — those stay in the tournament and are counted in
  // the "ещё N вне команды" note below, so nobody vanishes silently.
  const team = teams.find((t) => t.id === teamId) || null;
  const teamIdSet = team ? new Set(team.playerIds || []) : null;
  const visiblePlayers = teamIdSet ? players.filter((p) => teamIdSet.has(p.id)) : players;
  const hiddenSelected = selected.filter((id) => !visiblePlayers.some((p) => p.id === id)).length;
  const allVisibleOn = visiblePlayers.length > 0 && visiblePlayers.every((p) => selected.includes(p.id));
  const toggleAllVisible = () => setSelected((s) => (
    allVisibleOn
      ? s.filter((id) => !visiblePlayers.some((p) => p.id === id))
      : [...new Set([...s, ...visiblePlayers.map((p) => p.id)])]
  ));
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

      {/* Турнир задним числом: составы раундов вводятся вручную, поэтому
          рекомендация по числу раундов и схема посева здесь ни на что не влияют. */}
      <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, cursor: "pointer", fontSize: 13 }}>
        <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)}
          style={{ width: 17, height: 17, accentColor: C.action }} />
        <span>Турнир задним числом — раунды заполню вручную</span>
      </label>

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
        <div style={{ flex: "0 0 150px" }}>
          <div style={{ fontSize: 11, color: C.slateFaint, marginBottom: 4 }}>Дата</div>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ ...inputStyle, width: "100%" }} />
        </div>
        <div style={{ flex: "0 0 110px" }}>
          <div style={{ fontSize: 11, color: C.slateFaint, marginBottom: 4 }}>Время</div>
          <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} style={{ ...inputStyle, width: "100%" }} />
        </div>
        <div style={{ flex: "1 1 200px" }}>
          <div style={{ fontSize: 11, color: C.slateFaint, marginBottom: 4 }}>Объект</div>
          <select value={venueId} onChange={(e) => setVenueId(e.target.value)} style={{ ...inputStyle, width: "100%" }}>
            <option value="">Не указан</option>
            {venues.map((v) => <option key={v.id} value={v.id}>{v.name || "Без названия"}</option>)}
          </select>
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

      {teams.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 10, marginBottom: 12 }}>
          <div style={{ flex: "1 1 200px" }}>
            <div style={{ fontSize: 11, color: C.slateFaint, marginBottom: 4 }}>Команда</div>
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)} style={{ ...inputStyle, width: "100%" }}>
              <option value="">Все игроки</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>{t.name} ({(t.playerIds || []).length})</option>
              ))}
            </select>
          </div>
          {team && (
            <button onClick={toggleAllVisible} style={{ ...btn("none", C.action), border: `1px solid ${C.rule}`, padding: "9px 14px" }}>
              {allVisibleOn ? "Снять всех" : `Выбрать всех (${visiblePlayers.length})`}
            </button>
          )}
        </div>
      )}

      <div style={{ fontSize: 11, color: C.slateFaint, marginBottom: 6 }}>
        Участники — выбрано {selected.length}
        {selected.length > 0 && !enough && <span style={{ color: C.rust }}> · нужно минимум 4</span>}
        {enough && <span> · играют {willPlay}{willSit > 0 ? `, отдыхают ${willSit}` : ""}</span>}
        {team && hiddenSelected > 0 && <span style={{ color: C.action }}> · ещё {hiddenSelected} вне команды</span>}
      </div>
      {team && visiblePlayers.length === 0 && (
        <div style={{ fontSize: 12.5, color: C.rust, marginBottom: 14 }}>В команде «{team.name}» пока нет игроков.</div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14, maxHeight: 230, overflowY: "auto" }}>
        {visiblePlayers.map((p) => {
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
          onClick={() => onCreate({ format, name: name.trim() || FORMAT_LABEL[format], date, startTime: startTime || null, venueId: venueId || null, manual, pointsPerMatch, courts, seeding, playerIds: selected, targetRounds: roundsNum || null })}
          style={{ ...btn(C.court), opacity: !enough || busy ? 0.45 : 1 }}>{manual ? "Создать и заполнить" : "Создать турнир"}</button>
        <button onClick={onCancel} style={{ ...btn("none", C.slateFaint), border: `1px solid ${C.rule}` }}>Отмена</button>
      </div>
    </div>
  );
}

// ============================================================================
// Standings
// ============================================================================
// Раскладка выступления одного игрока внутри турнира: что было в каждом
// раунде и как накапливался счёт. Считается из самих раундов, а не из итоговой
// таблицы, — поэтому расхождения между раскрытой строкой и строкой итога
// невозможны по построению.
function playerTournamentBreakdown(tournament, playerId) {
  const entries = [];
  let scored = 0, conceded = 0, wins = 0, losses = 0, draws = 0, sitOuts = 0;
  (tournament.rounds || []).forEach((round, ri) => {
    const match = (round.matches || []).find((m) => [...(m.team1 || []), ...(m.team2 || [])].includes(playerId));
    if (!match) {
      if ((round.sitting || []).includes(playerId)) {
        sitOuts += 1;
        entries.push({ round: ri + 1, rested: true, scored, conceded });
      }
      return;
    }
    const mine = (match.team1 || []).includes(playerId) ? match.team1 : match.team2;
    const theirs = (match.team1 || []).includes(playerId) ? match.team2 : match.team1;
    const my = (match.team1 || []).includes(playerId) ? match.score1 : match.score2;
    const their = (match.team1 || []).includes(playerId) ? match.score2 : match.score1;
    const played = my !== null && my !== undefined && their !== null && their !== undefined;
    if (played) {
      scored += Number(my); conceded += Number(their);
      if (Number(my) > Number(their)) wins += 1;
      else if (Number(my) < Number(their)) losses += 1;
      else draws += 1;
    }
    entries.push({
      round: ri + 1, rested: false, played,
      partner: (mine || []).find((x) => x !== playerId) || null,
      opponents: theirs || [],
      my: played ? Number(my) : null,
      their: played ? Number(their) : null,
      scored, conceded,
    });
  });
  const games = wins + losses + draws;
  return {
    entries, scored, conceded, wins, losses, draws, games, sitOuts,
    perGame: games ? scored / games : 0,
    concededPerGame: games ? conceded / games : 0,
    share: scored + conceded ? (scored / (scored + conceded)) * 100 : 0,
  };
}

function StandingsTable({ tournament, standings, playersById }) {
  const [open, setOpen] = useState(null);
  const nameOf = (id) => (playersById[id] ? fullName(playersById[id]) : "—");
  const rows = sortedStandings(standings, nameOf);
  const withdrawnIds = new Set((tournament.withdrawals || []).map((w) => w.playerId));
  const reasonOf = (id) => (tournament.withdrawals || []).find((w) => w.playerId === id)?.reason;
  const joinedAtRound = {};
  (tournament.joins || []).forEach((j) => { if (j && j.playerId) joinedAtRound[j.playerId] = j.round; });

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
        const isOpen = open === r.id;
        const br = isOpen ? playerTournamentBreakdown(tournament, r.id) : null;
        const peak = br ? Math.max(1, ...br.entries.filter((e) => e.played).map((e) => Math.max(e.my, e.their))) : 1;
        return (
          <div key={r.id}>
          <div onClick={() => setOpen(isOpen ? null : r.id)} style={{ display: "flex", alignItems: "center", padding: "9px 14px", borderTop: `1px solid ${C.rule}`, background: isOpen ? C.paperDim : (i === 0 && !out ? "#F6FBF8" : C.card), opacity: out ? 0.55 : 1, cursor: "pointer" }}>
            <span style={{ width: 24, fontFamily: FONT_MONO, fontSize: 12.5, color: i === 0 && !out ? C.court : C.slateFaint, fontWeight: i === 0 && !out ? 700 : 400 }}>{i + 1}</span>
            <span style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, minWidth: 0 }}>
              <Avatar player={p} size={24} dim={out} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: out ? "line-through" : "none" }}>
                {p ? fullName(p) : "—"}
              </span>
              {out && <span title={reasonOf(r.id) || "выбыл"} style={{ fontSize: 10, color: C.rust, border: `1px solid ${C.rust}`, borderRadius: 999, padding: "0 6px", flex: "0 0 auto" }}>выбыл</span>}
              {!out && joinedAtRound[r.id] !== undefined && joinedAtRound[r.id] > 0 && (
                <span title={`Вступил в турнир с раунда ${joinedAtRound[r.id] + 1}`} style={{ fontSize: 10, color: C.action, border: `1px solid ${C.action}`, borderRadius: 999, padding: "0 6px", flex: "0 0 auto" }}>
                  с р.{joinedAtRound[r.id] + 1}
                </span>
              )}
            </span>
            <span style={{ width: 50, textAlign: "right", fontFamily: FONT_MONO, fontWeight: 700, fontSize: 14 }}>{r.points}</span>
            <span style={{ width: 44, textAlign: "right", fontFamily: FONT_MONO, fontSize: 12, color: r.points - r.conceded >= 0 ? C.positive : C.negative }}>
              {r.points - r.conceded >= 0 ? "+" : ""}{r.points - r.conceded}
            </span>
            <span style={{ width: 34, textAlign: "right", fontFamily: FONT_MONO, fontSize: 12, color: C.slateFaint }}>{r.played}</span>
            <span style={{ width: 62, textAlign: "right", fontFamily: FONT_MONO, fontSize: 12, color: r.sitOuts > 0 ? C.rust : C.slateFaint }}>{r.sitOuts}</span>
          </div>

          {isOpen && br && (
            <div style={{ padding: "12px 14px 14px", background: C.paperDim, borderTop: `1px solid ${C.rule}` }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 12 }}>
                {[
                  ["Забито", br.scored, C.ink],
                  ["Пропущено", br.conceded, C.slate],
                  ["Разница", `${br.scored - br.conceded >= 0 ? "+" : ""}${br.scored - br.conceded}`, br.scored - br.conceded >= 0 ? C.positive : C.negative],
                  ["За игру", br.perGame.toFixed(1), C.ink],
                  ["Доля очков", `${br.share.toFixed(1)}%`, C.ink],
                  ["Баланс", `${br.wins}–${br.losses}${br.draws ? `–${br.draws}` : ""}`, C.slate],
                ].map(([label, value, color]) => (
                  <div key={label} style={{ minWidth: 68 }}>
                    <div style={{ fontSize: 10, color: C.slateFaint, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
                    <div style={{ fontFamily: FONT_MONO, fontSize: 15, fontWeight: 700, color }}>{value}</div>
                  </div>
                ))}
              </div>

              {/* Забито и пропущено по раундам: столбик вверх — свои очки,
                  вниз — очки соперников. Видно, где результат просел. */}
              <div style={{ fontSize: 11, color: C.slateFaint, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>По раундам</div>
              <div style={{ display: "flex", gap: 5, alignItems: "flex-end", overflowX: "auto", paddingBottom: 4, marginBottom: 12 }}>
                {br.entries.map((e) => (
                  <div key={e.round} style={{ flex: "0 0 auto", width: 34, textAlign: "center" }}>
                    <div style={{ height: 40, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
                      {e.played && <div style={{ width: 16, height: Math.max(2, (e.my / peak) * 40), background: C.court, borderRadius: "3px 3px 0 0" }} />}
                    </div>
                    <div style={{ height: 1, background: C.rule }} />
                    <div style={{ height: 40, display: "flex", alignItems: "flex-start", justifyContent: "center" }}>
                      {e.played && <div style={{ width: 16, height: Math.max(2, (e.their / peak) * 40), background: C.rule, borderRadius: "0 0 3px 3px" }} />}
                    </div>
                    <div style={{ fontSize: 10, fontFamily: FONT_MONO, color: e.played ? C.ink : C.slateFaint, marginTop: 2 }}>
                      {e.played ? `${e.my}:${e.their}` : (e.rested ? "—" : "·")}
                    </div>
                    <div style={{ fontSize: 9.5, color: C.slateFaint }}>р.{e.round}</div>
                  </div>
                ))}
              </div>

              <div style={{ fontSize: 11, color: C.slateFaint, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>Матчи</div>
              {br.entries.map((e, k) => (
                <div key={k} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "5px 0", borderTop: k ? `1px solid ${C.rule}` : "none" }}>
                  <span style={{ width: 28, fontFamily: FONT_MONO, fontSize: 11, color: C.slateFaint }}>р.{e.round}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {e.rested ? (
                      <span style={{ color: C.rust }}>отдыхал</span>
                    ) : (
                      <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {e.partner ? `с ${nameOf(e.partner)}` : "один"} против {(e.opponents || []).map(nameOf).join(" / ")}
                      </span>
                    )}
                  </span>
                  {!e.rested && (
                    <>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 12.5, width: 50, textAlign: "right", fontWeight: e.played && e.my > e.their ? 700 : 400 }}>
                        {e.played ? `${e.my}:${e.their}` : "—"}
                      </span>
                      <span title="Накопленные очки после этого раунда" style={{ fontFamily: FONT_MONO, fontSize: 11, width: 68, textAlign: "right", color: C.slateFaint, whiteSpace: "nowrap" }}>
                        {e.played ? `итого ${e.scored}` : ""}
                      </span>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// One round
// ============================================================================
function RoundCard({ round, roundIndex, savedMatches, playersById, pointsPerMatch, onScore, canEnter, canEditSaved }) {
  const nameOf = (id) => (playersById[id] ? fullName(playersById[id]) : "—");
  return (
    <div style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 12, padding: 14, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
        <span style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 14 }}>Раунд {roundIndex + 1}</span>
        {round.manual && (
          <span style={{ fontSize: 10.5, color: C.action, border: `1px solid ${C.action}`, borderRadius: 999, padding: "0 7px" }}>вручную</span>
        )}
        {fmtDateTime(round.createdAt) && (
          <span style={{ fontSize: 11, color: C.slateFaint }}>{round.manual ? "внесён" : "сформирован"} {fmtDateTime(round.createdAt)}</span>
        )}
      </div>
      {round.matches.map((m, mi) => {
        const filled = m.score1 !== null && m.score1 !== undefined && m.score2 !== null && m.score2 !== undefined;
        // «Записан» — это то, что лежит на сервере, а не то, что набрано в полях
        // прямо сейчас. Раньше признак считался по текущему состоянию, и поле
        // блокировалось прямо во время набора: ввод первой цифры «1» запускал
        // автоподстановку второй ячейки, матч тут же выглядел записанным, и
        // дописать «6» к «16» было уже нельзя. Теперь блокировка наступает
        // только после нажатия «Сохранить счёт».
        const sm = savedMatches[mi];
        const saved = !!sm && sm.score1 !== null && sm.score1 !== undefined && sm.score2 !== null && sm.score2 !== undefined;
        // Внести результат впервые — часть ведения турнира. Исправить уже
        // записанный — действие админа, иначе историю можно переписать тихо.
        const editable = saved ? canEditSaved : canEnter;
        return (
          <div key={mi} style={{ borderTop: mi === 0 ? "none" : `1px solid ${C.rule}`, paddingTop: mi === 0 ? 0 : 10, marginTop: mi === 0 ? 0 : 10 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 10.5, color: C.slateFaint, textTransform: "uppercase", letterSpacing: "0.05em" }}>Корт {m.court}</span>
              {/* Отметку ставит сервер в момент сохранения, не браузер. */}
              {saved && fmtTime(sm.scoredAt) && (
                <span style={{ fontSize: 10.5, color: C.slateFaint, marginLeft: "auto" }} title={fmtDateTime(sm.scoredAt)}>
                  счёт внесён {fmtTime(sm.scoredAt)}
                </span>
              )}
            </div>
            {[["team1", "score1", "score2", "seeds1"], ["team2", "score2", "score1", "seeds2"]].map(([team, fld, other, seedKey]) => (
              <div key={fld} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: fld === "score1" ? 6 : 0 }}>
                <span style={{ flex: 1, fontSize: 13.5, fontWeight: filled && Number(m[fld]) > Number(m[other]) ? 700 : 400, display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
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
// Ручной ввод раунда — для турниров, заносимых задним числом
// ============================================================================
// Жеребьёвка здесь не участвует: состав каждого матча известен заранее, его
// надо просто записать. Поэтому вместо алгоритма — четыре выпадающих списка на
// корт и поля счёта. Кто не попал ни в один матч, автоматически считается
// отдыхавшим: отдельно отмечать их не нужно, а забыть — нельзя.
function ManualRoundEditor({ tournament, players, playersById, onSave, onCancel, busy }) {
  const active = activePlayerIds(tournament);
  const activePlayers = players.filter((p) => active.includes(p.id));
  const emptyMatch = () => ({ a1: "", a2: "", b1: "", b2: "", score1: "", score2: "" });
  const [matches, setMatches] = useState(
    Array.from({ length: Math.max(1, Math.min(Number(tournament.courts) || 1, Math.floor(active.length / 4) || 1)) }, emptyMatch)
  );

  const setField = (mi, field, value) => setMatches((ms) => ms.map((m, i) => (i === mi ? { ...m, [field]: value } : m)));

  const used = [];
  matches.forEach((m) => ["a1", "a2", "b1", "b2"].forEach((k) => { if (m[k]) used.push(m[k]); }));
  const duplicates = used.filter((id, i) => used.indexOf(id) !== i);
  const sitting = active.filter((id) => !used.includes(id));

  const problems = [];
  matches.forEach((m, i) => {
    const slots = [m.a1, m.a2, m.b1, m.b2].filter(Boolean);
    if (slots.length && slots.length < 4) problems.push(`Корт ${i + 1}: заполнены не все четыре игрока`);
    const s1 = m.score1 === "" ? null : Number(m.score1);
    const s2 = m.score2 === "" ? null : Number(m.score2);
    if (slots.length === 4 && (s1 === null || s2 === null)) problems.push(`Корт ${i + 1}: не внесён счёт`);
    if ((s1 !== null && s1 < 0) || (s2 !== null && s2 < 0)) problems.push(`Корт ${i + 1}: счёт не может быть отрицательным`);
  });
  if (duplicates.length) {
    const names = [...new Set(duplicates)].map((id) => (playersById[id] ? fullName(playersById[id]) : id));
    problems.push(`Один игрок в нескольких матчах: ${names.join(", ")}`);
  }
  const filled = matches.filter((m) => [m.a1, m.a2, m.b1, m.b2].every(Boolean));
  if (!filled.length) problems.push("Нужен хотя бы один заполненный матч");

  const save = () => {
    const round = {
      manual: true,
      sitting,
      matches: filled.map((m, i) => ({
        court: i + 1,
        team1: [m.a1, m.a2], team2: [m.b1, m.b2],
        score1: Number(m.score1), score2: Number(m.score2),
      })),
    };
    onSave(round);
  };

  const slot = (mi, field, label) => (
    <select value={matches[mi][field]} onChange={(e) => setField(mi, field, e.target.value)}
      style={{ ...inputStyle, width: "100%", fontSize: 13.5 }}>
      <option value="">{label}</option>
      {activePlayers.map((p) => <option key={p.id} value={p.id}>{fullName(p)}</option>)}
    </select>
  );

  return (
    <div style={{ background: C.card, border: `1px solid ${C.action}`, borderRadius: 12, padding: 14, marginBottom: 12 }}>
      <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 15, marginBottom: 4 }}>
        Раунд {(tournament.rounds || []).length + 1} — ручной ввод
      </div>
      <div style={{ fontSize: 11.5, color: C.slateFaint, marginBottom: 12 }}>
        Укажите составы и счёт. Остальные попадут в отдыхающие автоматически.
      </div>

      {matches.map((m, mi) => (
        <div key={mi} style={{ borderTop: mi ? `1px solid ${C.rule}` : "none", paddingTop: mi ? 12 : 0, marginTop: mi ? 12 : 0 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 10.5, color: C.slateFaint, textTransform: "uppercase", letterSpacing: "0.05em" }}>Корт {mi + 1}</span>
            {matches.length > 1 && (
              <button onClick={() => setMatches((ms) => ms.filter((_, i) => i !== mi))}
                style={{ marginLeft: "auto", fontSize: 11.5, background: "none", border: "none", color: C.negative, cursor: "pointer" }}>убрать корт</button>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
              {slot(mi, "a1", "Игрок 1")}
              {slot(mi, "a2", "Игрок 2")}
            </div>
            <input type="number" min="0" value={m.score1} onChange={(e) => setField(mi, "score1", e.target.value)}
              placeholder="0" style={{ ...inputStyle, width: 58, textAlign: "center", fontFamily: FONT_MONO }} />
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
              {slot(mi, "b1", "Игрок 3")}
              {slot(mi, "b2", "Игрок 4")}
            </div>
            <input type="number" min="0" value={m.score2} onChange={(e) => setField(mi, "score2", e.target.value)}
              placeholder="0" style={{ ...inputStyle, width: 58, textAlign: "center", fontFamily: FONT_MONO }} />
          </div>
        </div>
      ))}

      <button onClick={() => setMatches((ms) => [...ms, emptyMatch()])}
        style={{ ...btn("none", C.action), border: `1px dashed ${C.rule}`, marginTop: 12, fontSize: 12.5, padding: "7px 12px" }}>
        + Ещё корт
      </button>

      <div style={{ fontSize: 12, color: C.slateFaint, marginTop: 12, lineHeight: 1.5 }}>
        Отдыхают: {sitting.length ? sitting.map((id) => (playersById[id] ? fullName(playersById[id]) : id)).join(", ") : "никто"}
      </div>

      {problems.length > 0 && (
        <div style={{ fontSize: 12, color: C.rust, marginTop: 10, lineHeight: 1.5 }}>
          {problems.map((t, i) => <div key={i}>· {t}</div>)}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button disabled={problems.length > 0 || busy} onClick={save}
          style={{ ...btn(C.court), opacity: problems.length > 0 || busy ? 0.45 : 1 }}>Сохранить раунд</button>
        <button onClick={onCancel} style={{ ...btn("none", C.slateFaint), border: `1px solid ${C.rule}` }}>Отмена</button>
      </div>
    </div>
  );
}

// ============================================================================
// Tournament view
// ============================================================================
function TournamentView({ tournament, players, venues, onBack, onUpdate, canEdit, isAdmin, levels }) {
  const [local, setLocal] = useState(tournament);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [withdrawFor, setWithdrawFor] = useState(null);
  const [adding, setAdding] = useState(false);
  const [manualRound, setManualRound] = useState(false);
  const [addSearch, setAddSearch] = useState("");
  const [withdrawReason, setWithdrawReason] = useState("Травма");

  useEffect(() => { setLocal(tournament); }, [tournament.id]);

  const playersById = {};
  players.forEach((p) => { playersById[p.id] = p; });
  const standings = computeStandings(local);
  const active = activePlayerIds(local);
  const history = buildHistory(local);

  // В кандидаты идут все, кого в турнире ещё нет. Снятые сюда не попадают —
  // для них есть кнопка «вернуть» в списке выбывших.
  const inTournament = new Set(local.playerIds || []);
  const candidates = players.filter((p) => !inTournament.has(p.id)
    && (!addSearch.trim() || fullName(p).toLowerCase().includes(addSearch.trim().toLowerCase())));

  const venueName = (venues.find((v) => v.id === local.venueId) || {}).name || "";
  // Журнал времени строится из серверных отметок на матчах, а не из отдельного
  // поля: так он не может разойтись с тем, что реально записано в раундах.
  const allMatches = local.rounds.flatMap((r) => r.matches || []);
  const totalMatches = allMatches.length;
  const scoredStamps = allMatches.map((m) => m.scoredAt).filter(Boolean).sort();
  const scoredCount = allMatches.filter((m) => m.score1 !== null && m.score1 !== undefined && m.score2 !== null && m.score2 !== undefined).length;
  const createdAtText = fmtDateTime(local.createdAt);
  const firstScoreText = fmtDateTime(scoredStamps[0]);
  const lastScoreText = scoredStamps.length > 1 ? fmtDateTime(scoredStamps[scoredStamps.length - 1]) : null;

  const lastRound = local.rounds[local.rounds.length - 1];
  const lastComplete = !lastRound || lastRound.matches.every((m) => m.score1 !== null && m.score1 !== undefined && m.score2 !== null && m.score2 !== undefined);
  const reachedTarget = local.targetRounds ? local.rounds.length >= local.targetRounds : false;
  const tooFewActive = active.length < 4;

  const persist = async (next) => {
    setLocal(next); setBusy(true); setMsg("");
    try {
      const res = await api(`/api/mexicano/${local.id}`, { method: "PUT", body: next });
      // Сервер возвращает турнир со своими отметками времени — берём его версию,
      // иначе время внесения счёта появится только после перезагрузки.
      const applied = (res && res.tournament) || next;
      setLocal(applied);
      onUpdate(applied);
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

  // Ручной раунд сохраняется тем же путём, что и сформированный жеребьёвкой —
  // отличается только происхождением состава.
  const addManualRound = (round) => {
    setManualRound(false);
    persist({ ...local, rounds: [...local.rounds, round] });
  };

  const nextRound = () => {
    const round = buildRound(local, playersById, computeStandings(local), levels);
    persist({ ...local, rounds: [...local.rounds, round] });
  };

  // Добавление игрока по ходу турнира. В playerIds он попадает в конец, а в
  // joins записывается, с какого раунда вступил и с каким базовым уровнем
  // пропусков — чтобы очередь на отдых не перекосило (см. buildHistory).
  const doAdd = (playerId) => {
    const next = {
      ...local,
      playerIds: [...(local.playerIds || []), playerId],
      joins: [...(local.joins || []), {
        playerId,
        round: local.rounds.length,
        baselineSitOuts: joinBaselineSitOuts(local),
      }],
    };
    setAdding(false); setAddSearch("");
    persist(next);
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
        {local.date}{local.startTime ? `, ${local.startTime}` : ""} · до {local.pointsPerMatch} · кортов {local.courts} · {active.length} в игре
        {local.targetRounds ? ` · раунд ${local.rounds.length}/${local.targetRounds}` : ` · раундов ${local.rounds.length}`}
      </div>

      {/* Объект и журнал времени. Объект меняется и после завершения турнира:
          его часто вспоминают уже потом, а блокировать правку задним числом
          здесь нечему — на расчёт рейтинга объект не влияет. */}
      <div style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 12, padding: 14, marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 10 }}>
          <div style={{ flex: "1 1 220px" }}>
            <div style={{ fontSize: 11, color: C.slateFaint, marginBottom: 4 }}>Объект</div>
            {isAdmin ? (
              <select value={local.venueId || ""} onChange={(e) => persist({ ...local, venueId: e.target.value || null })}
                disabled={busy} style={{ ...inputStyle, width: "100%" }}>
                <option value="">Не указан</option>
                {venues.map((v) => <option key={v.id} value={v.id}>{v.name || "Без названия"}</option>)}
              </select>
            ) : (
              <div style={{ fontSize: 14 }}>{venueName || <span style={{ color: C.slateFaint }}>не указан</span>}</div>
            )}
          </div>
        </div>

        <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.rule}`, fontSize: 11.5, color: C.slateFaint, lineHeight: 1.6 }}>
          {local.manual && <div style={{ color: C.action }}>Внесён задним числом — раунды заполнены вручную</div>}
          {createdAtText && <div>{local.manual ? "Запись создана" : "Турнир создан"}: {createdAtText}</div>}
          {firstScoreText && <div>Первый результат внесён: {firstScoreText}</div>}
          {lastScoreText && <div>Последний результат внесён: {lastScoreText}</div>}
          <div>Результатов внесено: {scoredCount} из {totalMatches}</div>
        </div>
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
          {/* Добавление игрока уже начатого турнира — зеркало снятия. Доступно,
              пока турнир не завершён; вступивший играет со следующего раунда. */}
          <div style={{ marginBottom: 14, paddingBottom: 14, borderBottom: `1px solid ${C.rule}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: adding ? 8 : 0 }}>
              <span style={{ fontSize: 11.5, color: C.slateFaint }}>Добавить игрока в турнир</span>
              <button onClick={() => { setAdding((v) => !v); setAddSearch(""); }} style={{
                marginLeft: "auto", fontSize: 12.5, fontWeight: 600, cursor: "pointer",
                background: adding ? "none" : C.court, color: adding ? C.slateFaint : "#fff",
                border: adding ? `1px solid ${C.rule}` : "none", borderRadius: 8, padding: "6px 14px",
              }}>{adding ? "Отмена" : "+ Добавить"}</button>
            </div>
            {adding && (
              <>
                <input value={addSearch} onChange={(e) => setAddSearch(e.target.value)} placeholder="Поиск игрока"
                  style={{ ...inputStyle, width: "100%", marginBottom: 8 }} />
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 220, overflowY: "auto" }}>
                  {candidates.map((p) => (
                    <button key={p.id} onClick={() => doAdd(p.id)} disabled={busy} style={{
                      display: "flex", alignItems: "center", gap: 6, fontSize: 13,
                      background: C.paper, color: C.ink, border: `1px solid ${C.rule}`,
                      borderRadius: 999, padding: "5px 11px", cursor: "pointer", opacity: busy ? 0.5 : 1,
                    }}><Avatar player={p} size={20} /> {fullName(p)}</button>
                  ))}
                  {candidates.length === 0 && (
                    <span style={{ fontSize: 12.5, color: C.slateFaint }}>
                      {addSearch.trim() ? "Никого не нашлось." : "Все игроки уже в турнире."}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: C.slateFaint, marginTop: 8, lineHeight: 1.45 }}>
                  Вступивший играет со следующего раунда. В таблице он начинает с нуля очков,
                  а в очередь на отдых встаёт наравне с остальными.
                </div>
              </>
            )}
          </div>

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
          {local.manual
            ? "Раундов пока нет. Нажмите «Раунд вручную» и внесите составы и счёт."
            : "Турнир создан. Нажмите «Сформировать раунд» для первой жеребьёвки."}
        </div>
      )}

      {local.rounds.map((r, i) => (
        <RoundCard key={i} round={r} roundIndex={i} playersById={playersById}
          savedMatches={((tournament.rounds || [])[i] || {}).matches || []}
          pointsPerMatch={local.pointsPerMatch} onScore={onScore}
          canEnter={canEdit && !local.finished} canEditSaved={isAdmin} />
      ))}

      {manualRound && (
        <ManualRoundEditor tournament={local} players={players} playersById={playersById}
          onSave={addManualRound} onCancel={() => setManualRound(false)} busy={busy} />
      )}

      {msg && <div style={{ fontSize: 12.5, color: C.negative, marginBottom: 10 }}>{msg}</div>}

      {canEdit && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14, marginBottom: 30 }}>
          {local.rounds.length > 0 && (
            <button onClick={() => persist(local)} disabled={busy} style={{ ...btn(C.action), opacity: busy ? 0.5 : 1 }}>
              {busy ? "Сохранение…" : "Сохранить счёт"}
            </button>
          )}
          {/* Для турнира задним числом ручной ввод — единственный способ внести
              раунд, поэтому он доступен всем, кто вправе вести турнир. Для
              обычного турнира это обход жеребьёвки, и он остаётся за админом. */}
          {!local.finished && (local.manual || isAdmin) && (
            <button onClick={() => setManualRound(true)} disabled={busy || manualRound}
              title="Самостоятельно указать составы и счёт — для турниров, вносимых задним числом"
              style={{ ...btn("none", C.action), border: `1px solid ${C.action}`, opacity: busy || manualRound ? 0.45 : 1 }}>
              + Раунд вручную
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
          Пока счёт не сохранён, его можно свободно править. После нажатия «Сохранить счёт»
          исправление записанного результата и удаление турнира доступны только в админ-панели.
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

  // Хук обязан стоять ДО любых ранних return. Полный пересчёт истории стоит
  // десятки миллисекунд — привязываем его к данным, иначе он гонялся бы на
  // каждое нажатие клавиши в форме создания турнира.
  const pcrLevels = useMemo(() => {
    const out = {};
    if (!data) return out;
    computePCR(data).forEach((r) => { out[r.id] = r.rating; });
    return out;
  }, [data]);

  if (loadError) return <div style={{ padding: 24, fontFamily: FONT_BODY, color: C.negative }}>Не удалось загрузить данные: {loadError}</div>;
  if (!data) return <div style={{ minHeight: "60vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT_DISPLAY, fontSize: 22, color: C.court }}>PadelCom</div>;

  const canEdit = !!(session && session.loggedIn) || isAdmin;
  // Match balance is measured against PC Rating rather than points scored so
  // far: in the opening rounds the tournament's own table is almost empty and
  // tells you nothing, while PC Rating already reflects every game on record.

  const players = (data.players || []).slice().sort((a, b) => fullName(a).localeCompare(fullName(b)));
  const teams = [...(data.teams || [])].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const venues = [...(data.places || [])].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const venueNameOf = (t) => (venues.find((v) => v.id === t.venueId) || {}).name || "";
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
          <TournamentView tournament={open} players={players} venues={venues} canEdit={canEdit} isAdmin={isAdmin} levels={pcrLevels}
            onBack={() => setOpenId(null)} onUpdate={update} />
        ) : (
          <>
            {canEdit && !creating && (
              <button onClick={() => setCreating(true)} style={{ ...btn(C.ink), width: "100%", marginBottom: 16 }}>+ Новый турнир</button>
            )}
            {creating && <CreateForm players={players} teams={teams} venues={venues} onCreate={create} onCancel={() => setCreating(false)} busy={busy} />}

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
                      {t.date}{venueNameOf(t) ? ` · ${venueNameOf(t)}` : ""} · {(t.playerIds || []).length} игроков{out > 0 ? ` (−${out})` : ""} · раундов {(t.rounds || []).length}{t.targetRounds ? `/${t.targetRounds}` : ""} · матчей {done}
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
