/**
 * Rezervace akcí na webu Živý zámek Toužim (Google Apps Script).
 *
 * Skript patří k Google tabulce „Rezervace“ ve spolkovém Google účtu (Rozšíření → Apps Script).
 * Web (index.html, REZ_API) se ho ptá na volná místa a posílá mu rezervace.
 * Akce, počty míst, ceny a uzávěrky čte z webu (data/rezervace.json, vzniká z administrace).
 *
 * Jak to běží:
 *  - doGet:  počet volných míst u akce, u akce s více termíny (skupinami) u každého termínu zvlášť
 *  - doPost: nová rezervace → řádek na listu akce + e-mail s údaji k platbě
 *            (každá akce má vlastní list pojmenovaný podle akce a data, skript ho založí sám a nic z něj nemaže)
 *  - hlidej: každých 5 minut (časový spouštěč, založí ho funkce nastav)
 *      - stáhne platby z Fio (když je v Nastavení projektu → Vlastnosti skriptu FIO_TOKEN) a spáruje je podle VS
 *      - u řádků se zaškrtnutým „Zaplaceno“ pošle potvrzení
 *      - nezaplacené rezervace po lhůtě označí jako propadlé a pošle o tom e-mail
 */

// ---- Nastavení ----
var WEB = 'https://zametouzim.github.io/zivyzamek-web/';  // adresa webu (po přechodu na doménu stačí změnit tady)
var ODESILATEL = 'rezervace@zivyzamektouzim.cz';         // musí být v Gmailu tohoto účtu v „Odesílat poštu jako“, jinak se pošle z Gmailu a přijde upozornění
var ODPOVEDI = 'info@zivyzamektouzim.cz';                  // kam půjdou odpovědi návštěvníků
var UPOZORNENI = 'info@zivyzamektouzim.cz';                // kam skript hlásí problémy (Fio, platba po lhůtě)
var NOVE = 'rezervace@zivyzamektouzim.cz';                 // kam přijde zpráva o každé nové rezervaci (prázdné = nikam)
var LHUTA_HODIN = 24;                                     // jak dlouho držet nezaplacenou rezervaci
var UCET = '2301034510/2010';
var IBAN = 'CZ7920100000002301034510';
var ZONA = 'Europe/Prague';

var SLOUPCE = ['VS', 'Vytvořeno', 'Akce', 'Název akce', 'Termín', 'Jméno', 'E-mail', 'Telefon', 'Vstupenky', 'Osob', 'Kč',
               'Poznámka', 'Jazyk', 'Stav', 'Zaplaceno', 'Platba', 'Zaplatit do'];
var C = {};
SLOUPCE.forEach(function (n, i) { C[n] = i; });
var CEKA = 'čeká na platbu', POTVRZENO = 'potvrzeno', PROPADLO = 'propadlo', POZDE = 'zaplaceno po lhůtě';
var DRZI_MISTO = [CEKA, POTVRZENO, POZDE];

// ---- Web ----

function doGet(e) {
  var akce = nactiAkce(), id = e && e.parameter && e.parameter.akce;
  if (id) {
    if (!akce[id]) return json({ ok: false, chyba: 'akce' });
    return json({ ok: true, terminy: volno(id, akce[id]) });
  }
  var out = {};
  Object.keys(akce).forEach(function (k) { out[k] = volno(k, akce[k]); });
  return json({ ok: true, akce: out });
}

function doPost(e) {
  var p = (e && e.parameter) || {};
  if (p.web) return json({ ok: true, vs: '0', castka: 0 });  // past na roboty
  var akce = nactiAkce(), a = akce[p.akce];
  if (!a) return json({ ok: false, chyba: 'akce' });
  var jmeno = String(p.jmeno || '').trim().slice(0, 100), email = String(p.email || '').trim().slice(0, 100),
      telefon = String(p.telefon || '').trim().slice(0, 30), poznamka = String(p.poznamka || '').trim().slice(0, 1000),
      lang = ['en', 'de'].indexOf(p.lang) >= 0 ? p.lang : 'cs';
  if (!jmeno || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || telefon.replace(/\D/g, '').length < 9)
    return json({ ok: false, chyba: 'udaje' });
  var osob = 0, castka = 0, listky = [];
  a.ceny.forEach(function (c, i) {
    var n = Math.max(0, Math.min(1000, parseInt(p['pocet_' + i], 10) || 0));
    if (!n) return;
    osob += n; castka += n * c.cena; listky.push(n + '× ' + c.druh + (c.cena ? ' (' + c.cena + ' Kč)' : ''));
  });
  if (!osob) return json({ ok: false, chyba: 'udaje' });
  var termin = String(p.termin || '');
  if (!a.terminy.some(function (t) { return t.cas === termin; })) return json({ ok: false, chyba: 'termin' });

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (casAkce(a.uzaverka) < new Date()) return json({ ok: false, chyba: 'uzavreno' });
    var v = volno(p.akce, a);
    if (osob > v[termin]) return json({ ok: false, chyba: 'plno', terminy: v });
    var vs = noveVs(), ted = new Date(), splatnost = new Date(ted.getTime() + LHUTA_HODIN * 3600e3);
    var radek = [];
    radek[C['VS']] = vs; radek[C['Vytvořeno']] = ted; radek[C['Akce']] = p.akce; radek[C['Název akce']] = a.title;
    radek[C['Termín']] = "'" + termin;
    radek[C['Jméno']] = jmeno; radek[C['E-mail']] = email; radek[C['Telefon']] = "'" + telefon; radek[C['Vstupenky']] = listky.join(', ');
    radek[C['Osob']] = osob; radek[C['Kč']] = castka; radek[C['Poznámka']] = poznamka; radek[C['Jazyk']] = lang;
    radek[C['Stav']] = castka ? CEKA : POTVRZENO; radek[C['Zaplaceno']] = !castka; radek[C['Platba']] = castka ? '' : 'zdarma';
    radek[C['Zaplatit do']] = castka ? splatnost : '';
    var list = tabulka(p.akce, a);
    list.appendRow(radek);
    list.getRange(list.getLastRow(), C['Zaplaceno'] + 1).insertCheckboxes();
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  var r = { vs: vs, castka: castka, osob: osob, listky: listky.join(', '), splatnost: splatnost, lang: lang, a: a, akce: p.akce, termin: termin };
  if (castka) posli(email, text('platbaPredmet', r), text('platba', r));
  else posli(email, text('potvrzeniPredmet', r), text('potvrzeni', r));
  if (NOVE) {
    try {
      var datum = a.date ? a.date.split('-').map(Number) : null;
      GmailApp.sendEmail(NOVE, 'Nová rezervace ' + vs + ': ' + a.title + (termin ? ' ' + termin : '') + ', ' + osob + ' os.',
        'Akce: ' + a.title + '\nKdy: ' + (datum ? datum[2] + '. ' + datum[1] + '. ' + datum[0] : '') + (termin ? ', termín ' + termin : a.when ? ', ' + a.when : '') +
        '\nJméno: ' + jmeno + '\nE-mail: ' + email + '\nTelefon: ' + telefon + '\nVstupenky: ' + listky.join(', ') + '\nOsob: ' + osob +
        '\nCena: ' + castka + ' Kč' + (castka ? ', zaplatit do ' + Utilities.formatDate(splatnost, ZONA, 'd. M. yyyy H:mm') : ' (zdarma, potvrzeno)') +
        '\nVS: ' + vs + (poznamka ? '\nPoznámka: ' + poznamka : '') + '\n\nTabulka: ' + SpreadsheetApp.getActive().getUrl(),
        zpravaNove(email));
    } catch (err) { console.error(err); }  // rezervace platí i bez téhle zprávy
  }
  return json({ ok: true, vs: String(vs), castka: castka, splatnost: castka ? splatnost.toISOString() : '' });
}

// ---- Hlídání plateb (časový spouštěč) ----

function hlidej() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    var akce = nactiAkce(), ted = new Date(), platby = fio();
    listyRezervaci().forEach(function (list) { hlidejList(list, akce, platby, ted); });
  } finally {
    lock.releaseLock();
  }
}

function hlidejList(list, akce, platby, ted) {
  var data = list.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var row = data[i], vs = String(row[C['VS']]), stav = row[C['Stav']], kc = Number(row[C['Kč']]), zmena = null;
    var p = platby[vs], r = radekData(row, akce);
    // nová platba (nebo doplatek) k rezervaci, která čeká nebo propadla; platby se stejným VS se sčítají
    if (p && p.popis !== row[C['Platba']] && (stav === CEKA || stav === PROPADLO)) {
      list.getRange(i + 1, C['Platba'] + 1).setValue(p.popis);
      row[C['Platba']] = p.popis;
      r.zaplaceno = p.castka;
      if (p.castka >= kc) {
        if (stav === CEKA) { list.getRange(i + 1, C['Zaplaceno'] + 1).setValue(true); row[C['Zaplaceno']] = true; }
        else zmena = POZDE;
      } else if (stav === CEKA) {
        posli(row[C['E-mail']], text('nedoplatekPredmet', r), text('nedoplatek', r));
      } else {
        upozorni('Částečná platba po propadnutí', 'K propadlé rezervaci ' + vs + ' (' + row[C['Jméno']] + ', ' + row[C['Název akce']] + ') přišlo ' +
          p.castka + ' z ' + kc + ' Kč. Částku prosím vraťte, nebo se s návštěvníkem domluvte.');
      }
    }
    if (zmena === POZDE) {
      list.getRange(i + 1, C['Stav'] + 1).setValue(POZDE);
      upozorni('Platba po lhůtě', 'Rezervace ' + vs + ' (' + row[C['Jméno']] + ', ' + row[C['Název akce']] + ', ' + row[C['Osob']] +
        ' os.) byla zaplacena až po propadnutí. Místa jí zatím držím. Když je místo, zaškrtněte v tabulce „Zaplaceno“ a potvrzení odejde samo. ' +
        'Když místo není, peníze vraťte a změňte stav na „' + PROPADLO + '“.');
    } else if (row[C['Zaplaceno']] === true && (stav === CEKA || stav === POZDE)) {
      list.getRange(i + 1, C['Stav'] + 1).setValue(POTVRZENO);
      posli(row[C['E-mail']], text('potvrzeniPredmet', r), text('potvrzeni', r));
    } else if (stav === CEKA && row[C['Zaplatit do']] instanceof Date && row[C['Zaplatit do']] < ted) {
      list.getRange(i + 1, C['Stav'] + 1).setValue(PROPADLO);
      if (p && p.castka > 0) {
        r.zaplaceno = p.castka;
        posli(row[C['E-mail']], text('propadloPredmet', r), text('propadloCast', r));
        upozorni('Rezervace propadla s částečnou platbou', 'Rezervace ' + vs + ' (' + row[C['Jméno']] + ', ' + row[C['Název akce']] + ') propadla, přišlo jen ' +
          p.castka + ' z ' + kc + ' Kč. Návštěvníkovi jsme napsali, že se mu ozvete kvůli vrácení. Částku prosím vraťte.');
      } else {
        posli(row[C['E-mail']], text('propadloPredmet', r), text('propadlo', r));
      }
    }
  }
}

