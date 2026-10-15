#!/usr/bin/env python3
"""Sestaví data webu z obsahu, který se upravuje v administraci.

content/akce/*.json   -> data/akce.js  (window.AKCE, window.ROKY, window.HERO)
content/web/*.json    -> data/web.js   (window.WEB)
content/stranky/*.json -> data/web.js  (window.WEB.stranky, vlastní stránky v menu)
Překlady: každý soubor má česká pole v kořeni a anglická/německá pod klíči "en" a "de"
(Sveltia i18n „single_file_default_root“). Výstup window.L10N = {en: {akce, web}, de: {...}};
co není přeložené, chybí a web použije češtinu.
Fotky akcí: zmenší na 1000 px a vytvoří náhledy v img/akce/t/.
Plakáty a fotky suvenýrů: zmenší na 1400 px.
Ukázková administrace: admin/demo/data.js a admin/demo/config.js.
Spouští se automaticky na GitHubu po každé změně (.github/workflows/build.yml).
"""
import html, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

TAGC = {'Pro děti': 'kids', 'Přijďte pomoct': 'help'}
LANGS = ('en', 'de')


def split(d):
    """Rozdělí soubor na českou verzi (kořen) a překlady {'en': {...}, 'de': {...}}."""
    if not isinstance(d, dict):
        return d, {}
    return {k: v for k, v in d.items() if k not in LANGS}, {l: d[l] for l in LANGS if isinstance(d.get(l), dict)}


def localized(cs, tr):
    """Přeložená verze: přeložená pole přepíší česká, chybějící zůstanou česky."""
    out = dict(cs)
    for k, v in tr.items():
        if v not in (None, '', []):
            out[k] = v
    return out


def md(text):
    """Jednoduchý převod textu z administrace: řádek = odstavec, **tučně**, [odkaz](url)."""
    out = []
    for line in text.replace('\r', '').split('\n'):
        line = line.strip()
        if not line:
            continue
        line = re.sub(r'\\([\\`*_{}\[\]()#+\-.!>])', r'\1', line)
        line = html.escape(line, quote=False)
        line = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', line)
        line = re.sub(r'(?<!\*)\*(?!\*)(.+?)\*', r'<i>\1</i>', line)
        line = re.sub(r'\[([^\]]+)\]\((https?://[^)\s]+|#[^)\s]*)\)',
                      lambda m: '<a href="%s"%s>%s</a>' % (m.group(2), '' if m.group(2).startswith('#') else ' target="_blank" rel="noopener"', m.group(1)), line)
        out.append(line)
    return '\n'.join(out)


def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def akce(tr=None):
    items = []
    for fn in sorted(os.listdir('content/akce')):
        if not fn.endswith('.json'):
            continue
        a, loc = split(load('content/akce/' + fn))
        o = {'id': fn[:-5]}
        for l, t in loc.items():
            x = {k: t[k] for k in ('title', 'when', 'short') if t.get(k)}
            if t.get('text'):
                x['html'] = md(t['text'])
            if x and tr is not None:
                tr[l].setdefault('akce', {})[fn[:-5]] = x
        for k in ('date', 'title', 'end', 'when', 'short', 'poster', 'photos', 'tag', 'titleTodo'):
            v = a.get(k)
            if v in (None, '', [], False):
                continue
            o[k] = v
        o['date'] = str(o['date'])[:10]
        if o.get('end'):
            o['end'] = str(o['end'])[:10]
            if o['end'] <= o['date']:
                del o['end']
        if o.get('tag') in TAGC:
            o['tagc'] = TAGC[o['tag']]
        if a.get('text'):
            o['html'] = md(a['text'])
        items.append(o)
    items.sort(key=lambda a: (a['date'], a['id']))
    return items


def stranky():
    out = []
    for fn in sorted(os.listdir('content/stranky')) if os.path.isdir('content/stranky') else []:
        if not fn.endswith('.json'):
            continue
        s, loc = split(load('content/stranky/' + fn))
        o = {'id': fn[:-5], 'nazev': s.get('nazev', fn[:-5]), 'menu': s.get('menu') or s.get('nazev', fn[:-5]),
             'v_menu': s.get('v_menu', True), 'poradi': s.get('poradi', 10)}
        for k in ('nadtitulek', 'perex'):
            if s.get(k):
                o[k] = s[k]
        bloky = []
        for b in s.get('bloky') or []:
            b = dict(b)
            if b.get('type') == 'text':
                b['html'] = md(b.pop('text', ''))
            bloky.append(b)
        o['bloky'] = bloky
        o['_tr'] = loc
        out.append(o)
    out.sort(key=lambda o: (o['poradi'], o['nazev']))
    return out


