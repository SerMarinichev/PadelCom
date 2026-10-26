// Проверка защиты базы от потери. Каждый сценарий — реальный путь записи,
// а не вызов внутренней функции: именно так данные и терялись.
//
// BLOB — файл, который изображает хранилище (мок GitHub).
import fs from "node:fs";
const B = process.env.BASE || "http://127.0.0.1:3100";
const BLOB = process.env.BLOB || "/tmp/mock-blob.json";
let cookie = "";

async function call(path, opts = {}) {
  const res = await fetch(B + path, {
    method: opts.method || "GET",
    headers: { ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  let json = null;
  try { json = await res.json(); } catch { /* пусто */ }
  return { status: res.status, json };
}

let failures = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`  ok     ${label}`);
  else { failures += 1; console.log(`  ПАДАЕТ ${label}${detail ? " — " + detail : ""}`); }
};

const readBlob = () => JSON.parse(fs.readFileSync(BLOB, "utf8"));
const writeBlob = (d) => fs.writeFileSync(BLOB, JSON.stringify(d, null, 1));

async function main() {
  await call("/api/admin/login", { method: "POST", body: { password: process.env.ADMIN_PASSWORD || "adm" } });
  const healthy = readBlob();
  const playerCount = (healthy.players || []).length;
  console.log(`\nИсходная база: игроков ${playerCount}, турниров ${(healthy.mexicanoTournaments || []).length}, матчей ${(healthy.matchRecords || []).length}`);

  // --- 1. Тот самый сценарий: клиент сохраняет пустую структуру поверх живой базы
  console.log("\n=== 1. Автосохранение пустой структуры (так база и пропала) ===");
  const wiped = {};
  Object.keys(healthy).forEach((k) => { wiped[k] = Array.isArray(healthy[k]) ? [] : healthy[k]; });
  // пишем от имени игрока — именно эта роль имеет право на /api/data
  const saveCookie = cookie;
  cookie = `padelcom_player=${process.env.PLAYER_COOKIE || ""}`;
  const r1 = await call("/api/data", { method: "PUT", body: wiped });
  cookie = saveCookie;
  check("запись отклонена", r1.status >= 400, `получили HTTP ${r1.status}`);
  check("в ответе названо, что пропадало", String(JSON.stringify(r1.json)).includes("players"),
    JSON.stringify(r1.json).slice(0, 160));
  check("база на месте", (readBlob().players || []).length === playerCount);

  // --- 2. Частичная, но массовая потеря
  console.log("\n=== 2. Потеря больше половины записей ===");
  const half = JSON.parse(JSON.stringify(healthy));
  half.players = (half.players || []).slice(0, 1);
  half.matchRecords = [];
  half.mexicanoTournaments = [];
  const saveCookie2 = cookie;
  cookie = `padelcom_player=${process.env.PLAYER_COOKIE || ""}`;
  const r2 = await call("/api/data", { method: "PUT", body: half });
  cookie = saveCookie2;
  check("массовая потеря отклонена", r2.status >= 400, `HTTP ${r2.status}`);
  check("база на месте", (readBlob().players || []).length === playerCount);

  // --- 3. Нормальная работа не сломана
  console.log("\n=== 3. Обычные изменения проходят ===");
  const v = await call("/api/admin/venues", { method: "POST", body: { name: "Проверочный объект", type: "Корты" } });
  check("объект добавлен", v.status === 200 && !!v.json.ok, `HTTP ${v.status}`);
  const after = readBlob();
  check("игроки не пострадали", (after.players || []).length === playerCount);
  check("объект действительно в базе", (after.places || []).some((p) => p.name === "Проверочный объект"));

  // --- 4. Удаление одной записи разрешено
  console.log("\n=== 4. Точечное удаление разрешено ===");
  const vid = (readBlob().places || []).find((p) => p.name === "Проверочный объект").id;
  const del = await call(`/api/admin/venues/${vid}`, { method: "DELETE" });
  check("объект удалён", del.status === 200, `HTTP ${del.status}`);
  check("остальные объекты целы", (readBlob().places || []).length === (after.places || []).length - 1);

  // --- 5. Пропавший файл данных — явная ошибка, а не пустая база
  console.log("\n=== 5. Файл данных пропал ===");
  const backup = fs.readFileSync(BLOB, "utf8");
  fs.writeFileSync("/tmp/mock-missing.flag", "1");       // мок начнёт отвечать 404
  const r5 = await call("/api/data");
  check("/api/data отдаёт ошибку, а не {}", r5.status >= 400, `HTTP ${r5.status}, тело ${JSON.stringify(r5.json).slice(0, 120)}`);
  check("в ошибке сказано про файл", JSON.stringify(r5.json).includes("404") || JSON.stringify(r5.json).includes("не найден"));
  const st = await call("/api/admin/storage/status");
  check("статус показывает fileExists: false", st.json && st.json.fileExists === false);
  check("статус объясняет причину", !!(st.json && st.json.error));
  fs.unlinkSync("/tmp/mock-missing.flag");
  fs.writeFileSync(BLOB, backup);
  const r5b = await call("/api/data");
  check("после возврата файла всё работает", r5b.status === 200 && (r5b.json.players || []).length === playerCount);

  console.log(`\n${failures === 0 ? "ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ" : `ПРОВАЛЕНО: ${failures}`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("СБОЙ:", e.message); process.exit(1); });
