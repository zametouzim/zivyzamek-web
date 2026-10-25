#!/usr/bin/env python3
"""Automatický překlad obsahu z administrace do angličtiny a němčiny (DeepL API).

Spouští ho GitHub Action před tools/build.py. Doplní jen to, co v souboru ještě
přeložené není (prázdné nebo chybějící pole pod klíči "en" a "de"), takže ruční
úpravy překladů zůstanou. Která pole se překládají, čte z admin/config.yml
(i18n: true = přeložit, 'duplicate' = zkopírovat z češtiny).

Klíč DeepL je v proměnné DEEPL_KEY (GitHub secret). Bez klíče nedělá nic.
PREKLAD_TEST=1 místo DeepL jen připíše před text [en]/[de] (pro zkoušku).

Položka s vypnutým "prelozit" (zaškrtávátko v administraci) se do DeepL neposílá.
Po překladu zapíše zbývající kredit DeepL do nápovědy toho zaškrtávátka v admin/config.yml.
"""
import glob, html, json, os, re, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LANGS = {'en': 'EN-GB', 'de': 'DE'}
EMPTY = (None, '', [], {})


def config():
    s = open(os.path.join(ROOT, 'admin', 'config.yml'), encoding='utf-8').read()
    return json.loads(s[s.index('{'):])


def soubory(cfg):
    """(cesta, pole) pro každý soubor s obsahem, který má překlady."""
    for col in cfg['collections']:
        if 'folder' in col:
            for p in sorted(glob.glob(os.path.join(ROOT, col['folder'], '*.' + col.get('extension', 'json')))):
                yield p, col['fields']
        for f in col.get('files', []):
            yield os.path.join(ROOT, f['file']), f['fields']


class Preklad:
    """Sbírá texty k překladu, přeloží je najednou a pak je dosadí."""

    def __init__(self):
        self.fronta = {l: [] for l in LANGS}  # l -> [(text, markdown, nastav)]

    def pridej(self, l, text, markdown, nastav):
        self.fronta[l].append((text, markdown, nastav))

    def pocet(self):
        return sum(len(v) for v in self.fronta.values())

    def proved(self, klic, test=False):
        for l, polozky in self.fronta.items():
            for i in range(0, len(polozky), 40):
                davka = polozky[i:i + 40]
                if test:
                    vysledky = ['[%s] %s' % (l, t) for t, _, _ in davka]
                else:
                    vysledky = deepl([zabal(t, md) for t, md, _ in davka], LANGS[l], klic)
                    vysledky = [rozbal(v, md) for v, (_, md, _) in zip(vysledky, davka)]
                for v, (_, _, nastav) in zip(vysledky, davka):
                    nastav(v)


def zabal(text, markdown):
    """Text pro DeepL v XML: adresy odkazů a zalomení řádků se nepřekládají."""
    t = html.escape(text, quote=False)
    if markdown:
        t = re.sub(r'\]\(([^)\s]+)\)', lambda m: ']<k>(%s)</k>' % m.group(1), t)
    return t.replace('\n', '<br/>')


def rozbal(text, markdown):
    t = re.sub(r'\s*<br\s*/>\s?', '\n', text)
    t = re.sub(r'\]\s*<k>(.*?)</k>', r']\1', t)
    return html.unescape(t)


def deepl(texty, cil, klic):
    url = 'https://api-free.deepl.com/v2/translate' if klic.endswith(':fx') else 'https://api.deepl.com/v2/translate'
    data = [('text', t) for t in texty] + [('source_lang', 'CS'), ('target_lang', cil), ('tag_handling', 'xml'),
                                           ('ignore_tags', 'k'), ('preserve_formatting', '1')]
    req = urllib.request.Request(url, urllib.parse.urlencode(data).encode(),
                                 {'Authorization': 'DeepL-Auth-Key ' + klic})
    with urllib.request.urlopen(req, timeout=60) as r:
        return [x['text'] for x in json.load(r)['translations']]


class Nic:
    """Sběrač pro položky s vypnutým automatickým překladem: nic nepřekládá."""

    def pridej(self, *a):
        pass


def zbyva(klic):
    """(použito, limit) znaků podle DeepL, nebo None."""
    url = 'https://api-free.deepl.com/v2/usage' if klic.endswith(':fx') else 'https://api.deepl.com/v2/usage'
    req = urllib.request.Request(url, headers={'Authorization': 'DeepL-Auth-Key ' + klic})
    with urllib.request.urlopen(req, timeout=30) as r:
        u = json.load(r)
    if 'character_count' in u and u.get('character_limit'):
        return u['character_count'], u['character_limit']
    return None


def cislo(n):
    return '{:,}'.format(n).replace(',', '\u00a0')


