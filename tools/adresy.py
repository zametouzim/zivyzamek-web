#!/usr/bin/env python3
"""Skutečné adresy stránek pro vyhledávače (SEO): /program/, /zamek/, /akce/<id>/ …

Web je jedna stránka (index.html), která přepíná sekce. Vyhledávače ale část adresy za mřížkou
(#program) nečtou, takže by celý web byl pro ně jedna stránka. Proto se pro každou stránku
a každou akci vytvoří složka s kopií index.html, která má:
  <base href="../">          odkazy na obrázky, data a skripty vedou do kořene webu
  vlastní titulek a popis      (cs v hlavičce, en/de ve window.META, dosadí je překlad stránky)
  canonical a hreflang        hlavní adresa stránky a její jazykové verze (?lang=en|de)
  strukturovaná data          JSON-LD: zámek, spolek, akce (Event)
  viditelnou svou sekci        a u akcí a programu předvyplněný obsah pro roboty bez JavaScriptu
V kořeni webu hlavičku index.html, sitemap.xml a robots.txt. Seznam vytvořených složek je
v data/adresy.json; složky, které už nemají co obsahovat (smazaná akce), se smažou.

Spouští ho tools/build.py (po každé změně v administraci), jde spustit i samostatně.
Data čte z data/akce.js a data/web.js, takže build.py musí běžet dřív.
"""
import html, json, os, re, shutil, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = 'https://www.zivyzamektouzim.cz/'  # adresa ostrého webu (stejná jako u og:image v index.html)
OBR = SITE + 'img/og.jpg'
ZNACKA = re.compile(r'<!--seo:.*?-->\n.*?<!--/seo-->\n', re.S)
HLAVA = '<!--seo: generuje tools/adresy.py, neupravovat ručně-->\n%s<!--/seo-->\n'
# složky webu, které nejsou stránky (vlastní stránka z administrace se nesmí jmenovat stejně)
REZERVOVANE = {'img', 'docs', 'data', 'i18n', 'js', 'admin', 'nahled', 'navod', 'skripty', 'tools', 'content',
               'dotace', 'akce', 'domu', 'platba', 'archiv', 'dotaz'}

ADRESA = {'@type': 'PostalAddress', 'streetAddress': 'náměstí Jiřího z Poděbrad 1', 'postalCode': '364 01',
          'addressLocality': 'Toužim', 'addressCountry': 'CZ'}
SPOLEK = {'@type': 'NGO', '@id': SITE + '#spolek', 'name': 'Živý zámek Toužim, z. s.', 'alternateName': 'Živý zámek Toužim',
          'url': SITE, 'logo': SITE + 'img/logo.png',
          'address': {'@type': 'PostalAddress', 'streetAddress': 'Na Výsluní 346', 'addressLocality': 'Toužim', 'addressCountry': 'CZ'},
          'email': 'zivyzamektouzim@email.cz', 'foundingDate': '2016',
          'identifier': {'@type': 'PropertyValue', 'propertyID': 'IČO', 'value': '04690770'},
          'sameAs': ['https://www.facebook.com/zivyzamek.touzim', 'https://www.instagram.com/zivyzamektouzim/']}

