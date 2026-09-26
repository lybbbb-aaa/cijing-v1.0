# -*- coding: utf-8 -*-
"""抓取词库增强数据（音标 / 英文释义 / 英文例句）写入 data/vocab_enriched.json

数据源：dictionaryapi.dev（词典数据源自 Wiktionary，CC BY-SA 3.0）
说明：随机失败是正常的，脚本支持断点续抓——已缓存的词不会重复请求。

用法:  python tools/fetch_enriched.py
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.path.join(ROOT, 'data', 'vocab_base.json')
CACHE = os.path.join(ROOT, 'data', 'vocab_enriched.json')


def fetch_word(word):
    url = 'https://api.dictionaryapi.dev/api/v2/entries/en/' + urllib.parse.quote(word)
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=8) as r:
            data = json.loads(r.read())
        entry = data[0]
        ph = ''
        for p in entry.get('phonetics', []):
            if p.get('text'):
                ph = p['text']
                break
        en_def = ''
        example = ''
        for m in entry.get('meanings', []):
            for d in m.get('definitions', []):
                if not en_def and d.get('definition'):
                    en_def = d['definition']
                if not example and d.get('example'):
                    example = d['example']
                if en_def and example:
                    break
            if en_def and example:
                break
        return {'ph': ph, 'en': en_def, 'ee': example, 'ec': ''}
    except Exception:
        return None


def main():
    with open(BASE, encoding='utf-8') as f:
        base = json.load(f)
    cache = {}
    if os.path.exists(CACHE):
        with open(CACHE, encoding='utf-8') as f:
            cache = json.load(f)
    print('词表 %d，已有缓存 %d' % (len(base), len(cache)))

    todo = [v[0] for v in base if v[0] not in cache]
    print('待抓取 %d' % len(todo))

    fetched = failed = 0
    for i, word in enumerate(todo):
        r = fetch_word(word)
        if r:
            cache[word] = r
            fetched += 1
        else:
            cache[word] = {'ph': '', 'en': '', 'ee': '', 'ec': ''}
            failed += 1
        if (i + 1) % 50 == 0:
            print('  [%d/%d] ok=%d fail=%d' % (i + 1, len(todo), fetched, failed))
            sys.stdout.flush()
        if (i + 1) % 200 == 0:
            with open(CACHE, 'w', encoding='utf-8') as f:
                json.dump(cache, f, ensure_ascii=False)
        time.sleep(0.15)  # 限速，避免被接口拦截

    with open(CACHE, 'w', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False)
    print('完成：成功 %d，失败 %d，缓存共 %d' % (fetched, failed, len(cache)))
    print('接着运行 python tools/build_vocab.py 生成 vocab.js')


if __name__ == '__main__':
    main()
