import { useState } from "react";
import { initWorld, type GameState, type WorldInitRequest } from "./api";

const COMPUTING_HINT = "🌌 主控系統正在生成新世界…（自架模型可能需數十秒，請稍候）";

export function WorldSetupWizard({ onDone }: { onDone: (state: GameState) => void }) {
  const [tone, setTone] = useState("");
  const [horrorIntensity, setHorrorIntensity] = useState("");
  const [godPersona, setGodPersona] = useState("");
  const [protectionRule, setProtectionRule] = useState("");
  const [name, setName] = useState("");
  const [origin, setOrigin] = useState("");
  const [freeform, setFreeform] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    const body: WorldInitRequest = {
      preferences: { tone, horrorIntensity, godPersona, protectionRule },
      protagonistSeed: { name, origin, freeform },
    };
    try {
      const state = await initWorld(body);
      onDone(state);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="app-shell app-shell--main">
      <div className="layout">
        <header className="topbar">
          <div className="brand"><span className="brand-mark">∞</span><h1>建立新世界</h1></div>
        </header>
        <main className="story-col">
          <section className="story-card">
            <p className="story-eyebrow">WORLD SETUP</p>
            <p>所有欄位皆可留空——留空的部分交由主控系統自由發揮。</p>
            <label>基調 / 可參考作品<textarea value={tone} disabled={busy} onChange={(e) => setTone(e.target.value)} /></label>
            <label>恐怖 / 驚悚強度<input value={horrorIntensity} disabled={busy} onChange={(e) => setHorrorIntensity(e.target.value)} /></label>
            <label>主神表面性格<input value={godPersona} disabled={busy} onChange={(e) => setGodPersona(e.target.value)} /></label>
            <label>新手保護規則<textarea value={protectionRule} disabled={busy} onChange={(e) => setProtectionRule(e.target.value)} /></label>
            <hr />
            <label>主角姓名<input value={name} disabled={busy} onChange={(e) => setName(e.target.value)} /></label>
            <label>主角出身<textarea value={origin} disabled={busy} onChange={(e) => setOrigin(e.target.value)} /></label>
            <label>自由描述<textarea value={freeform} disabled={busy} onChange={(e) => setFreeform(e.target.value)} /></label>
            <button className="send-btn" disabled={busy} onClick={submit}>
              {busy ? "生成中…" : "建立世界"}
            </button>
            {busy && <div className="computing-hint">{COMPUTING_HINT}</div>}
            {error && <div className="story-text">[錯誤] {error}</div>}
          </section>
        </main>
      </div>
    </div>
  );
}
