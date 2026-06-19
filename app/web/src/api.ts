export interface NowState {
  chapter: string;
  scene: string;
  companions: string;
  activeDungeon: string;
  threads: string;
  nextStep: string;
  lastUpdated: string;
}

export interface ProtagonistDetail {
  name: string;
  points: string;
  attributes: string;
  skills: string;
  items: string;
  buffs: string;
}

export interface NpcEntry {
  id: string;
  name: string;
  role: string;
  status: string;
}

export interface GameState {
  now: NowState;
  protagonist: { name: string; points: string };
  protagonistDetail: ProtagonistDetail;
  npcs: NpcEntry[];
  mode: "main-space" | "dungeon";
}

export async function fetchState(): Promise<GameState> {
  const res = await fetch("/api/state");
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

export type TurnEvent =
  | { type: "ping" }
  | { type: "delta"; text: string }
  | { type: "warning"; message: string }
  | { type: "auto-advance"; index: number }
  | { type: "transition"; to: "dungeon" | "main-space"; dungeonId?: string }
  | { type: "error"; message: string }
  | {
      type: "done";
      narrative: string;
      committed: boolean;
      awaitingUserInput: boolean;
      suggestedActions: string[];
      modeTransition: string | null;
    };

/** 送出一個回合，解析 SSE 串流，逐事件回呼 */
export async function streamTurn(input: string, onEvent: (ev: TurnEvent) => void): Promise<void> {
  const res = await fetch("/api/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });
  if (!res.body) throw new Error("無回應串流");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.replace(/^data: /, "").trim();
      if (!line) continue;
      try {
        onEvent(JSON.parse(line) as TurnEvent);
      } catch {
        /* 忽略不完整片段 */
      }
    }
  }
}
