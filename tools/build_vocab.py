# -*- coding: utf-8 -*-
"""生成 vocab.js

把基础词表与增强数据合并成 7 字段格式：

    data/vocab_base.json      [[word, cn, level, cat], ...]        人工整理，权威
    data/vocab_enriched.json  {word: {ph, en, ee, ec}}             词典接口抓取缓存

输出（仓库根目录）：

    vocab.js   const vocab = [[word, cn, level, cat, ph, en, ee], ...]

    ph = 音标, en = 英文释义, ee = 英文例句, ec = 例句中文
    缺失的字段写空字符串，前端会自动隐藏空白区域。

用法:  python tools/build_vocab.py
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.path.join(ROOT, 'data', 'vocab_base.json')
CACHE = os.path.join(ROOT, 'data', 'vocab_enriched.json')
OUT = os.path.join(ROOT, 'vocab.js')

MAX_DEF = 120
MAX_EX = 160


def clip(s, n):
    s = (s or '').strip()
    if len(s) > n:
        s = s[:n - 3].rstrip() + '...'
    return s


def main():
    with open(BASE, encoding='utf-8') as f:
        base = json.load(f)
    cache = {}
    if os.path.exists(CACHE):
        with open(CACHE, encoding='utf-8') as f:
            cache = json.load(f)

    rows = []
    stat = {'ph': 0, 'en': 0, 'ee': 0}
    for v in base:
        w, cn, lv, cat = v[0], v[1], v[2], v[3]
        info = cache.get(w) or {}
        ph = clip(info.get('ph'), 40)
        en = clip(info.get('en'), MAX_DEF)
        ee = clip(info.get('ee'), MAX_EX)
        ec = clip(info.get('ec'), MAX_EX)
        for k, val in (('ph', ph), ('en', en), ('ee', ee)):
            if val:
                stat[k] += 1
        rows.append([w, cn, lv, cat, ph, en, ee, ec])

    lines = ['const vocab = [']
    for r in rows:
        lines.append('  ' + json.dumps(r, ensure_ascii=False) + ',')
    lines.append('];')
    lines.append('')
    lines.append('if (typeof module !== "undefined") module.exports = vocab;')

    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines) + '\n')

    n = len(rows)
    print('vocab.js 已生成：%d 词，%d 字节' % (n, os.path.getsize(OUT)))
    print('  音标 %d (%.1f%%)  英文释义 %d (%.1f%%)  英文例句 %d (%.1f%%)'
          % (stat['ph'], 100.0 * stat['ph'] / n,
             stat['en'], 100.0 * stat['en'] / n,
             stat['ee'], 100.0 * stat['ee'] / n))
    return 0


if __name__ == '__main__':
    sys.exit(main())
