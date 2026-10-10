import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";

// ---------- design tokens (kept in sync with the main app) ----------
const C = {
  paper: "#F5F3ED", paperDim: "#EFEDE4", card: "#FFFFFF", ink: "#1A1B1D",
  slate: "#4A4D52", slateFaint: "#8A8D93", rule: "#DFDBCF",
  court: "#2E9E6F", action: "#2F6DB3", rust: "#B5603A",
  negative: "#C0493B",
};
const FONT_DISPLAY = "'Montserrat', sans-serif";
const FONT_BODY = "'PT Sans', system-ui, sans-serif";

const fullName = (p) => [p.firstName, p.lastName].filter(Boolean).join(" ").trim() || "Без имени";

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

function Avatar({ player, size = 26 }) {
  if (!player) return null;
  const initials = `${(player.firstName || "?")[0] || ""}${(player.lastName || "")[0] || ""}`;
  const base = { width: size, height: size, flex: "0 0 auto", borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center" };
  if (player.photo) return <span style={{ ...base, backgroundImage: `url(${player.photo})`, backgroundSize: "cover", backgroundPosition: "center" }} />;
  return <span style={{ ...base, background: player.gender === "female" ? "#F3DDD5" : "#D8E3F0", color: C.ink, fontSize: size * 0.38, fontWeight: 700 }}>{initials}</span>;
}

function ConfirmModal({ text, onConfirm, onCancel }) {
  // Backdrop and panel are siblings, both position:fixed. Nesting the panel
  // inside the backdrop puts the overlay on top of its own content and the
  // clicks land on the backdrop instead of the buttons.
  return (
    <>
      <div onClick={onCancel} style={{ position: "fixed", inset: 0, background: "rgba(26,27,29,0.45)", zIndex: 2000 }} />
      <div style={{
        position: "fixed", zIndex: 2001, top: "50%", left: "50%", transform: "translate(-50%,-50%)",
        width: "min(360px, calc(100vw - 32px))", background: C.card, borderRadius: 12, padding: 18,
        boxShadow: "0 12px 40px rgba(26,27,29,0.25)",
      }}>
        <div style={{ fontSize: 14.5, marginBottom: 16, lineHeight: 1.45 }}>{text}</div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onCancel} style={{ ...btn("none", C.slateFaint), border: `1px solid ${C.rule}` }}>Отмена</button>
          <button onClick={onConfirm} style={btn(C.negative)}>Удалить</button>
        </div>
      </div>
    </>
  );
}

