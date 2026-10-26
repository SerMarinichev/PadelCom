// Полный цикл турнира через реальный HTTP API: создание, раунды, ввод счёта,
// правка счёта, снятие игрока, завершение. Плюс отдельная проверка миграции —
// турнир, начатый на СТАРОЙ версии данных (без venueId и отметок времени),
// который продолжают вести после обновления сервера.
//
// Смысл: убедиться, что ни на одном шаге не теряются составы, счета и раунды.
const B = process.env.BASE || "http://127.0.0.1:3100";
let cookie = "";

async function call(path, opts = {}) {
  const res = await fetch(B + path, {
    method: opts.method || "GET",
    headers: { ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const setC = res.headers.get("set-cookie");
  if (setC) cookie = setC.split(";")[0];
  let json = null;
  try { json = await res.json(); } catch { /* пусто */ }
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status} ${JSON.stringify(json)}`);
  return json;
}

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) { console.log(`  ok    ${label}`); }
  else { failures += 1; console.log(`  ПАДАЕТ ${label}${detail ? " — " + detail : ""}`); }
}

const data = () => call("/api/data");
const put = (id, body) => call(`/api/mexicano/${id}`, { method: "PUT", body });
const findT = async (id) => (await data()).mexicanoTournaments.find((t) => t.id === id);

async function main() {
  await call("/api/admin/login", { method: "POST", body: { password: process.env.ADMIN_PASSWORD || "adm" } });
  const d0 = await data();
  const ids = d0.players.slice(0, 8).map((p) => p.id);
  const venue = (d0.places || [])[0];

  console.log("\n=== 1. Создание турнира ===");
  const created = await call("/api/mexicano", {
    method: "POST",
    body: { format: "mexicano", name: "Проверка цикла", date: "2026-10-25", venueId: venue ? venue.id : null,
            pointsPerMatch: 24, courts: 2, seeding: "1+4", playerIds: ids, targetRounds: 7 },
  });
  const id = created.tournament.id;
  check("турнир создан", !!id);
  check("состав сохранён целиком", created.tournament.playerIds.length === ids.length,
    `${created.tournament.playerIds.length} из ${ids.length}`);
  check("объект записан", created.tournament.venueId === (venue ? venue.id : null));
  check("createdAt проставлен сервером", !!created.tournament.createdAt);

  console.log("\n=== 2. Три раунда со счётом ===");
  let t = await findT(id);
  for (let r = 0; r < 3; r += 1) {
    // раунд формируется клиентом и сохраняется целиком — имитируем это
    const pool = t.playerIds.slice(0, 8);
    const round = { matches: [
      { court: 1, team1: [pool[0], pool[3]], team2: [pool[1], pool[2]], seeds1: [1, 4], seeds2: [2, 3], scheme: "1+4", score1: null, score2: null },
      { court: 2, team1: [pool[4], pool[7]], team2: [pool[5], pool[6]], seeds1: [1, 4], seeds2: [2, 3], scheme: "1+4", score1: null, score2: null },
    ], sitting: [] };
    const afterRound = await put(id, { ...t, rounds: [...t.rounds, round] });
    t = afterRound.tournament;
    check(`раунд ${r + 1} сформирован`, t.rounds.length === r + 1, `раундов ${t.rounds.length}`);
    check(`раунд ${r + 1}: составы на месте`, t.rounds[r].matches.every((m) => m.team1.length === 2 && m.team2.length === 2));
    check(`раунд ${r + 1}: createdAt у нового раунда`, !!t.rounds[r].createdAt);

    // вносим счёт
    const withScores = { ...t, rounds: t.rounds.map((rr, ri) => (ri !== r ? rr : {
      ...rr, matches: rr.matches.map((m, mi) => ({ ...m, score1: mi === 0 ? 24 : 18, score2: mi === 0 ? 12 : 24 })),
    })) };
    const afterScore = await put(id, withScores);
    t = afterScore.tournament;
    check(`раунд ${r + 1}: счёт сохранён`, t.rounds[r].matches[0].score1 === 24 && t.rounds[r].matches[0].score2 === 12);
    check(`раунд ${r + 1}: scoredAt проставлен`, !!t.rounds[r].matches[0].scoredAt);
    check(`раунд ${r + 1}: прежние раунды целы`, t.rounds.length === r + 1 && t.rounds.every((rr) => rr.matches.length === 2));
  }

  console.log("\n=== 3. Отметки прежних раундов не переписываются ===");
  const stampBefore = t.rounds[0].matches[0].scoredAt;
  const touched = await put(id, { ...t, name: "Проверка цикла (переименован)" });
  t = touched.tournament;
  check("имя изменилось", t.name.includes("переименован"));
  check("scoredAt первого раунда НЕ переписан", t.rounds[0].matches[0].scoredAt === stampBefore,
    `было ${stampBefore}, стало ${t.rounds[0].matches[0].scoredAt}`);
  check("счета всех раундов целы", t.rounds.every((rr) => rr.matches.every((m) => m.score1 != null)));

  console.log("\n=== 4. Правка счёта обновляет отметку ===");
  await new Promise((r) => setTimeout(r, 1100));
  const fixed = await put(id, { ...t, rounds: t.rounds.map((rr, ri) => (ri !== 0 ? rr : {
    ...rr, matches: rr.matches.map((m, mi) => (mi !== 0 ? m : { ...m, score1: 24, score2: 20 })),
  })) });
  t = fixed.tournament;
  check("исправленный счёт сохранён", t.rounds[0].matches[0].score2 === 20);
  check("scoredAt обновлён у исправленного", t.rounds[0].matches[0].scoredAt !== stampBefore);
  check("scoredAt соседнего матча не тронут", !!t.rounds[0].matches[1].scoredAt);

  console.log("\n=== 5. Снятие игрока и завершение ===");
  const wd = await put(id, { ...t, withdrawals: [{ playerId: ids[7], reason: "Травма", round: t.rounds.length }] });
  t = wd.tournament;
  check("игрок снят", (t.withdrawals || []).length === 1);
  check("раунды целы после снятия", t.rounds.length === 3 && t.rounds.every((rr) => rr.matches.length === 2));
  const fin = await put(id, { ...t, finished: true });
  t = fin.tournament;
  check("турнир завершён", t.finished === true);

  console.log("\n=== 6. Смена объекта у завершённого турнира ===");
  const v2 = (d0.places || [])[1];
  const rev = await put(id, { ...t, venueId: v2 ? v2.id : null });
  t = rev.tournament;
  check("объект изменён", t.venueId === (v2 ? v2.id : null));
  check("счета не затронуты", t.rounds.every((rr) => rr.matches.every((m) => m.score1 != null)));
  check("состав не затронут", t.playerIds.length === ids.length);
  check("отметки времени сохранились", !!t.rounds[0].matches[0].scoredAt);

  console.log("\n=== 7. МИГРАЦИЯ: турнир со старой версии (без venueId и отметок) ===");
  // Старые данные нельзя изобразить через API: сервер намеренно не даёт клиенту
  // стереть свою отметку. Поэтому пишем турнир прямо в хранилище — ровно в том
  // виде, в каком он лежит у тех, кто играл до этого обновления.
  const fs = await import("node:fs");
  const BLOB = process.env.BLOB || "/tmp/mock-blob.json";
  const blob = JSON.parse(fs.readFileSync(BLOB, "utf8"));
  const lid = "legacy01";
  blob.mexicanoTournaments = [...(blob.mexicanoTournaments || []).filter((x) => x.id !== lid), {
    id: lid, name: "Старый турнир", date: "2026-10-20", format: "americano",
    pointsPerMatch: 24, courts: 1, seeding: "1+4", targetRounds: 7,
    playerIds: ids.slice(0, 4), withdrawals: [], finished: false,
    createdAt: "2026-10-20T09:00:00.000Z",
    rounds: [{ matches: [{ court: 1, team1: [ids[0], ids[3]], team2: [ids[1], ids[2]], score1: 24, score2: 16 }] }],
  }];
  fs.writeFileSync(BLOB, JSON.stringify(blob, null, 1));

  let lt = await findT(lid);
  check("старый турнир читается", !!lt && lt.rounds[0].matches[0].score1 === 24);
  check("у него нет ни venueId, ни отметок", !lt.venueId && !lt.rounds[0].createdAt && !lt.rounds[0].matches[0].scoredAt);

  // продолжаем вести его после обновления — добавляем новый раунд
  lt = (await put(lid, { ...lt, rounds: [...lt.rounds, { matches: [{ court: 1, team1: [ids[0], ids[1]], team2: [ids[2], ids[3]], score1: null, score2: null }] }] })).tournament;
  check("новый раунд добавился", lt.rounds.length === 2);
  check("старый счёт цел", lt.rounds[0].matches[0].score1 === 24 && lt.rounds[0].matches[0].score2 === 16);
  check("старая отметка НЕ подделана временем обновления", !lt.rounds[0].matches[0].scoredAt,
    `стало ${lt.rounds[0].matches[0].scoredAt}`);
  check("старому раунду не придумали createdAt", !lt.rounds[0].createdAt, `стало ${lt.rounds[0].createdAt}`);
  check("новый раунд получил createdAt", !!lt.rounds[1].createdAt);

  // вносим счёт в новый раунд — он должен получить отметку, старый остаться без
  lt = (await put(lid, { ...lt, rounds: lt.rounds.map((rr, ri) => (ri !== 1 ? rr : { ...rr, matches: rr.matches.map((m) => ({ ...m, score1: 24, score2: 9 })) })) })).tournament;
  check("счёт нового раунда записан с отметкой", lt.rounds[1].matches[0].score1 === 24 && !!lt.rounds[1].matches[0].scoredAt);
  check("старый раунд по-прежнему без отметки", !lt.rounds[0].matches[0].scoredAt);
  check("объект проставляется задним числом",
    (await put(lid, { ...lt, venueId: venue ? venue.id : null })).tournament.venueId === (venue ? venue.id : null));

  console.log("\n=== 8. Добавление игрока в идущий турнир ===");
  const spare = (await data()).players.find((p) => !t.playerIds.includes(p.id));
  if (spare) {
    const before = t.playerIds.length;
    const joined = (await put(id, { ...t, finished: false,
      playerIds: [...t.playerIds, spare.id],
      joins: [...(t.joins || []), { playerId: spare.id, round: t.rounds.length, baselineSitOuts: 1 }] })).tournament;
    check("игрок добавлен", joined.playerIds.length === before + 1);
    check("запись о вступлении создана", (joined.joins || []).some((j) => j.playerId === spare.id));
    check("время вступления проставил сервер", !!(joined.joins || []).find((j) => j.playerId === spare.id).at);
    check("прежний состав не тронут", joined.playerIds.slice(0, before).join() === t.playerIds.join());
    check("счета прежних раундов целы", joined.rounds.every((rr) => rr.matches.every((m) => m.score1 != null)));
    check("отметки прежних матчей не переписаны", joined.rounds[0].matches[0].scoredAt === t.rounds[0].matches[0].scoredAt);
    t = joined;
  } else {
    console.log("  (пропущено — все игроки уже в турнире)");
  }

  console.log(`\n${failures === 0 ? "ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ" : `ПРОВАЛЕНО ПРОВЕРОК: ${failures}`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("СБОЙ:", e.message); process.exit(1); });
