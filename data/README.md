# data/ 说明

词表源数据与增强缓存，**两个文件都需要进版本库**（否则新环境无法重建 `vocab.js`）。

| 文件 | 内容 | 来源 |
|------|------|------|
| `vocab_base.json` | 8079 条 `[单词, 中文释义, 等级, 分类]` | 人工整理，项目的权威词表 |
| `vocab_enriched.json` | `{单词: {ph 音标, en 英文释义, ee 英文例句, ec 例句中文}}` | dictionaryapi.dev（数据源自 Wiktionary） |

## 许可

`vocab_enriched.json` 的内容来源于 Wiktionary，采用 **CC BY-SA 3.0**。
二次分发或商用请保留 `LICENSE` 末尾的署名声明，或换用其它数据源。

## 重新生成

```bash
python tools/fetch_enriched.py    # 补抓缺失条目的音标/释义/例句（断点续抓）
python tools/build_vocab.py       # 合并 -> 仓库根目录 vocab.js
python tools/build.py             # 组装 widget.html 并同步到 dev / dist
```

当前覆盖率：音标 2886 词、英文释义 3298 词、英文例句 2043 词（共 8079 词）；
缺失的字段在界面上会自动隐藏，不会显示空白。