/** Příchozí platby za posledních 10 dní z Fio API: {VS: {castka, popis}}. Bez tokenu nic. */
function fio() {
  var token = PropertiesService.getScriptProperties().getProperty('FIO_TOKEN');
  if (!token) return {};
  var od = Utilities.formatDate(new Date(Date.now() - 10 * 864e5), ZONA, 'yyyy-MM-dd'),
      do_ = Utilities.formatDate(new Date(), ZONA, 'yyyy-MM-dd');
  var res = UrlFetchApp.fetch('https://fioapi.fio.cz/v1/rest/periods/' + token + '/' + od + '/' + do_ + '/transactions.json',
                              { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    upozorni('Fio: platby se nepodařilo stáhnout',
      'Fio API vrátilo chybu ' + res.getResponseCode() + '. Nejčastěji vypršel token (platí nejdéle 180 dní a prodlužuje se přihlášením do bankovnictví). ' +
      'Nový token se zakládá v internetovém bankovnictví Fio v Nastavení → API a vkládá do skriptu: Nastavení projektu → Vlastnosti skriptu → FIO_TOKEN. ' +
      'Do té doby zaškrtávejte zaplacené rezervace v tabulce ručně.', true);
    return {};
  }
  var out = {}, list = ((JSON.parse(res.getContentText()).accountStatement || {}).transactionList || {}).transaction || [];
  list.forEach(function (t) {
    var castka = t.column1 && t.column1.value, vs = t.column5 && t.column5.value;
    if (!vs || !(castka > 0)) return;
    vs = String(vs).replace(/^0+/, '');
    var kdo = (t.column10 && t.column10.value) || (t.column7 && t.column7.value) || '';
    var o = out[vs] || { castka: 0, popis: '' };
    o.castka += castka;
    o.popis = (o.popis ? o.popis + '; ' : '') + 'Fio ' + (t.column0 && t.column0.value || '').slice(0, 10) + ' ' + castka + ' Kč' + (kdo ? ' ' + kdo : '');
    out[vs] = o;
  });
  return out;
}

/** Spustit jednou ručně po vložení skriptu: založí spouštěč hlidej (každých 5 minut) a vyžádá oprávnění. */
function nastav() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'hlidej') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('hlidej').timeBased().everyMinutes(5).create();
  GmailApp.getAliases();  // ať se hned vyžádá oprávnění k Gmailu
  Logger.log('Hotovo. Tabulka: ' + SpreadsheetApp.getActive().getUrl());
}

// ---- Pomocné ----