// ============================================================================
// One team card — collapsed summary, expands into the member picker
// ============================================================================
function TeamCard({ team, players, canEdit, onSave, onDelete }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(team.name);
  const [note, setNote] = useState(team.note || "");
  const [ids, setIds] = useState(team.playerIds || []);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  // Re-sync when the server copy changes under an open card.
  useEffect(() => { setName(team.name); setNote(team.note || ""); setIds(team.playerIds || []); }, [team]);

  const dirty = name.trim() !== team.name
    || note.trim() !== (team.note || "")
    || ids.length !== (team.playerIds || []).length
    || ids.some((id) => !(team.playerIds || []).includes(id));

  const toggle = (id) => setIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const members = players.filter((p) => ids.includes(p.id));
  const shown = players.filter((p) => !search.trim() || fullName(p).toLowerCase().includes(search.trim().toLowerCase()));

  const save = async () => {
    setBusy(true);
    try { await onSave(team.id, { name: name.trim() || team.name, note: note.trim(), playerIds: ids }); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 12, marginBottom: 10, overflow: "hidden" }}>
      <button onClick={() => setOpen((o) => !o)} style={{
        width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "13px 15px",
        background: "none", border: "none", cursor: "pointer", textAlign: "left",
      }}>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 15, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{team.name}</span>
          <span style={{ display: "block", fontSize: 12, color: C.slateFaint, marginTop: 2 }}>
            {(team.playerIds || []).length} {pluralPlayers((team.playerIds || []).length)}
            {team.note ? ` · ${team.note}` : ""}
          </span>
        </span>
        <span style={{ display: "flex", marginRight: 4 }}>
          {members.slice(0, 5).map((p, i) => (
            <span key={p.id} style={{ marginLeft: i ? -7 : 0, border: `2px solid ${C.card}`, borderRadius: "50%", display: "inline-flex" }}>
              <Avatar player={p} size={24} />
            </span>
          ))}
        </span>
        <span style={{ fontSize: 12, color: C.slateFaint }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div style={{ borderTop: `1px solid ${C.rule}`, padding: 15 }}>
          {canEdit ? (
            <>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
                <div style={{ flex: "1 1 180px" }}>
                  <div style={{ fontSize: 11, color: C.slateFaint, marginBottom: 4 }}>Название</div>
                  <input value={name} onChange={(e) => setName(e.target.value)} style={{ ...inputStyle, width: "100%" }} />
                </div>
                <div style={{ flex: "1 1 180px" }}>
                  <div style={{ fontSize: 11, color: C.slateFaint, marginBottom: 4 }}>Примечание</div>
                  <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="например, отдел или компания" style={{ ...inputStyle, width: "100%" }} />
                </div>
              </div>

              <div style={{ fontSize: 11, color: C.slateFaint, marginBottom: 6 }}>
                Состав — {ids.length} {pluralPlayers(ids.length)}
              </div>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск игрока"
                style={{ ...inputStyle, width: "100%", marginBottom: 8 }} />
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14, maxHeight: 240, overflowY: "auto" }}>
                {shown.map((p) => {
                  const on = ids.includes(p.id);
                  return (
                    <button key={p.id} onClick={() => toggle(p.id)} style={{
                      display: "flex", alignItems: "center", gap: 6, fontSize: 13,
                      background: on ? C.court : C.paper, color: on ? "#fff" : C.ink,
                      border: `1px solid ${on ? C.court : C.rule}`, borderRadius: 999,
                      padding: "5px 11px", cursor: "pointer",
                    }}><Avatar player={p} size={20} /> {fullName(p)}</button>
                  );
                })}
                {shown.length === 0 && <span style={{ fontSize: 12.5, color: C.slateFaint }}>Никого не нашлось.</span>}
              </div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button disabled={!dirty || busy} onClick={save} style={{ ...btn(C.court), opacity: !dirty || busy ? 0.45 : 1 }}>Сохранить</button>
                <button onClick={() => setConfirm(true)} style={{ ...btn("none", C.negative), border: `1px solid ${C.rule}`, marginLeft: "auto" }}>Удалить команду</button>
              </div>
            </>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {members.map((p) => (
                <span key={p.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, background: C.paper, border: `1px solid ${C.rule}`, borderRadius: 999, padding: "5px 11px" }}>
                  <Avatar player={p} size={20} /> {fullName(p)}
                </span>
              ))}
              {members.length === 0 && <span style={{ fontSize: 12.5, color: C.slateFaint }}>В команде пока нет игроков.</span>}
            </div>
          )}
        </div>
      )}

      {confirm && (
        <ConfirmModal
          text={`Удалить команду «${team.name}»? Сами игроки останутся в общем списке.`}
          onCancel={() => setConfirm(false)}
          onConfirm={() => { setConfirm(false); onDelete(team.id); }}
        />
      )}
    </div>
  );
}

function pluralPlayers(n) {
  const d = n % 10, h = n % 100;
  if (d === 1 && h !== 11) return "игрок";
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return "игрока";
  return "игроков";
}

