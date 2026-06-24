import { useState } from "react";
import { resolveProtagonistDeath, type GameState, type ProtagonistSeed } from "./api";

interface Props {
  onKeepWorldDone: (state: GameState) => void;
  onEndWorldDone: () => void;
}

export function DeathChoiceModal({ onKeepWorldDone, onEndWorldDone }: Props) {
  const [mode, setMode] = useState<"choose" | "keep-form" | "end-confirm">("choose");
  const [name, setName] = useState("");
  const [freeform, setFreeform] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function keepWorld() {
    if (busy) return;
    setBusy(true); setError("");
    const seed: ProtagonistSeed = { name, freeform };
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

  // 阻斷式抉擇：不提供背景點擊關閉，必須在「換代 / 結束世界」之間做出選擇
  return (
    <div className="modal-backdrop">
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="death-title">
        <h2 id="death-title" className="modal-title">主角已永久死亡</h2>

        {mode === "choose" && (
          <>
            <p className="modal-body">這條時間線到此為止。你可以讓新主角接續這個世界，或結束並封存它。</p>
            <div className="modal-choices">
              <button className="btn btn--primary" disabled={busy} onClick={() => setMode("keep-form")}>保留這個世界，新主角接續</button>
              <button className="btn btn--danger" disabled={busy} onClick={() => setMode("end-confirm")}>結束這個世界</button>
            </div>
          </>
        )}

        {mode === "keep-form" && (
          <>
            <p className="modal-body">描述接替的新主角（皆可留空，交由主控系統自由發揮）：</p>
            <div className="modal-form">
              <label className="modal-field">新主角姓名<input value={name} disabled={busy} onChange={(e) => setName(e.target.value)} /></label>
              <label className="modal-field">主角描述（出身、性格、目標等，可留空）<textarea value={freeform} disabled={busy} onChange={(e) => setFreeform(e.target.value)} /></label>
            </div>
            <div className="modal-actions">
              <button className="btn btn--ghost" disabled={busy} onClick={() => setMode("choose")}>返回</button>
              <button className="btn btn--primary" disabled={busy} onClick={keepWorld}>{busy ? "生成中…" : "確認接續"}</button>
            </div>
          </>
        )}

        {mode === "end-confirm" && (
          <>
            <p className="modal-body">確定要結束這個世界嗎？此動作會封存整個世界並回到世界初始化畫面。</p>
            <div className="modal-actions">
              <button className="btn btn--ghost" disabled={busy} onClick={() => setMode("choose")}>返回</button>
              <button className="btn btn--danger" disabled={busy} onClick={endWorld}>{busy ? "封存中…" : "確定結束"}</button>
            </div>
          </>
        )}

        {error && <div className="modal-error">[錯誤] {error}</div>}
      </div>
    </div>
  );
}
