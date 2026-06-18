---
name: settle-dungeon
description: Settle a finished dungeon run (cleared, died, or retreated) - distill the run log into the dungeon wiki and update character/index files, then merge the PR back to main. Use when a dungeon run has reached an end state and needs to be closed out, or when triggered by the settle-on-merge GitHub Action.
---

# settle-dungeon

副本结束后的结算流程。**无论通关、死亡还是中途撤退，都走这个流程并合并回 main**——死亡不代表丢弃这个 PR，新手保护等后果由结算规则处理。

## 步骤

1. **读取本次 run 的完整记录**：`world/dungeons/<dungeon-id>/runs/<run-id>.md`（即该 PR branch 上累积的全部 commit 内容）。
2. **判定结束类型**：通关 / 死亡 / 中途撤退，并依 `world/setting.md` 当前规则（含新手保护条款）决定积分增减、惩罚或奖励。
3. **提炼进 wiki（不是复制粘贴全文）**：
   - 更新（或新建）`world/dungeons/<dungeon-id>/wiki.md`：本次新发现的地图/机关/规则/NPC，已经死亡或消耗掉的资源。
   - 原始 `runs/<run-id>.md` 保留不删，作为可回溯的原始记录。
4. **更新角色状态**：
   - `world/characters/protagonist.md`：积分、属性变化、新增/消耗的技能与物品、buff/debuff、新手保护剩余次数等。
   - 涉及到的 NPC：更新对应 `world/characters/<id>.md`，若是新出现的重要角色，新建档案并在 `index.md` 加一行。
5. **死亡的特殊处理**：若设定中新手保护允许死亡不等于 game over，依规则记录「死亡惩罚」（例如扣积分、清空部分物品、留下后遗症 debuff），而不是直接结束故事——除非设定明确写了保护已用尽。
6. **提交并合并**：
   - 把以上更新 commit 到该 dungeon run 的 branch。
   - 合并 PR 回 main（无论结果好坏都合并）。
   - 合并后可删除该 run 的临时分支（`runs/<run-id>.md` 内容已经在 main 上保留，不会丢失）。

## 注意

- 这个 skill 也是 `.github/workflows/settle-on-merge.yml` 在 PR 合并后会提示调用的同一套逻辑；手动结算与 Action 触发的结算必须遵守同一份规则，不要为了自动化场景简化判定标准。
