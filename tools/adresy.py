#!/usr/bin/env python3
"""Skutečné adresy stránek pro vyhledávače (SEO): /program/, /zamek/, /akce/<id>/ …

Web je jedna stránka (index.html), která přepíná sekce. Vyhledávače ale část adresy za mřížkou
(#program) nečtou, takže by celý web byl pro ně jedna stránka. Proto se pro každou stránku
a každou akci vytvoří složka s kopií index.html, která má:
  <base href="../">          odkazy na obrázky, data a skripty vedou do kořene webu
  vlastní titulek a popis      (cs v hlavičce, en/de ve window.META, dosadí je překlad stránky)
  canonical a hreflang        hlavní adresa stránky a její jazykové verze (/en/…, /de/…; stará ?lang=en přesměruje)
  strukturovaná data          JSON-LD: zámek, spolek, akce (Event)
  viditelnou svou sekci        a u akcí a programu předvyplněný obsah pro roboty bez JavaScriptu
  jen svůj text               ostatní sekce jsou zabalené v <script type="text/x-sekce">, takže robot na adrese
                              čte jen obsah té stránky; skript hned za </main> v index.html je vrátí do stránky
V kořeni webu hlavičku index.html, sitemap.xml a robots.txt. Seznam vytvořených složek je
v data/adresy.json; složky, které už nemají co obsahovat (smazaná akce), se smažou.

Spouští ho tools/build.py (po každé změně v administraci), jde spustit i samostatně.
Data čte z data/akce.js a data/web.js, takže build.py musí běžet dřív.
"""
import hashlib, html, json, os, re, shutil, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = 'https://www.zivyzamektouzim.cz/'  # adresa ostrého webu (stejná jako u og:image v index.html)
OBR = SITE + 'img/og.jpg'
ZNACKA = re.compile(r'<!--seo:.*?-->\n.*?<!--/seo-->\n', re.S)
HLAVA = '<!--seo: generuje tools/adresy.py, neupravovat ručně-->\n%s<!--/seo-->\n'
SEKCE = re.compile(r'^<section data-page="([a-z]+)"( hidden)?>\n.*?^</section>\n', re.S | re.M)
OBAL = re.compile(r'^<script type="text/x-sekce">\n(.*?)</script>\n', re.S | re.M)
# složky webu, které nejsou stránky (vlastní stránka z administrace se nesmí jmenovat stejně)
REZERVOVANE = {'en', 'de', 'img', 'docs', 'data', 'i18n', 'js', 'admin', 'nahled', 'navod', 'skripty', 'tools', 'content',
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


OG_ALT = 'Zámek Toužim, pohled přes trávník s lavicemi na zámecké budovy'


def hlavicka(cesta, meta, ld, noindex=False, pfx='', obr=None, jazyk='cs'):
    """Blok mezi <!--seo--> a <!--/seo--> v hlavičce. cesta = '' (úvod), 'program/', 'akce/x/'.
    pfx = složka kopie webu (srovnani/); kopie míří obrázky a data do kořene webu a canonical na skutečnou stránku."""
    t, d = meta.get(jazyk) or meta['cs']
    u = url(cesta)
    r = []
    if pfx + cesta:
        r.append('<base href="%s">' % ('../' * (pfx + cesta).count('/')))
    if pfx:
        r.append('<script>window.PFX=%s</script>' % json.dumps(pfx))
    if jazyk != 'cs':  # anglická a německá verze: vlastní adresa /en/…, /de/… (Google je zařadí jako samostatné stránky)
        r.append('<script>window.JAZYK=%s</script>' % json.dumps(jazyk))
    r.append('<title>%s</title>' % e(t))
    r.append('<meta name="description" content="%s">' % e(d))
    if noindex:
        r.append('<meta name="robots" content="noindex">')
    vlastni = url(pfx + cesta) if jazyk != 'cs' else u
    r.append('<link rel="canonical" href="%s">' % vlastni)
    for l in ('cs', 'en', 'de'):
        r.append('<link rel="alternate" hreflang="%s" href="%s">' % (l, url(('' if l == 'cs' else l + '/') + cesta)))
    r.append('<link rel="alternate" hreflang="x-default" href="%s">' % u)
    r.append('<meta property="og:title" content="%s">' % e(t))
    r.append('<meta property="og:description" content="%s">' % e(d))
    r.append('<meta property="og:url" content="%s">' % vlastni)
    # obrázek při sdílení: u akce její plakát nebo fotka (tools/build.py, img/sdileni/), jinak obecný obrázek webu
    o_src, o_alt = obr or (OBR, OG_ALT)
    r.append('<meta property="og:image" content="%s">' % e(o_src))
    r.append('<meta property="og:image:width" content="1200">')
    r.append('<meta property="og:image:height" content="630">')
    r.append('<meta property="og:image:alt" content="%s">' % e(o_alt))
    preklad = {l: {'t': meta[l][0], 'd': meta[l][1]} for l in ('en', 'de') if meta.get(l)}
    r.append('<script>window.META=%s</script>' % json.dumps(preklad, ensure_ascii=False).replace('</', '<\\/'))
    for x in (ld if isinstance(ld, list) else [ld]):
        r.append('<script type="application/ld+json">%s</script>' % json.dumps(x, ensure_ascii=False).replace('</', '<\\/'))
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


# druh účinkujícího z administrace (admin/config.yml) → typ podle schema.org; neznámý = Person
DRUH_UCINKUJICIHO = {
    'Hudebník / zpěvák (sólo)': 'Person',
    'Básník / autor (autorské čtení)': 'Person',
    'Herec / recitátor / vypravěč': 'Person',
    'Přednášející / průvodce': 'Person',
    'Lektor (dílna, cvičení)': 'Person',
    'Kouzelník / žonglér / artista': 'Person',
    'DJ': 'Person',
    'Jiný jednotlivec': 'Person',
    'Sbor': 'MusicGroup',
    'Kapela': 'MusicGroup',
    'Orchestr / komorní soubor': 'MusicGroup',
    'Divadelní soubor': 'TheaterGroup',
    'Taneční soubor': 'DanceGroup',
    'Folklorní soubor': 'PerformingGroup',
    'Šermířská / historická skupina': 'PerformingGroup',
    'Škola / ZUŠ': 'PerformingGroup',
    'Jiná skupina': 'PerformingGroup',
    'Osoba': 'Person', 'Skupina': 'PerformingGroup',
}


ZVEREJNENO = {}  # id akce -> datum, kdy se akce poprvé objevila na webu (pamatuje se v data/adresy.json)


def s_pasmem(cas):
    """Uzávěrka rezervace '2026-12-31T18:00' jako čas s pásmem Prahy (letní / zimní čas)."""
    import datetime
    from zoneinfo import ZoneInfo
    d = datetime.datetime.fromisoformat(str(cas)[:16]).replace(tzinfo=ZoneInfo('Europe/Prague'))
    return d.isoformat(timespec='minutes')


def zverejneni(akce, dnes, manifest):
    """Datum zveřejnění každé akce: co už je v data/adresy.json, zůstává; nová akce dostane dnešní datum."""
    stare = {}
    if os.path.exists(manifest):
        stare = json.load(open(manifest, encoding='utf-8')).get('zverejneno', {})
    return {a['id']: stare.get(a['id']) or dnes for a in akce}


def udalost(a, cesta, tr):
    ld = {'@type': 'Event', 'name': a['title'], 'startDate': a['date'], 'endDate': a.get('end') or a['date'],
          'eventAttendanceMode': 'https://schema.org/OfflineEventAttendanceMode',
          'eventStatus': 'https://schema.org/EventScheduled',
          'location': {'@type': 'Place', '@id': SITE + '#zamek', 'name': 'Zámek Toužim', 'address': ADRESA},
          'organizer': {'@type': 'NGO', '@id': SITE + '#spolek', 'name': 'Živý zámek Toužim, z. s.', 'url': SITE},
          'url': url(cesta)}
    # Google (Search Console) chce u akce popis, obrázek, účinkujícího a vstupné; co nevíme, nevymýšlíme
    ld['description'] = a.get('short') or text(a.get('html'), 300) or '%s na zámku Toužim, %s.' % (a['title'], datum(a, 'cs'))
    # obrázek = plakát akce; bez plakátu fotky z akce, jinak náhledový obrázek webu
    obr = [SITE + a['poster'].lstrip('/')] if a.get('poster') else [SITE + f.lstrip('/') for f in (a.get('photos') or [])[:3]]
    ld['image'] = obr or [SITE + 'img/og.jpg']
    # účinkující z administrace (kulturní akce); bez nich spolek (brigády apod.)
    jm = [u for u in (a.get('ucinkujici') or []) if isinstance(u, dict) and u.get('jmeno')]
    ld['performer'] = [{'@type': DRUH_UCINKUJICIHO.get(u.get('typ'), 'Person'), 'name': u['jmeno']} for u in jm] or \
        {'@type': 'Organization', 'name': 'Živý zámek Toužim, z. s.', 'url': SITE}
    # vstupné: skutečné ceny jen u akcí s rezervací (omezený počet míst), jinak akce zdarma (Michal 4. 11. 2026;
    # dobrovolné vstupné se neuvádí)
    rez = a.get('rezervace') or {}
    ceny = [c for c in (rez.get('ceny') or [] if isinstance(rez, dict) else []) if isinstance(c, dict) and c.get('cena')]
    nab = [{'@type': 'Offer', 'name': c.get('druh') or 'Vstupné', 'price': c['cena'], 'priceCurrency': 'CZK',
            'url': url(cesta), 'availability': 'https://schema.org/InStock'} for c in ceny]
    # dobrovolné / doporučené vstupné: Google zná jen cenu, cena 0 = vstup bez povinné platby (dokumentace Googlu);
    # doporučenou částku dáváme jen do názvu, aby nevypadala jako povinné vstupné
    nazev = {'Dobrovolné': 'Vstupné dobrovolné'}.get(a.get('vstupne'))
    if a.get('vstupne') == 'Dobrovolné, doporučená částka' and a.get('vstupne_castka'):
        nazev = 'Vstupné dobrovolné, doporučeno %s Kč' % a['vstupne_castka']
    zdarma = {'@type': 'Offer', 'price': 0, 'priceCurrency': 'CZK', 'url': url(cesta),
              'availability': 'https://schema.org/InStock'}
    if nazev:
        zdarma = dict(zdarma, name=nazev)
    # platnost vstupného (Michal 7. 11. 2026): od zveřejnění akce na webu (nejpozději od jejího začátku, kvůli
    # archivu doplněnému zpětně), u akce s rezervací do uzávěrky rezervací
    platnost = {'validFrom': min(ZVEREJNENO.get(a['id']) or a['date'], a['date'])}
    if isinstance(rez, dict) and rez.get('uzaverka'):
        platnost['validThrough'] = s_pasmem(rez['uzaverka'])
    nab = [dict(o, **platnost) for o in nab]
    zdarma = dict(zdarma, **platnost)
    ld['offers'] = nab or zdarma
    ld['isAccessibleForFree'] = not nab
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


def drobecky(a, cesta, dnes):
    """Drobečková navigace pro Google: Program › (Archiv akcí ›) název akce, stejně jako nahoře na stránce akce."""
    kroky = [('Program', url('program/'))]
    if (a.get('end') or a['date']) < dnes:
        kroky.append(('Archiv akcí', url('program/') + '#archiv'))
    kroky.append((a['title'], url(cesta)))
    return {'@context': 'https://schema.org', '@type': 'BreadcrumbList',
            'itemListElement': [{'@type': 'ListItem', 'position': i + 1, 'name': n, 'item': u} for i, (n, u) in enumerate(kroky)]}


def detail_html(a, dnes):
    """Obsah detailu akce pro roboty bez JavaScriptu (skript na stránce ho nahradí stejným obsahem)."""
    probehla = (a.get('end') or a['date']) < dnes
    h = ('<nav class="ak-back drob" aria-label="Kde jste"><a href="program/">Program</a><span aria-hidden="true">›</span>'
         + ('<a href="program/#archiv">Archiv akcí</a><span aria-hidden="true">›</span>' if probehla else '')
         + '<span class="drob-t" aria-current="page">%s</span></nav>' % e(a['title']))
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


def vlastni_html(p):
    """Sekce vlastní stránky z administrace v HTML, stejně jako ji skládá skript v index.html (ten ji pak přestaví v jazyce návštěvníka)."""
    odkaz = lambda u: u if re.match(r'(https?://|#|mailto:|tel:)', u or '') else '#'
    h = '<div class="page-head">%s<h1>%s</h1>%s</div><div class="vs">' % (
        '<span class="eyebrow">%s</span>' % e(p['nadtitulek']) if p.get('nadtitulek') else '', e(p.get('nazev', '')),
        '<p>%s</p>' % e(p['perex']) if p.get('perex') else '')
    for b in p.get('bloky') or []:
        t = b.get('type')
        if t == 'nadpis':
            h += '<h3>%s</h3>' % e(b.get('text', ''))
        elif t == 'text':
            h += ''.join('<p>%s</p>' % r for r in (b.get('html') or '').split('\n'))
        elif t == 'fotka' and b.get('src'):
            h += '<figure><img src="%s" alt="%s" loading="lazy">%s</figure>' % (
                e(b['src']), e(b.get('popisek', '')), '<figcaption>%s</figcaption>' % e(b['popisek']) if b.get('popisek') else '')
        elif t == 'galerie' and b.get('fotky'):
            h += '<div class="gal">%s</div>' % ''.join('<img src="%s" alt="" loading="lazy">' % e(f) for f in b['fotky'])
        elif t == 'tlacitko' and b.get('text'):
            h += '<p><a class="btn" href="%s">%s</a></p>' % (e(odkaz(b.get('odkaz'))), e(b['text']))
    return '<section data-page="%s">\n<div class="wrap">%s</div></div>\n</section>\n' % (p['id'], h)


def stranka(zaklad, cesta, hlava, sekce=None, vlozit=None, pfx='', slozky=(), jazyk='cs'):
    s = ZNACKA.sub(lambda m: hlava, zaklad, count=1)
    if jazyk != 'cs':
        s = s.replace('<html lang="cs">', '<html lang="%s">' % jazyk, 1)
        s = s.replace('<meta property="og:locale" content="cs_CZ">', '<meta property="og:locale" content="%s">' % {'en': 'en_GB', 'de': 'de_DE'}[jazyk], 1)
    if pfx + cesta:
        s = s.replace('href="#obsah"', 'href="%s#obsah"' % (pfx + cesta), 1)
    if sekce and sekce != 'domu':
        s = s.replace('<section data-page="domu">', '<section data-page="domu" hidden>', 1)
        s = s.replace('<section data-page="%s" hidden>' % sekce, '<section data-page="%s">' % sekce, 1)
    for co, cim in (vlozit or {}).items():
        i = co.index('></') + 1
        s = s.replace(co, co[:i] + cim + co[i:], 1)
    vlastni = sekce or 'domu'
    s = SEKCE.sub(lambda m: m.group(0) if m.group(1) == vlastni else '<script type="text/x-sekce">\n%s</script>\n' % m.group(0), s)
    if pfx:  # odkazy na stránky webu vedou do kopie
        s = re.sub(r'href="(\./|(?:%s)/[^"]*)"' % '|'.join(map(re.escape, slozky)), lambda m: 'href="%s%s"' % (pfx, m.group(1)), s)
    # přepínač jazyků: skutečné adresy téže stránky (odkazy jsou vůči kořeni webu, <base>)
    for l in ('cs', 'en', 'de'):
        cil = ('' if l == 'cs' else l + '/') + cesta
        s = s.replace('href="?lang=%s" data-lang="%s"' % (l, l), 'href="%s" data-lang="%s"' % (cil or './', l), 1)
    return s


def sestav(zaklad, akce, web, l10n, dnes, pfx='', navic=(), noindex=False, jazyk='cs'):
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
    st = lambda cesta, hlava, sekce=None, vlozit=None: stranka(zaklad, cesta, hlava, sekce, vlozit, pfx, slozky, jazyk)
    hl = lambda cesta, meta, ld, ni=False, obr=None: hlavicka(cesta, meta, ld, ni or noindex, pfx, obr, jazyk)
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
        z = zaklad.replace('</main>\n', vlastni_html(p) + '</main>\n', 1)
        soubory[pfx + pid + '/index.html'] = stranka(z, pid + '/', hl(pid + '/', meta, ld), pid, None, pfx, slozky, jazyk)
        mapa.append(pid + '/')
    for sid, meta, ld in navic:
        soubory[pfx + sid + '/index.html'] = st(sid + '/', hl(sid + '/', meta, ld), sid)
        mapa.append(sid + '/')
    for a in akce:
        if '/' in a['id'] or a['id'].startswith('.'):
            continue
        c = 'akce/%s/' % a['id']
        vlozit = {'<div class="wrap" id="akceDetail"></div>': detail_html(a, dnes)}
        obr = (SITE + a['share'], 'Plakát: %s' % a['title'] if a.get('poster') else a['title']) if a.get('share') else None
        ld = [udalost(a, c, l10n), drobecky(a, c, dnes)]
        soubory[pfx + c + 'index.html'] = st(c, hl(c, akce_meta(a, l10n), ld, bool(a.get('skryta')), obr), 'akce', vlozit)
        if not a.get('skryta'):
            mapa.append(c)
    return soubory, mapa


def nacti():
    import datetime
    os.chdir(ROOT)
    akce_js, web_js = nacti_js('data/akce.js'), nacti_js('data/web.js')
    return akce_js.get('AKCE', []), web_js.get('WEB', {}), web_js.get('L10N', {}), datetime.date.today().isoformat()


def posledni_zmeny(soubory, mapa, dnes, manifest):
    """Datum poslední změny každé stránky v mapě webu (lastmod pro Google): otisk obsahu stránky se pamatuje
    v data/adresy.json; když se obsah změní, platí dnešní datum. Čísla verzí skriptů (?v=…) se nepočítají."""
    stare = {}
    if os.path.exists(manifest):
        stare = json.load(open(manifest, encoding='utf-8')).get('zmeny', {})
    nove = {}
    for c in mapa:
        obsah = re.sub(r'\?v=[0-9a-f]+', '', soubory[c + 'index.html'])
        otisk = hashlib.sha1(obsah.encode('utf-8')).hexdigest()[:12]
        o = stare.get(c)
        nove[c] = o if o and o[0] == otisk else [otisk, dnes]
    return nove


def zapis(soubory, manifest, zmeny=None, zverejneno=None):
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
        json.dump({'stranky': nove, 'zmeny': zmeny or {}, 'zverejneno': zverejneno or {}}, f, ensure_ascii=False, indent=0)
        f.write('\n')
    return len(nove), zmeneno


# staré adresy z původního webu, které Google ještě zkouší (Search Console, 404): cesta -> nová stránka
PRESMEROVANI = {
    'hradozamecka-noc/': 'akce/2026-08-22/',
    'odmeny/': 'podporte/#pomoc-suvenyry',
}


def presmerovani(cil):
    """GitHub Pages neumí serverové přesměrování: okamžité meta refresh + canonical Google bere jako trvalé."""
    cesta, _, kotva = cil.partition('#')
    u = e(url(cesta) + ('#' + kotva if kotva else ''))
    return ('<!doctype html><html lang="cs"><head><meta charset="utf-8"><title>Přesměrování</title>'
            '<link rel="canonical" href="%s"><meta http-equiv="refresh" content="0; url=%s">'
            '</head><body><p><a href="%s">Pokračujte sem</a></p></body></html>\n') % (u, u, u)


def main():
    akce, web, l10n, dnes = nacti()
    zaklad = OBAL.sub(r'\1', open('index.html', encoding='utf-8').read())  # index.html je i výstup, sekce zase rozbalit
    if not ZNACKA.search(zaklad):
        raise SystemExit('adresy: v index.html chybí <!--seo--> … <!--/seo-->')
    ZVEREJNENO.update(zverejneni(akce, dnes, 'data/adresy.json'))
    soubory, mapa = sestav(zaklad, akce, web, l10n, dnes)
    for l in ('en', 'de'):  # anglická a německá verze každé stránky na vlastní adrese
        s, m = sestav(zaklad, akce, web, l10n, dnes, pfx=l + '/', jazyk=l)
        soubory.update(s)
        mapa += [l + '/' + c for c in m]
    zmeny = posledni_zmeny(soubory, mapa, dnes, 'data/adresy.json')
    soubory['sitemap.xml'] = ('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                              + ''.join('<url><loc>%s</loc><lastmod>%s</lastmod></url>\n' % (e(url(c)), zmeny[c][1]) for c in mapa)
                              + '</urlset>\n')
    for stara, cil in PRESMEROVANI.items():
        soubory[stara + 'index.html'] = presmerovani(cil)
    soubory['robots.txt'] = 'User-agent: *\nDisallow: /admin/\nDisallow: /nahled/\n\nSitemap: %ssitemap.xml\n' % SITE

    n, zmeneno = zapis(soubory, 'data/adresy.json', zmeny, ZVEREJNENO)
    print('adresy: %d stránek, v mapě webu %d, změněno %d souborů' % (n + 1, len(mapa), zmeneno))

if __name__ == '__main__':
    main()
