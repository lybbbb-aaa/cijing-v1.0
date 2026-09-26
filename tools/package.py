# -*- coding: utf-8 -*-
"""打包免安装版

从 electron dist 里按白名单复制运行必需的文件（丢掉 50 多个用不到的 locale），
再加上仓库里的应用文件，输出到 release/cijing-<version>/ 并打成 zip。

只做白名单复制，不会删除任何已有文件。

用法:
    python tools/package.py            复制 + 打包
    python tools/package.py --no-zip   只生成目录
"""
import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'node_modules', 'electron', 'dist')
OLD_DIST = os.path.join(os.path.dirname(ROOT), 'ielts-vocab-dist')
RELEASE = os.path.join(os.path.dirname(ROOT), 'release')

# electron 运行时里需要保留的文件
RUNTIME_ROOT = [
    'electron.exe', 'LICENSE', 'LICENSES.chromium.html',
    'chrome_100_percent.pak', 'chrome_200_percent.pak', 'resources.pak',
    'd3dcompiler_47.dll', 'ffmpeg.dll', 'libEGL.dll', 'libGLESv2.dll',
    'icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'version',
    'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll',
]
KEEP_LOCALES = ['zh-CN.pak', 'zh-TW.pak', 'en-US.pak']

# 仓库里的应用文件
APP_FILES = ['widget.html', 'main.js', 'preload.js', 'vocab.js',
             'reset.html', 'keybindings.html', 'vocab-manager.html', 'package.json']
# 可选：从旧的免安装目录里带过来的启动脚本
EXTRA_FROM_OLD = ['start.bat', 'keybindings.bat', 'manage-vocab.bat', 'reset.bat']

# 文档：直接从仓库根目录拷（旧 dist 里的副本可能不是最新）
DOC_MAP = [
    ('README.md', 'README.md'),
    ('CHANGELOG.md', 'CHANGELOG.md'),
    ('使用条款与售后说明.md', '使用条款与售后说明.md'),
    ('使用说明书.html', 'guide.html'),
    ('使用说明书.md', 'guide.md'),
    ('快捷键说明书.md', 'shortcuts.md'),
]


def write_shortcut_creator(out_dir):
    """在本机生成桌面快捷方式的小工具（随包分发）"""
    ps1 = os.path.join(out_dir, '创建快捷方式.ps1')
    ps_body = (
        "$here = Split-Path -Parent $MyInvocation.MyCommand.Path\n"
        "$desktop = [Environment]::GetFolderPath('Desktop')\n"
        "$lnk = Join-Path $desktop '词境 IELTS.lnk'\n"
        "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)\n"
        "$s.TargetPath = (Join-Path $here 'start.bat')\n"
        "$s.WorkingDirectory = $here\n"
        "$s.IconLocation = (Join-Path $here 'assets\\icon.ico')\n"
        "$s.Description = 'Cijing IELTS'\n"
        "$s.Save()\n"
        "Write-Host '已在桌面创建「词境 IELTS」快捷方式'\n"
    )
    # .ps1 存成 UTF-8 BOM，否则 Windows PowerShell 5.1 会把中文读成乱码
    with open(ps1, 'w', encoding='utf-8-sig', newline='\r\n') as f:
        f.write(ps_body)

    bat = os.path.join(out_dir, '创建桌面快捷方式.bat')
    bat_body = (
        '@echo off\n'
        'cd /d "%~dp0"\n'
        'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0创建快捷方式.ps1"\n'
        'pause\n'
    )
    with open(bat, 'w', encoding='gbk', newline='\r\n') as f:
        f.write(bat_body)
    print('  已生成 创建桌面快捷方式.bat / 创建快捷方式.ps1')


def make_shortcut(out_dir, lnk_name, target, workdir, icon):
    """生成指向包内 start.bat 的快捷方式（用 -EncodedCommand 规避中文编码问题）"""
    ps = (
        "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('%s'); "
        "$s.TargetPath = '%s'; $s.WorkingDirectory = '%s'; "
        "$s.IconLocation = '%s'; $s.Description = 'Cijing IELTS'; $s.Save()"
    ) % (lnk_name, target, workdir, icon)
    enc = base64.b64encode(ps.encode('utf-16-le')).decode('ascii')
    try:
        subprocess.run(['powershell', '-NoProfile', '-EncodedCommand', enc],
                       check=False, timeout=60)
        return os.path.exists(lnk_name)
    except Exception as e:
        print('  快捷方式创建失败: %s' % e)
        return False


