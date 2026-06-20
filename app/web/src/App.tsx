import { useEffect, useRef, useState } from "react";
import { fetchState, streamTurn, type GameState } from "./api";

const PREFILL_HINT =
  "主控系統正在分析個體行動，載入因果律中…（自架模型首字推論可能需數十秒，請稍候）";

export function App() {
  const [state, setState] = useState<GameState | null>(null);
  const [story, setStory] = useState<string>("輸入你的行動，開始推進劇情。");
  const [suggested, setSuggested] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [showStatus, setShowStatus] = useState(false);
  const storyEndRef = useRef<HTMLDivElement | null>(null);
  const loadedInitialRef = useRef(false);

  const refresh = () =>
    fetchState()
      .then((s) => {
        setState(s);
        if (!loadedInitialRef.current && s.lastTurn) {
          setStory(s.lastTurn.narrative);
          setSuggested(s.lastTurn.suggestedActions);
        }
        loadedInitialRef.current = true;
      })
      .catch(() => {});
  useEffect(() => {
    refresh();
  }, []);
  useEffect(() => {
    storyEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [story]);

  async function send(action: string) {
    const text = action.trim();
    if (!text || busy) return;
    setBusy(true);
    setSuggested([]);
    setInput("");
    setStory(PREFILL_HINT);
    let firstToken = true;
    try {
      await streamTurn(text, (ev) => {
        switch (ev.type) {
          case "delta":
            setStory((s) => (firstToken ? ((firstToken = false), ev.text) : s + ev.text));
            break;
          case "auto-advance":
            setStory((s) => s + "\n\n—— 系統自動推進 ——\n\n");
            firstToken = false;
            break;
          case "transition":
            setStory(
              (s) =>
                s + `\n\n【${ev.to === "dungeon" ? `進入副本 ${ev.dungeonId ?? ""}` : "返回安全區"}】\n\n`,
            );
            break;
          case "warning":
            setStory((s) => s + `\n[提示] ${ev.message}\n`);
            break;
          case "error":
            setStory((s) => s + `\n[錯誤] ${ev.message}\n`);
            break;
          case "done":
            setSuggested(ev.suggestedActions ?? []);
            break;
        }
      });
      await refresh();
    } catch (e) {
      setStory((s) => s + `\n[請求失敗] ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const isDungeon = state?.mode === "dungeon";

  return (
    <div className="app-shell">
      <div className="ambient-grid" aria-hidden="true" />
      <div className="layout">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark">∞</span>
            <div>
              <h1>無限世界冒險</h1>
              <span className={`mode-chip ${isDungeon ? "mode-chip--dungeon" : "mode-chip--main"}`}>
                <span className="mode-dot" />
                {isDungeon ? "副本中" : "主空間"}
              </span>
            </div>
          </div>
          <div className="header-actions">
            <button
              className="icon-btn"
              aria-label="開啟角色／系統面板"
              onClick={() => setShowStatus(true)}
            >
              <IconUser />
            </button>
          </div>
        </header>

        <div className="board">
          <main className="story-col">
            <section className="story-card">
              <div className="story-eyebrow">NARRATIVE LOG</div>
              <div className="story-text">
                {story}
                {busy && <span className="cursor" aria-hidden="true" />}
              </div>
              <div ref={storyEndRef} />
            </section>

            {suggested.length > 0 && (
              <div className="suggested" role="group" aria-label="建議行動">
                {suggested.map((a, i) => (
                  <button key={i} className="chip" disabled={busy} onClick={() => send(a)}>
                    <IconArrow className="chip-arrow" />
                    {a}
                  </button>
                ))}
              </div>
            )}

            <div className="composer">
              <input
                value={input}
                disabled={busy}
                placeholder="你的行動，例如：去資訊室找葉晴"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send(input)}
              />
              <button
                className="send-btn"
                disabled={busy}
                aria-label={busy ? "推進中" : "送出"}
                onClick={() => send(input)}
              >
                {busy ? <span className="spinner" /> : <IconArrow />}
              </button>
            </div>
          </main>

          <aside className="sidebar sidebar--desktop">
            {state && (
              <>
                <StatusPanel state={state} />
                <NpcPanel state={state} />
              </>
            )}
          </aside>
        </div>
      </div>

      {showStatus && state && (
        <StatusDrawer state={state} onClose={() => setShowStatus(false)} />
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="value">{value || "—"}</div>
    </div>
  );
}

function StatusDrawer({ state, onClose }: { state: GameState; onClose: () => void }) {
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <h2>角色 / 系統面板</h2>
          <button className="icon-btn" aria-label="關閉面板" onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <StatusPanel state={state} />
        <NpcPanel state={state} />
      </aside>
    </div>
  );
}

function StatusPanel({ state }: { state: GameState }) {
  const d = state.protagonistDetail;
  const now = state.now;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{d.name || "主角"}</h2>
        <span className="points-tag">積分 {d.points || "0"}</span>
      </div>

      <div className="field-group">
        <div className="field-cluster-label">局勢</div>
        <Field label="當前篇章" value={now.chapter} />
        <Field label="此刻場景／地點" value={now.scene} />
        <Field label="進行中的副本" value={now.activeDungeon} />
      </div>

      <div className="field-group">
        <div className="field-cluster-label">角色檔案</div>
        <Field label="屬性" value={d.attributes} />
        <Field label="技能 / 異能" value={d.skills} />
        <Field label="物品欄" value={d.items} />
        <Field label="Buff / Debuff" value={d.buffs} />
      </div>

      <div className="field-group">
        <div className="field-cluster-label">伏筆</div>
        <Field label="未解懸念／伏筆" value={now.threads} />
        <Field label="主角下一步打算" value={now.nextStep} />
        <Field label="最後更新" value={now.lastUpdated} />
      </div>
    </section>
  );
}

function NpcPanel({ state }: { state: GameState }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>在場 / 相關 NPC</h2>
      </div>
      {state.npcs.length === 0 && <div className="empty-row">—</div>}
      <div className="npc-list">
        {state.npcs.map((n) => (
          <div className="npc" key={n.id}>
            <span className="npc-avatar" aria-hidden="true">
              {n.name ? n.name[0] : "?"}
            </span>
            <div className="npc-body">
              <div className="npc-name">
                {n.name}
                <span className="npc-role">{n.role}</span>
              </div>
              <div className="npc-status">{n.status}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function IconUser() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M5 5l14 14M19 5L5 19" />
    </svg>
  );
}

function IconArrow({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}
