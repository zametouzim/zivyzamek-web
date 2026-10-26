/**
 * Rezervace akcí na webu Živý zámek Toužim (Google Apps Script).
 *
 * Skript patří k Google tabulce „Rezervace“ ve spolkovém Google účtu (Rozšíření → Apps Script).
 * Web (index.html, REZ_API) se ho ptá na volná místa a posílá mu rezervace.
 * Akce, počty míst, ceny a uzávěrky čte z webu (data/rezervace.json, vzniká z administrace).
 *
 * Jak to běží:
 *  - doGet:  počet volných míst u akce
 *  - doPost: nová rezervace → řádek na listu akce + e-mail s údaji k platbě
 *            (každá akce má vlastní list pojmenovaný podle akce a data, skript ho založí sám a nic z něj nemaže)
 *  - hlidej: každých 5 minut (časový spouštěč, založí ho funkce nastav)
 *      - stáhne platby z Fio (když je v Nastavení projektu → Vlastnosti skriptu FIO_TOKEN) a spáruje je podle VS
 *      - u řádků se zaškrtnutým „Zaplaceno“ pošle potvrzení
 *      - nezaplacené rezervace po lhůtě označí jako propadlé a pošle o tom e-mail
 */

// ---- Nastavení ----
var WEB = 'https://zametouzim.github.io/zivyzamek-web/';  // adresa webu (po přechodu na doménu stačí změnit tady)
var ODESILATEL = '';                                      // např. 'rezervace@zivyzamektouzim.cz', až bude v Gmailu nastavené „Odesílat poštu jako“
var ODPOVEDI = 'zivyzamektouzim@email.cz';                // kam půjdou odpovědi návštěvníků
var UPOZORNENI = 'zivyzamektouzim@email.cz';              // kam skript hlásí problémy (Fio, platba po lhůtě)
var LHUTA_HODIN = 24;                                     // jak dlouho držet nezaplacenou rezervaci
var UCET = '2301034510/2010';
var IBAN = 'CZ7920100000002301034510';
var ZONA = 'Europe/Prague';

var SLOUPCE = ['VS', 'Vytvořeno', 'Akce', 'Název akce', 'Jméno', 'E-mail', 'Telefon', 'Vstupenky', 'Osob', 'Kč',
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
    return json({ ok: true, volno: volno(id, akce[id]) });
  }
  var out = {};
  Object.keys(akce).forEach(function (k) { out[k] = volno(k, akce[k]); });
  return json({ ok: true, volno: out });
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
    osob += n; castka += n * c.cena; listky.push(n + '× ' + c.druh + ' (' + c.cena + ' Kč)');
  });
  if (!osob) return json({ ok: false, chyba: 'udaje' });

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (casAkce(a.uzaverka) < new Date()) return json({ ok: false, chyba: 'uzavreno' });
    var v = volno(p.akce, a);
    if (osob > v) return json({ ok: false, chyba: 'plno', volno: v });
    var vs = noveVs(), ted = new Date(), splatnost = new Date(ted.getTime() + LHUTA_HODIN * 3600e3);
    var radek = [];
    radek[C['VS']] = vs; radek[C['Vytvořeno']] = ted; radek[C['Akce']] = p.akce; radek[C['Název akce']] = a.title;
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
  var r = { vs: vs, castka: castka, osob: osob, listky: listky.join(', '), splatnost: splatnost, lang: lang, a: a, akce: p.akce };
  if (castka) posli(email, text('platbaPredmet', r), text('platba', r));
  else posli(email, text('potvrzeniPredmet', r), text('potvrzeni', r));
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
    var row = data[i], vs = String(row[C['VS']]), stav = row[C['Stav']], zmena = null;
    var p = platby[vs];
    if (p && !row[C['Platba']] && (stav === CEKA || stav === PROPADLO)) {
      list.getRange(i + 1, C['Platba'] + 1).setValue(p.popis);
      row[C['Platba']] = p.popis;
      if (p.castka >= row[C['Kč']]) {
        if (stav === CEKA) { list.getRange(i + 1, C['Zaplaceno'] + 1).setValue(true); row[C['Zaplaceno']] = true; }
        else zmena = POZDE;
      } else {
        upozorni('Platba nižší, než je cena rezervace',
          'Rezervace ' + vs + ' (' + row[C['Jméno']] + ', ' + row[C['Název akce']] + '): přišlo ' + p.castka + ' Kč, cena je ' +
          row[C['Kč']] + ' Kč. Rozhodněte prosím ručně a v tabulce zaškrtněte „Zaplaceno“, nebo se ozvěte návštěvníkovi.');
      }
    }
    var r = radekData(row, akce);
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
      posli(row[C['E-mail']], text('propadloPredmet', r), text('propadlo', r));
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