# titulky a popisy stránek; texty stránek jsou v index.html, tady jen to, co ukazuje vyhledávač
STRANKY = {
    'domu': {
        'cs': ('Živý zámek Toužim – akce, prohlídky a historie zámku',
               'Spolek dobrovolníků, který od roku 2015 oživuje zámek v Toužimi. Koncerty, divadlo, letní kino, prohlídky Janova hradu, brigády a obnova zámecké zahrady.'),
        'en': ('Živý zámek Toužim – events, tours and history of Toužim Castle',
               "A volunteer association bringing the castle in Toužim back to life since 2015. Concerts, theatre, open-air cinema, tours of Jan's Castle, work days and the restoration of the castle garden."),
        'de': ('Živý zámek Toužim – Veranstaltungen, Führungen und Geschichte von Schloss Theusing',
               'Ein Verein von Freiwilligen, der seit 2015 das Schloss in Theusing (Toužim) wiederbelebt. Konzerte, Theater, Sommerkino, Führungen durch Jans Burg, Arbeitseinsätze und die Erneuerung des Schlossgartens.'),
    },
    'program': {
        'cs': ('Program akcí na zámku Toužim',
               'Koncerty, divadlo, letní kino, prohlídky a brigády na zámku Toužim. Program sezóny a archiv akcí od roku 2015 s plakáty a fotkami.'),
        'en': ('Events at Toužim Castle',
               'Concerts, theatre, open-air cinema, tours and work days at Toužim Castle. This season’s programme and an archive of events since 2015 with posters and photos.'),
        'de': ('Veranstaltungen im Schloss Theusing',
               'Konzerte, Theater, Sommerkino, Führungen und Arbeitseinsätze im Schloss Theusing. Programm der Saison und Archiv der Veranstaltungen seit 2015 mit Plakaten und Fotos.'),
    },
    'navsteva': {
        'cs': ('Návštěva zámku Toužim: otevírací doba, vstupné, cesta', None),
        'en': ('Visiting Toužim Castle: opening hours, admission, getting here', None),
        'de': ('Besuch im Schloss Theusing: Öffnungszeiten, Eintritt, Anfahrt', None),
    },
    'zahrada': {
        'cs': ('Zámecká zahrada Toužim – obnova 2025–2027',
               'Mezi Horním a Dolním zámkem v Toužimi zakládáme novou zahradu s kamennými záhony a herním svahem. Při práci jsme objevili hradební zeď z 15. století.'),
        'en': ('Toužim Castle garden – restoration 2025–2027',
               'Between the Upper and Lower Castle in Toužim we are creating a new garden with stone beds and a play slope. During the work we uncovered a 15th-century town wall.'),
        'de': ('Schlossgarten Theusing – Erneuerung 2025–2027',
               'Zwischen dem Oberen und dem Unteren Schloss in Theusing legen wir einen neuen Garten mit Steinbeeten und einem Spielhang an. Bei den Arbeiten haben wir eine Stadtmauer aus dem 15. Jahrhundert entdeckt.'),
    },
    'zamek': {
        'cs': ('Historie zámku Toužim a Janova hradu',
               'Zámek Toužim byl proboštstvím, od roku 1437 gotickým hradem a od 16. století zámkem. Historie, majitelé, podoba areálu kolem roku 1700 a pověst o černém mnichovi.'),
        'en': ("History of Toužim Castle and Jan's Castle",
               'Toužim Castle was a provostry, a Gothic castle from 1437 and a château from the 16th century. Its history, owners, the site around 1700 and the legend of the Black Monk.'),
        'de': ('Geschichte von Schloss Theusing und Jans Burg',
               'Schloss Theusing war eine Propstei, ab 1437 eine gotische Burg und ab dem 16. Jahrhundert ein Schloss. Geschichte, Besitzer, das Areal um 1700 und die Sage vom schwarzen Mönch.'),
    },
    'spolek': {
        'cs': ('Spolek Živý zámek Toužim – kdo jsme',
               'Dobrovolníci, kteří od roku 2015 chrání, ukazují a obnovují zámek v Toužimi ve spolupráci s městem. Členové spolku, výroční zprávy a dokumenty.'),
        'en': ('The Živý zámek Toužim association – who we are',
               'Volunteers who since 2015 have been protecting, showing and restoring the castle in Toužim together with the town. Members, annual reports and documents.'),
        'de': ('Verein Živý zámek Toužim – wer wir sind',
               'Freiwillige, die seit 2015 das Schloss in Theusing gemeinsam mit der Stadt schützen, zeigen und erneuern. Mitglieder, Jahresberichte und Dokumente.'),
    },
    'podporte': {
        'cs': ('Podpořte zámek Toužim – brigády, dary, členství',
               'Přijďte na brigádu, přivezte občerstvení nebo materiál, pošlete dar, staňte se členem nebo kupte suvenýr. Každá pomoc vrací zámku v Toužimi život.'),
        'en': ('Support Toužim Castle – work days, donations, membership',
               'Come to a work day, bring food or materials, make a donation, become a member or buy a souvenir. Every bit of help brings the castle in Toužim back to life.'),
        'de': ('Unterstützen Sie Schloss Theusing – Arbeitseinsätze, Spenden, Mitgliedschaft',
               'Kommen Sie zu einem Arbeitseinsatz, bringen Sie Verpflegung oder Material, spenden Sie, werden Sie Mitglied oder kaufen Sie ein Souvenir. Jede Hilfe bringt das Schloss in Theusing zurück ins Leben.'),
    },
}
MESICE = {'en': 'January February March April May June July August September October November December'.split(),
          'de': 'Januar Februar März April Mai Juni Juli August September Oktober November Dezember'.split()}
