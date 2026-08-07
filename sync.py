# -*- coding: utf-8 -*-
"""词境 - 构建同步脚本：同步所有核心文件到三个目标目录"""
import shutil, os, sys

ROOT = r'C:\Users\liuyb07\Desktop\project\ielts-vocab'
DEV  = os.path.join(ROOT, 'node_modules', 'electron', 'dist', 'resources', 'app')
DIST = r'C:\Users\liuyb07\Desktop\project\ielts-vocab-dist\resources\app'

SOURCE = DEV  # 以 dev 目录为准

FILES = ['widget.html', 'main.js', 'vocab.js', 'reset.html', 'keybindings.html', 'vocab-manager.html',
         'package.json']

targets = [DIST, ROOT]
errors = []
for target in targets:
    for f in FILES:
        src = os.path.join(SOURCE, f)
        dst = os.path.join(target, f)
        if not os.path.exists(src):
            errors.append(f'MISSING: {src}')
            continue
        try:
            shutil.copy2(src, dst)
        except Exception as e:
            errors.append(f'COPY {f}: {e}')

# Also sync fonts directory
font_src = os.path.join(SOURCE, 'fonts')
for target in targets:
    font_dst = os.path.join(target, 'fonts')
    if os.path.exists(font_src):
        try:
            if os.path.exists(font_dst):
                shutil.rmtree(font_dst)
            shutil.copytree(font_src, font_dst)
        except Exception as e:
            errors.append(f'FONTS: {e}')

if errors:
    print('ERRORS:')
    for e in errors: print(f'  {e}')
    sys.exit(1)
else:
    print(f'Synced {len(FILES)} files + fonts to:')
    for t in targets: print(f'  {t}')
