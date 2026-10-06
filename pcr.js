// ============================================================================
// PC Rating — PadelCom community rating
// ============================================================================
// Two stages, same shape as the established padel systems:
//   1. a one-off questionnaire sets a starting level on the familiar 0–7 scale;
//   2. every recorded game pulls that number towards what the player actually
//      shows on court, with the questionnaire's influence fading as evidence
//      accumulates.
//
// The questionnaire is split into objective facts (how long, how often, coached,
// other racket sports, tournaments) and self-assessed technique. Self-assessment
// in padel is documented to run 0.5–1.0 high, so the objective half carries 70%
// of the weight and the subjective half 30%.

export const SCALE_MAX = 7;
export const DEFAULT_LEVEL = 2.5;      // used for players with no data at all
export const INITIAL_WEIGHT = 10;      // questionnaire counts as this many games
export const SENSITIVITY = 3;          // level swing at total domination

export const QUESTIONNAIRE = [
  {
    id: "a1", block: "objective", max: 30,
    q: "Сколько времени вы играете в падел?",
    options: [
      ["Ни разу не играл", 0], ["Меньше 3 месяцев", 3], ["3–6 месяцев", 7],
      ["6–12 месяцев", 12], ["1–2 года", 18], ["2–5 лет", 25], ["Больше 5 лет", 30],
    ],
  },
  {
    id: "a2", block: "objective", max: 20,
    q: "Как часто вы играете сейчас?",
    options: [
      ["Реже раза в месяц", 0], ["1–3 раза в месяц", 4], ["Раз в неделю", 9],
      ["2–3 раза в неделю", 15], ["4 раза в неделю и чаще", 20],
    ],
  },
  {
    id: "a3", block: "objective", max: 15,
    q: "Занимались ли с тренером?",
    options: [
      ["Никогда", 0], ["Несколько разовых занятий", 4],
      ["Регулярно до полугода", 9], ["Регулярно больше года", 15],
    ],
  },
  {
    id: "a4", block: "objective", max: 14,
    q: "Другие ракеточные виды спорта",
    hint: "Теннис, сквош, бадминтон, настольный теннис — переносится техника удара и работа ног",
    options: [
      ["Нет", 0], ["Играл любительски", 4],
      ["Играл регулярно несколько лет", 9], ["Секция или соревнования", 14],
    ],
  },
  {
    id: "a5", block: "objective", max: 28,
    q: "Турнирный опыт в падел",
    options: [
      ["Не играл турниры", 0], ["Любительские, без призовых мест", 6],
      ["Любительские, попадал в призы", 12], ["Открытые городские или клубные", 20],
      ["Региональные и выше", 28],
    ],
  },
  {
    id: "b1", block: "subjective", max: 15,
    q: "Можете ли стабильно держать розыгрыш 10+ ударов?",
    options: [
      ["Нет, мяч теряется раньше", 0], ["Иногда, если темп медленный", 5],
      ["Да, в спокойном темпе уверенно", 10], ["Да, в том числе при высоком темпе", 15],
    ],
  },
  {
    id: "b2", block: "subjective", max: 15,
    q: "Как вы играете от стекла?",
    options: [
      ["Стараюсь не доводить до стены", 0], ["Отбиваю, когда вынужден", 5],
      ["Уверенно играю от задней стены", 10], ["Осознанно использую обе стены", 15],
    ],
  },
  {
    id: "b3", block: "subjective", max: 14,
    q: "Бандеха и вибора",
    options: [
      ["Не знаю, что это", 0], ["Знаю, но не выполняю", 3],
      ["Выполняю бандеху стабильно", 8], ["Владею обоими, выбираю по ситуации", 14],
    ],
  },
  {
    id: "b4", block: "subjective", max: 13,
    q: "Подача и выход к сетке",
    options: [
      ["Подаю, чтобы просто ввести мяч", 0], ["Подаю стабильно, к сетке не всегда", 5],
      ["Подаю с выходом к сетке постоянно", 9], ["Варьирую направление и вращение", 13],
    ],
  },
  {
    id: "b5", block: "subjective", max: 15,
    q: "Тактика и игра в паре",
    options: [
      ["Играю по мячу, о позиции не думаю", 0], ["Понимаю базовое построение", 5],
      ["Двигаемся синхронно, закрываем середину", 10], ["Строю розыгрыш, играю на слабого", 15],
    ],
  },
];