ZNACKA_WEBU = {'cs': 'Živý zámek Toužim', 'en': 'Živý zámek Toužim', 'de': 'Živý zámek Toužim'}


def nacti_js(cesta):
    """window.X=…; z data/*.js jako slovník {X: hodnota}."""
    s = open(os.path.join(ROOT, cesta), encoding='utf-8').read()
    return {m.group(1): json.loads(m.group(2)) for m in re.finditer(r'^window\.(\w+)=(.*?);\n(?=window\.|\Z)', s, re.S | re.M)}


def e(t):
    return html.escape(t, quote=True)


def text(h, n=155):
    """Prostý text z HTML, zkrácený na celé věty (nejvýš n znaků)."""
    t = re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', h or ''))).strip()
    if len(t) <= n:
        return t
    kus = t[:n]
    tecka = max(kus.rfind('. '), kus.rfind('! '), kus.rfind('? '))
    return kus[:tecka + 1] if tecka > 60 else kus[:kus.rfind(' ')].rstrip(',;:–') + '…'


def datum(a, l='cs'):
    def jeden(iso):
        r, m, d = iso.split('-')
        if l == 'cs':
            return '%d. %d. %s' % (int(d), int(m), r)
        if l == 'en':
            return '%d %s %s' % (int(d), MESICE['en'][int(m) - 1], r)
        return '%d. %s %s' % (int(d), MESICE['de'][int(m) - 1], r)
    return jeden(a['date']) + (' – ' + jeden(a['end']) if a.get('end') else '')


def url(cesta):
    return SITE + urllib.parse.quote(cesta)


def hlavicka(cesta, meta, ld, noindex=False, pfx=''):
    """Blok mezi <!--seo--> a <!--/seo--> v hlavičce. cesta = '' (úvod), 'program/', 'akce/x/'.
    pfx = složka kopie webu (srovnani/); kopie míří obrázky a data do kořene webu a canonical na skutečnou stránku."""
    t, d = meta['cs']
    u = url(cesta)
    r = []
    if pfx + cesta:
        r.append('<base href="%s">' % ('../' * (pfx + cesta).count('/')))
    if pfx:
        r.append('<script>window.PFX=%s</script>' % json.dumps(pfx))
    r.append('<title>%s</title>' % e(t))
    r.append('<meta name="description" content="%s">' % e(d))
    if noindex:
        r.append('<meta name="robots" content="noindex">')
    r.append('<link rel="canonical" href="%s">' % u)
    for l in ('cs', 'en', 'de'):
        r.append('<link rel="alternate" hreflang="%s" href="%s">' % (l, u + ('' if l == 'cs' else '?lang=' + l)))
    r.append('<link rel="alternate" hreflang="x-default" href="%s">' % u)
    r.append('<meta property="og:title" content="%s">' % e(t))
    r.append('<meta property="og:description" content="%s">' % e(d))
    r.append('<meta property="og:url" content="%s">' % u)
    preklad = {l: {'t': meta[l][0], 'd': meta[l][1]} for l in ('en', 'de') if meta.get(l)}
    r.append('<script>window.META=%s</script>' % json.dumps(preklad, ensure_ascii=False).replace('</', '<\\/'))
    r.append('<script type="application/ld+json">%s</script>' % json.dumps(ld, ensure_ascii=False).replace('</', '<\\/'))
    return HLAVA % ''.join(x + '\n' for x in r)


def zamek(web):
    """Zámek jako turistický cíl; otevírací doba z administrace (stránka Navštivte nás), když jde přečíst."""
    z = {'@type': ['TouristAttraction', 'LandmarksOrHistoricalBuildings'], '@id': SITE + '#zamek', 'name': 'Zámek Toužim',
         'description': STRANKY['zamek']['cs'][1], 'url': SITE + 'navsteva/', 'image': OBR, 'address': ADRESA,
         'telephone': '+420724859799'}
    n = web.get('navsteva', {})
    m = re.fullmatch(r'sobota a neděle (\d+)–(\d+) a (\d+)–(\d+) h', n.get('vstup_cas', '').strip())
    od, do = n.get('sezona_od'), n.get('sezona_do')
    if m and isinstance(od, int) and isinstance(do, int) and 1 <= od <= do <= 12:
        # sezóna letos, po jejím konci příští rok (stránka se přestaví při každé změně v administraci)
        import calendar, datetime
        dnes = datetime.date.today()
        rok = dnes.year + (1 if dnes.month > do else 0)
        z['openingHoursSpecification'] = [
            {'@type': 'OpeningHoursSpecification', 'dayOfWeek': ['Saturday', 'Sunday'],
             'opens': '%02d:00' % int(a), 'closes': '%02d:00' % int(b),
             'validFrom': '%d-%02d-01' % (rok, od), 'validThrough': '%d-%02d-%02d' % (rok, do, calendar.monthrange(rok, do)[1])}
            for a, b in ((m[1], m[2]), (m[3], m[4]))]
    return z


