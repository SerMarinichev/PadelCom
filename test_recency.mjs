// Проверка: имеют ли свежие матчи больший вес в PC Rating.
// Метод: у одного игрока истинная сила МЕНЯЕТСЯ в середине истории.
// Если свежие матчи весят больше — итоговый рейтинг догонит новую силу.
// Если все матчи равнозначны — осядет между старой и новой.
import { computePCR, ratedRows, levelToElo, eloToLevel } from "./pcr.js";

let seed = 4242;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const N = 12;
const ids = [];
const BASE = {};
for (let i = 0; i < N; i += 1) { const id = `p${i}`; ids.push(id); BASE[id] = levelToElo(2.5 + (2.5 * i) / (N - 1)); }

const SUBJECT = "p5";
const JUMP = 500;              // на столько реально меняется сила испытуемого
const SESSIONS = 20;           // всего игровых дней
const SWITCH_AT = 10;          // с этого дня сила уже новая
const ROUNDS = 6, COURTS = 2, TARGET = 24;

// истинная сила на день t
const trueElo = (id, t) => BASE[id] + (id === SUBJECT && t >= SWITCH_AT ? JUMP : 0);

function sim(A, B, t) {
  const av = (s) => s.reduce((a, id) => a + trueElo(id, t), 0) / s.length;
  const p = 1 / (1 + Math.pow(10, -(av(A) - av(B)) / 1000));
  let a = 0, b = 0;
  const n = Math.max(0.05, Math.min(0.95, p + (rnd() - 0.5) * 0.10));
  while (a < TARGET && b < TARGET) { if (rnd() < n) a += 1; else b += 1; }
  return [a, b];
}

function build() {
  const players = ids.map((id) => ({ id, firstName: id, lastName: "" }));
  const tournaments = [];
  for (let t = 0; t < SESSIONS; t += 1) {
    const day = new Date(Date.UTC(2026, 0, 5 + t * 7)).toISOString().slice(0, 10);
    const rounds = [];
    for (let r = 0; r < ROUNDS; r += 1) {
      const pool = [...ids].sort(() => rnd() - 0.5).slice(0, COURTS * 4);
      const matches = [];
      for (let c = 0; c < COURTS; c += 1) {
        const f = pool.slice(c * 4, c * 4 + 4);
        const t1 = [f[0], f[3]], t2 = [f[1], f[2]];
        const [s1, s2] = sim(t1, t2, t);
        matches.push({ team1: t1, team2: t2, score1: s1, score2: s2 });
      }
      rounds.push({ matches });
    }
    tournaments.push({ id: `t${t}`, name: `S${t}`, date: day, format: "mexicano",
      pointsPerMatch: TARGET, playerIds: ids, rounds });
  }
  return { players, mexicanoTournaments: tournaments, matchRecords: [] };
}

const data = build();

function evaluate(label, opts) {
  const rows = computePCR(data, opts);
  const rated = ratedRows(rows);
  // Elo определяет только разницу — центрируем по общему среднему,
  // иначе сравнивать с истиной нельзя.
  const mE = rated.reduce((a, r) => a + r.elo, 0) / rated.length;
  const mT = rated.reduce((a, r) => a + trueElo(r.id, SESSIONS - 1), 0) / rated.length;
  const row = rated.find((r) => r.id === SUBJECT);
  const est = row.elo - mE + mT;
  const before = BASE[SUBJECT];
  const after = BASE[SUBJECT] + JUMP;
  // доля пути от старой силы к новой, которую прошла оценка
  const caught = (est - before) / JUMP;
  console.log(`${label.padEnd(34)} оценка ${Math.round(est).toString().padStart(5)}   `
    + `старая ${before}  новая ${after}   догнал ${(caught * 100).toFixed(0)}%   проходов ${rows.passesUsed}`);
  return caught;
}

console.log(`Испытуемый ${SUBJECT}: сила выросла на ${JUMP} Elo (${(JUMP / 300).toFixed(2)} уровня)`);
console.log(`после ${SWITCH_AT} из ${SESSIONS} сессий — то есть половина истории старая, половина новая.\n`);
console.log("Если свежие матчи весят больше — «догнал» будет близко к 100%.");
console.log("Если все матчи равнозначны — около 50%: оценка осядет посередине.\n");

const a = evaluate("один проход (как в чистом Elo)", { passes: 1 });
const b = evaluate("многопроходный (наша модель)", {});

console.log();
console.log(`Разница между режимами: ${Math.round((a - b) * 100)} п.п. в пользу `
  + `${a > b ? "одного прохода" : "многопроходного"}.`);

// Та же проверка на спад силы
