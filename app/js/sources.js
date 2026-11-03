/* Fuentes de contenido: Xtream Codes y listas M3U.
   ES5 puro para compatibilidad con webOS 3.x+.
   Interfaz común:
     login()               -> Promise
     sections()            -> [{id,label}]
     categories(section)   -> Promise<[{id,name}]>
     items(section, catId) -> Promise<[{id,name,logo,type,num?}]>
     episodes(seriesId)    -> Promise<[...]>   (solo Xtream)
     url(item)             -> string
     infoRows()            -> [[clave, valor]]
*/
var Sources = (function () {
  'use strict';

  function http(url, timeout) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open('GET', url, true);
      x.timeout = timeout || 30000;
      // err.code = 'network' cuando no se llega al servidor (p. ej. fuera de la red de CactusNet)
      function fail(msg, code) { var e = new Error(msg); e.code = code; reject(e); }
      x.onload = function () {
        if (x.status >= 200 && x.status < 300) resolve(x.responseText);
        else fail('el servidor respondió HTTP ' + x.status, x.status >= 500 ? 'network' : 'http');
      };
      x.onerror = function () { fail('no hay conexión con el servidor', 'network'); };
      x.ontimeout = function () { fail('el servidor tardó demasiado', 'network'); };
      x.send();
    });
  }

  function getJson(url, timeout) {
    return http(url, timeout).then(function (t) {
      try { return JSON.parse(t); }
      catch (e) { throw new Error('respuesta inválida (¿es un servidor Xtream?)'); }
    });
  }

  function normBase(s) {
    s = (s || '').replace(/^\s+|\s+$/g, '');
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    s = s.replace(/\/+$/, '');
    s = s.replace(/\/(player_api|get)\.php.*$/i, ''); // por si pegan la URL completa
    return s;
  }

  function asArray(v) {
    if (!v) return [];
    if (Object.prototype.toString.call(v) === '[object Array]') return v;
    var out = [];
    for (var k in v) if (v.hasOwnProperty(k)) out.push(v[k]);
    return out;
  }

  function fmtDate(unix) {
    if (!unix) return 'Ilimitada';
    var d = new Date(parseInt(unix, 10) * 1000);
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear();
  }

  /* ======================= XTREAM CODES ======================= */
  function Xtream(cfg) {
    // cfg.server es fijo en la app (CONFIG.server en app.js)
    this.kind = 'xtream';
    this.base = normBase(cfg.server);
    this.user = (cfg.user || '').replace(/^\s+|\s+$/g, '');
    this.pass = (cfg.pass || '').replace(/^\s+|\s+$/g, '');
    this.liveFmt = cfg.liveFmt || 'm3u8';
    this.info = null;
  }

  Xtream.prototype.api = function (action, extra) {
    var u = this.base + '/player_api.php?username=' + encodeURIComponent(this.user) +
      '&password=' + encodeURIComponent(this.pass);
    if (action) u += '&action=' + action;
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) u += '&' + k + '=' + encodeURIComponent(extra[k]);
    // el inicio de sesión espera menos: fuera de la red de CactusNet la conexión suele quedarse colgada
    return getJson(u, !action ? 12000 : (action === 'get_live_streams' || action === 'get_vod_streams' || action === 'get_series' ? 90000 : 30000));
  };

  Xtream.prototype.login = function () {
    var self = this;
    return this.api().then(function (d) {
      if (!d || !d.user_info || String(d.user_info.auth) !== '1') throw new Error('usuario o contraseña incorrectos');
      if (d.user_info.status && d.user_info.status !== 'Active') throw new Error('la cuenta está ' + d.user_info.status);
      self.info = d.user_info;
      return d;
    });
  };

  Xtream.prototype.sections = function () {
    return [
      { id: 'live', label: 'TV en vivo' },
      { id: 'vod', label: 'Películas' },
      { id: 'series', label: 'Series' }
    ];
  };

  var CAT_ACTION = { live: 'get_live_categories', vod: 'get_vod_categories', series: 'get_series_categories' };
  var ITEM_ACTION = { live: 'get_live_streams', vod: 'get_vod_streams', series: 'get_series' };

  Xtream.prototype.categories = function (sec) {
    return this.api(CAT_ACTION[sec]).then(function (list) {
      var out = [{ id: '*', name: 'Todos' }];
      asArray(list).forEach(function (c) { out.push({ id: String(c.category_id), name: c.category_name || 'Sin nombre' }); });
      return out;
    });
  };

  Xtream.prototype.items = function (sec, catId) {
    var extra = catId && catId !== '*' ? { category_id: catId } : null;
    return this.api(ITEM_ACTION[sec], extra).then(function (list) {
      return asArray(list).map(function (s) {
        var cat = s.category_id != null ? String(s.category_id) : '';
        var adult = String(s.is_adult) === '1';
        if (sec === 'live') return { id: String(s.stream_id), name: s.name || '', logo: s.stream_icon || '', type: 'live', num: s.num || '', cat: cat, adult: adult };
        if (sec === 'vod') return { id: String(s.stream_id), name: s.name || '', logo: s.stream_icon || '', type: 'vod', ext: s.container_extension || 'mp4', cat: cat, adult: adult };
        return { id: String(s.series_id), name: s.name || '', logo: s.cover || '', type: 'series', cat: cat, adult: adult };
      });
    });
  };

  Xtream.prototype.episodes = function (seriesId, seriesName, seriesLogo, seriesAdult, seriesCat) {
    return this.api('get_series_info', { series_id: seriesId }).then(function (d) {
      var eps = d && d.episodes ? d.episodes : {};
      var out = [];
      var seasons = [];
      if (Object.prototype.toString.call(eps) === '[object Array]') {
        // algunos paneles devuelven un arreglo de temporadas
        eps.forEach(function (arr, i) { seasons.push({ s: i + 1, list: asArray(arr) }); });
      } else {
        for (var k in eps) if (eps.hasOwnProperty(k)) seasons.push({ s: parseInt(k, 10) || 0, list: asArray(eps[k]) });
      }
      seasons.sort(function (a, b) { return a.s - b.s; });
      seasons.forEach(function (season) {
        season.list.forEach(function (e) {
          var n = e.episode_num || '';
          var title = e.title || '';
          out.push({
            id: String(e.id), type: 'episode', ext: e.container_extension || 'mp4',
            name: 'T' + season.s + ' · E' + n + (title ? '  ' + title : ''),
            logo: (e.info && e.info.movie_image) || seriesLogo || '',
            series: seriesName, adult: !!seriesAdult, cat: seriesCat || ''
          });
        });
      });
      return out;
    });
  };

  Xtream.prototype.url = function (it) {
    var u = encodeURIComponent(this.user), p = encodeURIComponent(this.pass);
    if (it.type === 'live') return this.base + '/live/' + u + '/' + p + '/' + it.id + '.' + this.liveFmt;
    if (it.type === 'vod') return this.base + '/movie/' + u + '/' + p + '/' + it.id + '.' + it.ext;
    return this.base + '/series/' + u + '/' + p + '/' + it.id + '.' + it.ext;
  };

  Xtream.prototype.infoRows = function () {
    var i = this.info || {};
    return [
      ['Servidor', this.base],
      ['Usuario', this.user],
      ['Estado', i.status || '—'],
      ['Vence', fmtDate(i.exp_date)],
      ['Conexiones', (i.active_cons || '0') + ' de ' + (i.max_connections || '?')]
    ];
  };

  /* ======================= LISTA M3U ======================= */
  function attr(line, name) {
    var m = line.match(new RegExp(name + '="([^"]*)"', 'i'));
    return m ? m[1] : '';
  }

  function parseM3U(text) {
    var lines = text.split(/\r?\n/);
    var items = [], groups = [], seen = {};
    var cur = null, grp = '', n = 0;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].replace(/^\s+|\s+$/g, '');
      if (!l) continue;
      if (l.indexOf('#EXTINF') === 0) {
        var q = l.lastIndexOf('"');
        var c = l.indexOf(',', q < 0 ? 0 : q);
        cur = {
          name: c >= 0 ? l.substring(c + 1).replace(/^\s+|\s+$/g, '') : 'Canal',
          logo: attr(l, 'tvg-logo'),
          group: attr(l, 'group-title'),
          num: attr(l, 'tvg-chno')
        };
      } else if (l.indexOf('#EXTGRP:') === 0) {
        grp = l.substring(8).replace(/^\s+|\s+$/g, '');
      } else if (l.charAt(0) !== '#') {
        if (!cur) cur = { name: l.split('/').pop(), logo: '', group: '', num: '' };
        var g = cur.group || grp || 'Sin grupo';
        n++;
        items.push({
          id: 'm' + n, name: cur.name || ('Canal ' + n), logo: cur.logo, group: g, cat: g,
          num: cur.num || String(n), url: l,
          type: /\.(mp4|mkv|avi|mov|wmv)(\?|$)/i.test(l) ? 'vod' : 'live'
        });
        if (!seen[g]) { seen[g] = 0; groups.push(g); }
        seen[g]++;
        cur = null; grp = '';
      }
    }
    return { items: items, groups: groups, counts: seen };
  }

  function M3U(cfg) {
    this.kind = 'm3u';
    this.src = (cfg.url || '').replace(/^\s+|\s+$/g, '');
    if (this.src && !/^https?:\/\//i.test(this.src)) this.src = 'http://' + this.src;
    this.all = [];
    this.groups = [];
    this.counts = {};
  }

  M3U.prototype.login = function () {
    var self = this;
    return http(this.src, 120000).then(function (t) {
      var r = parseM3U(t);
      if (!r.items.length) throw new Error('la lista está vacía o no es un M3U válido');
      self.all = r.items; self.groups = r.groups; self.counts = r.counts;
    });
  };

  M3U.prototype.sections = function () { return [{ id: 'live', label: 'Canales' }]; };

  M3U.prototype.categories = function () {
    var self = this;
    var out = [{ id: '*', name: 'Todos', count: this.all.length }];
    this.groups.forEach(function (g) { out.push({ id: g, name: g, count: self.counts[g] }); });
    return Promise.resolve(out);
  };

  M3U.prototype.items = function (sec, catId) {
    if (!catId || catId === '*') return Promise.resolve(this.all);
    return Promise.resolve(this.all.filter(function (it) { return it.group === catId; }));
  };

  M3U.prototype.url = function (it) { return it.url; };

  M3U.prototype.infoRows = function () {
    return [['Lista', this.src], ['Canales', String(this.all.length)], ['Grupos', String(this.groups.length)]];
  };

  return { Xtream: Xtream, M3U: M3U, parseM3U: parseM3U };
})();
