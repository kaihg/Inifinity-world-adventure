import { useState } from "react";
import { initWorld, type GameState, type WorldInitRequest } from "./api";

const COMPUTING_HINT = "🌌 主控系統正在生成新世界…（自架模型可能需數十秒，請稍候）";

const DIFFICULTY = ["簡單", "普通", "困難", "地獄"];
const GOD_PERSONA = ["冷酷疏離", "戲謔玩味", "公正如儀", "高深莫測"];
const PROTECTION = ["寬鬆", "標準", "嚴苛", "無保護"];

const RANDOM = "__random__";
// 單選值：空字串＝不選（交給 LLM 自由發揮）；RANDOM＝送出時抽一個具體值；其餘＝具體選項
type Choice = "" | typeof RANDOM | string;

function pickRandom(opts: string[]): string {
  return opts[Math.floor(Math.random() * opts.length)];
}

// 不選 → 送 ""（後端視為未指定）；隨機 → 抽一個具體值；具體 → 原值
function resolveChoice(value: Choice, opts: string[]): string {
  if (value === RANDOM) return pickRandom(opts);
  if (value === "") return "";
  return value;
}

function ChoiceGroup({ label, options, value, onChange, disabled }: {
  label: string;
  options: string[];
  value: Choice;
  onChange: (v: Choice) => void;
  disabled: boolean;
}) {
  const toggle = (v: Choice) => onChange(value === v ? "" : v);
  return (
    <div className="choice-group">
      <span className="choice-label">{label}</span>
      <div className="choice-chips" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o}
            type="button"
            disabled={disabled}
            aria-pressed={value === o}
            className={`chip chip--select${value === o ? " is-selected" : ""}`}
            onClick={() => toggle(o)}
          >
            {o}
          </button>
        ))}
        <button
          type="button"
          disabled={disabled}
          aria-pressed={value === RANDOM}
          className={`chip chip--select${value === RANDOM ? " is-selected" : ""}`}
          onClick={() => toggle(RANDOM)}
        >
          隨機
        </button>
      </div>
    </div>
  );
}

export function WorldSetupWizard({ onDone }: { onDone: (state: GameState) => void }) {
  const [difficulty, setDifficulty] = useState<Choice>("");
  const [godPersona, setGodPersona] = useState<Choice>("");
  const [protection, setProtection] = useState<Choice>("");
  const [name, setName] = useState("");
  const [freeform, setFreeform] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    const body: WorldInitRequest = {
      preferences: {
        difficulty: resolveChoice(difficulty, DIFFICULTY),
        godPersona: resolveChoice(godPersona, GOD_PERSONA),
        protectionRule: resolveChoice(protection, PROTECTION),
      },
      protagonistSeed: { name, freeform },
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
            <p>各項皆可不選——不選的交由主控系統自由發揮，或點「隨機」讓系統替你抽一個。</p>
            <div className="setup-form">
              <ChoiceGroup label="難度" options={DIFFICULTY} value={difficulty} onChange={setDifficulty} disabled={busy} />
              <ChoiceGroup label="主神性格" options={GOD_PERSONA} value={godPersona} onChange={setGodPersona} disabled={busy} />
              <ChoiceGroup label="新手保護" options={PROTECTION} value={protection} onChange={setProtection} disabled={busy} />
              <hr />
              <label className="modal-field">主角姓名<input value={name} disabled={busy} onChange={(e) => setName(e.target.value)} /></label>
              <label className="modal-field">主角描述（出身、性格、目標等，可留空）<textarea value={freeform} disabled={busy} onChange={(e) => setFreeform(e.target.value)} /></label>
              <button className="btn btn--primary" disabled={busy} onClick={submit}>
                {busy ? "生成中…" : "建立世界"}
              </button>
            </div>
            {busy && <div className="computing-hint">{COMPUTING_HINT}</div>}
            {error && <div className="story-text">[錯誤] {error}</div>}
          </section>
        </main>
      </div>
    </div>
  );
}
