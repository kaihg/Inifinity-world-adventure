# 副本目錄結構

每個副本一個子目錄：`world/dungeons/<dungeon-id>/`

```
world/dungeons/<dungeon-id>/
  wiki.md            # 已揭露的累積知識：地圖、機關、NPC、已知規則、跨次進入的記憶
  secrets.md         # 尚未揭露的隱藏真相（機關原理、NPC真實動機、劇情轉折），首次進入時生成，劇透文件
  runs/
    <run-id>.md       # 單次進入的完整對話 log（對應一個 PR/branch），append-only
```

- `wiki.md` 是**精煉後**、**玩家已知**的 canonical 知識，每次進入副本時優先讀這份，不讀歷史 `runs/*.md` 全文。
- `secrets.md` 是該副本的「母版真相」，由 `enter-dungeon` 首次進入時自主生成（不跟使用者討論），僅供 LLM 敘事時保持暗線一致，**不可提前講給玩家**。打開它等同劇透，建議不要主動查看。
- `runs/<run-id>.md` 是該次 PR branch 上的原始流水帳（含 `roll-random` 的實際指令與輸出），結算時由 `settle-dungeon` 提煉合併進 `wiki.md` 與 `characters/*.md`：只有實際劇情中揭露的部分會從 `secrets.md` 移入 `wiki.md`，原始記錄保留供事後查證矛盾。
- 同一個副本可以被多次進入（不同 `run-id`），`wiki.md` 在多次 run 之間延續，`secrets.md` 只生成一次不重新覆寫。
