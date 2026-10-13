// ============================================================================
// PC Rating — рейтинг сообщества PadelCom
// ============================================================================
// Модель: Elo с поправкой на счёт (margin of victory) + glicko-подобная
// неопределённость (RD) + многопроходный пересчёт всей истории.
//
// Что считается и почему именно так:
//
//  1. ШКАЛА. Рейтинг живёт в очках Elo (старт 1500). Уровень 0–7 — производная
//     величина: level = 2.5 + (Elo − 1500)/300. Турнирный движок и посев
//     работают с уровнем, пользователь видит очки — у очков заметная динамика,
//     у уровня она тонет в округлении до 0.5.
//
//  2. ПАРА. Рейтинг пары = среднее рейтингов партнёров. Это стандарт для парных
//     видов: альтернатива (взвешивать сильного партнёра выше) требует данных,
//     которых у любительского сообщества нет.
//
//  3. СЧЁТ. Предсказывается не вероятность победы, а ДОЛЯ очков. Матч до 24 даёт
//     гораздо больше информации, чем бинарный исход: 24:22 и 24:4 — разные
//     события. SHARE_SPREAD откалиброван так, что разрыв в один уровень (300 Elo)
//     соответствует примерно 24:12, полуровня — примерно 24:17.
//
//  4. НЕОПРЕДЕЛЁННОСТЬ (RD). Новый игрок двигается быстро, устоявшийся — медленно.
//     RD падает с каждым матчем и растёт при простое, поэтому вернувшийся после
//     перерыва снова подстраивается быстрее. Это заменяет прежний фиксированный
//     коэффициент затухания, который не умел возвращать подвижность.
//
//  5. ВЕС МАТЧА. Матч до 32 информативнее матча до 12 — вес пропорционален длине.
//     Размер турнира даёт небольшую надбавку (0.85→1.00 от 4 до 16 участников):
//     в большом поле состав соперников разнообразнее и единичное совпадение
//     меньше искажает картину. Это осознанное допущение, а не вывод из
//     статистики — эффект намеренно сделан слабым.
//
//  6. МНОГОПРОХОДНОСТЬ. Последовательный проход по истории страдает тем, что
//     ранние матчи обсчитываются против заведомо плохих оценок соперников.
//     История прогоняется заново столько раз, сколько нужно, чтобы очередной
//     проход перестал что-либо менять (PASS_TOLERANCE), но не больше PASSES_MAX.
//     Это поиск неподвижной точки: порядок матчей перестаёт влиять на итог.
//
//  7. ЯКОРЬ ШКАЛЫ. Elo по природе определяет только РАЗНИЦУ между игроками:
//     прибавьте всем 500 очков — все предсказания останутся прежними. Поэтому
//     после пересчёта вся шкала сдвигается так, чтобы средний рейтинг зачётных
//     игроков совпал со средним их стартовых оценок (анкета / саморейтинг).
//     Разницы между игроками при этом не меняются ни на очко, но абсолютный
//     уровень перестаёт уплывать и остаётся сопоставимым с анкетной шкалой 0–7.
//
//  8. ПОРОГ. Игроки менее MIN_RATED_GAMES матчей в зачёт не идут — их оценка
//     определяется анкетой, а не игрой, и ставить её в один ряд с остальными
//     некорректно. Такие строки отдаются отдельно (`provisional`).
//
// Ограничения модели, о которых стоит помнить:
//  — Личный вклад в парной игре не наблюдаем. Если игрок всегда выходит с одним
//    и тем же партнёром, разделить их силу нечем, и оба сойдутся к среднему
//    пары. Mexicano/Americano с ротацией эту проблему снимает, обычные матчи — нет.
//  — Анкета задаёт только стартовую точку. При 10+ матчах её влияние
//    практически исчезает.
//  — Рейтинг сопоставим внутри сообщества и не переносится на внешние шкалы.

export const SCALE_MAX = 7;
export const DEFAULT_LEVEL = 2.5;
export const MIN_RATED_GAMES = 2;      // меньше — в зачёт не идёт