def navsteva_meta(web, l10n):
    def popis(n, l):
        if not n.get('vstup_cas'):
            return STRANKY['domu'][l][1]
        if l == 'cs':
            return 'Zámek Toužim: %s, vstup %s, %s. Komentovaná prohlídka %s, %s. Mimo sezónu %s.' % (
                n.get('sezona', '').lower(), n['vstup_cas'], n.get('vstup_cena', ''), n.get('prohlidka_cas', ''),
                n.get('prohlidka_cena', ''), n.get('mimo_sezonu', ''))
        if l == 'en':
            return 'Toužim Castle: %s, entry %s, %s. Guided tour %s, %s. Off season %s.' % (
                n.get('sezona', ''), n['vstup_cas'], n.get('vstup_cena', ''), n.get('prohlidka_cas', ''),
                n.get('prohlidka_cena', ''), n.get('mimo_sezonu', ''))
        return 'Schloss Theusing: %s, Eintritt %s, %s. Führung %s, %s. Außerhalb der Saison %s.' % (
            n.get('sezona', ''), n['vstup_cas'], n.get('vstup_cena', ''), n.get('prohlidka_cas', ''),
            n.get('prohlidka_cena', ''), n.get('mimo_sezonu', ''))
    m = {}
    for l in ('cs', 'en', 'de'):
        n = web.get('navsteva', {}) if l == 'cs' else ((l10n.get(l) or {}).get('web') or {}).get('navsteva') or {}
        if l != 'cs' and not n.get('vstup_cas'):
            n = {}
        m[l] = (STRANKY['navsteva'][l][0], popis(n, l) if n else STRANKY['domu'][l][1])
    return m


def udalost(a, cesta, tr):
    ld = {'@type': 'Event', 'name': a['title'], 'startDate': a['date'], 'endDate': a.get('end') or a['date'],
          'eventAttendanceMode': 'https://schema.org/OfflineEventAttendanceMode',
          'eventStatus': 'https://schema.org/EventScheduled',
          'location': {'@type': 'Place', '@id': SITE + '#zamek', 'name': 'Zámek Toužim', 'address': ADRESA},
          'organizer': {'@type': 'NGO', '@id': SITE + '#spolek', 'name': 'Živý zámek Toužim, z. s.', 'url': SITE},
          'url': url(cesta)}
    popis = a.get('short') or text(a.get('html'), 300)
    if popis:
        ld['description'] = popis
    obr = [SITE + a['poster']] if a.get('poster') else []
    obr += [SITE + f for f in (a.get('photos') or [])[:3]]
    if obr:
        ld['image'] = obr
    return dict({'@context': 'https://schema.org'}, **ld)


def akce_meta(a, tr):
    m = {}
    for l in ('cs', 'en', 'de'):
        t = a if l == 'cs' else dict(a, **((tr.get(l) or {}).get('akce', {}).get(a['id']) or {}))
        if l != 'cs' and not (tr.get(l) or {}).get('akce', {}).get(a['id']):
            continue
        misto = {'cs': 'zámek Toužim', 'en': 'Toužim Castle', 'de': 'Schloss Theusing'}[l]
        titulek = '%s, %s – %s' % (t['title'], datum(a, l), ZNACKA_WEBU[l])
        popis = t.get('short') or text(t.get('html'))
        if not popis:
            popis = {'cs': '%s na zámku Toužim, %s.', 'en': '%s at Toužim Castle, %s.', 'de': '%s im Schloss Theusing, %s.'}[l] % (t['title'], datum(a, l))
        elif misto.lower() not in popis.lower() and 'toužim' not in popis.lower() and 'theusing' not in popis.lower():
            popis = text('%s (%s, %s) %s' % (t['title'], misto, datum(a, l), popis))
        m[l] = (titulek, popis)
    return m


