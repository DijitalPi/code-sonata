#!/usr/bin/env python3
"""Manage one session-only macOS launch agent, without login persistence."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import time

# install.sh links this folder into ~/.claude/skills and ~/.codex/skills; resolve() follows the
# link back to the repository, wherever it is.
APP = Path(os.environ.get('CODE_SONATA_APP', Path(__file__).resolve().parents[2])).expanduser().resolve()
SONGBOOK = Path(os.environ.get('CODE_SONATA_SONGS') or Path.home() / 'Library/Application Support/code-sonata/songs')
# Queue, liked and banned songs, signals turned off (agents.py reads and writes the same file).
PREFS = Path(os.environ.get('CODE_SONATA_PREFS') or Path.home() / 'Library/Application Support/code-sonata/preferences.json')
SIGNALS = {'wait': 'izin ya da cevap bekliyor', 'testfail': 'test kırıldı', 'pass': 'test geçti', 'ship': 'commit / push',
           'fail': 'komut hata verdi', 'adim': 'adımlar (komut, okuma, düşünme)'}


def module_json(name):
    """The JSON object inside one of the site's data modules (`export default {...};`)."""
    source = (APP / 'orchestra/web' / name).read_text(encoding='utf-8')
    return json.loads(source[source.index('{'):source.rindex('}') + 1])


def library():
    """(styles {id: title}, songs {id: title}, imported song ids) from the repository and this Mac."""
    styles = {k: v['title'] for k, v in module_json('styles.mjs').items()}
    songs = {k: v['title'] for k, v in module_json('songs.mjs')['songs'].items()}
    mine = {}
    for path in sorted(SONGBOOK.glob('*.json')) if SONGBOOK.is_dir() else []:
        try:
            mine[path.stem] = json.loads(path.read_text(encoding='utf-8')).get('title', path.stem)
        except (OSError, ValueError):
            continue
    return styles, {**songs, **{k: v for k, v in mine.items() if k not in songs}}, set(mine)


def load_prefs():
    try:
        value = json.loads(PREFS.read_text())
    except (OSError, ValueError):
        value = {}
    value = value if isinstance(value, dict) else {}
    return {k: [x for x in value.get(k, []) if isinstance(x, str)] if isinstance(value.get(k), list) else []
            for k in ('queue', 'liked', 'banned', 'quiet')}


def save_prefs(prefs):
    PREFS.parent.mkdir(parents=True, exist_ok=True)
    tmp = PREFS.with_suffix('.tmp')
    tmp.write_text(json.dumps(prefs, ensure_ascii=False, indent=1))
    tmp.replace(PREFS)
    if state()[1]:
        tell('prefs')   # the running listener picks the change up within a second


