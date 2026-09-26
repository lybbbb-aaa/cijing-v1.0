# -*- coding: utf-8 -*-
"""词境构建脚本

把 src/ 下的模板 + 前端资源组装成单文件 widget.html（应用实际加载的文件），
并可选地同步核心文件到 electron dev 目录与免安装 dist 目录。

    python tools/build.py            组装 + 同步
    python tools/build.py --no-sync  只组装
    python tools/build.py --check    只校验：组装结果与当前 widget.html 是否一致

注意：widget.html 是生成物，不要直接改它；改 src/ 下的源文件。
"""
import os
import sys
import shutil
import argparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'src')

# 三个发布位置：源码根目录（唯一真源）-> electron dev 目录 + 免安装 dist 目录
DEV = os.path.join(ROOT, 'node_modules', 'electron', 'dist', 'resources', 'app')
DIST = os.path.join(os.path.dirname(ROOT), 'ielts-vocab-dist', 'resources', 'app')

SYNC_FILES = ['widget.html', 'main.js', 'preload.js', 'vocab.js',
              'reset.html', 'keybindings.html', 'vocab-manager.html', 'package.json']
FONT_DIR = 'fonts'

# 文档同步映射：仓库源文件 -> dev/dist 里的文件名（历史原因命名不同）
DOC_MAP = [
    ('README.md', 'README.md'),
    ('CHANGELOG.md', 'CHANGELOG.md'),
    ('使用说明书.html', 'guide.html'),
    ('使用说明书.md', 'guide.md'),
    ('快捷键说明书.md', 'shortcuts.md'),
]

PARTS = [
    ('<!--CSS1-->', 'widget.base.css'),
    ('<!--CSS2-->', 'widget.theme.css'),
    ('<!--JS-->', 'widget.js'),
]


def read(path):
    with open(path, encoding='utf-8', newline='') as f:
        return f.read()


def assemble():
    out = read(os.path.join(SRC, 'widget.template.html'))
    for token, fname in PARTS:
        if token not in out:
            raise SystemExit('模板缺少占位符 %s' % token)
        out = out.replace(token, read(os.path.join(SRC, fname)), 1)
    return out


def sync(files_only=False):
    targets = [t for t in (DEV, DIST) if os.path.isdir(os.path.dirname(t)) and os.path.isdir(t)]
    if not targets:
        print('没有可同步的目标目录（dev / dist 都不存在）')
        return
    for target in targets:
        for f in SYNC_FILES:
            src = os.path.join(ROOT, f)
            if not os.path.exists(src):
                print('  跳过（不存在）: %s' % f)
                continue
            shutil.copy2(src, os.path.join(target, f))
        font_src = os.path.join(ROOT, FONT_DIR)
        font_dst = os.path.join(target, FONT_DIR)
        if os.path.isdir(font_src):
            if os.path.isdir(font_dst):
                shutil.rmtree(font_dst)
            shutil.copytree(font_src, font_dst)
        asset_src = os.path.join(ROOT, 'assets')
        asset_dst = os.path.join(target, 'assets')
        if os.path.isdir(asset_src):
            if os.path.isdir(asset_dst):
                shutil.rmtree(asset_dst)
            shutil.copytree(asset_src, asset_dst)
        for src_name, dst_name in DOC_MAP:
            src = os.path.join(ROOT, src_name)
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(target, dst_name))
        print('  已同步 -> %s' % target)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-sync', action='store_true', help='只组装，不同步')
    ap.add_argument('--check', action='store_true', help='只校验，不写入')
    args = ap.parse_args()

    built = assemble()
    target = os.path.join(ROOT, 'widget.html')

    if args.check:
        current = read(target)
        if current == built:
            print('OK：组装结果与 widget.html 完全一致（%d 字节）' % len(built))
            return 0
        print('FAIL：不一致  assembled=%d  current=%d' % (len(built), len(current)))
        import difflib
        diff = list(difflib.unified_diff(current.splitlines(), built.splitlines(),
                                         'current', 'assembled', lineterm='', n=1))
        print('\n'.join(diff[:40]))
        return 1

    with open(target, 'w', encoding='utf-8', newline='') as f:
        f.write(built)
    print('已组装 widget.html（%d 字节）' % len(built))

    if not args.no_sync:
        sync()
    return 0


if __name__ == '__main__':
    sys.exit(main())
