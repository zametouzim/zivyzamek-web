// Pole „Skrytá akce“: přepínač, a když je zapnutý, hotový odkaz na akci ke zkopírování.
// Funguje v administraci (Sveltia) i v ukázce (Decap), obě mají window.h a window.createClass.
(function () {
  var h = window.h;
  // adresa webu = adresa administrace bez /admin/…, takže sedí na testovací adrese i na doméně
  var web = location.href.split('#')[0].replace(/admin\/.*$/, '');
  function slug(p) {
    var s = p.entry && p.entry.get && p.entry.get('slug');
    if (s) return s;
    var m = location.hash.match(/\/entries\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }
  var Control = createClass({
    getInitialState: function () { return { hotovo: false }; },
    kopiruj: function (url, input) {
      var self = this;
      function ok() { self.setState({ hotovo: true }); setTimeout(function () { self.setState({ hotovo: false }); }, 2000); }
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(ok, function () { input.select(); });
      else { input.select(); try { document.execCommand('copy'); ok(); } catch (e) {} }
    },
    render: function () {
      var p = this.props, on = !!p.value, s = slug(p), self = this, input;
      var box = h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
        h('input', { type: 'checkbox', id: p.forID, checked: on, style: { width: '20px', height: '20px' },
          onChange: function (e) { p.onChange(e.target.checked); } }),
        on ? 'Akce je skrytá' : 'Akce je vidět v programu');
      if (!on) return h('div', { className: p.classNameWrapper }, box);
      var url = web + '#akce/' + s;
      return h('div', { className: p.classNameWrapper }, box,
        s ? h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' } },
              h('input', { type: 'text', readOnly: true, value: url, 'aria-label': 'Odkaz na skrytou akci',
                ref: function (el) { input = el; }, onFocus: function (e) { e.target.select(); },
                style: { flex: '1 1 260px', minWidth: 0, padding: '8px', font: 'inherit', fontSize: '14px' } }),
              h('button', { type: 'button', onClick: function () { self.kopiruj(url, input); },
                style: { padding: '8px 14px', font: 'inherit', fontWeight: 600, cursor: 'pointer' } },
                this.state.hotovo ? 'Zkopírováno' : 'Kopírovat odkaz'))
          : h('p', { style: { margin: '10px 0 0', fontSize: '14px' } }, 'Odkaz se zobrazí po uložení akce.'));
    }
  });
  CMS.registerWidget('skryta-akce', Control);
})();
