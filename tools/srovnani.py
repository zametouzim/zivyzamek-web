#!/usr/bin/env python3
"""Kopie webu na porovnání: web s viditelnými úpravami pro vyhledávače, ve složce srovnani/.

Michal (28. 10. 2026) chce viditelné úpravy nejdřív vidět na webu a porovnat je se současným,
než se rozhodne. Kopie má navíc:
  Časté dotazy        na stránkách Zámek a historie a Navštivte nás (krátká odpověď + odkaz na článek)
  Zajímavosti         souhrnná stránka článků (odkaz v patičce)
  21 článků           každý s vlastní adresou, texty v tools/srovnani-clanky.json (z dokumentu „SEO a GEO články“)
Všechny stránky kopie mají noindex, aby je vyhledávače nebraly jako druhý web.
Na skutečný web nemá vliv. Spouští se ručně (python3 tools/srovnani.py) po tools/build.py;
smazat jde celou složku srovnani/ (texty článků zůstávají v tools/srovnani-clanky.json).

python3 tools/srovnani.py januv-hrad   postaví jen vybrané články (zkušební článek pro Michala, 28. 10. 2026):
bez Častých dotazů a Zajímavostí, ostatní odkazy vedou na skutečný web.
"""
import html, json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import adresy  # noqa: E402

PFX = 'srovnani/'
SKUPINY = [('Návštěva', [2, 3, 10, 11, 19]), ('Historie', [1, 4, 5, 6, 7, 12, 18]),
           ('Akce a spolek', [8, 9, 13, 14]), ('Zahrada a okolí', [15, 16, 17, 20, 21])]
FAQ = {
    'zamek': [(1, 'Je v Toužimi hrad, nebo zámek?'), (5, 'Co je Janův hrad?'), (12, 'Komu zámek patří?'),
              (6, 'Jaký je rozdíl mezi Horním a Dolním zámkem?'), (7, 'Kdo je Černý mnich?')],
    'navsteva': [(2, 'Kdy je zámek otevřený?'), (3, 'Kolik stojí vstupné a prohlídka?'), (10, 'Kde zaparkovat a jak se k zámku dostat?'),
                 (19, 'Dá se zámek navštívit mimo sezónu?'), (11, 'Co na zámku zažijí děti?')],
}
CSS = '''<style>
.srov{background:#1f6f4a;color:#fff;font:15px/1.4 var(--font);padding:8px 16px;text-align:center}
.srov a{color:#fff;font-weight:700}
.faq{display:grid;border-top:2px solid var(--line);margin-bottom:24px}
.faq details{border-bottom:1px solid var(--line)}
.faq summary{cursor:pointer;list-style:none;padding:16px 40px 16px 0;font-family:var(--cond);font-size:22px;font-weight:600;position:relative;min-height:44px}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";position:absolute;right:4px;top:12px;font-size:28px;color:var(--accent)}
.faq details[open] summary::after{content:"–"}
.faq details p{margin:0 0 18px;max-width:70ch}
.faq details a{color:var(--accent)}
.crumbs{font-size:15px;color:var(--grey);padding-top:28px;margin:0}.crumbs a{color:var(--accent)}
.clanek{max-width:72ch;padding-bottom:48px}.clanek p,.clanek li{font-size:19px;line-height:1.6}.clanek p{margin:0 0 18px}
.clanek .odp{font-size:21px;background:var(--panel);padding:20px 22px;border-left:6px solid var(--accent)}
.clanek a{color:var(--accent)}.clanek ul,.clanek ol{margin:0 0 18px;padding-left:24px}
.clanek table{border-collapse:collapse;margin:0 0 18px}.clanek td{border-bottom:1px solid var(--line);padding:6px 10px;vertical-align:top}
.souv{border-top:2px solid var(--line);padding-top:16px;margin-top:32px}.souv h2{font-family:var(--cond);font-size:22px;margin:0 0 8px}
.souv ul{list-style:none;padding:0;margin:0;display:grid;gap:6px}
.zaj{list-style:none;padding:0;margin:0 0 8px;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
.zaj a{display:block;background:var(--panel);padding:18px 20px;color:var(--ink);text-decoration:none;height:100%}
.zaj a:hover b,.zaj a:focus-visible b{text-decoration:underline}
.zaj b{display:block;font-family:var(--cond);font-size:21px;margin-bottom:4px}
.zaj span{display:block;font-size:15px;line-height:1.45;color:var(--grey)}
.zcat{font-family:var(--cond);text-transform:uppercase;letter-spacing:.08em;font-size:15px;color:var(--accent);margin:32px 0 12px}
.clanek h2{font-family:var(--cond);font-size:28px;line-height:1.15;margin:36px 0 12px}
.clanek .fakta{background:var(--panel);padding:18px 22px;margin:0 0 24px}
.clanek .fakta h2{font-size:21px;margin:0 0 10px}
.clanek .fakta dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:0;font-size:17px;line-height:1.45}
.clanek .fakta dt{font-weight:700}.clanek .fakta dd{margin:0}
@media(max-width:560px){.clanek .fakta dl{grid-template-columns:1fr;gap:0}.clanek .fakta dd{margin-bottom:8px}}
.clanek figure{margin:8px 0 28px}.clanek .foto img{display:block;width:100%;height:auto}
.clanek figcaption{font-size:15px;line-height:1.4;color:var(--grey);margin-top:8px}.clanek .zfig figcaption{color:#555}
.clanek sup.zc{font-size:.68em;line-height:0;margin-left:1px}.clanek sup.zc a{text-decoration:none;padding:0 1px}
.clanek .zdroje{border-top:2px solid var(--line);margin-top:36px}
.clanek .zdroje li,.clanek .zdroje p{font-size:16px;line-height:1.5}.clanek .zdroje li{margin-bottom:6px;scroll-margin-top:96px}
.clanek .zdroje li:target{background:var(--panel)}
</style>
'''