// ============================================================================
function App() {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [session, setSession] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  const embed = new URLSearchParams(window.location.search).get("embed") === "1";

  useEffect(() => {
    fetch("/api/data").then((r) => r.json()).then(setData).catch((e) => setLoadError(String(e)));
    fetch("/api/player/session").then((r) => r.json()).then(setSession).catch(() => setSession({ loggedIn: false }));
    fetch("/api/admin/session").then((r) => r.json()).then((s) => setIsAdmin(!!(s && s.authenticated))).catch(() => setIsAdmin(false));
  }, []);

  if (loadError) return <div style={{ padding: 24, fontFamily: FONT_BODY, color: C.negative }}>Не удалось загрузить данные: {loadError}</div>;
  if (!data) return <div style={{ minHeight: "40vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT_DISPLAY, fontSize: 20, color: C.court }}>PadelCom</div>;

  const canEdit = !!(session && session.loggedIn) || isAdmin;
  const players = (data.players || []).slice().sort((a, b) => fullName(a).localeCompare(fullName(b)));
  const teams = [...(data.teams || [])].sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const res = await api("/api/teams", { method: "POST", body: { name, playerIds: [] } });
      setNewName("");
      setData((d) => ({ ...d, teams: [...(d.teams || []), res.team] }));
    } catch (e) {
      alert(e.status === 403 ? "Нужен вход через Telegram или в админ-панель" : e.message);
    } finally { setBusy(false); }
  };

  const save = async (id, patch) => {
    try {
      await api(`/api/teams/${id}`, { method: "PUT", body: patch });
      setData((d) => ({ ...d, teams: (d.teams || []).map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
    } catch (e) {
      alert(e.status === 403 ? "Нужен вход через Telegram или в админ-панель" : e.message);
    }
  };

  const remove = async (id) => {
    try {
      await api(`/api/teams/${id}`, { method: "DELETE" });
      setData((d) => ({ ...d, teams: (d.teams || []).filter((t) => t.id !== id) }));
    } catch (e) { alert(e.message); }
  };

  const body = (
    <>
      {canEdit && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
          <input value={newName} onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") create(); }}
            placeholder="Название команды" style={{ ...inputStyle, flex: "1 1 200px" }} />
          <button disabled={!newName.trim() || busy} onClick={create}
            style={{ ...btn(C.ink), opacity: !newName.trim() || busy ? 0.45 : 1 }}>Создать</button>
        </div>
      )}

      {teams.length === 0 ? (
        <div style={{ fontSize: 13, color: C.slateFaint, lineHeight: 1.5, background: C.paperDim, border: `1px solid ${C.rule}`, borderRadius: 10, padding: 14 }}>
          Команд пока нет. Команда — это сохранённый список игроков (компания, отдел, корпоративная группа).
          При создании турнира Mexicano или Americano её можно выбрать в поле «Команда», и список участников
          сузится до её состава.
        </div>
      ) : (
        teams.map((t) => (
          <TeamCard key={t.id} team={t} players={players} canEdit={canEdit} onSave={save} onDelete={remove} />
        ))
      )}

      {!canEdit && teams.length > 0 && (
        <div style={{ fontSize: 12, color: C.slateFaint, marginTop: 10 }}>
          Режим просмотра — войдите через Telegram, чтобы менять составы.
        </div>
      )}
    </>
  );

  if (embed) return <div style={{ fontFamily: FONT_BODY, color: C.ink }}>{body}</div>;

  return (
    <div style={{ fontFamily: FONT_BODY, color: C.ink, background: C.paper, minHeight: "100vh" }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "18px 16px 40px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
          <a href="/" style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 22, color: C.ink, textDecoration: "none" }}>
            Padel<span style={{ color: C.court }}>Com</span>
          </a>
          <span style={{ fontSize: 12, color: C.slateFaint, borderLeft: `1px solid ${C.rule}`, paddingLeft: 10 }}>Команды</span>
          {isAdmin && <span style={{ fontSize: 10.5, color: C.action, border: `1px solid ${C.action}`, borderRadius: 999, padding: "1px 8px" }}>админ</span>}
        </div>
        {body}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