/** List akce v tabulce. Pozná ho podle ID listu (přejmenovat ho jde), když chybí, založí nový „Název akce d. M. yyyy“ (s jenNajit vrátí null). */
function tabulka(id, a, jenNajit) {
  var ss = SpreadsheetApp.getActive(), props = PropertiesService.getScriptProperties(), k = 'LIST_' + id;
  var sid = props.getProperty(k), list = null;
  if (sid) ss.getSheets().forEach(function (x) { if (String(x.getSheetId()) === sid) list = x; });
  if (!list && !jenNajit) {
    var d = String(a.date || '').split('-').map(Number);
    var nazev = (a.title + (d.length === 3 ? ' ' + d[2] + '. ' + d[1] + '. ' + d[0] : '')).replace(/[\[\]*?:\/\\']/g, ' ').slice(0, 90);
    var n = nazev, i = 2;
    while (ss.getSheetByName(n)) n = nazev + ' (' + i++ + ')';
    list = ss.insertSheet(n, 0);
    props.setProperty(k, String(list.getSheetId()));
    list.appendRow(SLOUPCE);
    list.setFrozenRows(1);
    list.getRange(1, 1, 1, SLOUPCE.length).setFontWeight('bold');
    list.getRange('B:B').setNumberFormat('d. M. yyyy H:mm');
    list.getRange('P:P').setNumberFormat('d. M. yyyy H:mm');
  }
  return list;
}

function nactiAkce() {
  var cache = CacheService.getScriptCache(), c = cache.get('akce');
  if (c) return JSON.parse(c);
  var res = UrlFetchApp.fetch(WEB + 'data/rezervace.json?t=' + Date.now(), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return {};
  var t = res.getContentText();
  cache.put('akce', t, 300);
  return JSON.parse(t);
}

/** Všechny listy s rezervacemi (první buňka „VS“). */
function listyRezervaci() {
  return SpreadsheetApp.getActive().getSheets().filter(function (x) { return x.getRange(1, 1).getValue() === 'VS'; });
}

/** Volná místa po termínech: {"19:00": 5, "20:00": 0}; akce bez termínů má jeden termín "". */
function volno(id, a) {
  var list = tabulka(id, a, true), data = list ? list.getDataRange().getValues() : [], out = {};
  a.terminy.forEach(function (t) { out[t.cas] = t.kapacita; });
  for (var i = 1; i < data.length; i++) {
    var t = String(data[i][C['Termín']]);
    if (data[i][C['Akce']] === id && t in out && DRZI_MISTO.indexOf(data[i][C['Stav']]) >= 0) out[t] -= Number(data[i][C['Osob']]) || 0;
  }
  Object.keys(out).forEach(function (t) { out[t] = Math.max(0, out[t]); });
  return out;
}

/** Variabilní symbol: rok, měsíc, den a pořadí rezervace v ten den, např. 2026102605 = pátá rezervace 26. 10. 2026 (max. 99 za den). */
function noveVs() {
  var props = PropertiesService.getScriptProperties(), den = Utilities.formatDate(new Date(), ZONA, 'yyyyMMdd');
  var ulozeno = String(props.getProperty('VS_DEN') || '').split(':');
  var n = ulozeno[0] === den ? Number(ulozeno[1]) + 1 : 1;
  if (n > 99) throw new Error('Víc než 99 rezervací za den, variabilní symbol by měl víc než 10 číslic.');
  props.setProperty('VS_DEN', den + ':' + n);
  return Number(den) * 100 + n;
}

function casAkce(s) {
  return Utilities.parseDate(String(s).slice(0, 16), ZONA, "yyyy-MM-dd'T'HH:mm");
}

function radekData(row, akce) {
  var id = row[C['Akce']], a = akce[id] || { title: row[C['Název akce']], date: '', when: '' };
  return { vs: row[C['VS']], castka: row[C['Kč']], osob: row[C['Osob']], listky: row[C['Vstupenky']], splatnost: row[C['Zaplatit do']],
           lang: row[C['Jazyk']] || 'cs', a: a, akce: id, termin: String(row[C['Termín']] || '') };
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function posli(komu, predmet, telo) {
  var opt = { name: 'Živý zámek Toužim', replyTo: ODPOVEDI };
  if (ODESILATEL) {
    var aliasy = GmailApp.getAliases();
    if (aliasy.indexOf(ODESILATEL) >= 0) { opt.from = ODESILATEL; opt.replyTo = ODESILATEL; }
    else upozorni('odesílatel není nastavený', 'E-mail návštěvníkovi odešel ze spolkového Gmailu, ne z ' + ODESILATEL +
                  '.\nV Gmailu tohoto účtu chybí ' + ODESILATEL + ' v Nastavení → Účty → Odesílat poštu jako (nebo není potvrzená).\nAdresy, ze kterých skript smí posílat: ' +
                  (aliasy.join(', ') || 'žádné'), true);
  }
  // odkaz na platbu (…#platba/VS/částka) se v HTML verzi nahradí obrázkem QR kódu přímo v e-mailu
  var html = esc(telo), m = telo.match(/^(.*): (\S*#platba\/(\d+)\/(\d+))$/m);
  if (m) {
    var q = qrSLogem(spd(m[3], Number(m[4])), 10);
    opt.inlineImages = { qr: Utilities.newBlob(Utilities.base64Decode(q.src.split(',')[1]), 'image/gif', 'qr-platba.gif') };
    html = html.replace(esc(m[0]), esc(m[1]) + ':<br><img src="cid:qr" alt="QR" width="260" height="260">');
  }
  opt.htmlBody = '<div style="font:15px/1.5 Arial,sans-serif">' + html.replace(/\n/g, '<br>') + '</div>';
  GmailApp.sendEmail(komu, predmet, telo, opt);
}

/** Zpráva o nové rezervaci jde přes Seznam (from = alias), jinak ji Gmail nechá u sebe, protože adresu bere jako svoji. */
function zpravaNove(email) {
  var opt = { name: 'Rezervace na webu', replyTo: email };
  if (NOVE === ODESILATEL && GmailApp.getAliases().indexOf(ODESILATEL) >= 0) opt.from = ODESILATEL;
  return opt;
}

/** Text pro QR Platbu (formát SPD České bankovní asociace), stejný jako na webu. */
function spd(vs, kc) {
  return 'SPD*1.0*ACC:' + IBAN + '*AM:' + kc.toFixed(2) + '*CC:CZK*X-VS:' + vs + '*MSG:REZERVACE ' + vs;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** E-mail spolku; s jednouDenne se stejné upozornění pošle nejvýš jednou za den. */
function upozorni(predmet, telo, jednouDenne) {
  if (jednouDenne) {
    var props = PropertiesService.getScriptProperties(), dnes = Utilities.formatDate(new Date(), ZONA, 'yyyy-MM-dd'), k = 'UP_' + predmet;
    if (props.getProperty(k) === dnes) return;
    props.setProperty(k, dnes);
  }
  GmailApp.sendEmail(UPOZORNENI, 'Rezervace: ' + predmet, telo + '\n\nTabulka: ' + SpreadsheetApp.getActive().getUrl(), { name: 'Rezervace na webu' });
}

// ---- Texty e-mailů (česky, anglicky, německy) ----

var DRUHY = {
  en: { 'Vstup zdarma': 'Free admission', 'Jednotné vstupné': 'Standard admission', 'Dospělí': 'Adults', 'Děti': 'Children', ' Kč)': ' CZK)' },
  de: { 'Vstup zdarma': 'Freier Eintritt', 'Jednotné vstupné': 'Einheitlicher Eintritt', 'Dospělí': 'Erwachsene', 'Děti': 'Kinder', ' Kč)': ' CZK)' }
};

function text(klic, r) {
  var l = r.lang || 'cs', a = r.a || {};
  var datum = a.date ? a.date.split('-').map(Number) : null;
  var kdy = datum ? (l === 'cs' ? datum[2] + '. ' + datum[1] + '. ' + datum[0] : l === 'de' ? datum[2] + '.' + datum[1] + '.' + datum[0] : datum[2] + '/' + datum[1] + '/' + datum[0]) : '';
  var nazev = a['title_' + l] || a.title, cas = a['when_' + l] || a.when;
  // u akce s termíny jen čas termínu, obecný čas akce („prohlídky v 19, 20 a 21 h“) by mátl
  var kdyCele = [kdy, r.termin ? '' : cas, r.termin ? { cs: 'termín ', en: 'time slot ', de: 'Termin ' }[l] + r.termin : ''].filter(String).join(', ');
  var do_ = r.splatnost instanceof Date ? Utilities.formatDate(r.splatnost, ZONA, l === 'en' ? 'd/M/yyyy H:mm' : 'd. M. yyyy H:mm') : '';
  var chybi = r.castka - (r.zaplaceno || 0);
  var odkaz = WEB + (l === 'cs' ? '' : '?lang=' + l) + '#platba/' + r.vs + '/' + r.castka;
  var odkazDoplatek = WEB + (l === 'cs' ? '' : '?lang=' + l) + '#platba/' + r.vs + '/' + chybi;
  var listky = String(r.listky || '');
  if (l !== 'cs') Object.keys(DRUHY[l]).forEach(function (k) { listky = listky.split(k).join(DRUHY[l][k]); });
  // řádek se vstupenkami; u akce zdarma jen počet osob
  var vst = r.castka ? { cs: 'Vstupenky: ', en: 'Tickets: ', de: 'Eintrittskarten: ' }[l] + listky
                     : { cs: 'Počet osob: ', en: 'Number of people: ', de: 'Anzahl der Personen: ' }[l] + r.osob;
  var info = {
    cs: 'Akce: ' + nazev + '\nKdy: ' + kdyCele + '\n' + vst + '\nČíslo rezervace: ' + r.vs,
    en: 'Event: ' + nazev + '\nWhen: ' + kdyCele + '\n' + vst + '\nBooking number: ' + r.vs,
    de: 'Veranstaltung: ' + nazev + '\nWann: ' + kdyCele + '\n' + vst + '\nReservierungsnummer: ' + r.vs
  }[l];
  var podpis = { cs: '\n\nŽivý zámek Toužim z. s.\n' + WEB, en: '\n\nŽivý zámek Toužim z. s.\n' + WEB + '?lang=en', de: '\n\nŽivý zámek Toužim z. s.\n' + WEB + '?lang=de' }[l];
  var T = {
    cs: {
      platbaPredmet: 'Rezervace ' + r.vs + ': zbývá zaplatit',
      platba: 'Dobrý den,\n\nděkujeme za rezervaci.\n\n' + info + '\n\nRezervace platí až po zaplacení. Prosíme o platbu do ' + do_ + ', jinak rezervace propadne.\n\n' +
              'Účet: ' + UCET + '\nČástka: ' + r.castka + ' Kč\nVariabilní symbol: ' + r.vs + '\n\nQR kód pro platbu: ' + odkaz +
              '\n\nAž platbu spárujeme, pošleme vám potvrzení. Zaplacené vstupné se nevrací.' + podpis,
      potvrzeniPredmet: 'Rezervace ' + r.vs + ' potvrzena',
      potvrzeni: 'Dobrý den,\n\nvaše rezervace je potvrzená.\n\n' + info + '\n\nTěšíme se na vás.' + podpis,
      nedoplatekPredmet: 'Rezervace ' + r.vs + ': chybí doplatit ' + chybi + ' Kč',
      nedoplatek: 'Dobrý den,\n\nk vaší rezervaci přišlo ' + r.zaplaceno + ' Kč, cena je ' + r.castka + ' Kč. Chybí doplatit ' + chybi + ' Kč.\n\n' + info +
                  '\n\nDoplaťte prosím do ' + do_ + ' se stejným variabilním symbolem, jinak rezervace propadne.\n\n' +
                  'Účet: ' + UCET + '\nČástka: ' + chybi + ' Kč\nVariabilní symbol: ' + r.vs + '\n\nQR kód pro doplatek: ' + odkazDoplatek + podpis,
      propadloCast: 'Dobrý den,\n\nvaše rezervace propadla, protože jsme do ' + do_ + ' neobdrželi celou částku. Přišlo ' + r.zaplaceno + ' z ' + r.castka +
                    ' Kč. Místa jsme uvolnili.\n\n' + info + '\n\nKvůli vrácení zaplacené částky se vám ozveme.' + podpis,
      propadloPredmet: 'Rezervace ' + r.vs + ' propadla',
      propadlo: 'Dobrý den,\n\nvaše rezervace propadla, protože jsme do ' + do_ + ' neobdrželi platbu. Místa jsme uvolnili.\n\n' + info +
                '\n\nPokud jste už zaplatili, ozvěte se nám prosím odpovědí na tento e-mail.' + podpis
    },
    en: {
      platbaPredmet: 'Booking ' + r.vs + ': payment due',
      platba: 'Hello,\n\nthank you for your booking.\n\n' + info + '\n\nThe booking is valid once paid. Please pay by ' + do_ + ', otherwise the booking expires.\n\n' +
              'Account: ' + UCET + ' (IBAN ' + IBAN + ')\nAmount: ' + r.castka + ' CZK\nVariable symbol (reference): ' + r.vs + '\n\nQR code for payment: ' + odkaz +
              '\n\nOnce we match your payment, we will send you a confirmation. Admission fees are non-refundable.' + podpis,
      potvrzeniPredmet: 'Booking ' + r.vs + ' confirmed',
      potvrzeni: 'Hello,\n\nyour booking is confirmed.\n\n' + info + '\n\nWe look forward to seeing you.' + podpis,
      nedoplatekPredmet: 'Booking ' + r.vs + ': ' + chybi + ' CZK still due',
      nedoplatek: 'Hello,\n\nwe have received ' + r.zaplaceno + ' CZK for your booking, the price is ' + r.castka + ' CZK. ' + chybi + ' CZK is still due.\n\n' + info +
                  '\n\nPlease pay the rest by ' + do_ + ' with the same variable symbol, otherwise the booking expires.\n\n' +
                  'Account: ' + UCET + ' (IBAN ' + IBAN + ')\nAmount: ' + chybi + ' CZK\nVariable symbol (reference): ' + r.vs + '\n\nQR code for the remaining payment: ' + odkazDoplatek + podpis,
      propadloCast: 'Hello,\n\nyour booking has expired because we did not receive the full amount by ' + do_ + '. We received ' + r.zaplaceno + ' of ' + r.castka +
                    ' CZK. The places have been released.\n\n' + info + '\n\nWe will contact you about refunding the amount you paid.' + podpis,
      propadloPredmet: 'Booking ' + r.vs + ' expired',
      propadlo: 'Hello,\n\nyour booking has expired because we did not receive payment by ' + do_ + '. The places have been released.\n\n' + info +
                '\n\nIf you have already paid, please reply to this e-mail.' + podpis
    },
    de: {
      platbaPredmet: 'Reservierung ' + r.vs + ': Zahlung ausstehend',
      platba: 'Guten Tag,\n\nvielen Dank für Ihre Reservierung.\n\n' + info + '\n\nDie Reservierung gilt erst nach der Zahlung. Bitte zahlen Sie bis ' + do_ + ', sonst verfällt die Reservierung.\n\n' +
              'Konto: ' + UCET + ' (IBAN ' + IBAN + ')\nBetrag: ' + r.castka + ' CZK\nVariabler Symbol (Referenz): ' + r.vs + '\n\nQR-Code zur Zahlung: ' + odkaz +
              '\n\nSobald wir Ihre Zahlung zugeordnet haben, schicken wir Ihnen eine Bestätigung. Bezahlter Eintritt wird nicht erstattet.' + podpis,
      potvrzeniPredmet: 'Reservierung ' + r.vs + ' bestätigt',
      potvrzeni: 'Guten Tag,\n\nIhre Reservierung ist bestätigt.\n\n' + info + '\n\nWir freuen uns auf Sie.' + podpis,
      nedoplatekPredmet: 'Reservierung ' + r.vs + ': noch ' + chybi + ' CZK offen',
      nedoplatek: 'Guten Tag,\n\nfür Ihre Reservierung sind ' + r.zaplaceno + ' CZK eingegangen, der Preis beträgt ' + r.castka + ' CZK. Es fehlen noch ' + chybi + ' CZK.\n\n' + info +
                  '\n\nBitte zahlen Sie den Rest bis ' + do_ + ' mit demselben variablen Symbol, sonst verfällt die Reservierung.\n\n' +
                  'Konto: ' + UCET + ' (IBAN ' + IBAN + ')\nBetrag: ' + chybi + ' CZK\nVariabler Symbol (Referenz): ' + r.vs + '\n\nQR-Code für die Restzahlung: ' + odkazDoplatek + podpis,
      propadloCast: 'Guten Tag,\n\nIhre Reservierung ist verfallen, weil bis ' + do_ + ' nicht der volle Betrag eingegangen ist. Eingegangen sind ' + r.zaplaceno + ' von ' + r.castka +
                    ' CZK. Die Plätze wurden freigegeben.\n\n' + info + '\n\nWegen der Rückerstattung des bezahlten Betrags melden wir uns bei Ihnen.' + podpis,
      propadloPredmet: 'Reservierung ' + r.vs + ' verfallen',
      propadlo: 'Guten Tag,\n\nIhre Reservierung ist verfallen, weil bis ' + do_ + ' keine Zahlung eingegangen ist. Die Plätze wurden freigegeben.\n\n' + info +
                '\n\nFalls Sie bereits bezahlt haben, antworten Sie bitte auf diese E-Mail.' + podpis
    }
  };
  return T[l][klic];
}

// ---- QR kód s logem (stejné jako js/qr-logo.js na webu) ----

var QR_LOGO = { w: 200, h: 94, hex: '30000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000003e0000000000000000000000000000000000000000000000003fe00000000000000000000000000000000000001ffc000000307f00000000000000000000000000000000003fff860000003407f8000000000000000000000000000000fffe000300000035003f8000000000000000000000000003fffc00004d800000350001fc000078000000000000000007fff00000007f8000003500001fe0005c000000000000001fffc000000003fec0000035000000ff005c0000000000007fff800000000000126000003700f80007f05c0000000000fffe000000000000000d3000003700dc00007fdc00000003fff80000000000000000091800003300dc000003dc000007fff0000000000000000000068800003200dc0000005fc0001fc000000000000000000000050c00003200dc0000005cfc00180000000000000000000000010600003200dc0000005c0fc0100000000000000000000000008300003000dc0000005c00fc3200000000000000000000000081800030005c0000005c000ff280000000000000000000000000800030001c0000005c0000e400000000000000000000000000c00030001c0000005c00002700000000000000000000000000600030001c0000001c000067000000000000000000000000003000b000000000000c000066000000000000000000000000001000fff8000000000000004e00000000000000000000000000180033ffff000000000000ce000000000000000000000000000c0030003ffff000000000ce00000000000000000000000000060030000007fffe0000008400000000000000000000000000038030000000007fffc001880000000000000000000000000000c03000000000000ffffd88000000000000000000000000007fe03000000000000001ff00000000000000000ffffffffffffff0300000000000000041000003fffffffffffffffff800000300300000000000000043ffffffffffff0000000000000000030030e000000000000041e000000000000000000000000000030031e03c000000000040400000000000000000000000000003003120240000f01c004040000000000000000000000000000300312024000090160040400000000000000000000000000003003120240000901400404000e0e03c00000f0001f000000003003120240000901400404000a0a02c00000900013000000003003120240000901400404000a0a02c0000090001100000fc03003120240000901e00404000a0a02c0000090001100000cc03003120240000f00c00404000a0a02c0000090001100000cc030031e03c0000000000404100e0e02c0000090001100000cc0300300000000000000040494000003c0000090001100000cc0300300000000000000040494000000000000f00011001e0cc03003000000000000700407fe00000000000000001f00120cc03003000000000001f8040434000000000000000000001208c030030000000007810c0406ffc0000000000000000000120cc030030000007c0cc2040406fe0000000000000000000016078030030001e0c61062040404bc000000000000000000001e000030030f0331823026040404bf800000000000000000000000003003198611032024040404ac000007800000f00000000000003003308413012034040404280000048e000090000000000000300320cc1b012034040404280000048a000090003e00000000300360481a016034040404080000049a000090002200000000300360480a016014040404080000048e0000f0002200000000300340480a016014003fff8800000480000000002200000000300340480a01601c003fff8000000480000000002200000000300340580e0160140000040000000400000000002200000000300340580e0160340000000000000000000000002200000000300340580e0160340000000000000000000000002000000000300340500e016000000000000000000000000000fffffffc00300340500e03f800000000000000000000000000fffffffffffff340500fffc000000000000000000000000000200000000030034053ffc000000000000000000000000000000000000000300343ffc2000000000000000000000000000000000000000030037ff0000000000000000000000000000000000000000000300360500000000000000000000000000000000000000000003003005000000000000000000000000000000000000000000030030050000000000000000000000000000000000000000000300300400000000000000000000000000000000000000000003003004000000000000000000000000000000000000000000030030040000000000000000000000000000000000000000000300300463000000000000000000000000000000000000000003003004760000000000000000000000000000000000000000030030043c00000000000000000000000000000000000000000300300418000000c00000c00000001800000000003300000003003004ff1c0001c00001c000000038007fe000001b1c000003003004ff9c00038000038000000038007fe000001e1c000003003004ff1800030000030000000038007fe000000c08000003003004070000000000000010400038000601000000000200030030040e1ce3b8703f8fc3fde07c39c00e0fe1863f9c6f3c030030040e1ce3bce01f9fe3fff0fe3bc0060ff1c63f9c7ffe030030041c1ce39ce00388e3df71c73b80061c71c6071c7bce030030043c1c771ce00700e38e31c73f00061c71c6071c718e03003004381c770cc00f0fe38e31ff3f00061871c60e1c718e03003004701c770fc00e1fe38e31fe3f00061c71c61c1c718e03003004701c3e0fc01c1c638e31c03b80061c71ce1c1c718e03003004f11c3e07801c1ce38e31c23bc0061c71de381c718e03003004ff9c3e07803f9fe38e30fe39c00e1fe1fe3f9c718e03003004ff9c1c07803f8fe38e307e38e0060fc0f63f9c718e030030040000000700000000000000000000000000000000000300300400000007000000000000000000000000000000000003003004000000070000000000000000000000000000000000030033fffffffffffffffffffffffffff80000000000000000030030040000000000000000000000000000000000000000000300' };

/** QR kód s logem jako GIF (data URL). cell = pixelů na modul. Vrací { src, size }. */
function qrSLogem(text, cell) {
  var q = qrcode(0, 'H');  // nejvyšší oprava chyb, logo zakryje část kódu
  q.addData(text, 'Byte');
  q.make();
  var n = q.getModuleCount(), okraj = 4 * cell, size = n * cell + 2 * okraj, tmavy = q.isDark;
  var L = QR_LOGO, bw = L.w + 2 * cell, bh = L.h + 2 * cell;  // bílý rámeček kolem loga
  var bx = Math.floor((size - bw) / 2), by = Math.floor((size - bh) / 2);
  // createDataURL kreslí po modulech; s cell 1 a velikostí v pixelech kreslí po pixelech
  q.getModuleCount = function () { return size; };
  q.isDark = function (y, x) {
    if (x >= bx && x < bx + bw && y >= by && y < by + bh) {
      var lx = x - bx - cell, ly = y - by - cell;
      if (lx < 0 || ly < 0 || lx >= L.w || ly >= L.h) return false;
      var i = ly * L.w + lx;
      return (parseInt(L.hex.substr((i >> 3) * 2, 2), 16) & (128 >> (i & 7))) !== 0;
    }
    if (x < okraj || y < okraj || x >= size - okraj || y >= size - okraj) return false;
    return tmavy(Math.floor((y - okraj) / cell), Math.floor((x - okraj) / cell));
  };
  return { src: q.createDataURL(1, 0), size: size };
}

// ---- QR kód (knihovna qrcode-generator 1.4.4, Kazuhiko Arase, licence MIT; stejná jako js/qrcode.js na webu) ----

//---------------------------------------------------------------------
//
// QR Code Generator for JavaScript
//
// Copyright (c) 2009 Kazuhiko Arase
//
// URL: http://www.d-project.com/
//
// Licensed under the MIT license:
//  http://www.opensource.org/licenses/mit-license.php
//
// The word 'QR Code' is registered trademark of
// DENSO WAVE INCORPORATED
//  http://www.denso-wave.com/qrcode/faqpatent-e.html
//
//---------------------------------------------------------------------

var qrcode = function() {

  //---------------------------------------------------------------------
  // qrcode
  //---------------------------------------------------------------------

  /**
   * qrcode
   * @param typeNumber 1 to 40
   * @param errorCorrectionLevel 'L','M','Q','H'
   */
  var qrcode = function(typeNumber, errorCorrectionLevel) {

    var PAD0 = 0xEC;
    var PAD1 = 0x11;

    var _typeNumber = typeNumber;
    var _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
    var _modules = null;
    var _moduleCount = 0;
    var _dataCache = null;
    var _dataList = [];

    var _this = {};

    var makeImpl = function(test, maskPattern) {

      _moduleCount = _typeNumber * 4 + 17;
      _modules = function(moduleCount) {
        var modules = new Array(moduleCount);
        for (var row = 0; row < moduleCount; row += 1) {
          modules[row] = new Array(moduleCount);
          for (var col = 0; col < moduleCount; col += 1) {
            modules[row][col] = null;
          }
        }
        return modules;
      }(_moduleCount);

      setupPositionProbePattern(0, 0);
      setupPositionProbePattern(_moduleCount - 7, 0);
      setupPositionProbePattern(0, _moduleCount - 7);
      setupPositionAdjustPattern();
      setupTimingPattern();
      setupTypeInfo(test, maskPattern);

      if (_typeNumber >= 7) {
        setupTypeNumber(test);
      }

      if (_dataCache == null) {
        _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
      }

      mapData(_dataCache, maskPattern);
    };

    var setupPositionProbePattern = function(row, col) {

      for (var r = -1; r <= 7; r += 1) {

        if (row + r <= -1 || _moduleCount <= row + r) continue;

        for (var c = -1; c <= 7; c += 1) {

          if (col + c <= -1 || _moduleCount <= col + c) continue;

          if ( (0 <= r && r <= 6 && (c == 0 || c == 6) )
              || (0 <= c && c <= 6 && (r == 0 || r == 6) )
              || (2 <= r && r <= 4 && 2 <= c && c <= 4) ) {
            _modules[row + r][col + c] = true;
          } else {
            _modules[row + r][col + c] = false;
          }
        }
      }
    };

    var getBestMaskPattern = function() {

      var minLostPoint = 0;
      var pattern = 0;

      for (var i = 0; i < 8; i += 1) {

        makeImpl(true, i);

        var lostPoint = QRUtil.getLostPoint(_this);

        if (i == 0 || minLostPoint > lostPoint) {
          minLostPoint = lostPoint;
          pattern = i;
        }
      }

      return pattern;
    };

    var setupTimingPattern = function() {

      for (var r = 8; r < _moduleCount - 8; r += 1) {
        if (_modules[r][6] != null) {
          continue;
        }
        _modules[r][6] = (r % 2 == 0);
      }

      for (var c = 8; c < _moduleCount - 8; c += 1) {
        if (_modules[6][c] != null) {
          continue;
        }
        _modules[6][c] = (c % 2 == 0);
      }
    };

    var setupPositionAdjustPattern = function() {

      var pos = QRUtil.getPatternPosition(_typeNumber);

      for (var i = 0; i < pos.length; i += 1) {

        for (var j = 0; j < pos.length; j += 1) {

          var row = pos[i];
          var col = pos[j];

          if (_modules[row][col] != null) {
            continue;
          }

          for (var r = -2; r <= 2; r += 1) {

            for (var c = -2; c <= 2; c += 1) {

              if (r == -2 || r == 2 || c == -2 || c == 2
                  || (r == 0 && c == 0) ) {
                _modules[row + r][col + c] = true;
              } else {
                _modules[row + r][col + c] = false;
              }
            }
          }
        }
      }
    };

    var setupTypeNumber = function(test) {

      var bits = QRUtil.getBCHTypeNumber(_typeNumber);

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;
      }

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
      }
    };

    var setupTypeInfo = function(test, maskPattern) {

      var data = (_errorCorrectionLevel << 3) | maskPattern;
      var bits = QRUtil.getBCHTypeInfo(data);

      // vertical
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 6) {
          _modules[i][8] = mod;
        } else if (i < 8) {
          _modules[i + 1][8] = mod;
        } else {
          _modules[_moduleCount - 15 + i][8] = mod;
        }
      }

      // horizontal
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 8) {
          _modules[8][_moduleCount - i - 1] = mod;
        } else if (i < 9) {
          _modules[8][15 - i - 1 + 1] = mod;
        } else {
          _modules[8][15 - i - 1] = mod;
        }
      }

      // fixed module
      _modules[_moduleCount - 8][8] = (!test);
    };

    var mapData = function(data, maskPattern) {

      var inc = -1;
      var row = _moduleCount - 1;
      var bitIndex = 7;
      var byteIndex = 0;
      var maskFunc = QRUtil.getMaskFunction(maskPattern);

      for (var col = _moduleCount - 1; col > 0; col -= 2) {

        if (col == 6) col -= 1;

        while (true) {

          for (var c = 0; c < 2; c += 1) {

            if (_modules[row][col - c] == null) {

              var dark = false;

              if (byteIndex < data.length) {
                dark = ( ( (data[byteIndex] >>> bitIndex) & 1) == 1);
              }

              var mask = maskFunc(row, col - c);

              if (mask) {
                dark = !dark;
              }

              _modules[row][col - c] = dark;
              bitIndex -= 1;

              if (bitIndex == -1) {
                byteIndex += 1;
                bitIndex = 7;
              }
            }
          }

          row += inc;

          if (row < 0 || _moduleCount <= row) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    };

    var createBytes = function(buffer, rsBlocks) {

      var offset = 0;

      var maxDcCount = 0;
      var maxEcCount = 0;

      var dcdata = new Array(rsBlocks.length);
      var ecdata = new Array(rsBlocks.length);

      for (var r = 0; r < rsBlocks.length; r += 1) {

        var dcCount = rsBlocks[r].dataCount;
        var ecCount = rsBlocks[r].totalCount - dcCount;

        maxDcCount = Math.max(maxDcCount, dcCount);
        maxEcCount = Math.max(maxEcCount, ecCount);

        dcdata[r] = new Array(dcCount);

        for (var i = 0; i < dcdata[r].length; i += 1) {
          dcdata[r][i] = 0xff & buffer.getBuffer()[i + offset];
        }
        offset += dcCount;

        var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
        var rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);

        var modPoly = rawPoly.mod(rsPoly);
        ecdata[r] = new Array(rsPoly.getLength() - 1);
        for (var i = 0; i < ecdata[r].length; i += 1) {
          var modIndex = i + modPoly.getLength() - ecdata[r].length;
          ecdata[r][i] = (modIndex >= 0)? modPoly.getAt(modIndex) : 0;
        }
      }

      var totalCodeCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalCodeCount += rsBlocks[i].totalCount;
      }

      var data = new Array(totalCodeCount);
      var index = 0;

      for (var i = 0; i < maxDcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < dcdata[r].length) {
            data[index] = dcdata[r][i];
            index += 1;
          }
        }
      }

      for (var i = 0; i < maxEcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < ecdata[r].length) {
            data[index] = ecdata[r][i];
            index += 1;
          }
        }
      }

      return data;
    };

    var createData = function(typeNumber, errorCorrectionLevel, dataList) {

      var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);

      var buffer = qrBitBuffer();

      for (var i = 0; i < dataList.length; i += 1) {
        var data = dataList[i];
        buffer.put(data.getMode(), 4);
        buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
        data.write(buffer);
      }

      // calc num max data.
      var totalDataCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalDataCount += rsBlocks[i].dataCount;
      }

      if (buffer.getLengthInBits() > totalDataCount * 8) {
        throw 'code length overflow. ('
          + buffer.getLengthInBits()
          + '>'
          + totalDataCount * 8
          + ')';
      }

      // end code
      if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
        buffer.put(0, 4);
      }

      // padding
      while (buffer.getLengthInBits() % 8 != 0) {
        buffer.putBit(false);
      }

      // padding
      while (true) {

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD0, 8);

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD1, 8);
      }

      return createBytes(buffer, rsBlocks);
    };

    _this.addData = function(data, mode) {

      mode = mode || 'Byte';

      var newData = null;

      switch(mode) {
      case 'Numeric' :
        newData = qrNumber(data);
        break;
      case 'Alphanumeric' :
        newData = qrAlphaNum(data);
        break;
      case 'Byte' :
        newData = qr8BitByte(data);
        break;
      case 'Kanji' :
        newData = qrKanji(data);
        break;
      default :
        throw 'mode:' + mode;
      }

      _dataList.push(newData);
      _dataCache = null;
    };

    _this.isDark = function(row, col) {
      if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {
        throw row + ',' + col;
      }
      return _modules[row][col];
    };

    _this.getModuleCount = function() {
      return _moduleCount;
    };

    _this.make = function() {
      if (_typeNumber < 1) {
        var typeNumber = 1;

        for (; typeNumber < 40; typeNumber++) {
          var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, _errorCorrectionLevel);
          var buffer = qrBitBuffer();

          for (var i = 0; i < _dataList.length; i++) {
            var data = _dataList[i];
            buffer.put(data.getMode(), 4);
            buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
            data.write(buffer);
          }

          var totalDataCount = 0;
          for (var i = 0; i < rsBlocks.length; i++) {
            totalDataCount += rsBlocks[i].dataCount;
          }

          if (buffer.getLengthInBits() <= totalDataCount * 8) {
            break;
          }
        }

        _typeNumber = typeNumber;
      }

      makeImpl(false, getBestMaskPattern() );
    };

    _this.createTableTag = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var qrHtml = '';

      qrHtml += '<table style="';
      qrHtml += ' border-width: 0px; border-style: none;';
      qrHtml += ' border-collapse: collapse;';
      qrHtml += ' padding: 0px; margin: ' + margin + 'px;';
      qrHtml += '">';
      qrHtml += '<tbody>';

      for (var r = 0; r < _this.getModuleCount(); r += 1) {

        qrHtml += '<tr>';

        for (var c = 0; c < _this.getModuleCount(); c += 1) {
          qrHtml += '<td style="';
          qrHtml += ' border-width: 0px; border-style: none;';
          qrHtml += ' border-collapse: collapse;';
          qrHtml += ' padding: 0px; margin: 0px;';
          qrHtml += ' width: ' + cellSize + 'px;';
          qrHtml += ' height: ' + cellSize + 'px;';
          qrHtml += ' background-color: ';
          qrHtml += _this.isDark(r, c)? '#000000' : '#ffffff';
          qrHtml += ';';
          qrHtml += '"/>';
        }

        qrHtml += '</tr>';
      }

      qrHtml += '</tbody>';
      qrHtml += '</table>';

      return qrHtml;
    };

    _this.createSvgTag = function(cellSize, margin, alt, title) {

      var opts = {};
      if (typeof arguments[0] == 'object') {
        // Called by options.
        opts = arguments[0];
        // overwrite cellSize and margin.
        cellSize = opts.cellSize;
        margin = opts.margin;
        alt = opts.alt;
        title = opts.title;
      }

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      // Compose alt property surrogate
      alt = (typeof alt === 'string') ? {text: alt} : alt || {};
      alt.text = alt.text || null;
      alt.id = (alt.text) ? alt.id || 'qrcode-description' : null;

      // Compose title property surrogate
      title = (typeof title === 'string') ? {text: title} : title || {};
      title.text = title.text || null;
      title.id = (title.text) ? title.id || 'qrcode-title' : null;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var c, mc, r, mr, qrSvg='', rect;

      rect = 'l' + cellSize + ',0 0,' + cellSize +
        ' -' + cellSize + ',0 0,-' + cellSize + 'z ';

      qrSvg += '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"';
      qrSvg += !opts.scalable ? ' width="' + size + 'px" height="' + size + 'px"' : '';
      qrSvg += ' viewBox="0 0 ' + size + ' ' + size + '" ';
      qrSvg += ' preserveAspectRatio="xMinYMin meet"';
      qrSvg += (title.text || alt.text) ? ' role="img" aria-labelledby="' +
          escapeXml([title.id, alt.id].join(' ').trim() ) + '"' : '';
      qrSvg += '>';
      qrSvg += (title.text) ? '<title id="' + escapeXml(title.id) + '">' +
          escapeXml(title.text) + '</title>' : '';
      qrSvg += (alt.text) ? '<description id="' + escapeXml(alt.id) + '">' +
          escapeXml(alt.text) + '</description>' : '';
      qrSvg += '<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>';
      qrSvg += '<path d="';

      for (r = 0; r < _this.getModuleCount(); r += 1) {
        mr = r * cellSize + margin;
        for (c = 0; c < _this.getModuleCount(); c += 1) {
          if (_this.isDark(r, c) ) {
            mc = c*cellSize+margin;
            qrSvg += 'M' + mc + ',' + mr + rect;
          }
        }
      }

      qrSvg += '" stroke="transparent" fill="black"/>';
      qrSvg += '</svg>';

      return qrSvg;
    };

    _this.createDataURL = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      return createDataURL(size, size, function(x, y) {
        if (min <= x && x < max && min <= y && y < max) {
          var c = Math.floor( (x - min) / cellSize);
          var r = Math.floor( (y - min) / cellSize);
          return _this.isDark(r, c)? 0 : 1;
        } else {
          return 1;
        }
      } );
    };

    _this.createImgTag = function(cellSize, margin, alt) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;

      var img = '';
      img += '<img';
      img += '\u0020src="';
      img += _this.createDataURL(cellSize, margin);
      img += '"';
      img += '\u0020width="';
      img += size;
      img += '"';
      img += '\u0020height="';
      img += size;
      img += '"';
      if (alt) {
        img += '\u0020alt="';
        img += escapeXml(alt);
        img += '"';
      }
      img += '/>';

      return img;
    };

    var escapeXml = function(s) {
      var escaped = '';
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charAt(i);
        switch(c) {
        case '<': escaped += '&lt;'; break;
        case '>': escaped += '&gt;'; break;
        case '&': escaped += '&amp;'; break;
        case '"': escaped += '&quot;'; break;
        default : escaped += c; break;
        }
      }
      return escaped;
    };

    var _createHalfASCII = function(margin) {
      var cellSize = 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r1, r2, p;

      var blocks = {
        '██': '█',
        '█ ': '▀',
        ' █': '▄',
        '  ': ' '
      };

      var blocksLastLineNoMargin = {
        '██': '▀',
        '█ ': '▀',
        ' █': ' ',
        '  ': ' '
      };

      var ascii = '';
      for (y = 0; y < size; y += 2) {
        r1 = Math.floor((y - min) / cellSize);
        r2 = Math.floor((y + 1 - min) / cellSize);
        for (x = 0; x < size; x += 1) {
          p = '█';

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r1, Math.floor((x - min) / cellSize))) {
            p = ' ';
          }

          if (min <= x && x < max && min <= y+1 && y+1 < max && _this.isDark(r2, Math.floor((x - min) / cellSize))) {
            p += ' ';
          }
          else {
            p += '█';
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          ascii += (margin < 1 && y+1 >= max) ? blocksLastLineNoMargin[p] : blocks[p];
        }

        ascii += '\n';
      }

      if (size % 2 && margin > 0) {
        return ascii.substring(0, ascii.length - size - 1) + Array(size+1).join('▀');
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.createASCII = function(cellSize, margin) {
      cellSize = cellSize || 1;

      if (cellSize < 2) {
        return _createHalfASCII(margin);
      }

      cellSize -= 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r, p;

      var white = Array(cellSize+1).join('██');
      var black = Array(cellSize+1).join('  ');

      var ascii = '';
      var line = '';
      for (y = 0; y < size; y += 1) {
        r = Math.floor( (y - min) / cellSize);
        line = '';
        for (x = 0; x < size; x += 1) {
          p = 1;

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r, Math.floor((x - min) / cellSize))) {
            p = 0;
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          line += p ? white : black;
        }

        for (r = 0; r < cellSize; r += 1) {
          ascii += line + '\n';
        }
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.renderTo2dContext = function(context, cellSize) {
      cellSize = cellSize || 2;
      var length = _this.getModuleCount();
      for (var row = 0; row < length; row++) {
        for (var col = 0; col < length; col++) {
          context.fillStyle = _this.isDark(row, col) ? 'black' : 'white';
          context.fillRect(row * cellSize, col * cellSize, cellSize, cellSize);
        }
      }
    }

    return _this;
  };

  //---------------------------------------------------------------------
  // qrcode.stringToBytes
  //---------------------------------------------------------------------

  qrcode.stringToBytesFuncs = {
    'default' : function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        bytes.push(c & 0xff);
      }
      return bytes;
    }
  };

  qrcode.stringToBytes = qrcode.stringToBytesFuncs['default'];

  //---------------------------------------------------------------------
  // qrcode.createStringToBytes
  //---------------------------------------------------------------------

  /**
   * @param unicodeData base64 string of byte array.
   * [16bit Unicode],[16bit Bytes], ...
   * @param numChars
   */
  qrcode.createStringToBytes = function(unicodeData, numChars) {

    // create conversion map.

    var unicodeMap = function() {

      var bin = base64DecodeInputStream(unicodeData);
      var read = function() {
        var b = bin.read();
        if (b == -1) throw 'eof';
        return b;
      };

      var count = 0;
      var unicodeMap = {};
      while (true) {
        var b0 = bin.read();
        if (b0 == -1) break;
        var b1 = read();
        var b2 = read();
        var b3 = read();
        var k = String.fromCharCode( (b0 << 8) | b1);
        var v = (b2 << 8) | b3;
        unicodeMap[k] = v;
        count += 1;
      }
      if (count != numChars) {
        throw count + ' != ' + numChars;
      }

      return unicodeMap;
    }();

    var unknownChar = '?'.charCodeAt(0);

    return function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        if (c < 128) {
          bytes.push(c);
        } else {
          var b = unicodeMap[s.charAt(i)];
          if (typeof b == 'number') {
            if ( (b & 0xff) == b) {
              // 1byte
              bytes.push(b);
            } else {
              // 2bytes
              bytes.push(b >>> 8);
              bytes.push(b & 0xff);
            }
          } else {
            bytes.push(unknownChar);
          }
        }
      }
      return bytes;
    };
  };

  //---------------------------------------------------------------------
  // QRMode
  //---------------------------------------------------------------------

  var QRMode = {
    MODE_NUMBER :    1 << 0,
    MODE_ALPHA_NUM : 1 << 1,
    MODE_8BIT_BYTE : 1 << 2,
    MODE_KANJI :     1 << 3
  };

  //---------------------------------------------------------------------
  // QRErrorCorrectionLevel
  //---------------------------------------------------------------------

  var QRErrorCorrectionLevel = {
    L : 1,
    M : 0,
    Q : 3,
    H : 2
  };

  //---------------------------------------------------------------------
  // QRMaskPattern
  //---------------------------------------------------------------------

  var QRMaskPattern = {
    PATTERN000 : 0,
    PATTERN001 : 1,
    PATTERN010 : 2,
    PATTERN011 : 3,
    PATTERN100 : 4,
    PATTERN101 : 5,
    PATTERN110 : 6,
    PATTERN111 : 7
  };

  //---------------------------------------------------------------------
  // QRUtil
  //---------------------------------------------------------------------

  var QRUtil = function() {

    var PATTERN_POSITION_TABLE = [
      [],
      [6, 18],
      [6, 22],
      [6, 26],
      [6, 30],
      [6, 34],
      [6, 22, 38],
      [6, 24, 42],
      [6, 26, 46],
      [6, 28, 50],
      [6, 30, 54],
      [6, 32, 58],
      [6, 34, 62],
      [6, 26, 46, 66],
      [6, 26, 48, 70],
      [6, 26, 50, 74],
      [6, 30, 54, 78],
      [6, 30, 56, 82],
      [6, 30, 58, 86],
      [6, 34, 62, 90],
      [6, 28, 50, 72, 94],
      [6, 26, 50, 74, 98],
      [6, 30, 54, 78, 102],
      [6, 28, 54, 80, 106],
      [6, 32, 58, 84, 110],
      [6, 30, 58, 86, 114],
      [6, 34, 62, 90, 118],
      [6, 26, 50, 74, 98, 122],
      [6, 30, 54, 78, 102, 126],
      [6, 26, 52, 78, 104, 130],
      [6, 30, 56, 82, 108, 134],
      [6, 34, 60, 86, 112, 138],
      [6, 30, 58, 86, 114, 142],
      [6, 34, 62, 90, 118, 146],
      [6, 30, 54, 78, 102, 126, 150],
      [6, 24, 50, 76, 102, 128, 154],
      [6, 28, 54, 80, 106, 132, 158],
      [6, 32, 58, 84, 110, 136, 162],
      [6, 26, 54, 82, 110, 138, 166],
      [6, 30, 58, 86, 114, 142, 170]
    ];
    var G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
    var G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
    var G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

    var _this = {};

    var getBCHDigit = function(data) {
      var digit = 0;
      while (data != 0) {
        digit += 1;
        data >>>= 1;
      }
      return digit;
    };

    _this.getBCHTypeInfo = function(data) {
      var d = data << 10;
      while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
        d ^= (G15 << (getBCHDigit(d) - getBCHDigit(G15) ) );
      }
      return ( (data << 10) | d) ^ G15_MASK;
    };

    _this.getBCHTypeNumber = function(data) {
      var d = data << 12;
      while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
        d ^= (G18 << (getBCHDigit(d) - getBCHDigit(G18) ) );
      }
      return (data << 12) | d;
    };

    _this.getPatternPosition = function(typeNumber) {
      return PATTERN_POSITION_TABLE[typeNumber - 1];
    };

    _this.getMaskFunction = function(maskPattern) {

      switch (maskPattern) {

      case QRMaskPattern.PATTERN000 :
        return function(i, j) { return (i + j) % 2 == 0; };
      case QRMaskPattern.PATTERN001 :
        return function(i, j) { return i % 2 == 0; };
      case QRMaskPattern.PATTERN010 :
        return function(i, j) { return j % 3 == 0; };
      case QRMaskPattern.PATTERN011 :
        return function(i, j) { return (i + j) % 3 == 0; };
      case QRMaskPattern.PATTERN100 :
        return function(i, j) { return (Math.floor(i / 2) + Math.floor(j / 3) ) % 2 == 0; };
      case QRMaskPattern.PATTERN101 :
        return function(i, j) { return (i * j) % 2 + (i * j) % 3 == 0; };
      case QRMaskPattern.PATTERN110 :
        return function(i, j) { return ( (i * j) % 2 + (i * j) % 3) % 2 == 0; };
      case QRMaskPattern.PATTERN111 :
        return function(i, j) { return ( (i * j) % 3 + (i + j) % 2) % 2 == 0; };

      default :
        throw 'bad maskPattern:' + maskPattern;
      }
    };

    _this.getErrorCorrectPolynomial = function(errorCorrectLength) {
      var a = qrPolynomial([1], 0);
      for (var i = 0; i < errorCorrectLength; i += 1) {
        a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0) );
      }
      return a;
    };

    _this.getLengthInBits = function(mode, type) {

      if (1 <= type && type < 10) {

        // 1 - 9

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 10;
        case QRMode.MODE_ALPHA_NUM : return 9;
        case QRMode.MODE_8BIT_BYTE : return 8;
        case QRMode.MODE_KANJI     : return 8;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 27) {

        // 10 - 26

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 12;
        case QRMode.MODE_ALPHA_NUM : return 11;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 10;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 41) {

        // 27 - 40

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 14;
        case QRMode.MODE_ALPHA_NUM : return 13;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 12;
        default :
          throw 'mode:' + mode;
        }

      } else {
        throw 'type:' + type;
      }
    };

    _this.getLostPoint = function(qrcode) {

      var moduleCount = qrcode.getModuleCount();

      var lostPoint = 0;

      // LEVEL1

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount; col += 1) {

          var sameCount = 0;
          var dark = qrcode.isDark(row, col);

          for (var r = -1; r <= 1; r += 1) {

            if (row + r < 0 || moduleCount <= row + r) {
              continue;
            }

            for (var c = -1; c <= 1; c += 1) {

              if (col + c < 0 || moduleCount <= col + c) {
                continue;
              }

              if (r == 0 && c == 0) {
                continue;
              }

              if (dark == qrcode.isDark(row + r, col + c) ) {
                sameCount += 1;
              }
            }
          }

          if (sameCount > 5) {
            lostPoint += (3 + sameCount - 5);
          }
        }
      };

      // LEVEL2

      for (var row = 0; row < moduleCount - 1; row += 1) {
        for (var col = 0; col < moduleCount - 1; col += 1) {
          var count = 0;
          if (qrcode.isDark(row, col) ) count += 1;
          if (qrcode.isDark(row + 1, col) ) count += 1;
          if (qrcode.isDark(row, col + 1) ) count += 1;
          if (qrcode.isDark(row + 1, col + 1) ) count += 1;
          if (count == 0 || count == 4) {
            lostPoint += 3;
          }
        }
      }

      // LEVEL3

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount - 6; col += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row, col + 1)
              &&  qrcode.isDark(row, col + 2)
              &&  qrcode.isDark(row, col + 3)
              &&  qrcode.isDark(row, col + 4)
              && !qrcode.isDark(row, col + 5)
              &&  qrcode.isDark(row, col + 6) ) {
            lostPoint += 40;
          }
        }
      }

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount - 6; row += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row + 1, col)
              &&  qrcode.isDark(row + 2, col)
              &&  qrcode.isDark(row + 3, col)
              &&  qrcode.isDark(row + 4, col)
              && !qrcode.isDark(row + 5, col)
              &&  qrcode.isDark(row + 6, col) ) {
            lostPoint += 40;
          }
        }
      }

      // LEVEL4

      var darkCount = 0;

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount; row += 1) {
          if (qrcode.isDark(row, col) ) {
            darkCount += 1;
          }
        }
      }

      var ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
      lostPoint += ratio * 10;

      return lostPoint;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // QRMath
  //---------------------------------------------------------------------

  var QRMath = function() {

    var EXP_TABLE = new Array(256);
    var LOG_TABLE = new Array(256);

    // initialize tables
    for (var i = 0; i < 8; i += 1) {
      EXP_TABLE[i] = 1 << i;
    }
    for (var i = 8; i < 256; i += 1) {
      EXP_TABLE[i] = EXP_TABLE[i - 4]
        ^ EXP_TABLE[i - 5]
        ^ EXP_TABLE[i - 6]
        ^ EXP_TABLE[i - 8];
    }
    for (var i = 0; i < 255; i += 1) {
      LOG_TABLE[EXP_TABLE[i] ] = i;
    }

    var _this = {};

    _this.glog = function(n) {

      if (n < 1) {
        throw 'glog(' + n + ')';
      }

      return LOG_TABLE[n];
    };

    _this.gexp = function(n) {

      while (n < 0) {
        n += 255;
      }

      while (n >= 256) {
        n -= 255;
      }

      return EXP_TABLE[n];
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrPolynomial
  //---------------------------------------------------------------------

  function qrPolynomial(num, shift) {

    if (typeof num.length == 'undefined') {
      throw num.length + '/' + shift;
    }

    var _num = function() {
      var offset = 0;
      while (offset < num.length && num[offset] == 0) {
        offset += 1;
      }
      var _num = new Array(num.length - offset + shift);
      for (var i = 0; i < num.length - offset; i += 1) {
        _num[i] = num[i + offset];
      }
      return _num;
    }();

    var _this = {};

    _this.getAt = function(index) {
      return _num[index];
    };

    _this.getLength = function() {
      return _num.length;
    };

    _this.multiply = function(e) {

      var num = new Array(_this.getLength() + e.getLength() - 1);

      for (var i = 0; i < _this.getLength(); i += 1) {
        for (var j = 0; j < e.getLength(); j += 1) {
          num[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i) ) + QRMath.glog(e.getAt(j) ) );
        }
      }

      return qrPolynomial(num, 0);
    };

    _this.mod = function(e) {

      if (_this.getLength() - e.getLength() < 0) {
        return _this;
      }

      var ratio = QRMath.glog(_this.getAt(0) ) - QRMath.glog(e.getAt(0) );

      var num = new Array(_this.getLength() );
      for (var i = 0; i < _this.getLength(); i += 1) {
        num[i] = _this.getAt(i);
      }

      for (var i = 0; i < e.getLength(); i += 1) {
        num[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i) ) + ratio);
      }

      // recursive call
      return qrPolynomial(num, 0).mod(e);
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // QRRSBlock
  //---------------------------------------------------------------------

  var QRRSBlock = function() {

    var RS_BLOCK_TABLE = [

      // L
      // M
      // Q
      // H

      // 1
      [1, 26, 19],
      [1, 26, 16],
      [1, 26, 13],
      [1, 26, 9],

      // 2
      [1, 44, 34],
      [1, 44, 28],
      [1, 44, 22],
      [1, 44, 16],

      // 3
      [1, 70, 55],
      [1, 70, 44],
      [2, 35, 17],
      [2, 35, 13],

      // 4
      [1, 100, 80],
      [2, 50, 32],
      [2, 50, 24],
      [4, 25, 9],

      // 5
      [1, 134, 108],
      [2, 67, 43],
      [2, 33, 15, 2, 34, 16],
      [2, 33, 11, 2, 34, 12],

      // 6
      [2, 86, 68],
      [4, 43, 27],
      [4, 43, 19],
      [4, 43, 15],

      // 7
      [2, 98, 78],
      [4, 49, 31],
      [2, 32, 14, 4, 33, 15],
      [4, 39, 13, 1, 40, 14],

      // 8
      [2, 121, 97],
      [2, 60, 38, 2, 61, 39],
      [4, 40, 18, 2, 41, 19],
      [4, 40, 14, 2, 41, 15],

      // 9
      [2, 146, 116],
      [3, 58, 36, 2, 59, 37],
      [4, 36, 16, 4, 37, 17],
      [4, 36, 12, 4, 37, 13],

      // 10
      [2, 86, 68, 2, 87, 69],
      [4, 69, 43, 1, 70, 44],
      [6, 43, 19, 2, 44, 20],
      [6, 43, 15, 2, 44, 16],

      // 11
      [4, 101, 81],
      [1, 80, 50, 4, 81, 51],
      [4, 50, 22, 4, 51, 23],
      [3, 36, 12, 8, 37, 13],

      // 12
      [2, 116, 92, 2, 117, 93],
      [6, 58, 36, 2, 59, 37],
      [4, 46, 20, 6, 47, 21],
      [7, 42, 14, 4, 43, 15],

      // 13
      [4, 133, 107],
      [8, 59, 37, 1, 60, 38],
      [8, 44, 20, 4, 45, 21],
      [12, 33, 11, 4, 34, 12],

      // 14
      [3, 145, 115, 1, 146, 116],
      [4, 64, 40, 5, 65, 41],
      [11, 36, 16, 5, 37, 17],
      [11, 36, 12, 5, 37, 13],

      // 15
      [5, 109, 87, 1, 110, 88],
      [5, 65, 41, 5, 66, 42],
      [5, 54, 24, 7, 55, 25],
      [11, 36, 12, 7, 37, 13],

      // 16
      [5, 122, 98, 1, 123, 99],
      [7, 73, 45, 3, 74, 46],
      [15, 43, 19, 2, 44, 20],
      [3, 45, 15, 13, 46, 16],

      // 17
      [1, 135, 107, 5, 136, 108],
      [10, 74, 46, 1, 75, 47],
      [1, 50, 22, 15, 51, 23],
      [2, 42, 14, 17, 43, 15],

      // 18
      [5, 150, 120, 1, 151, 121],
      [9, 69, 43, 4, 70, 44],
      [17, 50, 22, 1, 51, 23],
      [2, 42, 14, 19, 43, 15],

      // 19
      [3, 141, 113, 4, 142, 114],
      [3, 70, 44, 11, 71, 45],
      [17, 47, 21, 4, 48, 22],
      [9, 39, 13, 16, 40, 14],

      // 20
      [3, 135, 107, 5, 136, 108],
      [3, 67, 41, 13, 68, 42],
      [15, 54, 24, 5, 55, 25],
      [15, 43, 15, 10, 44, 16],

      // 21
      [4, 144, 116, 4, 145, 117],
      [17, 68, 42],
      [17, 50, 22, 6, 51, 23],
      [19, 46, 16, 6, 47, 17],

      // 22
      [2, 139, 111, 7, 140, 112],
      [17, 74, 46],
      [7, 54, 24, 16, 55, 25],
      [34, 37, 13],

      // 23
      [4, 151, 121, 5, 152, 122],
      [4, 75, 47, 14, 76, 48],
      [11, 54, 24, 14, 55, 25],
      [16, 45, 15, 14, 46, 16],

      // 24
      [6, 147, 117, 4, 148, 118],
      [6, 73, 45, 14, 74, 46],
      [11, 54, 24, 16, 55, 25],
      [30, 46, 16, 2, 47, 17],

      // 25
      [8, 132, 106, 4, 133, 107],
      [8, 75, 47, 13, 76, 48],
      [7, 54, 24, 22, 55, 25],
      [22, 45, 15, 13, 46, 16],

      // 26
      [10, 142, 114, 2, 143, 115],
      [19, 74, 46, 4, 75, 47],
      [28, 50, 22, 6, 51, 23],
      [33, 46, 16, 4, 47, 17],

      // 27
      [8, 152, 122, 4, 153, 123],
      [22, 73, 45, 3, 74, 46],
      [8, 53, 23, 26, 54, 24],
      [12, 45, 15, 28, 46, 16],

      // 28
      [3, 147, 117, 10, 148, 118],
      [3, 73, 45, 23, 74, 46],
      [4, 54, 24, 31, 55, 25],
      [11, 45, 15, 31, 46, 16],

      // 29
      [7, 146, 116, 7, 147, 117],
      [21, 73, 45, 7, 74, 46],
      [1, 53, 23, 37, 54, 24],
      [19, 45, 15, 26, 46, 16],

      // 30
      [5, 145, 115, 10, 146, 116],
      [19, 75, 47, 10, 76, 48],
      [15, 54, 24, 25, 55, 25],
      [23, 45, 15, 25, 46, 16],

      // 31
      [13, 145, 115, 3, 146, 116],
      [2, 74, 46, 29, 75, 47],
      [42, 54, 24, 1, 55, 25],
      [23, 45, 15, 28, 46, 16],

      // 32
      [17, 145, 115],
      [10, 74, 46, 23, 75, 47],
      [10, 54, 24, 35, 55, 25],
      [19, 45, 15, 35, 46, 16],

      // 33
      [17, 145, 115, 1, 146, 116],
      [14, 74, 46, 21, 75, 47],
      [29, 54, 24, 19, 55, 25],
      [11, 45, 15, 46, 46, 16],

      // 34
      [13, 145, 115, 6, 146, 116],
      [14, 74, 46, 23, 75, 47],
      [44, 54, 24, 7, 55, 25],
      [59, 46, 16, 1, 47, 17],

      // 35
      [12, 151, 121, 7, 152, 122],
      [12, 75, 47, 26, 76, 48],
      [39, 54, 24, 14, 55, 25],
      [22, 45, 15, 41, 46, 16],

      // 36
      [6, 151, 121, 14, 152, 122],
      [6, 75, 47, 34, 76, 48],
      [46, 54, 24, 10, 55, 25],
      [2, 45, 15, 64, 46, 16],

      // 37
      [17, 152, 122, 4, 153, 123],
      [29, 74, 46, 14, 75, 47],
      [49, 54, 24, 10, 55, 25],
      [24, 45, 15, 46, 46, 16],

      // 38
      [4, 152, 122, 18, 153, 123],
      [13, 74, 46, 32, 75, 47],
      [48, 54, 24, 14, 55, 25],
      [42, 45, 15, 32, 46, 16],

      // 39
      [20, 147, 117, 4, 148, 118],
      [40, 75, 47, 7, 76, 48],
      [43, 54, 24, 22, 55, 25],
      [10, 45, 15, 67, 46, 16],

      // 40
      [19, 148, 118, 6, 149, 119],
      [18, 75, 47, 31, 76, 48],
      [34, 54, 24, 34, 55, 25],
      [20, 45, 15, 61, 46, 16]
    ];

    var qrRSBlock = function(totalCount, dataCount) {
      var _this = {};
      _this.totalCount = totalCount;
      _this.dataCount = dataCount;
      return _this;
    };

    var _this = {};

    var getRsBlockTable = function(typeNumber, errorCorrectionLevel) {

      switch(errorCorrectionLevel) {
      case QRErrorCorrectionLevel.L :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
      case QRErrorCorrectionLevel.M :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
      case QRErrorCorrectionLevel.Q :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
      case QRErrorCorrectionLevel.H :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
      default :
        return undefined;
      }
    };

    _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {

      var rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);

      if (typeof rsBlock == 'undefined') {
        throw 'bad rs block @ typeNumber:' + typeNumber +
            '/errorCorrectionLevel:' + errorCorrectionLevel;
      }

      var length = rsBlock.length / 3;

      var list = [];

      for (var i = 0; i < length; i += 1) {

        var count = rsBlock[i * 3 + 0];
        var totalCount = rsBlock[i * 3 + 1];
        var dataCount = rsBlock[i * 3 + 2];

        for (var j = 0; j < count; j += 1) {
          list.push(qrRSBlock(totalCount, dataCount) );
        }
      }

      return list;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrBitBuffer
  //---------------------------------------------------------------------

  var qrBitBuffer = function() {

    var _buffer = [];
    var _length = 0;

    var _this = {};

    _this.getBuffer = function() {
      return _buffer;
    };

    _this.getAt = function(index) {
      var bufIndex = Math.floor(index / 8);
      return ( (_buffer[bufIndex] >>> (7 - index % 8) ) & 1) == 1;
    };

    _this.put = function(num, length) {
      for (var i = 0; i < length; i += 1) {
        _this.putBit( ( (num >>> (length - i - 1) ) & 1) == 1);
      }
    };

    _this.getLengthInBits = function() {
      return _length;
    };

    _this.putBit = function(bit) {

      var bufIndex = Math.floor(_length / 8);
      if (_buffer.length <= bufIndex) {
        _buffer.push(0);
      }

      if (bit) {
        _buffer[bufIndex] |= (0x80 >>> (_length % 8) );
      }

      _length += 1;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrNumber
  //---------------------------------------------------------------------

  var qrNumber = function(data) {

    var _mode = QRMode.MODE_NUMBER;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var data = _data;

      var i = 0;

      while (i + 2 < data.length) {
        buffer.put(strToNum(data.substring(i, i + 3) ), 10);
        i += 3;
      }

      if (i < data.length) {
        if (data.length - i == 1) {
          buffer.put(strToNum(data.substring(i, i + 1) ), 4);
        } else if (data.length - i == 2) {
          buffer.put(strToNum(data.substring(i, i + 2) ), 7);
        }
      }
    };

    var strToNum = function(s) {
      var num = 0;
      for (var i = 0; i < s.length; i += 1) {
        num = num * 10 + chatToNum(s.charAt(i) );
      }
      return num;
    };

    var chatToNum = function(c) {
      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      }
      throw 'illegal char :' + c;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrAlphaNum
  //---------------------------------------------------------------------

  var qrAlphaNum = function(data) {

    var _mode = QRMode.MODE_ALPHA_NUM;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var s = _data;

      var i = 0;

      while (i + 1 < s.length) {
        buffer.put(
          getCode(s.charAt(i) ) * 45 +
          getCode(s.charAt(i + 1) ), 11);
        i += 2;
      }

      if (i < s.length) {
        buffer.put(getCode(s.charAt(i) ), 6);
      }
    };

    var getCode = function(c) {

      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      } else if ('A' <= c && c <= 'Z') {
        return c.charCodeAt(0) - 'A'.charCodeAt(0) + 10;
      } else {
        switch (c) {
        case ' ' : return 36;
        case '$' : return 37;
        case '%' : return 38;
        case '*' : return 39;
        case '+' : return 40;
        case '-' : return 41;
        case '.' : return 42;
        case '/' : return 43;
        case ':' : return 44;
        default :
          throw 'illegal char :' + c;
        }
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qr8BitByte
  //---------------------------------------------------------------------

  var qr8BitByte = function(data) {

    var _mode = QRMode.MODE_8BIT_BYTE;
    var _data = data;
    var _bytes = qrcode.stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _bytes.length;
    };

    _this.write = function(buffer) {
      for (var i = 0; i < _bytes.length; i += 1) {
        buffer.put(_bytes[i], 8);
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrKanji
  //---------------------------------------------------------------------

  var qrKanji = function(data) {

    var _mode = QRMode.MODE_KANJI;
    var _data = data;

    var stringToBytes = qrcode.stringToBytesFuncs['SJIS'];
    if (!stringToBytes) {
      throw 'sjis not supported.';
    }
    !function(c, code) {
      // self test for sjis support.
      var test = stringToBytes(c);
      if (test.length != 2 || ( (test[0] << 8) | test[1]) != code) {
        throw 'sjis not supported.';
      }
    }('\u53cb', 0x9746);

    var _bytes = stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return ~~(_bytes.length / 2);
    };

    _this.write = function(buffer) {

      var data = _bytes;

      var i = 0;

      while (i + 1 < data.length) {

        var c = ( (0xff & data[i]) << 8) | (0xff & data[i + 1]);

        if (0x8140 <= c && c <= 0x9FFC) {
          c -= 0x8140;
        } else if (0xE040 <= c && c <= 0xEBBF) {
          c -= 0xC140;
        } else {
          throw 'illegal char at ' + (i + 1) + '/' + c;
        }

        c = ( (c >>> 8) & 0xff) * 0xC0 + (c & 0xff);

        buffer.put(c, 13);

        i += 2;
      }

      if (i < data.length) {
        throw 'illegal char at ' + (i + 1);
      }
    };

    return _this;
  };

  //=====================================================================
  // GIF Support etc.
  //

  //---------------------------------------------------------------------
  // byteArrayOutputStream
  //---------------------------------------------------------------------

  var byteArrayOutputStream = function() {

    var _bytes = [];

    var _this = {};

    _this.writeByte = function(b) {
      _bytes.push(b & 0xff);
    };

    _this.writeShort = function(i) {
      _this.writeByte(i);
      _this.writeByte(i >>> 8);
    };

    _this.writeBytes = function(b, off, len) {
      off = off || 0;
      len = len || b.length;
      for (var i = 0; i < len; i += 1) {
        _this.writeByte(b[i + off]);
      }
    };

    _this.writeString = function(s) {
      for (var i = 0; i < s.length; i += 1) {
        _this.writeByte(s.charCodeAt(i) );
      }
    };

    _this.toByteArray = function() {
      return _bytes;
    };

    _this.toString = function() {
      var s = '';
      s += '[';
      for (var i = 0; i < _bytes.length; i += 1) {
        if (i > 0) {
          s += ',';
        }
        s += _bytes[i];
      }
      s += ']';
      return s;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64EncodeOutputStream
  //---------------------------------------------------------------------

  var base64EncodeOutputStream = function() {

    var _buffer = 0;
    var _buflen = 0;
    var _length = 0;
    var _base64 = '';

    var _this = {};

    var writeEncoded = function(b) {
      _base64 += String.fromCharCode(encode(b & 0x3f) );
    };

    var encode = function(n) {
      if (n < 0) {
        // error.
      } else if (n < 26) {
        return 0x41 + n;
      } else if (n < 52) {
        return 0x61 + (n - 26);
      } else if (n < 62) {
        return 0x30 + (n - 52);
      } else if (n == 62) {
        return 0x2b;
      } else if (n == 63) {
        return 0x2f;
      }
      throw 'n:' + n;
    };

    _this.writeByte = function(n) {

      _buffer = (_buffer << 8) | (n & 0xff);
      _buflen += 8;
      _length += 1;

      while (_buflen >= 6) {
        writeEncoded(_buffer >>> (_buflen - 6) );
        _buflen -= 6;
      }
    };

    _this.flush = function() {

      if (_buflen > 0) {
        writeEncoded(_buffer << (6 - _buflen) );
        _buffer = 0;
        _buflen = 0;
      }

      if (_length % 3 != 0) {
        // padding
        var padlen = 3 - _length % 3;
        for (var i = 0; i < padlen; i += 1) {
          _base64 += '=';
        }
      }
    };

    _this.toString = function() {
      return _base64;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64DecodeInputStream
  //---------------------------------------------------------------------

  var base64DecodeInputStream = function(str) {

    var _str = str;
    var _pos = 0;
    var _buffer = 0;
    var _buflen = 0;

    var _this = {};

    _this.read = function() {

      while (_buflen < 8) {

        if (_pos >= _str.length) {
          if (_buflen == 0) {
            return -1;
          }
          throw 'unexpected end of file./' + _buflen;
        }

        var c = _str.charAt(_pos);
        _pos += 1;

        if (c == '=') {
          _buflen = 0;
          return -1;
        } else if (c.match(/^\s$/) ) {
          // ignore if whitespace.
          continue;
        }

        _buffer = (_buffer << 6) | decode(c.charCodeAt(0) );
        _buflen += 6;
      }

      var n = (_buffer >>> (_buflen - 8) ) & 0xff;
      _buflen -= 8;
      return n;
    };

    var decode = function(c) {
      if (0x41 <= c && c <= 0x5a) {
        return c - 0x41;
      } else if (0x61 <= c && c <= 0x7a) {
        return c - 0x61 + 26;
      } else if (0x30 <= c && c <= 0x39) {
        return c - 0x30 + 52;
      } else if (c == 0x2b) {
        return 62;
      } else if (c == 0x2f) {
        return 63;
      } else {
        throw 'c:' + c;
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // gifImage (B/W)
  //---------------------------------------------------------------------

  var gifImage = function(width, height) {

    var _width = width;
    var _height = height;
    var _data = new Array(width * height);

    var _this = {};

    _this.setPixel = function(x, y, pixel) {
      _data[y * _width + x] = pixel;
    };

    _this.write = function(out) {

      //---------------------------------
      // GIF Signature

      out.writeString('GIF87a');

      //---------------------------------
      // Screen Descriptor

      out.writeShort(_width);
      out.writeShort(_height);

      out.writeByte(0x80); // 2bit
      out.writeByte(0);
      out.writeByte(0);

      //---------------------------------
      // Global Color Map

      // black
      out.writeByte(0x00);
      out.writeByte(0x00);
      out.writeByte(0x00);

      // white
      out.writeByte(0xff);
      out.writeByte(0xff);
      out.writeByte(0xff);

      //---------------------------------
      // Image Descriptor

      out.writeString(',');
      out.writeShort(0);
      out.writeShort(0);
      out.writeShort(_width);
      out.writeShort(_height);
      out.writeByte(0);

      //---------------------------------
      // Local Color Map

      //---------------------------------
      // Raster Data

      var lzwMinCodeSize = 2;
      var raster = getLZWRaster(lzwMinCodeSize);

      out.writeByte(lzwMinCodeSize);

      var offset = 0;

      while (raster.length - offset > 255) {
        out.writeByte(255);
        out.writeBytes(raster, offset, 255);
        offset += 255;
      }

      out.writeByte(raster.length - offset);
      out.writeBytes(raster, offset, raster.length - offset);
      out.writeByte(0x00);

      //---------------------------------
      // GIF Terminator
      out.writeString(';');
    };

    var bitOutputStream = function(out) {

      var _out = out;
      var _bitLength = 0;
      var _bitBuffer = 0;

      var _this = {};

      _this.write = function(data, length) {

        if ( (data >>> length) != 0) {
          throw 'length over';
        }

        while (_bitLength + length >= 8) {
          _out.writeByte(0xff & ( (data << _bitLength) | _bitBuffer) );
          length -= (8 - _bitLength);
          data >>>= (8 - _bitLength);
          _bitBuffer = 0;
          _bitLength = 0;
        }

        _bitBuffer = (data << _bitLength) | _bitBuffer;
        _bitLength = _bitLength + length;
      };

      _this.flush = function() {
        if (_bitLength > 0) {
          _out.writeByte(_bitBuffer);
        }
      };

      return _this;
    };

    var getLZWRaster = function(lzwMinCodeSize) {

      var clearCode = 1 << lzwMinCodeSize;
      var endCode = (1 << lzwMinCodeSize) + 1;
      var bitLength = lzwMinCodeSize + 1;

      // Setup LZWTable
      var table = lzwTable();

      for (var i = 0; i < clearCode; i += 1) {
        table.add(String.fromCharCode(i) );
      }
      table.add(String.fromCharCode(clearCode) );
      table.add(String.fromCharCode(endCode) );

      var byteOut = byteArrayOutputStream();
      var bitOut = bitOutputStream(byteOut);

      // clear code
      bitOut.write(clearCode, bitLength);

      var dataIndex = 0;

      var s = String.fromCharCode(_data[dataIndex]);
      dataIndex += 1;

      while (dataIndex < _data.length) {

        var c = String.fromCharCode(_data[dataIndex]);
        dataIndex += 1;

        if (table.contains(s + c) ) {

          s = s + c;

        } else {

          bitOut.write(table.indexOf(s), bitLength);

          if (table.size() < 0xfff) {

            if (table.size() == (1 << bitLength) ) {
              bitLength += 1;
            }

            table.add(s + c);
          }

          s = c;
        }
      }

      bitOut.write(table.indexOf(s), bitLength);

      // end code
      bitOut.write(endCode, bitLength);

      bitOut.flush();

      return byteOut.toByteArray();
    };

    var lzwTable = function() {

      var _map = {};
      var _size = 0;

      var _this = {};

      _this.add = function(key) {
        if (_this.contains(key) ) {
          throw 'dup key:' + key;
        }
        _map[key] = _size;
        _size += 1;
      };

      _this.size = function() {
        return _size;
      };

      _this.indexOf = function(key) {
        return _map[key];
      };

      _this.contains = function(key) {
        return typeof _map[key] != 'undefined';
      };

      return _this;
    };

    return _this;
  };

  var createDataURL = function(width, height, getPixel) {
    var gif = gifImage(width, height);
    for (var y = 0; y < height; y += 1) {
      for (var x = 0; x < width; x += 1) {
        gif.setPixel(x, y, getPixel(x, y) );
      }
    }

    var b = byteArrayOutputStream();
    gif.write(b);

    var base64 = base64EncodeOutputStream();
    var bytes = b.toByteArray();
    for (var i = 0; i < bytes.length; i += 1) {
      base64.writeByte(bytes[i]);
    }
    base64.flush();

    return 'data:image/gif;base64,' + base64;
  };

  //---------------------------------------------------------------------
  // returns qrcode function.

  return qrcode;
}();

// multibyte support
!function() {

  qrcode.stringToBytesFuncs['UTF-8'] = function(s) {
    // http://stackoverflow.com/questions/18729405/how-to-convert-utf8-string-to-byte-array
    function toUTF8Array(str) {
      var utf8 = [];
      for (var i=0; i < str.length; i++) {
        var charcode = str.charCodeAt(i);
        if (charcode < 0x80) utf8.push(charcode);
        else if (charcode < 0x800) {
          utf8.push(0xc0 | (charcode >> 6),
              0x80 | (charcode & 0x3f));
        }
        else if (charcode < 0xd800 || charcode >= 0xe000) {
          utf8.push(0xe0 | (charcode >> 12),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
        // surrogate pair
        else {
          i++;
          // UTF-16 encodes 0x10000-0x10FFFF by
          // subtracting 0x10000 and splitting the
          // 20 bits of 0x0-0xFFFFF into two halves
          charcode = 0x10000 + (((charcode & 0x3ff)<<10)
            | (str.charCodeAt(i) & 0x3ff));
          utf8.push(0xf0 | (charcode >>18),
              0x80 | ((charcode>>12) & 0x3f),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
      }
      return utf8;
    }
    return toUTF8Array(s);
  };

}();
