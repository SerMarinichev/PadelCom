// Валидация рейтинговой модели: игроки с ЗАРАНЕЕ ИЗВЕСТНОЙ силой, матчи
// симулируются из этой силы, модель должна её восстановить, не зная её.
import { computePCR, ratedRows, eloToLevel, levelToElo, recentChange, weeklySeries, headToHead } from "./pcr.js";

// --- детерминированный ГСЧ, чтобы прогон был воспроизводим -----------------
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

// Истинная сила в тех же очках Elo, что и модель
const TRUE = {};
const N = 14;
for (let i = 0; i < N; i += 1) {
  // равномерно от уровня 2.0 до 5.5
  TRUE[`p${i}`] = levelToElo(2.0 + (3.5 * i) / (N - 1));
}
const ids = Object.keys(TRUE);

// Симуляция матча: доля очков из той же логистики, что в модели, плюс шум
const SPREAD = 1000;
function simulate(sideA, sideB, target) {
  const avg = (s) => s.reduce((a, id) => a + TRUE[id], 0) / s.length;
  const p = 1 / (1 + Math.pow(10, -(avg(sideA) - avg(sideB)) / SPREAD));
  // биномиальная гонка до target с шумом исполнения
  let a = 0, b = 0;
  const noisy = Math.max(0.05, Math.min(0.95, p + (rnd() - 0.5) * 0.10));
  while (a < target && b < target) { if (rnd() < noisy) a += 1; else b += 1; }
  return [a, b];
}

// --- строим историю: турниры Mexicano/Americano с ротацией ----------------
function buildData(nTournaments, roundsEach, target, courts) {
  const players = ids.map((id) => ({ id, firstName: id, lastName: "", level: null }));
  const tournaments = [];
  for (let t = 0; t < nTournaments; t += 1) {
    const day = new Date(Date.UTC(2026, 0, 5 + t * 7)).toISOString().slice(0, 10);
    const rounds = [];
    for (let r = 0; r < roundsEach; r += 1) {
      // случайная ротация: перемешиваем и режем по кортам
      const pool = [...ids].sort(() => rnd() - 0.5).slice(0, courts * 4);
      const matches = [];
      for (let c = 0; c < courts; c += 1) {
        const four = pool.slice(c * 4, c * 4 + 4);
        const team1 = [four[0], four[3]], team2 = [four[1], four[2]];
        const [s1, s2] = simulate(team1, team2, target);
        matches.push({ team1, team2, score1: s1, score2: s2 });
      }
      rounds.push({ matches });
    }
    tournaments.push({
      id: `t${t}`, name: `Турнир ${t + 1}`, date: day,
      format: t % 2 ? "americano" : "mexicano",
      pointsPerMatch: target, playerIds: ids, rounds,
    });
  }
  return { players, mexicanoTournaments: tournaments, matchRecords: [] };
}

function spearman(a, b) {
  const rank = (arr) => { const s = [...arr].sort((x, y) => y.v - x.v); const m = {}; s.forEach((e, i) => { m[e.id] = i; }); return m; };
  const ra = rank(a), rb = rank(b);
  const n = a.length;
  let d2 = 0;
  a.forEach((e) => { d2 += (ra[e.id] - rb[e.id]) ** 2; });
  return 1 - (6 * d2) / (n * (n * n - 1));
}

function report(title, data) {
  const rows = computePCR(data);
  const rated = ratedRows(rows);
  const truth = ids.map((id) => ({ id, v: TRUE[id] }));
  const est = rated.map((r) => ({ id: r.id, v: r.elo }));
  const rho = spearman(truth.filter((t) => est.some((e) => e.id === t.id)), est);
  // Elo определяет только разницу, поэтому ошибка меряется ПОСЛЕ центрирования:
  // общий сдвиг шкалы не является ошибкой ранжирования.
  const mT = est.reduce((a, e) => a + TRUE[e.id], 0) / est.length;
  const mE = est.reduce((a, e) => a + e.v, 0) / est.length;
  const errs = est.map((e) => Math.abs((e.v - mE) - (TRUE[e.id] - mT)));
  const mae = errs.reduce((a, b) => a + b, 0) / errs.length;
  const spreadT = Math.max(...est.map((e) => TRUE[e.id])) - Math.min(...est.map((e) => TRUE[e.id]));
  const spreadE = Math.max(...est.map((e) => e.v)) - Math.min(...est.map((e) => e.v));
  const offset = Math.round(mE - mT);
  console.log(`\n=== ${title} ===`);
  console.log(`зачётных: ${rated.length}/${rows.length}   сходимость (макс сдвиг за проход): ${rows.convergence.join(" → ")}`);
  console.log(`ранговая корреляция (Спирмен): ${rho.toFixed(3)}   ошибка после центрирования: ${Math.round(mae)} Elo (${(mae / 300).toFixed(2)} уровня)`);
  console.log(`разброс истина/модель: ${Math.round(spreadT)} / ${Math.round(spreadE)} (${(spreadE / spreadT * 100).toFixed(0)}%)   остаточный сдвиг шкалы: ${offset} Elo   якорь сместил на ${rows.scaleShift}`);
  console.log("игрок  истина  модель   ошибка  матчей  RD  уровень  надёж");
  rated.slice(0, 20).forEach((r) => {
    console.log(`${r.id.padEnd(6)} ${String(Math.round(TRUE[r.id])).padStart(6)} ${String(r.elo).padStart(7)} ${String(r.elo - Math.round(TRUE[r.id])).padStart(8)} ${String(r.games).padStart(7)} ${String(r.rd).padStart(4)} ${r.rating.toFixed(2).padStart(7)} ${(r.reliability*100).toFixed(0).padStart(4)}%`);
  });
  return { rows, rated, rho, mae };
}

