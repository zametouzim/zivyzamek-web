<?php
// Odeslání formuláře „Máte dotaz?“ ze stránky Navštivte nás na e-mail spolku.
// Funguje jen na hostingu s PHP (Webglobe), na GitHub Pages ne.
// Před spuštěním ověřit, že hosting povoluje mail() a že FROM je adresa na doméně webu.

const KOMU = 'zivyzamektouzim@email.cz';
const FROM = 'web@zivyzamektouzim.cz';

header('Content-Type: application/json; charset=utf-8');

function konec($ok, $kod = 200) {
    http_response_code($kod);
    echo json_encode(['ok' => $ok]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') konec(false, 405);

function pole($k, $max) {
    $v = trim((string)($_POST[$k] ?? ''));
    return mb_substr($v, 0, $max, 'UTF-8');
}

// Skryté políčko vyplní jen roboti: tváříme se, že vše prošlo, a nic neposíláme.
if (pole('web', 200) !== '') konec(true);

$jmeno = str_replace(["\r", "\n"], ' ', pole('jmeno', 100));
$email = str_replace(["\r", "\n"], '', pole('email', 150));
$tel = str_replace(["\r", "\n"], ' ', pole('telefon', 40));
$zprava = pole('zprava', 5000);

if ($jmeno === '' || $zprava === '' || ($email === '' && $tel === '')) konec(false, 400);
if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) konec(false, 400);

$text = "Dotaz z webu zivyzamektouzim.cz\n\n"
      . "Jméno: $jmeno\n"
      . "E-mail: " . ($email ?: '–') . "\n"
      . "Telefon: " . ($tel ?: '–') . "\n\n"
      . $zprava . "\n";

$hlavicky = [
    'From: =?UTF-8?B?' . base64_encode('Web Živý zámek') . '?= <' . FROM . '>',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    'MIME-Version: 1.0',
];
if ($email !== '') $hlavicky[] = 'Reply-To: ' . $email;

$predmet = '=?UTF-8?B?' . base64_encode('Dotaz z webu: ' . $jmeno) . '?=';

konec(mail(KOMU, $predmet, $text, implode("\r\n", $hlavicky), '-f' . FROM));
