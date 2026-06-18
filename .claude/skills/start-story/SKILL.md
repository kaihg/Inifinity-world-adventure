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

## 叙事语言规范

- **全程使用繁体中文 + 台湾用词**，禁止简体习惯用词混入。常见地雷：「信息」→「資訊」、「视频」→「影片」、「软件」→「軟體」、「网络」→「網路」、「质量」（指品质时）→「品質」、「内存」→「記憶體」。输出前自查一遍用词。
- 旁白与对话都要用繁体；面板/系统提示文字也用繁体。

## 叙事节奏与人物一致性

- **开场/重大设定冲击不要一步到位陈述完**：被选中、传送、面板出现这类冲击，先给感官细节与主角情绪反应（混乱、恐惧、抗拒、好奇……），再带出机制说明，不要旁白直接条列规则。
- **新机制（面板、兑换、系统对话）第一次出现时放慢**：让主角有摸索、惊讶、迟疑的反应，不要表现得像主角早已熟悉这套规则。
- **人物一致性**：每次引入或重新提及一个 NPC 前，先确认这个人之前的外观/身份/名字描述（必要时重读 `world/characters/<id>.md` 或回顾对话上文），不要凭印象重新「派生」一个新设定给同一个人，也不要把不同人的特征混到一起。如果记不清前文设定的细节，宁可少写细节，不要编造可能矛盾的内容。
- **场景逻辑要交代清楚**：道具/机关的触发条件如果对不同角色有不同反应（例如某扇门有人推不开、主角一靠近就开），要在叙事中给出可被理解的原因，不能毫无解释地前后矛盾。

## 注意

- 本 skill 不处理副本内的叙事（那是 `enter-dungeon` 之后的事），只处理副本之间的常态剧情。
- 若使用者的请求明显是仓库维护性质（改文件结构、讨论 skill 设计），不要套用本 skill 的角色代入语气，正常以助理身份回应即可。
