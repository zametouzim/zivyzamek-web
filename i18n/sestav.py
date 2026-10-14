#!/usr/bin/env python3
"""Sestaví data/i18n.js z i18n/en.json a i18n/de.json (překlady pevných textů stránky index.html).
Klíč = český text prvku přesně tak, jak je v index.html (bez nadbytečných mezer).
Po změně českého textu v index.html je potřeba upravit i klíč v obou souborech, jinak se prvek nepřeloží."""
import json, os, re
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = {}
for l in ('en', 'de'):
    with open(os.path.join(ROOT, 'i18n', l + '.json'), encoding='utf-8') as f:
        d = json.load(f)
    n = lambda t: re.sub(r'\s+', ' ', t).strip()
    out[l] = {'html': {n(k): v for k, v in d.get('html', {}).items()},
              'attr': {n(k): v for k, v in d.get('attr', {}).items()},
              'js': d.get('js', {}), 'title': d.get('title', '')}
with open(os.path.join(ROOT, 'data', 'i18n.js'), 'w', encoding='utf-8') as f:
    f.write('// Generováno z i18n/*.json (i18n/sestav.py). Neupravovat ručně.\n')
    f.write('window.I18N=%s;\n' % json.dumps(out, ensure_ascii=False))
print({l: len(out[l]['html']) for l in out})
