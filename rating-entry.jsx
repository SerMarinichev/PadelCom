import React, { useState, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { buildRating, explainRow, MIN_GAMES_RELIABLE } from "./rating.js";
import {
  QUESTIONNAIRE, scoreQuestionnaire, computePCR, weeklySeries, ntrpRows,
  recentChange, headToHead, ratedRows, calibrationReport,
  MIN_RATED_GAMES, INITIAL_WEIGHT, SCALE_MAX, ELO_BASE,
} from "./pcr.js";

const C = {
  paper: "#F5F3ED", paperDim: "#EFEDE4", card: "#FFFFFF", ink: "#1A1B1D",
  slate: "#4A4D52", slateFaint: "#8A8D93", rule: "#DFDBCF",
  court: "#2E9E6F", action: "#2F6DB3", rust: "#B5603A",
  violet: "#684EC4", positive: "#2E9E6F", negative: "#C0493B",
};
const FD = "'Montserrat', sans-serif";
const FB = "'PT Sans', system-ui, sans-serif";
const FM = "'IBM Plex Mono', ui-monospace, monospace";

const fullName = (p) => [p.firstName, p.lastName].filter(Boolean).join(" ").trim() || "Без имени";
const MEDAL = ["#C9A227", "#9BA0A6", "#B07B4F"];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let j = null;
  try { j = await res.json(); } catch { /* none */ }
  if (!res.ok) { const e = new Error((j && (j.detail || j.error)) || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return j;
}

function Avatar({ player, size = 26 }) {
  if (!player) return null;
  const ini = `${(player.firstName || "?")[0] || ""}${(player.lastName || "")[0] || ""}`;
  const base = { width: size, height: size, flex: "0 0 auto", borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center" };
  if (player.photo) return <span style={{ ...base, backgroundImage: `url(${player.photo})`, backgroundSize: "cover", backgroundPosition: "center" }} />;
  return <span style={{ ...base, background: player.gender === "female" ? "#F3DDD5" : "#D8E3F0", color: C.ink, fontSize: size * 0.38, fontWeight: 700 }}>{ini}</span>;
}

const panel = { background: C.card, border: `1px solid ${C.rule}`, borderRadius: 12, overflow: "hidden" };
const headRow = { display: "flex", padding: "9px 13px", background: C.paperDim, fontSize: 10.5, color: C.slateFaint, textTransform: "uppercase", letterSpacing: "0.05em" };
const note = { background: C.card, border: `1px solid ${C.rule}`, borderRadius: 10, padding: "11px 13px", marginBottom: 14, fontSize: 12.5, color: C.slate, lineHeight: 1.55 };
const inputStyle = { fontSize: 16, border: `1px solid ${C.rule}`, borderRadius: 7, padding: "8px 10px", background: C.paper, fontFamily: FB, color: C.ink };

// ============================================================================
// Points-share table (Всё / Турниры / Матчи)
// ============================================================================
function ShareTable({ rows, playersById, showSource }) {
  const [open, setOpen] = useState(null);
  if (!rows.length) return <div style={{ ...panel, padding: 24, textAlign: "center", fontSize: 13.5, color: C.slateFaint, border: `1px dashed ${C.rule}` }}>Пока нет сыгранных матчей.</div>;
  return (
    <div style={panel}>
      <div style={headRow}>
        <span style={{ width: 26 }}>#</span><span style={{ flex: 1 }}>Игрок</span>
        <span style={{ width: 62, textAlign: "right" }}>Рейтинг</span>
        <span style={{ width: 38, textAlign: "right" }}>Игр</span>
        <span style={{ width: 46, textAlign: "right" }}>Побед</span>
      </div>
      {rows.map((r, i) => {
        const p = playersById[r.id];
        const isOpen = open === r.id;
        return (
          <div key={r.id}>
            <div onClick={() => setOpen(isOpen ? null : r.id)} style={{ display: "flex", alignItems: "center", padding: "10px 13px", borderTop: `1px solid ${C.rule}`, background: i === 0 && r.reliable ? "#F6FBF8" : C.card, cursor: "pointer", opacity: r.reliable ? 1 : 0.65 }}>
              <span style={{ width: 26, fontFamily: FM, fontSize: 12.5, fontWeight: i < 3 && r.reliable ? 700 : 400, color: i < 3 && r.reliable ? MEDAL[i] : C.slateFaint }}>{i + 1}</span>
              <span style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, minWidth: 0 }}>
                <Avatar player={p} size={26} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p ? fullName(p) : r.id}</span>
                {!r.reliable && <span style={{ fontSize: 9.5, color: C.rust, border: `1px solid ${C.rust}`, borderRadius: 999, padding: "0 5px", flex: "0 0 auto" }}>мало игр</span>}
              </span>
              <span style={{ width: 62, textAlign: "right", fontFamily: FM, fontWeight: 700, fontSize: 14.5 }}>{r.share.toFixed(1)}%</span>
              <span style={{ width: 38, textAlign: "right", fontFamily: FM, fontSize: 12, color: C.slateFaint }}>{r.games}</span>
              <span style={{ width: 46, textAlign: "right", fontFamily: FM, fontSize: 12, color: C.slateFaint }}>{r.wins}</span>
            </div>
            {isOpen && (
              <div style={{ padding: "10px 13px 13px 65px", background: C.paperDim, fontSize: 12.5, color: C.slate, lineHeight: 1.6, borderTop: `1px solid ${C.rule}` }}>
                <div><b>{explainRow(r)}</b></div>
                <div>Побед {r.wins}, поражений {r.losses}{r.draws > 0 ? `, ничьих ${r.draws}` : ""} — винрейт {r.winRate.toFixed(0)}%</div>
                <div>Разница очков: <span style={{ color: r.diff >= 0 ? C.positive : C.negative, fontFamily: FM }}>{r.diff >= 0 ? "+" : ""}{r.diff}</span></div>
                {showSource && <div style={{ color: C.slateFaint }}>Источник: турниры — {r.tournamentGames}, «Матчи» — {r.matchGames}</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// NTRP
// ============================================================================
function NtrpTable({ rows, playersById }) {
  const shown = rows.filter((r) => r.self != null || r.peer != null);
  return (
    <>
      <div style={note}>
        <b>Саморейтинг</b> — уровень, который игрок указал себе сам в своей карточке.
        <b> Оценка</b> — среднее из оценок, которые ему поставили другие игроки. Расхождение между
        колонками обычно и есть источник споров: самооценка в падел, как правило, завышена.
      </div>
      {shown.length === 0 ? (
        <div style={{ ...panel, padding: 24, textAlign: "center", fontSize: 13.5, color: C.slateFaint, border: `1px dashed ${C.rule}` }}>Ни у кого ещё не указан уровень.</div>
      ) : (
        <div style={panel}>
          <div style={headRow}>
            <span style={{ width: 26 }}>#</span><span style={{ flex: 1 }}>Игрок</span>
            <span style={{ width: 86, textAlign: "right" }}>Саморейтинг</span>
            <span style={{ width: 70, textAlign: "right" }}>Оценка</span>
          </div>
          {shown.map((r, i) => {
            const p = playersById[r.id];
            const gap = r.self != null && r.peer != null ? r.peer - r.self : null;
            return (
              <div key={r.id} style={{ display: "flex", alignItems: "center", padding: "10px 13px", borderTop: `1px solid ${C.rule}` }}>
                <span style={{ width: 26, fontFamily: FM, fontSize: 12.5, color: C.slateFaint }}>{i + 1}</span>
                <span style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, minWidth: 0 }}>
                  <Avatar player={p} size={26} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p ? fullName(p) : r.id}</span>
                </span>
                <span style={{ width: 86, textAlign: "right", fontFamily: FM, fontSize: 13.5 }}>{r.self != null ? r.self.toFixed(1) : "—"}</span>
                <span style={{ width: 70, textAlign: "right", fontFamily: FM, fontSize: 13.5, fontWeight: 700 }}>
                  {r.peer != null ? r.peer.toFixed(1) : "—"}
                  {r.peerCount > 0 && <span style={{ fontSize: 10, color: C.slateFaint, fontWeight: 400 }}> ·{r.peerCount}</span>}
                  {gap != null && Math.abs(gap) >= 0.5 && (
                    <span title="Разница с самооценкой" style={{ display: "block", fontSize: 10, color: gap < 0 ? C.rust : C.positive, fontWeight: 400 }}>
                      {gap > 0 ? "+" : ""}{gap.toFixed(1)}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ============================================================================
// PCR — the computed community rating
// ============================================================================
function WeeklyBars({ series }) {
  if (!series.length) return <div style={{ fontSize: 12, color: C.slateFaint }}>Недостаточно игр для динамики.</div>;
  const peak = Math.max(1, ...series.map((s) => Math.abs(s.delta)));
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "flex-end", overflowX: "auto", paddingBottom: 4 }}>
      {series.map((s) => {
        const up = s.delta >= 0;
        const h = Math.max(3, (Math.abs(s.delta) / peak) * 34);
        return (
          <div key={s.key} style={{ flex: "0 0 auto", width: 50, textAlign: "center" }}>
            <div style={{ height: 38, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
              {up && <div style={{ width: 20, height: h, background: C.positive, borderRadius: "4px 4px 0 0" }} />}
            </div>
            <div style={{ height: 1, background: C.rule }} />
            <div style={{ height: 38, display: "flex", alignItems: "flex-start", justifyContent: "center" }}>
              {!up && <div style={{ width: 20, height: h, background: C.negative, borderRadius: "0 0 4px 4px" }} />}
            </div>
            <div style={{ fontSize: 10.5, fontFamily: FM, color: up ? C.positive : C.negative, fontWeight: 700 }}>
              {up ? "+" : ""}{s.delta}
            </div>
            <div style={{ fontSize: 9.5, color: C.slateFaint, fontFamily: FM }}>{s.label}</div>
            <div style={{ fontSize: 9, color: C.slateFaint }}>{s.games} игр</div>
          </div>
        );
      })}
    </div>
  );
}

// Кто с кем и против кого — именно на этих встречах рейтинг и построен.
function H2HList({ title, entries, playersById, limit = 6 }) {
  if (!entries.length) return null;
  return (
    <div style={{ flex: "1 1 220px", minWidth: 0 }}>
      <div style={{ fontSize: 11, color: C.slateFaint, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>{title}</div>
      {entries.slice(0, limit).map((e) => {
        const p = playersById[e.id];
        const share = e.pointsFor + e.pointsAgainst ? e.pointsFor / (e.pointsFor + e.pointsAgainst) : 0.5;
        return (
          <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, padding: "3px 0" }}>
            <Avatar player={p} size={20} />
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p ? fullName(p) : e.id}</span>
            <span style={{ fontFamily: FM, fontSize: 11.5, color: C.slateFaint }}>{e.wins}–{e.games - e.wins}</span>
            <span style={{ fontFamily: FM, fontSize: 11.5, width: 42, textAlign: "right", color: share >= 0.5 ? C.positive : C.negative }}>
              {Math.round(share * 100)}%
            </span>
          </div>
        );
      })}
      {entries.length > limit && <div style={{ fontSize: 11, color: C.slateFaint, marginTop: 3 }}>и ещё {entries.length - limit}</div>}
    </div>
  );
}

// Последние матчи с вкладом каждого в рейтинг — чтобы на вопрос «почему у меня
// столько» можно было ответить матчем, а не формулой.
function ContributionList({ row, playersById, limit = 8 }) {
  const items = row.history.slice(-limit).reverse();
  if (!items.length) return null;
  const nameOf = (id) => (playersById[id] ? fullName(playersById[id]) : id);
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, color: C.slateFaint, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>Последние матчи</div>
      {items.map((h, i) => {
        const g = h.game;
        const mine = g.sideA.includes(row.id) ? g.sideA : g.sideB;
        const theirs = g.sideA.includes(row.id) ? g.sideB : g.sideA;
        const myScore = g.sideA.includes(row.id) ? g.scoreA : g.scoreB;
        const theirScore = g.sideA.includes(row.id) ? g.scoreB : g.scoreA;
        const partner = mine.find((id) => id !== row.id);
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "5px 0", borderTop: i ? `1px solid ${C.rule}` : "none" }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {partner ? `с ${nameOf(partner)}` : "в одиночку"} против {theirs.map(nameOf).join(" / ")}
              </span>
              <span style={{ display: "block", fontSize: 10.5, color: C.slateFaint }}>
                {g.date} · {g.label} · ожидалось {Math.round(h.expected * 100)}%, вышло {Math.round(h.share * 100)}%
              </span>
            </span>
            <span style={{ fontFamily: FM, fontSize: 12, width: 48, textAlign: "right" }}>{myScore}:{theirScore}</span>
            <span style={{ fontFamily: FM, fontSize: 12.5, fontWeight: 700, width: 44, textAlign: "right", color: h.delta >= 0 ? C.positive : C.negative }}>
              {h.delta > 0 ? "+" : ""}{h.delta}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function PcrRow({ r, i, playersById, rows, provisional, refDate }) {
  const [open, setOpen] = useState(false);
  const p = playersById[r.id];
  const series = open ? weeklySeries(r) : [];
  const h2h = open ? headToHead(rows, r.id) : { partners: [], opponents: [] };
  const recent = recentChange(r, 30, refDate);
  return (
    <div>
      <div onClick={() => setOpen((o) => !o)} style={{ display: "flex", alignItems: "center", padding: "10px 13px", borderTop: `1px solid ${C.rule}`, cursor: "pointer", background: i === 0 && !provisional ? "#F7F5FD" : C.card }}>
        <span style={{ width: 26, fontFamily: FM, fontSize: 12.5, fontWeight: i < 3 && !provisional ? 700 : 400, color: i < 3 && !provisional ? MEDAL[i] : C.slateFaint }}>
          {provisional ? "—" : i + 1}
        </span>
        <span style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, minWidth: 0 }}>
          <Avatar player={p} size={26} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p ? fullName(p) : r.id}</span>
        </span>
        <span style={{ width: 56, textAlign: "right", fontFamily: FM, fontWeight: 700, fontSize: 15, color: provisional ? C.slateFaint : C.violet }}>{r.elo}</span>
        <span style={{ width: 52, textAlign: "right", fontFamily: FM, fontSize: 12 }}>
          {recent && recent.delta !== 0
            ? <span style={{ color: recent.delta > 0 ? C.positive : C.negative }}>{recent.delta > 0 ? "▲" : "▼"}{Math.abs(recent.delta)}</span>
            : <span style={{ color: C.slateFaint }}>—</span>}
        </span>
        <span style={{ width: 44, textAlign: "right", fontFamily: FM, fontSize: 12, color: C.slate }}>{r.rating.toFixed(1)}</span>
        <span style={{ width: 38, textAlign: "right", fontFamily: FM, fontSize: 12, color: C.slateFaint }}>{r.games}</span>
      </div>

      {open && (
        <div style={{ padding: "12px 13px 14px", background: C.paperDim, borderTop: `1px solid ${C.rule}` }}>
          <div style={{ fontSize: 12.5, color: C.slate, marginBottom: 12, lineHeight: 1.6 }}>
            Рейтинг <b style={{ color: C.violet }}>{r.elo}</b> (уровень {r.rating.toFixed(2)}) · старт {r.startElo} из источника «{r.initialSource}»
            {r.change !== 0 && <> · {r.change > 0 ? "рост" : "снижение"} на {Math.abs(r.change)} очков</>}
            <br />
            Сыграно {r.games} — {r.wins} побед, {r.losses} поражений, доля очков {r.pointShare != null ? Math.round(r.pointShare * 100) + "%" : "—"} · надёжность {Math.round(r.reliability * 100)}%
            {provisional && <><br /><span style={{ color: C.rust }}>В зачёт не идёт: нужно минимум {MIN_RATED_GAMES} матча.</span></>}
          </div>
          <div style={{ fontSize: 11, color: C.slateFaint, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>Динамика по неделям</div>
          <WeeklyBars series={series} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 18, marginTop: 14 }}>
            <H2HList title="В паре с" entries={h2h.partners} playersById={playersById} />
            <H2HList title="Против" entries={h2h.opponents} playersById={playersById} />
          </div>
          <ContributionList row={r} playersById={playersById} />
        </div>
      )}
    </div>
  );
}

function PcrTable({ rows, playersById }) {
  const [showCalibration, setShowCalibration] = useState(false);
  if (!rows.length) return <div style={{ ...panel, padding: 24, textAlign: "center", fontSize: 13.5, color: C.slateFaint, border: `1px dashed ${C.rule}` }}>Нет игроков.</div>;
  const rated = rows.filter((r) => r.rated);
  const provisional = rows.filter((r) => !r.rated && r.games > 0);
  const untouched = rows.filter((r) => r.games === 0);
  // Окно динамики отсчитывается от последней сыгранной игры, а не от сегодня.
  const refDate = rows.lastGameDate ? new Date(rows.lastGameDate) : new Date();

  const head = (
    <div style={headRow}>
      <span style={{ width: 26 }}>#</span><span style={{ flex: 1 }}>Игрок</span>
      <span style={{ width: 56, textAlign: "right" }}>Рейтинг</span>
      <span style={{ width: 52, textAlign: "right" }}>30 дн.</span>
      <span style={{ width: 44, textAlign: "right" }}>Ур.</span>
      <span style={{ width: 38, textAlign: "right" }}>Игр</span>
    </div>
  );

  return (
    <>
      <div style={note}>
        <b>PC Rating</b> — рейтинг по модели Elo с поправкой на счёт. Учитываются все матчи и все
        раунды турниров Mexicano и Americano: рейтинг пары — среднее партнёров, и после каждого
        матча обе стороны сдвигаются на столько, насколько результат разошёлся с ожидаемым. Чем
        крупнее разрыв в счёте, тем сильнее сдвиг; матч до 32 весит больше, чем до 12.
        Вся история пересчитывается заново при каждом обновлении, поэтому порядок матчей на итог
        не влияет. Колонка <b>30 дн.</b> — движение за 30 дней до последней сыгранной
        в сообществе игры{rows.lastGameDate ? ` (${rows.lastGameDate})` : ""}; у тех, кто в этот
        месяц не играл, стоит прочерк.
        Игроки менее {MIN_RATED_GAMES} матчей в зачёт не идут.
        Нажмите на строку, чтобы увидеть динамику, встречи и вклад каждого матча.
      </div>

      <div style={panel}>
        {head}
        {rated.map((r, i) => <PcrRow key={r.id} r={r} i={i} playersById={playersById} rows={rows} refDate={refDate} />)}
      </div>

      {provisional.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: C.slateFaint, textTransform: "uppercase", letterSpacing: "0.06em", margin: "18px 0 8px" }}>
            Недостаточно матчей — вне зачёта
          </div>
          <div style={panel}>
            {head}
            {provisional.map((r, i) => <PcrRow key={r.id} r={r} i={i} playersById={playersById} rows={rows} refDate={refDate} provisional />)}
          </div>
        </>
      )}

      {untouched.length > 0 && (
        <div style={{ fontSize: 12, color: C.slateFaint, marginTop: 14, lineHeight: 1.5 }}>
          Ещё {untouched.length} {untouched.length === 1 ? "игрок" : "игроков"} без единого сыгранного матча — появятся в таблице после первой игры.
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <button onClick={() => setShowCalibration((v) => !v)} style={{
          fontSize: 12, color: C.slateFaint, background: "none", border: "none",
          cursor: "pointer", padding: 0, textDecoration: "underline",
        }}>{showCalibration ? "Скрыть проверку модели" : "Как проверить, что модель не врёт"}</button>
        {showCalibration && (
          <div style={{ ...note, marginTop: 8 }}>
            Модель исходит из того, что разрыв в один уровень (300 очков) — это примерно 24:12 по счёту.
            Таблица ниже сверяет это допущение с фактом: для каждого диапазона разрыва показано, какую
            долю очков фаворит должен был набрать и какую набрал на самом деле. Расхождение в пределах
            ±0.03 — норма. Устойчивое расхождение в одну сторону означает, что модель пора
            перекалибровать.
            {rows.calibration && rows.calibration.length > 0 ? (
              <div style={{ marginTop: 10 }}>
                <div style={{ display: "flex", fontSize: 10.5, color: C.slateFaint, textTransform: "uppercase", letterSpacing: "0.05em", paddingBottom: 4 }}>
                  <span style={{ flex: 1 }}>Разрыв</span>
                  <span style={{ width: 54, textAlign: "right" }}>Матчей</span>
                  <span style={{ width: 58, textAlign: "right" }}>Факт</span>
                  <span style={{ width: 66, textAlign: "right" }}>Ожидалось</span>
                </div>
                {rows.calibration.map((b) => (
                  <div key={b.label} style={{ display: "flex", fontSize: 12, fontFamily: FM, padding: "3px 0", borderTop: `1px solid ${C.rule}` }}>
                    <span style={{ flex: 1 }}>{b.label}</span>
                    <span style={{ width: 54, textAlign: "right", color: C.slateFaint }}>{b.games}</span>
                    <span style={{ width: 58, textAlign: "right", color: Math.abs(b.gap) > 0.03 ? C.rust : C.ink }}>{b.observed.toFixed(2)}</span>
                    <span style={{ width: 66, textAlign: "right", color: C.slateFaint }}>{b.predicted.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ marginTop: 8, color: C.slateFaint }}>Матчей пока слишком мало для проверки.</div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ============================================================================
// Questionnaire
// ============================================================================
function QuestionnaireForm({ me, players, isAdmin, onSaved }) {
  const [targetId, setTargetId] = useState(me ? me.id : "");
  const target = players.find((p) => p.id === targetId);
  const existing = target && target.pcrQuestionnaire;
  const [answers, setAnswers] = useState(existing ? existing.answers || {} : {});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const t = players.find((p) => p.id === targetId);
    setAnswers(t && t.pcrQuestionnaire ? (t.pcrQuestionnaire.answers || {}) : {});
    setEditing(false);
    setMsg("");
  }, [targetId]);

  const result = scoreQuestionnaire(answers);
  const locked = !!existing && !editing && !isAdmin;

  const save = async () => {
    setBusy(true); setMsg("");
    try {
      await api("/api/pcr/questionnaire", {
        method: "PUT",
        body: { playerId: isAdmin ? targetId : undefined, answers, level: result.level },
      });
      setMsg("Сохранено");
      setEditing(false);
      onSaved();
    } catch (e) {
      setMsg(e.status === 403 ? "Нужен вход через Telegram или в админ-панель" : `Не сохранилось: ${e.message}`);
    } finally { setBusy(false); }
  };

  if (!me && !isAdmin) {
    return <div style={{ ...note, color: C.rust, borderColor: C.rust }}>Чтобы пройти анкету, войдите через Telegram в приложении.</div>;
  }

  return (
    <div>
      <div style={note}>
        Анкета задаёт <b>стартовый</b> уровень. Дальше он уточняется по результатам игр, поэтому
        ошибиться не страшно — система выправит. Объективные вопросы о стаже и опыте весят больше,
        чем самооценка техники: самооценка в падел систематически завышена.
        {!isAdmin && <> Пройти анкету можно один раз, изменить потом — через администратора.</>}
      </div>

      {isAdmin && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: C.slateFaint, marginBottom: 4 }}>Игрок (режим администратора)</div>
          <select value={targetId} onChange={(e) => setTargetId(e.target.value)} style={{ ...inputStyle, width: "100%" }}>
            <option value="">— выберите игрока —</option>
            {players.map((p) => (
              <option key={p.id} value={p.id}>{fullName(p)}{p.pcrQuestionnaire ? " ✓" : ""}</option>
            ))}
          </select>
        </div>
      )}

      {!targetId ? null : (
        <>
          {existing && (
            <div style={{ ...note, background: "#F7F5FD", borderColor: C.violet }}>
              Анкета уже пройдена: стартовый уровень <b style={{ color: C.violet }}>{Number(existing.level).toFixed(1)}</b>
              {existing.completedAt && <> · {String(existing.completedAt).slice(0, 10)}</>}
              {locked && <> — изменение доступно администратору.</>}
              {!locked && !editing && (
                <> <button onClick={() => setEditing(true)} style={{ marginLeft: 6, fontSize: 12.5, background: "none", border: "none", color: C.action, cursor: "pointer", padding: 0 }}>изменить</button></>
              )}
            </div>
          )}

          <div style={{ opacity: locked ? 0.6 : 1, pointerEvents: locked ? "none" : "auto" }}>
            {QUESTIONNAIRE.map((q, qi) => (
              <div key={q.id} style={{ ...panel, padding: 13, marginBottom: 10 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: q.hint ? 3 : 8 }}>
                  <span style={{ color: C.slateFaint, fontFamily: FM, fontSize: 12 }}>{qi + 1}. </span>{q.q}
                </div>
                {q.hint && <div style={{ fontSize: 11.5, color: C.slateFaint, marginBottom: 8, lineHeight: 1.4 }}>{q.hint}</div>}
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {q.options.map(([label], oi) => {
                    const on = answers[q.id] === oi;
                    return (
                      <button key={oi} onClick={() => setAnswers((a) => ({ ...a, [q.id]: oi }))} style={{
                        textAlign: "left", fontSize: 13, padding: "8px 11px", borderRadius: 8, cursor: "pointer",
                        background: on ? C.violet : C.paper, color: on ? "#fff" : C.ink,
                        border: `1px solid ${on ? C.violet : C.rule}`,
                      }}>{label}</button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div style={{ ...panel, padding: 14, marginTop: 4, position: "sticky", bottom: 10, boxShadow: "0 4px 14px rgba(26,27,29,0.12)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 11, color: C.slateFaint }}>Отвечено {result.answered} из {result.total}</div>
                <div style={{ fontSize: 22, fontWeight: 700, fontFamily: FM, color: result.complete ? C.violet : C.slateFaint }}>
                  {result.level.toFixed(1)}
                  <span style={{ fontSize: 12, color: C.slateFaint, fontWeight: 400 }}> / {SCALE_MAX}</span>
                </div>
              </div>
              {!locked && (
                <button onClick={save} disabled={busy || !result.complete}
                  style={{ marginLeft: "auto", fontSize: 14, fontWeight: 600, color: "#fff", background: C.violet, border: "none", borderRadius: 8, padding: "10px 18px", cursor: "pointer", opacity: busy || !result.complete ? 0.45 : 1 }}>
                  {busy ? "Сохранение…" : existing ? "Обновить" : "Сохранить"}
                </button>
              )}
            </div>
            {!result.complete && <div style={{ fontSize: 11.5, color: C.rust, marginTop: 7 }}>Ответьте на все вопросы, чтобы сохранить.</div>}
            {msg && <div style={{ fontSize: 12.5, color: msg === "Сохранено" ? C.positive : C.negative, marginTop: 7 }}>{msg}</div>}
            {result.complete && (
              <div style={{ fontSize: 11, color: C.slateFaint, marginTop: 7, lineHeight: 1.5 }}>
                Объективный блок {result.objective} из {result.objectiveMax}, самооценка {result.subjective} из {result.subjectiveMax}.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================================
// Root
// ============================================================================
// PC Rating идёт первым и открывается по умолчанию: это и есть рейтинг.
// Остальные вкладки — описательная статистика, а не ранжирование.
const TABS = [
  ["pcr", "PC Rating"], ["all", "Всё"], ["tournaments", "Турниры"],
  ["matches", "Матчи"], ["ntrp", "NTRP"],
];

function App() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState("pcr");
  const [sub, setSub] = useState("pcr");       // PC Rating sub-tab: pcr | form
  const [session, setSession] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);

  const embed = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("embed") === "1";

  const load = () => {
    fetch("/api/data").then((r) => r.json()).then(setData).catch((e) => setErr(String(e)));
    fetch("/api/player/session").then((r) => r.json()).then(setSession).catch(() => setSession({ loggedIn: false }));
    fetch("/api/admin/session").then((r) => r.json()).then((s) => setIsAdmin(!!(s && s.authenticated))).catch(() => setIsAdmin(false));
  };
  useEffect(load, []);

  // Хук обязан стоять ДО любых ранних return: React требует одинакового
  // порядка хуков на каждом рендере. Полный пересчёт истории стоит десятки
  // миллисекунд, поэтому он привязан к самим данным, а не к рендеру.
  const pcrRows = useMemo(() => {
    if (!data) return [];
    const rows = computePCR(data);
    rows.calibration = calibrationReport(data, rows);
    return rows;
  }, [data]);

  if (err) return <div style={{ padding: 24, fontFamily: FB, color: C.negative }}>Не удалось загрузить данные: {err}</div>;
  if (!data) return <div style={{ minHeight: "50vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FD, fontSize: 20, color: C.court }}>PadelCom</div>;

  const playersById = {};
  (data.players || []).forEach((p) => { playersById[p.id] = p; });
  const players = (data.players || []).slice().sort((a, b) => fullName(a).localeCompare(fullName(b)));
  const me = session && session.loggedIn ? playersById[session.playerId] : null;


  const scopeOpts = { all: {}, tournaments: { includeMatches: false }, matches: { includeTournaments: false } };
  const shareRows = scopeOpts[tab] ? buildRating(data, scopeOpts[tab]) : [];

  const tournamentMatches = (data.mexicanoTournaments || []).reduce(
    (n, t) => n + (t.rounds || []).reduce((k, r) => k + (r.matches || []).filter((m) => m.score1 != null).length, 0), 0);
  const plainMatches = (data.matchRecords || []).length;

  return (
    <div style={{ fontFamily: FB, color: C.ink, background: C.paper, minHeight: embed ? 0 : "100vh" }}>
      <div style={{ maxWidth: 720, margin: "0 auto", padding: embed ? "2px 2px 28px" : "18px 16px 40px" }}>
        {!embed && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
            <a href="/" style={{ fontFamily: FD, fontWeight: 700, fontSize: 22, color: C.ink, textDecoration: "none" }}>Padel<span style={{ color: C.court }}>Com</span></a>
            <span style={{ fontSize: 12, color: C.slateFaint, borderLeft: `1px solid ${C.rule}`, paddingLeft: 10 }}>Рейтинг</span>
            {isAdmin && <span style={{ fontSize: 10.5, color: C.action, border: `1px solid ${C.action}`, borderRadius: 999, padding: "1px 8px" }}>админ</span>}
          </div>
        )}

        <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
          {TABS.map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} style={{
              fontSize: 13, fontWeight: 600, padding: "7px 13px", borderRadius: 999, cursor: "pointer",
              background: tab === k ? C.ink : C.card, color: tab === k ? "#fff" : C.ink,
              border: `1px solid ${tab === k ? C.ink : C.rule}`,
            }}>{label}</button>
          ))}
        </div>

        {(tab === "all" || tab === "tournaments" || tab === "matches") && (
          <>
            <div style={note}>
              <b>Это статистика, а не рейтинг.</b> Сила соперников здесь не учитывается: тот, кто
              всегда играл против слабых, окажется выше того, кто играл против сильных. Ранжирование —
              на вкладке <b>PC Rating</b>.
              <br /><br />
              <b>Как считается.</b> Доля очков, которую игрок забрал в своих матчах: набранные очки,
              делённые на все разыгранные. В матче 16:8 оба игрока выигравшей пары получают 16 из 24 —
              66,7%. Количество матчей на показатель не влияет. При менее чем {MIN_GAMES_RELIABLE} играх
              значение помечается как неустойчивое. Нажмите на строку, чтобы увидеть расчёт.
            </div>
            <div style={{ fontSize: 11.5, color: C.slateFaint, marginBottom: 8 }}>
              {shareRows.length} игроков · учтено матчей: турниры {tournamentMatches}, «Матчи» {plainMatches}
            </div>
            <ShareTable rows={shareRows} playersById={playersById} showSource={tab === "all"} />
          </>
        )}

        {tab === "ntrp" && <NtrpTable rows={ntrpRows(data)} playersById={playersById} />}

        {tab === "pcr" && (
          <>
            <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
              {[["pcr", "PCR"], ["form", "Анкета"]].map(([k, label]) => (
                <button key={k} onClick={() => setSub(k)} style={{
                  fontSize: 12.5, fontWeight: 600, padding: "6px 14px", borderRadius: 8, cursor: "pointer",
                  background: sub === k ? C.violet : C.card, color: sub === k ? "#fff" : C.ink,
                  border: `1px solid ${sub === k ? C.violet : C.rule}`,
                }}>{label}</button>
              ))}
            </div>
            {sub === "pcr"
              ? <PcrTable rows={pcrRows} playersById={playersById} />
              : <QuestionnaireForm me={me} players={players} isAdmin={isAdmin} onSaved={load} />}
          </>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
