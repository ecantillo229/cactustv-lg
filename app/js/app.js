/* CactusTV — interfaz, reproductor, control parental y modos TV / móvil.
   ES5 puro: funciona en LG webOS 3.x+ y en el WebView de Android 5+.
   En TV se maneja con control remoto (flechas, OK, ATRÁS, CH+/-, colores, números);
   en móvil, con toques. */
(function () {
  'use strict';

  /* ============================ CONFIGURACIÓN ============================ */
  var CONFIG = {
    server: 'http://10.0.2.5:25461', // servidor Xtream de CactusNet (no se le pide al usuario)
    version: '1.5.0',
    // Archivo con la última versión publicada (ver README → "Publicar una actualización").
    updateUrl: 'https://github.com/ecantillo229/cactustv/releases/latest/download/version.json',
    // Secciones que se muestran. Para volver a ofrecer películas y series: ['live', 'vod', 'series']
    sections: ['live'],
    refreshAfterMin: 30,            // al volver a la app tras este tiempo, se actualizan los canales
    supportPhone: '317 611 9013',     // se muestra en los mensajes de error
    relockAfterMin: 5,               // tras este tiempo en segundo plano, el contenido adulto se vuelve a bloquear
    pinMaxTries: 5,                  // intentos antes de bloquear el PIN temporalmente
    pinLockMin: 5,                   // primer bloqueo (minutos); se duplica con cada fallo adicional
    // categorías / canales que se consideran para adultos
    adultRe: /(adult(?!\s*swim)|xxx|porn|er[oó]tic|playboy|hustler|\+\s?18|18\s?\+|para\s+adultos)/i
  };

  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 461, ESC: 27, BKSP: 8,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
    CHUP: 33, CHDN: 34, PLAY: 415, PAUSE: 19, PLAYPAUSE: 10252, STOP: 413, FF: 417, RW: 412
  };
  var CHUNK = 80;            // filas que se pintan por tanda (listas de miles de canales)
  var PKEY = 'iptv.parental'; // PIN del dispositivo (no se borra al cerrar sesión)
  var IS_WEBOS = !!window.PalmSystem || !!window.CACTUS_TV; // TV fijo: LG webOS o Samsung Tizen

  var ICONS = {
    live: '<path d="M3 4h18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v10h18V6zM7 20h10v2H7z"/>',
    vod: '<path d="M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm1 2v2h2V5zm12 0v2h2V5zM5 9v2h2V9zm12 0v2h2V9zM5 13v2h2v-2zm12 0v2h2v-2zM5 17v2h2v-2zm12 0v2h2v-2zM9 5v14h6V5z"/>',
    series: '<path d="M3 8h14v12H3zM6 4h15v12h-2V6H6z"/>',
    settings: '<path d="M3 6h9v2H3zm13 0h5v2h-5zM3 16h4v2H3zm8 0h10v2H11zM12 4h4v6h-4zM7 14h4v6H7z"/>',
    lock: '<path d="M7 10V7a5 5 0 0 1 10 0v3h1a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zm2 0h6V7a3 3 0 0 0-6 0z"/>',
    play: 'M8 5v14l11-7z',
    pause: 'M6 5h4v14H6zm8 0h4v14h-4z'
  };

  /* ============================ UTILIDADES ============================ */
  function $(id) { return document.getElementById(id); }
  function qsa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function clock() { var d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) return '0:00';
    s = Math.floor(s);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ':' + pad(m) : m) + ':' + pad(x);
  }
  function svg(paths) { return '<svg viewBox="0 0 24 24">' + paths + '</svg>'; }
  function htmlCls(name, on) { document.documentElement.classList[on ? 'add' : 'remove'](name); }

  var store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  // Ajuste técnico (no visible para el usuario): cambiar el servidor sin recompilar.
  (function () { var ov = store.get('iptv.serverOverride', null); if (ov) CONFIG.server = ov; })();

  // Puente con la app nativa de Android (no existe en webOS ni en el navegador)
  function nat(fn, arg) {
    try {
      var n = window.CactusNative;
      if (n && n[fn]) return arg === undefined ? n[fn]() : n[fn](arg);
    } catch (e) {}
    return undefined;
  }
  function canPip() { return !!nat('pipSupported'); }

  var S = {
    screen: 'none', mode: null, src: null, profile: null,
    settings: store.get('iptv.settings', {}),
    sections: [], secIdx: 0, secEls: [],
    cats: [], catIdx: 0, catEls: [],
    items: [], itemIdx: 0, itemEls: [], shown: 0, loadedKey: null,
    col: 1, stack: null, favs: {}, favKey: '', lastKey: '',
    adultCats: {}, unlocked: false, after: null,
    reqId: 0, catTimer: null, secTimer: null, backAt: 0, hiddenAt: 0, inPip: false
  };
  if (!S.settings.liveFmt) S.settings.liveFmt = 'm3u8';
  if (!S.settings.engine) S.settings.engine = 'hlsjs';
  if (S.settings.pip == null) S.settings.pip = true;

  /* ============================ UI GENERAL ============================ */
  function show(id) {
    ['chooser', 'login', 'browser', 'player'].forEach(function (s) {
      if (s === id) $(s).classList.remove('hidden'); else $(s).classList.add('hidden');
    });
    S.screen = id;
  }
  function loading(on, text) {
    $('loadingText').textContent = text || 'Cargando…';
    if (on) $('loading').classList.remove('hidden'); else $('loading').classList.add('hidden');
  }
  var toastT = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.classList.add('hidden'); }, 2800);
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function exitApp() {
    if (window.CactusNative) { nat('exit'); return; }
    try { if (window.webOS && webOS.platformBack) { webOS.platformBack(); return; } } catch (e) {}
    window.close();
  }
  function confirmExit() {
    var now = Date.now();
    if (now - S.backAt < 2500) exitApp();
    else { S.backAt = now; toast(S.mode === 'mobile' ? 'Vuelve atrás otra vez para salir' : 'Pulsa ATRÁS otra vez para salir'); }
  }

  /* ============================ MODO TV / MÓVIL ============================ */
  function applyMode() {
    htmlCls('mode-choose', !S.mode);
    htmlCls('mode-tv', S.mode === 'tv');
    htmlCls('mode-mobile', S.mode === 'mobile');
    fit();
    if (S.mode === 'tv') nat('setOrientation', 6);                     // horizontal
    else if (S.mode === 'mobile') nat('setOrientation', S.screen === 'player' ? 6 : -1); // libre
  }

  // En TV la interfaz está diseñada a 1920x1080 y se escala a la pantalla real.
  function fit() {
    var b = document.body.style;
    if (S.mode !== 'tv') { b.webkitTransform = b.transform = ''; b.left = b.top = '0px'; return; }
    var w = window.innerWidth, h = window.innerHeight;
    if (!w || !h) return;
    var s = Math.min(w / 1920, h / 1080);
    if (Math.abs(s - 1) < 0.001) { b.webkitTransform = b.transform = ''; b.left = b.top = '0px'; return; }
    b.webkitTransformOrigin = b.transformOrigin = '0 0';
    b.webkitTransform = b.transform = 'scale(' + s + ')';
    b.left = Math.round((w - 1920 * s) / 2) + 'px';
    b.top = Math.round((h - 1080 * s) / 2) + 'px';
  }

  var C = { idx: 0 };
  function showChooser() {
    S.mode = null; applyMode();
    // Android dice si el equipo es un TV / TV box; si no, se adivina por la pantalla táctil
    var tv = nat('isTv');
    C.idx = tv === true ? 1 : (tv === false ? 0 : (('ontouchstart' in window) ? 0 : 1));
    show('chooser'); paintChooser();
  }
  function paintChooser() { qsa('#chooser .opt').forEach(function (o, i) { o.classList.toggle('focused', i === C.idx); }); }
  function chooseMode(m) {
    S.mode = m; store.set('iptv.mode', m); applyMode();
    proceed();
  }
  function chooserKey(k, e) {
    switch (k) {
      case KEY.LEFT: case KEY.UP: C.idx = 0; paintChooser(); break;
      case KEY.RIGHT: case KEY.DOWN: C.idx = 1; paintChooser(); break;
      case KEY.ENTER: chooseMode(qsa('#chooser .opt')[C.idx].getAttribute('data-mode')); break;
      case KEY.BACK: case KEY.ESC: confirmExit(); break;
      default: return;
    }
    e.preventDefault();
  }

  /* ============================ LOGIN ============================ */
  var L = { rows: [], r: 0 };
  function showLogin(msg) {
    show('login');
    L.rows = [$('xUser'), $('xPass'), $('btnConnect')];
    L.r = $('xUser').value ? ($('xPass').value ? 2 : 1) : 0;
    $('loginMsg').textContent = msg || '';
    paintLogin();
  }
  function paintLogin() {
    L.rows.forEach(function (e, i) { e.classList.toggle('focused', i === L.r && S.mode === 'tv'); });
  }
  function loginKey(k, e) {
    var ae = document.activeElement;
    if (ae && ae.tagName === 'INPUT') {
      if (k === KEY.ENTER) {
        ae.blur(); e.preventDefault();
        if (ae.id === 'xUser') { L.r = 1; paintLogin(); if (S.mode === 'mobile') $('xPass').focus(); }
        else { L.r = 2; paintLogin(); connect(); }
        return;
      }
      if (k === KEY.BACK || k === KEY.ESC) { ae.blur(); e.preventDefault(); return; }
      if (k !== KEY.UP && k !== KEY.DOWN) return; // dejar escribir y mover el cursor
      ae.blur();
    }
    switch (k) {
      case KEY.UP: L.r = clamp(L.r - 1, 0, 2); paintLogin(); break;
      case KEY.DOWN: L.r = clamp(L.r + 1, 0, 2); paintLogin(); break;
      case KEY.ENTER:
        if (L.r < 2) L.rows[L.r].focus(); else connect();
        break;
      case KEY.BACK: case KEY.ESC: case KEY.BKSP:
        if (S.src) { show('browser'); paint(); } else confirmExit();
        break;
      default: return;
    }
    e.preventDefault();
  }
  function connect() {
    var p = { mode: 'xtream', user: $('xUser').value.replace(/^\s+|\s+$/g, ''), pass: $('xPass').value };
    if (!p.user || !p.pass) { $('loginMsg').textContent = 'Escribe tu usuario y contraseña.'; return; }
    startSession(p, false);
  }

  function profKey(p) { return p.mode === 'm3u' ? p.url : CONFIG.server + '|' + p.user; }
  function makeSource(p) {
    return p.mode === 'm3u'
      ? new Sources.M3U({ url: p.url })
      : new Sources.Xtream({ server: CONFIG.server, user: p.user, pass: p.pass, liveFmt: S.settings.liveFmt });
  }

  // Cada vez que se abre la app se vuelve a iniciar sesión y se descargan las categorías
  // y canales del servidor, así que la lista siempre llega actualizada.
  function startSession(p, resume) {
    $('loginMsg').textContent = '';
    loading(true, resume ? 'Actualizando canales…' : 'Conectando…');
    var src = makeSource(p);
    src.login().then(function () {
      loading(false);
      store.set('iptv.profile', p);
      S.profile = p; S.src = src;
      S.favKey = 'iptv.favs.' + profKey(p);
      S.lastKey = 'iptv.last.' + profKey(p);
      S.favs = store.get(S.favKey, {});
      openBrowser(resume);
    }, function (err) {
      loading(false);
      if (p.user) $('xUser').value = p.user;
      if (p.pass) $('xPass').value = p.pass;
      if (err && err.code === 'network') {
        showLogin('');
        offlineModal(function () { startSession(p, resume); });
        return;
      }
      showLogin('No se pudo conectar: ' + err.message + '.');
    });
  }

  /* --- Sin conexión con el servidor (p. ej. fuera de la red de CactusNet) --- */
  var OFF = { retry: null };
  // ¿Hay internet? Se intenta cargar una imagen pequeña de Google (funciona sin CORS en Android y webOS).
  function checkInternet(cb) {
    if (navigator.onLine === false) { cb(false); return; }
    var urls = ['https://www.google.com/favicon.ico', 'https://www.gstatic.com/images/branding/product/1x/googleg_32dp.png'];
    var done = false, pending = urls.length;
    var t = setTimeout(function () { if (!done) { done = true; cb(false); } }, 6000);
    urls.forEach(function (u) {
      var img = new Image();
      img.onload = function () { if (!done) { done = true; clearTimeout(t); cb(true); } };
      img.onerror = function () { if (--pending === 0 && !done) { done = true; clearTimeout(t); cb(false); } };
      img.src = u + '?t=' + Date.now();
    });
  }
  function offlineText(internet) {
    if (!internet) {
      return 'Este equipo no tiene conexión a internet.\n\n' +
        (S.mode === 'mobile' ? 'Revisa que estés conectado al WiFi de tu casa' : 'Revisa que el equipo esté conectado al WiFi o al cable de red') +
        ' y que el módem esté encendido. Si el problema sigue, comunícate al ' + CONFIG.supportPhone + '.';
    }
    return 'Hay internet, pero no se pudo conectar con el servidor de CactusNet TV.\n\n' +
      'Este servicio solo funciona conectado al internet de CactusNet. ' +
      (S.mode === 'mobile' ? 'Si estás usando datos móviles u otra red WiFi, conéctate al WiFi de tu casa. ' : '') +
      'Si ya estás en la red de CactusNet, comunícate al ' + CONFIG.supportPhone + '.';
  }
  function offlineModal(retry) {
    loading(true, 'Comprobando conexión…');
    checkInternet(function (internet) { loading(false); offlineModalShow(retry, internet); });
  }
  function offlineModalShow(retry, internet) {
    OFF.retry = retry;
    var go = function () { OFF.retry = null; closeModal(); retry(); };
    openModal({
      kind: 'info', title: internet ? 'Sin conexión con CactusNet' : 'Sin internet', text: offlineText(internet),
      buttons: [
        { label: 'Reintentar', fn: go, primary: true },
        { label: 'Usar otra cuenta', fn: function () { OFF.retry = null; closeModal(); showLogin(); } }
      ]
    });
  }
  // Si el equipo recupera la conexión mientras se muestra el aviso, reintentar solo.
  window.addEventListener('online', function () {
    if (!OFF.retry || !M.open) return;
    var r = OFF.retry; OFF.retry = null;
    setTimeout(function () { closeModal(); r(); }, 1500);
  });
  function loadErrorText(err, what) {
    return err && err.code === 'network'
      ? 'Sin conexión con CactusNet. Verifica que estés conectado al internet de CactusNet y vuelve a intentarlo. Si sigue, comunícate al ' + CONFIG.supportPhone + '.'
      : 'No se pudieron cargar ' + what + ': ' + err.message + '.';
  }

  /* ============================ NAVEGADOR ============================ */
  function openBrowser(resume) {
    S.sections = S.src.sections()
      .filter(function (s) { return CONFIG.sections.indexOf(s.id) >= 0; })
      .concat([{ id: 'settings', label: 'Ajustes' }]);
    S.col = 1;
    renderSections();
    show('browser');
    var last = resume ? store.get(S.lastKey, null) : null;
    if (last && last.item && last.item.type === 'live') {
      selectSection(0, { catId: last.cat, then: function () { resumeLast(last); } });
    } else selectSection(0);
  }

  // Al abrir la app, volver a poner el último canal en vivo que se vio.
  function resumeLast(last) {
    var idx = -1;
    for (var i = 0; i < S.items.length; i++) if (S.items[i].id === last.item.id) { idx = i; break; }
    if (idx < 0) return;                                    // el canal ya no está en esa categoría
    if (isAdultItem(S.items[idx])) return;       // nunca reanudar contenido adulto
    S.col = 2;
    moveItem(idx);
    play(S.items, idx);
  }

  function curSec() { return S.sections[S.secIdx] ? S.sections[S.secIdx].id : ''; }

  function renderSections() {
    var list = $('listSec');
    list.innerHTML = '';
    S.secEls = [];
    S.sections.forEach(function (s, i) {
      var r = el('div', 'row');
      var ic = el('span', 'sic'); ic.innerHTML = svg(ICONS[s.id] || ICONS.live);
      r.appendChild(ic);
      r.appendChild(el('span', 'txt', s.label));
      r.setAttribute('data-col', '0'); r.setAttribute('data-idx', String(i));
      list.appendChild(r); S.secEls.push(r);
    });
  }

  function selectSection(i, opt) {
    S.secIdx = i; S.stack = null; S.after = (opt && opt.then) || null;
    var sec = curSec();
    htmlCls('sec-settings', sec === 'settings');
    $('browser').scrollTop = 0; // en móvil, Ajustes se desliza entero: volver arriba al cambiar de pestaña
    S.cats = []; S.catIdx = 0; renderCats();
    clearItems('');
    if (sec === 'settings') {
      S.cats = settingsCats();
      $('catsTitle').textContent = 'Ajustes';
      renderCats(); paint();
      showInfo();
      return;
    }
    $('catsTitle').textContent = 'Cargando…';
    paint();
    var id = ++S.reqId;
    S.src.categories(sec).then(function (cats) {
      if (id !== S.reqId) return;
      var ac = S.adultCats[sec] = {};
      cats.forEach(function (c) { if (c.id !== '*' && CONFIG.adultRe.test(c.name)) { c.adult = true; ac[c.id] = true; } });
      cats.unshift({ id: 'fav', name: '★ Favoritos', count: (S.favs[sec] || []).length });
      S.allCats = cats;
      // categorías de adultos: no aparecen mientras el interruptor de Ajustes esté apagado
      cats = S.cats = shownCats(cats);
      var pick = -1, j;
      if (opt && opt.catId != null) for (j = 0; j < cats.length; j++) if (cats[j].id === opt.catId) { pick = j; break; }
      if (pick < 0) {
        for (j = 0; j < cats.length; j++) if (cats[j].id !== 'fav' && cats[j].id !== '*' && !cats[j].adult) { pick = j; break; }
        if (pick < 0) pick = cats.length > 1 ? 1 : 0;
      }
      S.catIdx = pick;
      $('catsTitle').textContent = S.sections[S.secIdx].label;
      renderCats(); paint();
      loadItems();
    }, function (err) {
      if (id !== S.reqId) return;
      S.after = null;
      $('catsTitle').textContent = S.sections[S.secIdx].label;
      clearItems(loadErrorText(err, 'las categorías'));
    });
  }

  function shownCats(all) { return lockedNow() ? all.filter(function (c) { return !c.adult; }) : all.slice(); }

  function renderCats() {
    var list = $('listCats');
    list.innerHTML = '';
    S.catEls = [];
    S.catEls._p = null;
    var frag = document.createDocumentFragment();
    var locked = lockedNow();
    S.cats.forEach(function (c, i) {
      var r = el('div', 'row');
      if (c.adult && locked) { var lk = el('span', 'lock'); lk.innerHTML = svg(ICONS.lock); r.appendChild(lk); }
      r.appendChild(el('span', 'txt', c.name));
      if (c.count != null) r.appendChild(el('span', 'cnt', String(c.count)));
      r.setAttribute('data-col', '1'); r.setAttribute('data-idx', String(i));
      frag.appendChild(r); S.catEls.push(r);
    });
    list.appendChild(frag);
  }

  function clearItems(msg) {
    S.items = []; S.itemEls = []; S.itemIdx = 0; S.shown = 0; S.loadedKey = null;
    $('listItems').innerHTML = '';
    $('listItems').scrollTop = 0;
    $('itemsTitle').textContent = '';
    setEmpty(msg);
  }
  function setEmpty(msg, locked) {
    var e = $('itemsEmpty');
    e.textContent = msg || '';
    e.classList.toggle('hidden', !msg);
    e.classList.toggle('locked', !!locked);
  }
  function runAfter() { var f = S.after; S.after = null; if (f) f(); }

  function loadItems() {
    var sec = curSec(), cat = S.cats[S.catIdx];
    if (!cat || sec === 'settings') return;
    var key = sec + '|' + cat.id + (lockedNow() ? '|L' : '');
    if (S.loadedKey === key) return;
    S.stack = null;
    clearItems('');
    S.loadedKey = key;
    $('itemsTitle').textContent = cat.name;
    if (cat.adult && lockedNow()) {
      S.after = null;
      setEmpty(S.mode === 'mobile'
        ? 'Contenido para adultos bloqueado. Toca aquí para ingresar el PIN.'
        : 'Contenido para adultos bloqueado. Pulsa OK para ingresar el PIN.', true);
      return;
    }
    if (cat.id === 'fav') {
      setItems(filterAdult((S.favs[sec] || []).slice(), sec), cat.name,
        S.mode === 'mobile' ? 'Aún no tienes favoritos. Toca la estrella ☆ de un canal para agregarlo.'
                            : 'Aún no tienes favoritos. Pulsa el botón ROJO sobre un canal para agregarlo.');
      runAfter();
      return;
    }
    setEmpty('Cargando…');
    var id = ++S.reqId;
    S.src.items(sec, cat.id).then(function (list) {
      if (id !== S.reqId) return;
      setItems(filterAdult(list, sec), cat.name, 'Esta categoría está vacía.');
      runAfter();
    }, function (err) {
      if (id !== S.reqId) return;
      S.loadedKey = null; S.after = null;
      setEmpty(loadErrorText(err, 'los canales'));
    });
  }

  function setItems(list, title, emptyMsg) {
    S.items = list; S.itemIdx = 0; S.shown = 0; S.itemEls = [];
    $('listItems').innerHTML = '';
    $('listItems').scrollTop = 0;
    $('itemsTitle').textContent = title + '  ·  ' + list.length;
    setEmpty(list.length ? '' : emptyMsg);
    appendItems();
    paint();
  }

  function isFav(it, sec) {
    var arr = S.favs[sec || curSec()] || [];
    for (var i = 0; i < arr.length; i++) if (arr[i].id === it.id) return true;
    return false;
  }

  function itemRow(it, i) {
    var r = el('div', 'row item');
    if (it.type === 'info') {
      r.className = 'row info-row';
      r.appendChild(el('span', 'ik', it.k));
      r.appendChild(el('span', 'txt', it.v));
    } else {
      if (it.type === 'live') r.appendChild(el('span', 'num', String(it.num || i + 1)));
      var lg = el('span', 'logo');
      if (it.logo) {
        var img = document.createElement('img');
        img.onerror = function () { lg.innerHTML = ''; lg.appendChild(el('span', 'ph', (it.name || '?').charAt(0).toUpperCase())); };
        img.src = it.logo;
        lg.appendChild(img);
      } else lg.appendChild(el('span', 'ph', (it.name || '?').charAt(0).toUpperCase()));
      r.appendChild(lg);
      r.appendChild(el('span', 'txt', it.name));
      if (it.type === 'series') r.appendChild(el('span', 'cnt', 'Serie ›'));
      if (it.type !== 'episode') {
        var fav = isFav(it);
        if (fav) r.appendChild(el('span', 'star', '★'));
        r.appendChild(el('span', 'favbtn' + (fav ? ' on' : ''), fav ? '★' : '☆')); // solo visible en móvil
      }
    }
    r.setAttribute('data-col', '2'); r.setAttribute('data-idx', String(i));
    return r;
  }

  function appendItems() {
    var end = Math.min(S.items.length, S.shown + CHUNK);
    var frag = document.createDocumentFragment();
    for (var i = S.shown; i < end; i++) {
      var r = itemRow(S.items[i], i);
      frag.appendChild(r); S.itemEls.push(r);
    }
    $('listItems').appendChild(frag);
    S.shown = end;
  }

  /* --- foco visual --- */
  function setSel(els, idx, active, noScroll) {
    if (els._p != null && els[els._p]) { els[els._p].classList.remove('focused'); els[els._p].classList.remove('selected'); }
    var e = els[idx];
    if (!e) { els._p = null; return; }
    e.classList.add(active ? 'focused' : 'selected');
    els._p = idx;
    if (!noScroll) {
      var list = e.parentNode;
      if (S.mode === 'mobile' && list.id === 'listCats' && curSec() !== 'settings') {
        list.scrollLeft = Math.max(0, e.offsetLeft - list.clientWidth / 2 + e.offsetWidth / 2);
      } else if (S.mode !== 'mobile' || list.id !== 'listItems') {
        list.scrollTop = Math.max(0, e.offsetTop - list.clientHeight / 2 + e.offsetHeight / 2);
      }
    }
  }
  function paint(noScroll) {
    var mob = S.mode === 'mobile';
    setSel(S.secEls, S.secIdx, S.col === 0 && !mob, noScroll);
    setSel(S.catEls, S.catIdx, S.col === 1 && !mob, noScroll);
    setSel(S.itemEls, S.itemIdx, S.col === 2 && !mob, noScroll || mob);
  }

  /* --- movimientos con el control --- */
  function moveSec(d) {
    var i = clamp(S.secIdx + d, 0, S.sections.length - 1);
    if (i === S.secIdx) return;
    S.secIdx = i; paint();
    clearTimeout(S.secTimer);
    S.secTimer = setTimeout(function () { selectSection(S.secIdx); }, 350);
  }
  function moveCat(d) {
    var i = clamp(S.catIdx + d, 0, S.cats.length - 1);
    if (i === S.catIdx) return;
    S.catIdx = i; S.after = null; paint();
    if (curSec() === 'settings') { showInfo(); return; }
    clearTimeout(S.catTimer);
    S.catTimer = setTimeout(loadItems, 450);
  }
  function moveItem(d) {
    if (!S.items.length) return;
    var i = clamp(S.itemIdx + d, 0, S.items.length - 1);
    while (i >= S.shown - 5 && S.shown < S.items.length) appendItems();
    S.itemIdx = i; paint();
  }

  function browserKey(k, e) {
    var col = S.col, step = (k === KEY.CHUP || k === KEY.CHDN) ? 10 : 1;
    switch (k) {
      case KEY.UP: case KEY.DOWN: case KEY.CHUP: case KEY.CHDN:
        var d = (k === KEY.UP || k === KEY.CHUP) ? -step : step;
        if (col === 0) moveSec(d > 0 ? 1 : -1); else if (col === 1) moveCat(d); else moveItem(d);
        break;
      case KEY.LEFT:
        if (col > 0) { S.col--; paint(); }
        break;
      case KEY.RIGHT:
        if (col === 0) { if (S.secTimer) { clearTimeout(S.secTimer); S.secTimer = null; } S.col = 1; paint(); }
        else if (col === 1 && S.itemEls.length && curSec() !== 'settings') { S.col = 2; paint(); }
        break;
      case KEY.ENTER:
        if (col === 0) { S.col = 1; paint(); }
        else if (col === 1) enterCat();
        else activateItem();
        break;
      case KEY.BACK: case KEY.ESC: case KEY.BKSP:
        if (S.mode === 'mobile') {
          if (S.stack) restoreStack(); else if (S.secIdx !== 0) selectSection(0); else confirmExit();
        } else if (col === 2) {
          if (S.stack) restoreStack(); else { S.col = 1; paint(); }
        } else if (col === 1) { S.col = 0; paint(); }
        else confirmExit();
        break;
      case KEY.RED:
        if (col === 2) toggleFav(S.items[S.itemIdx]);
        break;
      default: return;
    }
    e.preventDefault();
  }

  function enterCat() {
    if (curSec() === 'settings') { runSetting(S.cats[S.catIdx]); return; }
    clearTimeout(S.catTimer);
    var cat = S.cats[S.catIdx];
    if (cat.adult && lockedNow()) { unlockAdult(function () { if (S.items.length) { S.col = 2; paint(); } }); return; }
    if (S.loadedKey !== curSec() + '|' + cat.id + (lockedNow() ? '|L' : '')) loadItems();
    if (S.items.length) { S.col = 2; paint(); }
  }

  function activateItem() {
    var it = S.items[S.itemIdx];
    if (!it || it.type === 'info') return;
    if (it.type === 'series') { openSeries(it); return; }
    play(S.items, S.itemIdx);
  }

  function openSeries(it) {
    loading(true, 'Cargando episodios…');
    S.src.episodes(it.id, it.name, it.logo, it.adult, it.cat).then(function (eps) {
      loading(false);
      if (!eps.length) { toast('Esta serie no tiene episodios disponibles'); return; }
      S.stack = { items: S.items, idx: S.itemIdx, title: $('itemsTitle').textContent, key: S.loadedKey };
      setItems(eps, it.name, '');
      S.col = 2; paint();
    }, function (err) {
      loading(false);
      toast('No se pudieron cargar los episodios: ' + err.message);
    });
  }

  function restoreStack() {
    var st = S.stack; S.stack = null;
    S.items = st.items; S.itemIdx = 0; S.shown = 0; S.itemEls = [];
    $('listItems').innerHTML = '';
    appendItems();
    $('itemsTitle').textContent = st.title;
    S.loadedKey = st.key;
    moveItem(st.idx);
    setEmpty('');
    paint();
  }

  /* --- favoritos --- */
  function toggleFav(it, sec) {
    if (!it || it.type === 'info' || it.type === 'episode') return;
    sec = sec || curSec();
    var arr = S.favs[sec] || (S.favs[sec] = []);
    var at = -1;
    for (var i = 0; i < arr.length; i++) if (arr[i].id === it.id) { at = i; break; }
    if (at >= 0) { arr.splice(at, 1); toast('Quitado de favoritos'); }
    else { arr.push(it); toast('Agregado a favoritos ★'); }
    store.set(S.favKey, S.favs);
    if (S.cats[0] && S.cats[0].id === 'fav' && sec === curSec()) {
      S.cats[0].count = arr.length;
      var cnt = S.catEls[0] && S.catEls[0].querySelector('.cnt');
      if (cnt) cnt.textContent = String(arr.length);
    }
    if (S.screen === 'browser' && sec === curSec()) {
      if (S.cats[S.catIdx] && S.cats[S.catIdx].id === 'fav') {
        var keep = S.itemIdx;
        S.loadedKey = null; loadItems();
        if (S.items.length) moveItem(Math.min(keep, S.items.length - 1)); else { S.col = 1; paint(); }
      } else {
        var pos = S.items.indexOf(it), old = S.itemEls[pos];
        if (old) {
          var r = itemRow(it, pos);
          old.parentNode.replaceChild(r, old); S.itemEls[pos] = r; S.itemEls._p = null; paint(true);
        }
      }
    }
  }

  /* ============================ CONTROL PARENTAL ============================ */
  function par() { return store.get(PKEY, null); }
  function pinSet() { return !!par(); }
  // El contenido para adultos viene bloqueado por defecto, haya PIN o no.
  function lockedNow() { return !S.unlocked; }

  function isAdultItem(it, sec) {
    var ac = S.adultCats[sec || curSec()] || {};
    return !!((it.cat && ac[it.cat]) || (it.group && CONFIG.adultRe.test(it.group)) || CONFIG.adultRe.test(it.name || ''));
  }
  function filterAdult(list, sec) {
    if (!lockedNow()) return list;
    return list.filter(function (it) { return !isAdultItem(it, sec); });
  }

  function randBytes(n) {
    var a = [];
    try { var u = new Uint8Array(n); window.crypto.getRandomValues(u); for (var i = 0; i < n; i++) a.push(u[i]); }
    catch (e) { for (var j = 0; j < n; j++) a.push(Math.floor(Math.random() * 256)); }
    return a;
  }
  function randHex(n) { return randBytes(n).map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  // Código de recuperación: 8 caracteres sin letras/números que se confundan (sin 0/O, 1/I/L)
  function genCode() {
    var A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', s = '';
    var b = randBytes(8);
    for (var i = 0; i < 8; i++) s += A.charAt(b[i] % 31);
    return s.slice(0, 4) + '-' + s.slice(4);
  }
  function normCode(c) { return (c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  // Hash con sal e iteraciones: el PIN y el código nunca se guardan en texto plano.
  function kdf(salt, secret) {
    var h = sha256(salt + ':' + secret);
    for (var i = 0; i < 2000; i++) h = sha256(h + salt);
    return h;
  }
  function savePin(pin, code) {
    var p = { salt: randHex(16), csalt: randHex(16), fails: 0, lockUntil: 0 };
    p.hash = kdf(p.salt, pin);
    p.chash = kdf(p.csalt, normCode(code));
    store.set(PKEY, p);
  }
  function lockoutMin() {
    var p = par();
    if (!p || !p.lockUntil) return 0;
    var ms = p.lockUntil - Date.now();
    return ms > 0 ? Math.ceil(ms / 60000) : 0;
  }
  // Tras 5 fallos se bloquea 5 min; cada fallo adicional duplica la espera (máx. ~5 h).
  function registerFail(p) {
    p.fails = (p.fails || 0) + 1;
    if (p.fails >= CONFIG.pinMaxTries) {
      p.lockUntil = Date.now() + CONFIG.pinLockMin * 60000 * Math.pow(2, Math.min(p.fails - CONFIG.pinMaxTries, 6));
    }
    store.set(PKEY, p);
  }
  function checkSecret(field, saltField, value) {
    var p = par();
    if (!p) return true;
    if (kdf(p[saltField], value) === p[field]) { p.fails = 0; p.lockUntil = 0; store.set(PKEY, p); return true; }
    registerFail(p);
    return false;
  }
  function triesLeft() { var p = par(); return Math.max(1, CONFIG.pinMaxTries - ((p && p.fails) || 0)); }
  function lockedMsg(w) { msgModal('PIN bloqueado', 'Demasiados intentos fallidos. Intenta de nuevo en ' + w + (w === 1 ? ' minuto.' : ' minutos.')); }

  // Pide el PIN antes de ejecutar ok(). Si el contenido ya está desbloqueado no lo pide,
  // salvo con opt.always (cambiar o quitar el PIN).
  function requirePin(title, ok, opt) {
    if (!pinSet()) { ok(); return; }
    if (S.unlocked && !(opt && opt.always)) { ok(); return; }
    var w = lockoutMin();
    if (w) { lockedMsg(w); return; }
    pinModal({
      title: title,
      text: 'Escribe tu PIN de 4 dígitos.',
      buttons: [
        { label: 'Olvidé mi PIN', fn: function () { recoverModal(ok); } },
        { label: 'Cancelar', fn: closeModal }
      ],
      onPin: function (pin) {
        if (checkSecret('hash', 'salt', pin)) { closeModal(); ok(); return null; }
        var w2 = lockoutMin();
        if (w2) { closeModal(); lockedMsg(w2); return null; }
        var n = triesLeft();
        return 'PIN incorrecto. ' + (n === 1 ? 'Te queda 1 intento.' : 'Te quedan ' + n + ' intentos.');
      }
    });
  }

  function unlockAdult(then) {
    // Sin PIN: para desbloquear por primera vez hay que crear uno.
    if (!pinSet()) {
      createPin(function () { S.unlocked = true; toast('Canales para adultos visibles'); afterLockChange(); if (then) then(); },
        'Crea un PIN para los canales de adultos');
      return;
    }
    requirePin('Contenido para adultos', function () {
      S.unlocked = true;
      toast('Canales para adultos visibles');
      afterLockChange();
      if (then) then();
    });
  }
  function relock() {
    if (!S.unlocked) return;
    S.unlocked = false;
    if (S.screen === 'player' && P.item && isAdultItem(P.item, P.sec)) exitPlayer();
    afterLockChange();
  }
  function afterLockChange() {
    if (S.screen !== 'browser' && S.screen !== 'player') return;
    if (curSec() === 'settings') { refreshSettings(); return; }
    if (S.allCats) {
      var curId = S.cats[S.catIdx] && S.cats[S.catIdx].id;
      S.cats = shownCats(S.allCats);
      S.catIdx = 0;
      for (var j = 0; j < S.cats.length; j++) if (S.cats[j].id === curId) { S.catIdx = j; break; }
    }
    renderCats(); paint(true);
    S.loadedKey = null; loadItems();
  }

  // Crear (o cambiar) el PIN: se pide dos veces y luego se muestra el código de recuperación.
  function createPin(done, title) {
    pinModal({
      title: title || 'Crea un PIN de 4 dígitos',
      text: 'Se pedirá para ver los canales de adultos.',
      buttons: [{ label: 'Cancelar', fn: closeModal }],
      onPin: function (p1) {
        pinModal({
          title: 'Confirma tu PIN',
          text: 'Escríbelo otra vez.',
          buttons: [{ label: 'Cancelar', fn: closeModal }],
          onPin: function (p2) {
            if (p2 !== p1) return 'Los PIN no coinciden. Escríbelo otra vez.';
            var code = genCode();
            savePin(p1, code);
            S.unlocked = false;
            msgModal('Guarda tu código de recuperación',
              'Si olvidas el PIN podrás recuperarlo con este código o con la contraseña de tu cuenta CactusNet. Anótalo y guárdalo lejos del alcance de los niños: no se volverá a mostrar.',
              code,
              [{ label: 'Ya lo anoté', fn: function () { closeModal(); toast('PIN creado. Contenido adulto bloqueado.'); afterLockChange(); if (done) done(); } }]);
            return null;
          }
        });
        return null;
      }
    });
  }

  // Recuperar el PIN. Dos formas, ambas con el mismo límite de intentos:
  //  1) el código de recuperación que se mostró al crear el PIN;
  //  2) la contraseña de la cuenta CactusNet, verificada contra el servidor (no contra lo guardado
  //     en el equipo), para quien perdió el código.
  // En ambos casos se crea un PIN nuevo y se genera un código nuevo.
  function recovered(ok) {
    createPin(function () { if (ok) { S.unlocked = true; afterLockChange(); ok(); } }, 'Crea tu PIN nuevo');
  }
  function recoverModal(ok) {
    var w = lockoutMin();
    if (w) { lockedMsg(w); return; }
    codeModal({
      title: 'Recuperar PIN',
      text: 'Escribe el código de recuperación que guardaste al crear el PIN (por ejemplo ABCD-2345).',
      extra: [{ label: 'No tengo el código', fn: function () { recoverByPassword(ok); } }],
      onCode: function (code) {
        if (normCode(code).length !== 8) return 'El código tiene 8 caracteres.';
        if (checkSecret('chash', 'csalt', normCode(code))) { recovered(ok); return null; }
        var w2 = lockoutMin();
        if (w2) { closeModal(); lockedMsg(w2); return null; }
        return 'Código incorrecto. Te quedan ' + triesLeft() + ' intentos.';
      }
    });
  }
  function recoverByPassword(ok) {
    var w = lockoutMin();
    if (w) { lockedMsg(w); return; }
    var busy = false;
    codeModal({
      title: 'Recuperar con tu cuenta',
      text: 'Escribe la contraseña de tu cuenta CactusNet (usuario ' + S.profile.user + '). La verificaremos con el servidor.',
      inputType: 'password', placeholder: 'Contraseña', maxLength: 64,
      onCode: function (pass) {
        if (busy) return null;
        if (!pass) return 'Escribe la contraseña.';
        busy = true;
        var opt = M.opt;
        $('mErr').textContent = 'Verificando…';
        new Sources.Xtream({ server: CONFIG.server, user: S.profile.user, pass: pass }).login().then(function () {
          busy = false;
          var p = par(); if (p) { p.fails = 0; p.lockUntil = 0; store.set(PKEY, p); }
          if (M.opt === opt) recovered(ok);
        }, function (err) {
          busy = false;
          if (M.opt !== opt) return;
          if (!/incorrect/.test(err.message)) {
            $('mErr').textContent = err.code === 'network'
              ? 'Para verificar la contraseña necesitas estar conectado al internet de CactusNet. También puedes usar el código de recuperación.'
              : 'No se pudo verificar: ' + err.message + '.';
            return;
          }
          var p = par(); if (p) registerFail(p);
          var w2 = lockoutMin();
          if (w2) { closeModal(); lockedMsg(w2); return; }
          $('mInput').value = '';
          $('mErr').textContent = 'Contraseña incorrecta. Te quedan ' + triesLeft() + ' intentos.';
        });
        return null;
      }
    });
  }

  /* --- ventana modal (PIN / código / aviso) --- */
  var M = { open: false, kind: '', opt: null, rows: [], r: 0, c: 0, pin: '' };
  var PAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];

  function buildPad() {
    var pad = $('mPad');
    PAD.forEach(function (v) {
      var k = el('div', v ? 'k f' : 'k blank', v === 'del' ? '' : v);
      if (v === 'del') k.innerHTML = '<svg viewBox="0 0 24 24"><path d="M22 3H7c-.7 0-1.2.3-1.6.9L0 12l5.4 8.1c.4.5.9.9 1.6.9h15c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-3 12.6L17.6 17 14 13.4 10.4 17 9 15.6l3.6-3.6L9 8.4 10.4 7l3.6 3.6L17.6 7 19 8.4 15.4 12z"/></svg>';
      if (v) {
        k.setAttribute('data-k', v);
        k.addEventListener('click', function () { padPress(v); });
      }
      pad.appendChild(k);
    });
  }
  function openModal(opt) {
    M.open = true; M.opt = opt; M.kind = opt.kind; M.pin = '';
    $('mTitle').textContent = opt.title || '';
    $('mText').textContent = opt.text || '';
    $('mCode').textContent = opt.code || '';
    $('mCode').classList.toggle('hidden', !opt.code);
    $('mErr').textContent = '';
    $('mDots').classList.toggle('hidden', opt.kind !== 'pin');
    $('mPad').classList.toggle('hidden', opt.kind !== 'pin');
    var inp = $('mInput');
    inp.classList.toggle('hidden', opt.kind !== 'code');
    inp.value = '';
    inp.type = opt.inputType || 'text';
    inp.maxLength = opt.maxLength || 9;
    inp.placeholder = opt.placeholder || 'XXXX-XXXX';
    inp.setAttribute('autocapitalize', opt.inputType === 'password' ? 'none' : 'characters');
    var bx = $('mBtns'); bx.innerHTML = '';
    var btnEls = (opt.buttons || []).map(function (b) {
      var x = el('div', 'mbtn f' + (b.primary ? ' primary' : ''), b.label);
      x.addEventListener('click', function () { b.fn(); });
      x._fn = b.fn;
      bx.appendChild(x);
      return x;
    });
    M.rows = [];
    if (opt.kind === 'pin') {
      var keys = qsa('#mPad .k.f');
      M.rows.push(keys.slice(0, 3), keys.slice(3, 6), keys.slice(6, 9), keys.slice(9, 11));
    }
    if (opt.kind === 'code') M.rows.push([inp]);
    bx.classList.toggle('vertical', !!opt.vertical);
    if (btnEls.length) { if (opt.vertical) btnEls.forEach(function (b) { M.rows.push([b]); }); else M.rows.push(btnEls); }
    M.r = opt.focus || 0; M.c = 0;
    $('modal').classList.remove('hidden');
    updateDots(); paintModal();
    if (opt.kind === 'code' && S.mode === 'mobile') setTimeout(function () { inp.focus(); }, 50);
  }
  function closeModal() {
    M.open = false;
    try { if (document.activeElement) document.activeElement.blur(); } catch (e) {}
    $('modal').classList.add('hidden');
  }
  function paintModal() {
    qsa('#modal .f').forEach(function (x) { x.classList.remove('focused'); });
    if (S.mode === 'mobile') return; // en móvil no hay foco de control remoto
    var row = M.rows[M.r]; if (!row) return;
    M.c = clamp(M.c, 0, row.length - 1);
    row[M.c].classList.add('focused');
  }
  function updateDots() {
    qsa('#mDots span').forEach(function (d, i) { d.classList.toggle('on', i < M.pin.length); });
  }
  function padPress(v) {
    if (v === 'del') { M.pin = M.pin.slice(0, -1); updateDots(); return; }
    if (M.pin.length >= 4) return;
    M.pin += v; $('mErr').textContent = ''; updateDots();
    if (M.pin.length === 4) {
      var opt = M.opt, pin = M.pin;
      setTimeout(function () {
        if (M.opt !== opt) return;
        var err = opt.onPin(pin);
        if (err && M.opt === opt) { M.pin = ''; updateDots(); $('mErr').textContent = err; }
      }, 160);
    }
  }
  function submitCode() {
    var opt = M.opt, err = opt.onCode($('mInput').value);
    if (err && M.opt === opt) $('mErr').textContent = err;
  }
  function pinModal(o) { o.kind = 'pin'; openModal(o); }
  function codeModal(o) {
    o.kind = 'code';
    o.buttons = [{ label: 'Verificar', fn: submitCode }].concat(o.extra || [], [{ label: 'Cancelar', fn: closeModal }]);
    openModal(o);
  }
  function msgModal(title, text, code, buttons) {
    openModal({ kind: 'info', title: title, text: text, code: code, buttons: buttons || [{ label: 'Entendido', fn: closeModal }] });
  }
  function modalKey(k, e) {
    var ae = document.activeElement;
    if (ae && ae.id === 'mInput') {
      if (k === KEY.ENTER) { ae.blur(); e.preventDefault(); submitCode(); return; }
      if (k === KEY.BACK || k === KEY.ESC) { ae.blur(); e.preventDefault(); return; }
      if (k !== KEY.UP && k !== KEY.DOWN) return;
      ae.blur();
    }
    if (M.kind === 'pin') {
      if (k >= 48 && k <= 57) { padPress(String(k - 48)); e.preventDefault(); return; }
      if (k >= 96 && k <= 105) { padPress(String(k - 96)); e.preventDefault(); return; }
      if (k === KEY.BKSP) { padPress('del'); e.preventDefault(); return; }
    }
    var row = M.rows[M.r];
    switch (k) {
      case KEY.UP: if (M.r > 0) { M.r--; M.c = Math.min(M.c, M.rows[M.r].length - 1); } break;
      case KEY.DOWN: if (M.r < M.rows.length - 1) { M.r++; M.c = Math.min(M.c, M.rows[M.r].length - 1); } break;
      case KEY.LEFT: M.c--; break;
      case KEY.RIGHT: M.c++; break;
      case KEY.ENTER:
        var x = row && row[clamp(M.c, 0, row.length - 1)];
        if (!x) break;
        if (x.getAttribute('data-k')) padPress(x.getAttribute('data-k'));
        else if (x.id === 'mInput') x.focus();
        else if (x._fn) x._fn();
        break;
      case KEY.BACK: case KEY.ESC: if (!(M.opt && M.opt.locked)) closeModal(); break;
      default: return;
    }
    if (M.open) paintModal();
    e.preventDefault();
  }

  /* ============================ AJUSTES ============================ */
  function settingsCats() {
    var out = [];
    if (!IS_WEBOS) out.push({ id: 'mode', name: 'Modo: ' + (S.mode === 'mobile' ? 'Celular / tablet' : 'Televisor') });
    if (S.mode === 'mobile' && canPip()) out.push({ id: 'pip', name: 'Ventana flotante al salir: ' + (S.settings.pip ? 'Sí' : 'No') });
    // Interruptor: los canales para adultos solo se ven si está activado (pide el PIN; si no hay, se crea).
    out.push({ id: 'adult', name: 'Canales para adultos: ' + (S.unlocked ? 'Visibles' : 'Ocultos') });
    if (pinSet()) {
      out.push({ id: 'pinchange', name: 'Cambiar PIN' });
      out.push({ id: 'pinoff', name: 'Quitar PIN' });
    }
    if (hasAndroidPlayer()) out.push({ id: 'andplayer', name: 'Reproductor: ' + PLAYER_NAMES[playerMode()] });
    if (!androidPlayerOn()) {
      if (S.src.kind === 'xtream') out.push({ id: 'fmt', name: 'Formato en vivo: ' + (S.settings.liveFmt === 'ts' ? 'MPEG-TS (.ts)' : 'HLS (.m3u8)') });
      out.push({ id: 'engine', name: 'Reproductor web: ' + (S.settings.engine === 'native' ? 'Nativo del equipo' : 'hls.js') });
    }
    out.push({ id: 'reload', name: 'Actualizar canales ahora' });
    if (canUpdate()) out.push({ id: 'update', name: 'Buscar nueva versión de la app' });
    out.push({ id: 'logout', name: 'Cerrar sesión' });
    return out;
  }
  function showInfo() {
    var rows = S.src.infoRows().filter(function (kv) { return kv[0] !== 'Servidor'; })
      .map(function (kv) { return { type: 'info', k: kv[0], v: kv[1] }; });
    rows.push({ type: 'info', k: 'Canales para adultos', v: S.unlocked ? 'Visibles' : 'Ocultos (se activan en Ajustes con el PIN)' });
    rows.push({ type: 'info', k: 'Versión', v: CONFIG.version });
    setItems(rows, 'Cuenta', '');
    $('itemsTitle').textContent = 'Cuenta';
  }
  function refreshSettings() {
    if (curSec() !== 'settings') return;
    var keep = S.catIdx;
    S.cats = settingsCats(); renderCats();
    S.catIdx = clamp(keep, 0, S.cats.length - 1);
    showInfo(); paint();
  }
  function runSetting(c) {
    if (!c) return;
    switch (c.id) {
      case 'mode':
        S.mode = S.mode === 'mobile' ? 'tv' : 'mobile';
        store.set('iptv.mode', S.mode); applyMode();
        S.col = 1; refreshSettings(); paintLogin();
        toast(S.mode === 'mobile' ? 'Modo celular / tablet' : 'Modo televisor');
        return;
      case 'pip': S.settings.pip = !S.settings.pip; break;
      case 'pinnew': createPin(refreshSettings); return;
      case 'pinchange':
        requirePin('PIN actual', function () { createPin(refreshSettings, 'Escribe tu PIN nuevo'); }, { always: true });
        return;
      case 'pinoff':
        requirePin('Quitar PIN', function () { store.del(PKEY); relock(); S.unlocked = false; toast('PIN eliminado. El contenido para adultos sigue bloqueado.'); refreshSettings(); }, { always: true });
        return;
      case 'adult':
        if (S.unlocked) { relock(); toast('Canales para adultos ocultos'); refreshSettings(); }
        else unlockAdult(refreshSettings);
        return;
      case 'fmt':
        S.settings.liveFmt = S.settings.liveFmt === 'ts' ? 'm3u8' : 'ts';
        S.src.liveFmt = S.settings.liveFmt;
        break;
      case 'engine': S.settings.engine = S.settings.engine === 'native' ? 'hlsjs' : 'native'; break;
      case 'andplayer':
        var modes = hasVlc() ? ['vlc', 'android', 'web'] : ['android', 'web'];
        S.settings.player = modes[(modes.indexOf(playerMode()) + 1) % modes.length];
        delete S.settings.andPlayer;
        break;
      case 'reload': startSession(S.profile, false); return;
      case 'update': checkUpdate(true); return;
      case 'logout':
        store.del('iptv.profile');
        S.src = null; S.unlocked = false;
        $('xPass').value = '';
        showLogin();
        return;
    }
    store.set('iptv.settings', S.settings);
    refreshSettings();
  }

  /* ============================ REPRODUCTOR ============================ */
  var P = { hls: null, list: [], idx: 0, item: null, sec: '', catId: null, url: '', triedTs: false, active: false, zapT: null, osdT: null };
  var video = null;

  function spinner(on) { $('spinner').classList.toggle('hidden', !on); }

  function play(list, idx) {
    P.list = list.filter(function (x) { return x.type !== 'info' && x.type !== 'series'; });
    var it = list[idx];
    P.idx = Math.max(0, P.list.indexOf(it));
    P.sec = curSec();
    P.catId = S.cats[S.catIdx] ? S.cats[S.catIdx].id : null;
    show('player');
    if (S.mode === 'mobile') {
      nat('setOrientation', 6);
      nat('setPipAllowed', !!S.settings.pip);
    }
    $('mPip').classList.toggle('hidden', !(S.mode === 'mobile' && canPip()));
    startStream();
  }

  /* --- Motores de reproducción ---
     Android (app nativa): reproductor de Android (VideoView), que usa el decodificador del equipo
     y reproduce MPEG-2, H.264, H.265, MP2, AC3… según lo que soporte el TV box o celular.
     Si falla, se prueba solo con otro formato y, como último recurso, con el reproductor web. */
  function hasAndroidPlayer() { return !!(window.CactusNative && window.CactusNative.playNative); }
  function hasVlc() { return !!(window.CactusNative && window.CactusNative.playVlc); }
  function natName() { return (window.CactusNative && window.CactusNative.nativeName) || 'Android'; }
  var PLAYER_NAMES = { vlc: 'VLC (recomendado)', android: natName(), web: 'Web' };
  // 'vlc' | 'android' | 'web'. VLC decodifica por software lo que el equipo no soporta (MPEG-2 en celulares).
  function playerMode() {
    if (!hasAndroidPlayer()) return 'web';
    var m = S.settings.player || (S.settings.andPlayer === false ? 'web' : (hasVlc() ? 'vlc' : 'android'));
    if (m === 'vlc' && !hasVlc()) m = 'android';
    return m;
  }
  function androidPlayerOn() { return playerMode() !== 'web'; }
  function isHls(u) { return /\.m3u8(\?|$)/i.test(u); }
  function asTs(u) { return u.replace(/\.m3u8(\?|$)/i, '.ts$1'); }
  function asHls(u) { return u.replace(/\.ts(\?|$)/i, '.m3u8$1'); }

  // Lista de intentos para el contenido actual: [{ engine: 'android'|'web', url }]
  function buildPlan(url) {
    var plan = [], xtLive = P.item.type === 'live' && S.src.kind === 'xtream';
    var mode = playerMode();
    function add(vlc) {
      if (xtLive) plan.push({ engine: 'android', vlc: vlc, url: asTs(url) }, { engine: 'android', vlc: vlc, url: asHls(asTs(url)) });
      else plan.push({ engine: 'android', vlc: vlc, url: url });
    }
    if (mode === 'vlc') { add(true); add(false); }
    else if (mode === 'android') { add(false); if (hasVlc()) add(true); }
    if (xtLive) {
      var first = S.settings.liveFmt === 'ts' ? asTs(url) : asHls(asTs(url));
      plan.push({ engine: 'web', url: first }, { engine: 'web', url: isHls(first) ? asTs(first) : asHls(first) });
    } else plan.push({ engine: 'web', url: url });
    return plan;
  }

  function startStream() {
    stopStream();
    P.item = P.list[P.idx];
    P.active = true;
    P.npaused = false;
    if (P.item.type === 'live' && S.lastKey) store.set(S.lastKey, { cat: P.catId, item: P.item });
    P.plan = buildPlan(S.src.url(P.item));
    P.step = 0; P.trail = []; P.engineInfo = '';
    loadStep();
    showOsd();
  }

  function stepName(s) {
    var f = /\.m3u8(\?|$)/i.test(s.url) ? 'HLS' : (/\.ts(\?|$)/i.test(s.url) ? 'TS' : 'archivo');
    return (s.vlc ? 'VLC' : (s.engine === 'android' ? natName() : 'Web')) + ' ' + f;
  }
  // Muestra en la barra del canal qué reproductor quedó y qué intentos fallaron (diagnóstico).
  function showEngine() {
    var s = P.plan && P.plan[P.step];
    if (!s) return;
    P.engineInfo = (P.trail && P.trail.length ? P.trail.join(' · ') + ' → ' : '') + stepName(s);
    if (osdVisible()) $('osdEngine').textContent = P.engineInfo;
  }
  function loadStep() {
    var s = P.plan[P.step];
    P.engine = s.engine;
    if (s.engine === 'android') loadAndroid(s.url, s.vlc); else load(s.url);
  }

  // Si el reproductor nativo no muestra imagen en 15 s, se pasa al siguiente intento.
  function armWatchdog() {
    clearTimeout(P.dog);
    var step = P.step;
    P.dog = setTimeout(function () { if (P.active && P.step === step && !P.started) fail('tiempo agotado'); }, 20000);
  }

  function loadAndroid(url, vlc) {
    P.url = url; P.started = false;
    $('playerMsg').textContent = '';
    spinner(true);
    htmlCls('native-video', true);
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) {}
    nat(vlc ? 'playVlc' : 'playNative', url);
    armWatchdog();
  }

  // Eventos del reproductor nativo de Android
  window.__cactusNative = function (ev, n) {
    if (!P.active || P.engine !== 'android') return;
    if (ev === 'playing') {
      P.started = true; clearTimeout(P.dog);
      showEngine();
      spinner(false); $('playerMsg').textContent = '';
      $('mPlayIc').setAttribute('d', P.npaused ? ICONS.play : ICONS.pause);
    } else if (ev === 'prepared') {
      P.started = true; clearTimeout(P.dog);
      spinner(false); $('playerMsg').textContent = '';
      showEngine();
    } else if (ev === 'buffering') {
      spinner(true);
    } else if (ev === 'error') {
      fail('código ' + n);
    } else if (ev === 'ended') {
      // En vivo: el servidor cortó la conexión; volver a conectar el mismo canal.
      if (P.item && P.item.type === 'live') {
        P.retries = (P.retries || 0) + 1;
        if (P.retries <= 3) { spinner(true); setTimeout(function () { if (P.active) loadStep(); }, 1500); return; }
        fail('conexión cerrada');
      } else { P.npaused = true; showOsd(true); }
    }
  };

  function useHlsJs(url) {
    return S.settings.engine !== 'native' && /\.m3u8(\?|$)/i.test(url) && window.Hls && Hls.isSupported();
  }

  function load(url) {
    P.url = url;
    $('playerMsg').textContent = '';
    spinner(true);
    if (useHlsJs(url)) {
      var h = new Hls({ maxBufferLength: 30, backBufferLength: 30, enableWorker: true });
      var recovered = 0;
      P.hls = h;
      h.on(Hls.Events.MANIFEST_PARSED, function () { tryPlay(); });
      h.on(Hls.Events.ERROR, function (ev, data) {
        if (!data.fatal || h !== P.hls) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recovered++ < 2) { h.recoverMediaError(); return; }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recovered++ < 2 && data.details !== 'manifestLoadError') { h.startLoad(); return; }
        fail(data.details);
      });
      h.loadSource(url);
      h.attachMedia(video);
    } else {
      video.src = url;
      video.load();
      tryPlay();
    }
  }
  function tryPlay() {
    try { var pr = video.play(); if (pr && pr.catch) pr.catch(function () {}); } catch (e) {}
  }

  // Un intento falló: pasar al siguiente de la lista (otro formato u otro reproductor).
  function fail(why) {
    if (!P.active) return;
    clearTimeout(P.dog);
    P.lastWhy = why;
    if (P.plan && P.plan[P.step]) P.trail.push(stepName(P.plan[P.step]) + ' ✗ ' + why);
    if (P.plan && P.step < P.plan.length - 1) {
      stopEngines();
      P.step++;
      loadStep();
      return;
    }
    stopEngines();
    spinner(false);
    P.engineInfo = P.trail.join(' · ');
    $('playerMsg').textContent = 'Este canal no está disponible en este momento.\nPrueba de nuevo en unos minutos o elige otro canal. Si el problema sigue, comunícate al ' + CONFIG.supportPhone + '.';
  }

  function destroyHls() { if (P.hls) { try { P.hls.destroy(); } catch (e) {} P.hls = null; } }

  function stopEngines() {
    clearTimeout(P.dog);
    if (P.engine === 'android' || document.documentElement.classList.contains('native-video')) {
      nat('stopNative');
      htmlCls('native-video', false);
    }
    destroyHls();
    try { video.pause(); } catch (e) {}
    video.removeAttribute('src');
    try { video.load(); } catch (e) {}
  }

  function stopStream() {
    P.active = false;
    P.retries = 0;
    stopEngines();
    P.engine = null;
    spinner(false);
  }

  // Estado del video sin importar el motor (nativo de Android o web)
  function vPaused() { return P.engine === 'android' ? !!P.npaused : video.paused; }
  function vTime() { if (P.engine === 'android') { var t = nat('nativePosition'); return (t || 0) / 1000; } return video.currentTime; }
  function vDur() {
    if (P.engine === 'android') { var d = nat('nativeDuration'); return d > 0 ? d / 1000 : NaN; }
    return video.duration;
  }
  function vSeekTo(sec) { if (P.engine === 'android') nat('seekNative', Math.round(sec * 1000)); else video.currentTime = sec; }
  function vPlay() {
    if (P.engine === 'android') { P.npaused = false; nat('resumeNative'); $('mPlayIc').setAttribute('d', ICONS.pause); }
    else tryPlay();
  }
  function vPause() {
    if (P.engine === 'android') { P.npaused = true; nat('pauseNative'); $('mPlayIc').setAttribute('d', ICONS.play); }
    else video.pause();
  }

  function findById(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return i;
    return -1;
  }

  function exitPlayer() {
    clearTimeout(P.zapT);
    closeList();
    stopStream();
    hideOsd();
    $('playerMsg').textContent = '';
    nat('setPipAllowed', false);
    show('browser');
    if (S.mode === 'mobile') nat('setOrientation', -1);
    var target = P.item;
    var curCat = S.cats[S.catIdx] ? S.cats[S.catIdx].id : null;
    // Si desde la lista de canales se cambió a otra categoría, volver a esa categoría
    // con el último canal visto seleccionado.
    if (target && P.sec === curSec() && P.catId != null && P.catId !== curCat) {
      for (var j = 0; j < S.cats.length; j++) if (S.cats[j].id === P.catId) {
        S.catIdx = j; S.col = 2; renderCats();
        S.after = function () { var a = findById(S.items, target.id); if (a >= 0) { S.itemIdx = 0; moveItem(a); } paint(); };
        S.loadedKey = null; loadItems(); paint();
        return;
      }
    }
    var at = target ? findById(S.items, target.id) : -1;
    if (at >= 0) { S.itemIdx = 0; moveItem(at); }
    paint();
  }

  /* --- Lista de canales sobre el video ---
     Se abre con OK (TV) o con el botón de lista (celular) y deja el canal actual sonando.
     ▲▼ elige, OK cambia de canal (la lista sigue abierta), ◀▶ cambia de categoría,
     ATRÁS la cierra. Se cierra sola tras unos segundos sin usarla. */
  var CL = { open: false, items: [], idx: 0, shown: 0, els: [], prev: -1, catId: null, timer: null, req: 0 };

  function clCats() { // categorías que se pueden recorrer desde la lista (sin adultos bloqueados)
    if (P.sec !== curSec()) return [];
    return S.cats.filter(function (c) { return !(c.adult && lockedNow()); });
  }
  function clCatName(id) {
    for (var i = 0; i < S.cats.length; i++) if (S.cats[i].id === id) return S.cats[i].name;
    return 'Canales';
  }
  function openList() {
    if (!P.item || P.item.type !== 'live' || S.inPip) return;
    CL.open = true; CL.catId = P.catId; CL.items = P.list.slice();
    hideOsd();
    $('chList').classList.remove('hidden');
    $('chlPrev').style.visibility = $('chlNext').style.visibility = clCats().length > 1 ? '' : 'hidden';
    clRender(findById(CL.items, P.item.id), true);
    clTouch();
  }
  function closeList() {
    if (!CL.open) return;
    CL.open = false; CL.req++;
    clearTimeout(CL.timer);
    $('chList').classList.add('hidden');
    if (S.screen === 'player' && !S.inPip) showOsd(); // mostrar un momento qué canal quedó
  }
  function clTouch() {
    clearTimeout(CL.timer);
    CL.timer = setTimeout(closeList, S.mode === 'mobile' ? 20000 : 12000);
  }
  function clRow(it, i) {
    var r = el('div', 'chl-row');
    r.appendChild(el('span', 'chl-num', String(it.num || i + 1)));
    var lg = el('span', 'chl-logo');
    if (it.logo) {
      var img = document.createElement('img');
      img.onerror = function () { lg.innerHTML = ''; };
      img.src = it.logo; lg.appendChild(img);
    }
    r.appendChild(lg);
    r.appendChild(el('span', 'chl-name', it.name));
    if (isFav(it, P.sec)) r.appendChild(el('span', 'chl-star', '★'));
    if (P.item && it.id === P.item.id) { r.className += ' now'; r.appendChild(el('span', 'chl-live', 'EN VIVO')); }
    r.setAttribute('data-idx', String(i));
    return r;
  }
  function clAppend(upto) {
    var end = Math.min(CL.items.length, Math.max(upto, CL.shown + 60));
    var frag = document.createDocumentFragment();
    for (var i = CL.shown; i < end; i++) { var r = clRow(CL.items[i], i); frag.appendChild(r); CL.els.push(r); }
    $('chlItems').appendChild(frag);
    CL.shown = end;
  }
  function clCenter(e) {
    var box = $('chlItems');
    if (e) box.scrollTop = Math.max(0, e.offsetTop - box.clientHeight / 2 + e.offsetHeight / 2);
  }
  function clRender(sel, center) {
    $('chlCat').textContent = clCatName(CL.catId);
    var box = $('chlItems');
    box.innerHTML = ''; box.scrollTop = 0;
    CL.els = []; CL.shown = 0; CL.prev = -1;
    CL.idx = clamp(sel < 0 ? 0 : sel, 0, Math.max(0, CL.items.length - 1));
    if (!CL.items.length) { box.appendChild(el('div', 'chl-empty', 'No hay canales en esta categoría.')); return; }
    clAppend(CL.idx + 30);
    clPaint(!center && S.mode === 'mobile');
    if (center && S.mode === 'mobile') clCenter(CL.els[CL.idx]);
  }
  function clPaint(noScroll) {
    if (CL.prev >= 0 && CL.els[CL.prev]) CL.els[CL.prev].classList.remove('focused');
    CL.prev = -1;
    if (S.mode !== 'tv') return; // en celular no hay cursor del control
    var e = CL.els[CL.idx];
    if (!e) return;
    e.classList.add('focused'); CL.prev = CL.idx;
    if (!noScroll) clCenter(e);
  }
  function clMove(d) {
    if (!CL.items.length) return;
    var i = clamp(CL.idx + d, 0, CL.items.length - 1);
    if (i >= CL.shown - 5) clAppend(i + 30);
    CL.idx = i; clPaint(); clTouch();
  }
  function clCat(d) {
    var cats = clCats();
    if (cats.length < 2) return;
    clTouch();
    var pos = 0;
    for (var j = 0; j < cats.length; j++) if (cats[j].id === CL.catId) { pos = j; break; }
    var c = cats[(pos + d + cats.length) % cats.length];
    CL.catId = c.id; CL.items = []; CL.els = []; CL.shown = 0; CL.prev = -1;
    $('chlCat').textContent = c.name;
    var box = $('chlItems'); box.innerHTML = ''; box.appendChild(el('div', 'chl-empty', 'Cargando…'));
    var id = ++CL.req;
    var pr = c.id === 'fav' ? Promise.resolve((S.favs[P.sec] || []).slice()) : S.src.items(P.sec, c.id);
    pr.then(function (list) {
      if (id !== CL.req || !CL.open) return;
      CL.items = filterAdult(list, P.sec).filter(function (x) { return x.type === 'live'; });
      clRender(findById(CL.items, P.item.id), true);
    }, function (err) {
      if (id !== CL.req) return;
      box.innerHTML = ''; box.appendChild(el('div', 'chl-empty', loadErrorText(err, 'los canales')));
    });
  }
  function clChoose(i) {
    var it = CL.items[i];
    if (!it) return;
    clTouch();
    if (P.item && it.id === P.item.id) { closeList(); return; } // OK sobre el canal actual: cerrar
    clearTimeout(P.zapT);
    P.list = CL.items.slice(); P.idx = i; P.catId = CL.catId;
    startStream();
    var keep = $('chlItems').scrollTop;
    clRender(i, false);                       // marcar el nuevo canal como "EN VIVO"
    if (S.mode === 'mobile') $('chlItems').scrollTop = keep;
  }
  function listKey(k, e) {
    switch (k) {
      case KEY.UP: clMove(-1); break;
      case KEY.DOWN: clMove(1); break;
      case KEY.CHUP: clMove(-10); break;
      case KEY.CHDN: clMove(10); break;
      case KEY.LEFT: clCat(-1); break;
      case KEY.RIGHT: clCat(1); break;
      case KEY.ENTER: clChoose(CL.idx); break;
      case KEY.RED:
        if (CL.items[CL.idx]) { toggleFav(CL.items[CL.idx], P.sec); clRender(CL.idx, false); clTouch(); }
        break;
      case KEY.BACK: case KEY.ESC: case KEY.BKSP: closeList(); break;
      default: return;
    }
    e.preventDefault();
  }
  function bindChannelList() {
    var box = $('chlItems');
    function rowOf(t) { while (t && t !== box && !(t.getAttribute && t.getAttribute('data-idx'))) t = t.parentNode; return t && t !== box ? t : null; }
    box.addEventListener('click', function (e) { e.stopPropagation(); var r = rowOf(e.target); if (r) clChoose(+r.getAttribute('data-idx')); });
    box.addEventListener('mouseover', function (e) { // Magic Remote
      if (S.mode !== 'tv') return;
      var r = rowOf(e.target); if (!r) return;
      CL.idx = +r.getAttribute('data-idx'); clPaint(true); clTouch();
    });
    box.addEventListener('scroll', function () {
      clTouch();
      if (CL.shown < CL.items.length && box.scrollTop + box.clientHeight > box.scrollHeight - 400) clAppend(CL.shown + 60);
    });
    $('chlPrev').addEventListener('click', function (e) { e.stopPropagation(); clCat(-1); });
    $('chlNext').addEventListener('click', function (e) { e.stopPropagation(); clCat(1); });
    $('chlClose').addEventListener('click', function (e) { e.stopPropagation(); closeList(); });
    $('chList').addEventListener('click', function (e) { e.stopPropagation(); });
  }

  function zap(d) {
    if (P.list.length < 2) return;
    P.idx = (P.idx + d + P.list.length) % P.list.length;
    P.item = P.list[P.idx];
    stopStream();
    showOsd();
    spinner(true);
    clearTimeout(P.zapT);
    P.zapT = setTimeout(startStream, 550); // permite pasar varios canales seguidos
  }

  function seek(sec) {
    var d = vDur();
    if (!isFinite(d)) return;
    vSeekTo(clamp(vTime() + sec, 0, d - 1));
    showOsd();
  }
  function togglePause() {
    if (vPaused()) { vPlay(); showOsd(); } else { vPause(); showOsd(true); }
  }

  function showOsd(sticky) {
    var it = P.item;
    if (!it || S.inPip || CL.open) return;
    var live = it.type === 'live';
    $('mList').classList.toggle('hidden', !live);
    $('osdNum').textContent = live ? String(it.num || P.idx + 1) : '';
    $('osdName').textContent = it.name;
    var fav = it.type !== 'episode' && isFav(it, P.sec);
    $('osdFav').textContent = fav ? '★' : '';
    $('mFav').classList.toggle('on', fav);
    $('mFav').classList.toggle('hidden', it.type === 'episode');
    $('osdClock').textContent = clock();
    var cat = null;
    for (var i = 0; i < S.cats.length; i++) if (S.cats[i].id === P.catId) { cat = S.cats[i]; break; }
    $('osdEngine').textContent = P.engineInfo || '';
    $('osdSub').textContent = it.series ? it.series : (it.group ? it.group : (cat ? cat.name : ''));
    $('osdProgress').classList.toggle('hidden', live);
    $('osdHint').textContent = live
      ? '▲▼ / CH  Cambiar canal    ·    OK  Lista de canales    ·    ◀ ▶  Opciones (idioma, subtítulos, favorito)    ·    ATRÁS  Salir'
      : 'OK  Pausa    ·    ◀ ▶  10 s    ·    ⏪ ⏩  1 min    ·    ATRÁS  Salir';
    $('mPlayIc').setAttribute('d', vPaused() ? ICONS.play : ICONS.pause);
    updateProgress();
    $('osd').classList.remove('hidden');
    clearTimeout(P.osdT);
    if (!sticky) P.osdT = setTimeout(function () { if (!vPaused() || live) hideOsd(); }, S.mode === 'mobile' ? 4000 : 4500);
  }
  function hideOsd() { $('osd').classList.add('hidden'); }
  function osdVisible() { return !$('osd').classList.contains('hidden'); }
  function updateProgress() {
    var d = vDur(), c = vTime();
    $('osdCur').textContent = fmtTime(c);
    $('osdDur').textContent = isFinite(d) ? fmtTime(d) : '--:--';
    $('osdBar').style.width = (isFinite(d) && d > 0 ? (c / d * 100) : 0) + '%';
  }

  /* --- Idiomas (audio) y subtítulos ---
     Con VLC se leen las pistas del canal; con el reproductor web, las pistas de audio de hls.js.
     type 0 = audio, 1 = subtítulos. */
  var LANGS = { spa: 'Español', es: 'Español', esp: 'Español', eng: 'Inglés', en: 'Inglés', por: 'Portugués', pt: 'Portugués',
    fra: 'Francés', fre: 'Francés', fr: 'Francés', ita: 'Italiano', it: 'Italiano', deu: 'Alemán', ger: 'Alemán', de: 'Alemán', qaa: 'Original', und: 'Sin especificar' };
  function trackLabel(name, type, id, n) {
    if (type === 1 && id < 0) return 'Desactivados';
    var m = /\[([^\]]+)\]/.exec(name || ''), lang = m ? m[1] : '';
    var nice = LANGS[lang.toLowerCase()] || lang;
    var extra = (name || '').replace(/\[[^\]]*\]/g, '').replace(/^(Track|Pista)\s*\d+\s*-?\s*/i, '').trim();
    return (nice || ((type === 0 ? 'Audio ' : 'Subtítulos ') + n)) + (extra ? ' (' + extra + ')' : '');
  }
  function trackMenu(type) {
    var s = P.plan && P.plan[P.step], opts = [], cur = null, apply = null, i;
    if (P.engine === 'android' && s) {
      var raw = String(nat(s.vlc ? 'vlcTracks' : 'nativeTracks', type) || ''), lines = raw.split('\n');
      cur = parseInt(lines[0], 10);
      for (i = 1; i < lines.length; i++) {
        var p = lines[i].split('\t'), id = parseInt(p[0], 10);
        if (isNaN(id) || (type === 0 && id < 0)) continue;
        opts.push({ id: id, name: trackLabel(p[1], type, id, opts.length + 1) });
      }
      apply = function (id) { try { window.CactusNative[s.vlc ? 'setVlcTrack' : 'setNativeTrack'](type, id); } catch (e) {} };
    } else if (P.engine === 'web' && P.hls && type === 0 && P.hls.audioTracks) {
      P.hls.audioTracks.forEach(function (t, j) { opts.push({ id: j, name: trackLabel('[' + (t.lang || '') + ']' + (t.name || ''), 0, j, j + 1) }); });
      cur = P.hls.audioTrack;
      apply = function (id) { P.hls.audioTrack = id; };
    }
    var real = opts.filter(function (o) { return o.id >= 0; }).length;
    if (type === 0 && real < 2) { toast(P.started ? 'Este canal tiene un solo idioma' : 'Espera a que cargue el canal'); return; }
    if (type === 1 && real < 1) { toast(P.started ? 'Este canal no tiene subtítulos' : 'Espera a que cargue el canal'); return; }
    var focus = 0;
    var buttons = opts.map(function (o, j) {
      if (o.id === cur) focus = j;
      return { label: (o.id === cur ? '✓ ' : '') + o.name, primary: o.id === cur,
        fn: function () { closeModal(); apply(o.id); toast((type === 0 ? 'Idioma: ' : 'Subtítulos: ') + o.name); } };
    });
    hideOsd();
    openModal({ kind: 'info', title: type === 0 ? 'Idioma del audio' : 'Subtítulos', text: '', buttons: buttons, vertical: true, focus: focus });
  }

  // Menú de opciones del canal (para controles sin botones de colores): ▶ o MENÚ
  function optionsMenu() {
    var it = P.item; if (!it) return;
    var fav = it.type !== 'episode' && isFav(it, P.sec);
    var b = [
      { label: 'Idioma del audio', fn: function () { closeModal(); trackMenu(0); } },
      { label: 'Subtítulos', fn: function () { closeModal(); trackMenu(1); } }
    ];
    if (it.type !== 'episode') b.push({ label: fav ? 'Quitar de favoritos' : 'Agregar a favoritos', fn: function () { closeModal(); toggleFav(it, P.sec); showOsd(); } });
    if (it.type === 'live') b.push({ label: 'Lista de canales', fn: function () { closeModal(); openList(); } });
    b.push({ label: 'Cerrar', fn: closeModal });
    hideOsd();
    openModal({ kind: 'info', title: it.name, text: '', buttons: b, vertical: true });
  }

  function playerKey(k, e) {
    var it = P.item, live = it && it.type === 'live';
    if (CL.open) { listKey(k, e); return; }
    switch (k) {
      case KEY.BACK: case KEY.ESC: case KEY.BKSP: case KEY.STOP:
        if (osdVisible() && !live && S.mode !== 'mobile') hideOsd(); else exitPlayer();
        break;
      case KEY.UP: case KEY.CHUP:
        if (live || k === KEY.CHUP) zap(1); else showOsd();
        break;
      case KEY.DOWN: case KEY.CHDN:
        if (live || k === KEY.CHDN) zap(-1); else showOsd();
        break;
      case KEY.LEFT: if (live) optionsMenu(); else seek(-10); break;
      case KEY.RIGHT: if (live) optionsMenu(); else seek(10); break;
      case KEY.RW: seek(-60); break;
      case KEY.FF: seek(60); break;
      case KEY.ENTER: case KEY.PLAYPAUSE: case KEY.PLAY: case KEY.PAUSE:
        if (live && k === KEY.ENTER) {
          openList();
        } else if (k === KEY.PAUSE || (k !== KEY.PLAY && !vPaused())) {
          vPause(); showOsd(true);
        } else { vPlay(); showOsd(); }
        break;
      case KEY.RED: toggleFav(it, P.sec); showOsd(); break;
      case KEY.YELLOW: trackMenu(0); break;
      case KEY.BLUE: optionsMenu(); break;
      case KEY.GREEN: trackMenu(1); break;
      default: return;
    }
    e.preventDefault();
  }

  function bindPlayerTouch() {
    function tap(id, fn) { $(id).addEventListener('click', function (e) { e.stopPropagation(); fn(); }); }
    tap('mBack', exitPlayer);
    tap('mPrev', function () { if (P.item.type === 'live') zap(-1); else seek(-10); });
    tap('mNext', function () { if (P.item.type === 'live') zap(1); else seek(10); });
    tap('mPlay', togglePause);
    tap('mFav', function () { toggleFav(P.item, P.sec); showOsd(); });
    tap('mPip', function () { closeList(); nat('enterPip'); });
    tap('mList', function () { hideOsd(); openList(); });
    tap('mLang', function () { trackMenu(0); });
    bindChannelList();
    $('osdBarWrap').addEventListener('click', function (e) {
      e.stopPropagation();
      if (!isFinite(vDur())) return;
      var r = this.getBoundingClientRect();
      vSeekTo(clamp((e.clientX - r.left) / r.width, 0, 1) * vDur());
      showOsd();
    });
    $('osd').addEventListener('click', function () { if (S.mode === 'mobile') hideOsd(); });
    $('player').addEventListener('click', function (e) {
      if (e.target !== video && e.target !== $('player')) return;
      if (CL.open) { closeList(); return; }
      if (S.mode === 'mobile') { if (osdVisible()) hideOsd(); else showOsd(vPaused()); return; }
      if (P.item && P.item.type !== 'live') togglePause(); else showOsd();
    });
  }

  /* ============================ SEGUNDO PLANO ============================ */
  function onHidden() { if (!S.hiddenAt) S.hiddenAt = Date.now(); }
  function onVisible() {
    if (!S.hiddenAt) return;
    var away = (Date.now() - S.hiddenAt) / 60000;
    S.hiddenAt = 0;
    if (away >= CONFIG.relockAfterMin) relock();
    if (away >= CONFIG.refreshAfterMin) softRefresh();
  }
  // Volver a pedir los datos al servidor sin interrumpir lo que se está viendo.
  function softRefresh() {
    if (!S.src || !S.profile) return;
    S.src.login().then(function () {
      if (S.screen !== 'browser' || curSec() === 'settings') return;
      var cid = S.cats[S.catIdx] ? S.cats[S.catIdx].id : null, keep = S.itemIdx;
      selectSection(S.secIdx, { catId: cid, then: function () { if (keep) { S.itemIdx = 0; moveItem(keep); } } });
      toast('Canales actualizados');
    }, function () {});
  }

  /* ============================ ENTRADA ============================ */
  function handleKey(k, e) {
    if (!$('loading').classList.contains('hidden')) { e.preventDefault(); return; }
    if (M.open) { modalKey(k, e); return; }
    if (k === KEY.BKSP && document.activeElement && document.activeElement.tagName === 'INPUT') return;
    if (S.screen === 'chooser') chooserKey(k, e);
    else if (S.screen === 'login') loginKey(k, e);
    else if (S.screen === 'browser') browserKey(k, e);
    else if (S.screen === 'player') playerKey(k, e);
  }
  document.addEventListener('keydown', function (e) { handleKey(e.keyCode, e); }, false);

  // Ganchos llamados por la app nativa de Android
  window.__cactusKey = function (k) { handleKey(k, { preventDefault: function () {} }); };
  window.__cactusToast = function (t) { toast(t); };
  window.__cactusPause = function () {
    if (S.screen === 'player' && video && !S.inPip && P.active) vPause();
    onHidden();
  };
  // Al volver a la app con un canal abierto, reconectarlo (en vivo no tiene sentido seguir pausado).
  window.__cactusResume = function () {
    onVisible();
    if (P.resumeOnShow && S.screen === 'player') { P.resumeOnShow = false; startStream(); }
  };
  // La app dejó de verse (incluido cerrar la ventana flotante): detener el video y la descarga.
  window.__cactusStop = function () {
    if (S.inPip) { S.inPip = false; htmlCls('in-pip', false); }
    if (S.screen === 'player' && P.active) { P.resumeOnShow = true; stopStream(); }
    onHidden();
  };
  window.__cactusPip = function (on) {
    S.inPip = !!on;
    htmlCls('in-pip', S.inPip);
    if (S.inPip) { closeList(); hideOsd(); } else showOsd();
  };
  window.addEventListener('resize', fit);

  // Puntero (Magic Remote / ratón) y toques
  function bindList(id) {
    var list = $(id);
    list.addEventListener('mouseover', function (e) {
      if (S.mode !== 'tv') return;
      var r = e.target;
      while (r && r !== list && !r.getAttribute('data-col')) r = r.parentNode;
      if (!r || r === list) return;
      var col = +r.getAttribute('data-col'), idx = +r.getAttribute('data-idx');
      if (col === 2 && S.items[idx] && S.items[idx].type === 'info') return;
      S.col = col;
      if (col === 0) S.secIdx = idx; else if (col === 1) S.catIdx = idx; else S.itemIdx = idx;
      paint(true);
    });
    list.addEventListener('click', function (e) {
      var r = e.target, onFav = false;
      while (r && r !== list && !(r.getAttribute && r.getAttribute('data-col'))) {
        if (r.getAttribute && /favbtn/.test(r.getAttribute('class') || '')) onFav = true;
        r = r.parentNode;
      }
      if (!r || r === list) return;
      var col = +r.getAttribute('data-col'), idx = +r.getAttribute('data-idx');
      if (col === 0) { S.col = 1; selectSection(idx); return; }
      if (col === 1) {
        S.catIdx = idx; S.col = 1; S.after = null; paint(true);
        var cat = S.cats[idx];
        if (curSec() === 'settings') runSetting(cat);
        else if (cat.adult && lockedNow()) unlockAdult();
        else { S.loadedKey = null; loadItems(); }
        return;
      }
      S.itemIdx = idx; S.col = 2;
      if (onFav) { toggleFav(S.items[idx]); return; }
      paint(true);
      activateItem();
    });
    list.addEventListener('mousewheel', function (e) {
      if (S.mode !== 'tv') return;
      var d = e.wheelDelta < 0 ? 3 : -3;
      if (id === 'listItems') moveItem(d); else if (id === 'listCats') moveCat(d);
      e.preventDefault();
    });
  }

  function proceed() {
    var p = store.get('iptv.profile', null);
    if (p && (p.user || p.url)) startSession(p, true);
    else showLogin();
  }

  function init() {
    video = $('video');
    // Estos eventos son del reproductor web; se ignoran cuando reproduce el nativo de Android.
    function web() { return P.active && P.engine === 'web'; }
    video.addEventListener('playing', function () { if (!web()) return; P.started = true; showEngine(); spinner(false); $('playerMsg').textContent = ''; $('mPlayIc').setAttribute('d', ICONS.pause); });
    video.addEventListener('pause', function () { if (web()) $('mPlayIc').setAttribute('d', ICONS.play); });
    video.addEventListener('waiting', function () { if (web()) spinner(true); });
    video.addEventListener('timeupdate', function () { if (osdVisible()) updateProgress(); });
    video.addEventListener('error', function () {
      if (!web() || P.hls || !video.getAttribute('src')) return;
      fail('código ' + (video.error ? video.error.code : '?'));
    });
    bindPlayerTouch();

    qsa('#chooser .opt').forEach(function (o) { o.addEventListener('click', function () { chooseMode(o.getAttribute('data-mode')); }); });
    $('btnConnect').addEventListener('click', connect);
    ['listSec', 'listCats', 'listItems'].forEach(bindList);
    $('itemsEmpty').addEventListener('click', function () {
      var cat = S.cats[S.catIdx];
      if (cat && cat.adult && lockedNow()) unlockAdult();
    });
    // en móvil la lista se desplaza con el dedo: cargar más filas al acercarse al final
    $('listItems').addEventListener('scroll', function () {
      var l = this;
      if (S.mode === 'mobile' && S.shown < S.items.length && l.scrollTop + l.clientHeight > l.scrollHeight - 600) appendItems();
    });
    buildPad();

    var vis = function () { if (document.hidden || document.webkitHidden) onHidden(); else onVisible(); };
    if (!window.CACTUS_OWN_VIS) document.addEventListener('visibilitychange', vis);
    if (!window.CACTUS_OWN_VIS) document.addEventListener('webkitvisibilitychange', function () {
      if (document.webkitHidden && S.screen === 'player' && !S.inPip) video.pause();
      vis();
    });

    var tick = function () { $('clock').textContent = $('mclock').textContent = clock(); };
    setInterval(tick, 10000); tick();

    // buscar una versión nueva unos segundos después de abrir (solo Android)
    setTimeout(function () { checkUpdate(false); }, 4000);
    // LG / Samsung: el cargador (boot.js) actualiza desde GitHub; si se acaba de aplicar una versión, mostrar sus cambios
    try { if (window.__cactusBootOk) window.__cactusBootOk(); } catch (e) {}
    if (window.__cactusBootNotes) {
      var bn = window.__cactusBootNotes; window.__cactusBootNotes = null;
      setTimeout(function () {
        if (M.open) return;
        openModal({ kind: 'info', title: 'CactusNet TV se actualizó a la versión ' + CONFIG.version, text: bn,
          buttons: [{ label: 'Entendido', fn: closeModal, primary: true }] });
      }, 2500);
    }

    S.mode = IS_WEBOS ? 'tv' : store.get('iptv.mode', null);
    if (!S.mode) { showChooser(); return; }
    applyMode();
    proceed();
  }

  /* ============================ ACTUALIZACIONES (Android) ============================
     Al abrir la app se lee CONFIG.updateUrl, un JSON así:
       { "versionCode": 6, "versionName": "1.3.0", "apk": "https://…/CactusTV.apk",
         "notes": "Qué cambió", "force": false }
     Si versionCode es mayor que el instalado, se ofrece actualizar: la APK se descarga aquí,
     se guarda en la caché privada (CactusNative.writeUpdate) y se abre el instalador de Android
     (CactusNative.installUpdate). Android solo la instala si está firmada con la misma llave. */
  var U = { busy: false, xhr: null };
  function canUpdate() {
    return !!(window.CactusNative && window.CactusNative.writeUpdate) && !/USUARIO/.test(CONFIG.updateUrl);
  }
  function localBuild() { var v = nat('versionCode'); return typeof v === 'number' ? v : 0; }
  function bust(url) { return url + (url.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(); }

  function checkUpdate(manual) {
    if (!canUpdate()) { if (manual) toast('Las actualizaciones automáticas no están disponibles en este equipo'); return; }
    if (U.busy) return;
    if (manual) loading(true, 'Buscando actualizaciones…');
    var x = new XMLHttpRequest();
    x.open('GET', bust(CONFIG.updateUrl), true);
    x.timeout = 20000;
    x.onload = function () {
      if (manual) loading(false);
      var info = null;
      try { info = JSON.parse(x.responseText); } catch (e) {}
      if (x.status < 200 || x.status >= 300 || !info || !info.versionCode || !info.apk) {
        if (manual) toast('No se pudo leer la información de actualización');
        return;
      }
      if (+info.versionCode > localBuild()) offerUpdate(info);
      else if (manual) toast('Ya tienes la última versión (' + CONFIG.version + ')');
    };
    x.onerror = x.ontimeout = function () {
      if (manual) { loading(false); toast('No hay conexión para buscar actualizaciones'); }
    };
    x.send();
  }

  // Cambios a mostrar: con "history" en version.json, solo los de las versiones que este equipo
  // aún no tiene (si se saltó varias, se muestran todas, de la más nueva a la más vieja).
  function updateNotes(info) {
    var have = localBuild(), h = info.history;
    if (h && h.length && have) {
      var miss = h.filter(function (v) { return +v.versionCode > have; })
        .sort(function (a, b) { return b.versionCode - a.versionCode; }).slice(0, 8);
      if (miss.length) {
        var out = [];
        miss.forEach(function (v) { (v.changes || []).forEach(function (c) { out.push('• ' + c); }); });
        return out.join('\n') + '\n\n';
      }
    }
    return info.notes ? info.notes + '\n\n' : '';
  }
  function offerUpdate(info) {
    // no interrumpir si hay otra ventana abierta (p. ej. el PIN): reintentar luego
    if (M.open) { setTimeout(function () { offerUpdate(info); }, 8000); return; }
    var btns = [{ label: 'Actualizar ahora', fn: function () { downloadUpdate(info); }, primary: true }];
    if (!info.force) btns.push({ label: 'Más tarde', fn: closeModal });
    openModal({
      kind: 'info', locked: !!info.force,
      title: 'Nueva versión ' + (info.versionName || ''),
      text: updateNotes(info) +
        (info.force ? 'Esta actualización es necesaria para seguir usando CactusNet TV.' : 'Tienes la versión ' + CONFIG.version + '. ¿Quieres actualizar ahora?'),
      buttons: btns
    });
  }

  function updateError(msg, info) {
    U.busy = false; U.xhr = null;
    var btns = [{ label: 'Reintentar', fn: function () { downloadUpdate(info); } }];
    if (!info.force) btns.push({ label: 'Cerrar', fn: closeModal });
    openModal({ kind: 'info', locked: !!info.force, title: 'No se pudo actualizar', text: msg, buttons: btns });
  }

  function downloadUpdate(info) {
    U.busy = true;
    var btns = info.force ? [] : [{ label: 'Cancelar', fn: function () { if (U.xhr) U.xhr.abort(); U.busy = false; U.xhr = null; closeModal(); } }];
    openModal({ kind: 'info', locked: true, title: 'Descargando CactusNet TV ' + (info.versionName || ''), text: 'Preparando…', buttons: btns });
    var opt = M.opt;
    var x = U.xhr = new XMLHttpRequest();
    x.open('GET', bust(info.apk), true);
    x.responseType = 'arraybuffer';
    x.timeout = 300000;
    x.onprogress = function (e) {
      if (M.opt !== opt) return;
      $('mText').textContent = e.lengthComputable
        ? 'Descargando… ' + Math.floor(e.loaded / e.total * 100) + ' %'
        : 'Descargando… ' + Math.round(e.loaded / 1024) + ' KB';
    };
    x.onload = function () {
      if (U.xhr !== x) return;
      var bytes = x.response ? new Uint8Array(x.response) : null;
      if (x.status < 200 || x.status >= 300 || !bytes) { updateError('El servidor respondió con un error (' + x.status + ').', info); return; }
      // Una APK es un ZIP: empieza con "PK". Si no, el enlace devolvió una página web
      // (típico de Google Drive cuando el archivo no es público).
      if (bytes.length < 20000 || bytes[0] !== 0x50 || bytes[1] !== 0x4B) {
        updateError('Lo descargado no es una APK. Revisa que el enlace sea público y de descarga directa.', info); return;
      }
      $('mText').textContent = 'Preparando la instalación…';
      setTimeout(function () { saveAndInstall(bytes, info); }, 30);
    };
    x.onerror = function () { if (U.xhr === x) updateError('No se pudo descargar. Revisa la conexión a internet.', info); };
    x.ontimeout = function () { if (U.xhr === x) updateError('La descarga tardó demasiado.', info); };
    x.send();
  }

  function toBase64(u8) {
    var s = '', step = 0x8000;
    for (var i = 0; i < u8.length; i += step) s += String.fromCharCode.apply(null, u8.subarray(i, i + step));
    return btoa(s);
  }
  function saveAndInstall(bytes, info) {
    var CH = 512 * 1024; // trozos de 512 KB hacia el lado nativo
    try {
      for (var i = 0; i < bytes.length; i += CH) {
        if (!window.CactusNative.writeUpdate(toBase64(bytes.subarray(i, i + CH)), i === 0)) throw new Error('write');
      }
    } catch (e) { updateError('No se pudo guardar la actualización en el equipo.', info); return; }
    U.busy = false; U.xhr = null;
    nat('installUpdate');
    var btns = info.force ? [{ label: 'Abrir instalador otra vez', fn: function () { nat('installUpdate'); } }]
                          : [{ label: 'Abrir instalador otra vez', fn: function () { nat('installUpdate'); } }, { label: 'Cerrar', fn: closeModal }];
    openModal({
      kind: 'info', locked: !!info.force, title: 'Instala la actualización',
      text: 'Se abrió el instalador de Android: elige Instalar / Actualizar. Si te pide permitir instalar apps de CactusNet TV, actívalo y vuelve atrás.',
      buttons: btns
    });
  }
  window.__cactusUpdateFail = function () {
    openModal({ kind: 'info', title: 'No se pudo abrir el instalador',
      text: 'Este equipo no permitió abrir el instalador. Puedes instalar la versión nueva con Downloader usando el mismo código de siempre.',
      buttons: [{ label: 'Entendido', fn: closeModal }] });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