def stranka_l(o, t):
    """Vlastní stránka v jiném jazyce (bloky, nadpisy), nepřeložené části česky."""
    x = {k: v for k, v in o.items() if k != '_tr'}
    for k in ('nazev', 'nadtitulek', 'perex'):
        if t.get(k):
            x[k] = t[k]
    if t.get('menu') or t.get('nazev'):
        x['menu'] = t.get('menu') or t['nazev']
    if t.get('bloky'):
        bl = []
        for b in t['bloky']:
            b = dict(b)
            if b.get('type') == 'text':
                b['html'] = md(b.pop('text', ''))
            bl.append(b)
        x['bloky'] = bl
    return x


def images(items, web):
    try:
        from PIL import Image, ImageOps
    except ImportError:
        print('PIL není nainstalovaný, obrázky přeskakuji', file=sys.stderr)
        return
    def fit(path, size):
        if not os.path.exists(path):
            print('chybí obrázek', path, file=sys.stderr)
            return
        im = Image.open(path)
        if max(im.size) <= size and path.lower().endswith('.jpg'):
            return
        im = ImageOps.exif_transpose(im).convert('RGB')
        im.thumbnail((size, size))
        im.save(path, quality=82, progressive=True, optimize=True)
    for a in items:
        for p in a.get('photos', []):
            fit(p, 1000)
            t = p.replace('img/akce/', 'img/akce/t/') if p.startswith('img/akce/') else None
            if t and os.path.exists(p) and not os.path.exists(t):
                os.makedirs(os.path.dirname(t), exist_ok=True)
                ImageOps.fit(Image.open(p).convert('RGB'), (192, 144)).save(t, quality=80)
        if a.get('poster'):
            fit(a['poster'], 1400)
    for g in web['suvenyry'].get('polozky', []):
        if g.get('foto'):
            fit(g['foto'], 1000)
    for f in web['zahrada'].get('fotky', []):
        fit(f['src'], 1400)
    for st in web.get('stranky', []):
        for b in st['bloky']:
            for src in [b.get('src')] + (b.get('fotky') or []):
                if src:
                    fit(src, 1400)


def main():
    tr = {l: {} for l in LANGS}
    items = akce(tr)
    uvod, uvod_l = split(load('content/web/uvod.json'))
    web, web_l = {}, {l: {} for l in LANGS}
    for k in ('navsteva', 'suvenyry', 'zahrada', 'partneri'):
        cs, loc = split(load('content/web/%s.json' % k))
        web[k] = cs
        for l in LANGS:
            web_l[l][k] = localized(cs, loc.get(l, {}))
    web['partneri'] = web['partneri'].get('partneri', [])
    for l in LANGS:
        web_l[l]['partneri'] = web_l[l]['partneri'].get('partneri', [])
        web_l[l]['hero'] = localized(uvod, uvod_l.get(l, {})).get('hero', [])
    web['stranky'] = stranky()
    for l in LANGS:
        web_l[l]['stranky'] = [stranka_l(o, o['_tr'].get(l, {})) for o in web['stranky']]
        tr[l]['web'] = web_l[l]
    for o in web['stranky']:
        del o['_tr']
    images(items, web)
    j = lambda o: json.dumps(o, ensure_ascii=False)
    with open('data/akce.js', 'w', encoding='utf-8') as f:
        f.write('// Generováno z content/ (tools/build.py). Neupravovat ručně, akce se upravují v administraci.\n')
        f.write('window.ROKY=%s;\n' % j({r['rok']: r['plakat'] for r in uvod.get('roky', [])}))
        f.write('window.HERO=%s;\n' % json.dumps(uvod.get('hero', []), ensure_ascii=False, indent=1))
        f.write('window.AKCE=[\n' + ',\n'.join(j(a) for a in items) + '\n];\n')
    with open('data/web.js', 'w', encoding='utf-8') as f:
        f.write('// Generováno z content/web/ (tools/build.py). Neupravovat ručně.\n')
        f.write('window.WEB=%s;\n' % json.dumps(web, ensure_ascii=False, indent=1))
        f.write('window.L10N=%s;\n' % json.dumps(tr, ensure_ascii=False, indent=1))
    demo()
    stamp()
    print('akce: %d, s fotkami %d, s plakátem %d' % (len(items), sum(1 for a in items if a.get('photos')), sum(1 for a in items if a.get('poster'))))