def detail_html(a, dnes):
    """Obsah detailu akce pro roboty bez JavaScriptu (skript na stránce ho nahradí stejným obsahem)."""
    probehla = (a.get('end') or a['date']) < dnes
    h = ('<a class="ak-back" href="program/#archiv">← Archiv akcí</a>' if probehla else '<a class="ak-back" href="program/">← Program</a>')
    h += '<div class="ak-head"><div class="ak-date">%s</div><h1>%s</h1>%s</div>' % (
        datum(a), e(a['title']), '<div class="ak-when">%s</div>' % e(a['when']) if a.get('when') else '')
    h += '<div class="ak-body"><div class="ak-text">%s</div>' % (
        ''.join('<p>%s</p>' % p for p in a['html'].split('\n')) if a.get('html') else '')
    if a.get('poster'):
        h += '<img src="%s" alt="Plakát: %s" style="max-width:100%%">' % (e(a['poster']), e(a['title']))
    return h + '</div>'


def program_html(akce, dnes):
    vidi = [a for a in akce if not a.get('skryta')]
    prijde = sorted((a for a in vidi if (a.get('end') or a['date']) >= dnes), key=lambda a: a['date'])
    bylo = sorted((a for a in vidi if (a.get('end') or a['date']) < dnes), key=lambda a: a['date'], reverse=True)
    li = lambda a: '<li class="ev"><div class="d">%s</div><div><h2 class="h3"><a href="akce/%s/">%s</a></h2></div></li>' % (
        datum(a), e(a['id']), e(a['title']))
    return ''.join(li(a) for a in prijde), ''.join(li(a) for a in bylo)


def stranka(zaklad, cesta, hlava, sekce=None, vlozit=None, pfx='', slozky=()):
    s = ZNACKA.sub(lambda m: hlava, zaklad, count=1)
    if pfx + cesta:
        s = s.replace('href="#obsah"', 'href="%s#obsah"' % (pfx + cesta), 1)
    if sekce and sekce != 'domu':
        s = s.replace('<section data-page="domu">', '<section data-page="domu" hidden>', 1)
        s = s.replace('<section data-page="%s" hidden>' % sekce, '<section data-page="%s">' % sekce, 1)
    for co, cim in (vlozit or {}).items():
        i = co.index('></') + 1
        s = s.replace(co, co[:i] + cim + co[i:], 1)
    if pfx:  # odkazy na stránky webu vedou do kopie
        s = re.sub(r'href="(\./|(?:%s)/[^"]*)"' % '|'.join(map(re.escape, slozky)), lambda m: 'href="%s%s"' % (pfx, m.group(1)), s)
    return s