// --- шкала -----------------------------------------------------------------
export const ELO_BASE = 1500;          // соответствует уровню DEFAULT_LEVEL
export const ELO_PER_LEVEL = 300;      // 1.0 уровня = 300 очков
export const ELO_FLOOR = ELO_BASE + (0 - DEFAULT_LEVEL) * ELO_PER_LEVEL;          // 750
export const ELO_CEIL = ELO_BASE + (SCALE_MAX - DEFAULT_LEVEL) * ELO_PER_LEVEL;   // 2850

export const eloToLevel = (elo) => clamp(2.5 + (elo - ELO_BASE) / ELO_PER_LEVEL, 0, SCALE_MAX);
export const levelToElo = (level) => ELO_BASE + (level - DEFAULT_LEVEL) * ELO_PER_LEVEL;

// --- параметры модели ------------------------------------------------------
const SHARE_SPREAD = 1000;   // 300 очков разницы → ~0.67 доли очков
const K_BASE = 300;          // очков Elo на единицу ошибки доли, при RD = RD_REF
const RD_REF = 150;
const RD_MIN = 70;
const RD_MAX = 350;
const RD_START_QUESTIONNAIRE = 200;  // анкета заполнена — старт точнее
const RD_START_SELF = 280;           // только саморейтинг NTRP
const RD_START_BLANK = RD_MAX;       // ничего не известно
const RD_SHRINK = 0.06;             // доля, на которую RD сжимается за матч (RD_MIN ≈ 26 матчей)
const RD_DRIFT_PER_WEEK = 12;        // рост RD за неделю простоя
const K_MIN_FACTOR = 0.35;
const K_MAX_FACTOR = 2.60;
const PASSES_MAX = 30;               // верхний предел проходов пересчёта
const PASS_TOLERANCE = 2;            // останов, когда проход двигает всех меньше чем на столько очков
const SEED_EVIDENCE = 5;             // матчей, при которых повторный посев наполовину доверяет прошлому проходу

export const INITIAL_WEIGHT = 10;    // анкета ≈ столько матчей (для «надёжности»)

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clampElo = (v) => clamp(v, ELO_FLOOR, ELO_CEIL);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const r2 = (v) => Math.round(v * 100) / 100;

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

  // Поправка на документированное смещение самооценки: игроки после первых
  // месяцев завышают, настоящие новички занижают.
  const experience = answers ? answers.a1 : undefined;
  const isNewcomer = experience !== undefined && experience <= 2;   // до полугода
  level += isNewcomer ? 0.2 : -0.3;

  level = clamp(level, 0, SCALE_MAX);
  return {
    level: Math.round(level * 2) / 2,
    raw: level,
    objective: obj, subjective: subj,
    objectiveMax: MAX_OBJECTIVE, subjectiveMax: MAX_SUBJECTIVE,
    answered, total: QUESTIONNAIRE.length,
    complete: answered === QUESTIONNAIRE.length,
  };
}