def personal(action, words):
    """queue [add|remove|set|clear] IDs · like [ID] · ban [ID] · signals [on|off KIND... | demo]."""
    _, songs, _ = library()
    prefs = load_prefs()
    title = lambda k: songs.get(k, k)
    unknown = [w for w in words if w not in songs and w not in ('add', 'remove', 'set', 'clear', 'on', 'off', 'demo') + tuple(SIGNALS)]
    if action in ('queue', 'like', 'ban') and unknown:
        raise ValueError(f'Böyle bir şarkı yok: {", ".join(unknown)}. Liste için: control.py list')
    if action == 'queue':
        verb, ids = (words[0], words[1:]) if words and words[0] in ('add', 'remove', 'set', 'clear') else ('add' if words else None, words)
        queue = prefs['queue']
        if verb == 'add':
            queue += [k for k in ids if k not in queue]
        elif verb == 'remove':
            queue[:] = [k for k in queue if k not in ids]
        elif verb == 'set':
            queue[:] = list(dict.fromkeys(ids))
        elif verb == 'clear':
            queue.clear()
        if verb:
            save_prefs(prefs)
        print('Sıran: ' + (' → '.join(title(k) for k in queue) if queue else 'boş'))
        if queue:
            print('Çalmak için: control.py start --song sira (sırayla çalar, sonra başa döner)')
        return
    if action in ('like', 'ban'):
        key = 'liked' if action == 'like' else 'banned'
        target = words[0] if words else live_status().get('song_id')
        if not target and live_status().get('flow'):
            raise ValueError('Akış çalıyor, şarkı yok. Bir şarkı için: control.py ' + action + ' ŞARKI')
        if not target:
            names = ', '.join(title(k) for k in prefs[key]) or 'yok'
            print(f'{"Sevdiklerin" if action == "like" else "Çalmayacaklar"}: {names}')
            return
        if target in prefs[key]:
            prefs[key].remove(target)
            print(f'{title(target)}: {"sevilmekten çıktı" if action == "like" else "yeniden çalabilir"}')
        else:
            prefs[key].append(target)
            for key in ('banned',) if action == 'like' else ('liked', 'queue'):
                if target in prefs[key]:
                    prefs[key].remove(target)
            print(f'{title(target)}: {"sevildi (kendi ruh halinde önce gelir)" if action == "like" else "artık çalmayacak (sıradan da çıktı)"}')
        save_prefs(prefs)
        return
    # signals
    if words and words[0] == 'demo':
        build(APP / 'Piano.swift', APP / '.build/piano')
        subprocess.run([sys.executable, str(APP / 'agents.py'), '--signals-demo'], check=False)
        return
    if words and words[0] in ('on', 'off'):
        kinds = [w for w in words[1:] if w in SIGNALS]
        if not kinds:
            raise ValueError(f'Sinyal adı ver: {", ".join(SIGNALS)}')
        for kind in kinds:
            if words[0] == 'off' and kind not in prefs['quiet']:
                prefs['quiet'].append(kind)
            elif words[0] == 'on' and kind in prefs['quiet']:
                prefs['quiet'].remove(kind)
        save_prefs(prefs)
    for kind, label in SIGNALS.items():
        print(f'  {"kapalı" if kind in prefs["quiet"] else "açık  "}  {kind:9s} {label}')
    print('Dinlemek için: control.py signals demo · kapatmak için: control.py signals off KIND')


def live_status():
    try:
        return json.loads((CACHE / 'status.json').read_text())
    except (OSError, ValueError):
        return {}


def fresh_status(since, wait=2.5):
    """The listener's status once it has written one after `since` (it writes every second), else {}."""
    for _ in range(int(wait / .1)):
        now = live_status()
        if now.get('updated', 0) >= since:
            return now
        time.sleep(.1)
    return {}


def tell(*commands):
    """Commands for the running listener (the menu bar uses the same file)."""
    with (CACHE / 'commands').open('a') as stream:
        stream.write(''.join(f'{c}\n' for c in commands))
CACHE = Path.home() / 'Library/Caches/code-sonata'
PLIST = CACHE / 'listener.plist'
LOG = CACHE / 'listener.log'
LABEL = 'local.code-sonata.skill'
# Programs started in the background live outside Desktop/Documents/Downloads: macOS asks the user
# before a background process opens files there, and a launch agent cannot show that question,
# so the sound engine would hang while loading. They are built here instead.
BIN = Path.home() / 'Library/Application Support/code-sonata/bin'
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
        binary.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['/usr/bin/xcrun', 'swiftc', '-swift-version', '5', '-O', str(source), '-o', str(binary)], check=True)


