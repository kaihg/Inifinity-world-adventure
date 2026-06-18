# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

这个 repo 不是传统软件项目，而是一个**「无限恐怖」类型小说的文本保存站与对话中心**：单一主角、单一世界，由使用者与 Claude Code（或其他 LLM CLI）对话推进剧情，所有世界状态、角色档案、副本记录都以 Markdown 文件保存在仓库里，git 历史本身就是故事的版本记录。

「无限恐怖」设定：主角进入由「主神/系统」掌控的空间，反复进出「副本」执行任务赚取积分，用积分兑换能力成长，直到通关或死亡。具体规则由 `world/setting.md` 定义，**不要凭空套用某部小说的设定，一切以仓库里实际写的规则为准**。

没有任何应用代码、构建系统、测试框架——所有"开发"工作都是读写 Markdown 文件 + 使用 `.claude/skills/` 下的 skill + git 操作。

## 核心循环

1. **世界状态**存在 `world/`，是当前 lifetime 的唯一真相来源（canonical truth）。
2. **剧情模式切换** = `start-story` skill。这是跟一般仓库维护对话（改 CLAUDE.md、调 skill、讨论架构）的分界线——只有 `start-story` 之后的对话才代入主神/系统语气与主角视角。主空间（副本之间：兑换积分、休整、NPC 互动）直接在当前分支对话+commit，不需要开 PR。
3. **进入副本** = 开一个 git branch + PR（`enter-dungeon` skill）。整个副本期间的剧情对话，逐步以 commit 落到该 branch 的 run log 里。进入副本通常是**半强制**的：使用者可以主动要求，LLM 也要在 `start-story` 对话中依设定判断「系统强制开启副本」的剧情节点主动触发，不必每次等使用者下指令。
4. **副本结束**（通关 / 死亡 / 撤退）都要**合并回 main**（`settle-dungeon` skill）——死亡不等于丢弃 PR，新手保护等后果由结算规则处理，不是靠不合并来逃避。
5. **合并后**触发 `.github/workflows/settle-on-merge.yml`，提醒/触发把本次 run 的内容提炼进角色档案与副本 wiki。
6. **`/init-world`** 是唯一的"重开"入口：封存当前 `world/` 到 `archives/<timestamp>/`，再与用户对话生成全新世界设定。

## 目录结构

```
world/
  setting.md              # 主神/系统规则、世界基调、当前篇章、新手保护条款——叙事必须严格遵守
  characters/
    index.md               # 轻量角色索引（先读这个，不要一次读全部角色档案）
    protagonist.md          # 主角：积分、属性、技能、物品、buff/debuff
    <npc-id>.md             # 重要 NPC/队友/敌人档案，随故事持续更新
  dungeons/
    <dungeon-id>/
      wiki.md               # 该副本提炼后的累积知识（地图/机关/规则），多次进入间延续，进副本时优先读这份
      runs/<run-id>.md       # 单次进入的原始对话 log，append-only，对应一个 PR/branch
archives/
  <timestamp>/world/...      # /init-world 重置前的整份世界快照，只读
.claude/skills/
  init-world/                # 重置世界
  start-story/                # 切换成剧情模式，处理副本之间的主空间对话
  enter-dungeon/              # 开副本（建分支+PR，开始叙事），含半强制触发判断
  roll-random/                # 产生可验证随机数，机率判定专用
  settle-dungeon/              # 副本结束后的结算 + 合并
.github/workflows/
  settle-on-merge.yml          # PR 合并到 main 后提醒/触发结算
```

## 关键约定

- **状态文件用 Markdown，不用 JSON**：因为故事和角色关系会越来越复杂，类似 wiki 持续生长，结构化字段会限制叙事弹性。读写状态时维持人类可读、分段清晰，方便 LLM 增量编辑而不是整篇重写。
- **`index.md` 类文件是为了省 context**：角色一多就不能每次全读，先读索引，需要细节再读对应档案。`dungeons/<id>/wiki.md` 同理优先于 `runs/*.md` 全文。
- **`wiki.md`（提炼知识）与 `runs/*.md`（原始记录）分离**：`runs/*.md` 是不可篡改的流水账（靠 git 历史天然防止事后改写），`wiki.md`/角色档案才是下次对话真正会读的「canonical truth」。结算时必须把 run log 提炼进 wiki，而不是整段复制。
- **机率事件必须真随机**：技能命中率、暴击、随机事件等一律先用 `roll-random` skill（实际跑 `python3 -c "import random; ..."` 之类命令）取得数值，再依数值叙事。禁止 LLM 直接「演」出一个机率结果而不掷骰，也禁止先编故事再凑一个随机数。
- **死亡也要合并 PR**：新手保护机制是靠 `settle-dungeon` 按 `world/setting.md` 规则做结算（扣分、清状态等），而不是不合并 PR 来回避后果。
- **剧情模式 vs 维护对话要分清**：没有进入 `start-story` 的对话（例如改这份 CLAUDE.md、调整 skill）不要代入主神/系统角色语气；副本进入可以由叙事内容半强制触发，不是只能等使用者明确下指令。
- **单一主角、单一世界**：本仓库只服务一条故事线；其他人想玩自己的版本应该 fork 仓库，而不是在这里加第二个主角或第二个世界。
- **GitHub Action 默认零成本**：`settle-on-merge.yml` 默认只留言提醒，由使用者手动在 Claude Code 里跑 `settle-dungeon`。如果要让 Action 自动呼叫 Claude API 完成结算（会产生费用），需要自己加 `ANTHROPIC_API_KEY` secret 并按 workflow 文件里的注释打开 `auto-settle` job。