def version():
    with open(os.path.join(ROOT, 'package.json'), encoding='utf-8') as f:
        return json.load(f).get('version', '0.0.0')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-zip', action='store_true')
    args = ap.parse_args()

    ver = version()
    out = os.path.join(RELEASE, 'cijing-%s' % ver)
    os.makedirs(out, exist_ok=True)

    if not os.path.isdir(DIST):
        print('找不到 electron dist: %s' % DIST)
        return 1

    copied = skipped = 0
    for name in RUNTIME_ROOT:
        src = os.path.join(DIST, name)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(out, name))
            copied += 1
        else:
            skipped += 1

    loc_out = os.path.join(out, 'locales')
    os.makedirs(loc_out, exist_ok=True)
    for name in KEEP_LOCALES:
        src = os.path.join(DIST, 'locales', name)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(loc_out, name))

    res_out = os.path.join(out, 'resources')
    os.makedirs(res_out, exist_ok=True)
    default_app = os.path.join(DIST, 'resources', 'default_app.asar')
    if os.path.exists(default_app):
        shutil.copy2(default_app, res_out)

    app_out = os.path.join(res_out, 'app')
    os.makedirs(app_out, exist_ok=True)
    for name in APP_FILES:
        src = os.path.join(ROOT, name)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(app_out, name))
        else:
            print('  缺失应用文件: %s' % name)

    font_src = os.path.join(ROOT, 'fonts')
    if os.path.isdir(font_src):
        font_dst = os.path.join(app_out, 'fonts')
        if os.path.isdir(font_dst):
            shutil.rmtree(font_dst)
        shutil.copytree(font_src, font_dst)

    asset_src = os.path.join(ROOT, 'assets')
    if os.path.isdir(asset_src):
        asset_dst = os.path.join(app_out, 'assets')
        if os.path.isdir(asset_dst):
            shutil.rmtree(asset_dst)
        shutil.copytree(asset_src, asset_dst)
        # 同时放到包根目录：快捷方式脚本按根目录的 assets\icon.ico 找图标
        root_assets = os.path.join(out, 'assets')
        if os.path.isdir(root_assets):
            shutil.rmtree(root_assets)
        shutil.copytree(asset_src, root_assets)

    if os.path.isdir(OLD_DIST):
        for name in EXTRA_FROM_OLD:
            src = os.path.join(OLD_DIST, name)
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(out, name))

    for src_name, dst_name in DOC_MAP:
        src = os.path.join(ROOT, src_name)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(out, dst_name))

    # 截图（README 里引用了，随包放一份免得链接失效）
    shot_src = os.path.join(ROOT, 'screenshots')
    if os.path.isdir(shot_src):
        shot_dst = os.path.join(out, 'screenshots')
        if os.path.isdir(shot_dst):
            shutil.rmtree(shot_dst)
        shutil.copytree(shot_src, shot_dst)

    # 快捷方式：不预先打包 .lnk（里面是绝对路径，换机器就失效），
    # 改为随包放一个在本机生成桌面快捷方式的脚本
    write_shortcut_creator(out)

    total = sum(os.path.getsize(os.path.join(dp, f))
                for dp, _, fs in os.walk(out) for f in fs)
    print('已生成 %s' % out)
    print('  文件数 %d，合计 %.1f MB' % (
        sum(len(fs) for _, _, fs in os.walk(out)), total / 1024 / 1024))

    if not args.no_zip:
        zip_path = os.path.join(RELEASE, 'cijing-%s.zip' % ver)
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
            for dp, _, fs in os.walk(out):
                for f in fs:
                    full = os.path.join(dp, f)
                    z.write(full, os.path.relpath(full, out))
        print('  压缩包 %s (%.1f MB)' % (zip_path, os.path.getsize(zip_path) / 1024 / 1024))
    return 0


if __name__ == '__main__':
    sys.exit(main())