function volno(id, a) {
  var list = tabulka(id, a, true), data = list ? list.getDataRange().getValues() : [], obsazeno = 0;
  for (var i = 1; i < data.length; i++)
    if (data[i][C['Akce']] === id && DRZI_MISTO.indexOf(data[i][C['Stav']]) >= 0) obsazeno += Number(data[i][C['Osob']]) || 0;
  return Math.max(0, a.kapacita - obsazeno);
}

function noveVs() {
  var props = PropertiesService.getScriptProperties(), rok = Number(Utilities.formatDate(new Date(), ZONA, 'yy'));
  var n = Number(props.getProperty('VS_' + rok) || 0) + 1;
  props.setProperty('VS_' + rok, String(n));
  return rok * 10000 + n;  // např. 260001
}

function casAkce(s) {
  return Utilities.parseDate(String(s).slice(0, 16), ZONA, "yyyy-MM-dd'T'HH:mm");
}

function radekData(row, akce) {
  var id = row[C['Akce']], a = akce[id] || { title: row[C['Název akce']], date: '', when: '' };
  return { vs: row[C['VS']], castka: row[C['Kč']], osob: row[C['Osob']], listky: row[C['Vstupenky']], splatnost: row[C['Zaplatit do']],
           lang: row[C['Jazyk']] || 'cs', a: a, akce: id };
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function posli(komu, predmet, telo) {
  var opt = { name: 'Živý zámek Toužim', replyTo: ODPOVEDI };
  if (ODESILATEL && GmailApp.getAliases().indexOf(ODESILATEL) >= 0) { opt.from = ODESILATEL; opt.replyTo = ODESILATEL; }
  GmailApp.sendEmail(komu, predmet, telo, opt);
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
  en: { 'Jednotné vstupné': 'Standard admission', 'Dospělí': 'Adults', 'Děti': 'Children', ' Kč)': ' CZK)' },
  de: { 'Jednotné vstupné': 'Einheitlicher Eintritt', 'Dospělí': 'Erwachsene', 'Děti': 'Kinder', ' Kč)': ' CZK)' }
};

function text(klic, r) {
  var l = r.lang || 'cs', a = r.a || {};
  var datum = a.date ? a.date.split('-').map(Number) : null;
  var kdy = datum ? (l === 'cs' ? datum[2] + '. ' + datum[1] + '. ' + datum[0] : l === 'de' ? datum[2] + '.' + datum[1] + '.' + datum[0] : datum[2] + '/' + datum[1] + '/' + datum[0]) : '';
  var nazev = a['title_' + l] || a.title, cas = a['when_' + l] || a.when;
  var akce = nazev + (kdy ? ', ' + kdy : '') + (cas ? ' (' + cas + ')' : '');
  var do_ = r.splatnost instanceof Date ? Utilities.formatDate(r.splatnost, ZONA, l === 'en' ? 'd/M/yyyy H:mm' : 'd. M. yyyy H:mm') : '';
  var odkaz = WEB + (l === 'cs' ? '' : '?lang=' + l) + '#platba/' + r.vs + '/' + r.castka;
  var listky = String(r.listky || '');
  if (l !== 'cs') Object.keys(DRUHY[l]).forEach(function (k) { listky = listky.split(k).join(DRUHY[l][k]); });
  r = Object.assign({}, r, { listky: listky });
  var podpis = { cs: '\n\nŽivý zámek Toužim z. s.\n' + WEB, en: '\n\nŽivý zámek Toužim z. s.\n' + WEB + '?lang=en', de: '\n\nŽivý zámek Toužim z. s.\n' + WEB + '?lang=de' }[l];
  var T = {
    cs: {
      platbaPredmet: 'Rezervace ' + r.vs + ': zbývá zaplatit',
      platba: 'Dobrý den,\n\nděkujeme za rezervaci na akci ' + akce + '.\nVstupenky: ' + r.listky + '\n\nRezervace platí až po zaplacení. Prosíme o platbu do ' + do_ + ', jinak rezervace propadne.\n\n' +
              'Účet: ' + UCET + '\nČástka: ' + r.castka + ' Kč\nVariabilní symbol: ' + r.vs + '\n\nQR kód pro platbu: ' + odkaz +
              '\n\nAž platbu spárujeme, pošleme vám potvrzení. Zaplacené vstupné se nevrací.' + podpis,
      potvrzeniPredmet: 'Rezervace ' + r.vs + ' potvrzena',
      potvrzeni: 'Dobrý den,\n\nvaše rezervace na akci ' + akce + ' je potvrzená.\nVstupenky: ' + r.listky + '\nČíslo rezervace: ' + r.vs + '\n\nTěšíme se na vás.' + podpis,
      propadloPredmet: 'Rezervace ' + r.vs + ' propadla',
      propadlo: 'Dobrý den,\n\nrezervace ' + r.vs + ' na akci ' + akce + ' propadla, protože jsme do ' + do_ + ' neobdrželi platbu. Místa jsme uvolnili.\n\n' +
                'Pokud jste už zaplatili, ozvěte se nám prosím odpovědí na tento e-mail.' + podpis
    },
    en: {
      platbaPredmet: 'Booking ' + r.vs + ': payment due',
      platba: 'Hello,\n\nthank you for booking ' + akce + '.\nTickets: ' + r.listky + '\n\nThe booking is valid once paid. Please pay by ' + do_ + ', otherwise the booking expires.\n\n' +
              'Account: ' + UCET + ' (IBAN ' + IBAN + ')\nAmount: ' + r.castka + ' CZK\nVariable symbol (reference): ' + r.vs + '\n\nQR code for payment: ' + odkaz +
              '\n\nOnce we match your payment, we will send you a confirmation. Admission fees are non-refundable.' + podpis,
      potvrzeniPredmet: 'Booking ' + r.vs + ' confirmed',
      potvrzeni: 'Hello,\n\nyour booking for ' + akce + ' is confirmed.\nTickets: ' + r.listky + '\nBooking number: ' + r.vs + '\n\nWe look forward to seeing you.' + podpis,
      propadloPredmet: 'Booking ' + r.vs + ' expired',
      propadlo: 'Hello,\n\nbooking ' + r.vs + ' for ' + akce + ' has expired because we did not receive payment by ' + do_ + '. The places have been released.\n\n' +
                'If you have already paid, please reply to this e-mail.' + podpis
    },
    de: {
      platbaPredmet: 'Reservierung ' + r.vs + ': Zahlung ausstehend',
      platba: 'Guten Tag,\n\nvielen Dank für Ihre Reservierung für ' + akce + '.\nEintrittskarten: ' + r.listky + '\n\nDie Reservierung gilt erst nach der Zahlung. Bitte zahlen Sie bis ' + do_ + ', sonst verfällt die Reservierung.\n\n' +
              'Konto: ' + UCET + ' (IBAN ' + IBAN + ')\nBetrag: ' + r.castka + ' CZK\nVariabler Symbol (Referenz): ' + r.vs + '\n\nQR-Code zur Zahlung: ' + odkaz +
              '\n\nSobald wir Ihre Zahlung zugeordnet haben, schicken wir Ihnen eine Bestätigung. Bezahlter Eintritt wird nicht erstattet.' + podpis,
      potvrzeniPredmet: 'Reservierung ' + r.vs + ' bestätigt',
      potvrzeni: 'Guten Tag,\n\nIhre Reservierung für ' + akce + ' ist bestätigt.\nEintrittskarten: ' + r.listky + '\nReservierungsnummer: ' + r.vs + '\n\nWir freuen uns auf Sie.' + podpis,
      propadloPredmet: 'Reservierung ' + r.vs + ' verfallen',
      propadlo: 'Guten Tag,\n\ndie Reservierung ' + r.vs + ' für ' + akce + ' ist verfallen, weil bis ' + do_ + ' keine Zahlung eingegangen ist. Die Plätze wurden freigegeben.\n\n' +
                'Falls Sie bereits bezahlt haben, antworten Sie bitte auf diese E-Mail.' + podpis
    }
  };
  return T[l][klic];
}