DEMO_STRANKA = {
    'nazev': 'Ukázková stránka', 'menu': 'Ukázka', 'v_menu': True, 'poradi': 10,
    'nadtitulek': 'Jen pro ukázku administrace',
    'perex': 'Takhle se skládá nová stránka. Na skutečném webu tato stránka není.',
    'bloky': [
        {'type': 'nadpis', 'text': 'Nadpis části'},
        {'type': 'text', 'text': 'Odstavec textu. Jde psát **tučně** a vkládat [odkazy](#program).\n\nDalší odstavec.'},
        {'type': 'fotka', 'src': 'img/zahrada-plochy.jpg', 'popisek': 'Fotka s popiskem'},
        {'type': 'tlacitko', 'text': 'Program akcí', 'odkaz': '#program'},
    ],
}


def demo():
    """Ukázková administrace bez přihlášení: obsah repozitáře vložený do stránky (nic se neukládá)."""
    tree = {}
    for base, _, files in os.walk('content'):
        for fn in files:
            node = tree
            for part in os.path.join(base, fn).split(os.sep)[:-1]:
                node = node.setdefault(part, {})
            if not fn.endswith('.json'):
                continue
            with open(os.path.join(base, fn), encoding='utf-8') as f:
                d = json.load(f)
            # Decap umí jen i18n „single_file“: {cs: {...}, en: {...}, de: {...}}
            cs, loc = split(d)
            node[fn] = {'content': json.dumps(dict({'cs': cs}, **loc), ensure_ascii=False, indent=2)}
    # v ukázce jedna vzorová vlastní stránka, ať je vidět, jak se skládá (na web se nedostane)
    st = tree.setdefault('content', {}).setdefault('stranky', {})
    if not st:
        st['ukazkova-stranka.json'] = {'content': json.dumps({'cs': DEMO_STRANKA}, ensure_ascii=False, indent=2)}
    with open('admin/config.yml', encoding='utf-8') as f:
        cfg = json.loads(''.join(l for l in f if not l.startswith('#')))
    cfg['backend'] = {'name': 'test-repo'}
    cfg['locale'] = 'cs'
    if cfg.get('i18n'):
        cfg['i18n']['structure'] = 'single_file'
    # Decap chce řazení jako seznam objektů (Sveltia jako {fields, default})
    for c in cfg['collections']:
        sf = c.get('sortable_fields')
        if isinstance(sf, dict):
            d = sf.get('default') or {}
            c['sortable_fields'] = [dict({'field': f}, **({'default_sort': 'desc' if d.get('direction', '').lower() == 'descending' else 'asc'} if f == d.get('field') else {}))
                                    for f in sf['fields']]
    cfg['load_config_file'] = False
    os.makedirs('admin/demo', exist_ok=True)
    with open('admin/demo/data.js', 'w', encoding='utf-8') as f:
        f.write('window.repoFiles=%s;\n' % json.dumps(tree, ensure_ascii=False))
        # testovací backend Decapu hledá složku kolekce jako jeden klíč ("content/akce")
        f.write('window.repoFiles["content/akce"]=window.repoFiles.content.akce;\n')
        f.write('window.repoFiles["content/stranky"]=window.repoFiles.content.stranky;\n')
    with open('admin/demo/config.js', 'w', encoding='utf-8') as f:
        f.write('window.DEMO_CONFIG=%s;\n' % json.dumps(cfg, ensure_ascii=False, indent=1))



def stamp():
    """Do index.html připíše k data/*.js otisk obsahu (?v=...), aby prohlížeč po změně nevzal starou kopii."""
    import hashlib
    with open('index.html', encoding='utf-8') as f:
        page = f.read()
    def ver(m):
        with open(m.group(1), 'rb') as g:
            return '<script src="%s?v=%s"></script>' % (m.group(1), hashlib.md5(g.read()).hexdigest()[:8])
    new = re.sub(r'<script src="(data/[a-z0-9]+\.js)(?:\?v=[^"]*)?"></script>', ver, page)
    if new != page:
        with open('index.html', 'w', encoding='utf-8') as f:
            f.write(new)


if __name__ == '__main__':
    main()
