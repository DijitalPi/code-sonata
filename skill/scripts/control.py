#!/usr/bin/env python3
"""Manage one session-only macOS launch agent, without login persistence."""
import argparse
import fcntl
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import time

APP = Path('/Users/selimcitil/Projects/code-sonata')
CACHE = Path.home() / 'Library/Caches/code-sonata'
PLIST = CACHE / 'listener.plist'
LOG = CACHE / 'listener.log'
LABEL = 'local.code-sonata.skill'
DOMAIN = f'gui/{os.getuid()}'
SERVICE = f'{DOMAIN}/{LABEL}'


def launchctl(*args):
    return subprocess.run(['/bin/launchctl', *args], capture_output=True, text=True)


def state():
    result = launchctl('print', SERVICE)
    return result.returncode == 0, 'state = running' in result.stdout


def settings():
    try:
        with PLIST.open('rb') as stream:
            return plistlib.load(stream)
    except (OSError, ValueError):
        return {}


def stop():
    loaded, _ = state()
    if loaded:
        result = launchctl('bootout', SERVICE)
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or 'Dinleme durdurulamadı.')
        for _ in range(30):
            if not state()[0]:
                break
            time.sleep(.1)
        if state()[0]:
            raise RuntimeError('Dinleme henüz durmadı.')


def build(source, binary):
    if not binary.exists() or source.stat().st_mtime_ns > binary.stat().st_mtime_ns:
        binary.parent.mkdir(exist_ok=True)
        subprocess.run(['/usr/bin/xcrun', 'swiftc', '-swift-version', '5', '-O', str(source), '-o', str(binary)], check=True)


def indicator():
    """Menu bar indicator: one instance, detached so it outlives start/stop."""
    source, binary = APP / 'MenuBar.swift', APP / '.build/menubar'
    if not source.is_file():
        return
    if subprocess.run(['/usr/bin/pgrep', '-f', str(binary)], capture_output=True).returncode == 0:
        return
    try:
        build(source, binary)
        subprocess.Popen([str(binary)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f'Gösterge açılamadı: {exc}', file=sys.stderr)


def start(project, song):
    if project is None:
        target, label = 'agents.py', 'bütün Claude / Codex oturumları'
        expected = [sys.executable, str(APP / target), '--song', song]
        workdir = APP
    else:
        project = project.expanduser().resolve()
        if not project.is_dir() or project in (Path.home(), Path(project.anchor)):
            raise ValueError('Geçerli bir proje klasörü seç; ev veya disk kökü olamaz.')
        target, label = 'watch.py', str(project)
        expected = [sys.executable, str(APP / target), str(project), '--song', song]
        workdir = project
    loaded, running = state()
    if running and settings().get('ProgramArguments') == expected:
        print(f'Zaten dinleniyor: {label} · {song}')
        return
    if not (APP / target).is_file():
        raise RuntimeError(f'Code Sonata bulunamadı: {APP}')
    build(APP / 'Piano.swift', APP / '.build/piano')
    if loaded:
        stop()
    LOG.write_text('')
    config = {'Label': LABEL, 'ProgramArguments': expected, 'RunAtLoad': True,
              'KeepAlive': False, 'WorkingDirectory': str(workdir),
              'StandardOutPath': str(LOG), 'StandardErrorPath': str(LOG),
              'EnvironmentVariables': {'PYTHONUNBUFFERED': '1'}}
    with PLIST.open('wb') as stream:
        plistlib.dump(config, stream)
    result = launchctl('bootstrap', DOMAIN, str(PLIST))
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or 'Arka plan dinleyicisi açılamadı.')
    for _ in range(120):
        log = LOG.read_text(errors='replace')
        if 'Dinleme hazır.' in log and state()[1]:
            indicator()
            print(f'Kod müziği açık: {label} · {song}\nKapatmak için: kod müziğini kapat (ya da menü çubuğundaki ♫)')
            return
        if not state()[1] and ('Ses açılamadı' in log or 'başlatılamadı' in log or 'Traceback' in log):
            break
        time.sleep(.1)
    stop()
    raise RuntimeError('Dinleyici hazır olmadı: ' + LOG.read_text(errors='replace')[-2000:])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'stop', 'status'])
    parser.add_argument('project', nargs='?', type=Path, help='Verilmezse bütün Claude/Codex oturumları dinlenir')
    parser.add_argument('--song', choices=['karisik', 'bella-ciao', 'fur-elise', 'greensleeves', 'ode-to-joy', 'original'],
                        default='karisik')
    args = parser.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    with (CACHE / 'control.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            if args.action == 'start':
                start(args.project, args.song)
            elif args.action == 'stop':
                stop()
                print('Kod müziği kapalı.')
            else:
                loaded, running = state()
                if running:
                    params = settings().get('ProgramArguments', [])
                    where = 'bütün Claude / Codex oturumları' if len(params) > 1 and params[1].endswith('agents.py') else (params[2] if len(params) > 2 else 'bilinmiyor')
                    print(f'Dinleniyor: {where} · {params[-1] if "--song" in params else "original"}')
                else:
                    print('Kod müziği kapalı.' if not loaded else f'Dinleyici durmuş. Günlük: {LOG}')
        except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as exc:
            print(str(exc), file=sys.stderr)
            return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