const MAX_OBJECTIVE = QUESTIONNAIRE.filter((q) => q.block === "objective").reduce((s, q) => s + q.max, 0);
const MAX_SUBJECTIVE = QUESTIONNAIRE.filter((q) => q.block === "subjective").reduce((s, q) => s + q.max, 0);

// answers: { a1: <index>, a2: <index>, ... }
export function scoreQuestionnaire(answers) {
  let obj = 0, subj = 0, answered = 0;
  QUESTIONNAIRE.forEach((q) => {
    const idx = answers ? answers[q.id] : undefined;
    if (idx === undefined || idx === null) return;
    const opt = q.options[idx];
    if (!opt) return;
    answered += 1;
    if (q.block === "objective") obj += opt[1]; else subj += opt[1];
  });
  const objPct = MAX_OBJECTIVE ? obj / MAX_OBJECTIVE : 0;
  const subjPct = MAX_SUBJECTIVE ? subj / MAX_SUBJECTIVE : 0;
  let level = (0.7 * objPct + 0.3 * subjPct) * SCALE_MAX;

  // Correction for the documented self-assessment bias: players past their
  // first months overstate, genuine beginners understate.
  const experience = answers ? answers.a1 : undefined;
  const isNewcomer = experience !== undefined && experience <= 2;   // under 6 months
  level += isNewcomer ? 0.2 : -0.3;

  level = Math.max(0, Math.min(SCALE_MAX, level));
  return {
    level: Math.round(level * 2) / 2,          // nearest 0.5
    raw: level,
    objective: obj, subjective: subj,
    objectiveMax: MAX_OBJECTIVE, subjectiveMax: MAX_SUBJECTIVE,
    answered, total: QUESTIONNAIRE.length,
    complete: answered === QUESTIONNAIRE.length,
  };
}

// ---------------------------------------------------------------------------
// Every scored game, in chronological order, as a flat list
// ---------------------------------------------------------------------------
export function collectGames(data) {
  const games = [];

  (data.mexicanoTournaments || []).forEach((t) => {
    (t.rounds || []).forEach((round, ri) => {
      (round.matches || []).forEach((m) => {
        if (m.score1 == null || m.score2 == null) return;
        const s1 = Number(m.score1) || 0, s2 = Number(m.score2) || 0;
        if (s1 + s2 === 0) return;
        games.push({
          date: t.date || t.createdAt || "", source: "tournament",
          sideA: m.team1 || [], sideB: m.team2 || [], scoreA: s1, scoreB: s2,
          label: `${t.name || "Турнир"}, раунд ${ri + 1}`,
        });
      });
    });
  });

  (data.matchRecords || []).forEach((m) => {
    if (m.score1 == null || m.score2 == null) return;
    const s1 = Number(m.score1) || 0, s2 = Number(m.score2) || 0;
    if (s1 + s2 === 0) return;
    games.push({
      date: m.date || "", source: "match",
      sideA: m.participant1 || [], sideB: m.participant2 || [], scoreA: s1, scoreB: s2,
      label: "Матч",
    });
  });

  games.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return games;
}

// Starting point for each player: questionnaire if they filled one in,
// otherwise their self-declared NTRP, otherwise the middle of the scale.
export function initialLevels(data) {
  const out = {};
  (data.players || []).forEach((p) => {
    const q = p.pcrQuestionnaire;
    if (q && q.level != null) { out[p.id] = { level: Number(q.level), source: "анкета" }; return; }
    const self = parseFloat(p.level);
    if (!isNaN(self)) { out[p.id] = { level: self, source: "саморейтинг NTRP" }; return; }
    out[p.id] = { level: DEFAULT_LEVEL, source: "по умолчанию" };
  });
  return out;
}

// ---------------------------------------------------------------------------
// The rating itself
// ---------------------------------------------------------------------------
// Expected share of the points for side A, from the two sides' current levels.
// A one-level gap predicts roughly 68% of the points, two levels roughly 82% —
// steep enough to be meaningful, flat enough that a single thrashing doesn't
// imply an absurd gap.
const SPREAD = 3;
function expectedShare(avgA, avgB) {
  return 1 / (1 + Math.pow(10, -(avgA - avgB) / SPREAD));
}

// How far a single game is allowed to move someone. Large while the system
// barely knows them, shrinking as their record builds — the same idea as the
// reliability percentage the established platforms expose.
const K0 = 0.75;
const stepFor = (gamesSoFar) => K0 * (INITIAL_WEIGHT / (INITIAL_WEIGHT + gamesSoFar));

