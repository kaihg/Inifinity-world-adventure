# 世界存檔（Archives）

每次執行 `/init-world` 重置世界前，會把當前 `world/` 整份打包封存到：

```
archives/<timestamp>/world/...
```

封存只讀，不再修改，僅供回溯查閱前一世（lifetime）的設定與角色結局。
