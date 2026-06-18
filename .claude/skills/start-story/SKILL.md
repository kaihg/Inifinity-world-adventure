---
name: start-story
description: Switch into in-character narrative mode for main-space (主神空间/安全区) dialogue between dungeon runs - status checks, point exchanges, NPC interactions, deciding what's next. Use when the user wants to begin or continue the story outside of a dungeon run, as opposed to repo-maintenance conversations (editing CLAUDE.md, skills, git operations) which stay in normal assistant mode.
---

# start-story

这个 skill 是「切换成剧情模式」的入口，用来跟一般的仓库维护对话（例如改 CLAUDE.md、调整 skill、讨论架构）区分开——维护对话不代入角色，剧情模式才严格代入 `world/setting.md` 的主神/系统语气与主角第一视角。

副本之间的「主空间」时间（兑换积分、休整、NPC 互动、决定下一步）不需要开 branch/PR，直接在当前分支（通常是 main）上对话与 commit 即可；只有进副本才需要 `enter-dungeon` 的 branch+PR 流程。

## 步骤

1. **读取必要状态**（不要读多余文件）：
   - `world/setting.md`
   - `world/gm-notes.md`（保持暗线一致用，**不可**在对话中提前讲出尚未揭露的内容）
   - `world/characters/index.md` → 按需再读相关 `world/characters/<id>.md`
2. **代入叙事**：以 `world/setting.md` 定义的主神/系统语气与主角视角推进对话，不可凭空更改已设定的规则、属性数值。机率事件一律先呼叫 `roll-random`。
3. **状态变更随手 commit**：兑换积分、领取奖励、NPC 关系变化等，直接更新对应的 `world/characters/*.md`，commit 到当前分支（不需要 PR，因为没有进副本）。
4. **侦测强制进入副本**：依 `world/setting.md` 规则，若剧情发展到系统/主神宣布开启副本、强制传送等节点，主动呼叫 `enter-dungeon`（不必等使用者明确说「我要进副本」）；使用者也可以随时主动要求进入某个副本。

## 注意

- 本 skill 不处理副本内的叙事（那是 `enter-dungeon` 之后的事），只处理副本之间的常态剧情。
- 若使用者的请求明显是仓库维护性质（改文件结构、讨论 skill 设计），不要套用本 skill 的角色代入语气，正常以助理身份回应即可。
