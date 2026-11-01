"""Hlídání ostrého webu (spouští .github/workflows/hlidani.yml).

Zkontroluje, že web odpovídá, že platí certifikát HTTPS, že fungují přesměrování
a že žijí skripty rezervací, kontaktního formuláře a newsletteru. Vypíše seznam
problémů a skončí chybou, když nějaký najde. Bez parametrů nic nemění.
"""
import json, re, socket, ssl, sys, urllib.error, urllib.request
from datetime import datetime, timezone

WEB = 'https://www.zivyzamektouzim.cz/'
HOST = 'www.zivyzamektouzim.cz'
# stránka → text, který na ní musí být
STRANKY = {
    '': 'Živý zámek',
    'program/': 'Živý zámek',
    'admin/': 'Sveltia',
    'dotace/': 'Dotační kalendář',
    'data/akce.js': 'AKCE',
    'sitemap.xml': '<urlset',
}
CERT_DNY = 14          # varovat, když certifikát vyprší dřív
UA = {'User-Agent': 'zivyzamek-hlidani/1.0'}


def stahni(url, presmerovat=True):
    req = urllib.request.Request(url, headers=UA)
    opener = urllib.request.build_opener() if presmerovat else urllib.request.build_opener(BezPresmerovani)
    with opener.open(req, timeout=30) as r:
        return r.status, r.headers, r.read().decode('utf-8', 'replace')


class BezPresmerovani(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def main():
    chyby = []

    def zkus(popis, fce):
        try:
            fce()
        except Exception as e:  # noqa: BLE001 – každá chyba je nález
            chyby.append('%s: %s' % (popis, e))

    # 1) stránky
    for cesta, text in STRANKY.items():
        def s(cesta=cesta, text=text):
            kod, _, telo = stahni(WEB + cesta)
            if kod != 200 or text not in telo:
                raise RuntimeError('kód %s, chybí text „%s“' % (kod, text))
        zkus('Stránka ' + (WEB + cesta), s)

    # 2) všechny adresy ze sitemap
    def mapa():
        _, _, telo = stahni(WEB + 'sitemap.xml')
        spatne = []
        for url in sorted(set(re.findall(r'<loc>(.*?)</loc>', telo))):
            try:
                kod, _, _ = stahni(url)
                if kod != 200:
                    spatne.append('%s (%s)' % (url, kod))
            except urllib.error.HTTPError as e:
                spatne.append('%s (%s)' % (url, e.code))
        if spatne:
            raise RuntimeError('nefunguje %d adres: %s' % (len(spatne), ', '.join(spatne[:10])))
    zkus('Adresy ze sitemap.xml', mapa)

    # 3) certifikát
    def cert():
        ctx = ssl.create_default_context()
        with socket.create_connection((HOST, 443), timeout=30) as sock:
            with ctx.wrap_socket(sock, server_hostname=HOST) as s:
                konec = datetime.strptime(s.getpeercert()['notAfter'], '%b %d %H:%M:%S %Y %Z').replace(tzinfo=timezone.utc)
        dny = (konec - datetime.now(timezone.utc)).days
        if dny < CERT_DNY:
            raise RuntimeError('vyprší za %d dní (%s)' % (dny, konec.date()))
    zkus('Certifikát HTTPS', cert)

    # 4) přesměrování na https://www.
    for zdroj in ('http://zivyzamektouzim.cz/', 'https://zivyzamektouzim.cz/', 'http://www.zivyzamektouzim.cz/'):
        def p(zdroj=zdroj):
            try:
                kod, hl, _ = stahni(zdroj, presmerovat=False)
                cil = hl.get('Location', '')
            except urllib.error.HTTPError as e:
                kod, cil = e.code, e.headers.get('Location', '')
            if kod not in (301, 302, 308) or not cil.startswith(WEB):
                raise RuntimeError('kód %s, cíl „%s“' % (kod, cil))
        zkus('Přesměrování ' + zdroj, p)

    # 5) skripty Google (adresy bere z index.html)
    _, _, index = stahni(WEB)
    skripty = re.findall(r'https://script\.google\.com/macros/s/[\w-]+/exec', index)
    if len(set(skripty)) < 3:
        chyby.append('Skripty Google: v index.html jsou %d, čekají se 3 (rezervace, formulář, newsletter)' % len(set(skripty)))
    rez = re.search(r"REZ_API='(https://script\.google\.com/macros/s/[\w-]+/exec)'", index)

    def rezervace():
        _, _, telo = stahni(rez.group(1) + '?akce=hlidani')
        json.loads(telo)  # skript rezervací odpovídá JSONem
    if rez:
        zkus('Skript rezervací', rezervace)
    for url in sorted(set(skripty) - {rez.group(1) if rez else ''}):
        def zije(url=url):
            try:
                stahni(url)
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    raise RuntimeError('404, nasazení skriptu neexistuje')
        zkus('Skript ' + url[:70] + '…', zije)

    if chyby:
        print('NALEZENÉ PROBLÉMY:')
        for c in chyby:
            print('- ' + c)
        with open('hlidani-vysledek.md', 'w', encoding='utf-8') as f:
            f.write('Automatické hlídání našlo na %s tyto problémy:\n\n' % WEB)
            f.write('\n'.join('- ' + c for c in chyby))
            f.write('\n\nZkontrolováno %s UTC. Až budou problémy pryč, tohle hlášení se samo zavře.\n'
                    % datetime.now(timezone.utc).strftime('%d. %m. %Y %H:%M'))
        sys.exit(1)
    print('Vše v pořádku.')


if __name__ == '__main__':
    main()
