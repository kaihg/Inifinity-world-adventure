import { useState } from "react";
import { resolveProtagonistDeath, type GameState, type ProtagonistSeed } from "./api";

interface Props {
  onKeepWorldDone: (state: GameState) => void;
  onEndWorldDone: () => void;
}

export function DeathChoiceModal({ onKeepWorldDone, onEndWorldDone }: Props) {
  const [mode, setMode] = useState<"choose" | "keep-form" | "end-confirm">("choose");
  const [name, setName] = useState("");
  const [origin, setOrigin] = useState("");
  const [freeform, setFreeform] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function keepWorld() {
    if (busy) return;
    setBusy(true); setError("");
    const seed: ProtagonistSeed = { name, origin, freeform };
    try {
      const result = await resolveProtagonistDeath({ choice: "keep-world", protagonistSeed: seed });
      onKeepWorldDone(result as GameState);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  async function endWorld() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await resolveProtagonistDeath({ choice: "end-world" });
      onEndWorldDone();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  return (
    <div className="drawer-backdrop">
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header"><h2>主角已永久死亡</h2></div>
        {mode === "choose" && (
          <div className="suggested">
            <button className="chip" disabled={busy} onClick={() => setMode("keep-form")}>保留這個世界，新主角接續</button>
            <button className="chip" disabled={busy} onClick={() => setMode("end-confirm")}>結束這個世界</button>
          </div>
        )}
        {mode === "keep-form" && (
          <section className="panel">
            <label>新主角姓名<input value={name} disabled={busy} onChange={(e) => setName(e.target.value)} /></label>
            <label>出身<textarea value={origin} disabled={busy} onChange={(e) => setOrigin(e.target.value)} /></label>
            <label>自由描述<textarea value={freeform} disabled={busy} onChange={(e) => setFreeform(e.target.value)} /></label>
            <button className="send-btn" disabled={busy} onClick={keepWorld}>{busy ? "生成中…" : "確認接續"}</button>
          </section>
        )}
        {mode === "end-confirm" && (
          <section className="panel">
            <p>確定要結束這個世界嗎？此動作會封存整個世界並回到初始化畫面。</p>
            <button className="chip" disabled={busy} onClick={() => setMode("choose")}>取消</button>
            <button className="send-btn" disabled={busy} onClick={endWorld}>{busy ? "封存中…" : "確定結束"}</button>
          </section>
        )}
        {error && <div className="story-text">[錯誤] {error}</div>}
      </aside>
    </div>
  );
}