def zapis_kredit(pouzito, limit):
    """Zbývající kredit do nápovědy pole "prelozit" v admin/config.yml (jen když se změnil)."""
    cesta = os.path.join(ROOT, 'admin', 'config.yml')
    s = open(cesta, encoding='utf-8').read()
    i = s.index('{')
    cfg = json.loads(s[i:])
    stav = 'Zbývá %s z %s znaků' % (cislo(limit - pouzito), cislo(limit))
    zmena = False
    for col in cfg['collections']:
        for f in col.get('fields', []):
            if f.get('name') == 'prelozit':
                zaklad = f.get('hint', '').split(' Kredit DeepL: ')[0]
                if stav not in f.get('hint', ''):
                    f['hint'] = '%s Kredit DeepL: %s (stav %s).' % (zaklad, stav, time.strftime('%-d. %-m. %Y'))
                    zmena = True
    if zmena:
        open(cesta, 'w', encoding='utf-8').write(s[:i] + json.dumps(cfg, ensure_ascii=False, indent=1) + '\n')
    print('překlad: kredit DeepL %s' % stav)


def i18n(f):
    v = f.get('i18n', False)
    return 'duplicate' if v == 'duplicate' else bool(v)


def klic_polozky(f, item):
    if not isinstance(item, dict):
        return None
    k = tuple((s['name'], json.dumps(item.get(s['name']))) for s in f.get('fields', [])
              if s.get('i18n') == 'duplicate' and item.get(s['name']) not in EMPTY)
    return k or None


def dopln(fields, cs, tr, l, p, cesta):
    """Doplní do slovníku tr (překlad jednoho jazyka) chybějící pole podle češtiny cs."""
    for f in fields:
        k, mode = f['name'], i18n(f)
        if not mode or cs.get(k) in EMPTY:
            continue
        v = cs[k]
        if mode == 'duplicate':
            if tr.get(k) in EMPTY:
                tr[k] = v
            continue
        w = f.get('widget', 'string')
        if w in ('string', 'text', 'markdown') and isinstance(v, str):
            if tr.get(k) in EMPTY:
                p.pridej(l, v, w == 'markdown', lambda x, tr=tr, k=k: tr.__setitem__(k, x))
        elif w == 'list' and isinstance(v, list):
            cil = tr.get(k)
            if not isinstance(cil, list) or len(cil) != len(v):
                # nový seznam nebo změněný počet položek: položky, které se dají poznat
                # podle nepřekládaných polí (odkaz, logo, fotka…), si překlad ponechají
                stare = {klic_polozky(f, x): x for x in (cil if isinstance(cil, list) else [])}
                cil = tr[k] = [stare.get(klic_polozky(f, x)) for x in v]
            for i, item in enumerate(v):
                if 'field' in f or not isinstance(item, dict):
                    if cil[i] in EMPTY:
                        cil[i] = item  # seznam fotek apod., nepřekládá se
                    continue
                if not isinstance(cil[i], dict):
                    cil[i] = {}
                sub = f.get('fields')
                if 'types' in f:
                    typ = next((t for t in f['types'] if t['name'] == item.get('type')), None)
                    sub = typ.get('fields', []) if typ else []
                    cil[i]['type'] = item.get('type')
                dopln([dict(s, i18n=s.get('i18n', 'duplicate')) for s in sub or []],
                      item, cil[i], l, p, cesta)
        elif tr.get(k) in EMPTY:
            tr[k] = v


def main():
    klic = os.environ.get('DEEPL_KEY', '').strip()
    test = os.environ.get('PREKLAD_TEST') == '1'
    if not klic and not test:
        print('překlad: chybí DEEPL_KEY, nic nepřekládám')
        return
    p, zmeny = Preklad(), []
    for cesta, fields in soubory(config()):
        if not os.path.exists(cesta):
            continue
        d = json.load(open(cesta, encoding='utf-8'))
        cs = {k: v for k, v in d.items() if k not in LANGS}
        pred = json.dumps(d, sort_keys=True)
        sber = Nic() if cs.get('prelozit') is False else p
        for l in LANGS:
            tr = d.get(l) if isinstance(d.get(l), dict) else {}
            dopln(fields, cs, tr, l, sber, cesta)
            d[l] = tr
        zmeny.append((cesta, d, pred))
    n = p.pocet()
    if n:
        try:
            p.proved(klic, test)
        except Exception as e:  # výpadek nebo vyčerpaný limit DeepL nesmí zastavit sestavení webu
            print('překlad: DeepL selhal (%s), texty zůstanou česky a přeloží se příště' % e)
            return
    ulozeno = 0
    for cesta, d, pred in zmeny:
        for l in LANGS:
            if d.get(l) in EMPTY:
                d.pop(l, None)
        if json.dumps(d, sort_keys=True) != pred:
            open(cesta, 'w', encoding='utf-8').write(json.dumps(d, ensure_ascii=False, indent=2) + '\n')
            ulozeno += 1
    print('překlad: %d textů, upraveno %d souborů' % (n, ulozeno))
    if klic and not test:
        try:
            u = zbyva(klic)
            if u:
                zapis_kredit(*u)
        except Exception as e:
            print('překlad: stav kreditu DeepL nezjištěn (%s)' % e)


if __name__ == '__main__':
    sys.exit(main())
