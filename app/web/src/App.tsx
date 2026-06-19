import { useEffect, useRef, useState } from "react";
import { fetchState, streamTurn, type GameState } from "./api";

const PREFILL_HINT =
  "🌌 [主控系統] 正在分析個體行動，載入因果律中…（自架模型首字推論可能需數十秒，請稍候）";

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

  return (
    <div className="layout">
      <main className="story-col">
        <header>
          <h1>
            無限世界冒險{" "}
            <span className="badge">{state?.mode === "dungeon" ? "副本中" : "主空間"}</span>
          </h1>
          <div className="header-actions">
            <button className="ghost" onClick={() => setShowStatus(true)}>
              👤 角色 / 系統
            </button>
          </div>
        </header>

        <div className="story">{story}</div>
        <div ref={storyEndRef} />

        {suggested.length > 0 && (
          <div className="suggested">
            {suggested.map((a, i) => (
              <button key={i} disabled={busy} onClick={() => send(a)}>
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
          <button disabled={busy} onClick={() => send(input)}>
            {busy ? "推進中…" : "送出"}
          </button>
        </div>
      </main>

      {showStatus && state && (
        <StatusDrawer state={state} onClose={() => setShowStatus(false)} />
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <>
      <div className="label">{label}</div>
      <div className="value">{value || "—"}</div>
    </>
  );
}

function StatusDrawer({ state, onClose }: { state: GameState; onClose: () => void }) {
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <h2>角色 / 系統面板</h2>
          <button className="ghost" onClick={onClose}>
            ✕
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
      <h2>{d.name || "主角"}　<span className="points">積分 {d.points || "0"}</span></h2>
      <Field label="當前篇章" value={now.chapter} />
      <Field label="此刻場景／地點" value={now.scene} />
      <Field label="屬性" value={d.attributes} />
      <Field label="技能 / 異能" value={d.skills} />
      <Field label="物品欄" value={d.items} />
      <Field label="Buff / Debuff" value={d.buffs} />
      <Field label="進行中的副本" value={now.activeDungeon} />
      <Field label="未解懸念／伏筆" value={now.threads} />
      <Field label="主角下一步打算" value={now.nextStep} />
      <Field label="最後更新" value={now.lastUpdated} />
    </section>
  );
}

function NpcPanel({ state }: { state: GameState }) {
  return (
    <section className="panel">
      <h2>在場 / 相關 NPC</h2>
      {state.npcs.length === 0 && <div className="value">—</div>}
      {state.npcs.map((n) => (
        <div className="npc" key={n.id}>
          <div className="npc-name">
            {n.name} <span className="npc-role">{n.role}</span>
          </div>
          <div className="npc-status">{n.status}</div>
        </div>
      ))}
    </section>
  );
}
