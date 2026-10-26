#!/usr/bin/env python3
"""Připraví náhled konceptu z administrace (spouští .github/workflows/nahled.yml).

Použití: nahled.py <větev> <cílová složka webu>
Koncept je větev cms/<kolekce>/<název>. Po sestavení (tools/build.py) se do <web>/nahled/<id>/ zkopíruje:
  data/akce.js, data/web.js   data konceptu; web je načte místo zveřejněných, když má adresa ?nahled=<id>
  img/…                       jen obrázky, které koncept přidal nebo změnil (cesty v datech se na ně přesměrují)
  index.html                  přesměrování na ?nahled=<id> rovnou na upravenou stránku
Vypíše id náhledu.
"""
import os, re, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

# kam vede náhled podle souboru v kolekci „Bloky na stránkách“ (content/web/)
BLOKY = {'uvod': 'domu', 'navsteva': 'navsteva', 'zahrada': 'zahrada', 'suvenyry': 'podporte/pomoc-suvenyry', 'partneri': 'domu'}


def nahled_id(vetev):
    return re.sub(r'[^a-z0-9-]+', '-', vetev.removeprefix('cms/').lower()).strip('-')[:80]


def cil(vetev):
    """Stránka webu, na které je změna vidět."""
    casti = vetev.removeprefix('cms/').split('/', 1)
    if len(casti) < 2:
        return 'domu'
    kolekce, nazev = casti[0], casti[1].replace('%2F', '/').replace('%25', '%')
    if kolekce == 'akce':
        return 'akce/' + nazev
    if kolekce == 'vlastni_stranky':
        return nazev
    return BLOKY.get(nazev, 'domu')


def git(*a):
    return subprocess.run(('git',) + a, check=True, capture_output=True, text=True).stdout.split('\n')


def zmenene_obrazky():
    """Obrázky, které se liší od zveřejněného webu (FETCH_HEAD = main), včetně nově vytvořených náhledů."""
    zmeny = set(git('diff', '--name-only', 'FETCH_HEAD', '--', 'img')) | set(git('ls-files', '--others', '--exclude-standard', 'img'))
    return sorted((p for p in zmeny if p and os.path.isfile(p)), key=len, reverse=True)


def main():
    vetev, web = sys.argv[1], sys.argv[2]
    nid = nahled_id(vetev)
    out = os.path.join(web, 'nahled', nid)
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(os.path.join(out, 'data'))
    obrazky = zmenene_obrazky()
    for p in obrazky:
        os.makedirs(os.path.join(out, os.path.dirname(p)), exist_ok=True)
        shutil.copy2(p, os.path.join(out, p))
    for f in ('akce.js', 'web.js'):
        with open(os.path.join('data', f), encoding='utf-8') as fh:
            s = fh.read()
        for p in obrazky:
            s = re.sub(r'(?<![\w/.-])' + re.escape(p), 'nahled/%s/%s' % (nid, p), s)
        with open(os.path.join(out, 'data', f), 'w', encoding='utf-8') as fh:
            fh.write(s)
    with open(os.path.join(out, 'index.html'), 'w', encoding='utf-8') as fh:
        fh.write('<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Náhled konceptu</title>'
                 '<script>location.replace("../../?nahled=%s"+(location.hash||"#%s"))</script>\n' % (nid, cil(vetev)))
    print(nid)


if __name__ == '__main__':
    main()
