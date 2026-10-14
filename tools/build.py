#!/usr/bin/env python3
"""Sestaví data webu z obsahu, který se upravuje v administraci.

content/akce/*.json   -> data/akce.js  (window.AKCE, window.ROKY, window.HERO)
content/web/*.json    -> data/web.js   (window.WEB)
content/stranky/*.json -> data/web.js  (window.WEB.stranky, vlastní stránky v menu)
Fotky akcí: zmenší na 1000 px a vytvoří náhledy v img/akce/t/.
Plakáty a fotky suvenýrů: zmenší na 1400 px.
Ukázková administrace: admin/demo/data.js a admin/demo/config.js.
Spouští se automaticky na GitHubu po každé změně (.github/workflows/build.yml).
"""
import html, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

TAGC = {'Pro děti': 'kids', 'Přijďte pomoct': 'help'}


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


def akce():
    items = []
    for fn in sorted(os.listdir('content/akce')):
        if not fn.endswith('.json'):
            continue
        a = load('content/akce/' + fn)
        o = {'id': fn[:-5]}
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
        s = load('content/stranky/' + fn)
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
        out.append(o)
    out.sort(key=lambda o: (o['poradi'], o['nazev']))
    return out


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
    items = akce()
    uvod = load('content/web/uvod.json')
    web = {k: load('content/web/%s.json' % k) for k in ('navsteva', 'suvenyry')}
    web['zahrada'] = load('content/web/zahrada.json')
    web['cizojazycne'] = load('content/web/cizojazycne.json')
    web['partneri'] = load('content/web/partneri.json').get('partneri', [])
    web['stranky'] = stranky()
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
    demo()
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
                node[fn] = {'content': f.read()}
    # v ukázce jedna vzorová vlastní stránka, ať je vidět, jak se skládá (na web se nedostane)
    st = tree.setdefault('content', {}).setdefault('stranky', {})
    if not st:
        st['ukazkova-stranka.json'] = {'content': json.dumps(DEMO_STRANKA, ensure_ascii=False, indent=2)}
    with open('admin/config.yml', encoding='utf-8') as f:
        cfg = json.loads(''.join(l for l in f if not l.startswith('#')))
    cfg['backend'] = {'name': 'test-repo'}
    cfg['locale'] = 'cs'
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


if __name__ == '__main__':
    main()