// ---------------------------------------------------------------------------
// Все сыгранные матчи в хронологическом порядке, плоским списком
// ---------------------------------------------------------------------------
export function collectGames(data) {
  const games = [];

  (data.mexicanoTournaments || []).forEach((t) => {
    // Выбывшие по ходу турнира входят в размер поля: они реально играли.
    const fieldSize = (t.playerIds || []).length;
    const format = t.format === "americano" ? "americano" : "mexicano";
    const target = Number(t.pointsPerMatch) || null;
    (t.rounds || []).forEach((round, ri) => {
      (round.matches || []).forEach((m) => {
        if (m.score1 == null || m.score2 == null) return;
        const s1 = Number(m.score1) || 0, s2 = Number(m.score2) || 0;
        if (s1 + s2 === 0) return;
        games.push({
          date: t.date || t.createdAt || "", source: "tournament",
          sideA: m.team1 || [], sideB: m.team2 || [], scoreA: s1, scoreB: s2,
          fieldSize, format, target,
          tournamentId: t.id, round: ri + 1,
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
      fieldSize: null, format: "match", target: null,
      label: "Матч",
    });
  });

  // Стабильная сортировка: дата, затем турнир и раунд, чтобы порядок внутри дня
  // был воспроизводим от запуска к запуску.
  games.sort((a, b) => String(a.date).localeCompare(String(b.date))
    || String(a.tournamentId || "").localeCompare(String(b.tournamentId || ""))
    || (a.round || 0) - (b.round || 0));
  return games;
}

// Стартовая точка: анкета → саморейтинг NTRP → середина шкалы.
// Источник задаёт и стартовую неопределённость: чем меньше известно, тем
// быстрее игрок будет двигаться по первым матчам.
export function initialLevels(data) {
  const out = {};
  (data.players || []).forEach((p) => {
    const q = p.pcrQuestionnaire;
    if (q && q.level != null) {
      out[p.id] = { level: Number(q.level), source: "анкета", rd: RD_START_QUESTIONNAIRE };
      return;
    }
    const self = parseFloat(p.level);
    if (!isNaN(self)) {
      out[p.id] = { level: self, source: "саморейтинг NTRP", rd: RD_START_SELF };
      return;
    }
    out[p.id] = { level: DEFAULT_LEVEL, source: "по умолчанию", rd: RD_START_BLANK };
  });
  return out;
}

// ---------------------------------------------------------------------------
// Ядро модели
// ---------------------------------------------------------------------------
// Ожидаемая доля очков стороны A. Логистика по разнице рейтингов пар, но с
// гораздо более пологим наклоном, чем у классического Elo: Elo предсказывает
// вероятность победы, здесь предсказывается доля розыгрышей, а она по природе
// заметно ближе к 0.5.
function expectedShare(eloA, eloB) {
  return 1 / (1 + Math.pow(10, -(eloA - eloB) / SHARE_SPREAD));
}

// Информативность матча: длина розыгранной дистанции плюс слабая надбавка за
// размер турнирного поля.
function matchWeight(g) {
  const total = g.scoreA + g.scoreB;
  const reference = g.target || 24;
  const lengthW = clamp(total / reference, 0.35, 1.15);
  let fieldW = 1;
  if (g.fieldSize != null && g.fieldSize > 0) {
    fieldW = 0.85 + 0.15 * clamp((g.fieldSize - 4) / 12, 0, 1);
  }
  return lengthW * fieldW;
}

const weeksBetween = (fromISO, toISO) => {
  if (!fromISO || !toISO) return 0;
  const a = new Date(fromISO), b = new Date(toISO);
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.max(0, (b - a) / (7 * 86400000));
};

// Один хронологический проход по всей истории.
function runPass(games, seedElo, seedRd) {
  const elo = { ...seedElo };
  const rd = { ...seedRd };
  const played = {};
  const lastDate = {};
  const history = {};

  games.forEach((g, gi) => {
    if (!g.sideA.length || !g.sideB.length) return;
    const total = g.scoreA + g.scoreB;
    if (!total) return;

    const everyone = [...g.sideA, ...g.sideB];
    everyone.forEach((id) => {
      if (elo[id] == null) { elo[id] = ELO_BASE; rd[id] = RD_START_BLANK; }
      // Простой возвращает подвижность: RD растёт со временем без игр.
      const wks = weeksBetween(lastDate[id], g.date);
      if (wks > 0) {
        rd[id] = clamp(Math.sqrt(rd[id] * rd[id] + RD_DRIFT_PER_WEEK * RD_DRIFT_PER_WEEK * wks), RD_MIN, RD_MAX);
      }
    });

    const avgA = mean(g.sideA.map((id) => elo[id]));
    const avgB = mean(g.sideB.map((id) => elo[id]));
    const shareA = g.scoreA / total;
    const expA = expectedShare(avgA, avgB);
    const errA = shareA - expA;          // ошибка симметрична: у B ровно −errA
    const w = matchWeight(g);

    const apply = (ids, err, isA) => ids.forEach((id) => {
      const before = elo[id];
      const kFactor = clamp(rd[id] / RD_REF, K_MIN_FACTOR, K_MAX_FACTOR);
      const delta = K_BASE * kFactor * w * err;
      const after = clampElo(before + delta);
      elo[id] = after;
      rd[id] = clamp(rd[id] * (1 - RD_SHRINK * w), RD_MIN, RD_MAX);
      played[id] = (played[id] || 0) + 1;
      lastDate[id] = g.date;
      (history[id] = history[id] || []).push({
        index: gi,
        game: g,
        before: Math.round(before),
        elo: Math.round(after),
        delta: Math.round(after - before),
        rating: r2(eloToLevel(after)),
        expected: r2(isA ? expA : 1 - expA),
        share: r2(isA ? shareA : 1 - shareA),
        weight: r2(w),
        rd: Math.round(rd[id]),
      });
    });

    apply(g.sideA, errA, true);
    apply(g.sideB, -errA, false);
  });

  return { elo, rd, played, history };
}

// Многопроходный пересчёт. Проход 1 стартует с анкетных оценок; каждый
// следующий — с результатов предыдущего, слегка подтянутых обратно к анкете
// (SEED_BLEND), чтобы итерация не раскачивала шкалу. RD на каждом проходе
// сбрасывается к стартовому: иначе к пятому проходу все были бы «уверенными»
// и модель перестала бы реагировать.
export function computePCR(data, opts = {}) {
  const passes = opts.passes || PASSES_MAX;
  const tolerance = opts.tolerance != null ? opts.tolerance : PASS_TOLERANCE;
  const init = initialLevels(data);
  const games = collectGames(data);

  const seedElo = {};
  const seedRd = {};
  Object.entries(init).forEach(([id, v]) => {
    seedElo[id] = clampElo(levelToElo(v.level));
    seedRd[id] = v.rd;
  });
  const anchorElo = { ...seedElo };

  let result = null;
  let passesUsed = 0;
  const convergence = [];
  for (let p = 0; p < passes; p += 1) {
    const prev = result;
    result = runPass(games, seedElo, { ...seedRd });
    if (prev) {
      const ids = Object.keys(result.elo).filter((id) => (result.played[id] || 0) > 0);
      const maxShift = ids.length
        ? Math.max(...ids.map((id) => Math.abs(result.elo[id] - prev.elo[id])))
        : 0;
      const shift = Math.round(maxShift);
      convergence.push(shift);
      // Итерация — поиск неподвижной точки: когда очередной проход перестаёт
      // что-либо менять, дальше считать нечего.
      if (shift <= tolerance) { passesUsed = p + 1; break; }
    }
    passesUsed = p + 1;
    if (p < passes - 1) {
      // Повторный посев взвешен по объёму сыгранного. Без этого игрок с одним
      // матчем разгоняется от прохода к проходу: его единственный результат
      // применяется заново поверх уже сдвинутой оценки, и итерация сходится к
      // рейтингу, который идеально объясняет ровно один матч. При весе n/(n+5)
      // новичок почти целиком возвращается к анкете, а тот, у кого матчей
      // много, переносит накопленную оценку дальше.
      Object.keys(result.elo).forEach((id) => {
        const anchor = anchorElo[id] != null ? anchorElo[id] : ELO_BASE;
        const n = result.played[id] || 0;
        const w = n / (n + SEED_EVIDENCE);
        seedElo[id] = w * result.elo[id] + (1 - w) * anchor;
      });
    }
  }

  // Закрепление шкалы (см. п. 7). Сдвиг общий для всех, поэтому ни одна
  // разница между игроками не меняется — двигается только нулевая отметка.
  const ratedIds = Object.keys(result.elo).filter((id) => (result.played[id] || 0) >= MIN_RATED_GAMES);
  let scaleShift = 0;
  if (ratedIds.length) {
    const meanNow = mean(ratedIds.map((id) => result.elo[id]));
    const meanSeed = mean(ratedIds.map((id) => (anchorElo[id] != null ? anchorElo[id] : ELO_BASE)));
    scaleShift = meanSeed - meanNow;
    Object.keys(result.elo).forEach((id) => { result.elo[id] = clampElo(result.elo[id] + scaleShift); });
    Object.values(result.history).forEach((list) => list.forEach((h) => {
      h.before = Math.round(h.before + scaleShift);
      h.elo = Math.round(h.elo + scaleShift);
      h.rating = r2(eloToLevel(h.elo));
    }));
  }

  const ids = new Set([...Object.keys(init), ...Object.keys(result.elo)]);
  const rows = [...ids].map((pid) => {
    const list = result.history[pid] || [];
    const startElo = anchorElo[pid] != null ? anchorElo[pid] : ELO_BASE;
    const finalElo = result.elo[pid] != null ? result.elo[pid] : startElo;
    const n = list.length;
    const wins = list.filter((h) => h.share > 0.5).length;
    const pointsFor = list.reduce((s, h) => s + (h.game.sideA.includes(pid) ? h.game.scoreA : h.game.scoreB), 0);
    const pointsAgainst = list.reduce((s, h) => s + (h.game.sideA.includes(pid) ? h.game.scoreB : h.game.scoreA), 0);
    return {
      id: pid,
      elo: Math.round(finalElo),
      rating: r2(eloToLevel(finalElo)),       // уровень 0–7, им пользуется движок турниров
      startElo: Math.round(startElo),
      initial: init[pid] ? init[pid].level : DEFAULT_LEVEL,
      initialSource: init[pid] ? init[pid].source : "по умолчанию",
      change: Math.round(finalElo - startElo),
      games: n,
      rated: n >= MIN_RATED_GAMES,
      rd: Math.round(result.rd[pid] != null ? result.rd[pid] : RD_START_BLANK),
      // Надёжность: от RD, а не от числа матчей — она учитывает и простои.
      reliability: clamp((RD_MAX - (result.rd[pid] != null ? result.rd[pid] : RD_START_BLANK)) / (RD_MAX - RD_MIN), 0, 1),
      wins,
      losses: n - wins,
      pointsFor, pointsAgainst,
      pointShare: pointsFor + pointsAgainst ? r2(pointsFor / (pointsFor + pointsAgainst)) : null,
      history: list,
    };
  });

  // Зачётные сверху по рейтингу, незачётные (менее MIN_RATED_GAMES матчей)
  // всегда ниже — чтобы новичок с одной случайной победой не возглавлял таблицу.
  rows.sort((a, b) => (b.rated - a.rated) || (b.elo - a.elo));
  rows.convergence = convergence;
  rows.scaleShift = Math.round(scaleShift);
  rows.passesUsed = passesUsed;
  // Опорная дата для «движения за месяц». Берётся последняя игра в базе, а не
  // текущее число: у сезонного сообщества окно от сегодняшнего дня почти всегда
  // пустое, и колонка динамики превращается в столбец прочерков.
  rows.lastGameDate = games.length ? games[games.length - 1].date : null;
  rows.converged = convergence.length > 0 && convergence[convergence.length - 1] <= tolerance;
  rows.gamesCount = games.length;
  return rows;
}

// Только зачётные строки — то, что показывается как рейтинг-лист.
export function ratedRows(rows) {
  return rows.filter((r) => r.rated);
}

// ---------------------------------------------------------------------------
// Динамика
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

// Понедельное движение: чем рейтинг закрыл неделю и насколько сдвинулся.
export function weeklySeries(row) {
  if (!row || !row.history || row.history.length === 0) return [];
  const buckets = new Map();
  row.history.forEach((h) => {
    const k = isoWeekKey(h.game.date) || "—";
    if (!buckets.has(k)) {
      buckets.set(k, { key: k, label: weekLabel(h.game.date), games: 0, start: h.before, end: h.elo });
    }
    const b = buckets.get(k);
    b.games += 1;
    b.end = h.elo;
  });
  return [...buckets.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((b) => ({
      key: b.key, label: b.label, games: b.games,
      elo: Math.round(b.end),
      rating: r2(eloToLevel(b.end)),
      delta: Math.round(b.end - b.start),
    }));
}

// Сдвиг за последние N дней — то, что показывается стрелкой в таблице.
export function recentChange(row, days = 30, now = new Date()) {
  if (!row || !row.history || !row.history.length) return null;
  const ref = now instanceof Date ? now : new Date(now);
  if (isNaN(ref)) return null;
  const cutoff = new Date(ref.getTime() - days * 86400000);
  const inWindow = row.history.filter((h) => {
    const d = new Date(h.game.date);
    return !isNaN(d) && d >= cutoff;
  });
  if (!inWindow.length) return { delta: 0, games: 0 };
  return {
    delta: Math.round(inWindow[inWindow.length - 1].elo - inWindow[0].before),
    games: inWindow.length,
  };
}

// Личные встречи: с кем играл в паре и против кого, с каким результатом.
// Это та самая «игра всех со всеми», на которой держится рейтинг — таблица
// показывает, на каких именно матчах он построен.
export function headToHead(rows, playerId) {
  const row = rows.find((r) => r.id === playerId);
  if (!row) return { partners: [], opponents: [] };
  const partners = new Map();
  const opponents = new Map();
  const bump = (map, id, won, pf, pa) => {
    if (!map.has(id)) map.set(id, { id, games: 0, wins: 0, pointsFor: 0, pointsAgainst: 0 });
    const e = map.get(id);
    e.games += 1;
    if (won) e.wins += 1;
    e.pointsFor += pf;
    e.pointsAgainst += pa;
  };
  row.history.forEach((h) => {
    const g = h.game;
    const mine = g.sideA.includes(playerId) ? g.sideA : g.sideB;
    const theirs = g.sideA.includes(playerId) ? g.sideB : g.sideA;
    const pf = g.sideA.includes(playerId) ? g.scoreA : g.scoreB;
    const pa = g.sideA.includes(playerId) ? g.scoreB : g.scoreA;
    const won = pf > pa;
    mine.filter((id) => id !== playerId).forEach((id) => bump(partners, id, won, pf, pa));
    theirs.forEach((id) => bump(opponents, id, won, pf, pa));
  });
  const fin = (m) => [...m.values()].sort((a, b) => b.games - a.games);
  return { partners: fin(partners), opponents: fin(opponents) };
}

// ---------------------------------------------------------------------------
// Калибровка: проверка главного допущения модели на реальных данных
// ---------------------------------------------------------------------------
// SHARE_SPREAD задан из общих соображений (разрыв в уровень ≈ 24:12), а не
// выведен из статистики сообщества. Эта функция сопоставляет предсказанную долю
// очков с фактической по корзинам разницы рейтингов. Если наблюдаемая колонка
// систематически круче предсказанной — SHARE_SPREAD надо уменьшать, если
// положе — увеличивать. Пересчитывать стоит раз в несколько месяцев, когда
// наберётся хотя бы несколько сотен матчей.
export function calibrationReport(data, rows) {
  const by = {};
  (rows || computePCR(data)).forEach((r) => { by[r.id] = r.elo; });
  const games = collectGames(data);
  const bins = [
    { lo: 0, hi: 75, label: "0–75" }, { lo: 75, hi: 150, label: "75–150" },
    { lo: 150, hi: 300, label: "150–300" }, { lo: 300, hi: 500, label: "300–500" },
    { lo: 500, hi: Infinity, label: "500+" },
  ].map((b) => ({ ...b, n: 0, obs: 0, exp: 0 }));

  games.forEach((g) => {
    if (!g.sideA.length || !g.sideB.length) return;
    const total = g.scoreA + g.scoreB;
    if (!total) return;
    const has = [...g.sideA, ...g.sideB].every((id) => by[id] != null);
    if (!has) return;
    const avgA = mean(g.sideA.map((id) => by[id]));
    const avgB = mean(g.sideB.map((id) => by[id]));
    // смотрим всегда со стороны ФАВОРИТА, иначе корзины схлопываются к 0.5
    const gap = Math.abs(avgA - avgB);
    const favShare = avgA >= avgB ? g.scoreA / total : g.scoreB / total;
    const bin = bins.find((b) => gap >= b.lo && gap < b.hi);
    if (!bin) return;
    bin.n += 1;
    bin.obs += favShare;
    bin.exp += expectedShare(Math.max(avgA, avgB), Math.min(avgA, avgB));
  });

  return bins.filter((b) => b.n > 0).map((b) => ({
    label: b.label, games: b.n,
    observed: r2(b.obs / b.n),
    predicted: r2(b.exp / b.n),
    gap: r2(b.obs / b.n - b.exp / b.n),
  }));
}

// ---------------------------------------------------------------------------
// NTRP: что игроки сказали о себе против того, что сказали о них другие
// ---------------------------------------------------------------------------
export function ntrpRows(data) {
  return (data.players || []).map((p) => {
    const ratings = Object.values(p.levelRatings || {}).map(Number).filter((n) => !isNaN(n));
    const peer = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;
    const self = parseFloat(p.level);
    return {
      id: p.id,
      self: isNaN(self) ? null : self,
      peer: peer == null ? null : r2(peer),
      peerCount: ratings.length,
    };
  }).sort((a, b) => {
    const av = a.peer != null ? a.peer : (a.self != null ? a.self : -1);
    const bv = b.peer != null ? b.peer : (b.self != null ? b.self : -1);
    return bv - av;
  });
}