const clampLevel = (v) => Math.max(0, Math.min(SCALE_MAX, v));
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// Ratings are walked forward game by game rather than solved algebraically.
// The earlier approach inferred each player's level by subtracting their
// partner's, which made teammates compete for the same credit and oscillated
// instead of settling. Nudging everyone towards whatever the result actually
// was converges by construction, and it gives an honest chronological history
// for free — which is what the weekly view needs anyway.
export function computePCR(data) {
  const init = initialLevels(data);
  const ratings = {};
  Object.entries(init).forEach(([id, v]) => { ratings[id] = v.level; });

  const played = {};
  const history = {};
  const games = collectGames(data);

  games.forEach((g, gi) => {
    if (!g.sideA.length || !g.sideB.length) return;
    const total = g.scoreA + g.scoreB;
    if (!total) return;

    const lv = (id) => (ratings[id] != null ? ratings[id] : DEFAULT_LEVEL);
    const avgA = mean(g.sideA.map(lv));
    const avgB = mean(g.sideB.map(lv));
    const shareA = g.scoreA / total;
    // error is symmetric: side B's is exactly the negative of side A's
    const errA = shareA - expectedShare(avgA, avgB);

    const apply = (ids, err) => ids.forEach((id) => {
      if (ratings[id] == null) ratings[id] = DEFAULT_LEVEL;
      const before = ratings[id];
      const step = stepFor(played[id] || 0);
      const after = clampLevel(before + step * err * 2);
      ratings[id] = after;
      played[id] = (played[id] || 0) + 1;
      (history[id] = history[id] || []).push({
        index: gi, game: g,
        before: Math.round(before * 100) / 100,
        rating: Math.round(after * 100) / 100,
        delta: Math.round((after - before) * 100) / 100,
      });
    });

    apply(g.sideA, errA);
    apply(g.sideB, -errA);
  });

  const rows = Object.keys(init).map((pid) => {
    const list = history[pid] || [];
    return {
      id: pid,
      rating: Math.round((ratings[pid] != null ? ratings[pid] : init[pid].level) * 100) / 100,
      initial: init[pid].level,
      initialSource: init[pid].source,
      games: list.length,
      reliability: list.length / (list.length + INITIAL_WEIGHT),
      change: Math.round(((ratings[pid] != null ? ratings[pid] : init[pid].level) - init[pid].level) * 100) / 100,
      history: list,
    };
  });
  rows.sort((a, b) => b.rating - a.rating);
  return rows;
}

// ---------------------------------------------------------------------------
// Weekly movement
// ---------------------------------------------------------------------------
const isoWeekKey = (dateStr) => {
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
};

const weekLabel = (dateStr) => {
  const d = new Date(dateStr);
  if (isNaN(d)) return "";
  const day = d.getUTCDay() || 7;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - day + 1);
  return `${String(monday.getUTCDate()).padStart(2, "0")}.${String(monday.getUTCMonth() + 1).padStart(2, "0")}`;
};

// Replays one player's games week by week, so the page can show what the rating
// was at the end of each week and how much it moved.
export function weeklySeries(row) {
  if (!row || !row.history || row.history.length === 0) return [];
  const buckets = new Map();
  row.history.forEach((h) => {
    const k = isoWeekKey(h.game.date) || "—";
    if (!buckets.has(k)) {
      buckets.set(k, { key: k, label: weekLabel(h.game.date), games: 0, start: h.before, end: h.rating });
    }
    const b = buckets.get(k);
    b.games += 1;
    b.end = h.rating;            // the week closes on the last game played in it
  });
  return [...buckets.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((b) => ({
      key: b.key, label: b.label, games: b.games,
      rating: Math.round(b.end * 100) / 100,
      delta: Math.round((b.end - b.start) * 100) / 100,
    }));
}

// ---------------------------------------------------------------------------
// NTRP view: what players said about themselves vs what others said about them
// ---------------------------------------------------------------------------
export function ntrpRows(data) {
  return (data.players || []).map((p) => {
    const ratings = Object.values(p.levelRatings || {}).map(Number).filter((n) => !isNaN(n));
    const peer = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;
    const self = parseFloat(p.level);
    return {
      id: p.id,
      self: isNaN(self) ? null : self,
      peer: peer == null ? null : Math.round(peer * 100) / 100,
      peerCount: ratings.length,
    };
  }).sort((a, b) => {
    const av = a.peer != null ? a.peer : (a.self != null ? a.self : -1);
    const bv = b.peer != null ? b.peer : (b.self != null ? b.self : -1);
    return bv - av;
  });
}
