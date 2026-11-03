/* CactusNet TV — cargador con actualización desde GitHub (LG webOS y Samsung Tizen).
   La app instalada trae una copia completa. Al abrir:
     1) si hay guardada una versión más nueva descargada antes, se usa esa; si no, la copia instalada;
     2) unos segundos después revisa version.json en GitHub y, si hay una versión nueva, la descarga
        y la guarda para la próxima vez que se abra la app (igual que la APK de Android).
   Si una versión descargada falla al arrancar dos veces seguidas, se descarta y se vuelve a la instalada.
   window.CACTUS_BOOT = { build, repo, styles: [...], scripts: [...] } lo define index.html. ES5. */
(function () {
  var CFG = window.CACTUS_BOOT, KEY = 'cn.boot';
  var RAW = 'https://raw.githubusercontent.com/' + CFG.repo + '/';

  function load() { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; } }
  function save(c) { try { localStorage.setItem(KEY, JSON.stringify(c)); return true; } catch (e) { return false; } }
  function drop() { try { localStorage.removeItem(KEY); } catch (e) {} }

  var running = CFG.build;

  function notesFor(c) {
    var out = [];
    (c.history || []).filter(function (v) { return +v.versionCode > (c.prev || 0); })
      .sort(function (a, b) { return b.versionCode - a.versionCode; }).slice(0, 8)
      .forEach(function (v) { (v.changes || []).forEach(function (x) { out.push('• ' + x); }); });
    return out.join('\n');
  }

  function runCached(c) {
    document.body.innerHTML = c.body;
    var links = document.querySelectorAll('link[rel=stylesheet]');
    for (var i = 0; i < links.length; i++) links[i].parentNode.removeChild(links[i]);
    c.styles.forEach(function (css) {
      var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    });
    running = c.build;
    if (!c.shown) window.__cactusBootNotes = notesFor(c);
    c.tries = (c.tries || 0) + 1; save(c);
    window.__cactusBootOk = function () { c.tries = 0; c.shown = true; save(c); };
    c.scripts.forEach(function (code) {
      var s = document.createElement('script'); s.text = code; document.head.appendChild(s);
    });
  }

  function runBundled() {
    var list = CFG.scripts.slice();
    (function next() {
      if (!list.length) return;
      var s = document.createElement('script');
      s.src = list.shift(); s.onload = next; s.onerror = next;
      document.head.appendChild(s);
    })();
  }

  var c = load();
  if (c && c.build > CFG.build && c.body && c.scripts && (c.tries || 0) < 2) {
    try { runCached(c); } catch (e) { drop(); runBundled(); }
  } else {
    if (c && c.build <= CFG.build) drop();              // la app instalada ya es igual o más nueva
    if (c && (c.tries || 0) >= 2) drop();                // la versión descargada no arrancaba
    runBundled();
  }

  // ---- Buscar versión nueva en GitHub ----
  function get(url, ok, fail) {
    var x = new XMLHttpRequest();
    x.open('GET', url + (url.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(), true);
    x.timeout = 30000;
    x.onload = function () { if (x.status >= 200 && x.status < 300) ok(x.responseText); else fail(); };
    x.onerror = x.ontimeout = fail;
    x.send();
  }
  function bodyOf(html) {
    var m = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
    return (m ? m[1] : html).replace(/<script[\s\S]*?<\/script>/gi, '');
  }
  function check() {
    get(RAW + 'main/version.json', function (txt) {
      var v; try { v = JSON.parse(txt); } catch (e) { return; }
      if (!v || !(+v.versionCode > running) || !v.tag || !v.scripts) return;
      var base = RAW + v.tag + '/app/', files = ['index.html'].concat(v.styles || [], v.scripts), got = {}, n = files.length, bad = false;
      files.forEach(function (f) {
        get(base + f, function (t) {
          got[f] = t;
          if (--n === 0 && !bad) {
            var ok = save({
              build: +v.versionCode, name: v.versionName, prev: running, shown: false, tries: 0,
              body: bodyOf(got['index.html']),
              styles: (v.styles || []).map(function (s) { return got[s]; }),
              scripts: v.scripts.map(function (s) { return got[s]; }),
              history: v.history || []
            });
            if (ok && window.__cactusToast) window.__cactusToast('Versión ' + v.versionName + ' descargada: se aplicará la próxima vez que abras la app');
          }
        }, function () { bad = true; });
      });
    }, function () {});
  }
  setTimeout(check, 8000);
})();
