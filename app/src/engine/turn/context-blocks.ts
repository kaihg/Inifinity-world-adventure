import { formatRecallBlock } from "../../recall/index.js";
import {
  formatIntentsBlock,
  parseCompanionIds,
  runCharacterPrePass,
  type CharacterIntent,
} from "../character-pre-pass.js";
import type { GameState } from "../context.js";
import type { TurnDeps, TurnEvent } from "./types.js";

/**
 * 對在場 NPC 跑角色意圖 pre-pass，回傳 warning events 與格式化後的 intentsBlock。
 * 失敗靜默降級——不 block 回合，但 yield warning 讓前端可觀察。
 */
export async function* runPrePassBlock(
  deps: TurnDeps,
  state: GameState,
  input: string,
): AsyncGenerator<TurnEvent, string> {
  const charClient = deps.characterClient ?? deps.client;
  const npcIds = parseCompanionIds(state.now.companions, state.npcs);
  const npcNames = Object.fromEntries(state.npcs.map((n) => [n.id, n.name]));
  if (npcIds.length === 0) return "";

  let intents: CharacterIntent[];
  try {
    intents = await runCharacterPrePass({
      npcIds,
      scene: state.now.scene,
      playerInput: input,
      worldDir: deps.worldDir,
      client: charClient,
    });
  } catch (err) {
    yield {
      type: "warning" as const,
      message: `character pre-pass 全部失敗：${(err as Error).message}`,
    };
    return "";
  }

  if (intents.length < npcIds.length) {
    const returnedIds = new Set(intents.map((i) => i.id));
    const missing = npcIds.filter((id) => !returnedIds.has(id));
    yield {
      type: "warning" as const,
      message: `character pre-pass 部分失敗，略過：${missing.join(", ")}`,
    };
  }

  return formatIntentsBlock(intents, npcNames);
}

const DEFAULT_RECALL_TOP_K = 5;
/** 最大查詢字元數：避免過長的上一回合敘事把向量模型拖慢 */
const MAX_RECALL_QUERY_LENGTH = 2000;

/**
 * 對 deps.recall（若有）以「上一回合敘事 + 玩家輸入」做語意檢索，格式化成 recallBlock。
 * lastNarrative：上一回合 Layer 1 產出的敘事段落（從 state.lastTurn?.narrative 傳入）；
 *   缺省時（opening 回合或 recall 首次）只用 input 查詢。
 * 失敗靜默降級——不 block 回合，但 yield warning 讓前端可觀察。
 */
export async function* runRecallBlock(
  deps: TurnDeps,
  input: string,
  lastNarrative?: string,
): AsyncGenerator<TurnEvent, string> {
  if (!deps.recall) return "";
  try {
    const query = [lastNarrative, input]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, MAX_RECALL_QUERY_LENGTH);
    const hits = await deps.recall.query(query, deps.recallTopK ?? DEFAULT_RECALL_TOP_K);
    return formatRecallBlock(hits);
  } catch (err) {
    yield { type: "warning" as const, message: `recall 檢索失敗，略過：${(err as Error).message}` };
    return "";
  }
}