def odpoved(body):
    """První odstavec článku = krátká odpověď."""
    m = re.match(r'<p>(.*?)</p>', body, re.S)
    return m.group(1) if m else ''


def skupina(n):
    return next(g for g, ns in SKUPINY if n in ns)


def main(jen=()):
    akce, web, l10n, dnes = adresy.nacti()
    clanky = {c['n']: c for c in json.load(open('tools/srovnani-clanky.json', encoding='utf-8'))}
    nezname = set(jen) - {c['slug'] for c in clanky.values()}
    if nezname:
        raise SystemExit('srovnani: neznámý článek %s' % ', '.join(sorted(nezname)))
    vybrane = {n: c for n, c in clanky.items() if not jen or c['slug'] in jen}
    s = open('index.html', encoding='utf-8').read()
    if 'class="srov"' in s:
        raise SystemExit('srovnani: index.html už je kopie')

    s = s.replace('</head>', CSS + '</head>', 1)
    if jen:
        pruh = 'Zkušební článek, na skutečném webu zatím není. Celý web je <a href="https://zametouzim.github.io/zivyzamek-web/">tady</a>.'
    else:
        pruh = ('Kopie webu na porovnání: Časté dotazy, <a href="zajimavosti/">Zajímavosti</a> a články. '
                'Současný web je <a href="https://zametouzim.github.io/zivyzamek-web/">tady</a>.')
    s = s.replace('<body>', '<body>\n<div class="srov" role="region" aria-label="Kopie webu">%s</div>' % pruh, 1)

    def faq(stranka):
        h = '<div class="page-head" style="margin-top:72px;padding-bottom:16px"><span class="eyebrow">Časté dotazy</span><h2>Na co se lidé ptají</h2></div><div class="faq">'
        for i, (n, otazka) in enumerate(FAQ[stranka]):
            c = clanky[n]
            h += '<details%s><summary>%s</summary><p>%s <a href="@@%s/">Celý článek →</a></p></details>' % (
                ' open' if i == 0 else '', html.escape(otazka), odpoved(c['body']), c['slug'])
        return h + '</div>\n'
    if not jen:
        kotva = '<div class="page-head" style="margin-top:72px"><span class="eyebrow">Areál zámku</span>'
        assert kotva in s
        s = s.replace(kotva, faq('zamek') + '    ' + kotva, 1)
        # Navštivte nás: na konec stránky, před konec sekce
        a = s.index('<section data-page="navsteva" hidden>')
        b = s.index('</section>', a)
        k = s.rindex('</div>', a, b)
        s = s[:k] + faq('navsteva') + s[k:]

    # stránky článků a Zajímavosti
    sekce = ''
    for n, c in sorted(vybrane.items()):
        g = skupina(n)
        dalsi = [clanky[x] for x in dict(SKUPINY)[g] if x != n and x in vybrane][:3]
        body = re.sub(r'^<p>', '<p class="odp">', c['body'], count=1)
        if dalsi:
            body += '<div class="souv"><h2>Mohlo by vás zajímat</h2><ul>%s</ul></div>' % ''.join(
                '<li><a href="@@%s/">%s</a></li>' % (d['slug'], html.escape(d['h1'])) for d in dalsi)
        if jen:
            hlava = '    <div class="page-head">'
        else:
            hlava = ('    <p class="crumbs"><a href="@@zajimavosti/">Zajímavosti</a> › %s</p>\n'
                     '    <div class="page-head" style="padding-top:16px">') % html.escape(c['h1'])
        sekce += ('<section data-page="%s" hidden>\n  <div class="wrap">\n%s<span class="eyebrow">%s</span><h1>%s</h1></div>\n'
                  '    <div class="clanek">%s</div>\n  </div>\n</section>\n') % (c['slug'], hlava, g, html.escape(c['h1']), body)
    seznam = ''
    for g, ns in SKUPINY:
        seznam += '<p class="zcat">%s</p><ul class="zaj">%s</ul>' % (g, ''.join(
            '<li><a href="@@%s/"><b>%s</b><span>%s</span></a></li>' % (clanky[n]['slug'], html.escape(clanky[n]['h1']), html.escape(clanky[n]['meta']))
            for n in ns))
    navic = []
    if not jen:
        sekce += ('<section data-page="zajimavosti" hidden>\n  <div class="wrap">\n    <div class="page-head"><span class="eyebrow">Zajímavosti</span>'
                  '<h1>Co vás zajímá o zámku Toužim</h1><p>Krátké články o historii zámku, návštěvě, akcích a zahradě.</p></div>\n    %s\n  </div>\n</section>\n') % seznam
        # odkaz v patičce
        s = s.replace('<p><a href="navsteva/#dotaz">Napište nám →</a></p></div>', '<p><a href="navsteva/#dotaz">Napište nám →</a></p><p><a href="@@zajimavosti/">Zajímavosti o zámku →</a></p></div>', 1)
        navic.append(('zajimavosti', {'cs': ('Zajímavosti o zámku Toužim', 'Krátké články o historii zámku Toužim, návštěvě, akcích a zahradě.')}, {}))
    s = s.replace('<!-- SPOLEK -->', sekce + '<!-- SPOLEK -->', 1)
    s = s.replace('href="@@', 'href="')  # odkazy dostanou složku kopie v adresy.stranka

    for n, c in sorted(vybrane.items()):
        ld = {'@context': 'https://schema.org', '@type': 'Article', 'headline': c['h1'], 'description': c['meta'],
              'inLanguage': 'cs', 'publisher': {'@id': adresy.SITE + '#spolek'}, 'about': {'@id': adresy.SITE + '#zamek'}}
        if c.get('obrazek'):
            ld['image'] = adresy.SITE + c['obrazek']
        if c.get('zdroje'):
            ld['citation'] = c['zdroje']
        navic.append((c['slug'], {'cs': (c['title'], c['meta'])}, ld))
    soubory, _ = adresy.sestav(s, akce, web, l10n, dnes, pfx=PFX, navic=navic, noindex=True)
    if jen:  # jen stránky článků; odkazy mimo ně vedou na skutečný web
        vlastni = re.compile(r'href="%s(?!(?:%s)/)' % (re.escape(PFX), '|'.join(map(re.escape, jen))))
        soubory = {cesta: vlastni.sub('href="', obsah) for cesta, obsah in soubory.items()
                   if cesta in {PFX + j + '/index.html' for j in jen}}
    n, zmeneno = adresy.zapis(soubory, PFX + 'stranky.json')
    print('srovnani: %d stránek, změněno %d' % (n, zmeneno))


if __name__ == '__main__':
    main(sys.argv[1:])
