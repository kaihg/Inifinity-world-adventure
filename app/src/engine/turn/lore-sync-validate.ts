import type { Logger } from "../../logger.js";
import { ITEM_ID_RE } from "./lore-rewrite.js";
import type { LoreEntityRef } from "../schema.js";

/**
 * 語意空洞、不可當實體 id 的黑名單（小寫比對）。
 * 實機觀察：弱模型常把萬用詞（system/系統/主神）或佔位詞（none/unknown）填進 touched_entities.id，
 * 導致同一個 id 被分到多個 category、建出一堆垃圾檔。
 */
const ID_BLACKLIST: ReadonlySet<string> = new Set([
  "system",
  "none",
  "unknown",
  "na",
  "n/a",
  "null",
  "undefined",
  "主神",
  "系統",
  "系统",
]);

/**
 * 合法 id 形狀：直接複用 repo 既有的 id 慣例 ITEM_ID_RE（= NPC_ID_RE = /^[\w.-]+$/，
 * 英數＋底線＋連字號＋點），避免本 gate 自立更嚴格的方言而把模型合法的 snake_case id
 * （如 water_bottle、collision_alarm_device）誤殺、導致實體永遠不落地。
 * 額外要求至少含一個英數字，擋掉 ITEM_ID_RE 仍會放行的純標點 id（".."、"--"、"__"）。
 * 注意：呼叫端比對前已 toLowerCase，故大小寫差異不影響。
 */
const HAS_ALNUM_RE = /[a-z0-9]/;

/**
 * 對弱模型抽出的 touched_entities 做決定論校驗（落地前的護欄，先於任何 LLM 重寫呼叫）：
 * 1) id 黑名單（system/none/…）→ 剔除
 * 2) id 不符 repo id 慣例（ITEM_ID_RE）或無英數字 → 剔除（正規化為小寫後比對）
 * 3) 同回合同 id 跨 category → 保留首見、剔除後者
 * 任一剔除都 log.warn（與 rewriteNpcFile/rewriteLoreEntity 既有「warn + 略過該筆」風格一致），絕不拋錯。
 * 這同時抑制了「假 entity 暴增 LLM 重寫呼叫」造成的 lore 階段過慢（根因 G 的呼叫量來源）。
 */
export function sanitizeTouchedEntities(entities: LoreEntityRef[], log: Logger): LoreEntityRef[] {
  const seenCategoryById = new Map<string, LoreEntityRef["category"]>();
  const out: LoreEntityRef[] = [];

  for (const e of entities) {
    const id = e.id.trim().toLowerCase();

    if (ID_BLACKLIST.has(id)) {
      log.warn({ entity: e }, "touched_entities id 在黑名單（語意空洞），略過");
      continue;
    }
    if (!ITEM_ID_RE.test(id) || !HAS_ALNUM_RE.test(id)) {
      log.warn({ entity: e }, "touched_entities id 非合法 slug，略過");
      continue;
    }
    const prev = seenCategoryById.get(id);
    if (prev && prev !== e.category) {
      log.warn({ entity: e, firstCategory: prev }, "同回合同 id 跨 category，保留首見、略過後者");
      continue;
    }
    seenCategoryById.set(id, e.category);
    out.push({ ...e, id });
  }

  return out;
}

/**
 * 把通過校驗的實體與「既有檔案實際 category」對齊：
 * 既有檔案是 canonical truth，弱模型若把既有 NPC 誤標成 item（反之亦然），以既有為準並 warn。
 * existingByCategory：各 category 既有 id 集合（由呼叫端就地讀磁碟組出）。
 * npcNameToId：既有 NPC name（正規化小寫）→ canonical id，用來攔截「name 相同但 id 拼法不同」
 *   的重複實體（如模型給 ye_qing 而既有是 yeqing）。只對 category=npc 且 id 全新時生效。
 *
 * 同一 id 可能同時存在於多個 category 目錄（歷史污染留下的殘檔）。此時：
 * - 模型給的 category 本身就是既有歸屬之一 → 視為相符，原樣保留（不可武斷改成別的）。
 * - 模型給的都不在既有歸屬內、但只有單一既有歸屬 → 以既有為準（原本的訂正意圖）。
 * - 多個既有歸屬且模型給的都不在內 → 無從決定，保留模型給的並 warn，不武斷挑一個。
 */
export function reconcileEntityCategories(
  entities: LoreEntityRef[],
  existingByCategory: Record<LoreEntityRef["category"], ReadonlySet<string>>,
  log: Logger,
  npcNameToId?: ReadonlyMap<string, string>,
): LoreEntityRef[] {
  const categoriesById = new Map<string, Set<LoreEntityRef["category"]>>();
  for (const category of Object.keys(existingByCategory) as Array<LoreEntityRef["category"]>) {
    for (const id of existingByCategory[category]) {
      const set = categoriesById.get(id) ?? new Set<LoreEntityRef["category"]>();
      set.add(category);
      categoriesById.set(id, set);
    }
  }

  return entities.map((e) => {
    const actual = categoriesById.get(e.id);
    // 全新實體 → 先做 NPC name 比對，攔截「name 相同但 id 拼法不同」的重複實體
    if (!actual) {
      if (e.category === "npc" && npcNameToId) {
        const canonicalId = npcNameToId.get(e.name.trim().toLowerCase());
        if (canonicalId && canonicalId !== e.id) {
          log.warn({ entity: e, canonicalId }, "NPC name 與既有實體相符，改用既有 id 避免重複建檔");
          return { ...e, id: canonicalId };
        }
      }
      return e;
    }
    // 模型給的 category 已是既有歸屬之一 → 原樣保留
    if (actual.has(e.category)) return e;
    // 單一既有歸屬 → 以既有為準（訂正模型的誤標）
    if (actual.size === 1) {
      const [only] = actual;
      log.warn({ entity: e, actualCategory: only }, "category 與既有檔案衝突，改用既有 category");
      return { ...e, category: only };
    }
    // 多個既有歸屬且模型給的都不在內 → 無從決定，保留模型給的並 warn
    log.warn({ entity: e, existingCategories: [...actual] }, "id 跨多個既有 category 且模型 category 不在其中，保留模型 category");
    return e;
  });
}
