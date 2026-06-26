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

export interface LastTurnRecord {
  narrative: string;
  suggestedActions: string[];
}

export interface GameState {
  now: NowState;
  protagonist: { name: string; points: string };
  protagonistDetail: ProtagonistDetail;
  npcs: NpcEntry[];
  mode: "main-space" | "dungeon";
  lastTurn: LastTurnRecord | null;
}

export async function fetchState(): Promise<GameState> {
  const res = await fetch("/api/state");
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

export interface AppVersion {
  hash: string;
  message: string;
}

export async function fetchVersion(): Promise<AppVersion> {
  const res = await fetch("/api/version");
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

export type TurnEvent =
  | { type: "ping" }
  | { type: "delta"; text: string }
  | { type: "warning"; message: string }
  | { type: "transition"; to: "dungeon" | "main-space"; dungeonId?: string }
  | { type: "error"; message: string }
  | {
      type: "done";
      narrative: string;
      committed: boolean;
      awaitingUserInput: boolean;
      suggestedActions: string[];
      modeTransition: string | null;
      transitionDungeonId?: string;
      transitionDungeonGoal?: string;
      protagonistDied: boolean;
      state?: GameState;
    };

async function readSSEStream(reader: ReadableStreamDefaultReader<Uint8Array>, onEvent: (ev: TurnEvent) => void): Promise<void> {
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

/** 送出一個回合，解析 SSE 串流，逐事件回呼 */
export async function streamTurn(input: string, onEvent: (ev: TurnEvent) => void): Promise<void> {
  const res = await fetch("/api/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  if (!res.body) throw new Error("無回應串流");
  await readSSEStream(res.body.getReader(), onEvent);
}

export interface ProtagonistSeed {
  name?: string;
  /** 出身、性格、目標等自由描述（合併原 origin/freeform 兩欄） */
  freeform?: string;
}

export interface WorldInitRequest {
  preferences?: {
    difficulty?: string;
    godPersona?: string;
    protectionRule?: string;
  };
  protagonistSeed?: ProtagonistSeed;
}

export async function fetchWorldStatus(): Promise<{ initialized: boolean }> {
  const res = await fetch("/api/world/status");
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

export async function initWorld(body: WorldInitRequest): Promise<GameState> {
  const res = await fetch("/api/world/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

export async function endWorld(confirmText: string): Promise<{ archivedTo: string }> {
  const res = await fetch("/api/world/end", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmText }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

export async function resolveProtagonistDeath(
  body:
    | { choice: "keep-world"; protagonistSeed: ProtagonistSeed }
    | { choice: "end-world" },
): Promise<GameState | { archivedTo: string }> {
  const res = await fetch("/api/world/protagonist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

export async function fetchTurnStatus(): Promise<{ active: boolean; turnId: string | null }> {
  const res = await fetch("/api/turn/status");
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

/** 從指定 offset 重播已落地事件，並持續接收新事件直到串流結束 */
export async function streamTurnFromOffset(
  offset: number,
  onEvent: (ev: TurnEvent) => void,
): Promise<void> {
  const res = await fetch(`/api/turn/stream?offset=${offset}`);
  if (res.status === 204) return; // 沒有需要重播的事件
  if (res.status === 410) throw new Error("GONE"); // buffer 已清，呼叫端降級處理
  if (!res.ok) throw new Error("HTTP " + res.status);
  if (!res.body) throw new Error("無回應串流");

  await readSSEStream(res.body.getReader(), onEvent);
}