// 1) много данных — модель должна почти точно восстановить порядок
report("8 турниров × 11 раундов, 3 корта, до 24", buildData(8, 11, 24, 3));

// 2) мало данных — реалистичный старт сообщества
report("2 турнира × 9 раундов, 3 корта, до 24", buildData(2, 9, 24, 3));

// 3) короткие матчи — вес должен снизить скорость движения
report("4 турнира × 9 раундов, до 12 очков", buildData(4, 9, 12, 3));

// 4) порог: один игрок сыграл 1 матч
{
  const d = buildData(3, 9, 24, 3);
  d.players.push({ id: "newbie", firstName: "Новичок", lastName: "", level: null });
  d.mexicanoTournaments[0].rounds[0].matches.push({
    team1: ["newbie", "p13"], team2: ["p0", "p1"], score1: 24, score2: 2,
  });
  const rows = computePCR(d);
  const n = rows.find((r) => r.id === "newbie");
  console.log(`\n=== порог MIN_RATED_GAMES ===`);
  console.log(`новичок: матчей ${n.games}, зачётный: ${n.rated}, elo ${n.elo}, позиция в списке ${rows.indexOf(n) + 1}/${rows.length}`);
  console.log(`в зачётном списке его нет: ${!ratedRows(rows).some((r) => r.id === "newbie")}`);
}

// 5) инвариантность к порядку: перетасовать турниры по датам не должно ломать итог
{
  const d = buildData(6, 9, 24, 3);
  const a = computePCR(d);
  const d2 = JSON.parse(JSON.stringify(d));
  d2.mexicanoTournaments.reverse();
  d2.mexicanoTournaments.forEach((t, i) => { t.date = d.mexicanoTournaments[i].date; });
  const b = computePCR(d2);
  const diffs = a.filter((r) => r.rated).map((r) => Math.abs(r.elo - (b.find((x) => x.id === r.id) || {}).elo));
  console.log(`\n=== устойчивость к порядку ===`);
  console.log(`макс расхождение при перестановке турниров: ${Math.max(...diffs)} Elo`);
}

// 6) динамика и вспомогательные функции не падают
{
  const d = buildData(5, 9, 24, 3);
  const rows = computePCR(d);
  const r = ratedRows(rows)[0];
  const w = weeklySeries(r);
  const rc = recentChange(r, 30, new Date("2026-02-20"));
  const h2h = headToHead(rows, r.id);
  console.log(`\n=== динамика ===`);
  console.log(`недель в серии: ${w.length}, последняя: ${JSON.stringify(w[w.length - 1])}`);
  console.log(`сдвиг за 30 дней: ${JSON.stringify(rc)}`);
  console.log(`партнёров: ${h2h.partners.length}, соперников: ${h2h.opponents.length}`);
  console.log(`топ-партнёр: ${JSON.stringify(h2h.partners[0])}`);
}

// 7) влияние анкеты: с анкетой старт точнее, но при большом объёме игр итог
//    должен сойтись к тому же
{
  const d = buildData(6, 9, 24, 3);
  const withQ = JSON.parse(JSON.stringify(d));
  withQ.players.forEach((p) => {
    // анкета, намеренно смещённая на +1.0 уровня — проверяем, что игра её пересиливает
    withQ.players.find((x) => x.id === p.id).pcrQuestionnaire = { level: eloToLevel(TRUE[p.id]) + 1.0 };
  });
  const a = computePCR(d), b = computePCR(withQ);
  const diffs = ratedRows(a).map((r) => Math.abs(r.elo - b.find((x) => x.id === r.id).elo));
  const avg = diffs.reduce((x, y) => x + y, 0) / diffs.length;
  console.log(`\n=== влияние смещённой анкеты (+1.0 уровня всем) ===`);
  console.log(`средний остаточный сдвиг после 54 матчей: ${Math.round(avg)} Elo (${(avg / 300).toFixed(2)} уровня), макс ${Math.max(...diffs)}`);
}

// 8) калибровочный отчёт
{
  const { calibrationReport } = await import("./pcr.js");
  const d = buildData(8, 11, 24, 3);
  const rows = computePCR(d);
  console.log(`\n=== калибровка SHARE_SPREAD ===`);
  console.log("разрыв Elo   матчей  факт.доля  предсказ.  расхождение");
  calibrationReport(d, rows).forEach((b) => {
    console.log(`${b.label.padEnd(12)} ${String(b.games).padStart(6)} ${b.observed.toFixed(3).padStart(10)} ${b.predicted.toFixed(3).padStart(10)} ${(b.gap >= 0 ? "+" : "") + b.gap.toFixed(3)}`);
  });
}
