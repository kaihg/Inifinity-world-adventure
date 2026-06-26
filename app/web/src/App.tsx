import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { fetchState, fetchVersion, fetchConfig, streamTurn, fetchWorldStatus, endWorld, fetchTurnStatus, streamTurnFromOffset, type AppVersion, type GameState } from "./api";
import { WorldSetupWizard } from "./WorldSetupWizard";
import { DeathChoiceModal } from "./DeathChoiceModal";
import { EndWorldModal } from "./EndWorldModal";

export const TYPEWRITER_INTERVAL_MS_DEFAULT = 50;
export const LOOKAHEAD_MIN = 20;

export function shouldTypewriterOutput({
  queueLength,
  llmDone,
}: {
  queueLength: number;
  llmDone: boolean;
}): boolean {
  if (queueLength === 0) return false;
  if (!llmDone && queueLength < LOOKAHEAD_MIN) return false;
  return true;
}

const COMPUTING_HINT = "🌌 主控系統正在運算中…（自架模型首字推論可能需數十秒，請稍候）";

export function App() {
  const [state, setState] = useState<GameState | null>(null);
  const [story, setStory] = useState<string>("輸入你的行動，開始推進劇情。");
  const [suggested, setSuggested] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [showStatus, setShowStatus] = useState(false);
  const [showEndWorld, setShowEndWorld] = useState(false);
  const [version, setVersion] = useState<AppVersion | null>(null);
  const [worldInitialized, setWorldInitialized] = useState<boolean | null>(null);
  const [protagonistDied, setProtagonistDied] = useState(false);
  const storyEndRef = useRef<HTMLDivElement | null>(null);
  const loadedInitialRef = useRef(false);
  const busyRef = useRef(busy);
  const pendingQueue = useRef<string[]>([]);
  const llmDoneRef = useRef(false);
  const typewriterTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectingRef = useRef(false);
  const typewriterIntervalMsRef = useRef(TYPEWRITER_INTERVAL_MS_DEFAULT);

  // 🚀 保持 busyRef 與 busy 同步
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

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
    fetchWorldStatus()
      .then((s) => setWorldInitialized(s.initialized))
      .catch(() => setWorldInitialized(true)); // 失敗時保守當已初始化，至少能進主畫面

    fetchConfig()
      .then((c) => { typewriterIntervalMsRef.current = c.typewriterIntervalMs; })
      .catch(() => {});

    refresh();
    fetchVersion().then(setVersion).catch(() => {});

    reconnectIfNeeded().catch(() => {});

    // 🚀 手機 App / 網頁切換至背景後喚醒自動同步
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        reconnectIfNeeded().catch(() => {});
        // 無論是否重連，也補一次 fetchState 更新 sidebar 狀態
        if (!busyRef.current) {
          fetchState()
            .then((s) => {
              setState(s);
              if (s.lastTurn && !busyRef.current) {
                setStory(s.lastTurn.narrative);
                setSuggested(s.lastTurn.suggestedActions);
              }
            })
            .catch(() => {});
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);
  function startTypewriter() {
    if (typewriterTimer.current) return;
    typewriterTimer.current = setInterval(() => {
      if (
        shouldTypewriterOutput({
          queueLength: pendingQueue.current.length,
          llmDone: llmDoneRef.current,
        })
      ) {
        const char = pendingQueue.current.shift()!;
        setStory((s) => s + char);
      } else if (llmDoneRef.current && pendingQueue.current.length === 0) {
        clearInterval(typewriterTimer.current!);
        typewriterTimer.current = null;
      }
    }, typewriterIntervalMsRef.current);
  }

  function stopTypewriter(clearQueue = false) {
    if (typewriterTimer.current) {
      clearInterval(typewriterTimer.current);
      typewriterTimer.current = null;
    }
    if (clearQueue) {
      pendingQueue.current = [];
    }
    llmDoneRef.current = false;
  }

  function waitForTypewriter(): Promise<void> {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (!typewriterTimer.current) {
          clearInterval(check);
          resolve();
        }
      }, typewriterIntervalMsRef.current);
    });
  }

  async function reconnectIfNeeded() {
    if (busyRef.current || reconnectingRef.current) return;
    try {
      const status = await fetchTurnStatus();
      if (!status.active) return;
      // 回合仍在進行中
      reconnectingRef.current = true;
      stopTypewriter(true); // 清掉可能殘留的舊 timer 再開始重播
      setBusy(true);
      setStory("");
      setSuggested([]);
      try {
        await streamTurnFromOffset(0, (ev) => {
          switch (ev.type) {
            case "delta":
              for (const char of ev.text) {
                pendingQueue.current.push(char);
              }
              startTypewriter();
              break;
            case "transition":
              setStory(
                (s) =>
                  s + `\n\n【${ev.to === "dungeon" ? `進入副本 ${ev.dungeonId ?? ""}` : "返回安全區"}】\n\n`,
              );
              setSuggested([]);
              break;
            case "warning":
              setStory((s) => s + `\n[提示] ${ev.message}\n`);
              break;
            case "error":
              stopTypewriter(true);
              setStory((s) => s + `\n[錯誤] ${ev.message}\n`);
              break;
            case "done":
              if (ev.protagonistDied) {
                setProtagonistDied(true);
                setSuggested([]);
              } else if (ev.awaitingUserInput) {
                setSuggested(ev.suggestedActions ?? []);
              } else {
                setSuggested([]);
              }
              if (ev.state) setState(ev.state);
              llmDoneRef.current = true;
              break;
          }
        });
        await waitForTypewriter(); // 等 typewriter 排空再 refresh
        await refresh();

      } catch (e) {
        stopTypewriter(true);
        if (e instanceof Error && e.message === "GONE") {
          await refresh();
          setStory((s) => s || "連線已中斷，已還原最後進度。");
        } else {
          setStory((s) => s + `\n[重連失敗] ${(e as Error).message}\n`);
        }
      } finally {

        reconnectingRef.current = false;
        setBusy(false);
      }
    } catch {
      // fetchTurnStatus 失敗，靜默忽略（網路問題，不影響現有流程）
    }
  }

  async function send(action: string) {
    const text = action.trim();
    if (!text || busy) return;
    setBusy(true);
    setStory("");
    stopTypewriter(true);
    llmDoneRef.current = false;
    setSuggested([]);
    setInput("");
    // 新回合：把劇情卡捲到可視區頂端，streaming 期間不再自動捲動
    storyEndRef.current?.parentElement?.scrollIntoView({ behavior: "smooth", block: "start" });

    // 🚀 Capture the exact pre-turn state and lastUpdated snapshot to avoid any race conditions with background refresh
    const preTurnLastUpdated = state?.now?.lastUpdated;

    try {
      await streamTurn(text, (ev) => {
        switch (ev.type) {
          case "delta":
            for (const char of ev.text) {
              pendingQueue.current.push(char);
            }
            startTypewriter();
            break;
          case "transition":
            setStory(
              (s) =>
                s + `\n\n【${ev.to === "dungeon" ? `進入副本 ${ev.dungeonId ?? ""}` : "返回安全區"}】\n\n`,
            );
            setSuggested([]); // 轉場時清空上回合的過期按鈕，防止幽靈按鈕殘留
            break;
          case "warning":
            setStory((s) => s + `\n[提示] ${ev.message}\n`);
            break;
          case "error":
            stopTypewriter(true);
            setStory((s) => s + `\n[錯誤] ${ev.message}\n`);
            break;
          case "done":
            if (ev.protagonistDied) {
              setProtagonistDied(true);
              setSuggested([]); // 死亡時不顯示建議行動 chips
            } else if (ev.awaitingUserInput) {
              setSuggested(ev.suggestedActions ?? []);
            } else {
              // 自動推進中的中間回合：還會有後續回合，不要先露出看起來可點、實際被 busy 鎖死的建議 chips
              setSuggested([]);
            }
            if (ev.state) setState(ev.state);
            llmDoneRef.current = true;
            break;
        }
      });
      await refresh();
      clearReconnectState();
    } catch (e) {
      stopTypewriter(true);
      clearReconnectState();
      // 🚀 斷線與背景喚醒自我癒合機制 ── 帶重試輪詢 (Polling with backoff/retries for slow self-hosted models)
      console.warn("streamTurn 發生中斷，開始執行自我癒合輪詢檢測...", e);

      const maxAttempts = 6; // 總共輪詢 6 次
      const pollIntervalMs = 3000; // 每 3 秒輪詢一次（符合自架 MoE 模型預計算/吐字週期）
      let healed = false;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          if (attempt > 1) {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          }

          console.log(`[癒合輪詢] 第 ${attempt}/${maxAttempts} 次嘗試拉取最新狀態...`);
          const freshState = await fetchState();

          // 確保當前 state 存在且 lastUpdated 已經推進了，才進行癒合
          if (
            freshState.lastTurn &&
            preTurnLastUpdated &&
            freshState.now.lastUpdated !== preTurnLastUpdated
          ) {
            console.log(`[癒合成功] 偵測到伺服器端已順利完成回合，lastUpdated 從 ${preTurnLastUpdated} 推進至 ${freshState.now.lastUpdated}`);
            setState(freshState);
            setStory(freshState.lastTurn.narrative);
            setSuggested(freshState.lastTurn.suggestedActions);
            healed = true;
            break; // 成功癒合，退出輪詢
          }
        } catch (err) {
          console.warn(`[癒合輪詢] 第 ${attempt} 次拉取失敗:`, err);
        }
      }

      if (!healed) {
        // 如果所有輪詢結束後仍未偵測到進度推進，則判定為真失敗
        setStory((s) => s + `\n[請求失敗] ${(e as Error).message}（伺服器可能未完成運算，請確認網路或手動重整）`);
      }
    } finally {
      await waitForTypewriter();
      setBusy(false);
    }
  }

  const isDungeon = state?.mode === "dungeon";

  if (worldInitialized === null) return <div className="app-shell app-shell--main" />;
  if (!worldInitialized) {
    return <WorldSetupWizard onDone={(s) => { setState(s); setWorldInitialized(true); loadedInitialRef.current = true; }} />;
  }

  return (
    <div className={`app-shell ${isDungeon ? "app-shell--dungeon" : "app-shell--main"}`}>
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
          {version && (
            <span className="version-tag" title={version.message}>
              {version.hash}
            </span>
          )}
          <div className="header-actions">
            {/* 開面板：桌面已有常駐側邊欄，僅行動裝置顯示（CSS 在桌面隱藏此顆） */}
            <button
              className="icon-btn header-actions__panel"
              aria-label="開啟角色／系統面板"
              onClick={() => setShowStatus(true)}
            >
              <IconUser />
            </button>
            {/* 封存世界＝操作行為，放 header 右側（所有視窗皆顯示），不混進遊戲資訊面板 */}
            <button
              className="icon-btn icon-btn--danger"
              aria-label="結束並封存世界"
              title="結束並封存世界"
              disabled={busy || protagonistDied}
              onClick={() => setShowEndWorld(true)}
            >
              <IconArchive />
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
            {busy && <div className="computing-hint">{COMPUTING_HINT}</div>}

            {suggested.length > 0 && !protagonistDied && (
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
                disabled={busy || protagonistDied}
                placeholder="你的行動，例如：觀察四周、對其他人說話、使用技能或道具…"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send(input)}
              />
              <button
                className="send-btn"
                disabled={busy || protagonistDied}
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
      {showEndWorld && (
        <EndWorldModal
          onClose={() => setShowEndWorld(false)}
          onConfirm={async () => {
            // 後端 /api/world/end 仍需 confirmText === "封存"，由前端程式帶入（使用者不必打字）
            try { await endWorld("封存"); setWorldInitialized(false); }
            catch (e) { setStory((s) => s + `\n[錯誤] ${(e as Error).message}\n`); }
          }}
        />
      )}
      {protagonistDied && (
        <DeathChoiceModal
          onKeepWorldDone={(s) => { setState(s); setProtagonistDied(false); setStory("新主角接替了這個世界。"); }}
          onEndWorldDone={() => { setProtagonistDied(false); setWorldInitialized(false); }}
        />
      )}
    </div>
  );
}

export function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="value">
        {value ? <ReactMarkdown>{value}</ReactMarkdown> : "—"}
      </div>
    </div>
  );
}

function StatusDrawer({ state, onClose }: { state: GameState; onClose: () => void }) {
  // 抽屜純粹鏡像側邊欄的「遊戲資訊」（狀態/NPC），不放操作行為；
  // 「封存世界」這類操作改由 header 操作列觸發。
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <h2>角色 / 系統面板</h2>
          <button className="icon-btn" aria-label="關閉面板" onClick={onClose}><IconClose /></button>
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

function IconArchive() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
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
