---
name: enter-dungeon
description: Start (or resume) a dungeon run. Creates a branch and PR for the run, sets up the run log, and begins the narrative dialogue strictly following world/setting.md and the current character/dungeon state. Use when the user asks to enter a dungeon, start a new 副本, or re-enter a previously visited dungeon — and also use proactively, without waiting for user request, when the ongoing story (in start-story main-space dialogue) reaches a point where the setting's 主神/系统 forcibly pulls the protagonist into a dungeon (半强制进入机制).
---

# enter-dungeon

开启一次副本「进入」。一次进入 = 一个 git branch + 一个 PR，整个副本期间的剧情对话都发生在这个 branch 上，并以 commit 的形式逐步落地成 log。

## 触发方式

副本进入在无限恐怖设定里通常是**半强制**的，两种触发路径都要支援，不要预设只有使用者主动要求才能进：

- **使用者主动要求**：直接进入下面的步骤。
- **剧情强制触发**：在 `start-story` 的主空间对话中，依 `world/setting.md` 的规则判断「系统/主神宣布即将开启副本、时间到、或强制传送」时，由 LLM 自己判断该呼叫本 skill，不必等使用者下指令。触发前先用一两句叙事给出「察觉到副本即将开启」的过渡（例如系统提示音、空间震动），再正式进入步骤 1，避免没有任何预警就硬切场景。

## 步骤

1. **确认副本身份**：
   - 新副本：与用户商定 `dungeon-id`（短英文/拼音 slug）。
   - 已存在的副本（重新进入）：读取 `world/dungeons/<dungeon-id>/wiki.md`，这是本次叙事必须遵守的既有事实（地图、机关、已死亡的NPC、已知规则等），不可与之矛盾。
2. **读取必要状态**（不要读多余文件）：
   - `world/setting.md`（系统规则、新手保护）
   - `world/characters/index.md` → 按需再读相关 `world/characters/<id>.md`
   - `world/dungeons/<dungeon-id>/wiki.md`（若存在）
3. **建立 branch + run 目录**：
   - 新建分支，例如 `dungeon/<dungeon-id>/<run-id>`（`run-id` 用日期或序号，例如 `run-3`）。
   - 建立 `world/dungeons/<dungeon-id>/runs/<run-id>.md`，文件开头写明：进入时间、当前角色状态摘要、本次副本目标（若已知）。
4. **开 PR**：以草稿/进行中状态开 PR，标题包含 dungeon-id 与 run-id，方便辨识。
5. **开始叙事**：
   - 严格依据 `world/setting.md` 与角色档案叙事，不可凭空更改已设定的规则、属性数值。
   - 凡是涉及机率判定（技能命中、暴击、随机事件、NPC 反应等），**必须**调用 `roll-random` skill 取得真实随机数，禁止直接用文字「演」出结果。
   - 每个回合/关键节点，把对话进展 append 到 `runs/<run-id>.md` 并 commit（不要等到最后一次性写完整段剧情再 commit，方便保留时间序的真实记录）。
6. **副本结束的判定**（通关 / 死亡 / 中途撤退）由叙事内容自然产生。结束后呼叫 `settle-dungeon` skill 处理结算与合并，不要自己手动改 `characters/*.md` 或 `wiki.md`。

## 注意

- 死亡也算「副本结束」，**不是**要放弃这个 PR——仍然走 `settle-dungeon` 流程合并回 main（新手保护机制由结算规则处理，而不是靠不合并来逃避后果）。
- 同一 dungeon-id 可以有多个 run-id（多次进入），`wiki.md` 在多次 run 间累积延续，`runs/*.md` 彼此独立、append-only。
