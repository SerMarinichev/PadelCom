import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { buildRating, explainRow, MIN_GAMES_RELIABLE } from "./rating.js";

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

function Avatar({ player, size = 26 }) {
  if (!player) return null;
  const initials = `${(player.firstName || "?")[0] || ""}${(player.lastName || "")[0] || ""}`;
  const base = { width: size, height: size, flex: "0 0 auto", borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center" };
  if (player.photo) return <span style={{ ...base, backgroundImage: `url(${player.photo})`, backgroundSize: "cover", backgroundPosition: "center" }} />;
  return <span style={{ ...base, background: player.gender === "female" ? "#F3DDD5" : "#D8E3F0", color: C.ink, fontSize: size * 0.38, fontWeight: 700 }}>{initials}</span>;
}

const MEDAL = ["#C9A227", "#9BA0A6", "#B07B4F"];

function RatingTable({ rows, playersById, showSource }) {
  const [openId, setOpenId] = useState(null);
  if (rows.length === 0) {
    return (
      <div style={{ background: C.card, border: `1px dashed ${C.rule}`, borderRadius: 12, padding: 24, textAlign: "center", fontSize: 13.5, color: C.slateFaint }}>
        Пока нет сыгранных матчей для расчёта.
      </div>
    );
  }
  return (
    <div style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", padding: "9px 13px", background: C.paperDim, fontSize: 10.5, color: C.slateFaint, textTransform: "uppercase", letterSpacing: "0.05em" }}>
        <span style={{ width: 26 }}>#</span>
        <span style={{ flex: 1 }}>Игрок</span>
        <span style={{ width: 62, textAlign: "right" }}>Рейтинг</span>
        <span style={{ width: 38, textAlign: "right" }}>Игр</span>
        <span style={{ width: 46, textAlign: "right" }}>Побед</span>
      </div>
      {rows.map((r, i) => {
        const p = playersById[r.id];
        const open = openId === r.id;
        return (
          <div key={r.id}>
            <div onClick={() => setOpenId(open ? null : r.id)} style={{
              display: "flex", alignItems: "center", padding: "10px 13px", borderTop: `1px solid ${C.rule}`,
              background: i === 0 && r.reliable ? "#F6FBF8" : C.card, cursor: "pointer",
              opacity: r.reliable ? 1 : 0.65,
            }}>
              <span style={{ width: 26, fontFamily: FONT_MONO, fontSize: 12.5, fontWeight: i < 3 && r.reliable ? 700 : 400, color: i < 3 && r.reliable ? MEDAL[i] : C.slateFaint }}>{i + 1}</span>
              <span style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, minWidth: 0 }}>
                <Avatar player={p} size={26} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p ? fullName(p) : r.id}</span>
                {!r.reliable && <span title={`Меньше ${MIN_GAMES_RELIABLE} игр — показатель пока неустойчив`} style={{ fontSize: 9.5, color: C.rust, border: `1px solid ${C.rust}`, borderRadius: 999, padding: "0 5px", flex: "0 0 auto" }}>мало игр</span>}
              </span>
              <span style={{ width: 62, textAlign: "right", fontFamily: FONT_MONO, fontWeight: 700, fontSize: 14.5 }}>{r.share.toFixed(1)}%</span>
              <span style={{ width: 38, textAlign: "right", fontFamily: FONT_MONO, fontSize: 12, color: C.slateFaint }}>{r.games}</span>
              <span style={{ width: 46, textAlign: "right", fontFamily: FONT_MONO, fontSize: 12, color: C.slateFaint }}>{r.wins}</span>
            </div>
            {open && (
              <div style={{ padding: "10px 13px 13px 65px", background: C.paperDim, fontSize: 12.5, color: C.slate, lineHeight: 1.6, borderTop: `1px solid ${C.rule}` }}>
                <div><b>{explainRow(r)}</b></div>
                <div>Побед {r.wins}, поражений {r.losses}{r.draws > 0 ? `, ничьих ${r.draws}` : ""} — винрейт {r.winRate.toFixed(0)}%</div>
                <div>Разница очков: <span style={{ color: r.diff >= 0 ? C.positive : C.negative, fontFamily: FONT_MONO }}>{r.diff >= 0 ? "+" : ""}{r.diff}</span></div>
                {showSource && (r.tournamentGames > 0 || r.matchGames > 0) && (
                  <div style={{ color: C.slateFaint }}>
                    Источник: турниры — {r.tournamentGames}, раздел «Матчи» — {r.matchGames}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function App() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [scope, setScope] = useState("all");   // all | tournaments | matches

  useEffect(() => {
    fetch("/api/data").then((r) => r.json()).then(setData).catch((e) => setErr(String(e)));
  }, []);

  if (err) return <div style={{ padding: 24, fontFamily: FONT_BODY, color: C.negative }}>Не удалось загрузить данные: {err}</div>;
  if (!data) return <div style={{ minHeight: "60vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT_DISPLAY, fontSize: 22, color: C.court }}>PadelCom</div>;

  const playersById = {};
  (data.players || []).forEach((p) => { playersById[p.id] = p; });

  const opts = {
    all: {},
    tournaments: { includeMatches: false },
    matches: { includeTournaments: false },
  }[scope];
  const rows = buildRating(data, opts);

  const tournaments = data.mexicanoTournaments || [];
  const tournamentNames = tournaments.map((t) => t.name).filter(Boolean);
  const matchCount = (data.matchRecords || []).length;
  const tournamentMatchCount = tournaments.reduce(
    (n, t) => n + (t.rounds || []).reduce((k, r) => k + (r.matches || []).filter((m) => m.score1 !== null && m.score1 !== undefined).length, 0), 0);

  const scopeLabel = {
    all: "по всем сыгранным матчам",
    tournaments: "только по турнирам",
    matches: "только по разделу «Матчи»",
  }[scope];

  return (
    <div style={{ fontFamily: FONT_BODY, color: C.ink, background: C.paper, minHeight: "100vh" }}>
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "18px 16px 40px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
          <a href="/" style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 22, color: C.ink, textDecoration: "none" }}>
            Padel<span style={{ color: C.court }}>Com</span>
          </a>
          <span style={{ fontSize: 12, color: C.slateFaint, borderLeft: `1px solid ${C.rule}`, paddingLeft: 10 }}>Рейтинг</span>
        </div>

        <h2 style={{ fontFamily: FONT_DISPLAY, fontSize: 19, margin: "0 0 4px" }}>
          Рейтинг игроков
        </h2>
        <div style={{ fontSize: 12.5, color: C.slateFaint, marginBottom: 14 }}>
          {tournamentNames.length > 0
            ? <>По результатам турнира{tournamentNames.length > 1 ? "ов" : ""} {tournamentNames.join(", ")} и матчам из раздела «Матчи»</>
            : <>По матчам, заведённым в систему</>}
        </div>

        <div style={{ display: "flex", gap: 7, marginBottom: 14, flexWrap: "wrap" }}>
          {[["all", "Всё"], ["tournaments", "Турниры"], ["matches", "Матчи"]].map(([k, label]) => (
            <button key={k} onClick={() => setScope(k)} style={{
              fontSize: 13, fontWeight: 600, padding: "7px 14px", borderRadius: 999, cursor: "pointer",
              background: scope === k ? C.ink : C.card, color: scope === k ? "#fff" : C.ink,
              border: `1px solid ${scope === k ? C.ink : C.rule}`,
            }}>{label}</button>
          ))}
        </div>

        {/* The formula is stated on the page itself: the first tournament raised
            questions about the results, and a rating nobody can check invites
            more of them. */}
        <div style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 10, padding: "11px 13px", marginBottom: 14, fontSize: 12.5, color: C.slate, lineHeight: 1.55 }}>
          <b>Как считается.</b> Рейтинг — это доля очков, которую игрок забрал в своих матчах:
          набранные очки, делённые на все разыгранные в этих матчах. В матче 16:8 оба игрока
          выигравшей пары получают 16 из 24 — это 66,7%. Количество сыгранных матчей на рейтинг не влияет,
          поэтому редко играющие не в проигрыше. При менее чем {MIN_GAMES_RELIABLE} играх показатель помечается
          как неустойчивый. Нажмите на строку, чтобы увидеть расчёт.
        </div>

        <div style={{ fontSize: 11.5, color: C.slateFaint, marginBottom: 8 }}>
          {rows.length} игроков · {scopeLabel} · учтено матчей: турниры {tournamentMatchCount}, «Матчи» {matchCount}
        </div>

        <RatingTable rows={rows} playersById={playersById} showSource={scope === "all"} />

        <div style={{ fontSize: 11.5, color: C.slateFaint, marginTop: 14, lineHeight: 1.55 }}>
          В турнирах Mexicano и Americano партнёры меняются каждый раунд, поэтому личный вклад виден
          точнее. В разделе «Матчи» пары обычно постоянные — там результат сильнее зависит от партнёра.
          Переключатель выше позволяет посмотреть каждый источник отдельно.
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