def sestav(zaklad, akce, web, l10n, dnes, pfx='', navic=(), noindex=False):
    """Všechny stránky webu: {cesta souboru: obsah} a seznam adres pro mapu webu.
    navic = [(id sekce, meta, ld)] další stránky, které v zakladu mají vlastní sekci (kopie webu)."""
    soubory, mapa = {}, []
    vlastni = []
    for p in web.get('stranky', []):
        pid = p.get('id', '')
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', pid) or pid in REZERVOVANE or pid in STRANKY:
            print('adresy: vlastní stránka „%s“ nemá vlastní adresu (nepovolený název)' % pid)
            continue
        vlastni.append(p)
    slozky = list(STRANKY) + ['akce'] + [p['id'] for p in vlastni] + [n[0] for n in navic]
    st = lambda cesta, hlava, sekce=None, vlozit=None: stranka(zaklad, cesta, hlava, sekce, vlozit, pfx, slozky)
    hl = lambda cesta, meta, ld, ni=False: hlavicka(cesta, meta, ld, ni or noindex, pfx)
    graf = {'@context': 'https://schema.org', '@graph': [zamek(web), SPOLEK,
            {'@type': 'WebSite', '@id': SITE + '#web', 'url': SITE, 'name': 'Živý zámek Toužim', 'inLanguage': ['cs', 'en', 'de'],
             'publisher': {'@id': SITE + '#spolek'}}]}
    soubory[pfx + 'index.html'] = st('', hl('', STRANKY['domu'], graf))
    mapa.append('')
    for sid in ('program', 'navsteva', 'zahrada', 'zamek', 'spolek', 'podporte'):
        meta = navsteva_meta(web, l10n) if sid == 'navsteva' else STRANKY[sid]
        ld = {'@context': 'https://schema.org', '@type': 'WebPage', 'name': meta['cs'][0], 'url': url(sid + '/'),
              'isPartOf': {'@id': SITE + '#web'}}
        if sid in ('navsteva', 'zamek'):
            ld['about'] = zamek(web)
        if sid == 'spolek':
            ld['about'] = SPOLEK
        vlozit = {}
        if sid == 'program':
            nahoru, archiv = program_html(akce, dnes)
            vlozit = {'<ul class="events up" id="upList"></ul>': nahoru, '<ul class="events arch" id="archList"></ul>': archiv}
        soubory[pfx + sid + '/index.html'] = st(sid + '/', hl(sid + '/', meta, ld), sid, vlozit)
        mapa.append(sid + '/')
    for p in vlastni:
        pid = p['id']
        meta = {'cs': ('%s – Živý zámek Toužim' % p.get('nazev', pid), p.get('perex') or STRANKY['domu']['cs'][1])}
        for l in ('en', 'de'):
            t = next((x for x in ((l10n.get(l) or {}).get('web') or {}).get('stranky', []) if x.get('id') == pid), None)
            if t and t.get('nazev'):
                meta[l] = ('%s – Živý zámek Toužim' % t['nazev'], t.get('perex') or STRANKY['domu'][l][1])
        ld = {'@context': 'https://schema.org', '@type': 'WebPage', 'name': meta['cs'][0], 'url': url(pid + '/'),
              'isPartOf': {'@id': SITE + '#web'}}
        soubory[pfx + pid + '/index.html'] = st(pid + '/', hl(pid + '/', meta, ld))
        mapa.append(pid + '/')
    for sid, meta, ld in navic:
        soubory[pfx + sid + '/index.html'] = st(sid + '/', hl(sid + '/', meta, ld), sid)
        mapa.append(sid + '/')
    for a in akce:
        if '/' in a['id'] or a['id'].startswith('.'):
            continue
        c = 'akce/%s/' % a['id']
        vlozit = {'<div class="wrap" id="akceDetail"></div>': detail_html(a, dnes)}
        soubory[pfx + c + 'index.html'] = st(c, hl(c, akce_meta(a, l10n), udalost(a, c, l10n), bool(a.get('skryta'))), 'akce', vlozit)
        if not a.get('skryta'):
            mapa.append(c)
    return soubory, mapa


def nacti():
    import datetime
    os.chdir(ROOT)
    akce_js, web_js = nacti_js('data/akce.js'), nacti_js('data/web.js')
    return akce_js.get('AKCE', []), web_js.get('WEB', {}), web_js.get('L10N', {}), datetime.date.today().isoformat()


def zapis(soubory, manifest):
    """Zapíše soubory, smaže stránky ze starého seznamu, které už nejsou, a uloží nový seznam."""
    stare = []
    if os.path.exists(manifest):
        stare = json.load(open(manifest, encoding='utf-8')).get('stranky', [])
    nove = sorted(c for c in soubory if c.endswith('/index.html'))
    for c in stare:
        if c not in soubory and c.endswith('/index.html') and os.path.exists(c):
            os.remove(c)
            d = os.path.dirname(c)
            while d and not os.listdir(d):
                os.rmdir(d)
                d = os.path.dirname(d)
    zmeneno = 0
    for c, obsah in soubory.items():
        if os.path.dirname(c):
            os.makedirs(os.path.dirname(c), exist_ok=True)
        if not os.path.exists(c) or open(c, encoding='utf-8').read() != obsah:
            with open(c, 'w', encoding='utf-8') as f:
                f.write(obsah)
            zmeneno += 1
    with open(manifest, 'w', encoding='utf-8') as f:
        json.dump({'stranky': nove}, f, ensure_ascii=False, indent=0)
        f.write('\n')
    return len(nove), zmeneno


def main():
    akce, web, l10n, dnes = nacti()
    zaklad = open('index.html', encoding='utf-8').read()
    if not ZNACKA.search(zaklad):
        raise SystemExit('adresy: v index.html chybí <!--seo--> … <!--/seo-->')
    soubory, mapa = sestav(zaklad, akce, web, l10n, dnes)
    soubory['sitemap.xml'] = ('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                              + ''.join('<url><loc>%s</loc></url>\n' % e(url(c)) for c in mapa) + '</urlset>\n')
    soubory['robots.txt'] = 'User-agent: *\nDisallow: /admin/\nDisallow: /nahled/\n\nSitemap: %ssitemap.xml\n' % SITE

    n, zmeneno = zapis(soubory, 'data/adresy.json')
    print('adresy: %d stránek, v mapě webu %d, změněno %d souborů' % (n + 1, len(mapa), zmeneno))

if __name__ == '__main__':
    main()