def indicator():
    """Menu bar indicator: one instance, detached so it outlives start/stop."""
    source, binary = APP / 'MenuBar.swift', BIN / 'menubar'
    if not source.is_file():
        return
    if subprocess.run(['/usr/bin/pgrep', '-f', str(binary)], capture_output=True).returncode == 0:
        return
    try:
        build(source, binary)
        env = dict(os.environ, CODE_SONATA_CONTROL=str(Path(__file__).resolve()))
        subprocess.Popen([str(binary)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, env=env,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f'Gösterge açılamadı: {exc}', file=sys.stderr)


MELODY = {'az': 'az (tema ve ara)', 'orta': 'orta (tema, çeşitleme, ara)', 'cok': 'çok (arasız)'}
NAMES = {'karisik': 'karışık', 'sira': 'sıram', 'akis': 'akış'}


def start(project, song=None, global_url=None, style=None, eco=False, melody=None, volume=None):
    styles, songs, _ = library()
    if melody and melody not in MELODY:
        raise ValueError(f'Melodi miktarı az, orta ya da cok olmalı: {melody}')
    if volume is not None and not 0 <= volume <= 100:
        raise ValueError(f'Ses 0 ile 100 arasında olmalı: {volume}')
    if project is not None and (melody or volume is not None):
        raise ValueError('--melody ve --volume yalnız ajan modunda (klasör vermeden) çalışır.')
    extra = ([f'melody:{melody}'] if melody else []) + ([f'volume:{volume}'] if volume is not None else [])
    if song and song not in songs and song not in ('karisik', 'original', 'sira', 'akis'):
        raise ValueError(f'Böyle bir şarkı yok: {song}. Liste için: control.py list')
    if song == 'akis' and project is not None:
        raise ValueError('Akış yalnız ajan modunda (klasör vermeden) çalışır.')
    if song == 'sira' and not load_prefs()['queue']:
        raise ValueError('Sıran boş. Önce: control.py queue add ŞARKI ŞARKI …')
    if style and style not in styles:
        raise ValueError(f'Böyle bir stil yok: {style}. Seçenekler: {", ".join(styles)}')
    if project is None:
        if song == 'original':
            raise ValueError("Üretken 'original' melodi yalnız klasör modunda; ajan modunda bir şarkı ya da karisik seç.")
        target, label = 'agents.py', 'bütün Claude / Codex oturumları'
        loaded, running = state()
        current = settings().get('ProgramArguments', [])
        same_world = ('--global' in current) == bool(global_url) and (not global_url or global_url in current)
        if running and len(current) > 1 and current[1].endswith('agents.py') and same_world and ('--eco' in current) == eco:
            # Already playing: switch style or song on the fly, no restart.
            tell(*([f'style:{style}'] if style else []), *([f'song:{song}'] if song else []), *extra)
            now = fresh_status(time.time() - 3)
            print(f'Kod müziği açık: {label} · stil {styles.get(style or now.get("style"), "")} · '
                  f'{songs.get(song, NAMES.get(song, "karışık")) if song else now.get("song", "")} · '
                  f'melodi {MELODY.get(melody or now.get("melody"), "orta")} · ses %{volume if volume is not None else now.get("volume", 100)}')
            return
        expected = [sys.executable, str(APP / target)] + (['--song', song] if song else []) + (['--style', style] if style else []) + (['--eco'] if eco else [])
        expected += (['--melody', melody] if melody else []) + (['--volume', str(volume)] if volume is not None else [])
        if global_url:
            expected += ['--global', global_url]
            label += f' + dünya orkestrası ({global_url.split("#", 1)[0]})'
        workdir = APP
    else:
        project = project.expanduser().resolve()
        if not project.is_dir() or project in (Path.home(), Path(project.anchor)):
            raise ValueError('Geçerli bir proje klasörü seç; ev veya disk kökü olamaz.')
        target, label = 'watch.py', str(project)
        expected = [sys.executable, str(APP / target), str(project)] + (['--song', song] if song else [])
        workdir = project
    loaded, running = state()
    if running and settings().get('ProgramArguments') == expected:
        print(f'Zaten dinleniyor: {label}')
        return
    if not (APP / target).is_file():
        raise RuntimeError(f'Code Sonata bulunamadı: {APP}')
    build(APP / 'Piano.swift', BIN / 'piano')
    if loaded:
        stop()
    LOG.write_text('')
    began = time.time()
    config = {'Label': LABEL, 'ProgramArguments': expected, 'RunAtLoad': True,
              'KeepAlive': False, 'WorkingDirectory': str(workdir),
              'StandardOutPath': str(LOG), 'StandardErrorPath': str(LOG),
              'EnvironmentVariables': {'PYTHONUNBUFFERED': '1', 'SONATA_PIANO': str(BIN / 'piano')}}
    with PLIST.open('wb') as stream:
        plistlib.dump(config, stream)
    result = launchctl('bootstrap', DOMAIN, str(PLIST))
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or 'Arka plan dinleyicisi açılamadı.')
    for _ in range(120):
        log = LOG.read_text(errors='replace')
        if 'Dinleme hazır.' in log and state()[1]:
            indicator()
            now = fresh_status(began)
            print(f'Kod müziği açık: {label} · stil {styles.get(now.get("style"), style or "")} · {now.get("song", NAMES.get(song, song or "karışık"))}'
                  f'{" · melodi " + MELODY.get(now.get("melody"), "orta") + " · ses %" + str(now.get("volume", 100)) if now else ""}\n'
                  'Kapatmak için: kod müziğini kapat (ya da menü çubuğundaki ♫); stil, şarkı, melodi ve ses menüden de değişir.')
            return
        if not state()[1] and ('Ses açılamadı' in log or 'başlatılamadı' in log or 'Traceback' in log):
            break
        time.sleep(.1)
    stop()
    raise RuntimeError('Dinleyici hazır olmadı: ' + LOG.read_text(errors='replace')[-2000:])


