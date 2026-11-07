/* Sanat — kişisel Fince ↔ Türkçe çalışma uygulaması
   Tamamen yerel çalışır: ağ isteği, reklam, analitik, uygulama içi satın alma yok.
   Tüm ilerleme localStorage'da tutulur. */
(function () {
  "use strict";

  var LS_KEY = "sanat.v1";
  var DAY = 86400000;
  /* box -> tekrar aralığı (gün). box 0 = hiç görülmemiş. */
  var INTERVALS = [0, 1, 3, 7, 16, 40, 90];
  /* Telaffuz puanı bunun altında kalan kelime "zayıf telaffuz" listesine girer. */
  var PRON_WEAK = 60;
  var CATS = [];
  /* Kategoriler sözlükten türetilir; paket eklenince yeniden kurulur. */
  function rebuildCats() {
    CATS.length = 0;
    WORDS.forEach(function (w) { if (w.cat && CATS.indexOf(w.cat) === -1) CATS.push(w.cat); });
  }
  rebuildCats();

  var app = document.getElementById("app");
  var toastEl = document.getElementById("toast");

  var state = load();
  var session = null;       // { mode, queue, i, ok, bad, dir, revealed, locked, feedback }
  var tab = "study";
  var listQuery = "";
  var listCat = "";
  /* Rekor tablosundan dönen oturumun kısa özeti: kalıcı değil, ~9 sn sonra silinir. */
  var recSummary = null;
  var summaryTimer = 0;

  /* ------------------------------------------------------------------ */
  /* Yardımcılar                                                        */
  /* ------------------------------------------------------------------ */

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function dayKey(d) {
    d = d || new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  /* "ev / yuva" -> "ev" (test seçenekleri ve karşılaştırma için) */
  function primary(s) { return String(s).split("/")[0].trim(); }
  /* Aksan/büyük-küçük farkını yok sayan karşılaştırma */
  function fold(s) {
    return String(s).toLowerCase()
      .replace(/\u0307/g, "")
      .replace(/[äå]/g, "a").replace(/ö/g, "o").replace(/ı/g, "i")
      .replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ü/g, "u").replace(/ç/g, "c")
      .replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  }
  function wordByFi(fi) {
    for (var i = 0; i < WORDS.length; i++) if (WORDS[i].fi === fi) return WORDS[i];
    return null;
  }
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.classList.remove("show"); }, 2200);
  }

  /* Ekran okuyucu duyurusu: tüm ekranı canlı bölge yapmak yerine tek satır.
     Kısa, tek bir bilgi taşır; kart metni, cevap ve sonuç ayrı ayrı söylenir. */
  var srStatusEl = document.getElementById("srStatus");
  var TAB_LABELS = { study: "Çalış", list: "Liste", packs: "Paketler", tips: "İpuçları", stats: "İstatistik" };
  /* Satır içi SVG ikon seti: index.html içindeki <symbol> tanımlarına başvurur.
     Emoji yerine geçer; renk ve kalınlık CSS'ten (currentColor) gelir. */
  function ico(name, cls) {
    return '<svg class="ico' + (cls ? " " + cls : "") + '" aria-hidden="true" focusable="false">' +
           '<use href="#i-' + name + '"/></svg>';
  }
  function announce(msg) {
    if (!srStatusEl || !msg) return;
    srStatusEl.textContent = msg;
  }

  /* Günlük telaffuz hedefi ilk kez tutulduğunda kısa kutlama:
     toast + üst bardaki seri sayacında yeşil nabız. Günde bir kez tetiklenir
     (ölçüm öncesi hedef tutmamış, sonrası tutmuş olmalı). */
  var flashTimer = 0;
  /* Kutlama, oturum sürerken tetiklenir; gün notu ekranda olmadığı için
     parıltı notun bir sonraki çizimine ertelenir. */
  var noteCelebratePending = false, noteCelebrateTimer = 0;
  var noteRecordPending = false, recordFlashTimer = 0;
  /* record > 0 ise aynı ölçümde rekor da kırıldı; tek toast'ta ikisi birden söylenir. */
  function celebratePronGoal(words, goal, record) {
    toast(record
      ? "🎉 Hedef tutuldu: " + words + " / " + goal + " · 🏅 yeni rekor " + record + " gün"
      : "🎉 Hedef tutuldu: " + words + " / " + goal + " farklı kelime");
    noteCelebratePending = true;
    if (record > 0) noteRecordPending = true;
    var el = document.getElementById("streakDays");
    if (!el || !el.classList) return;
    el.classList.remove("flash");
    void el.offsetWidth;           // animasyonu yeniden başlatmak için stil yenile
    el.classList.add("flash");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { el.classList.remove("flash"); }, 3000);
  }

  /* Notun çizilmesinden sonra çağrılır: bekleyen kutlama varsa notu
     yeşil parlatır, ✓ yanında yıldızı canlandırır; 1,6 sn sonra söner. */
  function applyNoteCelebration() {
    var el;
    if (noteCelebratePending) {
      el = document.getElementById("dayNote");
      if (el && el.classList) {
        noteCelebratePending = false;
        el.classList.remove("celebrate");
        void el.offsetWidth;         // animasyonu yeniden başlatmak için stil yenile
        el.classList.add("celebrate");
        clearTimeout(noteCelebrateTimer);
        noteCelebrateTimer = setTimeout(function () { el.classList.remove("celebrate"); }, 1600);
      }
    }
    if (noteRecordPending) {
      var badge = document.getElementById("recordBadge");
      if (badge && badge.classList) {
        noteRecordPending = false;
        badge.classList.remove("flash");
        void badge.offsetWidth;
        badge.classList.add("flash");
        clearTimeout(recordFlashTimer);
        recordFlashTimer = setTimeout(function () { badge.classList.remove("flash"); }, 2200);
      }
    }
  }
  function speak(text, lang) {
    if (!("speechSynthesis" in window) || !text) return;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      u.rate = 0.9;
      window.speechSynthesis.speak(u);
    } catch (e) { /* sessiz geç: ses desteği yoksa uygulama çalışmaya devam eder */ }
  }

  /* ------------------------------------------------------------------ */
  /* Kalıcı durum                                                       */
  /* ------------------------------------------------------------------ */

  function freshState() {
    return {
      settings: { direction: "fi-tr", goal: 20, pronGoal: 5 },
      cards: {},
      custom: [],
      packs: {},
      history: {},
      pron: {},
      pronLog: [],
      pronBest: {},
      pronRun: {},
      pronSessions: [],
      dayNote: null,
      lastSeen: null,
      streak: { last: null, days: 0 },
      answers: 0,
      correct: 0
    };
  }

  function load() {
    var s = freshState();
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        s.settings = Object.assign({ direction: "fi-tr", goal: 20, pronGoal: 5 }, p.settings || {});
        s.cards = p.cards || {};
        s.custom = Array.isArray(p.custom) ? p.custom.slice(0, 20000) : [];
        s.packs = (p.packs && typeof p.packs === "object") ? p.packs : {};
        s.history = p.history || {};
        s.pron = p.pron || {};
        s.pronLog = Array.isArray(p.pronLog) ? p.pronLog.slice(-400) : [];
        s.pronBest = (p.pronBest && typeof p.pronBest === "object") ? p.pronBest : {};
        s.pronRun = (p.pronRun && typeof p.pronRun === "object") ? p.pronRun : {};
        s.pronSessions = Array.isArray(p.pronSessions) ? p.pronSessions.slice(-40) : [];
        s.dayNote = p.dayNote || null;
        s.lastSeen = typeof p.lastSeen === "string" ? p.lastSeen : null;
        s.streak = Object.assign({ last: null, days: 0 }, p.streak || {});
        s.answers = p.answers || 0;
        s.correct = p.correct || 0;
      }
    } catch (e) {
      console.warn("Kayıt okunamadı, sıfırdan başlanıyor:", e);
    }
    return s;
  }

  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); }
    catch (e) { console.warn("Kayıt yazılamadı:", e); }
  }

  function cardOf(w) {
    if (!state.cards[w.fi]) {
      state.cards[w.fi] = { box: 0, due: 0, seen: 0, ok: 0, bad: 0, last: 0 };
    }
    return state.cards[w.fi];
  }
  function isNew(w) { var c = state.cards[w.fi]; return !c || c.box === 0; }
  function isDue(w) { var c = state.cards[w.fi]; return !!c && c.box > 0 && c.due <= Date.now(); }
  function isLearned(w) { var c = state.cards[w.fi]; return !!c && c.box >= 4; }

  /* Zayıf telaffuz kaydı: yalnızca eşiğin altında kalan kelimeler tutulur. */
  function rememberPron(fi, score) {
    if (!state.pron) state.pron = {};
    if (!state.pronLog) state.pronLog = [];

    /* Kutlama ölçümden önceki duruma bakar: hedef bu ölçümle ilk kez tutuldu mu? */
    var goal = Math.max(1, Number(state.settings.pronGoal) || 5);
    var metBefore = todayDistinct() >= goal;
    var runBefore = pronRunDays(goal);

    /* Tarihli puan günlüğü: eğilim grafiği ve "en zorlananlar" bundan çıkar. */
    state.pronLog.push({ fi: fi, score: score, at: Date.now() });
    if (state.pronLog.length > 400) state.pronLog = state.pronLog.slice(-400);

    var first = false;
    if (score < PRON_WEAK) {
      first = !state.pron[fi];
      var rec = state.pron[fi] || { tries: 0 };
      rec.tries += 1;
      rec.last = score;
      state.pron[fi] = rec;
    } else if (state.pron[fi]) {
      delete state.pron[fi];
    }
    refreshPronRun();
    /* Gün notu gün boyu kalır: yalnızca ✕ ile veya gün değişince kalkar. */
    save();
    var words = todayDistinct();
    if (!metBefore && words >= goal) {
      var runAfter = pronRunDays(goal);
      /* Seri bugün uzadı ve bugün hariç geçmişin en uzununu geçtiyse rekor kırıldı. */
      var record = (runAfter > runBefore && runAfter > bestRunBeforeToday(goal)) ? runAfter : 0;
      celebratePronGoal(words, goal, record);
    }
    return first;
  }

  /* En zayıftan en iyiye sıralı; liste boşsa boş dizi. */
  function weakWords() {
    var p = state.pron || {};
    var out = [];
    WORDS.forEach(function (w) { if (p[w.fi]) out.push(w); });
    out.sort(function (a, b) { return p[a.fi].last - p[b.fi].last; });
    return out;
  }

  /* Günlük ortalama puan grafiği + önceki 7 güne göre değişim. */
  function pronTrendHtml() {
    var log = state.pronLog || [];
    var now = Date.now();
    var days = [];
    var i, j, d, k, sum, n;

    for (i = 6; i >= 0; i--) {
      d = new Date(now - i * DAY);
      k = dayKey(d);
      sum = 0;
      n = 0;
      for (j = 0; j < log.length; j++) {
        if (dayKey(new Date(log[j].at)) === k) { sum += log[j].score; n += 1; }
      }
      days.push({
        label: ["Pz", "Pt", "Sa", "Ça", "Pe", "Cu", "Ct"][d.getDay()],
        avg: n ? Math.round(sum / n) : null,
        n: n
      });
    }

    var cur = { sum: 0, n: 0 }, prev = { sum: 0, n: 0 };
    for (i = 0; i < log.length; i++) {
      if (log[i].at >= now - 7 * DAY) { cur.sum += log[i].score; cur.n += 1; }
      else if (log[i].at >= now - 14 * DAY) { prev.sum += log[i].score; prev.n += 1; }
    }

    var avg = cur.n ? Math.round(cur.sum / cur.n) : null;
    var deltaText, deltaClass = "";
    if (avg !== null && prev.n) {
      var diff = avg - Math.round(prev.sum / prev.n);
      deltaClass = diff > 0 ? " up" : diff < 0 ? " down" : "";
      deltaText = (diff > 0 ? "▲ +" + diff + " puan" : diff < 0 ? "▼ " + diff + " puan" : "● değişim yok") +
        " · önceki 7 güne göre · " + cur.n + " ölçüm";
    } else if (avg !== null) {
      deltaText = "Önceki 7 günde kayıt yok · " + cur.n + " ölçüm";
    } else {
      deltaText = "Henüz telaffuz ölçümü yok";
    }

    var chart = "";
    for (i = 0; i < days.length; i++) {
      chart += '<div class="col' + (days[i].avg === null ? " void" : "") + '">' +
        (days[i].avg === null ? "" : "<b>" + days[i].avg + "</b>") +
        '<i style="height:' + (days[i].avg || 0) + '%"></i>' +
        "<span>" + days[i].label + "</span></div>";
    }

    return {
      cur: cur,
      prev: prev,
      html: '<div class="card">' +
        '<div class="trend-head"><b>Son 7 gün ortalaması</b>' +
          '<span class="score-pill ' + (avg === null ? "" : scoreClass(avg)) + '">' +
            (avg === null ? "–" : "%" + avg) + "</span></div>" +
        '<p class="trend-delta' + deltaClass + '">' + deltaText + "</p>" +
        '<div class="chart avg">' + chart + "</div>" +
      "</div>"
    };
  }

  /* Puan günlüğünden kelime bazlı ortalama; en düşük ortalama önce. */
  function hardestWords(count) {
    var log = state.pronLog || [];
    var agg = {};
    for (var i = 0; i < log.length; i++) {
      var a = agg[log[i].fi] || { sum: 0, n: 0 };
      a.sum += log[i].score;
      a.n += 1;
      agg[log[i].fi] = a;
    }
    var list = [];
    for (var fi in agg) {
      if (Object.prototype.hasOwnProperty.call(agg, fi)) {
        list.push({ fi: fi, avg: Math.round(agg[fi].sum / agg[fi].n), n: agg[fi].n });
      }
    }
    list.sort(function (x, y) { return x.avg - y.avg || y.n - x.n; });
    return list.slice(0, count || 5);
  }

  function hardestHtml() {
    var list = hardestWords(5);
    if (!list.length) {
      return '<div class="card"><p class="muted">Henüz telaffuz ölçümü yok. Telaffuz modunda birkaç kelime dene; ortalama ve en zorlanan kelimeler burada birikir.</p>' +
        '<button type="button" class="primary wide" data-mode="telaffuz">Telaffuz modunu aç</button></div>';
    }
    var rows = "";
    list.forEach(function (x) {
      rows += '<button type="button" class="hard-row" data-weak="' + esc(x.fi) + '">' +
        '<span class="hard-word">' + esc(x.fi) + "</span>" +
        '<span class="hard-meta">' + x.n + " ölçüm</span>" +
        '<span class="score-pill ' + scoreClass(x.avg) + '">%' + x.avg + "</span>" +
      "</button>";
    });
    return '<div class="card hardest">' + rows + "</div>";
  }

  /* "YYYY-MM-DD" anahtarını n gün kaydırır. */
  function addDaysKey(key, n) {
    var p = String(key).split("-");
    return dayKey(new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + n));
  }

  /* Hedefi tutturan gün serisi: güncel seri + tüm geçmişteki en uzun seri. */
  function pronGoalStreak() {
    var log = state.pronLog || [];
    var goal = Math.max(1, Number(state.settings.pronGoal) || 5);
    var perDay = {};
    var i, k;

    for (i = 0; i < log.length; i++) {
      k = dayKey(new Date(log[i].at));
      if (!perDay[k]) perDay[k] = {};
      perDay[k][log[i].fi] = true; /* aynı kelime günde bir kez */
    }

    var counts = {};
    var keys = [];
    for (k in perDay) {
      if (Object.prototype.hasOwnProperty.call(perDay, k)) {
        counts[k] = Object.keys(perDay[k]).length;
        keys.push(k);
      }
    }

    var todayKey = dayKey();
    var todayMet = (counts[todayKey] || 0) >= goal;

    /* Bugün henüz tutulmadıysa seri dünden geriye doğru sayılır (gün bitmedi). */
    var current = 0;
    var cursor = todayMet ? todayKey : addDaysKey(todayKey, -1);
    var guard = 0;
    while ((counts[cursor] || 0) >= goal && guard < 4000) {
      current += 1;
      cursor = addDaysKey(cursor, -1);
      guard += 1;
    }

    var best = 0, run = 0, walk = null;
    keys.sort();
    if (keys.length) {
      walk = keys[0];
      guard = 0;
      while (guard < 4000) {
        if ((counts[walk] || 0) >= goal) {
          run += 1;
          if (run > best) best = run;
        } else {
          run = 0;
        }
        if (walk === todayKey) break;
        walk = addDaysKey(walk, 1);
        guard += 1;
      }
    }

    return { current: current, best: best, todayMet: todayMet, goal: goal };
  }

  /* Bugünün serisi hariç en uzun seri: bugünkü seri bunu geçtiyse rekor kırıldı. */
  function bestRunBeforeToday(goal) {
    var counts = dailyCounts();
    var keys = Object.keys(counts);
    if (!keys.length) return 0;
    keys.sort();
    var first = keys[0];
    var cursor = addDaysKey(dayKey(), -1);
    var best = 0, run = 0, guard = 0;
    while (guard < 4000) {
      if ((counts[cursor] || 0) >= goal) {
        run += 1;
        if (run > best) best = run;
      } else {
        run = 0;
      }
      if (String(cursor) <= String(first)) break;
      cursor = addDaysKey(cursor, -1);
      guard += 1;
    }
    return best;
  }

  /* Hedef başına saklanan en uzun seri. */
  function pronBestFor(goal) {
    var map = state.pronBest || {};
    return Math.max(0, Number(map[String(goal)]) || 0);
  }

  function fmtDayKey(key) {
    var p = String(key).split("-");
    return p[2] + "." + p[1] + "." + p[0];
  }

  /* Rekor tablosundan başlatılan son 5 oturum: en yenisi üstte, süresiyle. */
  function recentSessionsHtml() {
    var all = Array.isArray(state.pronSessions) ? state.pronSessions : [];
    var list = all.slice(-5).reverse();
    if (!list.length) return "";
    var rows = "";
    list.forEach(function (r) {
      var secs = Number(r && r.secs);
      if (!isFinite(secs) || secs < 0) secs = 0;
      var total = Math.max(0, Math.round(Number(r.total) || 0));
      var okN = Math.max(0, Math.round(Number(r.ok) || 0));
      var pct = total ? Math.round((okN / total) * 100) : 0;
      var day = r && r.at ? fmtDayKey(dayKey(new Date(r.at))) : "—";
      var goalN = Math.max(1, Math.round(Number(r.goal) || 0));
      rows += '<li class="ses-item" data-rec-goal="' + goalN + '"' +
          ' role="button" tabindex="0" title="Bu hedefle yeniden başlat"' +
          ' aria-label="' + goalN + ' kelime hedefiyle yeniden başlat · ' + day +
            ' · ' + okN + '/' + total + ' doğru · ' + fmtSecs(secs) + '">' +
        '<span class="ses-day">' + day + "</span>" +
        '<span class="ses-goal">' + goalN + " kelime hedefi</span>" +
        '<span class="ses-ok">' + okN + "/" + total + " · %" + pct + "</span>" +
        '<span class="ses-time">' + fmtSecs(secs) + "</span>" +
        '<span class="ses-go" aria-hidden="true">›</span>' +
      "</li>";
    });
    return '<div class="card sessions-card">' +
      '<div class="trend-head"><b>Son oturumlar</b><span class="muted small">en yeni 5</span></div>' +
      '<ul class="ses-list">' + rows + "</ul>" +
    "</div>";
  }

  /* Hedef başına rekor tablosu: en uzun seri, serinin en son günü ("kırıldığı gün")
   ve o günkü farklı kelime sayısı. Seri pronLog'dan yeniden kurulur; günlük kayıt
   kırpılmışsa saklanan rekor sayısı kalır, tarih ve kelime sayısı "—" olur. */
  function pronRecordsHtml() {
    var counts = dailyCounts();
    var keys = Object.keys(counts).sort();
    var today = dayKey();
    var goal = Math.max(1, Number(state.settings.pronGoal) || 5);
    var map = state.pronBest || {};
    var goals = [], g, i, guard;

    for (g in map) {
      if (!Object.prototype.hasOwnProperty.call(map, g)) continue;
      var num = Math.max(0, Math.round(Number(g) || 0));
      if (num > 0 && goals.indexOf(num) === -1) goals.push(num);
    }
    if (goals.indexOf(goal) === -1) goals.push(goal);
    goals.sort(function (a, b) { return a - b; });

    var rows = "";
    var truncated = false;
    var anyDays = false;
    for (i = 0; i < goals.length; i++) {
      var target = goals[i];
      var run = 0, best = 0, bestDay = null;
      if (keys.length) {
        var cursor = keys[0];
        guard = 0;
        while (guard < 4000) {
          if ((counts[cursor] || 0) >= target) {
            run += 1;
            if (run > best) { best = run; bestDay = cursor; }
          } else {
            run = 0;
          }
          if (String(cursor) >= String(today)) break;
          cursor = addDaysKey(cursor, 1);
          guard += 1;
        }
      }

      /* döngü bugüne kadar ilerlediği için run, bugünle biten kesintisiz seridir */
      var todayRun = ((counts[today] || 0) >= target) ? run : 0;
      var todayWords = counts[today] || 0;

      var stored = Math.max(0, Math.round(Number(map[String(target)]) || 0));
      var days = Math.max(stored, best);
      var known = best > 0 && best === days;   /* tarih ancak kayıttan doğrulanabiliyorsa */
      if (stored > best) truncated = true;
      if (days > 0) anyDays = true;

      rows += '<tr class="' + (target === goal ? "current" : "") + '" data-rec-goal="' + target + '"' +
        ' role="button" tabindex="0"' +
        ' aria-label="' + target + ' kelime hedefiyle telaffuz oturumu başlat · rekor ' +
          days + ' gün · bugün ' + todayWords + '/' + target + '"' +
        ' title="Bu hedefle telaffuz oturumu başlat">' +
        "<td>" + target + " kelime" + (target === goal ? '<span class="rec-cur">şu an</span>' : "") +
          '<span class="rec-tip">bugün ' + todayWords + "/" + target + " · rekor için " +
            Math.max(1, days + 1 - todayRun) + " gün</span></td>" +
        '<td><b>' + days + "</b> gün</td>" +
        "<td>" + (known ? fmtDayKey(bestDay) : "—") + "</td>" +
        "<td>" + (known ? (counts[bestDay] || 0) + " kelime" : "—") + "</td>" +
        '<td class="rec-go" aria-hidden="true">›</td>' +
      "</tr>";
    }

    return '<div class="card records-card" id="recordsCard">' +
      '<div class="trend-head"><b>Rekorlar</b><span class="muted small">hedefe göre en uzun seri</span></div>' +
      recSummaryHtml() +
      (anyDays
        ? '<table class="rec-table">' +
            "<thead><tr><th>Hedef</th><th>Rekor</th><th>Kırıldığı gün</th><th>O gün</th><th class=\"rec-go\" aria-hidden=\"true\"></th></tr></thead>" +
            "<tbody>" + rows + "</tbody>" +
          "</table>"
        : '<p class="muted small">Henüz rekor yok — hedefi tutan ilk gün burada görünecek.</p>') +
      (truncated ? '<p class="muted small">Günlük kayıt kırpıldığı için eski rekorların tarihi gösterilemiyor.</p>' : "") +
    "</div>";
  }

  /* Kalıcı rekor: hedef başına en uzun seri.
     Günlük kayıtlar 400 kayıtta kırpılsa bile burada saklanan değer düşmez. */
  function pronBestMap() {
    if (!state.pronBest || typeof state.pronBest !== "object") state.pronBest = {};
    return state.pronBest;
  }

  function recordPronStreak() {
    var st = pronGoalStreak();
    var map = pronBestMap();
    var key = String(st.goal);
    var best = Math.max(map[key] || 0, st.current, st.best, pronRunDays(st.goal));
    if (best > (map[key] || 0)) {
      map[key] = best;
      return true;
    }
    return false;
  }

  /* ---- Kalıcı güncel seri (günlük kayıt kırpılsa da kesilmez) ---- */

  function pronRunMap() {
    if (!state.pronRun || typeof state.pronRun !== "object") state.pronRun = {};
    return state.pronRun;
  }

  /* Bugünün farklı kelime sayısı. */
  function todayDistinct() {
    var log = state.pronLog || [];
    var today = dayKey();
    var seen = {};
    for (var i = 0; i < log.length; i++) {
      if (dayKey(new Date(log[i].at)) === today) seen[log[i].fi] = true;
    }
    return Object.keys(seen).length;
  }

  /* Tüm geçmişin günlük farklı kelime sayıları. */
  function dailyCounts() {
    var log = state.pronLog || [];
    var per = {}, out = {};
    for (var i = 0; i < log.length; i++) {
      var k = dayKey(new Date(log[i].at));
      if (!per[k]) per[k] = {};
      per[k][log[i].fi] = true;
    }
    for (var k2 in per) {
      if (Object.prototype.hasOwnProperty.call(per, k2)) out[k2] = Object.keys(per[k2]).length;
    }
    return out;
  }

  /* Kayıttan çıkan güncel seri (kayıt kırpıldıysa kısa kalabilir). */
  function logRun(goal) {
    var counts = dailyCounts();
    var today = dayKey();
    var y = addDaysKey(today, -1);
    var last = (counts[today] || 0) >= goal ? today : ((counts[y] || 0) >= goal ? y : null);
    if (!last) return { days: 0, last: null };
    var days = 0, cur = last, guard = 0;
    while ((counts[cur] || 0) >= goal && guard < 4000) {
      days += 1;
      cur = addDaysKey(cur, -1);
      guard += 1;
    }
    return { days: days, last: last };
  }

  /* Seriyi ilerletir: tutulan gün +1, kaçırılan gün sıfırlar,
     bugün henüz tutulmadıysa seri bozulmaz (gün bitmedi). */
  function updatePronRun(goal, todayMet) {
    var map = pronRunMap();
    var key = String(goal);
    var rec = map[key] || { days: 0, last: null };
    var today = dayKey();
    var y = addDaysKey(today, -1);
    var fromLog = logRun(goal);

    if (todayMet) {
      if (rec.last === today) {
        /* bugün zaten sayıldı */
      } else if (rec.last === y) {
        rec.days = (rec.days || 0) + 1;
        rec.last = today;
      } else if (fromLog.last === today && fromLog.days > (rec.days || 0)) {
        rec.days = fromLog.days;
        rec.last = today;
      } else {
        rec.days = 1;
        rec.last = today;
      }
    } else if (rec.last !== today && rec.last !== y) {
      if (fromLog.last === y) {
        rec.days = fromLog.days;
        rec.last = y;
      } else {
        rec.days = 0;
        rec.last = null;
      }
    }

    map[key] = rec;
    return rec;
  }

  /* Saklanan seri bugün ya da dün bitiyorsa geçerli; daha eskisiyse kırılmıştır. */
  function pronRunDays(goal) {
    var rec = pronRunMap()[String(goal)];
    if (!rec || !rec.days) return 0;
    var today = dayKey();
    if (rec.last === today || rec.last === addDaysKey(today, -1)) return rec.days;
    return 0;
  }

  /* Kaydı güncel duruma getirir, seriyi ve rekoru tazeler. */
  function refreshPronRun() {
    var goal = Math.max(1, Number(state.settings.pronGoal) || 5);
    var key = String(goal);
    var before = JSON.stringify(pronRunMap()[key] || null);
    updatePronRun(goal, todayDistinct() >= goal);
    var after = JSON.stringify(pronRunMap()[key] || null);
    var bestChanged = recordPronStreak();
    if (before !== after || bestChanged) save();
    return pronRunDays(goal);
  }

  /* Günlük telaffuz hedefi: farklı kelime sayısı + 7 günlük hedef grafiği.
     Aynı kelimenin tekrar denemeleri günde bir kez sayılır (fi bazında tekilleştirme). */
  function pronGoalHtml() {
    var log = state.pronLog || [];
    var goal = Math.max(1, Number(state.settings.pronGoal) || 5);
    var labels = ["Pz", "Pt", "Sa", "Ça", "Pe", "Cu", "Ct"];
    var days = [];
    var i, j, d, k, n;
    var todayCount = 0, maxCount = 0;

    for (i = 6; i >= 0; i--) {
      d = new Date(Date.now() - i * DAY);
      k = dayKey(d);
      var seenToday = {};
      for (j = 0; j < log.length; j++) {
        if (dayKey(new Date(log[j].at)) === k) seenToday[log[j].fi] = true;
      }
      n = Object.keys(seenToday).length;
      days.push({ key: k, label: labels[d.getDay()], n: n });
      if (i === 0) todayCount = n;
      if (n > maxCount) maxCount = n;
    }

    var scale = Math.max(goal, maxCount, 1);
    var lineAt = Math.min(97, Math.round((goal / scale) * 100));

    var cols = "";
    var labelsHtml = "";
    for (i = 0; i < days.length; i++) {
      var h = Math.round((days[i].n / scale) * 100);
      cols += '<div class="col"><b>' + (days[i].n ? days[i].n : "") + "</b>" +
        '<i class="' + (days[i].n >= goal ? "met" : "") + '" style="height:' + h + '%"></i></div>';
      labelsHtml += "<span>" + days[i].label + "</span>";
    }

    /* Hedefin tutulduğu gün: ilk ölçümden bugüne kadarki günler üzerinden. */
    var firstAt = null;
    for (i = 0; i < log.length; i++) if (firstAt === null || log[i].at < firstAt) firstAt = log[i].at;
    var windowDays = 7;
    if (firstAt !== null) {
      var fk = dayKey(new Date(firstAt));
      for (i = 0; i < days.length; i++) if (days[i].key === fk) { windowDays = days.length - i; break; }
    }
    var met = 0;
    for (i = days.length - windowDays; i < days.length; i++) if (days[i] && days[i].n >= goal) met += 1;

    var note = firstAt === null
      ? "Henüz ölçüm yok · hedef günde " + goal + " farklı kelime"
      : "Hedefi tuttuğun gün: " + met + "/" + windowDays + " · günde en az " + goal + " farklı kelime";

    var noteHtml = dayNoteHtml();


    var streakHtml = "";
    if (firstAt !== null) {
      var st = pronGoalStreak();
      var record = Math.max(st.best, pronBestMap()[String(st.goal)] || 0);
      var current = Math.max(st.current, pronRunDays(st.goal));
      streakHtml =
        '<div class="goal-streak">' +
          '<span class="streak-pill' + (current ? " warm" : "") + (st.todayMet ? " met" : "") + '">' + ico("flame") + " " + current + " gün üst üste</span>" +
          '<span class="streak-pill">🏆 en uzun ' + record + " gün</span>" +
        "</div>" +
        '<p class="trend-delta' + (st.todayMet ? " up" : "") + '">' +
          (st.todayMet ? "Bugünün hedefi tutuldu." : "Bugün henüz tutulmadı — birkaç farklı kelime daha.") + "</p>";
    }

    return '<div class="card goal-card">' +
      noteHtml +
      '<div class="trend-head"><b>Bugünkü farklı kelime</b>' +
        '<span class="score-pill ' + (todayCount >= goal ? "good" : todayCount ? "ok" : "bad") + '">' +
          todayCount + " / " + goal + "</span></div>" +
      '<p class="trend-delta' + (todayCount >= goal ? " up" : "") + '">' + note + "</p>" +
      '<div class="goal-plot">' +
        '<div class="goal-line" style="bottom:' + lineAt + '%"><span>hedef ' + goal + "</span></div>" +
        cols +
      "</div>" +
      '<div class="goal-labels">' + labelsHtml + "</div>" +
      streakHtml +
    "</div>";
  }

  /* ------------------------------------------------------------------ */
  /* SRS                                                                */
  /* ------------------------------------------------------------------ */

  function gradeCard(w, q) {
    var c = cardOf(w);
    var now = Date.now();
    c.seen += 1;
    c.last = now;
    state.answers += 1;

    if (q === 0) {
      c.box = 1;
      c.bad += 1;
      c.due = now + 10 * 60000; /* 10 dakika sonra tekrar */
    } else {
      state.correct += 1;
      c.ok += 1;
      var prev = c.box || 0;
      if (q === 1) c.box = Math.max(1, prev);
      else if (q === 2) c.box = Math.min(6, prev + 1);
      else c.box = Math.min(6, prev + 2);

      var days = INTERVALS[c.box] || 1;
      if (q === 1) days = Math.max(1, Math.round(days / 2));
      c.due = now + days * DAY;
    }

    var k = dayKey();
    state.history[k] = (state.history[k] || 0) + 1;

    if (state.streak.last !== k) {
      var y = dayKey(new Date(now - DAY));
      state.streak.days = state.streak.last === y ? state.streak.days + 1 : 1;
      state.streak.last = k;
    }

    save();
    paintStreak();
  }

  /* ------------------------------------------------------------------ */
  /* Oturum                                                             */
  /* ------------------------------------------------------------------ */

  function buildQueue() {
    var goal = Math.max(5, Number(state.settings.goal) || 20);
    var reviews = WORDS.filter(isDue).sort(function (a, b) {
      return state.cards[a.fi].due - state.cards[b.fi].due;
    });
    var news = WORDS.filter(isNew);

    var queue = reviews.slice(0, goal);
    var free = Math.max(3, goal - queue.length);
    queue = queue.concat(news.slice(0, Math.min(news.length, free)));
    return queue;
  }

  /* Rekor satırı: telaffuz hedefini o değere alır ve hedef kadar kelimeyle
     hemen bir telaffuz oturumu başlatır. Bugün sayılmayan kelimeler ve zayıf
     telaffuzlular önce gelir; havuz hedefe yetmezse bugün çalışılanlar eklenir. */
  function goalSession(goal) {
    var g = Math.max(1, Math.min(50, Math.round(Number(goal) || 5)));
    state.settings.pronGoal = g;
    refreshPronRun();
    save();

    var log = state.pronLog || [], today = dayKey(), done = {}, i;
    for (i = 0; i < log.length; i++) {
      if (dayKey(new Date(log[i].at)) === today) done[log[i].fi] = true;
    }

    var p = state.pron || {};
    var weakPool = [], restPool = [];
    for (i = 0; i < WORDS.length; i++) {
      if (done[WORDS[i].fi]) continue;
      if (p[WORDS[i].fi]) weakPool.push(WORDS[i]); else restPool.push(WORDS[i]);
    }
    weakPool.sort(function (a, b) { return (p[a.fi].last || 0) - (p[b.fi].last || 0); });

    var queue = weakPool.concat(shuffle(restPool)).slice(0, g);
    if (queue.length < g) {
      var again = shuffle(WORDS.filter(function (w) { return done[w.fi]; }));
      queue = queue.concat(again.slice(0, g - queue.length));
    }
    if (!queue.length) { toast("Telaffuz için kelime yok."); return; }

    startSession("telaffuz", queue, "records");
    if (session) session.goal = g;
    toast("Telaffuz hedefi " + g + " · " + queue.length + " kelime");
  }

  function startSession(mode, queue, back) {
    queue = queue || buildQueue();
    if (!queue.length) { toast("Çalışacak kart kalmadı — serbest tekrar başlat."); return; }
    session = { mode: mode, queue: queue, back: back || null, goal: null,
      startedAt: Date.now(), i: 0, ok: 0, bad: 0, dir: null, revealed: false, locked: false, feedback: null, mic: null, rec: null };
    renderSession();
  }

  function pickDir() {
    var d = state.settings.direction;
    if (d === "karisik") return Math.random() < 0.5 ? "fi-tr" : "tr-fi";
    return d;
  }

  function nextCard() {
    stopListening();
    session.i += 1;
    session.dir = null;
    session.revealed = false;
    session.locked = false;
    session.feedback = null;
    session.mic = null;
    renderSession();
  }

  function answer(q) {
    var w = session.queue[session.i];
    if (q === 0) session.bad += 1; else session.ok += 1;
    gradeCard(w, q);
    nextCard();
  }

  function testOptions(w) {
    var field = session.dir === "fi-tr" ? "tr" : "fi";
    var correct = primary(w[field]);
    var pool = [];
    WORDS.forEach(function (x) {
      if (x.fi === w.fi) return;
      var p = primary(x[field]);
      if (p !== correct && pool.indexOf(p) === -1) pool.push(p);
    });
    shuffle(pool);
    var opts = [correct].concat(pool.slice(0, 3));
    return shuffle(opts);
  }

  function checkTyping(w, value) {
    var field = session.dir === "fi-tr" ? "tr" : "fi";
    var alts = String(w[field]).split("/").map(function (s) { return s.trim(); }).filter(Boolean);
    var raw = String(value || "").trim();
    if (!raw) return "empty";
    var low = raw.toLowerCase();
    for (var i = 0; i < alts.length; i++) if (alts[i].toLowerCase() === low) return "ok";
    for (var j = 0; j < alts.length; j++) if (fold(alts[j]) === fold(raw)) return "near";
    return "no";
  }

  /* ------------------------------------------------------------------ */
  /* Telaffuz: dinle -> tekrar et -> benzerlik puanı                      */
  /* ------------------------------------------------------------------ */

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  function levenshtein(a, b) {
    var m = a.length, n = b.length, prev = [], cur, i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur = [i];
      for (j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }

  /* Aksan ve büyük/küçük harf farkını yok sayarak 0-100 arası benzerlik */
  function similarity(expected, heard) {
    var a = fold(expected), b = fold(heard);
    if (!a && !b) return 100;
    if (!a || !b) return 0;
    var d = levenshtein(a, b);
    return Math.max(0, Math.round((1 - d / Math.max(a.length, b.length)) * 100));
  }

  function scoreClass(score) {
    if (score >= 85) return "good";
    if (score >= 60) return "ok";
    return "bad";
  }

  function stopListening() {
    if (session && session.rec) {
      try { session.rec.abort(); } catch (e) { /* yok say */ }
      session.rec = null;
    }
  }

  function startListening() {
    if (!session || session.locked) return;
    if (session.mic && session.mic.status === "listening") return;
    if (!SR) {
      toast("Bu tarayıcıda konuşma tanıma yok — dinleyip kendini puanla.");
      return;
    }
    var w = session.queue[session.i];
    var rec = new SR();
    rec.lang = "fi-FI";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    session.rec = rec;
    session.mic = { status: "listening" };
    renderSession();

    rec.onresult = function (e) {
      var heard = "";
      try { heard = e.results[0][0].transcript || ""; } catch (err) { heard = ""; }
      var score = similarity(w.fi, heard);
      var added = rememberPron(w.fi, score);
      session.mic = { status: "done", transcript: heard, score: score };
      session.locked = true;
      if (score >= 60) session.ok += 1; else session.bad += 1;
      gradeCard(w, score >= 85 ? 3 : score >= 60 ? 2 : 0);
      session.rec = null;
      renderSession();
      if (added) toast("Zayıf telaffuz listesine eklendi: " + w.fi);
    };
    rec.onerror = function (e) {
      var code = e && e.error ? e.error : "bilinmeyen";
      session.mic = { status: "error", message: code === "not-allowed" ? "Mikrofon izni verilmedi." : "Dinleme başarısız oldu (" + code + ")." };
      session.rec = null;
      renderSession();
    };
    rec.onend = function () {
      if (session && session.mic && session.mic.status === "listening") {
        session.mic = { status: "error", message: "Ses duyulamadı, tekrar dene." };
        session.rec = null;
        renderSession();
      }
    };
    try { rec.start(); } catch (e) {
      session.mic = { status: "error", message: "Mikrofon başlatılamadı." };
      session.rec = null;
      renderSession();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Ekran: oturum                                                      */
  /* ------------------------------------------------------------------ */

  /* Oturum ekranındaki tek satırlık klavye ipucu: moda göre en işe yarar tuş. */
  function kbdHintHtml(mode, locked, revealed) {
    var hint;
    if (locked) hint = "<kbd>Enter</kbd> sonraki kart";
    else if (mode === "yaz") hint = "<kbd>Enter</kbd> cevabı kontrol et · <kbd>Tab</kbd> ile gezin";
    else if (mode === "test") hint = "<kbd>Tab</kbd> seçenekler · <kbd>Enter</kbd> seç";
    else if (mode === "kart" && !revealed) hint = "<kbd>Tab</kbd> Cevabı göster · <kbd>Enter</kbd> düğmeyi açar";
    else hint = "<kbd>Tab</kbd> puanla · <kbd>Enter</kbd> onayla";
    return '<p class="kbd-hint">' + hint + "</p>";
  }

  function renderSession() {
    if (!session) return;
    if (session.i >= session.queue.length) { renderDone(); return; }
    if (!session.dir) session.dir = pickDir();

    var w = session.queue[session.i];
    var fiToTr = session.mode === "telaffuz" ? true : session.dir === "fi-tr";
    var promptLang = fiToTr ? "Fince" : "Türkçe";
    var answerLang = fiToTr ? "Türkçe" : "Fince";
    var prompt = fiToTr ? w.fi : w.tr;
    var answerText = fiToTr ? w.tr : w.fi;
    var speakLang = fiToTr ? "fi-FI" : "tr-TR";
    var headLang = session.mode === "telaffuz" ? "fi-FI" : speakLang;
    var headLabel = headLang === "fi-FI" ? "Kelimeyi Fince sesli oku" : "Kelimeyi Türkçe sesli oku";
    var pct = Math.round((session.i / session.queue.length) * 100);
    var html = "";

    html += '<section class="session">';
    html += '<div class="session-top">';
    html += '<button type="button" class="ghost" data-action="quit" title="Oturumu bitir"' +
            ' aria-label="Oturumu bitir">✕</button>';
    html += '<div class="bar" role="progressbar" aria-label="Oturum ilerlemesi"' +
            ' aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '">' +
            '<i style="width:' + pct + '%"></i></div>';
    html += '<span class="counter" aria-label="Kart ' + (session.i + 1) + " / " + session.queue.length + '">' +
            (session.i + 1) + "/" + session.queue.length + "</span>";
    html += "</div>";
    html += kbdHintHtml(session.mode, session.locked, session.revealed);

    html += '<div class="card study-card' + (session.revealed ? " revealed" : "") + '">';
    html += '<div class="card-head"><span class="chip">' + esc(w.cat) + "</span>";
    html += '<button type="button" class="icon-btn" data-action="speak" data-fi="' + esc(w.fi) +
            '" data-lang="' + headLang + '" title="Sesli oku"' +
            ' aria-label="' + headLabel + '">' + ico("speaker") + "</button></div>";
    html += '<p class="lang">' + promptLang + "</p>";
    html += '<h2 class="word">' + esc(prompt) + "</h2>";

    if (session.mode === "kart") {
      if (session.revealed) {
        html += '<div class="answer">';
        html += '<p class="lang">' + answerLang + "</p>";
        html += '<h3 class="answer-word">' + esc(answerText) + "</h3>";
        if (w.note) html += '<p class="note">' + esc(w.note) + "</p>";
        html += "</div>";
      } else {
        html += '<button type="button" class="primary" data-action="reveal">Cevabı göster</button>';
      }
    } else if (session.mode === "test") {
      var opts = testOptions(w);
      html += '<div class="options" role="group" aria-label="Seçenekler">';
      opts.forEach(function (o, idx) {
        var cls = "option";
        var fb = session.feedback;
        if (fb) {
          if (o === fb.correct) cls += " correct";
          else if (o === fb.chosen) cls += " wrong";
        }
        var optLabel = "ABCD".charAt(idx) + " seçeneği: " + o;
        if (fb) {
          if (o === fb.correct) optLabel += " · doğru cevap";
          else if (o === fb.chosen) optLabel += " · yanlış cevap";
        }
        html += '<button type="button" class="' + cls + '" data-opt="' + esc(o) + '"' +
                (session.locked ? " disabled" : "") +
                ' aria-label="' + esc(optLabel) + '">' + esc(o) + "</button>";
      });
      html += "</div>";
    } else if (session.mode === "telaffuz") {
      var micState = session.mic || null;
      html += '<div class="pron">';
      html += '<p class="lang">Türkçe</p>';
      html += '<p class="pron-mean">' + esc(w.tr) + "</p>";
      if (w.note) html += '<p class="note">' + esc(w.note) + "</p>";
      html += '<div class="pron-actions">';
      html += '<button type="button" class="listen" data-action="speak" data-fi="' + esc(w.fi) +
              '" data-lang="fi-FI" aria-label="Kelimeyi Fince dinle">' + ico("speaker") + " Dinle</button>";
      html += '<button type="button" class="mic' + (micState && micState.status === "listening" ? " on" : "") + '" data-action="listen"' +
              (session.locked ? " disabled" : "") +
              ' aria-label="Mikrofonu aç ve kelimeyi Fince tekrar et">' + ico("mic") + " Tekrar et</button>";
      html += "</div>";
      html += '<p class="muted small">' + (SR ? "Mikrofon yalnızca düğmeye basınca açılır, ses kaydedilmez; tanıma için tarayıcının konuşma servisi kullanılır." : "Bu tarayıcı konuşma tanımayı desteklemiyor: kelimeyi dinle, tekrar et ve kendini puanla.") + "</p>";
      if (micState && micState.status === "listening") html += '<p class="listening" role="status" aria-live="polite">Dinliyorum…</p>';
      if (micState && micState.status === "done") {
        html += '<div class="score ' + scoreClass(micState.score) + '" role="status" aria-live="polite"' +
                ' aria-label="Tanıma sonucu yüzde ' + micState.score + '">';
        html += "<b>%" + micState.score + "</b>";
        html += "<span>Duyulan: " + esc(micState.transcript || "(ses yok)") + "</span>";
        html += "</div>";
      }
      if (micState && micState.status === "error") html += '<p class="feedback no">' + esc(micState.message) + "</p>";
      html += "</div>";
    } else {
      html += '<div class="typing">';
      html += '<input id="typeInput" type="text" autocomplete="off" autocapitalize="off" spellcheck="false"' +
              ' placeholder="' + esc(answerLang) + " karşılığını yaz…\"" +
              ' aria-label="' + esc(answerLang) + " karşılığını yaz\"" +
              (session.feedback ? ' aria-describedby="typeFeedback"' : "") +
              (session.locked ? " disabled" : "") + ">";
      html += '<button type="button" class="primary" data-action="check"' + (session.locked ? " disabled" : "") +
              ' aria-label="Cevabı kontrol et">Kontrol et</button>';
      html += "</div>";
      if (session.feedback) {
        html += '<div class="feedback ' + session.feedback.status + '" id="typeFeedback"' +
                ' role="status" aria-live="polite" aria-atomic="true">';
        if (session.feedback.status === "ok") html += "Doğru ✔";
        else if (session.feedback.status === "near") html += "Doğru, ama aksanları kontrol et: <b>" + esc(answerText) + "</b>";
        else if (session.feedback.status === "empty") html += "Bir şey yazmadın.";
        else html += "Doğrusu: <b>" + esc(answerText) + "</b>";
        if (w.note) html += '<p class="note">' + esc(w.note) + "</p>";
        html += "</div>";
      }
    }
    html += "</div>";

    var showGrades = (session.mode === "kart" && session.revealed) || (session.mode === "telaffuz" && !session.locked);
    if (showGrades) {
      html += '<div class="grades" role="group" aria-label="Kendini puanla">';
      html += '<button type="button" class="g0" data-grade="0" aria-label="Bilmedim: kelimeyi hiç hatırlamadım">Bilmedim</button>';
      html += '<button type="button" class="g1" data-grade="1" aria-label="Zor: zor hatırladım">Zor</button>';
      html += '<button type="button" class="g2" data-grade="2" aria-label="İyi: iyi hatırladım">İyi</button>';
      html += '<button type="button" class="g3" data-grade="3" aria-label="Kolay: kolay hatırladım">Kolay</button>';
      html += "</div>";
    }
    if (session.locked) {
      html += '<button type="button" class="primary wide" data-action="next"' +
              ' aria-label="Sonraki karta geç">Devam →</button>';
    }
    html += "</section>";

    app.innerHTML = html;

    var ann = "Kart " + (session.i + 1) + "/" + session.queue.length + " · " +
              promptLang + ": " + prompt;
    if (session.mode === "kart" && session.revealed) {
      ann += " · " + answerLang + ": " + answerText;
    } else if (session.mode === "test" && session.feedback) {
      ann += session.feedback.chosen === session.feedback.correct
        ? " · doğru: " + session.feedback.correct
        : " · yanlış, doğrusu: " + session.feedback.correct;
    }
    /* Yazmada geri bildirim kutusu kendi canlı bölgesiyle duyuruyor. */
    if (!(session.mode === "yaz" && session.feedback)) announce(ann);

    var input = document.getElementById("typeInput");
    if (input) input.focus();
  }

  function fmtSecs(sec) {
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    if (m >= 60) {
      var h = Math.floor(m / 60);
      return h + ":" + pad2(m % 60) + ":" + pad2(s);
    }
    return m + ":" + pad2(s);
  }

  /* Son oturumun özeti: tablonun üstünde kısa süreli şerit. */
  function recSummaryHtml() {
    if (!recSummary) return "";
    var answered = recSummary.ok + recSummary.bad;
    var pct = answered ? Math.round((recSummary.ok / answered) * 100) : 0;
    return '<div class="rec-summary" id="recSummary" role="status">' +
      '<span class="rec-sum-ico" aria-hidden="true">' + ico("mic") + "</span>" +
      '<span class="rec-sum-text"><b>Son oturum</b> · ' + recSummary.ok + " doğru · " +
        recSummary.bad + " yanlış · %" + pct +
        '<span class="rec-sum-diff">' + paceText(recSummary) + "</span></span>" +
      '<span class="rec-sum-time">' + fmtSecs(recSummary.secs) + "</span>" +
      (recSummary.goal
        ? '<button type="button" class="rec-sum-btn" data-action="rec-again"' +
            ' title="Aynı hedefle yeniden başlat">Tekrar</button>'
        : "") +
    "</div>";
  }

  /* Rekor tablosundan başlatılan oturumların süreleri: karşılaştırma bundan çıkar. */
  function pronSessionsList() {
    if (!Array.isArray(state.pronSessions)) state.pronSessions = [];
    return state.pronSessions;
  }

  /* "ort. 1:30 · 30 sn hızlı" / "… yavaş" / "… ortalamayla aynı" */
  function paceText(sum) {
    if (!sum || !sum.prevN) return "ilk ölçüm · ortalama oluşuyor";
    var base = "ort. " + fmtSecs(sum.prevAvg);
    var d = Math.round(sum.diff);
    if (d >= 1) return base + " · " + d + " sn hızlı";
    if (d <= -1) return base + " · " + (-d) + " sn yavaş";
    return base + " · ortalamayla aynı";
  }

  /* Özeti hazırlar: son 5 oturumun ortalamasıyla karşılaştırır, sonra bu
     oturumu listeye ekler (en fazla 40 kayıt). */
  function summariseSession(goal, ok, bad, total, secs) {
    var list = pronSessionsList();
    var recent = list.slice(-5);
    var sum = 0, n = 0;
    for (var i = 0; i < recent.length; i++) {
      var v = Number(recent[i] && recent[i].secs);
      if (isFinite(v) && v >= 0 && v <= 3600) { sum += v; n += 1; }
    }
    var avg = n ? sum / n : 0;
    var out = {
      goal: goal, ok: ok, bad: bad, total: total, secs: secs,
      prevN: n, prevAvg: avg, diff: n ? avg - secs : 0
    };
    list.push({
      at: Date.now(), goal: goal, ok: ok, bad: bad,
      total: total, secs: Math.round(secs)
    });
    while (list.length > 40) list.shift();
    save();
    return out;
  }

  function scheduleSummaryHide() {
    if (summaryTimer) clearTimeout(summaryTimer);
    summaryTimer = setTimeout(function () {
      summaryTimer = 0;
      recSummary = null;
      var el = document.getElementById("recSummary");
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }, 9000);
  }

  /* Rekor tablosundan açılan oturum bitince İstatistik'e dönüp tabloyu
     görünür alana getirir; özet şeridi kısa süreliğine tablonun üstünde durur. */
  function backToRecords() {
    setTab("stats");
    var card = document.getElementById("recordsCard");
    if (card && card.scrollIntoView) {
      card.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    scheduleSummaryHide();
  }

  function renderDone() {
    if (session.back === "records") {
      var rOk = session.ok, rBad = session.bad, rTotal = session.queue.length;
      var rSecs = (Date.now() - (session.startedAt || Date.now())) / 1000;
      recSummary = summariseSession(session.goal, rOk, rBad, rTotal, rSecs);
      session = null;
      toast("Oturum tamam · " + rOk + "/" + rTotal + " doğru");
      backToRecords();
      return;
    }
    var total = session.queue.length;
    var pct = total ? Math.round((session.ok / total) * 100) : 0;
    app.innerHTML =
      '<section class="pad">' +
        '<div class="card done">' +
          '<div class="big-emoji">' + (pct >= 80 ? "🎉" : "💪") + "</div>" +
          "<h2>Oturum tamam</h2>" +
          '<p class="muted">' + total + " kart · <b>" + session.ok + "</b> doğru · <b>" + session.bad + "</b> yanlış</p>" +
          '<div class="bar big"><i style="width:' + pct + '%"></i></div>' +
          '<p class="muted">Başarı: %' + pct + "</p>" +
          '<div class="row">' +
            '<button type="button" class="primary" data-mode="' + session.mode + '">Yeni oturum</button>' +
            '<button type="button" class="ghost-btn" data-tab-btn="study">Ana ekran</button>' +
          "</div>" +
        "</div>" +
      "</section>";
    announce("Oturum tamam · " + total + " kart · " + session.ok + " doğru · " + session.bad + " yanlış");
    paintStreak();
  }

  /* ------------------------------------------------------------------ */
  /* Ekran: çalış                                                       */
  /* ------------------------------------------------------------------ */

  function greeting() {
    var h = new Date().getHours();
    if (h < 6) return "İyi geceler";
    if (h < 12) return "Günaydın";
    if (h < 18) return "İyi günler";
    return "İyi akşamlar";
  }

  function renderStudy() {
    var due = WORDS.filter(isDue).length;
    var news = WORDS.filter(isNew).length;
    var learned = WORDS.filter(isLearned).length;
    var goal = Math.max(5, Number(state.settings.goal) || 20);
    var done = state.history[dayKey()] || 0;
    var pct = Math.min(100, Math.round((done / goal) * 100));
    var d = state.settings.direction;
    var weak = weakWords();
    var weakHtml = "";
    if (weak.length) {
      var weakChips = "";
      weak.slice(0, 12).forEach(function (w) {
        weakChips += '<button type="button" class="weak-chip" data-weak="' + esc(w.fi) + '" title="Tek başına çalış">' +
          esc(w.fi) + '<i>%' + state.pron[w.fi].last + "</i></button>";
      });
      if (weak.length > 12) weakChips += '<span class="muted small">+' + (weak.length - 12) + " daha</span>";
      weakHtml =
        '<div class="card weak-card">' +
          '<div class="weak-head"><b>Zayıf telaffuz</b><span class="chip">' + weak.length + "</span></div>" +
          '<p class="muted small">Son denemede %' + PRON_WEAK + " altında kalan kelimeler. Bir kelimeye dokunup tek başına çalışabilirsin.</p>" +
          '<div class="weak-list">' + weakChips + "</div>" +
          '<button type="button" class="primary wide" data-action="weak-session">Sadece bunlarla çalış (' + weak.length + ")</button>" +
          '<button type="button" class="ghost-btn" data-action="weak-clear">Listeyi temizle</button>' +
        "</div>";
    }

    app.innerHTML =
      '<section class="pad">' +
        '<div class="card hero">' +
          '<div class="ring" style="--p:' + pct + '%"><span>' + done + "<small>/" + goal + "</small></span></div>" +
          '<div class="hero-text"><h1>' + greeting() + "</h1>" +
            "<p>" + (due ? "<b>" + due + "</b> kart tekrar bekliyor." : "Tekrar borcun yok " + ico("test", "ico-inline")) + "</p>" +
            '<p class="muted small">Seri: ' + state.streak.days + " gün · Öğrenilen: " + learned + "/" + WORDS.length + "</p>" +
          "</div>" +
        "</div>" +

        '<div class="stats-row">' +
          '<div class="mini"><b>' + due + "</b><span>tekrar</span></div>" +
          '<div class="mini"><b>' + news + "</b><span>yeni</span></div>" +
          '<div class="mini"><b>' + learned + "</b><span>öğrenildi</span></div>" +
        "</div>" +

        dayNoteHtml() +
        weakHtml +
        '<h2 class="section-title">Çalışma modu</h2>' +
        '<div class="modes">' +
          '<button type="button" class="mode" data-mode="kart">' + ico("kart", "ico-mode") + '<b>Kart</b><small>Çevir, kendini puanla</small></button>' +
          '<button type="button" class="mode" data-mode="test">' + ico("test", "ico-mode") + '<b>Test</b><small>4 seçenekten bul</small></button>' +
          '<button type="button" class="mode" data-mode="yaz">' + ico("yaz", "ico-mode") + '<b>Yazma</b><small>Karşılığını yaz</small></button>' +
          '<button type="button" class="mode" data-mode="telaffuz">' + ico("mic", "ico-mode") + '<b>Telaffuz</b><small>Dinle, tekrar et, puan al</small></button>' +
        "</div>" +

        '<button type="button" class="ghost-btn wide" data-action="free">Serbest tekrar (10 kart)</button>' +

        '<div class="card settings-card">' +
          "<label>Çeviri yönü</label>" +
          '<div class="seg">' +
            '<button type="button" data-dir="fi-tr" class="' + (d === "fi-tr" ? "on" : "") + '">FI → TR</button>' +
            '<button type="button" data-dir="tr-fi" class="' + (d === "tr-fi" ? "on" : "") + '">TR → FI</button>' +
            '<button type="button" data-dir="karisik" class="' + (d === "karisik" ? "on" : "") + '">Karışık</button>' +
          "</div>" +
          '<p class="muted small">Günlük hedef ve yedekleme için İstatistik sekmesine bak.</p>' +
        "</div>" +
      "</section>";
  }

  /* ------------------------------------------------------------------ */
  /* Ekran: liste                                                       */
  /* ------------------------------------------------------------------ */

  function renderList() {
    var chips = '<button type="button" class="chip-btn' + (listCat ? "" : " on") + '" data-cat="">Tümü</button>';
    chips += '<button type="button" class="chip-btn weak' + (listCat === "__weak__" ? " on" : "") + '" data-cat="__weak__">Zayıf telaffuz' +
      (weakWords().length ? " (" + weakWords().length + ")" : "") + "</button>";
    CATS.forEach(function (c) {
      chips += '<button type="button" class="chip-btn' + (listCat === c ? " on" : "") + '" data-cat="' + esc(c) + '">' + esc(c) + "</button>";
    });

    app.innerHTML =
      '<section class="pad">' +
        '<input id="search" class="search" type="search" placeholder="Fince veya Türkçe ara…" value="' + esc(listQuery) + '">' +
        '<div class="chips">' + chips + "</div>" +
        '<div id="rows" class="rows"></div>' +
      "</section>";

    var search = document.getElementById("search");
    search.addEventListener("input", function () {
      listQuery = this.value;
      fillRows();
    });
    fillRows();
  }

  function fillRows() {
    var box = document.getElementById("rows");
    if (!box) return;
    var q = listQuery.trim().toLowerCase();
    var weakMode = listCat === "__weak__";
    var pool = weakMode ? weakWords() : WORDS;
    var rows = pool.filter(function (w) {
      if (!weakMode && listCat && w.cat !== listCat) return false;
      if (!q) return true;
      return (w.fi + " " + w.tr).toLowerCase().indexOf(q) !== -1;
    });

    if (!rows.length) {
      box.innerHTML = weakMode
        ? '<p class="muted center">Liste boş — Telaffuz modunda %60 altında kalan kelimeler burada birikir.</p>'
        : '<p class="muted center">Sonuç yok.</p>';
      return;
    }
    var html = "";
    rows.forEach(function (w) {
      var c = state.cards[w.fi];
      var dots = "";
      for (var i = 1; i <= 5; i++) dots += '<i class="dot' + (c && c.box >= i ? " on" : "") + '"></i>';
      html += '<div class="row-item">' +
        '<div class="row-main">' +
          '<div class="row-fields"><b>' + esc(w.fi) + "</b><span>" + esc(w.tr) + "</span></div>" +
          (w.note ? '<p class="note">' + esc(w.note) + "</p>" : "") +
        "</div>" +
        '<div class="row-side">' +
          '<button type="button" class="icon-btn" data-action="speak" data-fi="' + esc(w.fi) + '" data-lang="fi-FI" title="Fince oku">' + ico("speaker") + '</button>' +
          (weakMode
            ? '<span class="score-pill ' + scoreClass(state.pron[w.fi].last) + '">%' + state.pron[w.fi].last + "</span>"
            : '<div class="dots">' + dots + "</div>") +
        "</div>" +
      "</div>";
    });
    box.innerHTML = html;
  }

  /* ------------------------------------------------------------------ */
  /* Ekran: ipuçları                                                    */
  /* ------------------------------------------------------------------ */

  /* İpuçları → öğrenme yolu: 34 derslik izlence.
     Sıra ve konular T. Argutina-Islamaeva, Suomen kieltä itseopiskeluun
     (Petroskoi: Periodika, 2019) kitabının birinci bölümünden; başlıklar
     Türkçeye çevrildi, ders içerikleri bu uygulamanın kendi listesinden
     çalışılır. [Türkçe başlık, Fince karşılık] */
  var PATH_LESSONS = [
    ["Alfabe ve sesler", "Aakkoset ja äänteet"],
    ["Kendini anlatmak", "Kertomus itsestäni", "Kalıplar"],
    ["Karşındakini anlatmak", "Kertomus sinusta"],
    ["Onu anlatmak", "Kertomus hänestä"],
    ["Fiillerde kişi ekleri", "Verbien persoonapäätteet", "Fiil Kalıpları"],
    ["Fiillerde olumsuzluk", "Verbien kieltomuoto"],
    ["Soru sözcükleri", "Kysymyssanat"],
    ["Fiil grupları", "Verbiryhmät", "Fiiller"],
    ["Pekiştirme", "Kertausta"],
    ["Olumsuz fiil çekimi", "Verbien kieltomuoto"],
    ["Sayılar", "Lukusanat", "Sayılar"],
    ["Aile", "Perhe", "Aile"],
    ["Saat", "Kellonaika", "Zaman"],
    ["Adessiv (-lla/-llä)", "Adessiivi"],
    ["Aile söz varlığı", "Perhe"],
    ["Renkler", "Värit", "Renkler"],
    ["İç yer hâlleri (-ssa/-stä/-Vn)", "Sisäpaikallissijat", "Şehir"],
    ["Dış yer hâlleri (-lla/-lta/-lle)", "Ulkopaikallissijat"],
    ["Kişi adılları yer hâllerinde", "Persoonat paikallissijoissa"],
    ["İsimlerin çekimi", "Nominien taivutus"],
    ["Elativ (-sta/-stä)", "Elatiivi"],
    ["Partitiivi ve anlamları", "Partitiivi ja sen merkitykset"],
    ["Gıda maddeleri", "Elintarvikkeet", "Yiyecek"],
    ["Noel", "Joulu"],
    ["İsim çekimi: çokluk", "Nominien taivutus"],
    ["Nesne hâlleri: partitiivi / akkusatiivi", "Objektin muodot"],
    ["İyelik ekleri", "Omistusliitteet"],
    ["Zarflar", "Adverbit"],
    ["Zaman anlatımları", "Ajanilmaukset", "Takvim"],
    ["Genitiv", "Genetiivi"],
    ["Genitiv: kullanım", "Genetiivi"],
    ["Zaman yapıları", "Ajanilmaukset"],
    ["Gerekli bilgiler", "Tarpeellista tietoa"],
    ["Ünsüz derecelenmesi", "Konsonanttivaihtelut"]
  ];
  /* Bir kategoriye düşen kelime sayısı (ders düğmesindeki etiket). */
  function catCount(cat) {
    var n = 0;
    for (var i = 0; i < WORDS.length; i++) if (WORDS[i].cat === cat) n++;
    return n;
  }

  /* Kategori oturumu: tekrar zamanı gelenler önce, sonra yeni kelimeler,
     kalan yer öğrenilmişlerden doldurulur; hedef kart sayısını aşmaz. */
  function catQueue(cat) {
    var goal = Math.max(5, Number(state.settings.goal) || 20);
    var all = WORDS.filter(function (w) { return w.cat === cat; });
    var due = all.filter(isDue).sort(function (a, b) {
      return state.cards[a.fi].due - state.cards[b.fi].due;
    });
    var news = all.filter(isNew);
    var rest = shuffle(all.filter(function (w) { return !isDue(w) && !isNew(w); }));
    return due.concat(news, rest).slice(0, goal);
  }

  /* Dersleri from–to aralığında numaralı liste olarak basar.
     Kategorisi olan ders bir düğmedir: tek dokunuşla o kategoride
     Kart oturumu başlar. Kategorisi olmayan ders düz metin kalır. */
  function lessonPath(from, to) {
    var html = '<ol class="path" start="' + from + '">';
    for (var i = from; i <= to; i++) {
      var l = PATH_LESSONS[i - 1];
      var body = "<b>" + l[0] + '</b> <span class="fin">' + l[1] + "</span>";
      if (l[2] && catCount(l[2])) {
        html += '<li><button type="button" class="path-go" data-lesson="' + esc(l[2]) + '"' +
          ' title="' + esc(l[2]) + ' kategorisiyle çalış">' + body +
          '<span class="path-count">' + catCount(l[2]) + " kelime</span></button></li>";
      } else {
        html += "<li>" + body + "</li>";
      }
    }
    return html + "</ol>";
  }

  function renderTips() {
    app.innerHTML =
      '<section class="pad tips">' +
        "<h2>Fince'yi Türkçe bilen biri olarak öğrenmek</h2>" +
        '<p class="muted">Fince Ural, Türkçe Altay dil ailesinde; akraba değiller. Ama tipolojik olarak şaşırtıcı ölçüde benzerler — bu, Türkçe konuşan için büyük avantaj.</p>' +

        '<h3>Ortak noktalar</h3>' +
        "<ul>" +
          "<li><b>Eklemeli yapı:</b> Türkçede <i>ev-ler-imiz-de-ki</i> gibi, Fince'de <i>talo-i-ssa-mme-kin</i> gibi ekler üst üste biner. Kelime kökü değişmez, sonuna ek gelir.</li>" +
          "<li><b>Ses uyumu:</b> Türkçede 4'lü (ı/i/u/ü), Fince'de 2'li. Ekler köke uyar: <i>talo-ssa</i> (evde) ↔ <i>kylä-ssä</i> (köyde).</li>" +
          "<li><b>Cinsiyet yok, artikel yok:</b> <i>hän</i> hem 'o' (kadın) hem 'o' (erkek) demek.</li>" +
          "<li><b>Sıra: özne–fiil–nesne</b> ve soru eki: Türkçe <i>mı/mi</i> ↔ Fince <i>-ko/-kö</i> (<i>Puhutko sinä suomea?</i> = <i>Fince konuşuyor musun?</i>).</li>" +
          "<li><b>Edat yerine son-ek/edat-sonrası:</b> <i>pöydän alla</i> = masan altında.</li>" +
        "</ul>" +

        '<h3>Zor gelen üç konu</h3>' +
        "<ul>" +
          "<li><b>Partitif (partitiivi):</b> Türkçede karşılığı yok. Belirsiz/kısmi nesne ve tüm olumsuz cümlelerde kullanılır: <i>Juon kahvi<i>a</i></i> (kahve içiyorum), <i>En juo kahvi<i>a</i></i> (kahve içmiyorum).</li>" +
          "<li><b>Ünsüz derecelenmesi (astevaihtelu):</b> Türkçede yok. <i>kk→k</i>, <i>pp→p</i>, <i>tt→t</i>, <i>k→∅</i>, <i>t→d</i>: <i>kauppa → kaupassa</i>, <i>katu → kadulla</i>, <i>Helsinki → Helsingissä</i>.</li>" +
          "<li><b>Fiil çekimi:</b> Kişi eki var (<i>olen, olet, on</i>), olumsuzluk ayrı bir fiille yapılır: <i>en, et, ei, emme, ette, eivät</i> + kök. Gelecek zaman yok; şimdiki zaman yeterli.</li>" +
        "</ul>" +

        '<h3>Öğrenme yolu: 34 ders</h3>' +
        '<p class="muted">Sıra, Argutina-Islamaeva\'nın <i>Suomen kieltä itseopiskeluun</i> (Petroskoi 2019) kitabının birinci bölümünden; başlıklar Türkçeye çevrildi. Ders konusu, bu uygulamadaki karşılık gelen kategoriyle birlikte çalışılınca oturuyor; acele etmeden aşama aşama ilerle.</p>' +
        '<h4 class="path-stage">Aşama 1 · ders 1–10: temel cümle ve fiil</h4>' +
        lessonPath(1, 10) +
        '<h4 class="path-stage">Aşama 2 · ders 11–16: günlük hayat</h4>' +
        lessonPath(11, 16) +
        '<h4 class="path-stage">Aşama 3 · ders 17–22: yer ve miktar hâlleri</h4>' +
        lessonPath(17, 22) +
        '<h4 class="path-stage">Aşama 4 · ders 23–34: nesne, iyelik, zaman, ses değişimi</h4>' +
        lessonPath(23, 34) +

        '<h3>Telaffuz kısa rehberi</h3>' +
        '<div class="table">' +
          "<div><b>ä</b><span>Türkçedeki 'e' ile 'a' arası, açık e (æ)</span></div>" +
          "<div><b>ö</b><span>Türkçedeki 'ö' gibi</span></div>" +
          "<div><b>y</b><span>Türkçedeki 'ü' gibi: <i>kylmä</i> ≈ külsmä</span></div>" +
          "<div><b>j</b><span>Türkçedeki 'y' gibi: <i>järvi</i> ≈ yarvi</span></div>" +
          "<div><b>v</b><span>Türkçedeki 'v' gibi (<i>vesi</i>)</span></div>" +
          "<div><b>çift harf</b><span>Uzun ses: <i>tuli</i> (ateş) ≠ <i>tuuli</i> (rüzgâr)</span></div>" +
          "<div><b>vurgu</b><span>Her zaman ilk hecede; Türkçedeki gibi sona kaymaz</span></div>" +
          "<div><b>yazım</b><span>Sesçil: yazıldığı gibi okunur, sürpriz yok</span></div>" +
        "</div>" +

        '<h3>Telaffuz alıştırması</h3>' +
        '<p class="muted">Çalış ekranındaki <b>Telaffuz</b> modunda önce <span class="ico-pair">' + ico("speaker", "ico-inline") + '&nbsp;<b>Dinle</b></span> düğmesiyle kelimeyi Fince duy, sonra <span class="ico-pair">' + ico("mic", "ico-inline") + '&nbsp;<b>Tekrar et</b></span> düğmesiyle aynı kelimeyi kendin söyle. Puan, duyulan metinle beklenen kelimenin harf düzeyinde karşılaştırmasıyla hesaplanır; aksan işaretleri yok sayıldığı için %85 üstü “iyi”, %60–84 “yakın” sayılır. Tanıma servisi aksanlı söyleyişte kelimeyi eksik yazabilir — puanı kesin ölçü değil, tekrar sinyali olarak gör.</p>' +
        '<p class="muted">Puanı %60 altında kalan kelimeler çalış ekranındaki <b>Zayıf telaffuz</b> listesine düşer; tek dokunuşla yalnızca onlardan oturum başlatabilirsin. %60 ve üzeri puan alan kelime listeden çıkar.</p>' +

        '<h3>Sözlük</h3>' +
        '<p class="muted">Yaklaşık 600 giriş, 33 kategori: günlük kelimeler, fiil kalıpları, deyimler ve ülke/dil adları. Yeni kelime eklemek için data.js dosyasına tek satır yeterli; “Yedek al” ile ilerlemeni JSON olarak saklayabilirsin.</p>' +

        '<h3>Bu uygulama hakkında</h3>' +
        '<p class="muted">Analiz edilen Android dil uygulamasının aksine burada reklam kimliği, analitik kimlik, uygulama içi satın alma ve arka plan servisi yok; uygulama kendiliğinden hiçbir ağ isteği yapmıyor. Tüm ilerleme yalnızca bu tarayıcının localStorage alanında; yedek almak için İstatistik → Yedek al.</p>' +
        '<p class="muted small">Tek istisna, isteğe bağlı <b>telaffuz</b> alıştırması: mikrofon yalnızca sen düğmeye bastığında açılır, ses kaydedilmez. Tanıma için tarayıcının konuşma servisi kullanılır (Chrome&#39;da ses Google&#39;a gidebilir); düğmeye basmazsan uygulama tamamen yerel kalır.</p>' +
        '<p class="muted small">Sözlük elle hazırlanmış “çekirdek” bir listedir; hata görürsen data.js dosyasındaki satırı düzeltmen yeterli.</p>' +
      "</section>";
  }

  /* ------------------------------------------------------------------ */
  /* Ekran: istatistik + ayarlar                                        */
  /* ------------------------------------------------------------------ */

  function renderStats() {
    var total = WORDS.length;
    var learned = WORDS.filter(isLearned).length;
    var due = WORDS.filter(isDue).length;
    var seen = WORDS.filter(function (w) { return !isNew(w); }).length;
    var acc = state.answers ? Math.round((state.correct / state.answers) * 100) : 0;
    var pronGoal = Math.max(1, Number(state.settings.pronGoal) || 5);

    /* son 7 gün */
    var days = [];
    for (var i = 6; i >= 0; i--) {
      var d = new Date(Date.now() - i * DAY);
      var k = dayKey(d);
      days.push({ k: k, label: ["Pz", "Pt", "Sa", "Ça", "Pe", "Cu", "Ct"][d.getDay()], n: state.history[k] || 0 });
    }
    var max = Math.max.apply(null, days.map(function (x) { return x.n; }).concat([1]));
    var chart = "";
    days.forEach(function (x) {
      var h = Math.round((x.n / max) * 100);
      chart += '<div class="col"><i style="height:' + h + '%"></i><span>' + x.label + "</span></div>";
    });

    var trend = pronTrendHtml();

    /* kategori ilerlemesi */
    var cats = "";
    CATS.forEach(function (c) {
      var all = WORDS.filter(function (w) { return w.cat === c; });
      var lc = all.filter(isLearned).length;
      var p = Math.round((lc / all.length) * 100);
      cats += '<div class="catrow"><span>' + esc(c) + "</span>" +
              '<div class="bar thin"><i style="width:' + p + '%"></i></div>' +
              '<b class="muted small">' + lc + "/" + all.length + "</b></div>";
    });

    var goal = Math.max(5, Number(state.settings.goal) || 20);

    app.innerHTML =
      '<section class="pad">' +
        '<div class="stats-row">' +
          '<div class="mini"><b>' + state.streak.days + "</b><span>gün seri</span></div>" +
          '<div class="mini"><b>' + learned + "/" + total + "</b><span>öğrenildi</span></div>" +
          '<div class="mini"><b>%' + acc + "</b><span>doğruluk</span></div>" +
        "</div>" +
        '<div class="stats-row">' +
          '<div class="mini"><b>' + state.answers + "</b><span>toplam cevap</span></div>" +
          '<div class="mini"><b>' + seen + "</b><span>görülen kelime</span></div>" +
          '<div class="mini"><b>' + due + "</b><span>bugün tekrar</span></div>" +
        "</div>" +

        '<h2 class="section-title">Son 7 gün</h2>' +
        '<div class="card chart">' + chart + "</div>" +

        '<h2 class="section-title">Telaffuz eğilimi</h2>' +
        trend.html +

        '<h2 class="section-title">Telaffuz hedefi</h2>' +
        pronGoalHtml() +
        pronRecordsHtml() +
        recentSessionsHtml() +

        '<h2 class="section-title">En çok zorlanan 5 kelime</h2>' +
        hardestHtml() +

        '<h2 class="section-title">Kategori ilerlemesi</h2>' +
        '<div class="card cats">' + cats + "</div>" +

        '<h2 class="section-title">Ayarlar</h2>' +
        '<div class="card settings-card">' +
          '<label for="goalInput">Günlük hedef (kart)</label>' +
          '<input id="goalInput" class="num" type="number" min="5" max="200" step="5" value="' + goal + '">' +
          '<label for="pronGoalInput" class="label-gap">Günlük telaffuz hedefi (farklı kelime)</label>' +
          '<input id="pronGoalInput" class="num" type="number" min="1" max="50" step="1" value="' + pronGoal + '">' +
          '<p class="muted small">Seri: ' + state.streak.days + " gün" +
            (state.streak.last ? " · son çalışma: " + esc(state.streak.last) : "") + "</p>" +
          '<div class="row">' +
            '<button type="button" class="ghost-btn" data-action="export">Yedek al (JSON)</button>' +
            '<button type="button" class="ghost-btn" data-action="import">Yedek yükle</button>' +
          "</div>" +
          '<button type="button" class="danger" data-action="reset">İlerlemeyi sıfırla</button>' +
        "</div>" +
      "</section>";

    var gi = document.getElementById("goalInput");
    if (gi) {
      gi.addEventListener("change", function () {
        var v = Math.max(5, Math.min(200, Number(this.value) || 20));
        state.settings.goal = v;
        save();
        toast("Günlük hedef: " + v);
      });
    }

    var pg = document.getElementById("pronGoalInput");
    if (pg) {
      pg.addEventListener("change", function () {
        var raw = parseFloat(this.value);
        if (!isFinite(raw)) raw = 5;
        var v = Math.max(1, Math.min(50, Math.round(raw)));
        state.settings.pronGoal = v;
        refreshPronRun();
        save();
        toast("Telaffuz hedefi: günde " + v + " farklı kelime");
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Yedekleme                                                          */
  /* ------------------------------------------------------------------ */

  function exportData() {
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "sanat-yedek-" + dayKey() + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast("Yedek indirildi");
  }

  function importData() {
    var inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "application/json,.json";
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try {
          var p = JSON.parse(String(r.result));
          if (!p || typeof p !== "object") throw new Error("geçersiz");
          var s = freshState();
          s.settings = Object.assign({ direction: "fi-tr", goal: 20, pronGoal: 5 }, p.settings || {});
          s.cards = p.cards || {};
          s.custom = Array.isArray(p.custom) ? p.custom.slice(0, 20000) : [];
          s.packs = (p.packs && typeof p.packs === "object") ? p.packs : {};
          s.history = p.history || {};
          s.pron = p.pron || {};
          s.pronLog = Array.isArray(p.pronLog) ? p.pronLog.slice(-400) : [];
          s.pronBest = (p.pronBest && typeof p.pronBest === "object") ? p.pronBest : {};
          s.pronRun = (p.pronRun && typeof p.pronRun === "object") ? p.pronRun : {};
          s.pronSessions = Array.isArray(p.pronSessions) ? p.pronSessions.slice(-40) : [];
          s.dayNote = p.dayNote || null;
          s.lastSeen = typeof p.lastSeen === "string" ? p.lastSeen : null;
          s.streak = Object.assign({ last: null, days: 0 }, p.streak || {});
          s.answers = p.answers || 0;
          s.correct = p.correct || 0;
          state = s;
          save();
          paintStreak();
          refreshPronRun();
          hydrateCustom();
          renderTab();
          toast("Yedek yüklendi");
        } catch (e) {
          toast("Dosya okunamadı");
        }
      };
      r.readAsText(f);
    };
    inp.click();
  }

  /* ------------------------------------------------------------------ */
  /* Genel çizim / olaylar                                              */
  /* ------------------------------------------------------------------ */

  function paintStreak() {
    var el = document.getElementById("streakDays");
    if (el) el.textContent = state.streak.days;
  }

  /* ------------------------------------------------------------------ */
  /* Kelime paketleri                                                   */
  /* ------------------------------------------------------------------ */

  /* Paket kaydını uygulamanın kelime biçimine çevirir; zorunlu alan yoksa null. */
  /* Paketler kategorileri küçük harfli Fince adlarla taşır ("aile", "fiiller"),
     çekirdek sözlük ise Türkçe adlar kullanır ("Aile", "Fiiller"). Aynı konu
     iki ayrı çip olarak durmasın diye eşlenir; eşlenmeyenler yeni kategori olur. */
  var CAT_ALIAS = {
    aile: "Aile", doga: "Doğa", ev: "Ev", fiiller: "Fiiller", okul: "Okul",
    sayilar: "Sayılar", sehir: "Şehir", seyahat: "Seyahat", vucut: "Vücut",
    sifat: "Sıfatlar", yemek: "Yiyecek", ilmaisut: "Kalıplar",
    yhteiskunta: "Toplum", kultur: "Kültür", dilbilgisi: "Dilbilgisi"
  };

  function mapCat(cat) {
    var raw = String(cat || "").trim();
    if (!raw) return "Genel";
    return CAT_ALIAS[raw.toLowerCase()] || raw;
  }

  function packWord(raw) {
    if (!raw || typeof raw !== "object") return null;
    var fi = String(raw.fi || "").trim();
    var tr = String(raw.tr || "").trim();
    if (!fi || !tr) return null;
    return { fi: fi, tr: tr, cat: mapCat(raw.cat) };
  }

  /* Diskteki özel kelimeleri sözlüğe katar; aynı Fince kelime iki kez girmez. */
  function hydrateCustom() {
    var list = Array.isArray(state.custom) ? state.custom : [];
    var added = 0, fixed = 0;
    for (var i = 0; i < list.length; i++) {
      var w = packWord(list[i]);
      if (!w) continue;
      /* Daha önce eklenmiş kelimenin kategorisi de yeni eşlemeye çekilir. */
      if (list[i].cat !== w.cat) { list[i].cat = w.cat; fixed += 1; }
      if (wordByFi(w.fi)) continue;
      WORDS.push(w);
      added += 1;
    }
    if (added) rebuildCats();
    if (fixed) save();
    return added;
  }

  var packIndex = null;      // [{ file, pack, count, lvl }]
  var packStatus = "idle";   // idle | loading | ready | error
  var packError = "";
  var packBusy = "";         // şu an eklenen dosya
  var packAll = null;        // toplu ekleme: { i, toplam, eklenen, atlanan, hata }
  var packNote = "";

  /* Daha önce eklenmiş paketin kaydı; yoksa null. Yeni kelime katmayan paket de
     "eklendi" sayılır, yoksa satırda yeniden "Ekle" görünüyordu. */
  function packRecord(file) {
    var rec = state.packs && state.packs[file];
    return (rec && typeof rec === "object") ? rec : null;
  }

  /* Liste ancak kullanıcı isterse indirilir: uygulama kendiliğinden ağa çıkmaz. */
  function loadPackIndex() {
    if (packStatus === "loading") return;
    packStatus = "loading";
    packError = "";
    renderTab();
    fetch("imports/index.json", { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        var list = Array.isArray(data) ? data : (data && Array.isArray(data.packs) ? data.packs : []);
        packIndex = [];
        for (var i = 0; i < list.length; i++) {
          var p = list[i] || {};
          var file = String(p.file || "").trim();
          if (!file) continue;
          packIndex.push({
            file: file,
            pack: String(p.pack || file).trim(),
            count: Math.max(0, Math.round(Number(p.count) || 0)),
            lvl: String(p.lvl || "").trim()
          });
        }
        packStatus = "ready";
        renderTab();
        announce(packIndex.length + " paket listelendi");
      })
      .catch(function (e) {
        packStatus = "error";
        packError = (e && e.message) ? e.message : "ağ hatası";
        renderTab();
      });
  }

  /* Tek paket: indir, doğrula, sözlüğe kat, kaydet. Aynı kelime ikinci kez girmez. */
  function importPack(file) {
    if (!file || packBusy) return;
    packBusy = file;
    packNote = "";
    renderTab();
    fetch("imports/" + file, { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        var s = mergePack(data, file);
        packBusy = "";
        var ad = String(data.pack || file);
        packNote = ad + " · " + (s.eklenen
          ? s.eklenen + " kelime eklendi" + (s.atlanan ? " · " + s.atlanan + " zaten vardı" : "")
          : "yeni kelime yok (" + s.atlanan + " zaten vardı)");
        toast(s.eklenen ? s.eklenen + " kelime eklendi" : "Yeni kelime yok");
        renderTab();
      })
      .catch(function (e) {
        packBusy = "";
        packNote = file + " eklenemedi: " + ((e && e.message) ? e.message : "ağ hatası");
        renderTab();
      });
  }

  /* Paket verisini doğrulayıp sözlüğe katar; tek paket ve toplu ekleme bunu kullanır. */
  function mergePack(data, file) {
    if (!data || data.app !== "suomi-tr" || !data.state || !Array.isArray(data.state.custom)) {
      throw new Error("beklenmeyen dosya biçimi");
    }
    if (!Array.isArray(state.custom)) state.custom = [];
    if (!state.packs || typeof state.packs !== "object") state.packs = {};
    var eklenen = 0, atlanan = 0;
    for (var i = 0; i < data.state.custom.length; i++) {
      var w = packWord(data.state.custom[i]);
      if (!w) continue;
      if (wordByFi(w.fi)) { atlanan += 1; continue; }
      WORDS.push(w);
      state.custom.push(w);
      eklenen += 1;
    }
    rebuildCats();
    state.packs[file] = { n: eklenen, at: dayKey() };
    save();
    return { eklenen: eklenen, atlanan: atlanan };
  }

  /* Sırayla tüm paketleri ekler: tek istek uçar, bitince sıradaki başlar. */
  function importAllPacks() {
    if (!packIndex || !packIndex.length || packAll || packBusy) return;
    packAll = { i: 0, toplam: packIndex.length, eklenen: 0, atlanan: 0, hata: "" };
    packNote = "";
    renderTab();
    nextPackInAll();
  }

  function nextPackInAll() {
    if (!packAll) return;
    if (packAll.i >= packAll.toplam) {
      var ozet = packAll;
      packAll = null;
      packNote = "Tümü eklendi: " + ozet.toplam + " paket · " + ozet.eklenen + " kelime eklendi" +
        (ozet.atlanan ? " · " + ozet.atlanan + " zaten vardı" : "") +
        (ozet.hata ? " · atlandı — " + ozet.hata : "");
      toast(ozet.eklenen ? ozet.eklenen + " kelime eklendi" : "Yeni kelime yok");
      renderTab();
      announce(packNote);
      return;
    }
    var p = packIndex[packAll.i];
    packNote = "Ekleniyor " + (packAll.i + 1) + "/" + packAll.toplam + " · " + p.pack;
    renderTab();
    fetch("imports/" + p.file, { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        var s = mergePack(data, p.file);
        packAll.eklenen += s.eklenen;
        packAll.atlanan += s.atlanan;
        packAll.i += 1;
        nextPackInAll();
      })
      .catch(function (e) {
        packAll.hata = p.file + ": " + ((e && e.message) ? e.message : "ağ hatası");
        packAll.i += 1;
        nextPackInAll();
      });
  }

  function renderPacks() {
    var html = '<section class="pad packs">' +
      '<h2 class="section-title">Kelime paketleri</h2>' +
      '<p class="muted">Paketler uygulamanın yanında durur; liste yalnızca istediğinde indirilir ve eklenen kelimeler bu tarayıcıda saklanır. Uygulama kendiliğinden ağ isteği yapmaz.</p>';

    if (packStatus === "loading") {
      html += '<div class="card"><p class="muted">Paket listesi indiriliyor…</p></div>';
    } else if (packStatus === "error") {
      html += '<div class="card"><p class="muted">Paket listesi alınamadı (' + esc(packError) + ').</p>' +
        '<button type="button" class="primary wide" data-action="packs-load">Tekrar dene</button></div>';
    } else if (packStatus === "ready" && packIndex && packIndex.length) {
      var satir = "";
      var toplam = 0;
      for (var i = 0; i < packIndex.length; i++) {
        var p = packIndex[i];
        var rec = packRecord(p.file);
        var ekli = rec ? Math.max(0, Math.round(Number(rec.n) || 0)) : 0;
        toplam += p.count;
        satir += '<div class="row-item pack-row">' +
          '<div class="row-main"><b>' + esc(p.pack) + '</b>' +
            '<p class="muted small">' + p.count + ' kelime' + (p.lvl ? ' · ' + esc(p.lvl) : '') +
              (rec ? (ekli ? ' · eklendi: ' + ekli : ' · eklendi, yeni kelime yok') : '') + '</p></div>' +
          '<div class="row-side">' +
            '<button type="button" class="ghost-btn pack-add" data-pack="' + esc(p.file) + '"' +
              (packBusy === p.file || packAll ? ' disabled' : '') + '>' +
              (packBusy === p.file ? 'Ekleniyor…' : rec ? 'Yeniden' : 'Ekle') + '</button>' +
          '</div>' +
        '</div>';
      }
      html += '<p class="muted small">' + packIndex.length + ' paket · toplam ' + toplam + ' kelime</p>' +
        (packNote ? '<p class="pack-note" role="status">' + esc(packNote) + '</p>' : '') +
        '<button type="button" class="primary wide" data-action="packs-all"' +
          (packAll || packBusy ? ' disabled' : '') + '>' +
          (packAll
            ? 'Ekleniyor ' + packAll.i + '/' + packAll.toplam + '…'
            : 'Tümünü ekle (' + packIndex.length + ' paket)') +
        '</button>' +
        '<div class="rows">' + satir + '</div>';
    } else if (packStatus === "ready") {
      html += '<div class="card"><p class="muted">Paket listesi boş.</p></div>';
    } else {
      html += '<div class="card"><p class="muted">Kitap 1–2 bölümleri, kitap 3 temaları ve kokoelma: 26 paket.</p>' +
        '<button type="button" class="primary wide" data-action="packs-load">Paketleri getir</button></div>' +
        (packNote ? '<p class="pack-note" role="status">' + esc(packNote) + '</p>' : '');
    }

    var eklenen = Array.isArray(state.custom) ? state.custom.length : 0;
    html += '<p class="muted small">Bu tarayıcıya eklenen kelime: ' + eklenen +
      ' · sözlük toplamı: ' + WORDS.length + '</p>';
    app.innerHTML = html + "</section>";
  }

  function renderTab() {
    if (tab === "study") renderStudy();
    else if (tab === "list") renderList();
    else if (tab === "packs") renderPacks();
    else if (tab === "tips") renderTips();
    else renderStats();
    applyNoteCelebration();
  }

  function setTab(name) {
    stopListening();
    if (session) { session = null; }
    tab = name;
    var buttons = document.querySelectorAll("#tabs button");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle("active", buttons[i].getAttribute("data-tab") === name);
    }
    window.scrollTo(0, 0);
    renderTab();
    announce((TAB_LABELS[name] || name) + " sekmesi");
  }

  document.getElementById("tabs").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-tab]");
    if (b) setTab(b.getAttribute("data-tab"));
  });

  app.addEventListener("click", function (e) {
    var t = e.target;

    var modeBtn = t.closest("[data-mode]");
    if (modeBtn) { startSession(modeBtn.getAttribute("data-mode")); return; }

    /* İpuçları → öğrenme yolu: ders düğmesi, kendi kategorisinde oturum açar. */
    var lessonBtn = t.closest("[data-lesson]");
    if (lessonBtn) {
      var lessonCat = lessonBtn.getAttribute("data-lesson");
      var lessonQueue = catQueue(lessonCat);
      if (!lessonQueue.length) { toast(lessonCat + " için kelime yok."); return; }
      toast(lessonCat + " · " + lessonQueue.length + " kelime");
      startSession("kart", lessonQueue, "tips");
      return;
    }

    var recRow = t.closest("[data-rec-goal]");
    if (recRow) { goalSession(recRow.getAttribute("data-rec-goal")); return; }

    var tabBtn = t.closest("[data-tab-btn]");
    if (tabBtn) { setTab(tabBtn.getAttribute("data-tab-btn")); return; }

    var dirBtn = t.closest("[data-dir]");
    if (dirBtn) {
      state.settings.direction = dirBtn.getAttribute("data-dir");
      save();
      renderTab();
      toast("Yön: " + (state.settings.direction === "fi-tr" ? "Fince → Türkçe"
        : state.settings.direction === "tr-fi" ? "Türkçe → Fince" : "Karışık"));
      return;
    }

    var catBtn = t.closest("[data-cat]");
    if (catBtn) {
      listCat = catBtn.getAttribute("data-cat");
      renderList();
      return;
    }

    var weakBtn = t.closest("[data-weak]");
    if (weakBtn) {
      var ww = wordByFi(weakBtn.getAttribute("data-weak"));
      if (ww) startSession("telaffuz", [ww]);
      return;
    }

    var speakBtn = t.closest('[data-action="speak"]');
    if (speakBtn) {
      var w = wordByFi(speakBtn.getAttribute("data-fi"));
      var lang = speakBtn.getAttribute("data-lang") || "fi-FI";
      if (w) speak(lang === "tr-TR" ? w.tr : w.fi, lang);
      return;
    }

    var packBtn = t.closest("[data-pack]");
    if (packBtn) { importPack(packBtn.getAttribute("data-pack")); return; }

    var action = t.closest("[data-action]") && t.closest("[data-action]").getAttribute("data-action");
    if (action) {
      if (action === "rec-again") {
        var againGoal = recSummary && recSummary.goal;
        if (againGoal) {
          if (summaryTimer) { clearTimeout(summaryTimer); summaryTimer = 0; }
          recSummary = null;
          goalSession(againGoal);
        }
        return;
      }
      if (action === "quit") {
        stopListening();
        var quitBack = session && session.back;
        if (quitBack === "records") {
          recSummary = summariseSession(
            session.goal, session.ok, session.bad, session.i,
            (Date.now() - (session.startedAt || Date.now())) / 1000
          );
        }
        session = null;
        if (quitBack === "records") backToRecords();
        else if (quitBack === "tips") setTab("tips");
        else setTab("study");
        return;
      }
      if (action === "reveal") { session.revealed = true; renderSession(); return; }
      if (action === "listen") { startListening(); return; }
      if (action === "next") { nextCard(); return; }
      if (action === "free") {
        var pool = shuffle(WORDS.slice()).slice(0, 10);
        startSession("kart", pool);
        return;
      }
      if (action === "check") {
        if (!session || session.locked) return;
        var input = document.getElementById("typeInput");
        var w2 = session.queue[session.i];
        var res = checkTyping(w2, input ? input.value : "");
        if (res === "empty") { toast("Önce bir cevap yaz"); return; }
        session.locked = true;
        session.feedback = { status: res };
        if (res === "ok" || res === "near") session.ok += 1; else session.bad += 1;
        gradeCard(w2, res === "no" ? 0 : 2);
        renderSession();
        return;
      }
      if (action === "weak-session") {
        var weakList = weakWords();
        if (!weakList.length) { toast("Zayıf telaffuz listesi boş."); return; }
        startSession("telaffuz", weakList);
        return;
      }
      if (action === "weak-clear") {
        if (!confirm("Zayıf telaffuz listesi temizlensin mi?")) return;
        state.pron = {};
        save();
        paintStreak();
        renderTab();
        toast("Liste temizlendi");
        return;
      }
      if (action === "dismiss-note") {
        state.dayNote = null;
        save();
        renderTab();
        return;
      }
      if (action === "note-session") {
        var noteNow = state.dayNote;
        var noteWords = noteNow ? dayNoteWords(noteNow.prevDay) : [];
        if (!noteWords.length) { toast("Dün telaffuz kaydı yok."); return; }
        var weakWordsList = dayNoteWeak(noteWords);
        var pick = weakWordsList.length ? weakWordsList : noteWords;
        var queue = [];
        for (var qi = 0; qi < pick.length; qi++) {
          var found = wordByFi(pick[qi].fi);
          if (found) queue.push(found);
        }
        if (!queue.length) { toast("Bu kelimeler sözlükte bulunamadı."); return; }
        startSession("telaffuz", queue);
        return;
      }
      if (action === "packs-load") { loadPackIndex(); return; }
      if (action === "packs-all") { importAllPacks(); return; }
      if (action === "export") { exportData(); return; }
      if (action === "import") { importData(); return; }
      if (action === "reset") {
        if (!confirm("Tüm ilerleme ve seri silinsin mi? Bu işlem geri alınamaz.")) return;
        state = freshState();
        save();
        paintStreak();
        renderTab();
        toast("Sıfırlandı");
        return;
      }
    }

    var gradeBtn = t.closest("[data-grade]");
    if (gradeBtn && session) { answer(Number(gradeBtn.getAttribute("data-grade"))); return; }

    var optBtn = t.closest("[data-opt]");
    if (optBtn && session && session.mode === "test" && !session.locked) {
      var chosen = optBtn.getAttribute("data-opt");
      var card = session.queue[session.i];
      var correct = primary(session.dir === "fi-tr" ? card.tr : card.fi);
      session.locked = true;
      session.feedback = { chosen: chosen, correct: correct };
      var good = chosen === correct;
      if (good) session.ok += 1; else session.bad += 1;
      gradeCard(card, good ? 2 : 0);
      renderSession();
      return;
    }
  });

  app.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;

    /* Odaklanmış rekor/oturum satırı: Enter ya da boşluk oturumu başlatır. */
    var row = e.target && e.target.closest ? e.target.closest("[data-rec-goal]") : null;
    if (row) {
      var rowGoal = row.getAttribute("data-rec-goal");
      if (rowGoal) {
        if (e.preventDefault) e.preventDefault();
        goalSession(rowGoal);
        return;
      }
    }

    if (e.key !== "Enter") return;
    if (!session) return;
    if (session.mode === "yaz" && !session.locked) {
      var btn = app.querySelector('[data-action="check"]');
      if (btn) btn.click();
    } else if (session.locked) {
      nextCard();
    }
  });

  /* ------------------------------------------------------------------ */
  /* Gün değişimi izleme: uygulama açıkken gece yarısını geçince tazele   */
  /* ------------------------------------------------------------------ */

  var currentDay = dayKey();
  var dayTimer = null;

  /* Gün dönüşü notu: hedef kartında bir kez gösterilir. */
  function buildDayNote(prevDay, runBefore) {
    var goal = Math.max(1, Number(state.settings.pronGoal) || 5);
    var counts = dailyCounts();
    var prevWords = counts[prevDay] || 0;
    return {
      day: dayKey(),
      prevDay: prevDay,
      prevWords: prevWords,
      goal: goal,
      prevMet: prevWords >= goal,
      runBefore: (typeof runBefore === "number" ? runBefore : null),
      runAfter: pronRunDays(goal)
    };
  }

  /* Dünkü telaffuz denemeleri: kelime başına o günün son puanı. */
  function dayNoteWords(prevDay) {
    var log = state.pronLog || [];
    var map = {}, order = [];
    for (var i = 0; i < log.length; i++) {
      var e = log[i];
      if (dayKey(new Date(e.at)) !== prevDay) continue;
      if (!Object.prototype.hasOwnProperty.call(map, e.fi)) order.push(e.fi);
      map[e.fi] = e.score;
    }
    var out = [];
    for (var j = 0; j < order.length; j++) out.push({ fi: order[j], score: map[order[j]] });
    return out;
  }

  /* Eşiğin altında kalan (zayıf telaffuzlu) kelimeler. */
  function dayNoteWeak(words) {
    var out = [];
    for (var i = 0; i < words.length; i++) if (words[i].score < PRON_WEAK) out.push(words[i]);
    return out;
  }

  /* Gün notu şeridi: hem hedef kartında hem çalış ekranında kullanılır.
     Dünkü kelimeler çip olarak dokunulabilir; düğme zayıf olanlardan oturum açar. */
  function dayNoteHtml() {
    var note = state.dayNote;
    if (!note || note.day !== dayKey()) return "";
    var detail;
    if (note.prevMet) {
      detail = "Dün hedef tutuldu: " + note.prevWords + " farklı kelime · seri " + note.runAfter + " gün";
    } else {
      detail = "Dün hedef tutulmadı (" + note.prevWords + " / " + note.goal + ") · seri sıfırlandı";
    }

    var words = dayNoteWords(note.prevDay);
    var shown = words.slice(0, 8);
    var chips = "";
    for (var i = 0; i < shown.length; i++) {
      chips += '<button type="button" class="weak-chip note-chip" data-weak="' + esc(shown[i].fi) + '" title="Tek başına çalış">' +
        esc(shown[i].fi) + "<i>%" + shown[i].score + "</i></button>";
    }
    if (words.length > shown.length) chips += '<span class="muted small">+' + (words.length - shown.length) + " daha</span>";

    var weak = dayNoteWeak(words);
    var actionHtml = "";
    if (words.length) {
      actionHtml = '<button type="button" class="ghost-btn note-btn" data-action="note-session">' +
        (weak.length
          ? "Dünün zayıf kelimeleriyle çalış (" + weak.length + ")"
          : "Dünün kelimeleriyle çalış (" + words.length + ")") +
        "</button>";
    }

    /* Bugünün canlı durumu: notun içinde dünkü özetle birlikte durur. */
    var tGoal = Math.max(1, Number(state.settings.pronGoal) || 5);
    var tWords = todayDistinct();
    var tMet = tWords >= tGoal;

    /* Hedef tutulduğunda kısa özet: bugünkü kelime + seri + rekor. */
    var summaryHtml = "";
    if (tMet) {
      var runSt = pronGoalStreak();
      var bestRun = Math.max(pronBestFor(tGoal), runSt.current);
      var freshRecord = runSt.current > bestRunBeforeToday(tGoal);
      summaryHtml = '<div class="note-summary">bugün ' + tWords + " farklı kelime · seri " +
        runSt.current + " gün · rekor " + bestRun +
        (freshRecord ? '<b class="note-record" id="recordBadge">yeni rekor</b>' : "") +
        "</div>";
    }

    return '<div class="day-note" id="dayNote">' +
        '<div class="day-note-text"><b>Gün sıfırlandı</b><span>' + detail + "</span>" +
          '<div class="note-today">' +
            '<span class="score-pill ' + (tMet ? "good" : tWords ? "ok" : "bad") + '">' + tWords + " / " + tGoal + "</span>" +
            "<span>bugün farklı kelime</span>" +
            (tMet ? '<b class="note-met">hedef tutuldu ✓<span class="note-spark" aria-hidden="true">✨</span></b>' : "") +
          "</div>" +
          summaryHtml +
          (chips ? '<div class="note-chips">' + chips + "</div>" : "") +
          actionHtml +
        "</div>" +
        '<button type="button" class="icon-btn" data-action="dismiss-note" title="Kapat">✕</button>' +
      "</div>";
  }

  /* Uygulama kapalıyken gün atlandıysa notu açılışta üretir. */
  function maybeDayNote() {
    var today = dayKey();
    if (!state.lastSeen) { state.lastSeen = today; save(); return; }
    if (state.lastSeen === today) return;
    var prevDay = state.lastSeen;
    state.dayNote = buildDayNote(prevDay, null);
    state.lastSeen = today;
    save();
  }

  /* Hafif kontrol: sadece gün anahtarı değiştiğinde iş yapar.
     Yoklama yok — gece yarısına tek bir zamanlayıcı kurulur. */
  function checkDayRollover() {
    var today = dayKey();
    if (today === currentDay) return false;
    var prevDay = currentDay;
    var goal = Math.max(1, Number(state.settings.pronGoal) || 5);
    var runBefore = pronRunDays(goal);
    currentDay = today;
    refreshPronRun();
    state.dayNote = buildDayNote(prevDay, runBefore);
    noteCelebratePending = false;   // dünkü kutlama yeni günün notuna taşınmaz
    noteRecordPending = false;      // bekleyen rekor parlaması da taşınmaz
    state.lastSeen = today;
    save();
    paintStreak();
    /* Oturum sürerken ekranı bozmuyoruz; veri tazelenir, ekran oturum
       bitince (veya bir sonraki çizimde) güncel hâliyle gelir. */
    if (!session) {
      renderTab();
      toast("Yeni gün başladı — hedefler tazelendi.");
    }
    return true;
  }

  /* Bir sonraki yerel gece yarısına (00:00:01) tek zamanlayıcı kurar.
     DST/30 gün sınırı gibi durumlarda da doğru hesaplar (setTimeout üst sınırı ~24,8 gün). */
  function scheduleMidnight() {
    if (dayTimer) clearTimeout(dayTimer);
    var now = new Date();
    var next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
    var ms = Math.max(1000, next.getTime() - now.getTime());
    dayTimer = setTimeout(function () {
      checkDayRollover();
      scheduleMidnight();
    }, ms);
  }

  function startDayWatch() {
    scheduleMidnight();
    /* Cihaz uykuya daldıysa ya da saat değiştiyse zamanlayıcı kaymış olabilir:
       sekmeye dönüşte kontrol edip yeniden zamanlıyoruz. */
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) { checkDayRollover(); scheduleMidnight(); }
    });
    window.addEventListener("focus", function () {
      checkDayRollover();
      scheduleMidnight();
    });
  }

  paintStreak();
  refreshPronRun();
  maybeDayNote();
  /* Açılış sırasının sonunda: kategori eşleme tablosu (CAT_ALIAS) bu noktada hazır. */
  hydrateCustom();   // paketlerden eklenmiş kelimeler sözlüğe katılır
  renderTab();
  startDayWatch();
})();