def doctor():
    """Everything a working install needs, one line each; returns the number of problems."""
    problems = 0

    def check(ok, good, bad):
        nonlocal problems
        problems += not ok
        print(f'{"✓" if ok else "✗"} {good if ok else bad}')
    check(sys.version_info >= (3, 9), f'Python {sys.version.split()[0]}', f'Python {sys.version.split()[0]}: 3.9 ya da yenisi gerekli')
    swift = subprocess.run(['/usr/bin/xcrun', '--find', 'swiftc'], capture_output=True).returncode == 0
    check(swift, 'Swift derleyicisi var', 'Swift derleyicisi yok: xcode-select --install')
    engine = BIN / 'piano'
    fresh = engine.is_file() and engine.stat().st_mtime_ns >= (APP / 'Piano.swift').stat().st_mtime_ns
    check(fresh, 'Ses motoru derlenmiş', 'Ses motoru eksik ya da eski: ./install.sh')
    if fresh:
        try:
            probe = subprocess.run([str(engine)], input='', capture_output=True, text=True, timeout=10,
                                   env=dict(os.environ, SONATA_MUTE='1'))
            check('READY' in probe.stdout, 'Ses motoru açılıyor (ses çıkışı var)', f'Ses motoru açılmadı: {probe.stderr.strip()[:120]}')
        except subprocess.TimeoutExpired:
            check(False, '', 'Ses motoru 10 sn içinde açılmadı (macOS dosya izni bekliyor olabilir): ./install.sh')
    for tool, folder in (('claude', Path.home() / '.claude'), ('codex', Path.home() / '.codex')):
        if folder.is_dir():
            link = folder / 'skills/code-sonata/SKILL.md'
            check(link.exists(), f'{tool} skill bağlı', f'{tool} skill bağlı değil: ./install.sh')
    roots = [r for r in (Path.home() / '.claude/projects', Path.home() / '.codex/sessions') if r.is_dir()]
    check(bool(roots), f'Dinlenecek oturum kayıtları: {", ".join(str(r) for r in roots)}', 'Claude Code ya da Codex oturum kaydı bulunamadı')
    protected = any(str(APP).startswith(str(Path.home() / d)) for d in ('Desktop', 'Documents', 'Downloads', 'Library/Mobile Documents'))
    check(not protected, f'Uygulama konumu: {APP}', f'Uygulama korunan bir klasörde ({APP}); arka planda izin sorabilir: ./install.sh')
    loaded, running = state()
    _, songs, mine = library()
    print(f'· Kod müziği {"açık" if running else "kapalı"} · {len(songs)} şarkı ({len(mine)} senin eklediğin)')
    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'stop', 'status', 'next', 'demo', 'list', 'import', 'doctor', 'queue', 'like', 'ban', 'signals'])
    parser.add_argument('project', nargs='?', type=Path,
                        help='start: verilmezse bütün Claude/Codex oturumları dinlenir · import: MIDI dosyası · '
                             'queue/like/ban/signals: ilk sözcük')
    parser.add_argument('words', nargs='*', help='queue add|remove|set|clear ŞARKI… · like/ban [ŞARKI] · signals on|off TÜR… | demo')
    parser.add_argument('--global', dest='global_url', metavar='URL', help='Dünya orkestrasına katıl')
    parser.add_argument('--song', help='Şarkı kimliği, karisik, sira ya da akis (list ile görülür); verilmezse son seçim')
    parser.add_argument('--style', help='Stil: klasik, 8bit, sinema, lofi, synthwave; verilmezse son seçim')
    parser.add_argument('--eco', action='store_true', help='Pil tasarrufu: yankı kapalı')
    parser.add_argument('--melody', choices=tuple(MELODY), help='Melodi miktarı: az, orta, cok; verilmezse son seçim')
    parser.add_argument('--volume', type=int, metavar='0-100', help='Ses seviyesi (100: varsayılan); verilmezse son seçim')
    parser.add_argument('--name', help='import: kısa ad')
    parser.add_argument('--title', help='import: menüde görünen ad')
    parser.add_argument('--track', type=int, help='import: melodinin izi')
    parser.add_argument('--bars', help='import: ölçü aralığı, ör. 5-20')
    args = parser.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    if args.action == 'demo':  # zero tokens: fake sessions play the real listener for about a minute
        build(APP / 'Piano.swift', APP / '.build/piano')   # demo runs in the foreground, from the repo
        return subprocess.run([sys.executable, str(APP / 'demo.py'), '--sessions', '4', '--song', args.song or 'karisik']).returncode
    if args.action == 'doctor':
        return 1 if doctor() else 0
    if args.action == 'next':   # the menu's "Sonraki şarkı / Sonraki sahne"
        if not state()[1]:
            print('Kod müziği kapalı.', file=sys.stderr)
            return 1
        tell('next')
        print('Sonraki sahne (akış) ya da sonraki şarkı, bir sonraki ölçüde.')
        return 0
    if args.action in ('queue', 'like', 'ban', 'signals'):
        try:
            personal(args.action, ([str(args.project)] if args.project else []) + args.words)
        except (OSError, ValueError, subprocess.CalledProcessError) as exc:
            print(str(exc), file=sys.stderr)
            return 1
        return 0
    if args.action == 'list':
        styles, songs, mine = library()
        print('Stiller: ' + ', '.join(f'{k} ({v})' for k, v in styles.items()))
        print('Akış: --song akis · şarkı yerine katmanlı döngüler; her sahnede yeni nakaratlar, son üç sahnede çalmamış bir akor döngüsü, komşu bir ton')
        print('Şarkılar (karisik: hepsi, tempoya göre):')
        prefs = load_prefs()
        for key, title in songs.items():
            marks = ('  · senin eklediğin' if key in mine else '') + ('  · sevdin' if key in prefs['liked'] else '') + \
                    ('  · çalmıyor' if key in prefs['banned'] else '') + ('  · sırada' if key in prefs['queue'] else '')
            print(f'  {key:18s} {title}{marks}')
        return 0
    if args.action == 'import':
        if not args.project:
            print('MIDI dosyasını ver: control.py import dosya.mid --name ad', file=sys.stderr)
            return 1
        command = [sys.executable, str(APP / 'songbook.py'), 'import', str(args.project.expanduser())]
        for flag, value in (('--name', args.name), ('--title', args.title), ('--track', args.track), ('--bars', args.bars)):
            if value is not None:
                command += [flag, str(value)]
        result = subprocess.run(command)
        if result.returncode == 0 and state()[1]:
            print('Çalan müziğin listesine girmesi için kod müziğini kapatıp yeniden aç.')
        return result.returncode
    with (CACHE / 'control.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            if args.action == 'start':
                start(args.project, args.song, args.global_url, args.style, args.eco, args.melody, args.volume)
            elif args.action == 'stop':
                stop()
                print('Kod müziği kapalı.')
            else:
                loaded, running = state()
                if running:
                    params = settings().get('ProgramArguments', [])
                    where = 'bütün Claude / Codex oturumları' if len(params) > 1 and params[1].endswith('agents.py') else (params[2] if len(params) > 2 else 'bilinmiyor')
                    now = live_status()
                    song = now.get('song') or (params[params.index('--song') + 1] if '--song' in params else 'karışık')
                    style = f" · stil {library()[0].get(now['style'], now['style'])}" if now.get('style') else ''
                    world = f" + dünya orkestrası ({params[params.index('--global') + 1].split('#', 1)[0]})" if '--global' in params else ''
                    extra = f" · melodi {MELODY.get(now['melody'], now['melody'])} · ses %{now.get('volume', 100)}" if now.get('melody') else ''
                    print(f'Dinleniyor: {where}{world} · {song}{style}{extra}')
                else:
                    print('Kod müziği kapalı.' if not loaded else f'Dinleyici durmuş. Günlük: {LOG}')
        except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as exc:
            print(str(exc), file=sys.stderr)
            return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
