// ==UserScript==
// @name         Image Magnifier
// @namespace    https://github.com/diple-df/Image-Magnifier
// @version      3.13.0
// @description  Двойной Ctrl по изображению открывает его в плавающем окне: зум 5–2000% с привязкой к курсору, панорамирование, инструменты рисования (карандаш, линия, стрелка, прямоугольник, эллипс, текст), палитра изображения, перспективная коррекция, чтение текста и QR, экспорт PNG/JPEG/WebP, отмена/повтор, полностью клавиатурный режим, копирование (Ctrl+C) и сохранение (Ctrl+S)
// @author       diple_df x claude
// @match        *://*/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @connect      github.com
// @downloadURL  https://raw.githubusercontent.com/diple-df/Image-Magnifier/main/imgMagnifier.user.js
// @updateURL    https://raw.githubusercontent.com/diple-df/Image-Magnifier/main/imgMagnifier.user.js
// @noframes     false
// ==/UserScript==

(function () {
    'use strict';

    // --- Константы --------------------------------------------------------
    const DOUBLE_PRESS_MS = 500;   // макс. интервал между двумя нажатиями Ctrl
    const TOAST_MS = 2500;
    const ZOOM_STEP = 1.15;        // шаг кнопок +/−
    const ZOOM_MIN = 0.05;
    const ZOOM_MAX = 20;           // 2000%
    const WIN_W = 640;             // стартовый размер окна
    const WIN_H = 520;
    const MAX_ANNOTATIONS = 500;   // защита от неограниченного роста памяти
    const MAX_POINTS = 12000;      // точек в одной линии карандаша
    const PEN_MIN_DIST = 1.2;      // мин. шаг между точками карандаша (экранные px)
    const HISTORY_LIMIT = 80;      // кадров undo/redo
    const DPR_MAX = 3;             // потолок devicePixelRatio для холста
    const WIN_ID = 'img-mag-window';
    const MIN_TARGET_PX = 24;      // меньше — иконка, пиксель трекинга, спейсер
    const MAX_CONTAINER_RATIO = 0.45; // доля вьюпорта, выше которой это «страница»

    const PALETTE_SAMPLE = 64;     // сторона уменьшенной копии для палитры
    const PALETTE_MAX = 8;         // максимум плашек палитры
    const PALETTE_MIN_DIST = 26;   // мин. расстояние между цветами палитры (RGB)
    const QUICK_PINS = 5;          // закреплённые быстрые цвета
    const QUICK_RECENT = 4;        // последние использованные цвета
    const PIXEL_GRID_FROM = 8;     // сетка пикселей с 800%
    const WARP_MAX_SIDE = 4000;    // предел стороны выпрямленной картинки
    const WARP_MAX_PIXELS = 12 * 1000 * 1000; // предел площади выборки
    const SCAN_MAX_SIDE = 1600;    // предел выборки для OCR/QR
    const OCR_SCALE = 4;           // увеличение фолбэка «скопировать картинку»
    const CACHE_MAX_ENTRIES = 3;   // «тёплые» состояния зум/панорама
    const CACHE_MAX_BYTES = 24 * 1024 * 1024; // предел памяти кэша
const PYRAMID_MAX_LEVELS = 3;  // уровней уменьшения не больше трёх
const PYRAMID_MAX_PIXELS = 12 * 1000 * 1000; // суммарный бюджет пирамиды
const PYRAMID_MAX_SOURCE = 40 * 1000 * 1000; // крупнее — пирамиду не строим
const HUGE_PIXELS = 20 * 1000 * 1000; // выше — готовим уменьшенную копию в фоне
const HUGE_MAX_SIDE = 4096;           // длинная сторона этой копии
const HUGE_BAND_PIXELS = 1.2 * 1000 * 1000; // пикселей исходника в одной полосе
    const HIT_TOLERANCE = 6;       // допуск хит-теста аннотаций (экранные px)

    // --- Безопасное хранилище (localStorage может бросать) ----------------
    const memStore = Object.create(null);
    let lsOk = true;
    try {
        localStorage.setItem('__img_mag_probe__', '1');
        localStorage.removeItem('__img_mag_probe__');
    } catch (e) {
        lsOk = false;
    }

    function storeGet(key) {
        if (lsOk) {
            try { return localStorage.getItem(key); } catch (e) { lsOk = false; }
        }
        return key in memStore ? memStore[key] : null;
    }

    function storeSet(key, value) {
        const s = String(value);
        memStore[key] = s;
        if (!lsOk) return;
        try { localStorage.setItem(key, s); } catch (e) { lsOk = false; }
    }

    function storeNum(key, def) {
        const raw = storeGet(key);
        if (raw == null || raw === '') return def;
        const n = parseFloat(raw);
        return isFinite(n) ? n : def;
    }

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    // --- Автообновление ----------------------------------------------------
    // Пассивный слой — @updateURL/@downloadURL в шапке: менеджер сам сверяет
    // версию. Здесь активный: ежедневная фоновая проверка после загрузки
    // страницы и пункт меню «Проверить обновления». Скрипт висит на *://*/*,
    // поэтому проверка почти бесплатна: на старте читается один timestamp,
    // сеть трогается не чаще раза в сутки.
    const UPDATE = (function () {
        const RAW = 'https://raw.githubusercontent.com/diple-df/Image-Magnifier/main/imgMagnifier.user.js';
        const PAGE = 'https://github.com/diple-df/Image-Magnifier';
        const STAMP_KEY = 'img_mag_upd_ts';
        const SEEN_KEY = 'img_mag_upd_seen';
        const DAY = 86400000;
        const LOCAL_VERSION = '3.13.0';

        function curVer() {
            try {
                if (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) {
                    return String(GM_info.script.version);
                }
            } catch (e) { /* ignore */ }
            return LOCAL_VERSION;
        }

        // Сравнение по числовым сегментам: 3.13.0 больше 3.9.0 (строкой — нет).
        function cmp(a, b) {
            const pa = String(a || '').split(/[.\-+]/);
            const pb = String(b || '').split(/[.\-+]/);
            const n = Math.max(pa.length, pb.length);
            for (let i = 0; i < n; i++) {
                const x = parseInt(pa[i], 10) || 0;
                const y = parseInt(pb[i], 10) || 0;
                if (x !== y) return x > y ? 1 : -1;
            }
            return 0;
        }

        function gmGet(key, def) {
            try {
                if (typeof GM_getValue === 'function') return GM_getValue(key, def);
            } catch (e) { /* ignore */ }
            return storeGet(key) === null ? def : storeGet(key);
        }

        function gmSet(key, val) {
            try {
                if (typeof GM_setValue === 'function') { GM_setValue(key, val); return; }
            } catch (e) { /* ignore */ }
            try { storeSet(key, val); } catch (e2) { /* ignore */ }
        }

        function fetchText(url, cb) {
            let done = false;
            const finish = (txt) => {
                if (done) return;
                done = true;
                try { cb(txt || null); } catch (e) { /* тихий сбой */ }
            };
            try {
                if (typeof GM_xmlhttpRequest === 'function') {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: url,
                        timeout: 15000,
                        onload: (r) => finish(r && r.status === 200 ? r.responseText : null),
                        onerror: () => finish(null),
                        ontimeout: () => finish(null),
                        onabort: () => finish(null),
                    });
                    return;
                }
            } catch (e) { /* падаем в fetch */ }
            try {
                fetch(url, { cache: 'no-store' })
                    .then((r) => (r && r.ok ? r.text() : null))
                    .then(finish)
                    .catch(() => finish(null));
            } catch (e) { finish(null); }
        }

        // Общий тост-баннер в стиле окна лупы. Только DOM API, без innerHTML.
        function notice(children, autoHideMs) {
            const box = document.createElement('div');
            box.id = 'img-mag-update-note';
            box.setAttribute('role', 'status');
            Object.assign(box.style, {
                position: 'fixed', zIndex: '2147483647', right: '16px', bottom: '16px',
                maxWidth: '340px', padding: '11px 13px', borderRadius: '10px',
                background: '#1e1e1e', color: '#f2f3f6',
                border: '1px solid rgba(255,255,255,0.14)',
                boxShadow: '0 12px 32px -8px rgba(0,0,0,0.65)',
                font: '13px/1.45 sans-serif', display: 'flex', gap: '10px',
                alignItems: 'flex-start', boxSizing: 'border-box',
            });

            const txt = document.createElement('div');
            txt.style.flex = '1 1 auto';
            for (let i = 0; i < children.length; i++) txt.appendChild(children[i]);

            const close = document.createElement('button');
            close.type = 'button';
            close.textContent = '✕';
            close.setAttribute('aria-label', 'Закрыть уведомление');
            Object.assign(close.style, {
                appearance: 'none', border: '0', background: 'none', color: '#8b90a0',
                font: 'inherit', cursor: 'pointer', padding: '0 0 0 4px', lineHeight: '1',
            });
            close.addEventListener('click', () => { try { box.remove(); } catch (e) { /* ignore */ } });

            box.append(txt, close);
            rootEl().appendChild(box);
            if (autoHideMs) {
                setTimeout(() => { try { box.remove(); } catch (e) { /* ignore */ } }, autoHideMs);
            }
            return box;
        }

        function textNode(text) {
            const d = document.createElement('span');
            d.textContent = text;
            return d;
        }

        function banner(version) {
            if (document.getElementById('img-mag-update-note')) return;
            const link = document.createElement('a');
            link.href = RAW;
            link.textContent = 'Обновить';
            link.rel = 'noopener noreferrer';
            Object.assign(link.style, {
                color: '#6cb6ff', textDecoration: 'underline', cursor: 'pointer',
            });
            notice([
                textNode('Image Magnifier ' + version + ' доступна. '),
                link,
            ], 0);
            gmSet(SEEN_KEY, version);
        }

        function msg(text) {
            if (document.getElementById('img-mag-update-note')) {
                const old = document.getElementById('img-mag-update-note');
                try { old.remove(); } catch (e) { /* ignore */ }
            }
            notice([textNode(text)], 3600);
        }

        function check(opts) {
            const manual = !!(opts && opts.manual);
            // Пока открыто окно лупы, фоновую проверку не запускаем: она не
            // должна мешать работе и не должна закрывать окно.
            if (!manual && document.getElementById(WIN_ID)) return;
            gmSet(STAMP_KEY, Date.now());
            fetchText(RAW, (txt) => {
                if (!txt) {
                    if (manual) msg('Не удалось проверить обновления');
                    return;
                }
                const m = txt.match(/^\/\/\s*@version\s+(.+)$/m);
                const remote = m ? String(m[1]).trim() : '';
                if (!remote) {
                    if (manual) msg('Не удалось прочитать версию обновления');
                    return;
                }
                const local = curVer();
                if (cmp(remote, local) > 0) {
                    const seen = gmGet(SEEN_KEY, null);
                    // фоном — один раз на версию; вручную — всегда показываем
                    if (manual || seen !== remote) banner(remote);
                } else if (manual) {
                    msg('Установлена последняя версия ' + local);
                }
            });
        }

        function maybeAuto() {
            try {
                const last = Number(gmGet(STAMP_KEY, 0)) || 0;
                if (Date.now() - last < DAY) return;
            } catch (e) { return; }
            const run = () => { try { check({ manual: false }); } catch (e) { /* ignore */ } };
            try {
                if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 5000 });
                else setTimeout(run, 2500);
            } catch (e) {
                setTimeout(run, 2500);
            }
        }

        return { check: check, maybeAuto: maybeAuto, cmp: cmp, curVer: curVer, PAGE: PAGE };
    })();

    if (typeof GM_registerMenuCommand === 'function') {
        try {
            GM_registerMenuCommand('Image Magnifier: Проверить обновления', function () {
                UPDATE.check({ manual: true });
            });
        } catch (e) { /* ignore */ }
    }

    try {
        if (document.readyState === 'complete') UPDATE.maybeAuto();
        else window.addEventListener('load', UPDATE.maybeAuto, { once: true, passive: true });
    } catch (e) { /* ignore */ }

    // --- Отслеживание позиции курсора ------------------------------------
    let mx = 0, my = 0;
    document.addEventListener('mousemove', (e) => {
        mx = e.clientX;
        my = e.clientY;
    }, { capture: true, passive: true });

    // --- Детект двойного нажатия Ctrl ------------------------------------
    let lastCtrl = 0;

    function isTypingTarget(el) {
        if (!el || !el.tagName) return false;
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
            const type = (el.type || '').toLowerCase();
            if (type === 'password' || type === 'search' || type === 'text' ||
                type === 'email' || type === 'url' || type === 'number') {
                return true;
            }
            return !el.disabled && !el.readOnly;
        }
        if (tag === 'SELECT') return !el.disabled;
        if (el.isContentEditable) return true;
        if (el.closest && el.closest('[contenteditable="true"], [contenteditable=""]')) return true;
        return false;
    }

    function inWindow(node) {
        return !!(win && node && (win === node || win.contains(node)));
    }

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Control' && e.code !== 'ControlLeft' && e.code !== 'ControlRight') return;
        if (e.repeat) return;
        if (e.altKey || e.shiftKey || e.metaKey) return;
        if (isTypingTarget(e.target)) return;

        const now = performance.now();
        if (now - lastCtrl <= DOUBLE_PRESS_MS) {
            lastCtrl = 0;
            handleTrigger();
        } else {
            lastCtrl = now;
        }
    }, true);

    function handleTrigger() {
        if (win) { closeWindow(); return; } // повторный двойной Ctrl закрывает окно

        const data = resolveImageAt(mx, my);
        if (!data) {
            toast('Под курсором нет изображения');
            return;
        }
        openWindow(data.url, data.caption);
    }

    // --- Поиск картинки под курсором -------------------------------------
    // Идём по всему стеку элементов под точкой, пронзая shadow DOM
    // (YouTube и др. на веб-компонентах): картинка часто перекрыта оверлеем
    // или спрятана внутри shadow-root.
    function resolveImageAt(x, y) {
        const seen = new Set();
        let result = null;

        const dig = (root) => {
            const stack = root.elementsFromPoint
                ? root.elementsFromPoint(x, y)
                : (root.elementFromPoint ? [root.elementFromPoint(x, y)] : []);
            for (let i = 0; i < stack.length; i++) {
                const el = stack[i];
                if (!el || seen.has(el)) continue;
                seen.add(el);
                if (el.id === WIN_ID) continue;            // своё окно не анализируем
                const data = resolveImage(el);
                if (data && data.url) { result = data; return true; }
                if (el.shadowRoot && dig(el.shadowRoot)) return true;
            }
            return false;
        };

        try { dig(document); } catch (e) { /* ignore */ }
        return result;
    }

    function resolveImage(el) {
        if (!el || !el.tagName) return null;

        if (el.tagName === 'IMG') {
            // Трекинг-пиксели 1×1 и иконки — не то, что пользователь
            // хочет увеличить, даже если курсор случайно на них попал.
            if (!isImageLike(el)) return null;
            const u = bestFromImg(el);
            return u ? { url: u, caption: el.alt || el.title || '' } : null;
        }

        if (el.tagName === 'CANVAS') {
            const u = urlFromCanvas(el);
            if (u) return { url: u, caption: el.getAttribute('aria-label') || el.title || '' };
        }

        // Контейнер отдаём как картинку, только если он и есть картинка.
        // Без этой проверки elementsFromPoint всегда доходит до BODY, и
        // двойной Ctrl по пустому месту открывал первую картинку страницы.
        if (!isImageLike(el)) return null;

        const innerImg = el.querySelector && el.querySelector('img');
        if (innerImg && isImageLike(innerImg)) {
            // Внутренняя картинка должна занимать почти весь контейнер.
            // Иначе это карточка/строка, где изображение — лишь часть,
            // и клик по пустому месту не должен её открывать.
            let covered = false;
            try {
                const cr = el.getBoundingClientRect();
                const ir = innerImg.getBoundingClientRect();
                covered = ir.width >= cr.width * 0.8 && ir.height >= cr.height * 0.8;
            } catch (e) { covered = false; }
            if (covered) {
                const u = bestFromImg(innerImg);
                if (u) return { url: u, caption: innerImg.alt || innerImg.title || '' };
            }
        }

        const bg = bgImageUrl(el);
        if (bg) return { url: bg, caption: el.getAttribute('aria-label') || el.title || '' };

        return null;
    }

    // Может ли этот элемент считаться «картинкой под курсором».
    // Отсекает то, что даёт ложные срабатывания: прозрачные трекинг-пиксели,
    // иконки в 12 px, невидимые изображения и контейнеры размером во всю
    // страницу (у них querySelector('img') находит всё, что угодно).
    function isImageLike(el) {
        if (!el || !el.getBoundingClientRect) return false;

        const tag = el.tagName;
        const isMedia = tag === 'IMG' || tag === 'CANVAS' || tag === 'PICTURE' ||
            tag === 'SVG' || tag === 'VIDEO';
        const isAncestor = tag === 'A' || tag === 'FIGURE' || tag === 'PICTURE' ||
            tag === 'DIV' || tag === 'SPAN' || tag === 'LI' || tag === 'P';

        let rect;
        try { rect = el.getBoundingClientRect(); } catch (e) { return false; }
        if (!rect || rect.width < MIN_TARGET_PX || rect.height < MIN_TARGET_PX) return false;

        // Контейнер во весь экран — это страница, а не картинка. Саму медиа
        // не проверяем: большое фото вполне может занимать весь вьюпорт.
        if (!isMedia) {
            const vw = innerWidth || 1, vh = innerHeight || 1;
            if (rect.width > vw * MAX_CONTAINER_RATIO && rect.height > vh * MAX_CONTAINER_RATIO) {
                return false;
            }
        }

        let cs;
        try { cs = getComputedStyle(el); } catch (e) { return isMedia; }
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        if (parseFloat(cs.opacity) === 0) return false;

        if (isMedia) return true;
        if (!isAncestor) return false;

        // Для обёрток: внутри должно быть ровно одно изображение и должен
        // быть картинкой сам элемент — своё фоновое изображение или
        // единственный потомок-медиа. Иначе это карточка со списком.
        if (bgImageUrl(el)) return true;
        if (!el.querySelectorAll) return false;
        const imgs = el.querySelectorAll('img, canvas, svg, video');
        return imgs.length === 1;
    }

    function urlFromCanvas(c) {
        try {
            if (!c.width || !c.height) return null;
            const d = c.toDataURL('image/png');
            // пустой/битый холст даёт очень короткую строку
            return d && d.length > 64 ? d : null;
        } catch (e) {
            return null; // tainted canvas
        }
    }

    // Разбираем srcset по дескрипторам, не разрезая URL по запятым
    // (иначе ломаются data: URL). Берём самый крупный кандидат.
    function collectSrcset(set, out) {
        if (!set) return;
        const re = /(\S+)\s+([\d.]+)(w|x)(?=\s|,|$)/g;
        let m;
        while ((m = re.exec(set)) !== null) {
            const url = m[1].replace(/,$/, '');
            const n = parseFloat(m[2]);
            if (!url || !isFinite(n) || n <= 0) continue;
            out.push({ url: url, kind: m[3], n: n });
        }
    }

    function bestFromImg(img) {
        const cands = [];
        const parent = img.parentElement;
        if (parent && parent.tagName === 'PICTURE') {
            const sources = parent.querySelectorAll('source');
            for (let i = 0; i < sources.length; i++) {
                collectSrcset(sources[i].getAttribute('srcset'), cands);
            }
        }
        collectSrcset(img.getAttribute('srcset'), cands);

        let best = null, bestW = 0, bestX = 0;
        for (let i = 0; i < cands.length; i++) {
            if (cands[i].kind === 'w' && cands[i].n > bestW) { bestW = cands[i].n; best = cands[i].url; }
        }
        if (!best) {
            for (let i = 0; i < cands.length; i++) {
                if (cands[i].kind === 'x' && cands[i].n > bestX) { bestX = cands[i].n; best = cands[i].url; }
            }
        }
        if (best) return absolutize(best);
        if (img.currentSrc) return absolutize(img.currentSrc);

        const src = img.getAttribute('src');
        if (src) return absolutize(src);
        return null;
    }

    // background-image может содержать image-set(...) со списком url();
    // берём последний — обычно это наибольшая плотность.
    function bgImageUrl(el) {
        let bg;
        try { bg = getComputedStyle(el).backgroundImage; } catch (e) { return null; }
        if (!bg || bg === 'none') return null;
        const re = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
        let m, last = null;
        while ((m = re.exec(bg)) !== null) {
            if (m[2]) last = m[2];
        }
        return last ? absolutize(last) : null;
    }

    function absolutize(u) {
        try { return new URL(u, location.href).href; } catch (e) { return u; }
    }

    // --- SVG-иконки (только DOM, без innerHTML: Trusted Types CSP) -------
    const SVGNS = 'http://www.w3.org/2000/svg';
    const ICONS = {
        move:    [['path', { d: 'M12 3v18M3 12h18' }], ['path', { d: 'M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5' }]],
        pen:     [['path', { d: 'M5 19l1-4L16 5l3 3L9 18l-4 1z' }], ['path', { d: 'M14 7l3 3' }]],
        text:    [['path', { d: 'M5 6h14' }], ['path', { d: 'M12 6v13' }], ['path', { d: 'M9.5 19h5' }]],
        arrow:   [['path', { d: 'M5 19L18 6' }], ['path', { d: 'M9 6h9v9' }]],
        line:    [['path', { d: 'M5 19L19 5' }]],
        rect:    [['rect', { x: 4, y: 5, width: 16, height: 14, rx: 2 }]],
        circle:  [['circle', { cx: 12, cy: 12, r: 7 }]],
        fillOn:  [['rect', { x: 4, y: 5, width: 16, height: 14, rx: 2 }], ['rect', { x: 7, y: 8, width: 10, height: 8, fill: 'currentColor', stroke: 'none' }]],
        fillOff: [['rect', { x: 4, y: 5, width: 16, height: 14, rx: 2 }], ['path', { d: 'M7 16l5-6 5 6z' }]],
        undo:    [['path', { d: 'M9 7L4 12l5 5' }], ['path', { d: 'M4 12h11a5 5 0 0 1 5 5v1' }]],
        redo:    [['path', { d: 'M15 7l5 5-5 5' }], ['path', { d: 'M20 12H9a5 5 0 0 0-5 5v1' }]],
        trash:   [['path', { d: 'M4 7h16' }], ['path', { d: 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2' }], ['path', { d: 'M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13' }], ['path', { d: 'M10 11v6M14 11v6' }]],
        zoomOut: [['circle', { cx: 11, cy: 11, r: 6 }], ['path', { d: 'M20 20l-3.6-3.6' }], ['path', { d: 'M8.5 11h5' }]],
        zoomIn:  [['circle', { cx: 11, cy: 11, r: 6 }], ['path', { d: 'M20 20l-3.6-3.6' }], ['path', { d: 'M11 8.5v5M8.5 11h5' }]],
        fit:     [['path', { d: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5' }]],
        copy:    [['rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }], ['path', { d: 'M5 15V5a1 1 0 0 1 1-1h9' }]],
        save:    [['path', { d: 'M12 4v10' }], ['path', { d: 'M7 10l5 5 5-5' }], ['path', { d: 'M4 20h16' }]],
        help:    [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M9.6 9.2a2.5 2.5 0 1 1 3.7 2.2c-.8.5-1.3 1.1-1.3 2v.3' }], ['path', { d: 'M12 17.4v.2' }]],
        close:   [['path', { d: 'M6 6l12 12M18 6L6 18' }]],

        // 3.9.0
        palette: [['circle', { cx: 8.5, cy: 12, r: 2 }], ['circle', { cx: 12, cy: 7.5, r: 2 }], ['circle', { cx: 15.5, cy: 12, r: 2 }], ['path', { d: 'M12 3.2a8.8 8.8 0 1 0 0 17.6 3 3 0 0 0 2.2-5 2 2 0 0 1 1.5-3.3h1.7A3.4 3.4 0 0 0 21 9.1 8.8 8.8 0 0 0 12 3.2z' }]],
        warp:    [['path', { d: 'M4 7l5-3 7 3 4-2' }], ['path', { d: 'M4 7v10l5 3 7-3 4 2V9' }], ['path', { d: 'M9 4v10' }], ['path', { d: 'M16 7v10' }]],
        scan:    [['path', { d: 'M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8' }], ['path', { d: 'M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8' }], ['path', { d: 'M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16' }], ['path', { d: 'M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16' }], ['path', { d: 'M7.5 12h9' }]],
        qr:      [['rect', { x: 4, y: 4, width: 6, height: 6, rx: 1 }], ['rect', { x: 14, y: 4, width: 6, height: 6, rx: 1 }], ['rect', { x: 4, y: 14, width: 6, height: 6, rx: 1 }], ['path', { d: 'M14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z' }]],
        pin:     [['path', { d: 'M9 4h6l-1 5 3 3H7l3-3z' }], ['path', { d: 'M12 12v8' }]],
        eraser:  [['path', { d: 'M8.5 20.5H20' }], ['path', { d: 'M4.6 15.9l7.1-7.1a2 2 0 0 1 2.8 0l3.5 3.5a2 2 0 0 1 0 2.8l-4.7 4.7H8.1l-3.5-3.5a2 2 0 0 1 0-2.8z' }], ['path', { d: 'M9.5 11l5.5 5.5' }]],
        export:  [['path', { d: 'M12 15V4' }], ['path', { d: 'M8 8l4-4 4 4' }], ['path', { d: 'M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3' }]],
        grid:    [['rect', { x: 4, y: 4, width: 16, height: 16, rx: 1 }], ['path', { d: 'M12 4v16M4 12h16' }], ['path', { d: 'M8 4v16M16 4v16M4 8h16M4 16h16', opacity: 0.55 }]],
        more:    [['circle', { cx: 6, cy: 12, r: 1.4 }], ['circle', { cx: 12, cy: 12, r: 1.4 }], ['circle', { cx: 18, cy: 12, r: 1.4 }]],
        chevron: [['path', { d: 'M6 9.5l6 6 6-6' }]],
        grip:    [['circle', { cx: 9, cy: 8, r: 1.1 }], ['circle', { cx: 15, cy: 8, r: 1.1 }], ['circle', { cx: 9, cy: 12, r: 1.1 }], ['circle', { cx: 15, cy: 12, r: 1.1 }], ['circle', { cx: 9, cy: 16, r: 1.1 }], ['circle', { cx: 15, cy: 16, r: 1.1 }]],
        sliders: [['path', { d: 'M5 8h5M14 8h5M5 16h9M18 16h1' }], ['circle', { cx: 12, cy: 8, r: 2 }], ['circle', { cx: 16, cy: 16, r: 2 }]]
    };

    function makeIcon(spec) {
        const s = document.createElementNS(SVGNS, 'svg');
        s.setAttribute('width', '18');
        s.setAttribute('height', '18');
        s.setAttribute('viewBox', '0 0 24 24');
        s.setAttribute('fill', 'none');
        s.setAttribute('stroke', 'currentColor');
        s.setAttribute('stroke-width', '1.9');
        s.setAttribute('stroke-linecap', 'round');
        s.setAttribute('stroke-linejoin', 'round');
        s.style.display = 'block';
        s.style.pointerEvents = 'none';
        for (let i = 0; i < spec.length; i++) {
            const tag = spec[i][0];
            const attrs = spec[i][1];
            const node = document.createElementNS(SVGNS, tag);
            for (const k in attrs) node.setAttribute(k, String(attrs[k]));
            s.appendChild(node);
        }
        return s;
    }

    // --- Состояние --------------------------------------------------------
    let win = null;          // контейнер окна
    let barEl = null;        // заголовок (перетаскивание)
    let viewEl = null;       // вьюпорт
    let imgEl = null;        // скрытый <img> — источник пикселей
    let drawEl = null;       // видимый холст: картинка + аннотации
    let baseCanvas = null;   // кэш "картинка + подтверждённые аннотации"
    let baseCtx = null;
    let statusEl = null;     // "Загрузка…" / ошибка
    let helpEl = null;
    let textInput = null;
    let zoomLabel = null;
    let undoBtn = null, redoBtn = null, fillBtn = null;
    let pinBtn = null, moreBtn = null;
    let toolButtons = {};
    let imageUrl = '';

    // Новый интерфейс: рейка категорий, панель свойств, строка состояния.
    let railEl = null;        // левая рейка с категориями
    let propsEl = null;       // правая панель свойств
    let statusBarEl = null;   // строка состояния под картинкой
    let propsFolded = true;   // панель свойств свёрнута: картинка важнее интерфейса
    let propsPinned = false;
    // Пользователь свернул панель вручную. Пока курсор не уйдёт из правой
    // зоны, наведение не должно её снова раскрывать — иначе кажется,
    // что кнопка «Свернуть» не работает.
    let propsLock = false;  // закреплена навсегда (не прячется на уходе курсора)
    let propsHover = false;   // курсор сейчас в зоне раскрытия справа

    let scale = 1, tx = 0, ty = 0;
    let currentTool = 'move';
    let penColor = '#ff3b30';
    let penWidth = 4;
    let fillShapes = false;

    let annotations = [];
    let history = [[]];
    let histIndex = 0;
    let inProgress = null;
    let drawing = false;
    let mode = null;        // 'pan' | 'drag' | null
    let startX = 0, startY = 0, startA = 0, startB = 0;

    let dpr = 1, viewW = 0, viewH = 0;
    let baseValid = false;
    let rafId = 0;
    let viewRect = null;    // кэш getBoundingClientRect на время жеста
    let spaceDown = false;
    let overWin = false;
    let winRO = null;
    let persistTimer = 0;
    let canExport = null;   // true/false после проверки taint
    let corsImage = null;
    let corsTried = false;

    // --- Состояние новых возможностей (3.9.0) ------------------------------
    let perspCanvas = null;      // выпрямленная копия картинки (1.5)
    let perspCorners = [];       // выбранные углы в координатах картинки
    let perspPicking = false;    // идёт выбор четырёх углов
    let perspBusy = false;
    let scanRect = null;         // выделение области для распознавания
    let scanPick = false;        // ждём выделения области
    let selShape = null;         // выбранная аннотация (4.2)
    let dragShape = null;        // { shape, ox, oy, moved }
    let lastShape = null;        // последняя добавленная фигура
    let imagePalette = [];       // доминирующие цвета (1.4)
    let quickRecent = [];        // последние использованные цвета (4.3)
    let quickPins = [];          // закреплённые быстрые цвета (4.3)
    // (нативный <input type=color> убран: цвет выбирается HSV-кругом)     // <input type=color>
    let pinned = false;          // окно не закрывается от клика мимо (5.3)
    let ghostMode = false;       // «только смотреть»: клики сквозь картинку
    let translucent = false;     // полупрозрачное окно
    let exportFormat = 'png';    // 'png' | 'jpeg' | 'webp' (3.5)
    let exportQuality = 0.92;
    let pixelGrid = false;       // сетка пикселей при ≥800% (9.3)
    let pyramid = null;          // уровни 1/2, 1/4, 1/8 (6.1)
    let pyramidLevel = 0;
    let baseRev = 0;             // растёт при смене аннотаций/источника
    const baseCache = [];        // LRU «тёплых» состояний (6.2)
    let mqDpr = null;            // matchMedia для смены монитора (6.3)
    let dprPoll = 0;             // страховочный опрос DPR
    let menuEl = null;           // открытое всплывающее меню
    let menuAnchorBtn = null;
    let liveEl = null;           // aria-live для тостов (4.1)
    let focusables = [];         // элементы окна для Tab-ловушки

    const s2i = (x, y) => ({ x: (x - tx) / scale, y: (y - ty) / scale }); // экран → картинка

    function sourceEl() { return perspCanvas || hugeSource || imgEl; }

    // Источник для пиксельных операций (текст, палитра, пипетка, экспорт).
    // Если исходный <img> «отравил» canvas, подставляем копию, скачанную
    // в обход CORS через GM_xmlhttpRequest — у неё пиксельный доступ есть.
    function pixelSource() {
        if (perspCanvas) return perspCanvas;
        if (corsImage) return corsImage;
        return imgEl;
    }

    function imageW() {
        if (perspCanvas) return perspCanvas.width;
        return (imgEl && (imgEl.naturalWidth || imgEl.width)) || 0;
    }
    function imageH() {
        if (perspCanvas) return perspCanvas.height;
        return (imgEl && (imgEl.naturalHeight || imgEl.height)) || 0;
    }

    // --- Мелкие помощники ---------------------------------------------------
    function mk(tag, styles, children) {
        const el = document.createElement(tag);
        if (styles) Object.assign(el.style, styles);
        if (children) {
            for (let i = 0; i < children.length; i++) {
                if (children[i]) el.appendChild(children[i]);
            }
        }
        return el;
    }

    function hexToRgb(hex) {
        const m = /^#?([a-f0-9]{3}|[a-f0-9]{6})$/i.exec(String(hex || '').trim());
        if (!m) return null;
        let h = m[1];
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        return {
            r: parseInt(h.slice(0, 2), 16),
            g: parseInt(h.slice(2, 4), 16),
            b: parseInt(h.slice(4, 6), 16),
        };
    }

    function rgbToHex(r, g, b) {
        const p = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
        return '#' + p(r) + p(g) + p(b);
    }

    function rgbDist(a, b) {
        const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
        return Math.sqrt(dr * dr + dg * dg + db * db);
    }

    // Копирование текста: clipboard API, иначе скрытый textarea.
    function copyText(text, okMsg) {
        const done = () => announce(okMsg || 'Скопировано');
        const fallback = () => {
            let ok = false;
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.setAttribute('readonly', '');
                Object.assign(ta.style, {
                    position: 'fixed', left: '-9999px', top: '0', opacity: '0',
                });
                rootEl().appendChild(ta);
                ta.select();
                ok = document.execCommand('copy');
                ta.remove();
            } catch (e) { ok = false; }
            if (ok) done();
            else toast('Не удалось скопировать в буфер');
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done).catch(fallback);
        } else {
            fallback();
        }
    }

    // Озвучивание для экранного диктора и видимая плашка (4.1)
    function announce(msg) {
        toast(msg);
        if (!liveEl) {
            liveEl = mk('div', {
                position: 'absolute', width: '1px', height: '1px', overflow: 'hidden',
                clipPath: 'inset(50%)', whiteSpace: 'nowrap', opacity: '0',
            });
            liveEl.setAttribute('role', 'status');
            liveEl.setAttribute('aria-live', 'polite');
            liveEl.setAttribute('aria-atomic', 'true');
        }
        if (win && !liveEl.isConnected) win.appendChild(liveEl);
        liveEl.textContent = '';
        // повторная запись в тот же узел иногда не читается диктором
        setTimeout(() => { if (liveEl) liveEl.textContent = msg; }, 60);
    }

    function rootEl() { return document.body || document.documentElement; }

    // --- Кнопки -----------------------------------------------------------
    function decorateButton(b) {
        // У кнопок с классом .imv-btn оформление живёт в <style>, поэтому
        // инлайновые наведения им не нужны и только перебили бы CSS.
        if (b.classList && b.classList.contains('imv-btn')) {
            b.addEventListener('mousedown', (e) => e.stopPropagation());
            return b;
        }
        b.addEventListener('mouseenter', () => {
            if (b.dataset.active !== '1' && b.dataset.disabled !== '1') {
                b.style.background = 'rgba(255,255,255,0.15)';
            }
        });
        b.addEventListener('mouseleave', () => setBtnActive(b, b.dataset.active === '1'));
        b.addEventListener('mousedown', (e) => e.stopPropagation()); // не таскать окно
        b.addEventListener('focus', () => {
            b.style.outline = '2px solid #4da3ff';
            b.style.outlineOffset = '1px';
        });
        b.addEventListener('blur', () => { b.style.outline = 'none'; });
        return b;
    }

    function setBtnActive(b, on) {
        if (!b) return;
        b.dataset.active = on ? '1' : '';
        // Кнопки рейки и шапки одеваются классами из <style>, остальным
        // (кнопки старых поповеров) по-прежнему нужен инлайновый фон.
        if (b.classList && b.classList.contains('imv-btn')) {
            b.classList.toggle('is-on', !!on);
            if (on) b.setAttribute('aria-pressed', 'true');
            else if (b.hasAttribute('data-tool')) b.setAttribute('aria-pressed', 'false');
            return;
        }
        b.style.background = on ? 'rgba(0,120,212,0.95)' : 'transparent';
    }

    function iconButton(icon, tip, onClick) {
        const b = document.createElement('button');
        b.type = 'button';
        b.title = tip;
        b.setAttribute('aria-label', tip);
        b.appendChild(makeIcon(ICONS[icon]));
        Object.assign(b.style, {
            background: 'transparent', color: '#fff', border: 'none', cursor: 'pointer',
            width: '30px', height: '26px', padding: '0', borderRadius: '5px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            outline: 'none', flex: '0 0 auto',
        });
        b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
        return decorateButton(b);
    }

    // Кнопки, которые обязаны оставаться видимыми в узком окне:
    // сжимаем заголовок и подпись масштаба, а не прячем управление.
    // Снимает оформление, заданное инлайново в iconButton(), чтобы кнопку
    // полностью оформил класс из <style> (иначе :hover не работает).
    function bareButton(b, cls) {
        if (!b) return b;
        if (cls) b.className = cls;
        b.style.background = '';
        b.style.width = '';
        b.style.height = '';
        b.style.borderRadius = '';
        b.style.display = '';
        b.style.alignItems = '';
        b.style.justifyContent = '';
        b.style.outline = '';
        return b;
    }

    function compactButton(b) {
        b.dataset.compact = '1';
        b.style.width = '26px';
        b.style.height = '24px';
        return b;
    }

    function separator() {
        const s = document.createElement('div');
        Object.assign(s.style, {
            width: '1px', height: '20px', background: 'rgba(255,255,255,0.15)',
            margin: '0 3px', flex: '0 0 auto',
        });
        return s;
    }

    // Растяжка, прижимающая undo/redo/trash к правому краю полосы
    function tbSpacer() {
        const d = document.createElement('div');
        Object.assign(d.style, { flex: '1 1 8px', minWidth: '0', height: '1px' });
        return d;
    }

    // --- Всплывающие панели (меню и поповеры) ------------------------------
    // Никакого innerHTML: только createElement/textContent.
    function closeMenu() {
        if (menuEl) {
            try { menuEl.remove(); } catch (e) { /* ignore */ }
            menuEl = null;
        }
        if (menuAnchorBtn) {
            menuAnchorBtn.dataset.open = '';
            setBtnActive(menuAnchorBtn, menuAnchorBtn.dataset.active === '1');
            menuAnchorBtn.setAttribute('aria-expanded', 'false');
            menuAnchorBtn = null;
        }
    }

    function menuOpen() { return !!menuEl; }

    function openPanel(anchorBtn, title, build, opts) {
        if (!win) return null;
        if (menuEl && menuAnchorBtn === anchorBtn) { closeMenu(); return null; }
        closeMenu();

        const O = opts || {};
        const panel = document.createElement('div');
        Object.assign(panel.style, {
            position: 'absolute', zIndex: '9', minWidth: (O.minWidth || 190) + 'px',
            maxWidth: 'min(340px, calc(100% - 12px))',
            maxHeight: 'min(360px, calc(100% - 12px))', overflow: 'auto',
            background: '#2b2b2b', color: '#eee', borderRadius: '8px',
            boxShadow: '0 10px 28px rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.12)',
            padding: '6px', boxSizing: 'border-box', font: '12.5px/1.4 sans-serif',
        });
        panel.setAttribute('role', 'menu');
        panel.addEventListener('mousedown', (e) => e.stopPropagation());
        panel.addEventListener('click', (e) => e.stopPropagation());

        const head = document.createElement('div');
        head.textContent = title || '';
        Object.assign(head.style, {
            padding: '2px 6px 6px', opacity: '0.65', fontSize: '11.5px',
            textTransform: 'uppercase', letterSpacing: '0.04em',
        });
        if (title) panel.appendChild(head);

        build(panel);

        win.appendChild(panel);
        menuEl = panel;
        menuAnchorBtn = anchorBtn;
        if (anchorBtn) {
            anchorBtn.dataset.open = '1';
            setBtnActive(anchorBtn, true);
            anchorBtn.setAttribute('aria-expanded', 'true');
        }

        // ставим под кнопкой, но не выпускаем за окно
        const l = clamp(anchorBtn ? anchorBtn.offsetLeft : 8, 6, Math.max(6, win.clientWidth - panel.offsetWidth - 6));
        const t = (anchorBtn ? anchorBtn.offsetTop + anchorBtn.offsetHeight : 6) + 2;
        panel.style.left = Math.round(l) + 'px';
        panel.style.top = Math.round(t) + 'px';
        panel.style.maxHeight = Math.max(80, Math.min(360, win.clientHeight - t - 8)) + 'px';
        return panel;
    }

    // Пункт меню: { label, hint, check, disabled, onClick }
    function menuItem(parent, it) {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        Object.assign(b.style, {
            display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
            background: 'transparent', color: '#eee', border: 'none', cursor: 'pointer',
            padding: '6px 8px', borderRadius: '5px', textAlign: 'left', font: 'inherit',
            outline: 'none', boxSizing: 'border-box',
        });
        if (it.icon && ICONS[it.icon]) b.appendChild(makeIcon(ICONS[it.icon]));

        const label = document.createElement('span');
        label.textContent = it.label;
        Object.assign(label.style, { flex: '1 1 auto', minWidth: '0' });

        const hint = document.createElement('span');
        hint.textContent = it.hint || '';
        Object.assign(hint.style, {
            opacity: '0.55', fontSize: '11px', flex: '0 0 auto',
            fontFamily: 'ui-monospace, monospace',
        });

        b.append(label, hint);
        if (it.check) {
            const tick = document.createElement('span');
            tick.textContent = '✓';
            Object.assign(tick.style, { color: '#6cb6ff', flex: '0 0 auto' });
            b.appendChild(tick);
        }
        if (it.hint) b.setAttribute('aria-keyshortcuts', it.hint);

        if (it.disabled) {
            b.disabled = true;
            b.style.opacity = '0.4';
            b.style.cursor = 'default';
            b.setAttribute('aria-disabled', 'true');
        } else {
            b.addEventListener('mouseenter', () => { b.style.background = 'rgba(255,255,255,0.12)'; });
            b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
            b.addEventListener('click', () => {
                closeMenu();
                try { it.onClick(); } catch (e) { /* ignore */ }
            });
        }
        parent.appendChild(b);
        return b;
    }

    function menuSep(parent) {
        parent.appendChild(mk('div', {
            height: '1px', background: 'rgba(255,255,255,0.12)', margin: '5px 4px',
        }));
    }

    function menuNote(parent, text) {
        const d = mk('div', { padding: '4px 8px 6px', opacity: '0.6', fontSize: '11.5px' }, null);
        d.textContent = text;
        parent.appendChild(d);
        return d;
    }

    // --- Быстрые цвета (4.3) ------------------------------------------------
    const DEFAULT_PINS = ['#ff3b30', '#ffcc00', '#34c759', '#4da3ff', '#ffffff'];

    function readQuickColors() {
        let pins = DEFAULT_PINS.slice();
        try {
            const raw = storeGet('img_mag_pins');
            if (raw) {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr)) {
                    const clean = arr.filter((c) => hexToRgb(c)).map((c) => String(c).toLowerCase());
                    if (clean.length) pins = clean.slice(0, QUICK_PINS);
                }
            }
        } catch (e) { /* ignore */ }
        let rec = [];
        try {
            const raw = storeGet('img_mag_recent');
            if (raw) {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr)) {
                    rec = arr.filter((c) => hexToRgb(c)).map((c) => String(c).toLowerCase());
                }
            }
        } catch (e) { /* ignore */ }
        quickPins = pins;
        quickRecent = rec.slice(0, QUICK_RECENT);
    }

    function saveQuickColors() {
        try { storeSet('img_mag_pins', JSON.stringify(quickPins.slice(0, QUICK_PINS))); } catch (e) { /* ignore */ }
        try { storeSet('img_mag_recent', JSON.stringify(quickRecent.slice(0, QUICK_RECENT))); } catch (e) { /* ignore */ }
    }

    function setPenColor(hex, quiet) {
        const rgb = hexToRgb(hex);
        if (!rgb) return;
        penColor = rgbToHex(rgb.r, rgb.g, rgb.b).toLowerCase();
        storeSet('img_mag_color', penColor);
        if (hsvRefs) syncColorUi();
        if (textInput) {
            textInput.style.color = penColor;
            textInput.style.caretColor = penColor;
            textInput.style.boxShadow = '0 0 0 1px ' + penColor + ', 0 1px 6px rgba(0,0,0,0.5)';
        }
        pushRecentColor(penColor);
        if (!quiet) {
            /* цвет уже применён; перерисовка не нужна до следующего штриха */
        }
    }

    function pushRecentColor(hex) {
        const c = String(hex || '').toLowerCase();
        if (!hexToRgb(c)) return;
        const next = [c];
        for (let i = 0; i < quickRecent.length; i++) {
            if (quickRecent[i] !== c) next.push(quickRecent[i]);
        }
        quickRecent = next.slice(0, QUICK_RECENT);
        saveQuickColors();
    }

    // --- Закрепление и прозрачность (5.3) ----------------------------------
    function applyWindowLook() {
        if (!win) return;
        win.style.opacity = translucent ? '0.82' : '1';
        win.style.pointerEvents = '';
        if (viewEl) {
            viewEl.style.pointerEvents = ghostMode ? 'none' : '';
            viewEl.style.cursor = ghostMode ? 'default' : (currentTool === 'move' ? 'grab' : 'crosshair');
        }
        if (pinBtn) {
            setBtnActive(pinBtn, pinned);
            pinBtn.title = (pinned ? 'Открепить' : 'Закрепить') + ' окно (Shift+P)';
            pinBtn.setAttribute('aria-label', pinBtn.title);
            pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
        }
        win.setAttribute('data-pinned', pinned ? '1' : '0');
    }

    function togglePin(force) {
        const next = (force === undefined) ? !pinned : !!force;
        pinned = next;
        storeSet('img_mag_pin', pinned ? '1' : '0');
        applyWindowLook();
        announce(pinned ? 'Окно закреплено — клик мимо не закрывает' : 'Окно откреплено');
    }

    function toggleGhost(force) {
        const next = (force === undefined) ? !ghostMode : !!force;
        ghostMode = next;
        applyWindowLook();
        announce(ghostMode ? 'Режим «только смотреть»: клики проходят сквозь картинку' : 'Обычный режим');
    }

    function toggleTranslucent(force) {
        const next = (force === undefined) ? !translucent : !!force;
        translucent = next;
        storeSet('img_mag_translucent', translucent ? '1' : '0');
        applyWindowLook();
        announce(translucent ? 'Полупрозрачное окно' : 'Обычная прозрачность');
    }

    // --- Фокус-ловушка (4.1) -----------------------------------------------
    function collectFocusables() {
        const out = [];
        if (!win) return out;
        const nodes = win.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i];
            if (el.disabled) continue;
            if (el.dataset && el.dataset.disabled === '1') continue;
            let r;
            try { r = el.getBoundingClientRect(); } catch (e) { continue; }
            if (!r || (!r.width && !r.height)) continue;
            if (el === zoomLabel || el.tagName === 'INPUT' || el.tagName === 'SELECT' ||
                el.tagName === 'TEXTAREA' || el.tabIndex >= 0) {
                out.push(el);
            }
        }
        return out;
    }

    // Tab ходит только по окну и никогда не уходит на страницу.
    function trapFocus(e) {
        const list = collectFocusables();
        if (!list.length) { e.preventDefault(); return; }
        const active = document.activeElement;
        let idx = list.indexOf(active);
        if (idx === -1) idx = e.shiftKey ? 0 : -1;
        const dir = e.shiftKey ? -1 : 1;
        let next = idx + dir;
        if (next < 0) next = list.length - 1;
        if (next >= list.length) next = 0;
        e.preventDefault();
        try { list[next].focus({ preventScroll: true }); } catch (err) { /* ignore */ }
    }

    // ======================================================================
    // Интерфейс: рейка категорий, панель свойств, строка состояния
    // ======================================================================
    const UI_STORE_KEY = 'img_mag_ui';

    const RAIL_CATS = [
        { id: 'draw',      label: 'Рисование',     hint: 'кисти и фигуры' },
        { id: 'recognize', label: 'Распознавание', hint: 'текст, коды, перспектива' },
        { id: 'analyze',   label: 'Анализ',        hint: 'цвета и статистика' },
        { id: 'file',      label: 'Файл',          hint: 'копировать и сохранить' },
        { id: 'edit',      label: 'История',       hint: 'отмена и очистка' },
    ];

    const RAIL_ACTS = [
        { id: 'ocr',        cat: 'recognize', label: 'Текст с выделения',      icon: 'scan',    hint: 'Выделите область с текстом' },
        { id: 'qr',         cat: 'recognize', label: 'QR и штрихкод',          icon: 'qr',      hint: 'Выделите код' },
        { id: 'persp',      cat: 'recognize', label: 'Выпрямить перспективу',  icon: 'warp',    hint: 'Поставьте четыре угла' },
        { id: 'palette',    cat: 'analyze',   label: 'Палитра картинки',       icon: 'palette', hint: 'Главные цвета снимка' },
        { id: 'grid',       cat: 'analyze',   label: 'Пиксельная сетка',       icon: 'grid',    hint: 'От 800%' },
        { id: 'copy',       cat: 'file',      label: 'Копировать',             icon: 'copy',    hint: 'Ctrl+C' },
        { id: 'save',       cat: 'file',      label: 'Сохранить',              icon: 'save',    hint: 'Ctrl+S' },
        { id: 'export',     cat: 'file',      label: 'Формат и качество',      icon: 'export',  hint: 'PNG, JPEG, WebP' },
        { id: 'undo',       cat: 'edit',      label: 'Отменить',               icon: 'undo',    hint: 'Ctrl+Z' },
        { id: 'redo',       cat: 'edit',      label: 'Повторить',              icon: 'redo',    hint: 'Ctrl+Shift+Z' },
        { id: 'clear',      cat: 'edit',      label: 'Очистить всё',           icon: 'trash',   hint: 'Снять все пометки' },
    ];

    const UI_GROUPS = [
        { id: 'rail',      label: 'Рейка инструментов', hint: 'слева' },
        { id: 'props',     label: 'Панель свойств',     hint: 'справа' },
        { id: 'statusbar', label: 'Строка состояния',   hint: 'снизу' },
    ];

    const UI_PRESETS = [
        { id: 'full', label: 'Всё видно' },
        { id: 'view', label: 'Только просмотр' },
        { id: 'draw', label: 'Только рисование' },
    ];

    function defaultUi() {
        const cats = {}, tools = {}, acts = {}, groups = {}, collapsed = {};
        RAIL_CATS.forEach((c) => { cats[c.id] = true; });
        ['move', 'pen', 'line', 'arrow', 'rect', 'circle', 'text', 'eraser'].forEach((t) => { tools[t] = true; });
        RAIL_ACTS.forEach((a) => { acts[a.id] = true; });
        UI_GROUPS.forEach((g) => { groups[g.id] = true; });
        return {
            cats: cats, tools: tools, acts: acts, groups: groups,
            order: RAIL_CATS.map((c) => c.id), collapsed: collapsed,
            preset: 'full',
        };
    }

    function cloneUi(src) {
        const d = defaultUi();
        const o = src && typeof src === 'object' ? src : {};
        const take = (dst, s) => {
            if (!s || typeof s !== 'object') return;
            for (const k in dst) if (typeof s[k] === 'boolean') dst[k] = s[k];
        };
        take(d.cats, o.cats); take(d.tools, o.tools); take(d.acts, o.acts); take(d.groups, o.groups);
        if (Array.isArray(o.order)) {
            const seen = {};
            const order = [];
            o.order.forEach((id) => {
                if (d.cats[id] !== undefined && !seen[id]) { order.push(id); seen[id] = 1; }
            });
            RAIL_CATS.forEach((c) => { if (!seen[c.id]) order.push(c.id); });
            d.order = order;
        }
        if (o.collapsed && typeof o.collapsed === 'object') {
            for (const k in o.collapsed) if (typeof o.collapsed[k] === 'boolean') d.collapsed[k] = o.collapsed[k];
        }
        if (typeof o.preset === 'string') d.preset = o.preset;
        return d;
    }

    let uiCfg = null;

    function loadUiCfg() {
        if (uiCfg) return uiCfg;
        let raw = null;
        try { raw = storeGet(UI_STORE_KEY); } catch (e) { raw = null; }
        if (typeof raw === 'string' && raw) {
            try { raw = JSON.parse(raw); } catch (e) { raw = null; }
        }
        uiCfg = cloneUi(raw);
        return uiCfg;
    }

    function saveUiCfg() {
        if (!uiCfg) return;
        try { storeSet(UI_STORE_KEY, JSON.stringify(uiCfg)); } catch (e) { /* ignore */ }
    }

    function catLabel(id) {
        for (let i = 0; i < RAIL_CATS.length; i++) if (RAIL_CATS[i].id === id) return RAIL_CATS[i].label;
        return id;
    }

    // --- Стили окна --------------------------------------------------------
    // Один <style> с классам вместо десятков inline-стилей. Trusted Types:
    // только textContent, никакого innerHTML.
    function injectWinCss() {
        if (document.getElementById('img-mag-css')) return;
        const css = [
            '#img-mag-window{--imv-bar:#1e2228;--imv-rail:#191d22;--imv-props:#1a1e24;--imv-card:#232830;',
            '--imv-line:rgba(255,255,255,.09);--imv-line2:rgba(255,255,255,.16);--imv-fg:#e9edf3;',
            '--imv-fg2:#98a1ad;--imv-fg3:#6d7683;--imv-accent:#2ec4b6;}',
            '#img-mag-window button{font:inherit;}',
            '#img-mag-window .imv-btn{background:transparent;color:#fff;border:none;cursor:pointer;',
            'width:30px;height:26px;padding:0;border-radius:6px;display:flex;align-items:center;',
            'justify-content:center;outline:none;flex:0 0 auto;}',
            '#img-mag-window .imv-btn:hover{background:rgba(255,255,255,.14);}',
            '#img-mag-window .imv-btn:focus-visible{outline:2px solid #4da3ff;outline-offset:1px;}',
            '#img-mag-window .imv-btn.is-on{background:rgba(46,196,182,.22);color:#8ef0e4;}',
            '#img-mag-window .imv-btn[disabled],#img-mag-window .imv-btn[aria-disabled="true"]{opacity:.35;cursor:default;}',
            '#img-mag-window .imv-sep{width:1px;height:20px;background:var(--imv-line2);margin:0 4px;flex:0 0 auto;}',
            '#img-mag-window .imv-head{display:flex;align-items:center;gap:2px;height:38px;flex:0 0 38px;',
            'padding:0 6px 0 12px;background:var(--imv-bar);border-bottom:1px solid var(--imv-line);',
            'cursor:move;user-select:none;box-sizing:border-box;min-width:0;}',
            '#img-mag-window .imv-title{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
            'opacity:.9;min-width:0;font-size:12.5px;}',
            '#img-mag-window .imv-zoom{display:flex;align-items:center;gap:1px;flex:0 0 auto;}',
            '#img-mag-window .imv-zoomval{min-width:44px;padding:3px 6px;border-radius:5px;background:rgba(255,255,255,.07);',
            'color:#fff;border:none;cursor:pointer;font-size:11.5px;font-variant-numeric:tabular-nums;outline:none;}',
            '#img-mag-window .imv-zoomval:hover{background:rgba(255,255,255,.14);}',
            '#img-mag-window .imv-body{display:flex;flex:1 1 auto;min-height:0;min-width:0;position:relative;}',
            // Компактный режим: узкое окно — узкие элементы.
            '#img-mag-window.imv-narrow .imv-rail{flex-basis:50px;width:50px;}',
            '#img-mag-window.imv-narrow .imv-railbtn{width:44px;height:24px;}',
            '#img-mag-window.imv-narrow .imv-railbtn svg{width:15px;height:15px;}',
            '#img-mag-window.imv-narrow .imv-cathead{font-size:6.5px;min-height:14px;padding:2px 2px 1px;}',
            '#img-mag-window.imv-narrow .imv-props{flex-basis:150px;width:150px;}',
            '#img-mag-window.imv-narrow .imv-hsvwrap,#img-mag-window.imv-narrow .imv-hsvcv{width:112px;height:112px;}',
            '#img-mag-window.imv-narrow .imv-thick{min-width:22px;font-size:10.5px;}',
            '#img-mag-window.imv-tiny .imv-rail{flex-basis:42px;width:42px;}',
            '#img-mag-window.imv-tiny .imv-railbtn{width:36px;height:22px;}',
            '#img-mag-window.imv-tiny .imv-railbtn svg{width:14px;height:14px;}',
            '#img-mag-window.imv-tiny .imv-cathead{font-size:6px;min-height:13px;}',
            '#img-mag-window.imv-tiny .imv-head{height:32px;flex-basis:32px;padding:0 4px 0 8px;}',
            '#img-mag-window.imv-tiny .imv-title{font-size:11px;}',
            '#img-mag-window.imv-tiny .imv-zoomval{min-width:36px;font-size:10.5px;padding:2px 4px;}',
            '#img-mag-window.imv-tiny .imv-btn{width:26px;height:24px;}',
            '#img-mag-window .imv-rail{flex:0 0 62px;width:62px;display:flex;flex-direction:column;align-items:stretch;',
            'gap:1px;padding:5px 0 6px;background:var(--imv-rail);border-right:1px solid var(--imv-line);',
            'overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;box-sizing:border-box;}',
            '#img-mag-window .imv-rail[hidden]{display:none;}',
            '#img-mag-window .imv-rail::-webkit-scrollbar{width:4px;}',
            '#img-mag-window .imv-rail::-webkit-scrollbar-thumb{background:var(--imv-line2);border-radius:2px;}',
            '#img-mag-window .imv-cat{display:flex;flex-direction:column;}',
            '#img-mag-window .imv-cat+.imv-cat{border-top:1px solid var(--imv-line);margin-top:3px;padding-top:3px;}',
            '#img-mag-window .imv-cat.is-dragging{opacity:.55;}',
            '#img-mag-window .imv-cathead{position:relative;display:flex;align-items:center;gap:1px;min-height:16px;',
            'padding:2px 2px 1px;border-radius:5px;cursor:grab;color:var(--imv-fg3);font-size:7px;',
            'font-weight:600;line-height:1.15;letter-spacing:-.1px;user-select:none;}',
            '#img-mag-window .imv-cathead:hover{background:rgba(255,255,255,.07);color:var(--imv-fg2);}',
            '#img-mag-window .imv-cathead:focus-visible{outline:2px solid var(--imv-accent);outline-offset:-1px;}',
            '#img-mag-window .imv-catname{flex:1 1 auto;min-width:0;overflow-wrap:break-word;}',
            '#img-mag-window .imv-catchev{width:8px;height:8px;opacity:.5;flex:0 0 auto;transition:transform .15s;}',
            '#img-mag-window .imv-cat.is-collapsed .imv-catchev{transform:rotate(-90deg);}',
            '#img-mag-window .imv-catbody{display:flex;flex-direction:column;align-items:center;gap:1px;}',
            '#img-mag-window .imv-cat.is-collapsed .imv-catbody{display:none;}',
            '#img-mag-window .imv-railbtn{width:56px;height:27px;border-radius:7px;}',
            '#img-mag-window .imv-railbtn svg{width:17px;height:17px;}',
            '#img-mag-window .imv-center{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0;}',
            '#img-mag-window .imv-status{flex:0 0 28px;height:28px;display:flex;align-items:center;gap:7px;',
            'padding:0 10px;background:var(--imv-bar);border-top:1px solid var(--imv-line);font-size:11.5px;',
            'color:var(--imv-fg2);box-sizing:border-box;min-width:0;}',
            '#img-mag-window .imv-status[hidden]{display:none;}',
            '#img-mag-window .imv-stool{color:var(--imv-fg);font-weight:600;flex:0 0 auto;}',
            '#img-mag-window .imv-sdot{width:4px;height:4px;border-radius:50%;background:var(--imv-accent);flex:0 0 auto;}',
            '#img-mag-window .imv-shint{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '#img-mag-window .imv-sright{display:flex;gap:10px;flex:0 0 auto;font-variant-numeric:tabular-nums;}',
            '#img-mag-window .imv-props{flex:0 0 186px;width:186px;display:flex;flex-direction:column;',
            'background:var(--imv-props);border-left:1px solid var(--imv-line);box-sizing:border-box;min-width:0;}',
            '#img-mag-window .imv-props[hidden]{display:none;}',
            '#img-mag-window .imv-propshead{display:flex;align-items:center;gap:6px;padding:7px 8px 6px;',
            'border-bottom:1px solid var(--imv-line);color:var(--imv-fg2);font-size:11px;',
            'text-transform:uppercase;letter-spacing:.04em;flex:0 0 auto;}',
            '#img-mag-window .imv-propshead svg{width:14px;height:14px;flex:0 0 auto;}',
            '#img-mag-window .imv-propstitle{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '#img-mag-window .imv-propshead kbd{font:10px ui-monospace,monospace;padding:1px 4px;border-radius:3px;',
            'background:rgba(255,255,255,.09);color:var(--imv-fg2);flex:0 0 auto;}',
            '#img-mag-window .imv-propsbody{flex:1 1 auto;overflow-y:auto;padding:8px;display:flex;',
            'flex-direction:column;gap:9px;min-height:0;scrollbar-width:thin;}',
            '#img-mag-window .imv-propsbody::-webkit-scrollbar{width:4px;}',
            '#img-mag-window .imv-propsbody::-webkit-scrollbar-thumb{background:var(--imv-line2);border-radius:2px;}',
            '#img-mag-window .imv-propsfoot{flex:0 0 auto;padding:5px;border-top:1px solid var(--imv-line);}',
            '#img-mag-window .imv-fold{display:flex;align-items:center;justify-content:center;gap:5px;width:100%;',
            'height:24px;background:transparent;color:var(--imv-fg2);border:1px solid var(--imv-line2);',
            'border-radius:5px;cursor:pointer;font-size:11px;outline:none;}',
            '#img-mag-window .imv-fold:hover{background:rgba(255,255,255,.08);color:#fff;}',
            '#img-mag-window .imv-fold svg{width:11px;height:11px;transition:transform .15s;}',
            '#img-mag-window .imv-props.is-folded{flex:0 0 30px;width:30px;}',
        '#img-mag-window .imv-props.is-folded .imv-propspin{display:none;}',,
            '#img-mag-window .imv-props.is-folded .imv-propstitle,',
            '#img-mag-window .imv-props.is-folded .imv-propshead kbd,',
            '#img-mag-window .imv-props.is-folded .imv-propsbody,',
            '#img-mag-window .imv-props.is-folded .imv-fold span{display:none;}',
            '#img-mag-window .imv-props.is-folded .imv-propshead{justify-content:center;padding:7px 0 6px;}',
            '#img-mag-window .imv-props.is-folded .imv-fold svg{transform:rotate(180deg);}',
            '#img-mag-window .imv-plabel{font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;',
            'color:var(--imv-fg3);display:flex;justify-content:space-between;gap:6px;}',
            '#img-mag-window .imv-plabel b{color:var(--imv-fg2);font:10.5px ui-monospace,monospace;font-weight:600;}',
            '#img-mag-window .imv-hsv{display:flex;justify-content:center;}',
            '#img-mag-window .imv-hsvcv{border-radius:50%;cursor:crosshair;touch-action:none;outline:none;',
            'box-shadow:0 0 0 1px rgba(0,0,0,.5),0 0 0 2px rgba(255,255,255,.12);display:block;}',
            '#img-mag-window .imv-hsvwrap{position:relative;width:132px;height:132px;flex:0 0 auto;}',
            '#img-mag-window .imv-hsvdot{position:absolute;width:14px;height:14px;margin:-7px 0 0 -7px;',
            'border-radius:50%;border:2px solid #fff;pointer-events:none;',
            'box-shadow:0 0 0 1px rgba(0,0,0,.6),0 2px 6px rgba(0,0,0,.5);}',
            '#img-mag-window .imv-vrow{display:flex;align-items:center;gap:6px;}',
            '#img-mag-window .imv-vrow span{font:10px ui-monospace,monospace;color:var(--imv-fg3);flex:0 0 auto;}',
            '#img-mag-window .imv-vrow output{font:10px ui-monospace,monospace;color:var(--imv-fg2);',
            'min-width:24px;text-align:right;flex:0 0 auto;}',
            '#img-mag-window .imv-range{flex:1 1 auto;min-width:0;accent-color:var(--imv-accent);height:14px;}',
            '#img-mag-window .imv-thicks{display:flex;gap:3px;flex-wrap:wrap;}',
            '#img-mag-window .imv-thick{flex:1 1 0;min-width:0;height:22px;border-radius:5px;cursor:pointer;',
            'background:rgba(255,255,255,.06);color:var(--imv-fg2);border:1px solid transparent;',
            'font-size:10.5px;outline:none;}',
            '#img-mag-window .imv-thick:hover{background:rgba(255,255,255,.12);color:#fff;}',
            '#img-mag-window .imv-thick.is-on{background:rgba(46,196,182,.2);border-color:rgba(46,196,182,.55);color:#8ef0e4;}',
            '#img-mag-window .imv-rows{display:flex;gap:3px;}',
            '#img-mag-window .imv-row{flex:1 1 0;height:24px;border-radius:5px;cursor:pointer;',
            'background:rgba(255,255,255,.06);color:var(--imv-fg2);border:1px solid transparent;',
            'font-size:11px;outline:none;}',
            '#img-mag-window .imv-row:hover{background:rgba(255,255,255,.12);color:#fff;}',
            '#img-mag-window .imv-row.is-on{background:rgba(46,196,182,.2);border-color:rgba(46,196,182,.55);color:#8ef0e4;}',
            '#img-mag-window .imv-hint{font-size:10.5px;line-height:1.45;color:var(--imv-fg3);}',
            '#img-mag-window .imv-swrow{display:flex;align-items:center;gap:8px;width:100%;padding:5px 7px;',
            'border-radius:5px;background:transparent;border:none;cursor:pointer;color:#eee;',
            'text-align:left;outline:none;}',
            '#img-mag-window .imv-swrow:hover{background:rgba(255,255,255,.08);}',
            '#img-mag-window .imv-swrow:focus-visible{outline:2px solid #4da3ff;outline-offset:-2px;}',
            '#img-mag-window .imv-swlabel{flex:1 1 auto;min-width:0;font-size:12px;}',
            '#img-mag-window .imv-swlabel em{display:block;font-size:10.5px;font-style:normal;color:var(--imv-fg3);}',
            '#img-mag-window .imv-switch{flex:0 0 auto;width:26px;height:15px;border-radius:8px;',
            'background:rgba(255,255,255,.16);position:relative;transition:background .15s;}',
            '#img-mag-window .imv-switch::after{content:"";position:absolute;left:2px;top:2px;width:11px;height:11px;',
            'border-radius:50%;background:#fff;transition:left .15s;}',
            '#img-mag-window .imv-swrow[aria-checked="true"] .imv-switch{background:var(--imv-accent);}',
            '#img-mag-window .imv-swrow[aria-checked="true"] .imv-switch::after{left:13px;}',
            '#img-mag-window .imv-sec{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;',
            'color:var(--imv-fg3);padding:7px 7px 4px;position:sticky;top:0;background:#2b2b2b;z-index:1;}',
            '#img-mag-window .imv-presets{display:grid;grid-template-columns:1fr 1fr;gap:5px;padding:2px 7px 8px;}',
            '#img-mag-window .imv-preset{height:28px;border-radius:6px;cursor:pointer;font-size:11.5px;',
            'background:rgba(255,255,255,.07);color:#ddd;border:1px solid transparent;outline:none;}',
            '#img-mag-window .imv-preset:hover{background:rgba(255,255,255,.14);color:#fff;}',
            '#img-mag-window .imv-preset.is-on{background:rgba(46,196,182,.2);border-color:rgba(46,196,182,.55);color:#8ef0e4;}',
            '#img-mag-window .imv-count{font:10.5px ui-monospace,monospace;color:var(--imv-fg3);}',
            '@media (prefers-reduced-motion: reduce){#img-mag-window *{transition-duration:.001s!important;animation-duration:.001s!important;}}',
        ].join('');
        const st = document.createElement('style');
        st.id = 'img-mag-css';
        st.textContent = css;
        (document.head || document.documentElement).appendChild(st);
    }

    // --- Кнопка-иконка в стиле рейки --------------------------------------
    function railIconButton(iconName, label, hint) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'imv-btn imv-railbtn';
        b.title = label + (hint ? ' — ' + hint : '');
        b.setAttribute('aria-label', label);
        b.appendChild(makeIcon(ICONS[iconName] || ICONS.more));
        // iconButton() ставит размеры инлайново — в рейке нужен свой,
        // поэтому инлайновые значения снимаем, оставляя их классу.
        b.style.width = '';
        b.style.height = '';
        b.addEventListener('mousedown', (e) => e.stopPropagation());
        return b;
    }

    // --- Шапка окна --------------------------------------------------------
    function buildHead(caption, url) {
        const head = document.createElement('div');
        head.className = 'imv-head';

        const title = document.createElement('div');
        title.className = 'imv-title';
        title.textContent = caption || 'Изображение';
        title.title = caption || url || '';

        zoomLabel = document.createElement('button');
        zoomLabel.type = 'button';
        zoomLabel.className = 'imv-zoomval';
        zoomLabel.title = 'Сбросить масштаб до 100% (Ctrl+0)';
        zoomLabel.setAttribute('aria-label', 'Масштаб. Нажмите, чтобы сбросить до 100%');
        zoomLabel.addEventListener('mousedown', (e) => e.stopPropagation());
        zoomLabel.addEventListener('click', (e) => { e.stopPropagation(); setZoom(1); });

        const zoom = document.createElement('div');
        zoom.className = 'imv-zoom';
        const headBtn = (icon, label, onClick) => bareButton(iconButton(icon, label, onClick), 'imv-btn');

        const btnOut = headBtn('zoomOut', 'Отдалить', () => zoomCenter(1 / ZOOM_STEP));
        const btnIn = headBtn('zoomIn', 'Приблизить', () => zoomCenter(ZOOM_STEP));
        const btnFit = headBtn('fit', 'По размеру окна (Ctrl+1)', () => fitImage());
        zoom.append(btnOut, zoomLabel, btnIn, btnFit);

        pinBtn = headBtn('pin', 'Закрепить окно (Shift+P)', () => togglePin());
        const helpBtn = headBtn('help', 'Горячие клавиши (?)', () => toggleHelp());
        const setBtn = headBtn('sliders', 'Настройки интерфейса', (e) => openUiSettings(e.currentTarget));
        setBtn.setAttribute('aria-haspopup', 'true');
        moreBtn = headBtn('more', 'Ещё', (e) => openMoreMenu(e.currentTarget));
        const closeBtn = headBtn('close', 'Закрыть (Esc)', () => closeWindow());

        const sepA = document.createElement('div');
        sepA.className = 'imv-sep';

        head.append(title, zoom, sepA, pinBtn, helpBtn, setBtn, moreBtn, closeBtn);
        applyWindowLook();
        return head;
    }

    // --- Рейка с категориями ----------------------------------------------
    const railActs = {};
    let railDragEl = null, railDragY = 0, railDragMoved = false;

    function buildRail() {
        const rail = railEl || document.createElement('div');
        rail.className = 'imv-rail';
        rail.setAttribute('role', 'toolbar');
        rail.setAttribute('aria-orientation', 'vertical');
        rail.setAttribute('aria-label', 'Инструменты');
        while (rail.firstChild) rail.removeChild(rail.firstChild);

        toolButtons = {};
        for (const k in railActs) delete railActs[k];
        let shown = 0;

        const cfg = loadUiCfg();
        cfg.order.forEach((catId) => {
            if (!cfg.cats[catId]) return;
            const items = [];
            if (catId === 'draw') {
                ['move', 'pen', 'line', 'arrow', 'rect', 'circle', 'text', 'eraser'].forEach((id) => {
                    if (cfg.tools[id]) items.push({ kind: 'tool', id: id });
                });
            }
            RAIL_ACTS.forEach((a) => {
                if (a.cat === catId && cfg.acts[a.id]) items.push({ kind: 'act', def: a });
            });
            if (!items.length) return;
            shown++;

            const wrap = document.createElement('div');
            wrap.className = 'imv-cat';
            wrap.setAttribute('data-cat', catId);

            const head = document.createElement('div');
            head.className = 'imv-cathead';
            head.setAttribute('role', 'button');
            head.tabIndex = 0;
            head.title = catLabel(catId) + ' — перетащите, чтобы поменять порядок';
            const nm = document.createElement('span');
            nm.className = 'imv-catname';
            nm.textContent = catLabel(catId);
            const chev = makeIcon(ICONS.chevron || ICONS.close);
            chev.setAttribute('class', 'imv-catchev');
            head.append(nm, chev);
            wrap.appendChild(head);

            const body = document.createElement('div');
            body.className = 'imv-catbody';

            items.forEach((it) => {
                let b;
                if (it.kind === 'tool') {
                    const def = toolDefById(it.id);
                    b = railIconButton(it.id, def.label, 'клавиша ' + def.key);
                    b.setAttribute('data-tool', it.id);
                    b.setAttribute('aria-pressed', String(currentTool === it.id));
                    if (currentTool === it.id) b.classList.add('is-on');
                    b.addEventListener('click', () => setTool(it.id));
                    toolButtons[it.id] = b;
                    setBtnActive(b, currentTool === it.id);
                } else {
                    b = railIconButton(it.def.icon, it.def.label, it.def.hint);
                    b.setAttribute('data-act', it.def.id);
                    b.addEventListener('click', () => runRailAction(it.def.id, b));
                    railActs[it.def.id] = b;
                }
                body.appendChild(b);
            });
            wrap.appendChild(body);

            if (cfg.collapsed[catId]) wrap.classList.add('is-collapsed');

            head.addEventListener('click', () => {
                if (railDragMoved) return;
                cfg.collapsed[catId] = !cfg.collapsed[catId];
                wrap.classList.toggle('is-collapsed', cfg.collapsed[catId]);
                saveUiCfg();
            });
            head.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    cfg.collapsed[catId] = !cfg.collapsed[catId];
                    wrap.classList.toggle('is-collapsed', cfg.collapsed[catId]);
                    saveUiCfg();
                } else if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
                    ev.preventDefault();
                    const i = cfg.order.indexOf(catId);
                    const j = i + (ev.key === 'ArrowUp' ? -1 : 1);
                    if (i >= 0 && j >= 0 && j < cfg.order.length) {
                        const t = cfg.order[i]; cfg.order[i] = cfg.order[j]; cfg.order[j] = t;
                        saveUiCfg();
                        buildRail();
                        const h = rail.querySelector('[data-cat="' + catId + '"] .imv-cathead');
                        if (h) h.focus();
                    }
                }
            });
            head.addEventListener('pointerdown', (ev) => {
                if (ev.button !== 0) return;
                railDragEl = wrap;
                railDragY = ev.clientY;
                railDragMoved = false;
            });

            rail.appendChild(wrap);
        });

        rail.hidden = !cfg.groups.rail || shown === 0;
        undoBtn = railActs['undo'] || null;
        redoBtn = railActs['redo'] || null;
        syncHistoryButtons();
        syncGridButton();
        return rail;
    }

    function onRailDragMove(ev) {
        if (!railDragEl || !railEl) return;
        if (!railDragMoved && Math.abs(ev.clientY - railDragY) < 5) return;
        railDragMoved = true;
        railDragEl.classList.add('is-dragging');
        const sibs = railEl.querySelectorAll('.imv-cat');
        for (let i = 0; i < sibs.length; i++) {
            if (sibs[i] === railDragEl) continue;
            const r = sibs[i].getBoundingClientRect();
            if (ev.clientY < r.top + r.height / 2) {
                if (sibs[i].previousSibling !== railDragEl) railEl.insertBefore(railDragEl, sibs[i]);
                return;
            }
        }
        if (railEl.lastChild !== railDragEl) railEl.appendChild(railDragEl);
    }

    function onRailDragUp() {
        if (!railDragEl) return;
        railDragEl.classList.remove('is-dragging');
        if (railDragMoved && railEl) {
            const cfg = loadUiCfg();
            const order = [];
            const cats = railEl.querySelectorAll('.imv-cat');
            for (let i = 0; i < cats.length; i++) order.push(cats[i].getAttribute('data-cat'));
            RAIL_CATS.forEach((c) => { if (order.indexOf(c.id) === -1) order.push(c.id); });
            cfg.order = order;
            saveUiCfg();
            toast('Порядок категорий сохранён');
        }
        railDragEl = null;
        setTimeout(() => { railDragMoved = false; }, 0);
    }

    function toolDefById(id) {
        const map = {
            move: { label: 'Перемещение', key: 'V', hint: 'Тяните картинку или колесо для зума' },
            pen: { label: 'Карандаш', key: '1', hint: 'Тяните по картинке, чтобы рисовать' },
            line: { label: 'Линия', key: '2', hint: 'Потяните от начала до конца' },
            arrow: { label: 'Стрелка', key: '3', hint: 'Потяните от хвоста к острию' },
            rect: { label: 'Прямоугольник', key: '4', hint: 'Потяните по диагонали рамки' },
            circle: { label: 'Эллипс', key: '5', hint: 'Потяните по диагонали овала' },
            text: { label: 'Текст', key: '6', hint: 'Кликните по картинке и печатайте' },
            eraser: { label: 'Ластик', key: '7', hint: 'Проведите по фигуре, чтобы стереть' },
        };
        return map[id] || { label: id, key: '', hint: '' };
    }

    function runRailAction(id, btn) {
        if (id === 'undo') { undo(); return; }
        if (id === 'redo') { redo(); return; }
        if (id === 'clear') { clearAll(); return; }
        if (id === 'grid') { togglePixelGrid(); return; }
        if (id === 'copy') { copyToClipboard(); return; }
        if (id === 'save') { savePNG(); return; }
        if (id === 'export') { openExportMenu(btn); return; }
        if (id === 'palette') { openPalettePanel(btn); return; }
        if (id === 'persp') {
            if (perspCanvas) restorePerspective(); else beginPerspective();
            return;
        }
        if (id === 'ocr') { startScanFor('text'); return; }
        if (id === 'qr') { startScanFor('qr'); return; }
    }

    function syncGridButton() {
        for (const k in railActs) {
            if (k !== 'grid') continue;
            const b = railActs[k];
            const on = !!pixelGrid;
            b.classList.toggle('is-on', on);
            b.setAttribute('aria-pressed', String(on));
        }
    }

    function syncHistoryButtons() {
        const canUndo = histIndex > 0;
        const canRedo = histIndex < history.length - 1;
        setEnabled(undoBtn, canUndo);
        setEnabled(redoBtn, canRedo);
        if (railActs['clear']) setEnabled(railActs['clear'], annotations.length > 0);
    }

    // --- Палитра: HSV-круг ------------------------------------------------
    function hsvToRgb(h, s, v) {
        const hh = ((h % 360) + 360) % 360 / 60;
        const c = v * s;
        const x = c * (1 - Math.abs(hh % 2 - 1));
        const m = v - c;
        let r = 0, g = 0, b = 0;
        if (hh < 1) { r = c; g = x; }
        else if (hh < 2) { r = x; g = c; }
        else if (hh < 3) { g = c; b = x; }
        else if (hh < 4) { g = x; b = c; }
        else if (hh < 5) { r = x; b = c; }
        else { r = c; b = x; }
        return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
    }

    let uiHsv = { h: 0, s: 1, v: 1 };
    let wheelPaintedV = -1;   // какая яркость сейчас нарисована на колесе

    function colorToHsv(hex) {
        const c = hexToRgb(hex) || { r: 255, g: 59, b: 48 };
        const r = c.r / 255, g = c.g / 255, b = c.b / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const d = max - min;
        let h = 0;
        if (d > 0) {
            if (max === r) h = ((g - b) / d) % 6;
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h *= 60;
        }
        if (h < 0) h += 360;
        return { h: h, s: max === 0 ? 0 : d / max, v: max };
    }

    function paintHsvWheel(cv, v) {
        const size = cv.width;
        const ctx = cv.getContext('2d');
        if (!ctx) return;
        const img = ctx.createImageData(size, size);
        const data = img.data;
        const rad = size / 2;
        for (let y = 0; y < size; y++) {
            const dy = y - rad + 0.5;
            for (let x = 0; x < size; x++) {
                const dx = x - rad + 0.5;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const i = (y * size + x) * 4;
                if (dist > rad) { data[i + 3] = 0; continue; }
                const h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
                const s = Math.min(1, dist / rad);
                const c = hsvToRgb(h, s, v);
                data[i] = c.r; data[i + 1] = c.g; data[i + 2] = c.b;
                data[i + 3] = dist > rad - 1 ? Math.round(255 * (rad - dist)) : 255;
            }
        }
        ctx.clearRect(0, 0, size, size);
        ctx.putImageData(img, 0, 0);
    }

    function syncColorUi() {
        const hsv = colorToHsv(penColor);
        uiHsv.h = Math.round(hsv.h);
        uiHsv.s = hsv.s;
        uiHsv.v = hsv.v;
        if (!hsvRefs) return;
        // Перерисовка 132x132 = 17 400 пикселей. При перетаскивании маркера
        // яркость не меняется, поэтому холст трогаем только когда она ушла.
        if (wheelPaintedV !== uiHsv.v) {
            paintHsvWheel(hsvRefs.cv, uiHsv.v);
            wheelPaintedV = uiHsv.v;
        }
        if (hsvRefs.dot) {
            const ang = uiHsv.h * Math.PI / 180;
            const rr = uiHsv.s * 50;
            hsvRefs.dot.style.left = (50 + Math.cos(ang) * rr) + '%';
            hsvRefs.dot.style.top = (50 + Math.sin(ang) * rr) + '%';
            hsvRefs.dot.style.background = penColor;
        }
        if (hsvRefs.vr) hsvRefs.vr.value = String(Math.round(uiHsv.v * 100));
        if (hsvRefs.vval) hsvRefs.vval.textContent = String(Math.round(uiHsv.v * 100));
        if (hsvRefs.swatch) hsvRefs.swatch.style.background = penColor;
        if (hsvRefs.hex) hsvRefs.hex.textContent = penColor.toUpperCase();
    }

    let hsvRefs = null;

    function hsvBlock() {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;flex-direction:column;gap:5px;';

        const lab = document.createElement('div');
        lab.className = 'imv-plabel';
        const nm = document.createElement('span');
        nm.textContent = 'Цвет';
        const hex = document.createElement('b');
        hex.textContent = penColor.toUpperCase();
        lab.append(nm, hex);

        const outer = document.createElement('div');
        outer.className = 'imv-hsv';
        const box = document.createElement('div');
        box.className = 'imv-hsvwrap';
        const cv = document.createElement('canvas');
        cv.className = 'imv-hsvcv';
        cv.width = 132;
        cv.height = 132;
        cv.style.width = '132px';
        cv.style.height = '132px';
        cv.tabIndex = 0;
        cv.setAttribute('role', 'slider');
        cv.setAttribute('aria-label', 'Цвет: тон и насыщенность');
        const dot = document.createElement('div');
        dot.className = 'imv-hsvdot';
        box.append(cv, dot);
        outer.appendChild(box);

        const vrow = document.createElement('div');
        vrow.className = 'imv-vrow';
        const vnm = document.createElement('span');
        vnm.textContent = 'V';
        const vr = document.createElement('input');
        vr.type = 'range';
        vr.min = '0';
        vr.max = '100';
        vr.step = '1';
        vr.className = 'imv-range';
        vr.setAttribute('aria-label', 'Яркость цвета');
        const vval = document.createElement('output');
        vval.textContent = String(Math.round(uiHsv.v * 100));
        vrow.append(vnm, vr, vval);

        hsvRefs = { cv: cv, dot: dot, vr: vr, vval: vval, hex: hex, swatch: null };
        // Холст новый и пустой, а кэш «какая яркость нарисована» общий для
        // модуля. Без сброса при смене инструмента колесо оставалось чёрным.
        wheelPaintedV = -1;

        const pickFrom = (ev) => {
            const r = cv.getBoundingClientRect();
            const rad = r.width / 2;
            const dx = ev.clientX - r.left - rad;
            const dy = ev.clientY - r.top - rad;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const s = Math.max(0, Math.min(1, dist / rad));
            let h = Math.atan2(dy, dx) * 180 / Math.PI;
            if (h < 0) h += 360;
            uiHsv.h = h;
            uiHsv.s = s;
            const c = hsvToRgb(h, s, uiHsv.v);
            setPenColor(rgbToHex(c.r, c.g, c.b), true);
            syncColorUi();
        };

        let dragging = false;
        cv.addEventListener('pointerdown', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            dragging = true;
            try { cv.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
            pickFrom(ev);
        });
        cv.addEventListener('pointermove', (ev) => {
            if (!dragging) return;
            ev.preventDefault();
            pickFrom(ev);
        });
        const stopDrag = () => { dragging = false; };
        cv.addEventListener('pointerup', stopDrag);
        cv.addEventListener('pointercancel', stopDrag);
        cv.addEventListener('mousedown', (e) => e.stopPropagation());

        vr.addEventListener('input', () => {
            uiHsv.v = clamp(parseInt(vr.value, 10) / 100, 0, 1);
            const c = hsvToRgb(uiHsv.h, uiHsv.s, uiHsv.v);
            setPenColor(rgbToHex(c.r, c.g, c.b), true);
            syncColorUi();
        });
        vr.addEventListener('mousedown', (e) => e.stopPropagation());

        wrap.append(lab, outer, vrow);
        return wrap;
    }

    function thicknessBlock() {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
        const lab = document.createElement('div');
        lab.className = 'imv-plabel';
        const nm = document.createElement('span');
        nm.textContent = 'Толщина';
        const val = document.createElement('b');
        val.textContent = penWidth + 'px';
        lab.append(nm, val);

        const row = document.createElement('div');
        row.className = 'imv-thicks';
        [2, 4, 6, 10, 16].forEach((w) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'imv-thick' + (w === penWidth ? ' is-on' : '');
            b.textContent = String(w);
            b.title = 'Толщина ' + w + ' px';
            b.setAttribute('aria-label', 'Толщина ' + w + ' px');
            b.addEventListener('mousedown', (e) => e.stopPropagation());
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                penWidth = w;
                storeSet('img_mag_width', penWidth);
                const all = row.querySelectorAll('.imv-thick');
                for (let i = 0; i < all.length; i++) all[i].classList.toggle('is-on', all[i] === b);
                val.textContent = w + 'px';
            });
            row.appendChild(b);
        });

        wrap.append(lab, row);
        return wrap;
    }

    function fillBlock() {
        const row = document.createElement('div');
        row.className = 'imv-rows';
        const mk2 = (on, text, tip) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'imv-row' + (on ? ' is-on' : '');
            b.textContent = text;
            b.title = tip;
            b.setAttribute('aria-label', tip);
            b.setAttribute('aria-pressed', String(on));
            b.addEventListener('mousedown', (e) => e.stopPropagation());
            return b;
        };
        const onB = mk2(fillShapes, 'С заливкой', 'Фигуры с заливкой');
        const offB = mk2(!fillShapes, 'Контур', 'Фигуры контуром');
        const apply = (on) => {
            fillShapes = on;
            storeSet('img_mag_fill', on ? '1' : '0');
            onB.classList.toggle('is-on', on);
            offB.classList.toggle('is-on', !on);
            onB.setAttribute('aria-pressed', String(on));
            offB.setAttribute('aria-pressed', String(!on));
        };
        onB.addEventListener('click', (e) => { e.stopPropagation(); apply(true); });
        offB.addEventListener('click', (e) => { e.stopPropagation(); apply(false); });
        row.append(onB, offB);
        return row;
    }

    function textSizeBlock() {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
        const lab = document.createElement('div');
        lab.className = 'imv-plabel';
        const nm = document.createElement('span');
        nm.textContent = 'Размер текста';
        const val = document.createElement('b');
        val.textContent = Math.round(textScreenSize()) + 'px';
        lab.append(nm, val);
        const rng = document.createElement('input');
        rng.type = 'range';
        rng.min = '10';
        rng.max = '120';
        rng.step = '1';
        rng.value = String(Math.round(clamp(textScreenSize(), 10, 120)));
        rng.className = 'imv-range';
        rng.setAttribute('aria-label', 'Размер текста');
        rng.addEventListener('mousedown', (e) => e.stopPropagation());
        rng.addEventListener('input', () => {
            const px = clamp(parseInt(rng.value, 10) || 20, 10, 120);
            storeSet('img_mag_font', px);
            val.textContent = px + 'px';
        });
        wrap.append(lab, rng);
        return wrap;
    }

    function radiusBlock() {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
        const lab = document.createElement('div');
        lab.className = 'imv-plabel';
        const nm = document.createElement('span');
        nm.textContent = 'Радиус ластика';
        const val = document.createElement('b');
        val.textContent = Math.round(eraserRadius()) + 'px';
        lab.append(nm, val);
        const rng = document.createElement('input');
        rng.type = 'range';
        rng.min = '6';
        rng.max = '80';
        rng.step = '1';
        rng.value = String(Math.round(clamp(eraserRadius(), 6, 80)));
        rng.className = 'imv-range';
        rng.setAttribute('aria-label', 'Радиус ластика');
        rng.addEventListener('mousedown', (e) => e.stopPropagation());
        rng.addEventListener('input', () => {
            const px = clamp(parseInt(rng.value, 10) || 12, 6, 80);
            penWidth = clamp(px / 2.2, 1, 40);
            storeSet('img_mag_width', penWidth);
            val.textContent = px + 'px';
        });
        wrap.append(lab, rng);
        return wrap;
    }

    // --- Панель свойств ----------------------------------------------------
    let propsIcon = null, propsTitle = null, propsKey = null, propsBody = null;

    // Наведение на правую часть вьюпорта раскрывает свёрнутую панель.
    // Зона — правые 28px картинки; уход с неё сворачивает панель обратно,
    // если она не закреплена.
    function onPropsHoverEdge(on) {
        // Курсор ушёл из правой зоны — ручное сворачивание больше не нужно.
        if (!on) propsLock = false;
        if (propsPinned || propsLock) { on = false; }
        // Курсор на самой панели — тоже «в зоне»: иначе она схлопнется
        // в момент, когда пользователь тянется к ползунку.
        if (!on && propsEl && !propsEl.classList.contains('is-folded')) {
            try {
                if (propsEl.matches(':hover')) on = true;
            } catch (e) { /* ignore */ }
        }
        if (propsHover === on) return;   // дешёвый выход: на каждый mousemove
        propsHover = on;
        if (!propsEl) return;
        // Только класс, без applyUiCfg(): тот перестраивает рейку, а это
        // на каждое движение мыши слишком дорого.
        const eff = propsPinned ? false : (propsFolded && !propsHover);
        propsEl.classList.toggle('is-folded', !!eff);
        if (viewEl) { viewRect = null; fitCanvas(); invalidate(); }
    }

    function buildProps() {
        const props = document.createElement('div');
        props.className = 'imv-props';

        const head = document.createElement('div');
        head.className = 'imv-propshead';
        propsIcon = makeIcon(ICONS.move);
        propsTitle = document.createElement('span');
        propsTitle.className = 'imv-propstitle';
        propsTitle.textContent = 'Перемещение';
        propsKey = document.createElement('kbd');
        propsKey.textContent = 'V';
        head.append(propsIcon, propsTitle, propsKey);

        propsBody = document.createElement('div');
        propsBody.className = 'imv-propsbody';

        const foot = document.createElement('div');
        foot.className = 'imv-propsfoot';
        const fold = document.createElement('button');
        fold.type = 'button';
        fold.className = 'imv-fold';
        fold.title = 'Свернуть или развернуть панель свойств';
        fold.setAttribute('aria-label', 'Свернуть панель свойств');
        const chev = makeIcon(ICONS.chevron || ICONS.close);
        const foldTxt = document.createElement('span');
        foldTxt.textContent = 'Свернуть';
        fold.append(chev, foldTxt);
        fold.addEventListener('mousedown', (e) => e.stopPropagation());
        fold.addEventListener('click', (e) => {
            e.stopPropagation();
            const eff = propsPinned ? false : (propsFolded && !propsHover);
            if (eff) {
                // Развернуть: снимаем и ручную блокировку, и закрепление.
                propsFolded = false;
                propsLock = false;
                applyUiCfg();
            } else {
                // Свернуть. Если панель закреплена — заодно отпускаем её,
                // иначе закрепление отменяло бы сворачивание и кнопка
                // выглядела бы «мёртвой».
                propsFolded = true;
                propsLock = true;
                propsHover = false;
                if (propsPinned) {
                    propsPinned = false;
                    storeSet('img_mag_propspin', '0');
                    const pinBtn = propsEl && propsEl.querySelector('.imv-propspin');
                    if (pinBtn) {
                        pinBtn.setAttribute('aria-pressed', 'false');
                        pinBtn.classList.remove('is-on');
                        pinBtn.title = 'Держать панель раскрытой';
                    }
                }
                applyUiCfg();
            }
            if (viewEl) { viewRect = null; fitCanvas(); invalidate(); }
        });
        foot.appendChild(fold);

        // Закрепить: панель всегда раскрыта и не прячется при уходе курсора.
        const pin = document.createElement('button');
        pin.type = 'button';
        pin.className = 'imv-fold imv-propspin';
        pin.setAttribute('aria-pressed', String(propsPinned));
        pin.title = 'Держать панель раскрытой';
        pin.setAttribute('aria-label', 'Держать панель свойств раскрытой');
        const pinTxt = document.createElement('span');
        pinTxt.textContent = 'Закрепить панель';
        pin.append(pinTxt);
        pin.addEventListener('mousedown', (e) => e.stopPropagation());
        pin.addEventListener('click', (e) => {
            e.stopPropagation();
            propsPinned = !propsPinned;
            storeSet('img_mag_propspin', propsPinned ? '1' : '0');
            // При закреплении сразу раскрываем; при откреплении возвращаем
            // поведение «свёрнута, пока курсор не в правой зоне».
            propsFolded = !propsPinned;
            propsLock = false;
            pin.setAttribute('aria-pressed', String(propsPinned));
            pin.classList.toggle('is-on', propsPinned);
            pin.title = propsPinned ? 'Панель закреплена — нажмите, чтобы отпустить' : 'Держать панель раскрытой';
            applyUiCfg();
            if (viewEl) { viewRect = null; fitCanvas(); invalidate(); }
        });
        foot.appendChild(pin);

        props.append(head, propsBody, foot);
        return props;
    }

    function renderPropsPanel() {
        if (!propsBody || !propsTitle || !propsIcon) return;
        hsvRefs = null;
        while (propsBody.firstChild) propsBody.removeChild(propsBody.firstChild);

        const def = toolDefById(currentTool);
        propsTitle.textContent = def.label;
        propsKey.textContent = def.key;
        const nextIcon = makeIcon(ICONS[currentTool] || ICONS.move);
        if (propsIcon.parentNode) propsIcon.parentNode.replaceChild(nextIcon, propsIcon);
        propsIcon = nextIcon;

        if (currentTool === 'move') {
            const h = document.createElement('div');
            h.className = 'imv-hint';
            h.textContent = 'Тяните картинку, чтобы сдвинуть кадр. Колесо мыши приближает к курсору.';
            propsBody.appendChild(h);
        } else if (currentTool === 'eraser') {
            propsBody.appendChild(radiusBlock());
            const h = document.createElement('div');
            h.className = 'imv-hint';
            h.textContent = 'Ластик удаляет пометки, а не пиксели снимка. Отменяется через Ctrl+Z.';
            propsBody.appendChild(h);
        } else {
            propsBody.appendChild(hsvBlock());
            propsBody.appendChild(thicknessBlock());
            if (currentTool === 'text') propsBody.appendChild(textSizeBlock());
            if (currentTool === 'rect' || currentTool === 'circle') propsBody.appendChild(fillBlock());
            const h = document.createElement('div');
            h.className = 'imv-hint';
            h.textContent = def.hint;
            propsBody.appendChild(h);
        }
        syncColorUi();
    }

    // --- Строка состояния -------------------------------------------------
    let sbTool = null, sbHint = null, sbCount = null, sbZoom = null;

    function buildStatusBar() {
        const bar = document.createElement('div');
        bar.className = 'imv-status';
        sbTool = document.createElement('span');
        sbTool.className = 'imv-stool';
        sbTool.textContent = 'Перемещение';
        const dot = document.createElement('span');
        dot.className = 'imv-sdot';
        sbHint = document.createElement('span');
        sbHint.className = 'imv-shint';
        sbHint.textContent = 'Тяните картинку или колесо для зума';
        const right = document.createElement('span');
        right.className = 'imv-sright';
        sbCount = document.createElement('span');
        sbCount.textContent = 'пометок нет';
        sbZoom = document.createElement('span');
        sbZoom.textContent = '100%';
        right.append(sbCount, sbZoom);
        bar.append(sbTool, dot, sbHint, right);
        return bar;
    }

    function pluralMarks(n) {
        const a = Math.abs(n) % 100, b = a % 10;
        if (a > 10 && a < 20) return n + ' пометок';
        if (b === 1) return n + ' пометка';
        if (b >= 2 && b <= 4) return n + ' пометки';
        return n + ' пометок';
    }

    function syncStatus() {
        const def = toolDefById(currentTool);
        if (sbTool) sbTool.textContent = def.label;
        // Временная подсказка (рамка выделения, четыре угла) важнее
        // подсказки инструмента; снимается передачей null.
        if (sbHint) sbHint.textContent = hintOverride || def.hint;
        if (sbCount) sbCount.textContent = annotations.length ? pluralMarks(annotations.length) : 'пометок нет';
        if (sbZoom) sbZoom.textContent = Math.round(scale * 100) + '%';
    }

    let hintOverride = null;
    function showHint(text) {
        hintOverride = text;
        if (sbHint) sbHint.textContent = text || toolDefById(currentTool).hint;
    }

    // --- Применение настроек видимости ------------------------------------
    function applyUiCfg() {
        const cfg = loadUiCfg();
        if (railEl) {
            railEl.hidden = !cfg.groups.rail;
            buildRail();
        }
        if (propsEl) {
            propsEl.hidden = !cfg.groups.props;
            const eff = propsPinned ? false : (propsFolded && !propsHover);
            propsEl.classList.toggle('is-folded', !!eff);
            const fold = propsEl.querySelector('.imv-fold');
            if (fold) {
                const sp = fold.querySelector('span');
                if (sp) sp.textContent = eff ? 'Развернуть' : 'Свернуть';
                fold.setAttribute('aria-label', eff ? 'Развернуть панель свойств' : 'Свернуть панель свойств');
            }
        }
        if (statusBarEl) statusBarEl.hidden = !cfg.groups.statusbar;
        if (viewW) { viewRect = null; fitCanvas(); invalidate(); }
        if (settingsEl) refreshUiSettings();
    }

    // --- Настройки интерфейса ---------------------------------------------
    // Одноразовость попытки CORS-копии для палитры (защита от рекурсии).
    let paletteCorsTried = false;

    // Доступны ли пиксели у конкретной картинки. 1×1 холст, поэтому дёшево.
    function corsPixelsOk(img) {
        if (!img) return false;
        try {
            const c = document.createElement('canvas');
            c.width = 1;
            c.height = 1;
            const x = c.getContext('2d');
            x.drawImage(img, 0, 0, 1, 1);
            x.getImageData(0, 0, 1, 1);
            return true;
        } catch (e) {
            return false;
        }
    }

    let settingsEl = null, settingsRefs = null;

    function uiSwitchRow(label, hint, on, onChange) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'imv-swrow';
        b.setAttribute('role', 'switch');
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        const lab = document.createElement('span');
        lab.className = 'imv-swlabel';
        lab.textContent = label;
        if (hint) {
            const em = document.createElement('em');
            em.textContent = hint;
            lab.appendChild(em);
        }
        const sw = document.createElement('span');
        sw.className = 'imv-switch';
        b.append(lab, sw);
        b.addEventListener('mousedown', (e) => e.stopPropagation());
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            const next = b.getAttribute('aria-checked') !== 'true';
            b.setAttribute('aria-checked', next ? 'true' : 'false');
            onChange(next);
        });
        return b;
    }

    function openUiSettings(anchorBtn) {
        closeMenu();
        const cfg = loadUiCfg();
        const panel = document.createElement('div');
        Object.assign(panel.style, {
            position: 'absolute', zIndex: '9', width: '322px',
            maxWidth: 'calc(100% - 12px)', maxHeight: 'min(560px, calc(100% - 12px))',
            overflow: 'auto', background: '#2b2b2b', color: '#eee', borderRadius: '8px',
            boxShadow: '0 10px 28px rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.12)',
            padding: '4px 0 8px', boxSizing: 'border-box', font: '12.5px/1.4 sans-serif',
        });
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Настройки интерфейса');
        panel.addEventListener('mousedown', (e) => e.stopPropagation());
        panel.addEventListener('click', (e) => e.stopPropagation());

        settingsEl = panel;
        settingsRefs = { presetBtns: [], rows: [] };

        const section = (title) => {
            const s = document.createElement('div');
            s.className = 'imv-sec';
            s.textContent = title;
            panel.appendChild(s);
        };

        section('Наборы');
        const presets = document.createElement('div');
        presets.className = 'imv-presets';
        UI_PRESETS.forEach((p) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'imv-preset' + (cfg.preset === p.id ? ' is-on' : '');
            b.textContent = p.label;
            b.addEventListener('mousedown', (e) => e.stopPropagation());
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                const c = loadUiCfg();
                const d = defaultUi();
                if (p.id === 'full') {
                    c.cats = d.cats; c.tools = d.tools; c.acts = d.acts; c.groups = d.groups;
                } else if (p.id === 'view') {
                    for (const k in c.cats) c.cats[k] = false;
                    for (const k in c.tools) c.tools[k] = false;
                    for (const k in c.acts) c.acts[k] = false;
                    c.groups.rail = false; c.groups.props = false;
                } else if (p.id === 'draw') {
                    c.cats.recognize = false; c.cats.file = false;
                    c.groups.attrs = true;
                }
                c.preset = p.id;
                saveUiCfg();
                applyUiCfg();
            });
            settingsRefs.presetBtns.push({ id: p.id, btn: b });
            presets.appendChild(b);
        });
        panel.appendChild(presets);

        const resetWrap = document.createElement('div');
        resetWrap.style.cssText = 'padding:0 7px 6px;';
        const reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'imv-preset';
        reset.style.width = '100%';
        reset.textContent = 'Сбросить к полному набору';
        reset.addEventListener('mousedown', (e) => e.stopPropagation());
        reset.addEventListener('click', (e) => {
            e.stopPropagation();
            uiCfg = defaultUi();
            saveUiCfg();
            applyUiCfg();
            toast('Интерфейс сброшен');
        });
        resetWrap.appendChild(reset);
        panel.appendChild(resetWrap);

        const addToggle = (label, hint, on, kind, id) => {
            const row = uiSwitchRow(label, hint, on, (next) => {
                const c = loadUiCfg();
                if (kind === 'cat') c.cats[id] = next;
                else if (kind === 'tool') c.tools[id] = next;
                else if (kind === 'act') c.acts[id] = next;
                else c.groups[id] = next;
                c.preset = 'custom';
                saveUiCfg();
                applyUiCfg();
            });
            panel.appendChild(row);
            settingsRefs.rows.push({ kind: kind, id: id, btn: row });
        };

        section('Категории рейки');
        RAIL_CATS.forEach((c) => addToggle(c.label, c.hint, cfg.cats[c.id], 'cat', c.id));

        section('Инструменты рисования');
        ['move', 'pen', 'line', 'arrow', 'rect', 'circle', 'text', 'eraser'].forEach((id) => {
            const def = toolDefById(id);
            addToggle(def.label, def.hint, cfg.tools[id], 'tool', id);
        });

        section('Кнопки действий');
        RAIL_ACTS.forEach((a) => {
            addToggle(a.label, catLabel(a.cat) + ' · ' + a.hint, cfg.acts[a.id], 'act', a.id);
        });

        section('Блоки интерфейса');
        UI_GROUPS.forEach((g) => addToggle(g.label, g.hint, cfg.groups[g.id], 'group', g.id));

        const note = document.createElement('div');
        note.className = 'imv-hint';
        note.style.padding = '8px 9px 2px';
        note.textContent = 'Категории в рейке можно перетаскивать за заголовок. Скрытые кнопки не занимают место.';
        panel.appendChild(note);

        win.appendChild(panel);

        // ставим под кнопкой, не выпуская за окно
        const l = clamp(anchorBtn ? (anchorBtn.offsetLeft + anchorBtn.offsetWidth - panel.offsetWidth) : 8,
            6, Math.max(6, win.clientWidth - panel.offsetWidth - 6));
        const t = (anchorBtn ? anchorBtn.offsetTop + anchorBtn.offsetHeight : 6) + 2;
        panel.style.left = Math.round(l) + 'px';
        panel.style.top = Math.round(Math.max(6, t)) + 'px';
        panel.style.maxHeight = Math.max(120, win.clientHeight - t - 10) + 'px';

        menuEl = panel;
        menuAnchorBtn = anchorBtn;
        if (anchorBtn) {
            anchorBtn.dataset.open = '1';
            setBtnActive(anchorBtn, true);
            anchorBtn.setAttribute('aria-expanded', 'true');
        }
        settingsEl = panel;
        return panel;
    }

    function refreshUiSettings() {
        if (!settingsEl || !settingsRefs) return;
        const cfg = loadUiCfg();
        settingsRefs.rows.forEach((r) => {
            let on = false;
            if (r.kind === 'cat') on = !!cfg.cats[r.id];
            else if (r.kind === 'tool') on = !!cfg.tools[r.id];
            else if (r.kind === 'act') on = !!cfg.acts[r.id];
            else on = !!cfg.groups[r.id];
            r.btn.setAttribute('aria-checked', on ? 'true' : 'false');
        });
        settingsRefs.presetBtns.forEach((p) => p.btn.classList.toggle('is-on', cfg.preset === p.id));
    }


    function openWindow(url, caption) {
        if (win) closeWindow();
        injectWinCss();

        imageUrl = url;
        canExport = null;
        corsImage = null;
        corsTried = false;
        if (hugeSource) { try { hugeSource.close && hugeSource.close(); } catch (e) {} }
        hugeSource = null;
        hugeTried = false;

        const savedW = clamp(storeNum('img_mag_w', WIN_W), Math.min(280, innerWidth - 16), Math.max(280, innerWidth - 16));
        const savedH = clamp(storeNum('img_mag_h', WIN_H), Math.min(200, innerHeight - 16), Math.max(200, innerHeight - 16));
        const savedScale = storeNum('img_mag_scale', 0);
        const savedLeft = storeNum('img_mag_left', NaN);
        const savedTop = storeNum('img_mag_top', NaN);

        const left = clamp(
            isFinite(savedLeft) ? savedLeft : (innerWidth - savedW) / 2,
            8, Math.max(8, innerWidth - savedW - 8)
        );
        const top = clamp(
            isFinite(savedTop) ? savedTop : (innerHeight - savedH) / 2,
            8, Math.max(8, innerHeight - savedH - 8)
        );

        penColor = storeGet('img_mag_color') || '#ff3b30';
        penWidth = clamp(storeNum('img_mag_width', 4), 1, 40);
        fillShapes = storeGet('img_mag_fill') === '1';
        pinned = storeGet('img_mag_pin') === '1';
        propsPinned = storeGet('img_mag_propspin') === '1';
        propsHover = false;
        propsLock = false;
        propsFolded = !propsPinned;
        ghostMode = false;
        translucent = storeGet('img_mag_translucent') === '1';
        pixelGrid = storeGet('img_mag_grid') === '1';
        exportFormat = storeGet('img_mag_format') || 'png';
        if (exportFormat !== 'png' && exportFormat !== 'jpeg' && exportFormat !== 'webp') exportFormat = 'png';
        exportQuality = clamp(storeNum('img_mag_quality', 0.92), 0.3, 1);
        readQuickColors();
        resetPerFeatureState();

        // --- контейнер окна ---
        win = document.createElement('div');
        win.id = WIN_ID;
        win.setAttribute('role', 'dialog');
        win.setAttribute('aria-label', caption || 'Image Magnifier');
        win.tabIndex = -1;
        win.className = 'imv-win';
        Object.assign(win.style, {
            position: 'fixed', zIndex: '2147483647',
            left: left + 'px', top: top + 'px',
            width: savedW + 'px', height: savedH + 'px',
            minWidth: Math.min(280, innerWidth - 8) + 'px',
            minHeight: Math.min(180, innerHeight - 8) + 'px',
            background: '#1e1e1e', borderRadius: '10px', overflow: 'hidden',
            boxShadow: '0 12px 48px rgba(0,0,0,0.65)',
            display: 'flex', flexDirection: 'column',
            resize: 'both', border: '1px solid rgba(255,255,255,0.12)',
            font: '13px/1.3 sans-serif', color: '#fff',
            outline: 'none', boxSizing: 'border-box',
        });

        // --- шапка ---
        barEl = buildHead(caption, url);


        // --- вьюпорт ---
        viewEl = document.createElement('div');
        Object.assign(viewEl.style, {
            flex: '1 1 auto', overflow: 'hidden', position: 'relative',
            background: '#0f0f0f', cursor: 'grab', touchAction: 'none',
            minHeight: '0', minWidth: '0', boxSizing: 'border-box',
        });

        imgEl = document.createElement('img');
        imgEl.alt = '';
        imgEl.draggable = false;
        Object.assign(imgEl.style, {
            display: 'none', position: 'absolute', top: '0', left: '0',
            transformOrigin: '0 0', userSelect: 'none', maxWidth: 'none', maxHeight: 'none',
        });

        // холст всегда перехватывает клики, включая ПКМ — чтобы нативное
        // "Копировать изображение" брало объединённые слои
        drawEl = document.createElement('canvas');
        Object.assign(drawEl.style, {
            position: 'absolute', top: '0', left: '0', pointerEvents: 'auto',
            touchAction: 'none', display: 'block',
        });

        statusEl = document.createElement('div');
        Object.assign(statusEl.style, {
            position: 'absolute', top: '0', left: '0', right: '0', bottom: '0',
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', gap: '10px', padding: '16px',
            color: '#bbb', font: '13px/1.5 sans-serif', textAlign: 'center',
            background: 'rgba(15,15,15,0.92)', zIndex: '4', boxSizing: 'border-box',
        });
        statusEl.textContent = 'Загрузка…';

        const center = document.createElement('div');
        center.className = 'imv-center';
        viewEl.append(imgEl, drawEl, statusEl, buildHelp());
        statusBarEl = buildStatusBar();
        center.append(viewEl, statusBarEl);

        railEl = buildRail();
        propsEl = buildProps();

        const bodyEl = document.createElement('div');
        bodyEl.className = 'imv-body';
        bodyEl.append(railEl, center, propsEl);
        win.append(barEl, bodyEl);

        // --- события ---
        viewEl.addEventListener('wheel', onWheel, { passive: false });
        viewEl.addEventListener('mousedown', onMouseDown);
        viewEl.addEventListener('dblclick', onDblClick);
        viewEl.addEventListener('contextmenu', onContextMenu);
        viewEl.addEventListener('touchstart', onTouchStart, { passive: false });
        viewEl.addEventListener('touchmove', onTouchMove, { passive: false });
        viewEl.addEventListener('touchend', onTouchEnd, { passive: false });
        viewEl.addEventListener('touchcancel', onTouchEnd, { passive: false });
        barEl.addEventListener('mousedown', onDragStart);
        // Правая зона вьюпорта: наведение раскрывает свёрнутую панель свойств.
        // Зона раскрытия — правые 84px ОКНА (свёрнутая панель + запас),
        // а не viewEl: у свёрнутой панели viewEl кончается левее, и
        // курсор до слушателя на нём просто не доходил.
        win.addEventListener('mousemove', (e) => {
            const r = win.getBoundingClientRect();
            onPropsHoverEdge(e.clientX >= r.right - 84);
        });
        win.addEventListener('mouseleave', () => onPropsHoverEdge(false));
        document.addEventListener('pointermove', onRailDragMove);
        document.addEventListener('pointerup', onRailDragUp);
        win.addEventListener('mouseenter', () => { overWin = true; });
        win.addEventListener('mouseleave', () => { overWin = false; });
        win.addEventListener('mouseover', () => { overWin = true; });

        document.addEventListener('mousemove', onMouseMove, true);
        document.addEventListener('mouseup', onMouseUp, true);
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('keyup', onKeyUp, true);
        document.addEventListener('mousedown', onOutsideClick, true);
        window.addEventListener('resize', onViewportChange);
        window.addEventListener('scroll', onPageScroll, true);

        winRO = new ResizeObserver(() => onViewportChange());
        winRO.observe(win);

        rootEl().appendChild(win);

        annotations = [];
        history = [[]];
        histIndex = 0;
        inProgress = null;
        drawing = false;
        mode = null;
        spaceDown = false;
        viewRect = null;
        viewW = viewH = 0;
        dpr = 1;
        baseValid = false;

        setTool(storeGet('img_mag_tool') || 'move', true);
        updateHistoryButtons();
        syncCompactMode();
        applyUiCfg();
        renderPropsPanel();
        syncStatus();
        fitCanvas();
        updateZoomLabel();

        // --- загрузка картинки ---
        let loadedOnce = false;
        imgEl.addEventListener('load', () => {
            if (!win) return;
            hideStatus();
            fitCanvas();
            if (!loadedOnce) {
                loadedOnce = true;
                // Всегда вписываем целиком: сохранённый масштаб с прошлой
                // сессии приводил к тому, что картинка не видна полностью
                // при первом открытии. Полосы лучше обрезки.
                fitImage();
                // Раскладка могла быть ещё не готова — повторяем кадром позже.
                requestAnimationFrame(() => { if (win) fitImage(); });
            } else {
                invalidate();
            }
            afterSourceReady();
        });
        imgEl.addEventListener('error', () => {
            if (!win) return;
            showLoadError(url);
        });
        imgEl.src = url;

        watchDpr();
        startDprPoll();
        try { win.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }

    // Сбрасываем всё, что относится к конкретной картинке/сессии.
    function resetPerFeatureState() {
        perspCanvas = null;
        perspCorners = [];
        perspPicking = false;
        perspBusy = false;
        erasing = false;
        eraseMoved = 0;
        scanRect = null;
        scanPick = false;
        selShape = null;
        dragShape = null;
        lastShape = null;
        imagePalette = [];
        paletteCorsTried = false;
        pyramid = null;
        pyramidLevel = 0;
        menuEl = null;
        menuAnchorBtn = null;
        liveEl = null;
        clearBaseCache();
    }

    // --- Оверлей справки ---------------------------------------------------
    function buildHelp() {
        helpEl = document.createElement('div');
        Object.assign(helpEl.style, {
            position: 'absolute', top: '0', left: '0', right: '0', bottom: '0',
            background: 'rgba(15,15,15,0.96)', color: '#e8e8e8',
            padding: '12px 16px', overflow: 'auto', display: 'none',
            zIndex: '6', font: '12.5px/1.55 sans-serif', boxSizing: 'border-box',
        });

        const head = document.createElement('div');
        head.textContent = 'Горячие клавиши';
        Object.assign(head.style, { fontWeight: '600', marginBottom: '8px', fontSize: '13px' });
        helpEl.appendChild(head);

        const rows = [
            ['Колесо', 'Зум к курсору'],
            ['Стрелки', 'Панорама (Shift — крупнее)'],
            ['+ / −', 'Приблизить / отдалить'],
            ['Ctrl+0', 'Масштаб 100%'],
            ['Ctrl+1', 'Вписать в окно'],
            ['Пробел', 'Панорама (удерживать)'],
            ['СКМ', 'Панорама'],
            ['1 … 7', 'Инструменты'],
            ['X', 'Ластик (стирает фигуры)'],
            ['Ctrl+Z', 'Отменить'],
            ['Ctrl+Shift+Z', 'Повторить'],
            ['Shift', 'Квадрат / круг / 45°'],
            ['Alt + тащить', 'Дублировать фигуру'],
            ['Ctrl + тащить', 'Копия фигуры'],
            ['2× клик', 'Выбрать и править фигуру'],
            ['Delete', 'Удалить выбранную'],
            ['Ctrl+C', 'Копировать изображение'],
            ['Ctrl+S', 'Сохранить (формат в «Экспорт»)'],
            ['Shift+P', 'Закрепить окно'],
            ['G', 'Сетка пикселей (от 800%)'],
            ['Tab / Enter', 'Обход кнопок / нажать'],
            ['C', 'Цвет рисования'],
            ['?', 'Эта справка'],
            ['Esc', 'Снять выделение / закрыть']
        ];

        for (let i = 0; i < rows.length; i++) {
            const row = document.createElement('div');
            Object.assign(row.style, { display: 'flex', gap: '10px', alignItems: 'baseline' });

            const k = document.createElement('span');
            k.textContent = rows[i][0];
            Object.assign(k.style, {
                flex: '0 0 118px', color: '#9ecbff', fontFamily: 'ui-monospace, monospace',
                fontSize: '11.5px',
            });

            const v = document.createElement('span');
            v.textContent = rows[i][1];
            Object.assign(v.style, { flex: '1 1 auto' });

            row.append(k, v);
            helpEl.appendChild(row);
        }

        const hint = document.createElement('div');
        hint.textContent = 'Нажмите ? или Esc, чтобы закрыть справку';
        Object.assign(hint.style, { marginTop: '10px', opacity: '0.55', fontSize: '11.5px' });
        helpEl.appendChild(hint);

        helpEl.addEventListener('mousedown', (e) => e.stopPropagation());
        helpEl.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
        return helpEl;
    }

    function toggleHelp(force) {
        if (!helpEl) return;
        const show = (force === undefined) ? helpEl.style.display === 'none' : !!force;
        helpEl.style.display = show ? 'block' : 'none';
    }

    function helpVisible() {
        return !!(helpEl && helpEl.style.display !== 'none');
    }

    // --- Статус загрузки ---------------------------------------------------
    function hideStatus() {
        if (statusEl && statusEl.parentNode) statusEl.parentNode.removeChild(statusEl);
        statusEl = null;
    }

    function showLoadError(url) {
        if (!statusEl) return;
        statusEl.textContent = '';
        const msg = document.createElement('div');
        msg.textContent = 'Не удалось загрузить изображение';
        Object.assign(msg.style, { color: '#ff8b80', fontWeight: '600' });

        const sub = document.createElement('div');
        sub.textContent = 'Возможно, сайт запрещает хотлинк или требует авторизацию.';
        sub.style.opacity = '0.7';

        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Открыть в новой вкладке';
        Object.assign(link.style, {
            color: '#6cb6ff', textDecoration: 'underline', cursor: 'pointer',
        });

        statusEl.append(msg, sub, link);
    }

    // --- Отрисовка --------------------------------------------------------
    function fitCanvas() {
        if (!drawEl || !viewEl) return false;
        const vw = viewEl.clientWidth;
        const vh = viewEl.clientHeight;
        if (!vw || !vh) return false;

        const nd = clamp(window.devicePixelRatio || 1, 1, DPR_MAX);
        const pw = Math.max(1, Math.round(vw * nd));
        const ph = Math.max(1, Math.round(vh * nd));

        if (nd !== dpr || vw !== viewW || vh !== viewH) { baseValid = false; clearBaseCache(); }
        dpr = nd;
        viewW = vw;
        viewH = vh;

        if (drawEl.width !== pw || drawEl.height !== ph) {
            drawEl.width = pw;
            drawEl.height = ph;
        }
        drawEl.style.width = vw + 'px';
        drawEl.style.height = vh + 'px';

        if (!baseCanvas) {
            baseCanvas = document.createElement('canvas');
            baseCtx = baseCanvas.getContext('2d');
        }
        if (baseCanvas.width !== pw || baseCanvas.height !== ph) {
            baseCanvas.width = pw;
            baseCanvas.height = ph;
            baseValid = false;
        }
        return true;
    }

    // --- Подготовка очень больших снимков ---------------------------------
    // Сжать 8000×6000 в окно 640 px — это ~48 Мпикс пересчёта на главном
    // потоке. Замерено: 346 мс одной длинной задачей при открытии окна, из-за
    // которых вкладка «замирает». createImageBitmap с resize выполняет ту же
    // работу в фоновом потоке, после чего кадры работают с копией ≤4096 px.
    let hugeSource = null;
    let hugeTried = false;

    // Уменьшает источник полосами. Каждый drawImage трогает только часть
    // исходника, поэтому главный поток не блокируется надолго.
    // onDone(canvas) вызывается один раз в конце; onFail() — при ошибке.
    function bandDownscale(src, sw, sh, tw, th, onDone, onFail) {
        let cv;
        try {
            cv = document.createElement('canvas');
            cv.width = tw;
            cv.height = th;
        } catch (e) { if (onFail) onFail(); return; }
        const cx = cv.getContext('2d');
        if (!cx) { if (onFail) onFail(); return; }
        if (cx.imageSmoothingQuality) cx.imageSmoothingQuality = 'low';
        const kx = tw / sw;
        const ky = th / sh;
        const bandSrc = Math.max(64, Math.min(sh, Math.floor(HUGE_BAND_PIXELS / Math.max(1, sw))));
        let sy = 0;
        const step = () => {
            if (sy >= sh) { onDone(cv); return; }
            const h = Math.min(bandSrc, sh - sy);
            try {
                cx.drawImage(src, 0, sy, sw, h,
                             0, Math.round(sy * ky), tw, Math.max(1, Math.round(h * ky)));
            } catch (e) { if (onFail) onFail(); return; }
            sy += h;
            if (typeof requestIdleCallback === 'function') {
                requestIdleCallback(step, { timeout: 400 });
            } else {
                setTimeout(step, 16);
            }
        };
        step();
    }

    // Тяжёлые шаги после загрузки картинки идут в таком порядке:
    // 1) уменьшенная копия для огромных снимков (полосами, в простое),
    // 2) проверка «отравленности» canvas — уже на копии, а не на исходнике,
    // 3) пирамида и палитра.
    // Раньше проверка шла первой и одна стоила ~360 мс блокировки.
    function afterSourceReady() {
        const iw = imageW(), ih = imageH();
        const huge = iw && ih && iw * ih > HUGE_PIXELS && imgEl && imgEl.naturalWidth;
        if (!huge) {
            checkExportable();
            buildPyramid();
            buildImagePalette();
            return;
        }
        prepareHugeSource();
        // prepareHugeSource выставит hugeSource и сам попросит перерисовку;
        // ждём его в простое, не блокируя открытие окна.
        const wait = (tries) => {
            if (!win) return;
            if (hugeSource) {
                checkExportable();
                buildPyramid();
                buildImagePalette();
                return;
            }
            if (tries <= 0) {
                // копия не получилась — работаем как раньше
                checkExportable();
                buildPyramid();
                buildImagePalette();
                return;
            }
            if (typeof requestIdleCallback === 'function') {
                requestIdleCallback(() => wait(tries - 1), { timeout: 600 });
            } else {
                setTimeout(() => wait(tries - 1), 40);
            }
        };
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(() => wait(200), { timeout: 600 });
        } else {
            setTimeout(() => wait(200), 40);
        }
    }

    function prepareHugeSource() {
        if (hugeTried || hugeSource) return;
        const iw = imageW(), ih = imageH();
        if (!iw || !ih || iw * ih <= HUGE_PIXELS) return;
        if (!imgEl || !imgEl.naturalWidth) return;
        hugeTried = true;
        const k = Math.min(1, HUGE_MAX_SIDE / Math.max(iw, ih));
        if (k >= 1) return;
        const rw = Math.max(1, Math.round(iw * k));
        const rh = Math.max(1, Math.round(ih * k));

        // Один drawImage всего снимка — это одна длинная задача (замерено
        // ~520 мс на 48 Мпикс) и вкладка на это время замирает. Поэтому
        // режем на полосы и рисуем их по одной в простое.
        bandDownscale(imgEl, iw, ih, rw, rh, (cv) => {
            if (!win) return;
            hugeSource = cv;
            baseValid = false;
            clearBaseCache();
            requestDraw();
        }, null);
    }

    // --- 6.1 Пирамида уровней (mipmap) -------------------------------------
    // Предварительно строим 1/2, 1/4, 1/8. При уменьшении картинки рисуем
    // мелкий уровень вместо гигантского исходника — это дешевле и плавнее.
    function buildPyramid() {
        pyramid = null;
        pyramidLevel = 0;
        const iw = imageW(), ih = imageH();
        if (!iw || !ih || iw * ih < 1200 * 1200) return; // смысл есть только на больших
        // Очень большие снимки не уменьшаем заранее: кадр и так рисует только
        // видимую область, а три полноразмерных canvas на 8000×6000 — это
        // ~100 МБ памяти и сотни миллисекунд блокировки вкладки.
        if (iw * ih > PYRAMID_MAX_SOURCE) return;
        // Пирамида нужна только для уменьшения, поэтому берём уровень под
        // минимальный реальный масштаб, а не «все три всегда»: каждый уровень
        // это полноразмерный canvas (для 8000×6000 три уровня — ~100 МБ).
        const levels = [];
        let w = iw, h = ih;
        for (let i = 0; i < PYRAMID_MAX_LEVELS; i++) {
            w = Math.max(1, Math.round(w / 2));
            h = Math.max(1, Math.round(h / 2));
            if (w < 32 || h < 32) break;
            levels.push({ w: w, h: h, canvas: null });
        }
        // Считаем суммарный бюджет честно, от первого уровня к последнему.
        const kept = [];
        let used = 0;
        for (let i = 0; i < levels.length; i++) {
            const px = levels[i].w * levels[i].h;
            if (used + px > PYRAMID_MAX_PIXELS) break;
            used += px;
            kept.push(levels[i]);
        }
        levels.length = 0;
        for (let i = 0; i < kept.length; i++) levels.push(kept[i]);
        if (!levels.length) return;
        pyramid = levels;

        const src = sourceEl();
        let idx = 0;
        const step = () => {
            if (!win || !pyramid) return;
            if (idx >= levels.length) return;
            const lv = levels[idx++];
            const done = () => { if (win && pyramid) step(); };
            try {
                const cv = document.createElement('canvas');
                cv.width = lv.w;
                cv.height = lv.h;
                const cx = cv.getContext('2d');
                if (!cx) { done(); return; }
                cx.imageSmoothingEnabled = true;
                // 'high' на многомегапиксельном источнике блокирует поток на
                // сотни миллисекунд; для уровня-превью хватает 'low'.
                if (cx.imageSmoothingQuality) cx.imageSmoothingQuality = 'low';
                cx.drawImage(src, 0, 0, lv.w, lv.h);
                lv.canvas = cv;
            } catch (e) { /* taint и прочее — просто без уровня */ }
            done();
        };
        // Строим в простое, по одному уровню: даже один уровень на большом
        // снимке — это заметная работа, и делать её во время первого кадра нельзя.
        const idle = (fn) => {
            if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 1500 });
            else setTimeout(fn, 120);
        };
        const kick = () => { if (win && pyramid) idle(step); };
        setTimeout(kick, 80);
    }

    // Какой уровень рисовать при текущем масштабе.
    function pyramidFor(sc) {
        if (!pyramid) return null;
        // эффективное уменьшение: если sc < 1, часть деталей не видна
        let k = 0;
        if (sc < 0.5) k = 3;
        else if (sc < 0.25) k = 4;
        else if (sc < 0.125) k = 5;
        else return null;
        const lv = pyramid[Math.min(pyramid.length, k) - 1];
        if (!lv || !lv.canvas) return null;
        return lv;
    }

    // --- 6.2 Кэш «тёплых» состояний ---------------------------------------
    function cacheKey() {
        return [
            Math.round(scale * 10000), Math.round(tx * 2), Math.round(ty * 2),
            baseRev, baseCanvas ? baseCanvas.width : 0, baseCanvas ? baseCanvas.height : 0,
        ].join(':');
    }

    function clearBaseCache() {
        for (let i = 0; i < baseCache.length; i++) {
            const e = baseCache[i];
            if (e.canvas) { e.canvas.width = 0; e.canvas.height = 0; }
        }
        baseCache.length = 0;
    }

    function cacheBudgetUsed() {
        let n = 0;
        for (let i = 0; i < baseCache.length; i++) {
            const c = baseCache[i].canvas;
            n += c.width * c.height * 4;
        }
        return n;
    }

    function cacheGet(key) {
        for (let i = 0; i < baseCache.length; i++) {
            if (baseCache[i].key === key) {
                const e = baseCache.splice(i, 1)[0];
                baseCache.unshift(e);   // LRU: трогаем при обращении
                e.used = Date.now();
                return e.canvas;
            }
        }
        return null;
    }

    function cachePut(key, src) {
        if (!src || !win) return;
        const bytes = src.width * src.height * 4;
        if (bytes > CACHE_MAX_BYTES * 0.6) return; // один кадр уже великоват
        let cv;
        try {
            cv = document.createElement('canvas');
            cv.width = src.width;
            cv.height = src.height;
            const c = cv.getContext('2d');
            if (!c) return;
            c.drawImage(src, 0, 0);
        } catch (e) { return; }

        baseCache.unshift({ key: key, canvas: cv, used: Date.now() });
        while (baseCache.length > CACHE_MAX_ENTRIES || cacheBudgetUsed() > CACHE_MAX_BYTES) {
            const dropped = baseCache.pop();
            if (dropped && dropped.canvas) {
                dropped.canvas.width = 0;
                dropped.canvas.height = 0;
            }
            if (!baseCache.length) break;
        }
    }

    // Пересобираем кэш: картинка + подтверждённые аннотации при текущем
    // масштабе. Делается только при смене зума/панорамы/аннотаций, а не на
    // каждый mousemove.
    function rebuildBase() {
        if (!baseCanvas || !baseCtx) return;
        const key = cacheKey();
        const warm = baseValid ? null : cacheGet(key);
        const c = baseCtx;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, baseCanvas.width, baseCanvas.height);

        if (warm) {
            try { c.drawImage(warm, 0, 0); } catch (e) { /* ignore */ }
            baseValid = true;
            return;
        }

        c.setTransform(dpr, 0, 0, dpr, 0, 0);

        const iw = imageW(), ih = imageH();
        if (iw && ih && scale > 0) {
            // при сильном увеличении показываем пиксели без сглаживания
            c.imageSmoothingEnabled = scale < 3;
            // 'high' на каждый кадр зума — лишние десятки миллисекунд.
            if (c.imageSmoothingQuality) c.imageSmoothingQuality = 'medium';
            const src = sourceEl();
            const lv = pyramidFor(scale);
            const useSrc = lv ? lv.canvas : src;
            // Огромный снимок нельзя масштабировать на главном потоке ни разу:
            // даже один кадр 8000×6000 → 640 px блокирует вкладку на ~0.5 с.
            // Пока фоновая копия не готова, кадр остаётся пустым — копия
            // приходит за десятки миллисекунд и сама просит перерисовку.
            if (!lv && !perspCanvas && !hugeSource && iw * ih > HUGE_PIXELS) { /* ждём копию */ }
            else {
            const useW = lv ? lv.w : iw;
            const useH = lv ? lv.h : ih;
            // Отрисовка ТОЛЬКО видимой области. Раньше кадр рисовал картинку
            // целиком (drawImage на всю iw*scale × ih*scale): на фото
            // 8000×6000 это давало кадр в 323 мс и подвисание вкладки.
            // Сейчас размер работы зависит от площади окна, а не картинки.
            let ix0 = Math.max(0, Math.floor((0 - tx) / scale));
            let iy0 = Math.max(0, Math.floor((0 - ty) / scale));
            let ix1 = Math.min(iw, Math.ceil((viewW - tx) / scale));
            let iy1 = Math.min(ih, Math.ceil((viewH - ty) / scale));
            if (ix1 > ix0 && iy1 > iy0) {
                // запас в 2 пикселя: сглаживание не даёт шва на границе
                ix0 = Math.max(0, ix0 - 2);
                iy0 = Math.max(0, iy0 - 2);
                ix1 = Math.min(iw, ix1 + 2);
                iy1 = Math.min(ih, iy1 + 2);
                if (useSrc) {
                    const kx = useW / iw, ky = useH / ih;
                    try {
                        c.drawImage(
                            useSrc,
                            ix0 * kx, iy0 * ky, (ix1 - ix0) * kx, (iy1 - iy0) * ky,
                            tx + ix0 * scale, ty + iy0 * scale,
                            (ix1 - ix0) * scale, (iy1 - iy0) * scale
                        );
                    } catch (e) { /* taint и прочее — кадр просто без картинки */ }
                }
            }
            if (pixelGrid) drawPixelGrid(c, iw, ih);
            }
        }
        for (let i = 0; i < annotations.length; i++) {
            drawShape(c, annotations[i], scale, tx, ty);
        }
        if (selShape) drawSelection(c, selShape);
        baseValid = true;

        // запоминаем «тёплый» кадр (без подсветки выделения — её рисуем сверху)
        if (!selShape) cachePut(key, baseCanvas);
    }

    // 9.3 Сетка пикселей при увеличении ≥ 800%
    function drawPixelGrid(c, iw, ih) {
        if (scale < PIXEL_GRID_FROM) return;
        const x0 = Math.max(0, Math.floor((0 - tx) / scale));
        const y0 = Math.max(0, Math.floor((0 - ty) / scale));
        const x1 = Math.min(iw, Math.ceil((viewW - tx) / scale));
        const y1 = Math.min(ih, Math.ceil((viewH - ty) / scale));
        if (x1 <= x0 || y1 <= y0) return;
        // не рисуем десятки тысяч линий
        if ((x1 - x0) > 900 || (y1 - y0) > 900) return;

        c.save();
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.lineWidth = 1;
        c.strokeStyle = 'rgba(120,190,255,0.45)';
        c.beginPath();
        for (let x = x0; x <= x1; x++) {
            const sx = Math.round(x * scale + tx) + 0.5;
            c.moveTo(sx, Math.round(y0 * scale + ty));
            c.lineTo(sx, Math.round(y1 * scale + ty));
        }
        for (let y = y0; y <= y1; y++) {
            const sy = Math.round(y * scale + ty) + 0.5;
            c.moveTo(Math.round(x0 * scale + tx), sy);
            c.lineTo(Math.round(x1 * scale + tx), sy);
        }
        c.stroke();

        // координаты: подписываем каждые 5 пикселей (или каждый, если их мало)
        const stepPx = scale >= 16 ? 1 : (scale >= 12 ? 2 : 5);
        c.font = '9px ui-monospace, monospace';
        c.fillStyle = 'rgba(160,215,255,0.85)';
        c.textBaseline = 'top';
        for (let x = x0; x <= x1; x += stepPx) {
            const sx = x * scale + tx;
            if (sx < 10 || sx > viewW - 4) continue;
            c.fillText(String(x), sx + 1, 2);
        }
        for (let y = y0; y <= y1; y += stepPx) {
            const sy = y * scale + ty;
            if (sy < 10 || sy > viewH - 4) continue;
            c.fillText(String(y), 2, sy + 1);
        }
        c.restore();
    }

    function drawSelection(c, shape) {
        const b = shapeBounds(shape);
        if (!b) return;
        c.save();
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        const x = b.x1 * scale + tx, y = b.y1 * scale + ty;
        const w = (b.x2 - b.x1) * scale, h = (b.y2 - b.y1) * scale;
        c.strokeStyle = '#4da3ff';
        c.lineWidth = 1.5;
        c.setLineDash([5, 4]);
        c.strokeRect(x - 3, y - 3, w + 6, h + 6);
        c.setLineDash([]);
        c.restore();
    }

    function redraw() {
        if (!drawEl || !baseCanvas) return;
        if (!viewW || !viewH) {
            if (!fitCanvas()) return;
        }
        if (!baseValid) rebuildBase();

        const c = drawEl.getContext('2d');
        if (!c) return;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, drawEl.width, drawEl.height);
        if (baseCanvas.width && baseCanvas.height) c.drawImage(baseCanvas, 0, 0);

        if (inProgress || scanRect || perspPicking) {
            c.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        if (inProgress) drawShape(c, inProgress, scale, tx, ty);
        if (scanRect) drawScanRect(c);
        if (perspPicking) drawPerspPicking(c);
    }

    function requestDraw() {
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
            rafId = 0;
            redraw();
        });
    }

    function invalidate() {
        baseValid = false;
        requestDraw();
    }

    function drawShape(ctx, s, sc, dx, dy) {
        const X = (v) => v * sc + dx;
        const Y = (v) => v * sc + dy;

        ctx.globalAlpha = 1;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = s.color;
        ctx.fillStyle = s.color;
        ctx.lineWidth = Math.max(0.6, s.width * sc);

        if (s.type === 'pen') {
            const pts = s.points;
            if (!pts || !pts.length) return;
            if (pts.length === 1) {
                ctx.beginPath();
                ctx.arc(X(pts[0].x), Y(pts[0].y), Math.max(0.5, ctx.lineWidth / 2), 0, Math.PI * 2);
                ctx.fill();
                return;
            }
            ctx.beginPath();
            ctx.moveTo(X(pts[0].x), Y(pts[0].y));
            for (let i = 1; i < pts.length; i++) ctx.lineTo(X(pts[i].x), Y(pts[i].y));
            ctx.stroke();
            return;
        }

        if (s.type === 'text') {
            const fs = Math.max(1, s.size * sc);
            // line-height хранится в координатах картинки (s.lh), поэтому
            // межстрочные интервалы совпадают с редактором при любом зуме.
            // Важно: НЕ пересчитываем его из s.size — иначе накопятся
            // разные округления и текст «уплывёт» вниз на несколько px.
            const lh = (s.lh ? s.lh * sc : fs * 1.25);
            ctx.font = '600 ' + fs + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
            ctx.textBaseline = 'top';
            const lines = String(s.text).split('\n');
            const x = X(s.x);
            // half-leading повторяет положение строки в textarea
            const y0 = Y(s.y) + (lh - fs) / 2;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i]) ctx.fillText(lines[i], x, y0 + i * lh);
            }
            return;
        }

        if (s.type === 'rect' || s.type === 'circle') {
            const x1 = Math.min(s.x1, s.x2), y1 = Math.min(s.y1, s.y2);
            const w = Math.abs(s.x2 - s.x1), h = Math.abs(s.y2 - s.y1);
            if (s.type === 'rect') {
                ctx.beginPath();
                ctx.rect(X(x1), Y(y1), w * sc, h * sc);
            } else {
                const rx = Math.max(0, (w * sc) / 2);
                const ry = Math.max(0, (h * sc) / 2);
                ctx.beginPath();
                ctx.ellipse(X(x1) + rx, Y(y1) + ry, rx, ry, 0, 0, Math.PI * 2);
            }
            if (s.fill) {
                ctx.globalAlpha = 0.25;
                ctx.fill();
                ctx.globalAlpha = 1;
            }
            ctx.stroke();
            return;
        }

        // line / arrow
        const ax = X(s.x1), ay = Y(s.y1), bx = X(s.x2), by = Y(s.y2);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();

        if (s.type === 'arrow') {
            const ang = Math.atan2(by - ay, bx - ax);
            const len = Math.hypot(bx - ax, by - ay);
            let head = Math.max(s.width * sc * 3.2, 2);
            head = Math.min(head, Math.max(2, len * 0.6));
            ctx.beginPath();
            ctx.moveTo(bx, by);
            ctx.lineTo(bx - head * Math.cos(ang - Math.PI / 7), by - head * Math.sin(ang - Math.PI / 7));
            ctx.moveTo(bx, by);
            ctx.lineTo(bx - head * Math.cos(ang + Math.PI / 7), by - head * Math.sin(ang + Math.PI / 7));
            ctx.stroke();
        }
    }

    // --- Границы фигуры и хит-тест (4.2) -----------------------------------
    function shapeBounds(s) {
        if (!s) return null;
        if (s.type === 'pen') {
            const pts = s.points || [];
            if (!pts.length) return null;
            let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
            for (let i = 0; i < pts.length; i++) {
                if (pts[i].x < x1) x1 = pts[i].x;
                if (pts[i].x > x2) x2 = pts[i].x;
                if (pts[i].y < y1) y1 = pts[i].y;
                if (pts[i].y > y2) y2 = pts[i].y;
            }
            return { x1: x1, y1: y1, x2: x2, y2: y2 };
        }
        if (s.type === 'text') {
            const lines = String(s.text || '').split('\n');
            const lh = s.lh || (s.size * 1.25);
            let maxLen = 1;
            for (let i = 0; i < lines.length; i++) maxLen = Math.max(maxLen, lines[i].length);
            return {
                x1: s.x, y1: s.y,
                x2: s.x + maxLen * s.size * 0.62,
                y2: s.y + Math.max(1, lines.length) * lh,
            };
        }
        return {
            x1: Math.min(s.x1, s.x2), y1: Math.min(s.y1, s.y2),
            x2: Math.max(s.x1, s.x2), y2: Math.max(s.y1, s.y2),
        };
    }

    function distToSegment(px, py, ax, ay, bx, by) {
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        if (!len2) return Math.hypot(px - ax, py - ay);
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = clamp(t, 0, 1);
        return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    }

    // Поиск фигуры под точкой (координаты картинки), сверху вниз по стеку.
    function hitTest(ix, iy) {
        const tol = HIT_TOLERANCE / Math.max(scale, 0.0001);
        for (let i = annotations.length - 1; i >= 0; i--) {
            const s = annotations[i];
            if (!s) continue;
            if (s.type === 'pen') {
                const pts = s.points || [];
                const w = Math.max(s.width / 2, tol);
                for (let k = 1; k < pts.length; k++) {
                    if (distToSegment(ix, iy, pts[k - 1].x, pts[k - 1].y, pts[k].x, pts[k].y) <= w) return i;
                }
                if (pts.length === 1 && Math.hypot(ix - pts[0].x, iy - pts[0].y) <= w) return i;
                continue;
            }
            if (s.type === 'line' || s.type === 'arrow') {
                const w = Math.max(s.width / 2, tol);
                if (distToSegment(ix, iy, s.x1, s.y1, s.x2, s.y2) <= w) return i;
                continue;
            }
            const b = shapeBounds(s);
            if (!b) continue;
            if (ix >= b.x1 - tol && ix <= b.x2 + tol && iy >= b.y1 - tol && iy <= b.y2 + tol) {
                // для текста хватает рамки, для рамок/эллипсов — тоже рамка
                return i;
            }
        }
        return -1;
    }

    function selectShape(shape) {
        selShape = shape;
        invalidate();
    }

    function deleteShape(shape) {
        if (!shape) return;
        const idx = annotations.indexOf(shape);
        if (idx === -1) return;
        annotations = annotations.slice(0, idx).concat(annotations.slice(idx + 1));
        selShape = null;
        commit();
        toast('Фигура удалена (Ctrl+Z — вернуть)');
    }

    // Клонирование фигуры со смещением (4.2: Alt — дублировать, Ctrl — копия)
    function cloneShape(s, dx, dy) {
        if (!s) return null;
        const c = {};
        for (const k in s) {
            if (k === 'points') {
                c.points = (s.points || []).map((p) => ({ x: p.x + dx, y: p.y + dy }));
            } else if (k === 'x') {
                c.x = s.x + dx;
            } else if (k === 'y') {
                c.y = s.y + dy;
            } else if (k === 'x1') {
                c.x1 = s.x1 + dx;
            } else if (k === 'y1') {
                c.y1 = s.y1 + dy;
            } else if (k === 'x2') {
                c.x2 = s.x2 + dx;
            } else if (k === 'y2') {
                c.y2 = s.y2 + dy;
            } else if (k === 'ax' || k === 'ay') {
                c[k] = s[k] + (k === 'ax' ? dx : dy);
            } else {
                c[k] = s[k];
            }
        }
        return c;
    }

    function updateZoomLabel() {
        if (zoomLabel) zoomLabel.textContent = Math.round(scale * 100) + '%';
        if (sbZoom) sbZoom.textContent = Math.round(scale * 100) + '%';
    }

    function apply() {
        updateZoomLabel();
        baseValid = false;
        requestDraw();
        schedulePersist();
    }

    // Единая точка обновления статуса после смены инструмента/пометок.
    function afterToolChange() {
        renderPropsPanel();
        syncStatus();
    }

    function zoomAt(cx, cy, factor) {
        if (!(factor > 0) || Math.abs(factor - 1) < 1e-4) return;
        const next = clamp(scale * factor, ZOOM_MIN, ZOOM_MAX);
        if (next === scale) return;
        const f = next / scale;
        tx = cx - (cx - tx) * f;
        ty = cy - (cy - ty) * f;
        scale = next;
        apply();
    }

    function zoomCenter(factor) {
        if (!viewW) fitCanvas();
        zoomAt(viewW / 2, viewH / 2, factor);
    }

    function setZoom(value) {
        if (!viewW) fitCanvas();
        const target = clamp(value, ZOOM_MIN, ZOOM_MAX);
        zoomAt(viewW / 2, viewH / 2, target / scale);
    }

    function fitImage() {
        if (!imgEl || !viewEl) return;
        const iw = imageW(), ih = imageH();
        if (!iw || !ih) return;
        // Вьюпорт мог ещё не получить размер (окно только вставили в DOM).
        // Тогда берём размеры напрямую, иначе scale посчитается от нуля.
        if (!fitCanvas() || !viewW || !viewH) {
            const vw = viewEl.clientWidth, vh = viewEl.clientHeight;
            if (!vw || !vh) return;
            viewW = vw; viewH = vh;
        }
        // Вписываем в окно в обе стороны: маленькая картинка должна занимать
        // окно, а не половину. Предел 4x — чтобы иконка 16 px не раздувалась.
        scale = clamp(Math.min(viewW / iw, viewH / ih, 4), ZOOM_MIN, ZOOM_MAX);
        tx = (viewW - iw * scale) / 2;
        ty = (viewH - ih * scale) / 2;
        apply();
    }

    function onWheel(e) {
        if (!viewEl) return;
        if (textInput || helpVisible()) return;
        if (e.target !== drawEl && e.target !== viewEl) return;
        e.preventDefault();

        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 16;
        else if (e.deltaMode === 2) dy *= Math.max(1, viewH);
        if (!dy) return;
        const factor = clamp(Math.exp(-dy * 0.0022), 0.5, 2);

        if (drawing) endStroke(true);
        const r = viewEl.getBoundingClientRect();
        viewRect = r;
        zoomAt(e.clientX - r.left, e.clientY - r.top, factor);
    }

    // --- Персистентность ----------------------------------------------------
    function persistNow() {
        if (!win) return;
        storeSet('img_mag_scale', Math.round(scale * 10000) / 10000);
        storeSet('img_mag_left', Math.round(win.offsetLeft));
        storeSet('img_mag_top', Math.round(win.offsetTop));
        storeSet('img_mag_w', Math.round(win.offsetWidth));
        storeSet('img_mag_h', Math.round(win.offsetHeight));
    }

    function schedulePersist() {
        if (persistTimer) return;
        persistTimer = setTimeout(() => {
            persistTimer = 0;
            persistNow();
        }, 300);
    }

    // --- Ластик -------------------------------------------------------------
    // Стирает целиком фигуры, задетые кистью: так сохраняется отмена,
    // экспорт остаётся векторно чистым, а случайное «задевание» можно
    // откатить одним Ctrl+Z. Режим «стирать пиксели» сознательно не делаем:
    // он конфликтует с историей и с аннотациями в координатах картинки.
    let erasing = false;
    let eraseMoved = 0;

    function eraserRadius() { return Math.max(6, penWidth * 2.2); }

    function collectUnderCursor(sx, sy) {
        const p = s2i(sx, sy);
        const rad = eraserRadius() / Math.max(scale, 0.0001);
        const out = [];
        for (let i = annotations.length - 1; i >= 0; i--) {
            const s = annotations[i];
            if (!s) continue;
            if (shapeHitsCircle(s, p.x, p.y, rad)) out.push(i);
        }
        return out;
    }

    // Пересекается ли фигура с кругом (cx, cy, r) в координатах картинки.
    function shapeHitsCircle(s, cx, cy, r) {
        const b = shapeBounds(s);
        if (!b) return false;
        if (cx + r < b.x1 || cx - r > b.x2 || cy + r < b.y1 || cy - r > b.y2) return false;
        if (s.type === 'pen') {
            const pts = s.points || [];
            const w = Math.max(s.width / 2, 0);
            if (!pts.length) return false;
            if (pts.length === 1) return Math.hypot(cx - pts[0].x, cy - pts[0].y) <= r + w;
            for (let k = 1; k < pts.length; k++) {
                if (distToSegment(cx, cy, pts[k - 1].x, pts[k - 1].y, pts[k].x, pts[k].y) <= r + w) return true;
            }
            return false;
        }
        if (s.type === 'line' || s.type === 'arrow') {
            return distToSegment(cx, cy, s.x1, s.y1, s.x2, s.y2) <= r + Math.max(s.width / 2, 0);
        }
        if (s.type === 'rect' || s.type === 'circle') {
            const x1 = Math.min(s.x1, s.x2), y1 = Math.min(s.y1, s.y2);
            const x2 = Math.max(s.x1, s.x2), y2 = Math.max(s.y1, s.y2);
            if (s.fill) {
                // заливка: достаточно попадания в область
                if (s.type === 'rect') return cx >= x1 - r && cx <= x2 + r && cy >= y1 - r && cy <= y2 + r;
                const rx = Math.max((x2 - x1) / 2, 0.0001), ry = Math.max((y2 - y1) / 2, 0.0001);
                const nx = (cx - (x1 + rx)) / (rx + r), ny = (cy - (y1 + ry)) / (ry + r);
                return nx * nx + ny * ny <= 1;
            }
            // контур: проверяем четыре стороны/эллипс по рамке
            if (s.type === 'rect') {
                return distToSegment(cx, cy, x1, y1, x2, y1) <= r + s.width / 2
                    || distToSegment(cx, cy, x2, y1, x2, y2) <= r + s.width / 2
                    || distToSegment(cx, cy, x2, y2, x1, y2) <= r + s.width / 2
                    || distToSegment(cx, cy, x1, y2, x1, y1) <= r + s.width / 2;
            }
            return cx >= x1 - r && cx <= x2 + r && cy >= y1 - r && cy <= y2 + r;
        }
        // текст — по рамке
        return true;
    }

    function eraseAt(sx, sy) {
        const idx = collectUnderCursor(sx, sy);
        if (!idx.length) return false;
        const drop = new Set(idx);
        const next = [];
        for (let i = 0; i < annotations.length; i++) {
            if (!drop.has(i)) next.push(annotations[i]);
        }
        annotations = next;
        if (selShape && annotations.indexOf(selShape) === -1) selShape = null;
        eraseMoved += idx.length;
        return true;
    }

    // --- Геометрия и инструменты -------------------------------------------
    function getViewRect() {
        if (!viewRect && viewEl) viewRect = viewEl.getBoundingClientRect();
        return viewRect || { left: 0, top: 0 };
    }

    function setTool(name, silent) {
        if (!toolButtons[name] && name !== 'move') name = 'move';
        if (textInput && name !== 'text') commitText(true);
        currentTool = name;
        if (name !== 'move') { scanPick = false; scanRect = null; }
        for (const k in toolButtons) setBtnActive(toolButtons[k], k === name);
        if (viewEl) {
            viewEl.style.cursor = ghostMode ? 'default'
                : (name === 'move' ? 'grab' : 'crosshair');
        }
        // ластик — единственный инструмент, который стирает, а не рисует:
        // предупреждаем и подсказываем, что вся кисть отменяется одним Ctrl+Z
        if (name === 'eraser' && !silent) announce('Ластик: проведите по фигуре, чтобы стереть');
        if (!silent) storeSet('img_mag_tool', name);
        syncStatus();
        if (!silent) renderPropsPanel();
    }

    function updateHistoryButtons() {
        syncHistoryButtons();
        if (sbCount) sbCount.textContent = annotations.length ? pluralMarks(annotations.length) : 'пометок нет';
    }

    function setEnabled(b, on) {
        if (!b) return;
        b.dataset.disabled = on ? '' : '1';
        b.style.opacity = on ? '1' : '0.3';
        b.style.cursor = on ? 'pointer' : 'default';
        b.setAttribute('aria-disabled', on ? 'false' : 'true');
    }

    function commit() {
        history = history.slice(0, histIndex + 1);
        history.push(annotations.slice());
        if (history.length > HISTORY_LIMIT) history.shift();
        histIndex = history.length - 1;
        baseRev++;
        clearBaseCache();
        updateHistoryButtons();
        invalidate();
    }

    function undo() {
        if (textInput) return;
        if (histIndex <= 0) return;
        histIndex--;
        annotations = history[histIndex].slice();
        if (selShape && annotations.indexOf(selShape) === -1) selShape = null;
        baseRev++;
        clearBaseCache();
        updateHistoryButtons();
        invalidate();
    }

    function redo() {
        if (histIndex >= history.length - 1) return;
        histIndex++;
        annotations = history[histIndex].slice();
        if (selShape && annotations.indexOf(selShape) === -1) selShape = null;
        baseRev++;
        clearBaseCache();
        updateHistoryButtons();
        invalidate();
    }

    function clearAll() {
        if (!annotations.length && !selShape) return;
        annotations = [];
        selShape = null;
        commit();
        toast('Аннотации очищены (Ctrl+Z — вернуть)');
    }

    function pushAnnotation(shape) {
        if (annotations.length >= MAX_ANNOTATIONS) {
            toast('Достигнут лимит аннотаций (' + MAX_ANNOTATIONS + ')');
            return;
        }
        annotations = annotations.concat([shape]);
        lastShape = shape;
        commit();
        // после ввода текста сразу возвращаемся к панораме:
        // это самый частый следующий шаг
        if (shape && shape.type === 'text' && currentTool === 'text') setTool('move');
    }

    function isMeaningful(s) {
        if (!s) return false;
        if (s.type === 'pen') return s.points && s.points.length > 1;
        if (s.type === 'text') return !!(s.text && s.text.length);
        return Math.hypot(s.x2 - s.x1, s.y2 - s.y1) * scale >= 3;
    }

    function beginStroke(sx, sy) {
        if (currentTool === 'move') return false;
        if (currentTool === 'text') { openTextEditor(sx, sy); return false; }
        if (currentTool === 'eraser') {
            // Ластик — отдельный режим: фигуры удаляются по мере движения,
            // а один commit() в конце даёт одну запись в истории на весь жест.
            if (erasing) return false;
            erasing = true;
            eraseMoved = 0;
            eraseAt(sx, sy);
            invalidate();
            return true;
        }
        if (drawing) return false;
        if (annotations.length >= MAX_ANNOTATIONS) {
            toast('Достигнут лимит аннотаций (' + MAX_ANNOTATIONS + ')');
            return false;
        }

        const dragMode = currentTool === 'pen' || currentTool === 'line' ||
            currentTool === 'arrow' || currentTool === 'rect' || currentTool === 'circle';
        if (!dragMode) return false;

        const p = s2i(sx, sy);
        drawing = true;
        inProgress = {
            type: currentTool,
            color: penColor,
            width: penWidth / scale,     // экранная толщина → пиксели картинки
            fill: fillShapes && (currentTool === 'rect' || currentTool === 'circle'),
            ax: p.x, ay: p.y,
            x1: p.x, y1: p.y, x2: p.x, y2: p.y,
            points: currentTool === 'pen' ? [p] : null,
        };
        requestDraw();
        return true;
    }

    function updateStroke(sx, sy, shift, alt) {
        if (erasing) {
            if (eraseAt(sx, sy)) invalidate();
            return true;
        }
        if (!inProgress) return false;
        const p = s2i(sx, sy);

        if (inProgress.type === 'pen') {
            const pts = inProgress.points;
            const last = pts[pts.length - 1];
            if (Math.hypot(p.x - last.x, p.y - last.y) * scale < PEN_MIN_DIST) return false;
            if (pts.length >= MAX_POINTS) return false;
            pts.push(p);
            requestDraw();
            return true;
        }

        const ax = inProgress.ax, ay = inProgress.ay;
        let dx = p.x - ax, dy = p.y - ay;

        if (inProgress.type === 'line' || inProgress.type === 'arrow') {
            if (shift) {
                const step = Math.PI / 4;
                const a = Math.round(Math.atan2(dy, dx) / step) * step;
                const len = Math.hypot(dx, dy);
                dx = Math.cos(a) * len;
                dy = Math.sin(a) * len;
            }
            inProgress.x1 = ax; inProgress.y1 = ay;
            inProgress.x2 = ax + dx; inProgress.y2 = ay + dy;
        } else {
            if (shift) {
                const m = Math.max(Math.abs(dx), Math.abs(dy));
                dx = m * (dx < 0 ? -1 : 1);
                dy = m * (dy < 0 ? -1 : 1);
            }
            if (alt) {
                inProgress.x1 = ax - dx; inProgress.y1 = ay - dy;
                inProgress.x2 = ax + dx; inProgress.y2 = ay + dy;
            } else {
                inProgress.x1 = ax; inProgress.y1 = ay;
                inProgress.x2 = ax + dx; inProgress.y2 = ay + dy;
            }
        }
        requestDraw();
        return true;
    }

    function endStroke(cancel) {
        if (erasing) {
            erasing = false;
            const n = eraseMoved;
            eraseMoved = 0;
            if (!cancel && n > 0) {
                commit();
                toast(n === 1 ? 'Удалена 1 фигура' : 'Удалено фигур: ' + n);
            } else {
                requestDraw();
            }
            return;
        }
        if (!drawing) { inProgress = null; return; }
        drawing = false;
        const s = inProgress;
        inProgress = null;
        if (!cancel && s && isMeaningful(s)) {
            pushAnnotation(s);   // pushAnnotation сам вызовет invalidate()
        } else {
            requestDraw();
        }
    }

    function cancelStroke() {
        if (erasing) {
            erasing = false;
            eraseMoved = 0;
            invalidate();
            return;
        }
        if (drawing) endStroke(true);
        inProgress = null;
    }

    // --- Текстовый инструмент ----------------------------------------------
    // Текст хранится в координатах картинки (s.x, s.y, s.size), поэтому он
    // жёстко приклеен к изображению при любом зуме/панораме и попадает в
    // экспорт ровно туда, где был на экране.
    function openTextEditor(sx, sy, initialText) {
        if (!viewEl || !win) return;
        commitText(true);

        // Авторучка: анкор = точка клика. Если редактор пришлось сдвинуть от
        // края окна, сдвигаем и анкор — текст встанет ровно туда, где его
        // видел пользователь, а не за границу картинки.
        const screenSize = textScreenSize();
        const sizeInImage = screenSize / scale;
        const lineHeight = Math.round(screenSize * 1.25);
        const baseLeft = Math.round(sx);
        const baseTop = Math.round(sy);

        const inp = document.createElement('textarea');
        inp.rows = 1;
        inp.wrap = 'off';
        inp.spellcheck = false;
        inp.placeholder = 'Текст…';
        inp.setAttribute('aria-label', 'Текст аннотации');
        Object.assign(inp.style, {
            position: 'absolute',
            left: baseLeft + 'px',
            top: baseTop + 'px',
            margin: '0',
            padding: '0',
            border: 'none',
            borderRadius: '2px',
            resize: 'none',
            overflow: 'hidden',
            whiteSpace: 'pre',
            font: '600 ' + screenSize + 'px/' + lineHeight + 'px system-ui, -apple-system, "Segoe UI", sans-serif',
            color: penColor,
            caretColor: penColor,
            background: 'transparent',
            boxShadow: '0 0 0 1px ' + penColor + ', 0 1px 6px rgba(0,0,0,0.5)',
            outline: 'none',
            zIndex: '5',
            boxSizing: 'content-box',
            minWidth: '40px',
            transform: 'translateZ(0)',
        });

        const autosize = () => {
            const lines = inp.value.split('\n');
            let maxLen = 1;
            for (let i = 0; i < lines.length; i++) maxLen = Math.max(maxLen, lines[i].length);
            const w = clamp(maxLen * screenSize * 0.62 + 8, 60, Math.max(60, viewW - 12));
            const h = Math.max(1, lines.length) * lineHeight;
            inp.style.width = Math.round(w) + 'px';
            inp.style.height = Math.round(h) + 'px';

            // не вылезаем за границы вьюпорта
            inp._left = Math.round(clamp(baseLeft, 0, Math.max(0, viewW - w - 4)));
            inp._top = Math.round(clamp(baseTop, 0, Math.max(0, viewH - h - 4)));
            inp.style.left = inp._left + 'px';
            inp.style.top = inp._top + 'px';
        };

        let finished = false;
        const finish = (keep) => {
            // remove() снимает фокус и синхронно вызывает blur -> повторный
            // вход в finish. Без этого флага второй вход падал с NotFoundError.
            if (finished || !inp.isConnected) return;
            finished = true;
            inp._finish = null;
            if (textInput === inp) textInput = null;
            const value = inp.value.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '');
            // якорь = финальная позиция редактора, переведённая в координаты
            // картинки. Никакого двойного масштабирования: и редактор, и рендер
            // используют одну и ту же пару (scale, tx/ty).
            const anchor = s2i(
                inp._left === undefined ? baseLeft : inp._left,
                inp._top === undefined ? baseTop : inp._top
            );
            if (inp.parentNode) inp.parentNode.removeChild(inp);

            if (keep && value.trim()) {
                pushAnnotation({
                    type: 'text',
                    color: penColor,
                    width: 1,
                    size: sizeInImage,        // пиксели картинки → масштабируется вместе с ней
                    lh: lineHeight / scale,   // ровно тот же межстрочный шаг
                    x: anchor.x,
                    y: anchor.y,
                    text: value.replace(/^\n+/, '').replace(/\n+$/, ''),
                });
            } else {
                requestDraw();
            }
        };

        inp._finish = finish;
        textInput = inp;

        inp.addEventListener('input', autosize);
        inp.addEventListener('blur', () => finish(true));
        // Enter/Esc обрабатывает наш capture-хендлер на document; здесь только
        // не даём остальным клавишам дойти до хоткеев сайта
        inp.addEventListener('keydown', (e) => { e.stopPropagation(); });
        inp.addEventListener('mousedown', (e) => e.stopPropagation());
        inp.addEventListener('pointerdown', (e) => e.stopPropagation());
        inp.addEventListener('click', (e) => e.stopPropagation());
        inp.addEventListener('dblclick', (e) => e.stopPropagation());
        inp.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

        viewEl.appendChild(inp);
        autosize();
        if (initialText) {
            inp.value = String(initialText);
            autosize();
        }
        try { inp.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
    }

    function textScreenSize() {
        return clamp(14 + penWidth * 2, 12, 96);
    }

    function commitText(keep) {
        if (!textInput) return;
        if (typeof textInput._finish === 'function') textInput._finish(keep !== false);
    }

    // --- Мышь ---------------------------------------------------------------
    function beginPan(x, y) {
        mode = 'pan';
        startX = x;
        startY = y;
        startA = tx;
        startB = ty;
        if (viewEl) viewEl.style.cursor = 'grabbing';
    }

    function onMouseDown(e) {
        if (!viewEl || !drawEl) return;
        if (e.target !== drawEl && e.target !== viewEl) return; // клики по полю текста и т.п.
        if (helpVisible()) { toggleHelp(false); return; }
        if (menuEl) closeMenu();

        // клик по картинке при открытом редакторе = «готово»,
        // без одновременного старта панорамы/штриха
        if (textInput) {
            e.preventDefault();
            commitText(true);
            return;
        }

        viewRect = null;
        getViewRect();

        if (e.button === 1 || spaceDown) {
            e.preventDefault();
            e.stopPropagation();
            if (drawing) endStroke(true);
            beginPan(e.clientX, e.clientY);
            if (viewEl) viewEl.style.cursor = 'grabbing';
            return;
        }
        if (e.button !== 0) return;

        const r = getViewRect();
        const sx = e.clientX - r.left;
        const sy = e.clientY - r.top;

        // 1.5 — ставим четыре угла
        if (perspPicking) {
            e.preventDefault();
            e.stopPropagation();
            addPerspCorner(sx, sy);
            return;
        }

        // 2.3 / 2.4 — выделяем область
        if (scanPick) {
            e.preventDefault();
            e.stopPropagation();
            scanRect = { x1: sx, y1: sy, x2: sx, y2: sy };
            mode = 'scan';
            requestDraw();
            return;
        }

        if (currentTool === 'move') {
            // 4.2 — в режиме панорамы даём тащить выбранную/найденную фигуру
            const p = s2i(sx, sy);
            const hit = currentTool === 'eraser' ? -1 : hitTest(p.x, p.y);
            if (hit !== -1) {
                const shape = annotations[hit];
                e.preventDefault();
                e.stopPropagation();
                if (selShape !== shape) { selShape = shape; invalidate(); }
                dragShape = { shape: shape, ox: p.x, oy: p.y, moved: false, alt: e.altKey };
                mode = 'shape';
                if (viewEl) viewEl.style.cursor = 'move';
                return;
            }
            if (selShape) { selShape = null; invalidate(); }
            e.preventDefault();
            beginPan(e.clientX, e.clientY);
            if (viewEl) viewEl.style.cursor = 'grabbing';
            return;
        }

        // рисующие инструменты: проверяем попадание по фигуре для правки
        // (ластик сюда не относится — он стирает, а не таскает)
        const ip = s2i(sx, sy);
        const hitIdx = currentTool === 'eraser' ? -1 : hitTest(ip.x, ip.y);
        if (hitIdx !== -1 && annotations[hitIdx]) {
            const shape = annotations[hitIdx];
            e.preventDefault();
            e.stopPropagation();
            selShape = shape;
            if (e.altKey || e.ctrlKey || e.metaKey) {
                // дубликат существующей фигуры
                const dup = cloneShape(shape, 0, 0);
                lastShape = dup;
                pushAnnotation(dup);
                selShape = dup;
                invalidate();
                dragShape = { shape: dup, ox: ip.x, oy: ip.y, moved: false, alt: false };
                mode = 'shape';
                announce('Фигура продублирована');
                return;
            }
            dragShape = { shape: shape, ox: ip.x, oy: ip.y, moved: false, alt: false };
            mode = 'shape';
            invalidate();
            return;
        }

        e.preventDefault();
        e.stopPropagation();

        // Alt + перетаскивание: дублируем последнюю фигуру со смещением
        if (e.altKey && lastShape && annotations.indexOf(lastShape) === -1) {
            // последнюю могли отменить — берём последнюю из истории
            lastShape = annotations.length ? annotations[annotations.length - 1] : null;
        }
        if (e.altKey && lastShape) {
            dragShape = { shape: lastShape, ox: ip.x, oy: ip.y, moved: false, alt: true, cloneMade: false };
            mode = 'shape';
            if (viewEl) viewEl.style.cursor = 'move';
            return;
        }

        beginStroke(sx, sy);
    }

    function onMouseMove(e) {
        if (!win) return;

        if (erasing) {
            const r = getViewRect();
            updateStroke(e.clientX - r.left, e.clientY - r.top, e.shiftKey, e.altKey);
            return;
        }

        if (drawing && inProgress) {
            const r = getViewRect();
            updateStroke(e.clientX - r.left, e.clientY - r.top, e.shiftKey, e.altKey);
            return;
        }

        if (mode === 'scan') {
            const r = getViewRect();
            scanRect.x2 = e.clientX - r.left;
            scanRect.y2 = e.clientY - r.top;
            requestDraw();
            return;
        }

        if (mode === 'shape' && dragShape) {
            const r = getViewRect();
            const p = s2i(e.clientX - r.left, e.clientY - r.top);
            const dx = p.x - dragShape.ox;
            const dy = p.y - dragShape.oy;
            if (Math.abs(dx) * scale > 2 || Math.abs(dy) * scale > 2) {
                dragShape.moved = true;
            }
            if (dragShape.moved) {
                if (dragShape.alt && !dragShape.cloneMade) {
                    // Alt-дубликат создаётся только когда реально потащили
                    const dup = cloneShape(dragShape.shape, 0, 0);
                    if (dup) {
                        lastShape = dup;
                        pushAnnotation(dup);
                        selShape = dup;
                        dragShape.shape = dup;
                        dragShape.cloneMade = true;
                    }
                }
                if (dragShape.cloneMade) {
                    // тянем копию от исходной точки — пересчитываем от базы
                    moveShapeBy(dragShape.shape, dx - (dragShape.lastDx || 0), dy - (dragShape.lastDy || 0));
                    dragShape.lastDx = dx;
                    dragShape.lastDy = dy;
                } else {
                    moveShapeBy(dragShape.shape, dx, dy);
                    dragShape.ox = p.x;
                    dragShape.oy = p.y;
                }
                invalidate();
            }
            return;
        }

        if (mode === 'pan') {
            tx = startA + (e.clientX - startX);
            ty = startB + (e.clientY - startY);
            apply();
            return;
        }

        if (mode === 'drag') {
            const w = win.offsetWidth || 0;
            const h = win.offsetHeight || 0;
            const left = clamp(startA + (e.clientX - startX), -(w - 80), Math.max(0, innerWidth - 80));
            const top = clamp(startB + (e.clientY - startY), 0, Math.max(0, innerHeight - 34));
            win.style.left = left + 'px';
            win.style.top = top + 'px';
            schedulePersist();
        }
    }

    // Сдвиг фигуры в координатах картинки (все поля сразу)
    function moveShapeBy(s, dx, dy) {
        if (!s || (!dx && !dy)) return;
        if (s.type === 'pen') {
            const pts = s.points || [];
            for (let i = 0; i < pts.length; i++) { pts[i].x += dx; pts[i].y += dy; }
            return;
        }
        if (s.type === 'text') { s.x += dx; s.y += dy; return; }
        s.x1 += dx; s.y1 += dy; s.x2 += dx; s.y2 += dy;
        if (s.ax !== undefined) s.ax += dx;
        if (s.ay !== undefined) s.ay += dy;
    }

    function onMouseUp() {
        if (erasing) {
            endStroke(false);
            return;
        }
        if (drawing) {
            endStroke(false);
            return;
        }
        if (mode === 'scan' && scanRect) {
            const rc = normalizeRect(scanRect);
            scanRect = null;
            mode = null;
            if (rc && rc.w * scale >= 6 && rc.h * scale >= 6) {
                runScan(rc);
            } else {
                announce('Слишком маленькая область');
                requestDraw();
            }
            return;
        }
        if (mode === 'shape' && dragShape) {
            const changed = dragShape.moved;
            dragShape = null;
            mode = null;
            if (changed) {
                baseRev++;
                clearBaseCache();
                commit();
            } else {
                invalidate();
            }
            if (viewEl) viewEl.style.cursor = currentTool === 'move' ? 'grab' : 'crosshair';
            return;
        }
        if (mode === 'pan' && viewEl) {
            viewEl.style.cursor = spaceDown ? 'grab' : (currentTool === 'move' ? 'grab' : 'crosshair');
        }
        mode = null;
    }

    function onDragStart(e) {
        if (!win || e.button !== 0) return;
        if (helpVisible()) return;
        mode = 'drag';
        const r = win.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        startA = r.left;
        startB = r.top;
        e.preventDefault();
    }

    function onContextMenu(e) {
        // нативное меню нужно (Копировать/Сохранить изображение),
        // но незавершённый штрих надо сбросить
        if (erasing) { erasing = false; eraseMoved = 0; invalidate(); }
        if (drawing) endStroke(true);
        if (e.target !== drawEl && e.target !== viewEl) return;
    }

    function onOutsideClick(e) {
        if (!win) return;
        if (win.contains(e.target)) {
            // клик мимо открытого меню, но внутри окна — закрываем меню
            if (menuEl && !menuEl.contains(e.target) && e.target !== menuAnchorBtn) closeMenu();
            return;
        }
        if (menuEl) closeMenu();
        if (pinned) return;            // 5.3: закреплённое окно не закрывается
        closeWindow();
    }

    // 4.2: двойной клик по фигуре — выбрать и править
    function onDblClick(e) {
        if (!win || !drawEl) return;
        if (e.target !== drawEl && e.target !== viewEl) return;
        if (textInput || helpVisible()) return;
        const r = getViewRect();
        const p = s2i(e.clientX - r.left, e.clientY - r.top);
        const hit = hitTest(p.x, p.y);
        if (hit === -1) return;
        e.preventDefault();
        e.stopPropagation();
        const shape = annotations[hit];
        selShape = shape;
        invalidate();
        if (shape.type === 'text') {
            editTextShape(shape);
        } else {
            openShapeMenu(shape, e.clientX, e.clientY);
        }
    }

    function onPageScroll() {
        viewRect = null;
    }

    // --- Касания ------------------------------------------------------------
    let touchState = null;

    function touchPoint(t) {
        const r = getViewRect();
        return { x: t.clientX - r.left, y: t.clientY - r.top };
    }

    function onTouchStart(e) {
        if (!viewEl || !win) return;
        if (helpVisible()) { toggleHelp(false); return; }
        viewRect = null;
        getViewRect();

        if (e.touches.length >= 2) {
            e.preventDefault();
            cancelStroke();
            mode = null;
            const a = e.touches[0], b = e.touches[1];
            const p1 = touchPoint(a), p2 = touchPoint(b);
            const dist = Math.max(1, Math.hypot(p1.x - p2.x, p1.y - p2.y));
            const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
            touchState = {
                kind: 'pinch',
                d0: dist,
                scale0: scale,
                ix: (mid.x - tx) / scale,
                iy: (mid.y - ty) / scale,
            };
            return;
        }

        if (e.touches.length === 1) {
            const p = touchPoint(e.touches[0]);
            touchState = { kind: 'single', x: p.x, y: p.y, tx0: tx, ty0: ty };

            if (currentTool === 'text') {
                // тап пальцем по картинке — сразу редактор текста
                e.preventDefault();
                openTextEditor(p.x, p.y);
                touchState = null;
            } else if (currentTool === 'move') {
                beginPan(0, 0);
                mode = 'touch-pan';
            } else {
                e.preventDefault();
                beginStroke(p.x, p.y);
            }
        }
    }

    function onTouchMove(e) {
        if (!touchState) return;

        if (touchState.kind === 'pinch' && e.touches.length >= 2) {
            e.preventDefault();
            const a = e.touches[0], b = e.touches[1];
            const p1 = touchPoint(a), p2 = touchPoint(b);
            const dist = Math.max(1, Math.hypot(p1.x - p2.x, p1.y - p2.y));
            const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
            scale = clamp(touchState.scale0 * (dist / touchState.d0), ZOOM_MIN, ZOOM_MAX);
            tx = mid.x - touchState.ix * scale;
            ty = mid.y - touchState.iy * scale;
            apply();
            return;
        }

        if (e.touches.length !== 1) return;
        e.preventDefault();
        const p = touchPoint(e.touches[0]);

        if (drawing) {
            updateStroke(p.x, p.y, false, false);
        } else if (mode === 'touch-pan') {
            tx = touchState.tx0 + (p.x - touchState.x);
            ty = touchState.ty0 + (p.y - touchState.y);
            apply();
        }
    }

    function onTouchEnd(e) {
        if (!touchState) return;
        if (touchState.kind === 'pinch') {
            // отпустили один палец — прекращаем пинч и ждём нового touchstart,
            // чтобы картинка не прыгнула под оставшимся пальцем
            if (e.touches.length > 0) {
                touchState = null;
                mode = null;
                return;
            }
            touchState = null;
            mode = null;
            return;
        }
        if (e.touches.length > 0) return;
        if (drawing) endStroke(false);
        touchState = null;
        mode = null;
        if (viewEl) viewEl.style.cursor = currentTool === 'move' ? 'grab' : 'crosshair';
    }

    // --- Вьюпорт ------------------------------------------------------------
    // Компактный режим для маленького окна: рейка, кнопки и панель
    // свойств ужимаются, иначе в окне 300 px они занимают всё место.
    function syncCompactMode() {
        if (!win) return;
        const w = win.clientWidth || 0;
        win.classList.toggle('imv-narrow', w > 0 && w < 520);
        win.classList.toggle('imv-tiny', w > 0 && w < 380);
    }

    function onViewportChange() {
        if (!win || !viewEl) return;
        viewRect = null;
        syncCompactMode();

        // ещё ни разу не мерили — просто инициализируем холст
        if (!viewW || !viewH) {
            fitCanvas();
            if (imageW() && viewW && viewH) {
                // Размер вьюпорта только что появился — вписываем целиком,
                // иначе картинка окажется обрезанной при первом открытии.
                fitImage();
                return;
            }
            baseValid = false;
            requestDraw();
            return;
        }

        const ix = scale ? (viewW / 2 - tx) / scale : 0;
        const iy = scale ? (viewH / 2 - ty) / scale : 0;

        if (!fitCanvas()) return;

        // сохраняем точку картинки в центре вьюпорта
        tx = viewW / 2 - ix * scale;
        ty = viewH / 2 - iy * scale;
        baseValid = false;
        requestDraw();
        schedulePersist();
    }

    // ======================================================================
    // 1.4 Палитра изображения
    // ======================================================================
    function buildImagePalette() {
        imagePalette = [];
        // Палитра — про пиксели, поэтому берём pixelSource(): он учитывает
        // CORS-копию. С sourceEl() отравленный <img> так и остался бы
        // источником, и палитра не построилась бы никогда.
        const src = pixelSource();
        const iw = imageW(), ih = imageH();
        if (!src || !iw || !ih) return;

        // Отравленный canvas: пробуем CORS-копию, иначе палитры не будет.
        // ВАЖНО: попытка строго одноразовая. Раньше здесь стоял повторный
        // вызов buildImagePalette(), а loadCorsImage() на втором заходе
        // отдаёт уже готовый corsImage — цикл обещаний не заканчивался и
        // вкладка вставала намертво. Это и было причиной зависания.
        if (canExport !== true) {
            checkExportable();
            if (canExport === false) {
                if (paletteCorsTried) {
                    canExport = false;
                    return;
                }
                paletteCorsTried = true;
                loadCorsImage().then((im) => {
                    if (!im || !win) return;
                    corsImage = im;
                    // Проверяем доступ к пикселям у самой копии — дальше
                    // работаем по ней, без нового витка рекурсии.
                    const ok = corsPixelsOk(im);
                    if (ok) { canExport = true; buildImagePalette(); }
                    else { canExport = false; }
                });
                return;
            }
        }

        // Замерено: один drawImage 8000×6000 -> 256 px держал главный поток
        // ~380 мс, и вкладка на это время замирала. Уменьшаем полосами в
        // простое — суммарно те же миллисекунды, но без блокировки.
        const sw = src.naturalWidth || src.width || PALETTE_SAMPLE;
        const sh = src.naturalHeight || src.height || PALETTE_SAMPLE;
        const MID = 256;

        const finish = (feed) => {
            let data = null;
            try {
                const c = document.createElement('canvas');
                c.width = PALETTE_SAMPLE;
                c.height = PALETTE_SAMPLE;
                const x = c.getContext('2d');
                if (!x) return;
                x.imageSmoothingEnabled = true;
                if (x.imageSmoothingQuality) x.imageSmoothingQuality = 'low';
                x.fillStyle = '#000';
                x.drawImage(feed, 0, 0, PALETTE_SAMPLE, PALETTE_SAMPLE);
                data = x.getImageData(0, 0, PALETTE_SAMPLE, PALETTE_SAMPLE).data;
            } catch (e) {
                imagePalette = [];   // tainted canvas: палитры не будет
                return;
            }
            tallyPalette(data);
        };

        if (Math.max(sw, sh) <= MID) { finish(src); return; }
        const k = MID / Math.max(sw, sh);
        bandDownscale(src, sw, sh,
            Math.max(1, Math.round(sw * k)), Math.max(1, Math.round(sh * k)),
            (cv) => { if (win) finish(cv); },
            () => { imagePalette = []; });
    }

    // Квантование готовой выборки в 5–8 различимых цветов.
    function tallyPalette(data) {
        if (!data) { imagePalette = []; return; }

        // грубые бины: 4 бита на канал
        const bins = new Map();
        for (let i = 0; i < data.length; i += 4) {
            const a = data[i + 3];
            if (a < 128) continue;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
            let e = bins.get(key);
            if (!e) {
                e = { n: 0, r: 0, g: 0, b: 0 };
                bins.set(key, e);
            }
            e.n++;
            e.r += r; e.g += g; e.b += b;
        }
        if (!bins.size) return;

        const list = [];
        bins.forEach((e) => {
            list.push({
                n: e.n,
                r: Math.round(e.r / e.n),
                g: Math.round(e.g / e.n),
                b: Math.round(e.b / e.n),
            });
        });
        list.sort((a, b) => b.n - a.n);

        const picked = [];
        for (let i = 0; i < list.length && picked.length < PALETTE_MAX; i++) {
            const c = list[i];
            let ok = true;
            for (let k = 0; k < picked.length; k++) {
                if (rgbDist(c, picked[k]) < PALETTE_MIN_DIST) { ok = false; break; }
            }
            if (ok) picked.push(c);
            if (picked.length >= 5 && i > 60) break;
        }
        while (picked.length < 5 && list.length > picked.length) {
            // добираем до пяти, если квантование дало мало далёких цветов
            const c = list[picked.length];
            let dup = false;
            for (let k = 0; k < picked.length; k++) {
                if (rgbDist(c, picked[k]) < 6) { dup = true; break; }
            }
            if (!dup) picked.push(c);
            else break;
        }

        imagePalette = picked.map((c) => rgbToHex(c.r, c.g, c.b));
    }

    function openPalettePanel(anchorBtn) {
        openPanel(anchorBtn, 'Палитра изображения', (panel) => {
            if (!imagePalette.length) {
                menuNote(panel, canExport === false
                    ? 'Изображение с другого сайта защищено CORS — палитру построить нельзя.'
                    : 'Палитра ещё не готова.');
                return;
            }
            const grid = mk('div', {
                display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '2px 6px 4px',
            });
            imagePalette.forEach((hex) => {
                const cell = mk('button', {
                    width: '40px', height: '30px', padding: '0', background: hex,
                    border: '1px solid rgba(0,0,0,0.5)', borderRadius: '5px',
                    cursor: 'pointer', outline: 'none',
                    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.22)',
                });
                cell.type = 'button';
                cell.title = hex.toUpperCase() + ' — скопировать и взять кистью';
                cell.setAttribute('aria-label', 'Цвет ' + hex.toUpperCase() +
                    ': скопировать HEX и выбрать для рисования');
                cell.addEventListener('focus', () => { cell.style.outline = '2px solid #4da3ff'; });
                cell.addEventListener('blur', () => { cell.style.outline = 'none'; });
                cell.addEventListener('click', () => {
                    setPenColor(hex, true);
                    copyText(hex.toUpperCase(), 'HEX ' + hex.toUpperCase() + ' скопирован, кисть — этого цвета');
                });
                grid.appendChild(cell);
            });
            panel.appendChild(grid);

            const row = mk('div', { display: 'flex', flexWrap: 'wrap', gap: '4px', padding: '0 6px 4px' });
            imagePalette.forEach((hex) => {
                const lbl = mk('span', {
                    font: '10.5px ui-monospace, monospace', opacity: '0.7',
                });
                lbl.textContent = hex.toUpperCase();
                row.appendChild(lbl);
            });
            panel.appendChild(row);
            menuNote(panel, 'Клик по плашке: HEX в буфер + цвет кисти.');
        }, { minWidth: 210 });
    }

    // ======================================================================
    // 1.5 Перспективная коррекция
    // ======================================================================
    function beginPerspective() {
        if (!imgEl || !imageW()) { toast('Картинка ещё не загрузилась'); return; }
        perspCorners = [];
        perspPicking = true;
        setTool('move');
        if (helpVisible()) toggleHelp(false);
        selShape = null;
        if (viewEl) viewEl.style.cursor = 'crosshair';
        invalidate();
        showHint('Кликните четыре угла документа, Esc — отмена');
        announce('Укажите четыре угла документа: левый верх, правый верх, правый низ, левый низ');
    }

    function cancelPerspective() {
        showHint(null);
        perspPicking = false;
        perspCorners = [];
        if (viewEl) viewEl.style.cursor = ghostMode ? 'default' : 'grab';
        invalidate();
    }

    function addPerspCorner(sx, sy) {
        const p = s2i(sx, sy);
        perspCorners.push({ x: p.x, y: p.y });
        if (perspCorners.length < 4) {
            announce('Угол ' + perspCorners.length + ' из 4');
            requestDraw();
            return;
        }
        perspPicking = false;
        if (viewEl) viewEl.style.cursor = ghostMode ? 'default' : 'grab';
        applyPerspective();
    }

    function drawPerspPicking(c) {
        const pts = perspCorners;
        c.save();
        c.lineWidth = 1.6;
        c.strokeStyle = '#4da3ff';
        c.fillStyle = '#4da3ff';
        c.setLineDash([]);
        if (pts.length > 1) {
            c.beginPath();
            c.moveTo(pts[0].x * scale + tx, pts[0].y * scale + ty);
            for (let i = 1; i < pts.length; i++) {
                c.lineTo(pts[i].x * scale + tx, pts[i].y * scale + ty);
            }
            if (pts.length === 4) c.closePath();
            c.stroke();
        }
        for (let i = 0; i < pts.length; i++) {
            const x = pts[i].x * scale + tx;
            const y = pts[i].y * scale + ty;
            c.beginPath();
            c.arc(x, y, 5, 0, Math.PI * 2);
            c.fill();
            c.fillStyle = '#0d1a26';
            c.font = '600 10px ui-monospace, monospace';
            c.textAlign = 'center';
            c.textBaseline = 'middle';
            c.fillText(String(i + 1), x, y);
            c.fillStyle = '#4da3ff';
        }
        c.restore();
    }

    // Гомография: 4 точки источника → прямоугольник. Выборка по пикселям
    // в выходной холст разумного размера (иначе большие фото подвесили бы вкладку).
    function applyPerspective() {
        if (perspCorners.length !== 4 || perspBusy) return;
        if (!sourceEl()) return;
        // getImageData ниже требует пиксельного доступа: на чужой картинке
        // сначала добываем CORS-копию, иначе всё падает на taint.
        ensurePixels().then((src) => {
            if (!win) return;
            if (!src) { toast('Нет доступа к пикселям этой картинки'); return; }
            runPerspective(src);
        });
    }

    function runPerspective(src) {
        if (!src) return;
        // Читаем размеры ФАКТИЧЕСКОГО источника: ensurePixels() может
        // отдать CORS-копию или уменьшенный hugeSource, у которых свой
        // размер. Старый код брал imageW()/imageH() (размер оригинала) и
        // на «грязном» img рисовал растянутый исходник, а getImageData
        // полного размера бросал исключение → ложный тост про CORS.
        const sw = src.naturalWidth || src.width;
        const sh = src.naturalHeight || src.height;
        if (!sw || !sh) return;
        const iw = sw, ih = sh;

        const d = perspCorners;
        const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
        const topW = dist(d[0], d[1]);
        const botW = dist(d[3], d[2]);
        const leftH = dist(d[0], d[3]);
        const rightH = dist(d[1], d[2]);
        let outW = Math.round(Math.max(topW, botW));
        let outH = Math.round(Math.max(leftH, rightH));
        if (!outW || !outH) { cancelPerspective(); return; }

        // ограничители: сторона и площадь
        const sideCap = Math.min(WARP_MAX_SIDE, Math.round(Math.sqrt(WARP_MAX_PIXELS)));
        outW = clamp(outW, 8, sideCap);
        outH = clamp(outH, 8, Math.max(8, Math.floor(WARP_MAX_PIXELS / outW)));

        perspBusy = true;
        announce('Выпрямляем…');

        try {
            const cv = document.createElement('canvas');
            cv.width = outW;
            cv.height = outH;
            const out = cv.getContext('2d');
            if (!out) throw new Error('ctx');

            // исходник → ImageData целиком (так выборка дешевле)
            const sc = document.createElement('canvas');
            sc.width = iw;
            sc.height = ih;
            const sctx = sc.getContext('2d');
            if (!sctx) throw new Error('ctx');
            sctx.drawImage(src, 0, 0, iw, ih);
            const srcData = sctx.getImageData(0, 0, iw, ih);
            const sd = srcData.data;

            const dst = out.createImageData(outW, outH);
            const dd = dst.data;

            // Гомография из единичного квадрата (u,v) в 4 точки источника.
            // Решаем 8×8 систему Гауссом.
            const H = squareToQuad(d[0], d[1], d[2], d[3]);
            if (!H) throw new Error('homography');

            for (let y = 0; y < outH; y++) {
                const v = (y + 0.5) / outH;
                for (let x = 0; x < outW; x++) {
                    const u = (x + 0.5) / outW;
                    const den = H[6] * u + H[7] * v + 1;
                    if (!den) continue;
                    const sx = (H[0] * u + H[1] * v + H[2]) / den;
                    const sy = (H[3] * u + H[4] * v + H[5]) / den;
                    const ix = Math.round(sx), iy = Math.round(sy);
                    if (ix < 0 || iy < 0 || ix >= iw || iy >= ih) continue;
                    const si = (iy * iw + ix) * 4;
                    const di = (y * outW + x) * 4;
                    dd[di] = sd[si];
                    dd[di + 1] = sd[si + 1];
                    dd[di + 2] = sd[si + 2];
                    dd[di + 3] = 255;
                }
            }
            out.putImageData(dst, 0, 0);

            perspCanvas = cv;
            perspCorners = [];
            perspBusy = false;
            baseRev++;
            clearBaseCache();
            buildPyramid();
            buildImagePalette();
            fitImage();
            showHint(null);
            toast('Перспектива исправлена. «Ещё» → вернуть оригинал');
        } catch (e) {
            perspBusy = false;
            perspCorners = [];
            showHint(null);
            invalidate();
            toast('Не удалось выпрямить: изображение защищено CORS или слишком велико');
        }
    }

    // Гомография единичного квадрата → четырёхугольник (Heckbert).
    function squareToQuad(p0, p1, p2, p3) {
        // p0=(0,0) p1=(1,0) p2=(1,1) p3=(0,1)
        const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, sx = p0.x - p1.x + p2.x - p3.x;
        const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, sy = p0.y - p1.y + p2.y - p3.y;
        let g = 0, h = 0;
        if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
            const det = dx1 * dy2 - dx2 * dy1;
            if (Math.abs(det) < 1e-9) return null;
            g = (sx * dy2 - dx2 * sy) / det;
            h = (dx1 * sy - sx * dy1) / det;
        }
        return [
            p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x,
            p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y,
            g, h,
        ];
    }

    function restorePerspective() {
        if (!perspCanvas) { toast('Оригинал уже показан'); return; }
        perspCanvas = null;
        perspCorners = [];
        perspPicking = false;
        baseRev++;
        clearBaseCache();
        buildPyramid();
        buildImagePalette();
        fitImage();
        toast('Показан оригинал');
    }

    // ======================================================================
    // 2.3 / 2.4 Чтение области: текст, QR, штрих-коды
    // ======================================================================
    function normalizeRect(r) {
        const x1 = Math.min(r.x1, r.x2), y1 = Math.min(r.y1, r.y2);
        const x2 = Math.max(r.x1, r.x2), y2 = Math.max(r.y1, r.y2);
        const a = s2i(x1, y1), b = s2i(x2, y2);
        const iw = imageW(), ih = imageH();
        const rx1 = clamp(Math.floor(a.x), 0, iw);
        const ry1 = clamp(Math.floor(a.y), 0, ih);
        const rx2 = clamp(Math.ceil(b.x), 0, iw);
        const ry2 = clamp(Math.ceil(b.y), 0, ih);
        const w = rx2 - rx1, h = ry2 - ry1;
        if (w < 1 || h < 1) return null;
        return { x: rx1, y: ry1, w: w, h: h, sx: x1, sy: y1, sw: x2 - x1, sh: y2 - y1 };
    }

    function drawScanRect(c) {
        if (!scanRect) return;
        const r = normalizeRectScreen(scanRect);
        c.save();
        c.fillStyle = 'rgba(77,163,255,0.14)';
        c.fillRect(r.x, r.y, r.w, r.h);
        c.strokeStyle = '#4da3ff';
        c.lineWidth = 1.5;
        c.setLineDash([6, 4]);
        c.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
        c.setLineDash([]);
        c.restore();
    }

    function normalizeRectScreen(r) {
        const x = Math.min(r.x1, r.x2), y = Math.min(r.y1, r.y2);
        return { x: x, y: y, w: Math.abs(r.x2 - r.x1), h: Math.abs(r.y2 - r.y1) };
    }

    // Пустой обработчик-заглушка: выделение области запускает один из действий
    function startScan() {
        if (!imgEl || !imageW()) { toast('Картинка ещё не загрузилась'); return; }
        scanRect = null;
        scanPick = true;
        if (helpVisible()) toggleHelp(false);
        if (viewEl) viewEl.style.cursor = 'crosshair';
        setToolSilent('move');
        showHint('Протяните рамку вокруг текста или кода, Esc — отмена');
        announce('Выделите прямоугольник вокруг текста или кода');
    }

    function setToolSilent(name) {
        // выделение идёт при любом инструменте, но курсор ставим крестиком
        if (name) { /* no-op: инструмент не меняем */ }
    }

    // Вырезаем область в offscreen-холст (ограниченного размера).
    // Через ensurePixels: на чужой картинке берём CORS-копию, иначе
    // getImageData/toBlob в распознавании текста падают на taint.
    function cropRegion(rect, scaleUp) {
        if (!sourceEl()) return null;
        return ensurePixels().then((src) => {
            if (!src) return null;
            let w = Math.max(1, Math.round(rect.w * (scaleUp || 1)));
            let h = Math.max(1, Math.round(rect.h * (scaleUp || 1)));
            const cap = SCAN_MAX_SIDE;
            if (w > cap || h > cap) {
                const k = cap / Math.max(w, h);
                w = Math.max(1, Math.round(w * k));
                h = Math.max(1, Math.round(h * k));
            }
            // Прямоугольник пришёл в пикселях исходной картинки, а источник
            // может быть копией другого размера — приводим масштаб.
            const iw0 = imageW() || w;
            const ih0 = imageH() || h;
            const sw = src.naturalWidth || src.width || iw0;
            const sh = src.naturalHeight || src.height || ih0;
            const kx = sw / iw0;
            const ky = sh / ih0;
            try {
                const cv = document.createElement('canvas');
                cv.width = w;
                cv.height = h;
                const c = cv.getContext('2d');
                if (!c) return null;
                c.imageSmoothingEnabled = true;
                if (c.imageSmoothingQuality) c.imageSmoothingQuality = 'high';
                c.drawImage(src, rect.x * kx, rect.y * ky, rect.w * kx, rect.h * ky, 0, 0, w, h);
                return cv;
            } catch (e) {
                return null;
            }
        });
    }

    function runScan(rect) {
        const mode = scanMode;
        scanMode = null;
        scanPick = false;
        if (viewEl) viewEl.style.cursor = currentTool === 'move' ? 'grab' : 'crosshair';
        showHint(null);
        requestDraw();

        if (mode === 'qr') detectCodes(rect);
        else readText(rect);
    }

    let scanMode = null;

    // --- 2.4 QR: свой декодер + необязательный BarcodeDetector -------------
    // BarcodeDetector отсутствует в десктопных Chrome и Edge, поэтому
    // QR-коды разбираем сами. jsQR (MIT, (c) Cozmo): на вход RGBA-пиксели,
    // на выходе { data, binaryData, location }. Его UMD-обёртка вешает
    // модуль на self — подменяем self локальным объектом, чтобы ничего
    // не просочилось на страницу.
    var jsQR = (function makeJsQR(){var self={};!function(o,e){"object"==typeof exports&&"object"==typeof module?module.exports=e():"function"==typeof define&&define.amd?define([],e):"object"==typeof exports?exports.jsQR=e():o.jsQR=e()}("undefined"!=typeof self?self:this,(function(){return function(o){var e={};function r(t){if(e[t])return e[t].exports;var c=e[t]={i:t,l:!1,exports:{}};return o[t].call(c.exports,c,c.exports,r),c.l=!0,c.exports}return r.m=o,r.c=e,r.d=function(o,e,t){r.o(o,e)||Object.defineProperty(o,e,{configurable:!1,enumerable:!0,get:t})},r.n=function(o){var e=o&&o.__esModule?function(){return o.default}:function(){return o};return r.d(e,"a",e),e},r.o=function(o,e){return Object.prototype.hasOwnProperty.call(o,e)},r.p="",r(r.s=3)}([function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var t=function(){function o(o,e){this.width=e,this.height=o.length/e,this.data=o}return o.createEmpty=function(e,r){return new o(new Uint8ClampedArray(e*r),e)},o.prototype.get=function(o,e){return!(o<0||o>=this.width||e<0||e>=this.height)&&!!this.data[e*this.width+o]},o.prototype.set=function(o,e,r){this.data[e*this.width+o]=r?1:0},o.prototype.setRegion=function(o,e,r,t,c){for(var s=e;s<e+t;s++)for(var a=o;a<o+r;a++)this.set(a,s,!!c)},o}();e.BitMatrix=t},function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var t=r(2);e.addOrSubtractGF=function(o,e){return o^e};var c=function(){function o(o,e,r){this.primitive=o,this.size=e,this.generatorBase=r,this.expTable=new Array(this.size),this.logTable=new Array(this.size);for(var c=1,s=0;s<this.size;s++)this.expTable[s]=c,(c*=2)>=this.size&&(c=(c^this.primitive)&this.size-1);for(s=0;s<this.size-1;s++)this.logTable[this.expTable[s]]=s;this.zero=new t.default(this,Uint8ClampedArray.from([0])),this.one=new t.default(this,Uint8ClampedArray.from([1]))}return o.prototype.multiply=function(o,e){return 0===o||0===e?0:this.expTable[(this.logTable[o]+this.logTable[e])%(this.size-1)]},o.prototype.inverse=function(o){if(0===o)throw new Error("Can't invert 0");return this.expTable[this.size-this.logTable[o]-1]},o.prototype.buildMonomial=function(o,e){if(o<0)throw new Error("Invalid monomial degree less than 0");if(0===e)return this.zero;var r=new Uint8ClampedArray(o+1);return r[0]=e,new t.default(this,r)},o.prototype.log=function(o){if(0===o)throw new Error("Can't take log(0)");return this.logTable[o]},o.prototype.exp=function(o){return this.expTable[o]},o}();e.default=c},function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var t=r(1),c=function(){function o(o,e){if(0===e.length)throw new Error("No coefficients.");this.field=o;var r=e.length;if(r>1&&0===e[0]){for(var t=1;t<r&&0===e[t];)t++;if(t===r)this.coefficients=o.zero.coefficients;else{this.coefficients=new Uint8ClampedArray(r-t);for(var c=0;c<this.coefficients.length;c++)this.coefficients[c]=e[t+c]}}else this.coefficients=e}return o.prototype.degree=function(){return this.coefficients.length-1},o.prototype.isZero=function(){return 0===this.coefficients[0]},o.prototype.getCoefficient=function(o){return this.coefficients[this.coefficients.length-1-o]},o.prototype.addOrSubtract=function(e){var r;if(this.isZero())return e;if(e.isZero())return this;var c=this.coefficients,s=e.coefficients;c.length>s.length&&(c=(r=[s,c])[0],s=r[1]);for(var a=new Uint8ClampedArray(s.length),n=s.length-c.length,d=0;d<n;d++)a[d]=s[d];for(d=n;d<s.length;d++)a[d]=t.addOrSubtractGF(c[d-n],s[d]);return new o(this.field,a)},o.prototype.multiply=function(e){if(0===e)return this.field.zero;if(1===e)return this;for(var r=this.coefficients.length,t=new Uint8ClampedArray(r),c=0;c<r;c++)t[c]=this.field.multiply(this.coefficients[c],e);return new o(this.field,t)},o.prototype.multiplyPoly=function(e){if(this.isZero()||e.isZero())return this.field.zero;for(var r=this.coefficients,c=r.length,s=e.coefficients,a=s.length,n=new Uint8ClampedArray(c+a-1),d=0;d<c;d++)for(var l=r[d],i=0;i<a;i++)n[d+i]=t.addOrSubtractGF(n[d+i],this.field.multiply(l,s[i]));return new o(this.field,n)},o.prototype.multiplyByMonomial=function(e,r){if(e<0)throw new Error("Invalid degree less than 0");if(0===r)return this.field.zero;for(var t=this.coefficients.length,c=new Uint8ClampedArray(t+e),s=0;s<t;s++)c[s]=this.field.multiply(this.coefficients[s],r);return new o(this.field,c)},o.prototype.evaluateAt=function(o){var e=0;if(0===o)return this.getCoefficient(0);var r=this.coefficients.length;if(1===o)return this.coefficients.forEach((function(o){e=t.addOrSubtractGF(e,o)})),e;e=this.coefficients[0];for(var c=1;c<r;c++)e=t.addOrSubtractGF(this.field.multiply(o,e),this.coefficients[c]);return e},o}();e.default=c},function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var t=r(4),c=r(5),s=r(11),a=r(12);function n(o){var e=a.locate(o);if(!e)return null;for(var r=0,t=e;r<t.length;r++){var n=t[r],d=s.extract(o,n),l=c.decode(d.matrix);if(l)return{binaryData:l.bytes,data:l.text,chunks:l.chunks,version:l.version,location:{topRightCorner:d.mappingFunction(n.dimension,0),topLeftCorner:d.mappingFunction(0,0),bottomRightCorner:d.mappingFunction(n.dimension,n.dimension),bottomLeftCorner:d.mappingFunction(0,n.dimension),topRightFinderPattern:n.topRight,topLeftFinderPattern:n.topLeft,bottomLeftFinderPattern:n.bottomLeft,bottomRightAlignmentPattern:n.alignmentPattern}}}return null}var d={inversionAttempts:"attemptBoth"};function l(o,e,r,c){void 0===c&&(c={});var s=d;Object.keys(s||{}).forEach((function(o){s[o]=c[o]||s[o]}));var a="attemptBoth"===s.inversionAttempts||"invertFirst"===s.inversionAttempts,l="onlyInvert"===s.inversionAttempts||"invertFirst"===s.inversionAttempts,i=t.binarize(o,e,r,a),B=i.binarized,k=i.inverted,u=n(l?k:B);return u||"attemptBoth"!==s.inversionAttempts&&"invertFirst"!==s.inversionAttempts||(u=n(l?B:k)),u}l.default=l,e.default=l},function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var t=r(0);function c(o,e,r){return o<e?e:o>r?r:o}var s=function(){function o(o,e){this.width=o,this.data=new Uint8ClampedArray(o*e)}return o.prototype.get=function(o,e){return this.data[e*this.width+o]},o.prototype.set=function(o,e,r){this.data[e*this.width+o]=r},o}();e.binarize=function(o,e,r,a){if(o.length!==e*r*4)throw new Error("Malformed data passed to binarizer.");for(var n=new s(e,r),d=0;d<e;d++)for(var l=0;l<r;l++){var i=o[4*(l*e+d)+0],B=o[4*(l*e+d)+1],k=o[4*(l*e+d)+2];n.set(d,l,.2126*i+.7152*B+.0722*k)}for(var u=Math.ceil(e/8),C=Math.ceil(r/8),m=new s(u,C),f=0;f<C;f++)for(var w=0;w<u;w++){var P=0,v=1/0,h=0;for(l=0;l<8;l++)for(d=0;d<8;d++){var y=n.get(8*w+d,8*f+l);P+=y,v=Math.min(v,y),h=Math.max(h,y)}var p=P/Math.pow(8,2);if(h-v<=24&&(p=v/2,f>0&&w>0)){var b=(m.get(w,f-1)+2*m.get(w-1,f)+m.get(w-1,f-1))/4;v<b&&(p=b)}m.set(w,f,p)}var g=t.BitMatrix.createEmpty(e,r),x=null;for(a&&(x=t.BitMatrix.createEmpty(e,r)),f=0;f<C;f++)for(w=0;w<u;w++){for(var M=c(w,2,u-3),L=c(f,2,C-3),N=(P=0,-2);N<=2;N++)for(var I=-2;I<=2;I++)P+=m.get(M+N,L+I);var O=P/25;for(N=0;N<8;N++)for(I=0;I<8;I++){d=8*w+N,l=8*f+I;var z=n.get(d,l);g.set(d,l,z<=O),a&&x.set(d,l,!(z<=O))}}return a?{binarized:g,inverted:x}:{binarized:g}}},function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var t=r(0),c=r(6),s=r(9),a=r(10);function n(o,e){for(var r=o^e,t=0;r;)t++,r&=r-1;return t}function d(o,e){return e<<1|o}var l=[{bits:21522,formatInfo:{errorCorrectionLevel:1,dataMask:0}},{bits:20773,formatInfo:{errorCorrectionLevel:1,dataMask:1}},{bits:24188,formatInfo:{errorCorrectionLevel:1,dataMask:2}},{bits:23371,formatInfo:{errorCorrectionLevel:1,dataMask:3}},{bits:17913,formatInfo:{errorCorrectionLevel:1,dataMask:4}},{bits:16590,formatInfo:{errorCorrectionLevel:1,dataMask:5}},{bits:20375,formatInfo:{errorCorrectionLevel:1,dataMask:6}},{bits:19104,formatInfo:{errorCorrectionLevel:1,dataMask:7}},{bits:30660,formatInfo:{errorCorrectionLevel:0,dataMask:0}},{bits:29427,formatInfo:{errorCorrectionLevel:0,dataMask:1}},{bits:32170,formatInfo:{errorCorrectionLevel:0,dataMask:2}},{bits:30877,formatInfo:{errorCorrectionLevel:0,dataMask:3}},{bits:26159,formatInfo:{errorCorrectionLevel:0,dataMask:4}},{bits:25368,formatInfo:{errorCorrectionLevel:0,dataMask:5}},{bits:27713,formatInfo:{errorCorrectionLevel:0,dataMask:6}},{bits:26998,formatInfo:{errorCorrectionLevel:0,dataMask:7}},{bits:5769,formatInfo:{errorCorrectionLevel:3,dataMask:0}},{bits:5054,formatInfo:{errorCorrectionLevel:3,dataMask:1}},{bits:7399,formatInfo:{errorCorrectionLevel:3,dataMask:2}},{bits:6608,formatInfo:{errorCorrectionLevel:3,dataMask:3}},{bits:1890,formatInfo:{errorCorrectionLevel:3,dataMask:4}},{bits:597,formatInfo:{errorCorrectionLevel:3,dataMask:5}},{bits:3340,formatInfo:{errorCorrectionLevel:3,dataMask:6}},{bits:2107,formatInfo:{errorCorrectionLevel:3,dataMask:7}},{bits:13663,formatInfo:{errorCorrectionLevel:2,dataMask:0}},{bits:12392,formatInfo:{errorCorrectionLevel:2,dataMask:1}},{bits:16177,formatInfo:{errorCorrectionLevel:2,dataMask:2}},{bits:14854,formatInfo:{errorCorrectionLevel:2,dataMask:3}},{bits:9396,formatInfo:{errorCorrectionLevel:2,dataMask:4}},{bits:8579,formatInfo:{errorCorrectionLevel:2,dataMask:5}},{bits:11994,formatInfo:{errorCorrectionLevel:2,dataMask:6}},{bits:11245,formatInfo:{errorCorrectionLevel:2,dataMask:7}}],i=[function(o){return(o.y+o.x)%2==0},function(o){return o.y%2==0},function(o){return o.x%3==0},function(o){return(o.y+o.x)%3==0},function(o){return(Math.floor(o.y/2)+Math.floor(o.x/3))%2==0},function(o){return o.x*o.y%2+o.x*o.y%3==0},function(o){return(o.y*o.x%2+o.y*o.x%3)%2==0},function(o){return((o.y+o.x)%2+o.y*o.x%3)%2==0}];function B(o,e,r){for(var c=i[r.dataMask],s=o.height,a=function(o){var e=17+4*o.versionNumber,r=t.BitMatrix.createEmpty(e,e);r.setRegion(0,0,9,9,!0),r.setRegion(e-8,0,8,9,!0),r.setRegion(0,e-8,9,8,!0);for(var c=0,s=o.alignmentPatternCenters;c<s.length;c++)for(var a=s[c],n=0,d=o.alignmentPatternCenters;n<d.length;n++){var l=d[n];6===a&&6===l||6===a&&l===e-7||a===e-7&&6===l||r.setRegion(a-2,l-2,5,5,!0)}return r.setRegion(6,9,1,e-17,!0),r.setRegion(9,6,e-17,1,!0),o.versionNumber>6&&(r.setRegion(e-11,0,3,6,!0),r.setRegion(0,e-11,6,3,!0)),r}(e),n=[],l=0,B=0,k=!0,u=s-1;u>0;u-=2){6===u&&u--;for(var C=0;C<s;C++)for(var m=k?s-1-C:C,f=0;f<2;f++){var w=u-f;if(!a.get(w,m)){B++;var P=o.get(w,m);c({y:m,x:w})&&(P=!P),l=d(P,l),8===B&&(n.push(l),B=0,l=0)}}k=!k}return n}function k(o){var e=function(o){var e=o.height,r=Math.floor((e-17)/4);if(r<=6)return a.VERSIONS[r-1];for(var t=0,c=5;c>=0;c--)for(var s=e-9;s>=e-11;s--)t=d(o.get(s,c),t);var l=0;for(s=5;s>=0;s--)for(c=e-9;c>=e-11;c--)l=d(o.get(s,c),l);for(var i,B=1/0,k=0,u=a.VERSIONS;k<u.length;k++){var C=u[k];if(C.infoBits===t||C.infoBits===l)return C;var m=n(t,C.infoBits);m<B&&(i=C,B=m),(m=n(l,C.infoBits))<B&&(i=C,B=m)}return B<=3?i:void 0}(o);if(!e)return null;var r=function(o){for(var e=0,r=0;r<=8;r++)6!==r&&(e=d(o.get(r,8),e));for(var t=7;t>=0;t--)6!==t&&(e=d(o.get(8,t),e));var c=o.height,s=0;for(t=c-1;t>=c-7;t--)s=d(o.get(8,t),s);for(r=c-8;r<c;r++)s=d(o.get(r,8),s);for(var a=1/0,i=null,B=0,k=l;B<k.length;B++){var u=k[B],C=u.bits,m=u.formatInfo;if(C===e||C===s)return m;var f=n(e,C);f<a&&(i=m,a=f),e!==s&&(f=n(s,C))<a&&(i=m,a=f)}return a<=3?i:null}(o);if(!r)return null;var t=function(o,e,r){var t=e.errorCorrectionLevels[r],c=[],s=0;if(t.ecBlocks.forEach((function(o){for(var e=0;e<o.numBlocks;e++)c.push({numDataCodewords:o.dataCodewordsPerBlock,codewords:[]}),s+=o.dataCodewordsPerBlock+t.ecCodewordsPerBlock})),o.length<s)return null;o=o.slice(0,s);for(var a=t.ecBlocks[0].dataCodewordsPerBlock,n=0;n<a;n++)for(var d=0,l=c;d<l.length;d++)l[d].codewords.push(o.shift());if(t.ecBlocks.length>1){var i=t.ecBlocks[0].numBlocks,B=t.ecBlocks[1].numBlocks;for(n=0;n<B;n++)c[i+n].codewords.push(o.shift())}for(;o.length>0;)for(var k=0,u=c;k<u.length;k++)u[k].codewords.push(o.shift());return c}(B(o,e,r),e,r.errorCorrectionLevel);if(!t)return null;for(var i=t.reduce((function(o,e){return o+e.numDataCodewords}),0),k=new Uint8ClampedArray(i),u=0,C=0,m=t;C<m.length;C++){var f=m[C],w=s.decode(f.codewords,f.codewords.length-f.numDataCodewords);if(!w)return null;for(var P=0;P<f.numDataCodewords;P++)k[u++]=w[P]}try{return c.decode(k,e.versionNumber)}catch(o){return null}}e.decode=function(o){if(null==o)return null;var e=k(o);if(e)return e;for(var r=0;r<o.width;r++)for(var t=r+1;t<o.height;t++)o.get(r,t)!==o.get(t,r)&&(o.set(r,t,!o.get(r,t)),o.set(t,r,!o.get(t,r)));return k(o)}},function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var t,c,s=r(7),a=r(8);function n(o,e){for(var r=[],t="",c=[10,12,14][e],s=o.readBits(c);s>=3;){if((l=o.readBits(10))>=1e3)throw new Error("Invalid numeric value above 999");var a=Math.floor(l/100),n=Math.floor(l/10)%10,d=l%10;r.push(48+a,48+n,48+d),t+=a.toString()+n.toString()+d.toString(),s-=3}if(2===s){if((l=o.readBits(7))>=100)throw new Error("Invalid numeric value above 99");a=Math.floor(l/10),n=l%10;r.push(48+a,48+n),t+=a.toString()+n.toString()}else if(1===s){var l;if((l=o.readBits(4))>=10)throw new Error("Invalid numeric value above 9");r.push(48+l),t+=l.toString()}return{bytes:r,text:t}}!function(o){o.Numeric="numeric",o.Alphanumeric="alphanumeric",o.Byte="byte",o.Kanji="kanji",o.ECI="eci"}(t=e.Mode||(e.Mode={})),function(o){o[o.Terminator=0]="Terminator",o[o.Numeric=1]="Numeric",o[o.Alphanumeric=2]="Alphanumeric",o[o.Byte=4]="Byte",o[o.Kanji=8]="Kanji",o[o.ECI=7]="ECI"}(c||(c={}));var d=["0","1","2","3","4","5","6","7","8","9","A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V","W","X","Y","Z"," ","$","%","*","+","-",".","/",":"];function l(o,e){for(var r=[],t="",c=[9,11,13][e],s=o.readBits(c);s>=2;){var a=o.readBits(11),n=Math.floor(a/45),l=a%45;r.push(d[n].charCodeAt(0),d[l].charCodeAt(0)),t+=d[n]+d[l],s-=2}if(1===s){n=o.readBits(6);r.push(d[n].charCodeAt(0)),t+=d[n]}return{bytes:r,text:t}}function i(o,e){for(var r=[],t="",c=[8,16,16][e],s=o.readBits(c),a=0;a<s;a++){var n=o.readBits(8);r.push(n)}try{t+=decodeURIComponent(r.map((function(o){return"%"+("0"+o.toString(16)).substr(-2)})).join(""))}catch(o){}return{bytes:r,text:t}}function B(o,e){for(var r=[],t="",c=[8,10,12][e],s=o.readBits(c),n=0;n<s;n++){var d=o.readBits(13),l=Math.floor(d/192)<<8|d%192;l+=l<7936?33088:49472,r.push(l>>8,255&l),t+=String.fromCharCode(a.shiftJISTable[l])}return{bytes:r,text:t}}e.decode=function(o,e){for(var r,a,d,k,u=new s.BitStream(o),C=e<=9?0:e<=26?1:2,m={text:"",bytes:[],chunks:[],version:e};u.available()>=4;){var f=u.readBits(4);if(f===c.Terminator)return m;if(f===c.ECI)0===u.readBits(1)?m.chunks.push({type:t.ECI,assignmentNumber:u.readBits(7)}):0===u.readBits(1)?m.chunks.push({type:t.ECI,assignmentNumber:u.readBits(14)}):0===u.readBits(1)?m.chunks.push({type:t.ECI,assignmentNumber:u.readBits(21)}):m.chunks.push({type:t.ECI,assignmentNumber:-1});else if(f===c.Numeric){var w=n(u,C);m.text+=w.text,(r=m.bytes).push.apply(r,w.bytes),m.chunks.push({type:t.Numeric,text:w.text})}else if(f===c.Alphanumeric){var P=l(u,C);m.text+=P.text,(a=m.bytes).push.apply(a,P.bytes),m.chunks.push({type:t.Alphanumeric,text:P.text})}else if(f===c.Byte){var v=i(u,C);m.text+=v.text,(d=m.bytes).push.apply(d,v.bytes),m.chunks.push({type:t.Byte,bytes:v.bytes,text:v.text})}else if(f===c.Kanji){var h=B(u,C);m.text+=h.text,(k=m.bytes).push.apply(k,h.bytes),m.chunks.push({type:t.Kanji,bytes:h.bytes,text:h.text})}}if(0===u.available()||0===u.readBits(u.available()))return m}},function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var t=function(){function o(o){this.byteOffset=0,this.bitOffset=0,this.bytes=o}return o.prototype.readBits=function(o){if(o<1||o>32||o>this.available())throw new Error("Cannot read "+o.toString()+" bits");var e=0;if(this.bitOffset>0){var r=8-this.bitOffset,t=o<r?o:r,c=255>>8-t<<(s=r-t);e=(this.bytes[this.byteOffset]&c)>>s,o-=t,this.bitOffset+=t,8===this.bitOffset&&(this.bitOffset=0,this.byteOffset++)}if(o>0){for(;o>=8;)e=e<<8|255&this.bytes[this.byteOffset],this.byteOffset++,o-=8;if(o>0){var s;c=255>>(s=8-o)<<s;e=e<<o|(this.bytes[this.byteOffset]&c)>>s,this.bitOffset+=o}}return e},o.prototype.available=function(){return 8*(this.bytes.length-this.byteOffset)-this.bitOffset},o}();e.BitStream=t},function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.shiftJISTable={32:32,33:33,34:34,35:35,36:36,37:37,38:38,39:39,40:40,41:41,42:42,43:43,44:44,45:45,46:46,47:47,48:48,49:49,50:50,51:51,52:52,53:53,54:54,55:55,56:56,57:57,58:58,59:59,60:60,61:61,62:62,63:63,64:64,65:65,66:66,67:67,68:68,69:69,70:70,71:71,72:72,73:73,74:74,75:75,76:76,77:77,78:78,79:79,80:80,81:81,82:82,83:83,84:84,85:85,86:86,87:87,88:88,89:89,90:90,91:91,92:165,93:93,94:94,95:95,96:96,97:97,98:98,99:99,100:100,101:101,102:102,103:103,104:104,105:105,106:106,107:107,108:108,109:109,110:110,111:111,112:112,113:113,114:114,115:115,116:116,117:117,118:118,119:119,120:120,121:121,122:122,123:123,124:124,125:125,126:8254,33088:12288,33089:12289,33090:12290,33091:65292,33092:65294,33093:12539,33094:65306,33095:65307,33096:65311,33097:65281,33098:12443,33099:12444,33100:180,33101:65344,33102:168,33103:65342,33104:65507,33105:65343,33106:12541,33107:12542,33108:12445,33109:12446,33110:12291,33111:20189,33112:12293,33113:12294,33114:12295,33115:12540,33116:8213,33117:8208,33118:65295,33119:92,33120:12316,33121:8214,33122:65372,33123:8230,33124:8229,33125:8216,33126:8217,33127:8220,33128:8221,33129:65288,33130:65289,33131:12308,33132:12309,33133:65339,33134:65341,33135:65371,33136:65373,33137:12296,33138:12297,33139:12298,33140:12299,33141:12300,33142:12301,33143:12302,33144:12303,33145:12304,33146:12305,33147:65291,33148:8722,33149:177,33150:215,33152:247,33153:65309,33154:8800,33155:65308,33156:65310,33157:8806,33158:8807,33159:8734,33160:8756,33161:9794,33162:9792,33163:176,33164:8242,33165:8243,33166:8451,33167:65509,33168:65284,33169:162,33170:163,33171:65285,33172:65283,33173:65286,33174:65290,33175:65312,33176:167,33177:9734,33178:9733,33179:9675,33180:9679,33181:9678,33182:9671,33183:9670,33184:9633,33185:9632,33186:9651,33187:9650,33188:9661,33189:9660,33190:8251,33191:12306,33192:8594,33193:8592,33194:8593,33195:8595,33196:12307,33208:8712,33209:8715,33210:8838,33211:8839,33212:8834,33213:8835,33214:8746,33215:8745,33224:8743,33225:8744,33226:172,33227:8658,33228:8660,33229:8704,33230:8707,33242:8736,33243:8869,33244:8978,33245:8706,33246:8711,33247:8801,33248:8786,33249:8810,33250:8811,33251:8730,33252:8765,33253:8733,33254:8757,33255:8747,33256:8748,33264:8491,33265:8240,33266:9839,33267:9837,33268:9834,33269:8224,33270:8225,33271:182,33276:9711,33359:65296,33360:65297,33361:65298,33362:65299,33363:65300,33364:65301,33365:65302,33366:65303,33367:65304,33368:65305,33376:65313,33377:65314,33378:65315,33379:65316,33380:65317,33381:65318,33382:65319,33383:65320,33384:65321,33385:65322,33386:65323,33387:65324,33388:65325,33389:65326,33390:65327,33391:65328,33392:65329,33393:65330,33394:65331,33395:65332,33396:65333,33397:65334,33398:65335,33399:65336,33400:65337,33401:65338,33409:65345,33410:65346,33411:65347,33412:65348,33413:65349,33414:65350,33415:65351,33416:65352,33417:65353,33418:65354,33419:65355,33420:65356,33421:65357,33422:65358,33423:65359,33424:65360,33425:65361,33426:65362,33427:65363,33428:65364,33429:65365,33430:65366,33431:65367,33432:65368,33433:65369,33434:65370,33439:12353,33440:12354,33441:12355,33442:12356,33443:12357,33444:12358,33445:12359,33446:12360,33447:12361,33448:12362,33449:12363,33450:12364,33451:12365,33452:12366,33453:12367,33454:12368,33455:12369,33456:12370,33457:12371,33458:12372,33459:12373,33460:12374,33461:12375,33462:12376,33463:12377,33464:12378,33465:12379,33466:12380,33467:12381,33468:12382,33469:12383,33470:12384,33471:12385,33472:12386,33473:12387,33474:12388,33475:12389,33476:12390,33477:12391,33478:12392,33479:12393,33480:12394,33481:12395,33482:12396,33483:12397,33484:12398,33485:12399,33486:12400,33487:12401,33488:12402,33489:12403,33490:12404,33491:12405,33492:12406,33493:12407,33494:12408,33495:12409,33496:12410,33497:12411,33498:12412,33499:12413,33500:12414,33501:12415,33502:12416,33503:12417,33504:12418,33505:12419,33506:12420,33507:12421,33508:12422,33509:12423,33510:12424,33511:12425,33512:12426,33513:12427,33514:12428,33515:12429,33516:12430,33517:12431,33518:12432,33519:12433,33520:12434,33521:12435,33600:12449,33601:12450,33602:12451,33603:12452,33604:12453,33605:12454,33606:12455,33607:12456,33608:12457,33609:12458,33610:12459,33611:12460,33612:12461,33613:12462,33614:12463,33615:12464,33616:12465,33617:12466,33618:12467,33619:12468,33620:12469,33621:12470,33622:12471,33623:12472,33624:12473,33625:12474,33626:12475,33627:12476,33628:12477,33629:12478,33630:12479,33631:12480,33632:12481,33633:12482,33634:12483,33635:12484,33636:12485,33637:12486,33638:12487,33639:12488,33640:12489,33641:12490,33642:12491,33643:12492,33644:12493,33645:12494,33646:12495,33647:12496,33648:12497,33649:12498,33650:12499,33651:12500,33652:12501,33653:12502,33654:12503,33655:12504,33656:12505,33657:12506,33658:12507,33659:12508,33660:12509,33661:12510,33662:12511,33664:12512,33665:12513,33666:12514,33667:12515,33668:12516,33669:12517,33670:12518,33671:12519,33672:12520,33673:12521,33674:12522,33675:12523,33676:12524,33677:12525,33678:12526,33679:12527,33680:12528,33681:12529,33682:12530,33683:12531,33684:12532,33685:12533,33686:12534,33695:913,33696:914,33697:915,33698:916,33699:917,33700:918,33701:919,33702:920,33703:921,33704:922,33705:923,33706:924,33707:925,33708:926,33709:927,33710:928,33711:929,33712:931,33713:932,33714:933,33715:934,33716:935,33717:936,33718:937,33727:945,33728:946,33729:947,33730:948,33731:949,33732:950,33733:951,33734:952,33735:953,33736:954,33737:955,33738:956,33739:957,33740:958,33741:959,33742:960,33743:961,33744:963,33745:964,33746:965,33747:966,33748:967,33749:968,33750:969,33856:1040,33857:1041,33858:1042,33859:1043,33860:1044,33861:1045,33862:1025,33863:1046,33864:1047,33865:1048,33866:1049,33867:1050,33868:1051,33869:1052,33870:1053,33871:1054,33872:1055,33873:1056,33874:1057,33875:1058,33876:1059,33877:1060,33878:1061,33879:1062,33880:1063,33881:1064,33882:1065,33883:1066,33884:1067,33885:1068,33886:1069,33887:1070,33888:1071,33904:1072,33905:1073,33906:1074,33907:1075,33908:1076,33909:1077,33910:1105,33911:1078,33912:1079,33913:1080,33914:1081,33915:1082,33916:1083,33917:1084,33918:1085,33920:1086,33921:1087,33922:1088,33923:1089,33924:1090,33925:1091,33926:1092,33927:1093,33928:1094,33929:1095,33930:1096,33931:1097,33932:1098,33933:1099,33934:1100,33935:1101,33936:1102,33937:1103,33951:9472,33952:9474,33953:9484,33954:9488,33955:9496,33956:9492,33957:9500,33958:9516,33959:9508,33960:9524,33961:9532,33962:9473,33963:9475,33964:9487,33965:9491,33966:9499,33967:9495,33968:9507,33969:9523,33970:9515,33971:9531,33972:9547,33973:9504,33974:9519,33975:9512,33976:9527,33977:9535,33978:9501,33979:9520,33980:9509,33981:9528,33982:9538,34975:20124,34976:21782,34977:23043,34978:38463,34979:21696,34980:24859,34981:25384,34982:23030,34983:36898,34984:33909,34985:33564,34986:31312,34987:24746,34988:25569,34989:28197,34990:26093,34991:33894,34992:33446,34993:39925,34994:26771,34995:22311,34996:26017,34997:25201,34998:23451,34999:22992,35e3:34427,35001:39156,35002:32098,35003:32190,35004:39822,35005:25110,35006:31903,35007:34999,35008:23433,35009:24245,35010:25353,35011:26263,35012:26696,35013:38343,35014:38797,35015:26447,35016:20197,35017:20234,35018:20301,35019:20381,35020:20553,35021:22258,35022:22839,35023:22996,35024:23041,35025:23561,35026:24799,35027:24847,35028:24944,35029:26131,35030:26885,35031:28858,35032:30031,35033:30064,35034:31227,35035:32173,35036:32239,35037:32963,35038:33806,35039:34915,35040:35586,35041:36949,35042:36986,35043:21307,35044:20117,35045:20133,35046:22495,35047:32946,35048:37057,35049:30959,35050:19968,35051:22769,35052:28322,35053:36920,35054:31282,35055:33576,35056:33419,35057:39983,35058:20801,35059:21360,35060:21693,35061:21729,35062:22240,35063:23035,35064:24341,35065:39154,35066:28139,35067:32996,35068:34093,35136:38498,35137:38512,35138:38560,35139:38907,35140:21515,35141:21491,35142:23431,35143:28879,35144:32701,35145:36802,35146:38632,35147:21359,35148:40284,35149:31418,35150:19985,35151:30867,35152:33276,35153:28198,35154:22040,35155:21764,35156:27421,35157:34074,35158:39995,35159:23013,35160:21417,35161:28006,35162:29916,35163:38287,35164:22082,35165:20113,35166:36939,35167:38642,35168:33615,35169:39180,35170:21473,35171:21942,35172:23344,35173:24433,35174:26144,35175:26355,35176:26628,35177:27704,35178:27891,35179:27945,35180:29787,35181:30408,35182:31310,35183:38964,35184:33521,35185:34907,35186:35424,35187:37613,35188:28082,35189:30123,35190:30410,35191:39365,35192:24742,35193:35585,35194:36234,35195:38322,35196:27022,35197:21421,35198:20870,35200:22290,35201:22576,35202:22852,35203:23476,35204:24310,35205:24616,35206:25513,35207:25588,35208:27839,35209:28436,35210:28814,35211:28948,35212:29017,35213:29141,35214:29503,35215:32257,35216:33398,35217:33489,35218:34199,35219:36960,35220:37467,35221:40219,35222:22633,35223:26044,35224:27738,35225:29989,35226:20985,35227:22830,35228:22885,35229:24448,35230:24540,35231:25276,35232:26106,35233:27178,35234:27431,35235:27572,35236:29579,35237:32705,35238:35158,35239:40236,35240:40206,35241:40644,35242:23713,35243:27798,35244:33659,35245:20740,35246:23627,35247:25014,35248:33222,35249:26742,35250:29281,35251:20057,35252:20474,35253:21368,35254:24681,35255:28201,35256:31311,35257:38899,35258:19979,35259:21270,35260:20206,35261:20309,35262:20285,35263:20385,35264:20339,35265:21152,35266:21487,35267:22025,35268:22799,35269:23233,35270:23478,35271:23521,35272:31185,35273:26247,35274:26524,35275:26550,35276:27468,35277:27827,35278:28779,35279:29634,35280:31117,35281:31166,35282:31292,35283:31623,35284:33457,35285:33499,35286:33540,35287:33655,35288:33775,35289:33747,35290:34662,35291:35506,35292:22057,35293:36008,35294:36838,35295:36942,35296:38686,35297:34442,35298:20420,35299:23784,35300:25105,35301:29273,35302:30011,35303:33253,35304:33469,35305:34558,35306:36032,35307:38597,35308:39187,35309:39381,35310:20171,35311:20250,35312:35299,35313:22238,35314:22602,35315:22730,35316:24315,35317:24555,35318:24618,35319:24724,35320:24674,35321:25040,35322:25106,35323:25296,35324:25913,35392:39745,35393:26214,35394:26800,35395:28023,35396:28784,35397:30028,35398:30342,35399:32117,35400:33445,35401:34809,35402:38283,35403:38542,35404:35997,35405:20977,35406:21182,35407:22806,35408:21683,35409:23475,35410:23830,35411:24936,35412:27010,35413:28079,35414:30861,35415:33995,35416:34903,35417:35442,35418:37799,35419:39608,35420:28012,35421:39336,35422:34521,35423:22435,35424:26623,35425:34510,35426:37390,35427:21123,35428:22151,35429:21508,35430:24275,35431:25313,35432:25785,35433:26684,35434:26680,35435:27579,35436:29554,35437:30906,35438:31339,35439:35226,35440:35282,35441:36203,35442:36611,35443:37101,35444:38307,35445:38548,35446:38761,35447:23398,35448:23731,35449:27005,35450:38989,35451:38990,35452:25499,35453:31520,35454:27179,35456:27263,35457:26806,35458:39949,35459:28511,35460:21106,35461:21917,35462:24688,35463:25324,35464:27963,35465:28167,35466:28369,35467:33883,35468:35088,35469:36676,35470:19988,35471:39993,35472:21494,35473:26907,35474:27194,35475:38788,35476:26666,35477:20828,35478:31427,35479:33970,35480:37340,35481:37772,35482:22107,35483:40232,35484:26658,35485:33541,35486:33841,35487:31909,35488:21e3,35489:33477,35490:29926,35491:20094,35492:20355,35493:20896,35494:23506,35495:21002,35496:21208,35497:21223,35498:24059,35499:21914,35500:22570,35501:23014,35502:23436,35503:23448,35504:23515,35505:24178,35506:24185,35507:24739,35508:24863,35509:24931,35510:25022,35511:25563,35512:25954,35513:26577,35514:26707,35515:26874,35516:27454,35517:27475,35518:27735,35519:28450,35520:28567,35521:28485,35522:29872,35523:29976,35524:30435,35525:30475,35526:31487,35527:31649,35528:31777,35529:32233,35530:32566,35531:32752,35532:32925,35533:33382,35534:33694,35535:35251,35536:35532,35537:36011,35538:36996,35539:37969,35540:38291,35541:38289,35542:38306,35543:38501,35544:38867,35545:39208,35546:33304,35547:20024,35548:21547,35549:23736,35550:24012,35551:29609,35552:30284,35553:30524,35554:23721,35555:32747,35556:36107,35557:38593,35558:38929,35559:38996,35560:39e3,35561:20225,35562:20238,35563:21361,35564:21916,35565:22120,35566:22522,35567:22855,35568:23305,35569:23492,35570:23696,35571:24076,35572:24190,35573:24524,35574:25582,35575:26426,35576:26071,35577:26082,35578:26399,35579:26827,35580:26820,35648:27231,35649:24112,35650:27589,35651:27671,35652:27773,35653:30079,35654:31048,35655:23395,35656:31232,35657:32e3,35658:24509,35659:35215,35660:35352,35661:36020,35662:36215,35663:36556,35664:36637,35665:39138,35666:39438,35667:39740,35668:20096,35669:20605,35670:20736,35671:22931,35672:23452,35673:25135,35674:25216,35675:25836,35676:27450,35677:29344,35678:30097,35679:31047,35680:32681,35681:34811,35682:35516,35683:35696,35684:25516,35685:33738,35686:38816,35687:21513,35688:21507,35689:21931,35690:26708,35691:27224,35692:35440,35693:30759,35694:26485,35695:40653,35696:21364,35697:23458,35698:33050,35699:34384,35700:36870,35701:19992,35702:20037,35703:20167,35704:20241,35705:21450,35706:21560,35707:23470,35708:24339,35709:24613,35710:25937,35712:26429,35713:27714,35714:27762,35715:27875,35716:28792,35717:29699,35718:31350,35719:31406,35720:31496,35721:32026,35722:31998,35723:32102,35724:26087,35725:29275,35726:21435,35727:23621,35728:24040,35729:25298,35730:25312,35731:25369,35732:28192,35733:34394,35734:35377,35735:36317,35736:37624,35737:28417,35738:31142,35739:39770,35740:20136,35741:20139,35742:20140,35743:20379,35744:20384,35745:20689,35746:20807,35747:31478,35748:20849,35749:20982,35750:21332,35751:21281,35752:21375,35753:21483,35754:21932,35755:22659,35756:23777,35757:24375,35758:24394,35759:24623,35760:24656,35761:24685,35762:25375,35763:25945,35764:27211,35765:27841,35766:29378,35767:29421,35768:30703,35769:33016,35770:33029,35771:33288,35772:34126,35773:37111,35774:37857,35775:38911,35776:39255,35777:39514,35778:20208,35779:20957,35780:23597,35781:26241,35782:26989,35783:23616,35784:26354,35785:26997,35786:29577,35787:26704,35788:31873,35789:20677,35790:21220,35791:22343,35792:24062,35793:37670,35794:26020,35795:27427,35796:27453,35797:29748,35798:31105,35799:31165,35800:31563,35801:32202,35802:33465,35803:33740,35804:34943,35805:35167,35806:35641,35807:36817,35808:37329,35809:21535,35810:37504,35811:20061,35812:20534,35813:21477,35814:21306,35815:29399,35816:29590,35817:30697,35818:33510,35819:36527,35820:39366,35821:39368,35822:39378,35823:20855,35824:24858,35825:34398,35826:21936,35827:31354,35828:20598,35829:23507,35830:36935,35831:38533,35832:20018,35833:27355,35834:37351,35835:23633,35836:23624,35904:25496,35905:31391,35906:27795,35907:38772,35908:36705,35909:31402,35910:29066,35911:38536,35912:31874,35913:26647,35914:32368,35915:26705,35916:37740,35917:21234,35918:21531,35919:34219,35920:35347,35921:32676,35922:36557,35923:37089,35924:21350,35925:34952,35926:31041,35927:20418,35928:20670,35929:21009,35930:20804,35931:21843,35932:22317,35933:29674,35934:22411,35935:22865,35936:24418,35937:24452,35938:24693,35939:24950,35940:24935,35941:25001,35942:25522,35943:25658,35944:25964,35945:26223,35946:26690,35947:28179,35948:30054,35949:31293,35950:31995,35951:32076,35952:32153,35953:32331,35954:32619,35955:33550,35956:33610,35957:34509,35958:35336,35959:35427,35960:35686,35961:36605,35962:38938,35963:40335,35964:33464,35965:36814,35966:39912,35968:21127,35969:25119,35970:25731,35971:28608,35972:38553,35973:26689,35974:20625,35975:27424,35976:27770,35977:28500,35978:31348,35979:32080,35980:34880,35981:35363,35982:26376,35983:20214,35984:20537,35985:20518,35986:20581,35987:20860,35988:21048,35989:21091,35990:21927,35991:22287,35992:22533,35993:23244,35994:24314,35995:25010,35996:25080,35997:25331,35998:25458,35999:26908,36e3:27177,36001:29309,36002:29356,36003:29486,36004:30740,36005:30831,36006:32121,36007:30476,36008:32937,36009:35211,36010:35609,36011:36066,36012:36562,36013:36963,36014:37749,36015:38522,36016:38997,36017:39443,36018:40568,36019:20803,36020:21407,36021:21427,36022:24187,36023:24358,36024:28187,36025:28304,36026:29572,36027:29694,36028:32067,36029:33335,36030:35328,36031:35578,36032:38480,36033:20046,36034:20491,36035:21476,36036:21628,36037:22266,36038:22993,36039:23396,36040:24049,36041:24235,36042:24359,36043:25144,36044:25925,36045:26543,36046:28246,36047:29392,36048:31946,36049:34996,36050:32929,36051:32993,36052:33776,36053:34382,36054:35463,36055:36328,36056:37431,36057:38599,36058:39015,36059:40723,36060:20116,36061:20114,36062:20237,36063:21320,36064:21577,36065:21566,36066:23087,36067:24460,36068:24481,36069:24735,36070:26791,36071:27278,36072:29786,36073:30849,36074:35486,36075:35492,36076:35703,36077:37264,36078:20062,36079:39881,36080:20132,36081:20348,36082:20399,36083:20505,36084:20502,36085:20809,36086:20844,36087:21151,36088:21177,36089:21246,36090:21402,36091:21475,36092:21521,36160:21518,36161:21897,36162:22353,36163:22434,36164:22909,36165:23380,36166:23389,36167:23439,36168:24037,36169:24039,36170:24055,36171:24184,36172:24195,36173:24218,36174:24247,36175:24344,36176:24658,36177:24908,36178:25239,36179:25304,36180:25511,36181:25915,36182:26114,36183:26179,36184:26356,36185:26477,36186:26657,36187:26775,36188:27083,36189:27743,36190:27946,36191:28009,36192:28207,36193:28317,36194:30002,36195:30343,36196:30828,36197:31295,36198:31968,36199:32005,36200:32024,36201:32094,36202:32177,36203:32789,36204:32771,36205:32943,36206:32945,36207:33108,36208:33167,36209:33322,36210:33618,36211:34892,36212:34913,36213:35611,36214:36002,36215:36092,36216:37066,36217:37237,36218:37489,36219:30783,36220:37628,36221:38308,36222:38477,36224:38917,36225:39321,36226:39640,36227:40251,36228:21083,36229:21163,36230:21495,36231:21512,36232:22741,36233:25335,36234:28640,36235:35946,36236:36703,36237:40633,36238:20811,36239:21051,36240:21578,36241:22269,36242:31296,36243:37239,36244:40288,36245:40658,36246:29508,36247:28425,36248:33136,36249:29969,36250:24573,36251:24794,36252:39592,36253:29403,36254:36796,36255:27492,36256:38915,36257:20170,36258:22256,36259:22372,36260:22718,36261:23130,36262:24680,36263:25031,36264:26127,36265:26118,36266:26681,36267:26801,36268:28151,36269:30165,36270:32058,36271:33390,36272:39746,36273:20123,36274:20304,36275:21449,36276:21766,36277:23919,36278:24038,36279:24046,36280:26619,36281:27801,36282:29811,36283:30722,36284:35408,36285:37782,36286:35039,36287:22352,36288:24231,36289:25387,36290:20661,36291:20652,36292:20877,36293:26368,36294:21705,36295:22622,36296:22971,36297:23472,36298:24425,36299:25165,36300:25505,36301:26685,36302:27507,36303:28168,36304:28797,36305:37319,36306:29312,36307:30741,36308:30758,36309:31085,36310:25998,36311:32048,36312:33756,36313:35009,36314:36617,36315:38555,36316:21092,36317:22312,36318:26448,36319:32618,36320:36001,36321:20916,36322:22338,36323:38442,36324:22586,36325:27018,36326:32948,36327:21682,36328:23822,36329:22524,36330:30869,36331:40442,36332:20316,36333:21066,36334:21643,36335:25662,36336:26152,36337:26388,36338:26613,36339:31364,36340:31574,36341:32034,36342:37679,36343:26716,36344:39853,36345:31545,36346:21273,36347:20874,36348:21047,36416:23519,36417:25334,36418:25774,36419:25830,36420:26413,36421:27578,36422:34217,36423:38609,36424:30352,36425:39894,36426:25420,36427:37638,36428:39851,36429:30399,36430:26194,36431:19977,36432:20632,36433:21442,36434:23665,36435:24808,36436:25746,36437:25955,36438:26719,36439:29158,36440:29642,36441:29987,36442:31639,36443:32386,36444:34453,36445:35715,36446:36059,36447:37240,36448:39184,36449:26028,36450:26283,36451:27531,36452:20181,36453:20180,36454:20282,36455:20351,36456:21050,36457:21496,36458:21490,36459:21987,36460:22235,36461:22763,36462:22987,36463:22985,36464:23039,36465:23376,36466:23629,36467:24066,36468:24107,36469:24535,36470:24605,36471:25351,36472:25903,36473:23388,36474:26031,36475:26045,36476:26088,36477:26525,36478:27490,36480:27515,36481:27663,36482:29509,36483:31049,36484:31169,36485:31992,36486:32025,36487:32043,36488:32930,36489:33026,36490:33267,36491:35222,36492:35422,36493:35433,36494:35430,36495:35468,36496:35566,36497:36039,36498:36060,36499:38604,36500:39164,36501:27503,36502:20107,36503:20284,36504:20365,36505:20816,36506:23383,36507:23546,36508:24904,36509:25345,36510:26178,36511:27425,36512:28363,36513:27835,36514:29246,36515:29885,36516:30164,36517:30913,36518:31034,36519:32780,36520:32819,36521:33258,36522:33940,36523:36766,36524:27728,36525:40575,36526:24335,36527:35672,36528:40235,36529:31482,36530:36600,36531:23437,36532:38635,36533:19971,36534:21489,36535:22519,36536:22833,36537:23241,36538:23460,36539:24713,36540:28287,36541:28422,36542:30142,36543:36074,36544:23455,36545:34048,36546:31712,36547:20594,36548:26612,36549:33437,36550:23649,36551:34122,36552:32286,36553:33294,36554:20889,36555:23556,36556:25448,36557:36198,36558:26012,36559:29038,36560:31038,36561:32023,36562:32773,36563:35613,36564:36554,36565:36974,36566:34503,36567:37034,36568:20511,36569:21242,36570:23610,36571:26451,36572:28796,36573:29237,36574:37196,36575:37320,36576:37675,36577:33509,36578:23490,36579:24369,36580:24825,36581:20027,36582:21462,36583:23432,36584:25163,36585:26417,36586:27530,36587:29417,36588:29664,36589:31278,36590:33131,36591:36259,36592:37202,36593:39318,36594:20754,36595:21463,36596:21610,36597:23551,36598:25480,36599:27193,36600:32172,36601:38656,36602:22234,36603:21454,36604:21608,36672:23447,36673:23601,36674:24030,36675:20462,36676:24833,36677:25342,36678:27954,36679:31168,36680:31179,36681:32066,36682:32333,36683:32722,36684:33261,36685:33311,36686:33936,36687:34886,36688:35186,36689:35728,36690:36468,36691:36655,36692:36913,36693:37195,36694:37228,36695:38598,36696:37276,36697:20160,36698:20303,36699:20805,36700:21313,36701:24467,36702:25102,36703:26580,36704:27713,36705:28171,36706:29539,36707:32294,36708:37325,36709:37507,36710:21460,36711:22809,36712:23487,36713:28113,36714:31069,36715:32302,36716:31899,36717:22654,36718:29087,36719:20986,36720:34899,36721:36848,36722:20426,36723:23803,36724:26149,36725:30636,36726:31459,36727:33308,36728:39423,36729:20934,36730:24490,36731:26092,36732:26991,36733:27529,36734:28147,36736:28310,36737:28516,36738:30462,36739:32020,36740:24033,36741:36981,36742:37255,36743:38918,36744:20966,36745:21021,36746:25152,36747:26257,36748:26329,36749:28186,36750:24246,36751:32210,36752:32626,36753:26360,36754:34223,36755:34295,36756:35576,36757:21161,36758:21465,36759:22899,36760:24207,36761:24464,36762:24661,36763:37604,36764:38500,36765:20663,36766:20767,36767:21213,36768:21280,36769:21319,36770:21484,36771:21736,36772:21830,36773:21809,36774:22039,36775:22888,36776:22974,36777:23100,36778:23477,36779:23558,36780:23567,36781:23569,36782:23578,36783:24196,36784:24202,36785:24288,36786:24432,36787:25215,36788:25220,36789:25307,36790:25484,36791:25463,36792:26119,36793:26124,36794:26157,36795:26230,36796:26494,36797:26786,36798:27167,36799:27189,36800:27836,36801:28040,36802:28169,36803:28248,36804:28988,36805:28966,36806:29031,36807:30151,36808:30465,36809:30813,36810:30977,36811:31077,36812:31216,36813:31456,36814:31505,36815:31911,36816:32057,36817:32918,36818:33750,36819:33931,36820:34121,36821:34909,36822:35059,36823:35359,36824:35388,36825:35412,36826:35443,36827:35937,36828:36062,36829:37284,36830:37478,36831:37758,36832:37912,36833:38556,36834:38808,36835:19978,36836:19976,36837:19998,36838:20055,36839:20887,36840:21104,36841:22478,36842:22580,36843:22732,36844:23330,36845:24120,36846:24773,36847:25854,36848:26465,36849:26454,36850:27972,36851:29366,36852:30067,36853:31331,36854:33976,36855:35698,36856:37304,36857:37664,36858:22065,36859:22516,36860:39166,36928:25325,36929:26893,36930:27542,36931:29165,36932:32340,36933:32887,36934:33394,36935:35302,36936:39135,36937:34645,36938:36785,36939:23611,36940:20280,36941:20449,36942:20405,36943:21767,36944:23072,36945:23517,36946:23529,36947:24515,36948:24910,36949:25391,36950:26032,36951:26187,36952:26862,36953:27035,36954:28024,36955:28145,36956:30003,36957:30137,36958:30495,36959:31070,36960:31206,36961:32051,36962:33251,36963:33455,36964:34218,36965:35242,36966:35386,36967:36523,36968:36763,36969:36914,36970:37341,36971:38663,36972:20154,36973:20161,36974:20995,36975:22645,36976:22764,36977:23563,36978:29978,36979:23613,36980:33102,36981:35338,36982:36805,36983:38499,36984:38765,36985:31525,36986:35535,36987:38920,36988:37218,36989:22259,36990:21416,36992:36887,36993:21561,36994:22402,36995:24101,36996:25512,36997:27700,36998:28810,36999:30561,37e3:31883,37001:32736,37002:34928,37003:36930,37004:37204,37005:37648,37006:37656,37007:38543,37008:29790,37009:39620,37010:23815,37011:23913,37012:25968,37013:26530,37014:36264,37015:38619,37016:25454,37017:26441,37018:26905,37019:33733,37020:38935,37021:38592,37022:35070,37023:28548,37024:25722,37025:23544,37026:19990,37027:28716,37028:30045,37029:26159,37030:20932,37031:21046,37032:21218,37033:22995,37034:24449,37035:24615,37036:25104,37037:25919,37038:25972,37039:26143,37040:26228,37041:26866,37042:26646,37043:27491,37044:28165,37045:29298,37046:29983,37047:30427,37048:31934,37049:32854,37050:22768,37051:35069,37052:35199,37053:35488,37054:35475,37055:35531,37056:36893,37057:37266,37058:38738,37059:38745,37060:25993,37061:31246,37062:33030,37063:38587,37064:24109,37065:24796,37066:25114,37067:26021,37068:26132,37069:26512,37070:30707,37071:31309,37072:31821,37073:32318,37074:33034,37075:36012,37076:36196,37077:36321,37078:36447,37079:30889,37080:20999,37081:25305,37082:25509,37083:25666,37084:25240,37085:35373,37086:31363,37087:31680,37088:35500,37089:38634,37090:32118,37091:33292,37092:34633,37093:20185,37094:20808,37095:21315,37096:21344,37097:23459,37098:23554,37099:23574,37100:24029,37101:25126,37102:25159,37103:25776,37104:26643,37105:26676,37106:27849,37107:27973,37108:27927,37109:26579,37110:28508,37111:29006,37112:29053,37113:26059,37114:31359,37115:31661,37116:32218,37184:32330,37185:32680,37186:33146,37187:33307,37188:33337,37189:34214,37190:35438,37191:36046,37192:36341,37193:36984,37194:36983,37195:37549,37196:37521,37197:38275,37198:39854,37199:21069,37200:21892,37201:28472,37202:28982,37203:20840,37204:31109,37205:32341,37206:33203,37207:31950,37208:22092,37209:22609,37210:23720,37211:25514,37212:26366,37213:26365,37214:26970,37215:29401,37216:30095,37217:30094,37218:30990,37219:31062,37220:31199,37221:31895,37222:32032,37223:32068,37224:34311,37225:35380,37226:38459,37227:36961,37228:40736,37229:20711,37230:21109,37231:21452,37232:21474,37233:20489,37234:21930,37235:22766,37236:22863,37237:29245,37238:23435,37239:23652,37240:21277,37241:24803,37242:24819,37243:25436,37244:25475,37245:25407,37246:25531,37248:25805,37249:26089,37250:26361,37251:24035,37252:27085,37253:27133,37254:28437,37255:29157,37256:20105,37257:30185,37258:30456,37259:31379,37260:31967,37261:32207,37262:32156,37263:32865,37264:33609,37265:33624,37266:33900,37267:33980,37268:34299,37269:35013,37270:36208,37271:36865,37272:36973,37273:37783,37274:38684,37275:39442,37276:20687,37277:22679,37278:24974,37279:33235,37280:34101,37281:36104,37282:36896,37283:20419,37284:20596,37285:21063,37286:21363,37287:24687,37288:25417,37289:26463,37290:28204,37291:36275,37292:36895,37293:20439,37294:23646,37295:36042,37296:26063,37297:32154,37298:21330,37299:34966,37300:20854,37301:25539,37302:23384,37303:23403,37304:23562,37305:25613,37306:26449,37307:36956,37308:20182,37309:22810,37310:22826,37311:27760,37312:35409,37313:21822,37314:22549,37315:22949,37316:24816,37317:25171,37318:26561,37319:33333,37320:26965,37321:38464,37322:39364,37323:39464,37324:20307,37325:22534,37326:23550,37327:32784,37328:23729,37329:24111,37330:24453,37331:24608,37332:24907,37333:25140,37334:26367,37335:27888,37336:28382,37337:32974,37338:33151,37339:33492,37340:34955,37341:36024,37342:36864,37343:36910,37344:38538,37345:40667,37346:39899,37347:20195,37348:21488,37349:22823,37350:31532,37351:37261,37352:38988,37353:40441,37354:28381,37355:28711,37356:21331,37357:21828,37358:23429,37359:25176,37360:25246,37361:25299,37362:27810,37363:28655,37364:29730,37365:35351,37366:37944,37367:28609,37368:35582,37369:33592,37370:20967,37371:34552,37372:21482,37440:21481,37441:20294,37442:36948,37443:36784,37444:22890,37445:33073,37446:24061,37447:31466,37448:36799,37449:26842,37450:35895,37451:29432,37452:40008,37453:27197,37454:35504,37455:20025,37456:21336,37457:22022,37458:22374,37459:25285,37460:25506,37461:26086,37462:27470,37463:28129,37464:28251,37465:28845,37466:30701,37467:31471,37468:31658,37469:32187,37470:32829,37471:32966,37472:34507,37473:35477,37474:37723,37475:22243,37476:22727,37477:24382,37478:26029,37479:26262,37480:27264,37481:27573,37482:30007,37483:35527,37484:20516,37485:30693,37486:22320,37487:24347,37488:24677,37489:26234,37490:27744,37491:30196,37492:31258,37493:32622,37494:33268,37495:34584,37496:36933,37497:39347,37498:31689,37499:30044,37500:31481,37501:31569,37502:33988,37504:36880,37505:31209,37506:31378,37507:33590,37508:23265,37509:30528,37510:20013,37511:20210,37512:23449,37513:24544,37514:25277,37515:26172,37516:26609,37517:27880,37518:34411,37519:34935,37520:35387,37521:37198,37522:37619,37523:39376,37524:27159,37525:28710,37526:29482,37527:33511,37528:33879,37529:36015,37530:19969,37531:20806,37532:20939,37533:21899,37534:23541,37535:24086,37536:24115,37537:24193,37538:24340,37539:24373,37540:24427,37541:24500,37542:25074,37543:25361,37544:26274,37545:26397,37546:28526,37547:29266,37548:30010,37549:30522,37550:32884,37551:33081,37552:33144,37553:34678,37554:35519,37555:35548,37556:36229,37557:36339,37558:37530,37559:38263,37560:38914,37561:40165,37562:21189,37563:25431,37564:30452,37565:26389,37566:27784,37567:29645,37568:36035,37569:37806,37570:38515,37571:27941,37572:22684,37573:26894,37574:27084,37575:36861,37576:37786,37577:30171,37578:36890,37579:22618,37580:26626,37581:25524,37582:27131,37583:20291,37584:28460,37585:26584,37586:36795,37587:34086,37588:32180,37589:37716,37590:26943,37591:28528,37592:22378,37593:22775,37594:23340,37595:32044,37596:29226,37597:21514,37598:37347,37599:40372,37600:20141,37601:20302,37602:20572,37603:20597,37604:21059,37605:35998,37606:21576,37607:22564,37608:23450,37609:24093,37610:24213,37611:24237,37612:24311,37613:24351,37614:24716,37615:25269,37616:25402,37617:25552,37618:26799,37619:27712,37620:30855,37621:31118,37622:31243,37623:32224,37624:33351,37625:35330,37626:35558,37627:36420,37628:36883,37696:37048,37697:37165,37698:37336,37699:40718,37700:27877,37701:25688,37702:25826,37703:25973,37704:28404,37705:30340,37706:31515,37707:36969,37708:37841,37709:28346,37710:21746,37711:24505,37712:25764,37713:36685,37714:36845,37715:37444,37716:20856,37717:22635,37718:22825,37719:23637,37720:24215,37721:28155,37722:32399,37723:29980,37724:36028,37725:36578,37726:39003,37727:28857,37728:20253,37729:27583,37730:28593,37731:3e4,37732:38651,37733:20814,37734:21520,37735:22581,37736:22615,37737:22956,37738:23648,37739:24466,37740:26007,37741:26460,37742:28193,37743:30331,37744:33759,37745:36077,37746:36884,37747:37117,37748:37709,37749:30757,37750:30778,37751:21162,37752:24230,37753:22303,37754:22900,37755:24594,37756:20498,37757:20826,37758:20908,37760:20941,37761:20992,37762:21776,37763:22612,37764:22616,37765:22871,37766:23445,37767:23798,37768:23947,37769:24764,37770:25237,37771:25645,37772:26481,37773:26691,37774:26812,37775:26847,37776:30423,37777:28120,37778:28271,37779:28059,37780:28783,37781:29128,37782:24403,37783:30168,37784:31095,37785:31561,37786:31572,37787:31570,37788:31958,37789:32113,37790:21040,37791:33891,37792:34153,37793:34276,37794:35342,37795:35588,37796:35910,37797:36367,37798:36867,37799:36879,37800:37913,37801:38518,37802:38957,37803:39472,37804:38360,37805:20685,37806:21205,37807:21516,37808:22530,37809:23566,37810:24999,37811:25758,37812:27934,37813:30643,37814:31461,37815:33012,37816:33796,37817:36947,37818:37509,37819:23776,37820:40199,37821:21311,37822:24471,37823:24499,37824:28060,37825:29305,37826:30563,37827:31167,37828:31716,37829:27602,37830:29420,37831:35501,37832:26627,37833:27233,37834:20984,37835:31361,37836:26932,37837:23626,37838:40182,37839:33515,37840:23493,37841:37193,37842:28702,37843:22136,37844:23663,37845:24775,37846:25958,37847:27788,37848:35930,37849:36929,37850:38931,37851:21585,37852:26311,37853:37389,37854:22856,37855:37027,37856:20869,37857:20045,37858:20970,37859:34201,37860:35598,37861:28760,37862:25466,37863:37707,37864:26978,37865:39348,37866:32260,37867:30071,37868:21335,37869:26976,37870:36575,37871:38627,37872:27741,37873:20108,37874:23612,37875:24336,37876:36841,37877:21250,37878:36049,37879:32905,37880:34425,37881:24319,37882:26085,37883:20083,37884:20837,37952:22914,37953:23615,37954:38894,37955:20219,37956:22922,37957:24525,37958:35469,37959:28641,37960:31152,37961:31074,37962:23527,37963:33905,37964:29483,37965:29105,37966:24180,37967:24565,37968:25467,37969:25754,37970:29123,37971:31896,37972:20035,37973:24316,37974:20043,37975:22492,37976:22178,37977:24745,37978:28611,37979:32013,37980:33021,37981:33075,37982:33215,37983:36786,37984:35223,37985:34468,37986:24052,37987:25226,37988:25773,37989:35207,37990:26487,37991:27874,37992:27966,37993:29750,37994:30772,37995:23110,37996:32629,37997:33453,37998:39340,37999:20467,38e3:24259,38001:25309,38002:25490,38003:25943,38004:26479,38005:30403,38006:29260,38007:32972,38008:32954,38009:36649,38010:37197,38011:20493,38012:22521,38013:23186,38014:26757,38016:26995,38017:29028,38018:29437,38019:36023,38020:22770,38021:36064,38022:38506,38023:36889,38024:34687,38025:31204,38026:30695,38027:33833,38028:20271,38029:21093,38030:21338,38031:25293,38032:26575,38033:27850,38034:30333,38035:31636,38036:31893,38037:33334,38038:34180,38039:36843,38040:26333,38041:28448,38042:29190,38043:32283,38044:33707,38045:39361,38046:40614,38047:20989,38048:31665,38049:30834,38050:31672,38051:32903,38052:31560,38053:27368,38054:24161,38055:32908,38056:30033,38057:30048,38058:20843,38059:37474,38060:28300,38061:30330,38062:37271,38063:39658,38064:20240,38065:32624,38066:25244,38067:31567,38068:38309,38069:40169,38070:22138,38071:22617,38072:34532,38073:38588,38074:20276,38075:21028,38076:21322,38077:21453,38078:21467,38079:24070,38080:25644,38081:26001,38082:26495,38083:27710,38084:27726,38085:29256,38086:29359,38087:29677,38088:30036,38089:32321,38090:33324,38091:34281,38092:36009,38093:31684,38094:37318,38095:29033,38096:38930,38097:39151,38098:25405,38099:26217,38100:30058,38101:30436,38102:30928,38103:34115,38104:34542,38105:21290,38106:21329,38107:21542,38108:22915,38109:24199,38110:24444,38111:24754,38112:25161,38113:25209,38114:25259,38115:26e3,38116:27604,38117:27852,38118:30130,38119:30382,38120:30865,38121:31192,38122:32203,38123:32631,38124:32933,38125:34987,38126:35513,38127:36027,38128:36991,38129:38750,38130:39131,38131:27147,38132:31800,38133:20633,38134:23614,38135:24494,38136:26503,38137:27608,38138:29749,38139:30473,38140:32654,38208:40763,38209:26570,38210:31255,38211:21305,38212:30091,38213:39661,38214:24422,38215:33181,38216:33777,38217:32920,38218:24380,38219:24517,38220:30050,38221:31558,38222:36924,38223:26727,38224:23019,38225:23195,38226:32016,38227:30334,38228:35628,38229:20469,38230:24426,38231:27161,38232:27703,38233:28418,38234:29922,38235:31080,38236:34920,38237:35413,38238:35961,38239:24287,38240:25551,38241:30149,38242:31186,38243:33495,38244:37672,38245:37618,38246:33948,38247:34541,38248:39981,38249:21697,38250:24428,38251:25996,38252:27996,38253:28693,38254:36007,38255:36051,38256:38971,38257:25935,38258:29942,38259:19981,38260:20184,38261:22496,38262:22827,38263:23142,38264:23500,38265:20904,38266:24067,38267:24220,38268:24598,38269:25206,38270:25975,38272:26023,38273:26222,38274:28014,38275:29238,38276:31526,38277:33104,38278:33178,38279:33433,38280:35676,38281:36e3,38282:36070,38283:36212,38284:38428,38285:38468,38286:20398,38287:25771,38288:27494,38289:33310,38290:33889,38291:34154,38292:37096,38293:23553,38294:26963,38295:39080,38296:33914,38297:34135,38298:20239,38299:21103,38300:24489,38301:24133,38302:26381,38303:31119,38304:33145,38305:35079,38306:35206,38307:28149,38308:24343,38309:25173,38310:27832,38311:20175,38312:29289,38313:39826,38314:20998,38315:21563,38316:22132,38317:22707,38318:24996,38319:25198,38320:28954,38321:22894,38322:31881,38323:31966,38324:32027,38325:38640,38326:25991,38327:32862,38328:19993,38329:20341,38330:20853,38331:22592,38332:24163,38333:24179,38334:24330,38335:26564,38336:20006,38337:34109,38338:38281,38339:38491,38340:31859,38341:38913,38342:20731,38343:22721,38344:30294,38345:30887,38346:21029,38347:30629,38348:34065,38349:31622,38350:20559,38351:22793,38352:29255,38353:31687,38354:32232,38355:36794,38356:36820,38357:36941,38358:20415,38359:21193,38360:23081,38361:24321,38362:38829,38363:20445,38364:33303,38365:37610,38366:22275,38367:25429,38368:27497,38369:29995,38370:35036,38371:36628,38372:31298,38373:21215,38374:22675,38375:24917,38376:25098,38377:26286,38378:27597,38379:31807,38380:33769,38381:20515,38382:20472,38383:21253,38384:21574,38385:22577,38386:22857,38387:23453,38388:23792,38389:23791,38390:23849,38391:24214,38392:25265,38393:25447,38394:25918,38395:26041,38396:26379,38464:27861,38465:27873,38466:28921,38467:30770,38468:32299,38469:32990,38470:33459,38471:33804,38472:34028,38473:34562,38474:35090,38475:35370,38476:35914,38477:37030,38478:37586,38479:39165,38480:40179,38481:40300,38482:20047,38483:20129,38484:20621,38485:21078,38486:22346,38487:22952,38488:24125,38489:24536,38490:24537,38491:25151,38492:26292,38493:26395,38494:26576,38495:26834,38496:20882,38497:32033,38498:32938,38499:33192,38500:35584,38501:35980,38502:36031,38503:37502,38504:38450,38505:21536,38506:38956,38507:21271,38508:20693,38509:21340,38510:22696,38511:25778,38512:26420,38513:29287,38514:30566,38515:31302,38516:37350,38517:21187,38518:27809,38519:27526,38520:22528,38521:24140,38522:22868,38523:26412,38524:32763,38525:20961,38526:30406,38528:25705,38529:30952,38530:39764,38531:40635,38532:22475,38533:22969,38534:26151,38535:26522,38536:27598,38537:21737,38538:27097,38539:24149,38540:33180,38541:26517,38542:39850,38543:26622,38544:40018,38545:26717,38546:20134,38547:20451,38548:21448,38549:25273,38550:26411,38551:27819,38552:36804,38553:20397,38554:32365,38555:40639,38556:19975,38557:24930,38558:28288,38559:28459,38560:34067,38561:21619,38562:26410,38563:39749,38564:24051,38565:31637,38566:23724,38567:23494,38568:34588,38569:28234,38570:34001,38571:31252,38572:33032,38573:22937,38574:31885,38575:27665,38576:30496,38577:21209,38578:22818,38579:28961,38580:29279,38581:30683,38582:38695,38583:40289,38584:26891,38585:23167,38586:23064,38587:20901,38588:21517,38589:21629,38590:26126,38591:30431,38592:36855,38593:37528,38594:40180,38595:23018,38596:29277,38597:28357,38598:20813,38599:26825,38600:32191,38601:32236,38602:38754,38603:40634,38604:25720,38605:27169,38606:33538,38607:22916,38608:23391,38609:27611,38610:29467,38611:30450,38612:32178,38613:32791,38614:33945,38615:20786,38616:26408,38617:40665,38618:30446,38619:26466,38620:21247,38621:39173,38622:23588,38623:25147,38624:31870,38625:36016,38626:21839,38627:24758,38628:32011,38629:38272,38630:21249,38631:20063,38632:20918,38633:22812,38634:29242,38635:32822,38636:37326,38637:24357,38638:30690,38639:21380,38640:24441,38641:32004,38642:34220,38643:35379,38644:36493,38645:38742,38646:26611,38647:34222,38648:37971,38649:24841,38650:24840,38651:27833,38652:30290,38720:35565,38721:36664,38722:21807,38723:20305,38724:20778,38725:21191,38726:21451,38727:23461,38728:24189,38729:24736,38730:24962,38731:25558,38732:26377,38733:26586,38734:28263,38735:28044,38736:29494,38737:29495,38738:30001,38739:31056,38740:35029,38741:35480,38742:36938,38743:37009,38744:37109,38745:38596,38746:34701,38747:22805,38748:20104,38749:20313,38750:19982,38751:35465,38752:36671,38753:38928,38754:20653,38755:24188,38756:22934,38757:23481,38758:24248,38759:25562,38760:25594,38761:25793,38762:26332,38763:26954,38764:27096,38765:27915,38766:28342,38767:29076,38768:29992,38769:31407,38770:32650,38771:32768,38772:33865,38773:33993,38774:35201,38775:35617,38776:36362,38777:36965,38778:38525,38779:39178,38780:24958,38781:25233,38782:27442,38784:27779,38785:28020,38786:32716,38787:32764,38788:28096,38789:32645,38790:34746,38791:35064,38792:26469,38793:33713,38794:38972,38795:38647,38796:27931,38797:32097,38798:33853,38799:37226,38800:20081,38801:21365,38802:23888,38803:27396,38804:28651,38805:34253,38806:34349,38807:35239,38808:21033,38809:21519,38810:23653,38811:26446,38812:26792,38813:29702,38814:29827,38815:30178,38816:35023,38817:35041,38818:37324,38819:38626,38820:38520,38821:24459,38822:29575,38823:31435,38824:33870,38825:25504,38826:30053,38827:21129,38828:27969,38829:28316,38830:29705,38831:30041,38832:30827,38833:31890,38834:38534,38835:31452,38836:40845,38837:20406,38838:24942,38839:26053,38840:34396,38841:20102,38842:20142,38843:20698,38844:20001,38845:20940,38846:23534,38847:26009,38848:26753,38849:28092,38850:29471,38851:30274,38852:30637,38853:31260,38854:31975,38855:33391,38856:35538,38857:36988,38858:37327,38859:38517,38860:38936,38861:21147,38862:32209,38863:20523,38864:21400,38865:26519,38866:28107,38867:29136,38868:29747,38869:33256,38870:36650,38871:38563,38872:40023,38873:40607,38874:29792,38875:22593,38876:28057,38877:32047,38878:39006,38879:20196,38880:20278,38881:20363,38882:20919,38883:21169,38884:23994,38885:24604,38886:29618,38887:31036,38888:33491,38889:37428,38890:38583,38891:38646,38892:38666,38893:40599,38894:40802,38895:26278,38896:27508,38897:21015,38898:21155,38899:28872,38900:35010,38901:24265,38902:24651,38903:24976,38904:28451,38905:29001,38906:31806,38907:32244,38908:32879,38976:34030,38977:36899,38978:37676,38979:21570,38980:39791,38981:27347,38982:28809,38983:36034,38984:36335,38985:38706,38986:21172,38987:23105,38988:24266,38989:24324,38990:26391,38991:27004,38992:27028,38993:28010,38994:28431,38995:29282,38996:29436,38997:31725,38998:32769,38999:32894,39e3:34635,39001:37070,39002:20845,39003:40595,39004:31108,39005:32907,39006:37682,39007:35542,39008:20525,39009:21644,39010:35441,39011:27498,39012:36036,39013:33031,39014:24785,39015:26528,39016:40434,39017:20121,39018:20120,39019:39952,39020:35435,39021:34241,39022:34152,39023:26880,39024:28286,39025:30871,39026:33109,39071:24332,39072:19984,39073:19989,39074:20010,39075:20017,39076:20022,39077:20028,39078:20031,39079:20034,39080:20054,39081:20056,39082:20098,39083:20101,39084:35947,39085:20106,39086:33298,39087:24333,39088:20110,39089:20126,39090:20127,39091:20128,39092:20130,39093:20144,39094:20147,39095:20150,39096:20174,39097:20173,39098:20164,39099:20166,39100:20162,39101:20183,39102:20190,39103:20205,39104:20191,39105:20215,39106:20233,39107:20314,39108:20272,39109:20315,39110:20317,39111:20311,39112:20295,39113:20342,39114:20360,39115:20367,39116:20376,39117:20347,39118:20329,39119:20336,39120:20369,39121:20335,39122:20358,39123:20374,39124:20760,39125:20436,39126:20447,39127:20430,39128:20440,39129:20443,39130:20433,39131:20442,39132:20432,39133:20452,39134:20453,39135:20506,39136:20520,39137:20500,39138:20522,39139:20517,39140:20485,39141:20252,39142:20470,39143:20513,39144:20521,39145:20524,39146:20478,39147:20463,39148:20497,39149:20486,39150:20547,39151:20551,39152:26371,39153:20565,39154:20560,39155:20552,39156:20570,39157:20566,39158:20588,39159:20600,39160:20608,39161:20634,39162:20613,39163:20660,39164:20658,39232:20681,39233:20682,39234:20659,39235:20674,39236:20694,39237:20702,39238:20709,39239:20717,39240:20707,39241:20718,39242:20729,39243:20725,39244:20745,39245:20737,39246:20738,39247:20758,39248:20757,39249:20756,39250:20762,39251:20769,39252:20794,39253:20791,39254:20796,39255:20795,39256:20799,39257:20800,39258:20818,39259:20812,39260:20820,39261:20834,39262:31480,39263:20841,39264:20842,39265:20846,39266:20864,39267:20866,39268:22232,39269:20876,39270:20873,39271:20879,39272:20881,39273:20883,39274:20885,39275:20886,39276:20900,39277:20902,39278:20898,39279:20905,39280:20906,39281:20907,39282:20915,39283:20913,39284:20914,39285:20912,39286:20917,39287:20925,39288:20933,39289:20937,39290:20955,39291:20960,39292:34389,39293:20969,39294:20973,39296:20976,39297:20981,39298:20990,39299:20996,39300:21003,39301:21012,39302:21006,39303:21031,39304:21034,39305:21038,39306:21043,39307:21049,39308:21071,39309:21060,39310:21067,39311:21068,39312:21086,39313:21076,39314:21098,39315:21108,39316:21097,39317:21107,39318:21119,39319:21117,39320:21133,39321:21140,39322:21138,39323:21105,39324:21128,39325:21137,39326:36776,39327:36775,39328:21164,39329:21165,39330:21180,39331:21173,39332:21185,39333:21197,39334:21207,39335:21214,39336:21219,39337:21222,39338:39149,39339:21216,39340:21235,39341:21237,39342:21240,39343:21241,39344:21254,39345:21256,39346:30008,39347:21261,39348:21264,39349:21263,39350:21269,39351:21274,39352:21283,39353:21295,39354:21297,39355:21299,39356:21304,39357:21312,39358:21318,39359:21317,39360:19991,39361:21321,39362:21325,39363:20950,39364:21342,39365:21353,39366:21358,39367:22808,39368:21371,39369:21367,39370:21378,39371:21398,39372:21408,39373:21414,39374:21413,39375:21422,39376:21424,39377:21430,39378:21443,39379:31762,39380:38617,39381:21471,39382:26364,39383:29166,39384:21486,39385:21480,39386:21485,39387:21498,39388:21505,39389:21565,39390:21568,39391:21548,39392:21549,39393:21564,39394:21550,39395:21558,39396:21545,39397:21533,39398:21582,39399:21647,39400:21621,39401:21646,39402:21599,39403:21617,39404:21623,39405:21616,39406:21650,39407:21627,39408:21632,39409:21622,39410:21636,39411:21648,39412:21638,39413:21703,39414:21666,39415:21688,39416:21669,39417:21676,39418:21700,39419:21704,39420:21672,39488:21675,39489:21698,39490:21668,39491:21694,39492:21692,39493:21720,39494:21733,39495:21734,39496:21775,39497:21780,39498:21757,39499:21742,39500:21741,39501:21754,39502:21730,39503:21817,39504:21824,39505:21859,39506:21836,39507:21806,39508:21852,39509:21829,39510:21846,39511:21847,39512:21816,39513:21811,39514:21853,39515:21913,39516:21888,39517:21679,39518:21898,39519:21919,39520:21883,39521:21886,39522:21912,39523:21918,39524:21934,39525:21884,39526:21891,39527:21929,39528:21895,39529:21928,39530:21978,39531:21957,39532:21983,39533:21956,39534:21980,39535:21988,39536:21972,39537:22036,39538:22007,39539:22038,39540:22014,39541:22013,39542:22043,39543:22009,39544:22094,39545:22096,39546:29151,39547:22068,39548:22070,39549:22066,39550:22072,39552:22123,39553:22116,39554:22063,39555:22124,39556:22122,39557:22150,39558:22144,39559:22154,39560:22176,39561:22164,39562:22159,39563:22181,39564:22190,39565:22198,39566:22196,39567:22210,39568:22204,39569:22209,39570:22211,39571:22208,39572:22216,39573:22222,39574:22225,39575:22227,39576:22231,39577:22254,39578:22265,39579:22272,39580:22271,39581:22276,39582:22281,39583:22280,39584:22283,39585:22285,39586:22291,39587:22296,39588:22294,39589:21959,39590:22300,39591:22310,39592:22327,39593:22328,39594:22350,39595:22331,39596:22336,39597:22351,39598:22377,39599:22464,39600:22408,39601:22369,39602:22399,39603:22409,39604:22419,39605:22432,39606:22451,39607:22436,39608:22442,39609:22448,39610:22467,39611:22470,39612:22484,39613:22482,39614:22483,39615:22538,39616:22486,39617:22499,39618:22539,39619:22553,39620:22557,39621:22642,39622:22561,39623:22626,39624:22603,39625:22640,39626:27584,39627:22610,39628:22589,39629:22649,39630:22661,39631:22713,39632:22687,39633:22699,39634:22714,39635:22750,39636:22715,39637:22712,39638:22702,39639:22725,39640:22739,39641:22737,39642:22743,39643:22745,39644:22744,39645:22757,39646:22748,39647:22756,39648:22751,39649:22767,39650:22778,39651:22777,39652:22779,39653:22780,39654:22781,39655:22786,39656:22794,39657:22800,39658:22811,39659:26790,39660:22821,39661:22828,39662:22829,39663:22834,39664:22840,39665:22846,39666:31442,39667:22869,39668:22864,39669:22862,39670:22874,39671:22872,39672:22882,39673:22880,39674:22887,39675:22892,39676:22889,39744:22904,39745:22913,39746:22941,39747:20318,39748:20395,39749:22947,39750:22962,39751:22982,39752:23016,39753:23004,39754:22925,39755:23001,39756:23002,39757:23077,39758:23071,39759:23057,39760:23068,39761:23049,39762:23066,39763:23104,39764:23148,39765:23113,39766:23093,39767:23094,39768:23138,39769:23146,39770:23194,39771:23228,39772:23230,39773:23243,39774:23234,39775:23229,39776:23267,39777:23255,39778:23270,39779:23273,39780:23254,39781:23290,39782:23291,39783:23308,39784:23307,39785:23318,39786:23346,39787:23248,39788:23338,39789:23350,39790:23358,39791:23363,39792:23365,39793:23360,39794:23377,39795:23381,39796:23386,39797:23387,39798:23397,39799:23401,39800:23408,39801:23411,39802:23413,39803:23416,39804:25992,39805:23418,39806:23424,39808:23427,39809:23462,39810:23480,39811:23491,39812:23495,39813:23497,39814:23508,39815:23504,39816:23524,39817:23526,39818:23522,39819:23518,39820:23525,39821:23531,39822:23536,39823:23542,39824:23539,39825:23557,39826:23559,39827:23560,39828:23565,39829:23571,39830:23584,39831:23586,39832:23592,39833:23608,39834:23609,39835:23617,39836:23622,39837:23630,39838:23635,39839:23632,39840:23631,39841:23409,39842:23660,39843:23662,39844:20066,39845:23670,39846:23673,39847:23692,39848:23697,39849:23700,39850:22939,39851:23723,39852:23739,39853:23734,39854:23740,39855:23735,39856:23749,39857:23742,39858:23751,39859:23769,39860:23785,39861:23805,39862:23802,39863:23789,39864:23948,39865:23786,39866:23819,39867:23829,39868:23831,39869:23900,39870:23839,39871:23835,39872:23825,39873:23828,39874:23842,39875:23834,39876:23833,39877:23832,39878:23884,39879:23890,39880:23886,39881:23883,39882:23916,39883:23923,39884:23926,39885:23943,39886:23940,39887:23938,39888:23970,39889:23965,39890:23980,39891:23982,39892:23997,39893:23952,39894:23991,39895:23996,39896:24009,39897:24013,39898:24019,39899:24018,39900:24022,39901:24027,39902:24043,39903:24050,39904:24053,39905:24075,39906:24090,39907:24089,39908:24081,39909:24091,39910:24118,39911:24119,39912:24132,39913:24131,39914:24128,39915:24142,39916:24151,39917:24148,39918:24159,39919:24162,39920:24164,39921:24135,39922:24181,39923:24182,39924:24186,39925:40636,39926:24191,39927:24224,39928:24257,39929:24258,39930:24264,39931:24272,39932:24271,4e4:24278,40001:24291,40002:24285,40003:24282,40004:24283,40005:24290,40006:24289,40007:24296,40008:24297,40009:24300,40010:24305,40011:24307,40012:24304,40013:24308,40014:24312,40015:24318,40016:24323,40017:24329,40018:24413,40019:24412,40020:24331,40021:24337,40022:24342,40023:24361,40024:24365,40025:24376,40026:24385,40027:24392,40028:24396,40029:24398,40030:24367,40031:24401,40032:24406,40033:24407,40034:24409,40035:24417,40036:24429,40037:24435,40038:24439,40039:24451,40040:24450,40041:24447,40042:24458,40043:24456,40044:24465,40045:24455,40046:24478,40047:24473,40048:24472,40049:24480,40050:24488,40051:24493,40052:24508,40053:24534,40054:24571,40055:24548,40056:24568,40057:24561,40058:24541,40059:24755,40060:24575,40061:24609,40062:24672,40064:24601,40065:24592,40066:24617,40067:24590,40068:24625,40069:24603,40070:24597,40071:24619,40072:24614,40073:24591,40074:24634,40075:24666,40076:24641,40077:24682,40078:24695,40079:24671,40080:24650,40081:24646,40082:24653,40083:24675,40084:24643,40085:24676,40086:24642,40087:24684,40088:24683,40089:24665,40090:24705,40091:24717,40092:24807,40093:24707,40094:24730,40095:24708,40096:24731,40097:24726,40098:24727,40099:24722,40100:24743,40101:24715,40102:24801,40103:24760,40104:24800,40105:24787,40106:24756,40107:24560,40108:24765,40109:24774,40110:24757,40111:24792,40112:24909,40113:24853,40114:24838,40115:24822,40116:24823,40117:24832,40118:24820,40119:24826,40120:24835,40121:24865,40122:24827,40123:24817,40124:24845,40125:24846,40126:24903,40127:24894,40128:24872,40129:24871,40130:24906,40131:24895,40132:24892,40133:24876,40134:24884,40135:24893,40136:24898,40137:24900,40138:24947,40139:24951,40140:24920,40141:24921,40142:24922,40143:24939,40144:24948,40145:24943,40146:24933,40147:24945,40148:24927,40149:24925,40150:24915,40151:24949,40152:24985,40153:24982,40154:24967,40155:25004,40156:24980,40157:24986,40158:24970,40159:24977,40160:25003,40161:25006,40162:25036,40163:25034,40164:25033,40165:25079,40166:25032,40167:25027,40168:25030,40169:25018,40170:25035,40171:32633,40172:25037,40173:25062,40174:25059,40175:25078,40176:25082,40177:25076,40178:25087,40179:25085,40180:25084,40181:25086,40182:25088,40183:25096,40184:25097,40185:25101,40186:25100,40187:25108,40188:25115,40256:25118,40257:25121,40258:25130,40259:25134,40260:25136,40261:25138,40262:25139,40263:25153,40264:25166,40265:25182,40266:25187,40267:25179,40268:25184,40269:25192,40270:25212,40271:25218,40272:25225,40273:25214,40274:25234,40275:25235,40276:25238,40277:25300,40278:25219,40279:25236,40280:25303,40281:25297,40282:25275,40283:25295,40284:25343,40285:25286,40286:25812,40287:25288,40288:25308,40289:25292,40290:25290,40291:25282,40292:25287,40293:25243,40294:25289,40295:25356,40296:25326,40297:25329,40298:25383,40299:25346,40300:25352,40301:25327,40302:25333,40303:25424,40304:25406,40305:25421,40306:25628,40307:25423,40308:25494,40309:25486,40310:25472,40311:25515,40312:25462,40313:25507,40314:25487,40315:25481,40316:25503,40317:25525,40318:25451,40320:25449,40321:25534,40322:25577,40323:25536,40324:25542,40325:25571,40326:25545,40327:25554,40328:25590,40329:25540,40330:25622,40331:25652,40332:25606,40333:25619,40334:25638,40335:25654,40336:25885,40337:25623,40338:25640,40339:25615,40340:25703,40341:25711,40342:25718,40343:25678,40344:25898,40345:25749,40346:25747,40347:25765,40348:25769,40349:25736,40350:25788,40351:25818,40352:25810,40353:25797,40354:25799,40355:25787,40356:25816,40357:25794,40358:25841,40359:25831,40360:33289,40361:25824,40362:25825,40363:25260,40364:25827,40365:25839,40366:25900,40367:25846,40368:25844,40369:25842,40370:25850,40371:25856,40372:25853,40373:25880,40374:25884,40375:25861,40376:25892,40377:25891,40378:25899,40379:25908,40380:25909,40381:25911,40382:25910,40383:25912,40384:30027,40385:25928,40386:25942,40387:25941,40388:25933,40389:25944,40390:25950,40391:25949,40392:25970,40393:25976,40394:25986,40395:25987,40396:35722,40397:26011,40398:26015,40399:26027,40400:26039,40401:26051,40402:26054,40403:26049,40404:26052,40405:26060,40406:26066,40407:26075,40408:26073,40409:26080,40410:26081,40411:26097,40412:26482,40413:26122,40414:26115,40415:26107,40416:26483,40417:26165,40418:26166,40419:26164,40420:26140,40421:26191,40422:26180,40423:26185,40424:26177,40425:26206,40426:26205,40427:26212,40428:26215,40429:26216,40430:26207,40431:26210,40432:26224,40433:26243,40434:26248,40435:26254,40436:26249,40437:26244,40438:26264,40439:26269,40440:26305,40441:26297,40442:26313,40443:26302,40444:26300,40512:26308,40513:26296,40514:26326,40515:26330,40516:26336,40517:26175,40518:26342,40519:26345,40520:26352,40521:26357,40522:26359,40523:26383,40524:26390,40525:26398,40526:26406,40527:26407,40528:38712,40529:26414,40530:26431,40531:26422,40532:26433,40533:26424,40534:26423,40535:26438,40536:26462,40537:26464,40538:26457,40539:26467,40540:26468,40541:26505,40542:26480,40543:26537,40544:26492,40545:26474,40546:26508,40547:26507,40548:26534,40549:26529,40550:26501,40551:26551,40552:26607,40553:26548,40554:26604,40555:26547,40556:26601,40557:26552,40558:26596,40559:26590,40560:26589,40561:26594,40562:26606,40563:26553,40564:26574,40565:26566,40566:26599,40567:27292,40568:26654,40569:26694,40570:26665,40571:26688,40572:26701,40573:26674,40574:26702,40576:26803,40577:26667,40578:26713,40579:26723,40580:26743,40581:26751,40582:26783,40583:26767,40584:26797,40585:26772,40586:26781,40587:26779,40588:26755,40589:27310,40590:26809,40591:26740,40592:26805,40593:26784,40594:26810,40595:26895,40596:26765,40597:26750,40598:26881,40599:26826,40600:26888,40601:26840,40602:26914,40603:26918,40604:26849,40605:26892,40606:26829,40607:26836,40608:26855,40609:26837,40610:26934,40611:26898,40612:26884,40613:26839,40614:26851,40615:26917,40616:26873,40617:26848,40618:26863,40619:26920,40620:26922,40621:26906,40622:26915,40623:26913,40624:26822,40625:27001,40626:26999,40627:26972,40628:27e3,40629:26987,40630:26964,40631:27006,40632:26990,40633:26937,40634:26996,40635:26941,40636:26969,40637:26928,40638:26977,40639:26974,40640:26973,40641:27009,40642:26986,40643:27058,40644:27054,40645:27088,40646:27071,40647:27073,40648:27091,40649:27070,40650:27086,40651:23528,40652:27082,40653:27101,40654:27067,40655:27075,40656:27047,40657:27182,40658:27025,40659:27040,40660:27036,40661:27029,40662:27060,40663:27102,40664:27112,40665:27138,40666:27163,40667:27135,40668:27402,40669:27129,40670:27122,40671:27111,40672:27141,40673:27057,40674:27166,40675:27117,40676:27156,40677:27115,40678:27146,40679:27154,40680:27329,40681:27171,40682:27155,40683:27204,40684:27148,40685:27250,40686:27190,40687:27256,40688:27207,40689:27234,40690:27225,40691:27238,40692:27208,40693:27192,40694:27170,40695:27280,40696:27277,40697:27296,40698:27268,40699:27298,40700:27299,40768:27287,40769:34327,40770:27323,40771:27331,40772:27330,40773:27320,40774:27315,40775:27308,40776:27358,40777:27345,40778:27359,40779:27306,40780:27354,40781:27370,40782:27387,40783:27397,40784:34326,40785:27386,40786:27410,40787:27414,40788:39729,40789:27423,40790:27448,40791:27447,40792:30428,40793:27449,40794:39150,40795:27463,40796:27459,40797:27465,40798:27472,40799:27481,40800:27476,40801:27483,40802:27487,40803:27489,40804:27512,40805:27513,40806:27519,40807:27520,40808:27524,40809:27523,40810:27533,40811:27544,40812:27541,40813:27550,40814:27556,40815:27562,40816:27563,40817:27567,40818:27570,40819:27569,40820:27571,40821:27575,40822:27580,40823:27590,40824:27595,40825:27603,40826:27615,40827:27628,40828:27627,40829:27635,40830:27631,40832:40638,40833:27656,40834:27667,40835:27668,40836:27675,40837:27684,40838:27683,40839:27742,40840:27733,40841:27746,40842:27754,40843:27778,40844:27789,40845:27802,40846:27777,40847:27803,40848:27774,40849:27752,40850:27763,40851:27794,40852:27792,40853:27844,40854:27889,40855:27859,40856:27837,40857:27863,40858:27845,40859:27869,40860:27822,40861:27825,40862:27838,40863:27834,40864:27867,40865:27887,40866:27865,40867:27882,40868:27935,40869:34893,40870:27958,40871:27947,40872:27965,40873:27960,40874:27929,40875:27957,40876:27955,40877:27922,40878:27916,40879:28003,40880:28051,40881:28004,40882:27994,40883:28025,40884:27993,40885:28046,40886:28053,40887:28644,40888:28037,40889:28153,40890:28181,40891:28170,40892:28085,40893:28103,40894:28134,40895:28088,40896:28102,40897:28140,40898:28126,40899:28108,40900:28136,40901:28114,40902:28101,40903:28154,40904:28121,40905:28132,40906:28117,40907:28138,40908:28142,40909:28205,40910:28270,40911:28206,40912:28185,40913:28274,40914:28255,40915:28222,40916:28195,40917:28267,40918:28203,40919:28278,40920:28237,40921:28191,40922:28227,40923:28218,40924:28238,40925:28196,40926:28415,40927:28189,40928:28216,40929:28290,40930:28330,40931:28312,40932:28361,40933:28343,40934:28371,40935:28349,40936:28335,40937:28356,40938:28338,40939:28372,40940:28373,40941:28303,40942:28325,40943:28354,40944:28319,40945:28481,40946:28433,40947:28748,40948:28396,40949:28408,40950:28414,40951:28479,40952:28402,40953:28465,40954:28399,40955:28466,40956:28364,161:65377,162:65378,163:65379,164:65380,165:65381,166:65382,167:65383,168:65384,169:65385,170:65386,171:65387,172:65388,173:65389,174:65390,175:65391,176:65392,177:65393,178:65394,179:65395,180:65396,181:65397,182:65398,183:65399,184:65400,185:65401,186:65402,187:65403,188:65404,189:65405,190:65406,191:65407,192:65408,193:65409,194:65410,195:65411,196:65412,197:65413,198:65414,199:65415,200:65416,201:65417,202:65418,203:65419,204:65420,205:65421,206:65422,207:65423,208:65424,209:65425,210:65426,211:65427,212:65428,213:65429,214:65430,215:65431,216:65432,217:65433,218:65434,219:65435,220:65436,221:65437,222:65438,223:65439,57408:28478,57409:28435,57410:28407,57411:28550,57412:28538,57413:28536,57414:28545,57415:28544,57416:28527,57417:28507,57418:28659,57419:28525,57420:28546,57421:28540,57422:28504,57423:28558,57424:28561,57425:28610,57426:28518,57427:28595,57428:28579,57429:28577,57430:28580,57431:28601,57432:28614,57433:28586,57434:28639,57435:28629,57436:28652,57437:28628,57438:28632,57439:28657,57440:28654,57441:28635,57442:28681,57443:28683,57444:28666,57445:28689,57446:28673,57447:28687,57448:28670,57449:28699,57450:28698,57451:28532,57452:28701,57453:28696,57454:28703,57455:28720,57456:28734,57457:28722,57458:28753,57459:28771,57460:28825,57461:28818,57462:28847,57463:28913,57464:28844,57465:28856,57466:28851,57467:28846,57468:28895,57469:28875,57470:28893,57472:28889,57473:28937,57474:28925,57475:28956,57476:28953,57477:29029,57478:29013,57479:29064,57480:29030,57481:29026,57482:29004,57483:29014,57484:29036,57485:29071,57486:29179,57487:29060,57488:29077,57489:29096,57490:29100,57491:29143,57492:29113,57493:29118,57494:29138,57495:29129,57496:29140,57497:29134,57498:29152,57499:29164,57500:29159,57501:29173,57502:29180,57503:29177,57504:29183,57505:29197,57506:29200,57507:29211,57508:29224,57509:29229,57510:29228,57511:29232,57512:29234,57513:29243,57514:29244,57515:29247,57516:29248,57517:29254,57518:29259,57519:29272,57520:29300,57521:29310,57522:29314,57523:29313,57524:29319,57525:29330,57526:29334,57527:29346,57528:29351,57529:29369,57530:29362,57531:29379,57532:29382,57533:29380,57534:29390,57535:29394,57536:29410,57537:29408,57538:29409,57539:29433,57540:29431,57541:20495,57542:29463,57543:29450,57544:29468,57545:29462,57546:29469,57547:29492,57548:29487,57549:29481,57550:29477,57551:29502,57552:29518,57553:29519,57554:40664,57555:29527,57556:29546,57557:29544,57558:29552,57559:29560,57560:29557,57561:29563,57562:29562,57563:29640,57564:29619,57565:29646,57566:29627,57567:29632,57568:29669,57569:29678,57570:29662,57571:29858,57572:29701,57573:29807,57574:29733,57575:29688,57576:29746,57577:29754,57578:29781,57579:29759,57580:29791,57581:29785,57582:29761,57583:29788,57584:29801,57585:29808,57586:29795,57587:29802,57588:29814,57589:29822,57590:29835,57591:29854,57592:29863,57593:29898,57594:29903,57595:29908,57596:29681,57664:29920,57665:29923,57666:29927,57667:29929,57668:29934,57669:29938,57670:29936,57671:29937,57672:29944,57673:29943,57674:29956,57675:29955,57676:29957,57677:29964,57678:29966,57679:29965,57680:29973,57681:29971,57682:29982,57683:29990,57684:29996,57685:30012,57686:30020,57687:30029,57688:30026,57689:30025,57690:30043,57691:30022,57692:30042,57693:30057,57694:30052,57695:30055,57696:30059,57697:30061,57698:30072,57699:30070,57700:30086,57701:30087,57702:30068,57703:30090,57704:30089,57705:30082,57706:30100,57707:30106,57708:30109,57709:30117,57710:30115,57711:30146,57712:30131,57713:30147,57714:30133,57715:30141,57716:30136,57717:30140,57718:30129,57719:30157,57720:30154,57721:30162,57722:30169,57723:30179,57724:30174,57725:30206,57726:30207,57728:30204,57729:30209,57730:30192,57731:30202,57732:30194,57733:30195,57734:30219,57735:30221,57736:30217,57737:30239,57738:30247,57739:30240,57740:30241,57741:30242,57742:30244,57743:30260,57744:30256,57745:30267,57746:30279,57747:30280,57748:30278,57749:30300,57750:30296,57751:30305,57752:30306,57753:30312,57754:30313,57755:30314,57756:30311,57757:30316,57758:30320,57759:30322,57760:30326,57761:30328,57762:30332,57763:30336,57764:30339,57765:30344,57766:30347,57767:30350,57768:30358,57769:30355,57770:30361,57771:30362,57772:30384,57773:30388,57774:30392,57775:30393,57776:30394,57777:30402,57778:30413,57779:30422,57780:30418,57781:30430,57782:30433,57783:30437,57784:30439,57785:30442,57786:34351,57787:30459,57788:30472,57789:30471,57790:30468,57791:30505,57792:30500,57793:30494,57794:30501,57795:30502,57796:30491,57797:30519,57798:30520,57799:30535,57800:30554,57801:30568,57802:30571,57803:30555,57804:30565,57805:30591,57806:30590,57807:30585,57808:30606,57809:30603,57810:30609,57811:30624,57812:30622,57813:30640,57814:30646,57815:30649,57816:30655,57817:30652,57818:30653,57819:30651,57820:30663,57821:30669,57822:30679,57823:30682,57824:30684,57825:30691,57826:30702,57827:30716,57828:30732,57829:30738,57830:31014,57831:30752,57832:31018,57833:30789,57834:30862,57835:30836,57836:30854,57837:30844,57838:30874,57839:30860,57840:30883,57841:30901,57842:30890,57843:30895,57844:30929,57845:30918,57846:30923,57847:30932,57848:30910,57849:30908,57850:30917,57851:30922,57852:30956,57920:30951,57921:30938,57922:30973,57923:30964,57924:30983,57925:30994,57926:30993,57927:31001,57928:31020,57929:31019,57930:31040,57931:31072,57932:31063,57933:31071,57934:31066,57935:31061,57936:31059,57937:31098,57938:31103,57939:31114,57940:31133,57941:31143,57942:40779,57943:31146,57944:31150,57945:31155,57946:31161,57947:31162,57948:31177,57949:31189,57950:31207,57951:31212,57952:31201,57953:31203,57954:31240,57955:31245,57956:31256,57957:31257,57958:31264,57959:31263,57960:31104,57961:31281,57962:31291,57963:31294,57964:31287,57965:31299,57966:31319,57967:31305,57968:31329,57969:31330,57970:31337,57971:40861,57972:31344,57973:31353,57974:31357,57975:31368,57976:31383,57977:31381,57978:31384,57979:31382,57980:31401,57981:31432,57982:31408,57984:31414,57985:31429,57986:31428,57987:31423,57988:36995,57989:31431,57990:31434,57991:31437,57992:31439,57993:31445,57994:31443,57995:31449,57996:31450,57997:31453,57998:31457,57999:31458,58e3:31462,58001:31469,58002:31472,58003:31490,58004:31503,58005:31498,58006:31494,58007:31539,58008:31512,58009:31513,58010:31518,58011:31541,58012:31528,58013:31542,58014:31568,58015:31610,58016:31492,58017:31565,58018:31499,58019:31564,58020:31557,58021:31605,58022:31589,58023:31604,58024:31591,58025:31600,58026:31601,58027:31596,58028:31598,58029:31645,58030:31640,58031:31647,58032:31629,58033:31644,58034:31642,58035:31627,58036:31634,58037:31631,58038:31581,58039:31641,58040:31691,58041:31681,58042:31692,58043:31695,58044:31668,58045:31686,58046:31709,58047:31721,58048:31761,58049:31764,58050:31718,58051:31717,58052:31840,58053:31744,58054:31751,58055:31763,58056:31731,58057:31735,58058:31767,58059:31757,58060:31734,58061:31779,58062:31783,58063:31786,58064:31775,58065:31799,58066:31787,58067:31805,58068:31820,58069:31811,58070:31828,58071:31823,58072:31808,58073:31824,58074:31832,58075:31839,58076:31844,58077:31830,58078:31845,58079:31852,58080:31861,58081:31875,58082:31888,58083:31908,58084:31917,58085:31906,58086:31915,58087:31905,58088:31912,58089:31923,58090:31922,58091:31921,58092:31918,58093:31929,58094:31933,58095:31936,58096:31941,58097:31938,58098:31960,58099:31954,58100:31964,58101:31970,58102:39739,58103:31983,58104:31986,58105:31988,58106:31990,58107:31994,58108:32006,58176:32002,58177:32028,58178:32021,58179:32010,58180:32069,58181:32075,58182:32046,58183:32050,58184:32063,58185:32053,58186:32070,58187:32115,58188:32086,58189:32078,58190:32114,58191:32104,58192:32110,58193:32079,58194:32099,58195:32147,58196:32137,58197:32091,58198:32143,58199:32125,58200:32155,58201:32186,58202:32174,58203:32163,58204:32181,58205:32199,58206:32189,58207:32171,58208:32317,58209:32162,58210:32175,58211:32220,58212:32184,58213:32159,58214:32176,58215:32216,58216:32221,58217:32228,58218:32222,58219:32251,58220:32242,58221:32225,58222:32261,58223:32266,58224:32291,58225:32289,58226:32274,58227:32305,58228:32287,58229:32265,58230:32267,58231:32290,58232:32326,58233:32358,58234:32315,58235:32309,58236:32313,58237:32323,58238:32311,58240:32306,58241:32314,58242:32359,58243:32349,58244:32342,58245:32350,58246:32345,58247:32346,58248:32377,58249:32362,58250:32361,58251:32380,58252:32379,58253:32387,58254:32213,58255:32381,58256:36782,58257:32383,58258:32392,58259:32393,58260:32396,58261:32402,58262:32400,58263:32403,58264:32404,58265:32406,58266:32398,58267:32411,58268:32412,58269:32568,58270:32570,58271:32581,58272:32588,58273:32589,58274:32590,58275:32592,58276:32593,58277:32597,58278:32596,58279:32600,58280:32607,58281:32608,58282:32616,58283:32617,58284:32615,58285:32632,58286:32642,58287:32646,58288:32643,58289:32648,58290:32647,58291:32652,58292:32660,58293:32670,58294:32669,58295:32666,58296:32675,58297:32687,58298:32690,58299:32697,58300:32686,58301:32694,58302:32696,58303:35697,58304:32709,58305:32710,58306:32714,58307:32725,58308:32724,58309:32737,58310:32742,58311:32745,58312:32755,58313:32761,58314:39132,58315:32774,58316:32772,58317:32779,58318:32786,58319:32792,58320:32793,58321:32796,58322:32801,58323:32808,58324:32831,58325:32827,58326:32842,58327:32838,58328:32850,58329:32856,58330:32858,58331:32863,58332:32866,58333:32872,58334:32883,58335:32882,58336:32880,58337:32886,58338:32889,58339:32893,58340:32895,58341:32900,58342:32902,58343:32901,58344:32923,58345:32915,58346:32922,58347:32941,58348:20880,58349:32940,58350:32987,58351:32997,58352:32985,58353:32989,58354:32964,58355:32986,58356:32982,58357:33033,58358:33007,58359:33009,58360:33051,58361:33065,58362:33059,58363:33071,58364:33099,58432:38539,58433:33094,58434:33086,58435:33107,58436:33105,58437:33020,58438:33137,58439:33134,58440:33125,58441:33126,58442:33140,58443:33155,58444:33160,58445:33162,58446:33152,58447:33154,58448:33184,58449:33173,58450:33188,58451:33187,58452:33119,58453:33171,58454:33193,58455:33200,58456:33205,58457:33214,58458:33208,58459:33213,58460:33216,58461:33218,58462:33210,58463:33225,58464:33229,58465:33233,58466:33241,58467:33240,58468:33224,58469:33242,58470:33247,58471:33248,58472:33255,58473:33274,58474:33275,58475:33278,58476:33281,58477:33282,58478:33285,58479:33287,58480:33290,58481:33293,58482:33296,58483:33302,58484:33321,58485:33323,58486:33336,58487:33331,58488:33344,58489:33369,58490:33368,58491:33373,58492:33370,58493:33375,58494:33380,58496:33378,58497:33384,58498:33386,58499:33387,58500:33326,58501:33393,58502:33399,58503:33400,58504:33406,58505:33421,58506:33426,58507:33451,58508:33439,58509:33467,58510:33452,58511:33505,58512:33507,58513:33503,58514:33490,58515:33524,58516:33523,58517:33530,58518:33683,58519:33539,58520:33531,58521:33529,58522:33502,58523:33542,58524:33500,58525:33545,58526:33497,58527:33589,58528:33588,58529:33558,58530:33586,58531:33585,58532:33600,58533:33593,58534:33616,58535:33605,58536:33583,58537:33579,58538:33559,58539:33560,58540:33669,58541:33690,58542:33706,58543:33695,58544:33698,58545:33686,58546:33571,58547:33678,58548:33671,58549:33674,58550:33660,58551:33717,58552:33651,58553:33653,58554:33696,58555:33673,58556:33704,58557:33780,58558:33811,58559:33771,58560:33742,58561:33789,58562:33795,58563:33752,58564:33803,58565:33729,58566:33783,58567:33799,58568:33760,58569:33778,58570:33805,58571:33826,58572:33824,58573:33725,58574:33848,58575:34054,58576:33787,58577:33901,58578:33834,58579:33852,58580:34138,58581:33924,58582:33911,58583:33899,58584:33965,58585:33902,58586:33922,58587:33897,58588:33862,58589:33836,58590:33903,58591:33913,58592:33845,58593:33994,58594:33890,58595:33977,58596:33983,58597:33951,58598:34009,58599:33997,58600:33979,58601:34010,58602:34e3,58603:33985,58604:33990,58605:34006,58606:33953,58607:34081,58608:34047,58609:34036,58610:34071,58611:34072,58612:34092,58613:34079,58614:34069,58615:34068,58616:34044,58617:34112,58618:34147,58619:34136,58620:34120,58688:34113,58689:34306,58690:34123,58691:34133,58692:34176,58693:34212,58694:34184,58695:34193,58696:34186,58697:34216,58698:34157,58699:34196,58700:34203,58701:34282,58702:34183,58703:34204,58704:34167,58705:34174,58706:34192,58707:34249,58708:34234,58709:34255,58710:34233,58711:34256,58712:34261,58713:34269,58714:34277,58715:34268,58716:34297,58717:34314,58718:34323,58719:34315,58720:34302,58721:34298,58722:34310,58723:34338,58724:34330,58725:34352,58726:34367,58727:34381,58728:20053,58729:34388,58730:34399,58731:34407,58732:34417,58733:34451,58734:34467,58735:34473,58736:34474,58737:34443,58738:34444,58739:34486,58740:34479,58741:34500,58742:34502,58743:34480,58744:34505,58745:34851,58746:34475,58747:34516,58748:34526,58749:34537,58750:34540,58752:34527,58753:34523,58754:34543,58755:34578,58756:34566,58757:34568,58758:34560,58759:34563,58760:34555,58761:34577,58762:34569,58763:34573,58764:34553,58765:34570,58766:34612,58767:34623,58768:34615,58769:34619,58770:34597,58771:34601,58772:34586,58773:34656,58774:34655,58775:34680,58776:34636,58777:34638,58778:34676,58779:34647,58780:34664,58781:34670,58782:34649,58783:34643,58784:34659,58785:34666,58786:34821,58787:34722,58788:34719,58789:34690,58790:34735,58791:34763,58792:34749,58793:34752,58794:34768,58795:38614,58796:34731,58797:34756,58798:34739,58799:34759,58800:34758,58801:34747,58802:34799,58803:34802,58804:34784,58805:34831,58806:34829,58807:34814,58808:34806,58809:34807,58810:34830,58811:34770,58812:34833,58813:34838,58814:34837,58815:34850,58816:34849,58817:34865,58818:34870,58819:34873,58820:34855,58821:34875,58822:34884,58823:34882,58824:34898,58825:34905,58826:34910,58827:34914,58828:34923,58829:34945,58830:34942,58831:34974,58832:34933,58833:34941,58834:34997,58835:34930,58836:34946,58837:34967,58838:34962,58839:34990,58840:34969,58841:34978,58842:34957,58843:34980,58844:34992,58845:35007,58846:34993,58847:35011,58848:35012,58849:35028,58850:35032,58851:35033,58852:35037,58853:35065,58854:35074,58855:35068,58856:35060,58857:35048,58858:35058,58859:35076,58860:35084,58861:35082,58862:35091,58863:35139,58864:35102,58865:35109,58866:35114,58867:35115,58868:35137,58869:35140,58870:35131,58871:35126,58872:35128,58873:35148,58874:35101,58875:35168,58876:35166,58944:35174,58945:35172,58946:35181,58947:35178,58948:35183,58949:35188,58950:35191,58951:35198,58952:35203,58953:35208,58954:35210,58955:35219,58956:35224,58957:35233,58958:35241,58959:35238,58960:35244,58961:35247,58962:35250,58963:35258,58964:35261,58965:35263,58966:35264,58967:35290,58968:35292,58969:35293,58970:35303,58971:35316,58972:35320,58973:35331,58974:35350,58975:35344,58976:35340,58977:35355,58978:35357,58979:35365,58980:35382,58981:35393,58982:35419,58983:35410,58984:35398,58985:35400,58986:35452,58987:35437,58988:35436,58989:35426,58990:35461,58991:35458,58992:35460,58993:35496,58994:35489,58995:35473,58996:35493,58997:35494,58998:35482,58999:35491,59e3:35524,59001:35533,59002:35522,59003:35546,59004:35563,59005:35571,59006:35559,59008:35556,59009:35569,59010:35604,59011:35552,59012:35554,59013:35575,59014:35550,59015:35547,59016:35596,59017:35591,59018:35610,59019:35553,59020:35606,59021:35600,59022:35607,59023:35616,59024:35635,59025:38827,59026:35622,59027:35627,59028:35646,59029:35624,59030:35649,59031:35660,59032:35663,59033:35662,59034:35657,59035:35670,59036:35675,59037:35674,59038:35691,59039:35679,59040:35692,59041:35695,59042:35700,59043:35709,59044:35712,59045:35724,59046:35726,59047:35730,59048:35731,59049:35734,59050:35737,59051:35738,59052:35898,59053:35905,59054:35903,59055:35912,59056:35916,59057:35918,59058:35920,59059:35925,59060:35938,59061:35948,59062:35960,59063:35962,59064:35970,59065:35977,59066:35973,59067:35978,59068:35981,59069:35982,59070:35988,59071:35964,59072:35992,59073:25117,59074:36013,59075:36010,59076:36029,59077:36018,59078:36019,59079:36014,59080:36022,59081:36040,59082:36033,59083:36068,59084:36067,59085:36058,59086:36093,59087:36090,59088:36091,59089:36100,59090:36101,59091:36106,59092:36103,59093:36111,59094:36109,59095:36112,59096:40782,59097:36115,59098:36045,59099:36116,59100:36118,59101:36199,59102:36205,59103:36209,59104:36211,59105:36225,59106:36249,59107:36290,59108:36286,59109:36282,59110:36303,59111:36314,59112:36310,59113:36300,59114:36315,59115:36299,59116:36330,59117:36331,59118:36319,59119:36323,59120:36348,59121:36360,59122:36361,59123:36351,59124:36381,59125:36382,59126:36368,59127:36383,59128:36418,59129:36405,59130:36400,59131:36404,59132:36426,59200:36423,59201:36425,59202:36428,59203:36432,59204:36424,59205:36441,59206:36452,59207:36448,59208:36394,59209:36451,59210:36437,59211:36470,59212:36466,59213:36476,59214:36481,59215:36487,59216:36485,59217:36484,59218:36491,59219:36490,59220:36499,59221:36497,59222:36500,59223:36505,59224:36522,59225:36513,59226:36524,59227:36528,59228:36550,59229:36529,59230:36542,59231:36549,59232:36552,59233:36555,59234:36571,59235:36579,59236:36604,59237:36603,59238:36587,59239:36606,59240:36618,59241:36613,59242:36629,59243:36626,59244:36633,59245:36627,59246:36636,59247:36639,59248:36635,59249:36620,59250:36646,59251:36659,59252:36667,59253:36665,59254:36677,59255:36674,59256:36670,59257:36684,59258:36681,59259:36678,59260:36686,59261:36695,59262:36700,59264:36706,59265:36707,59266:36708,59267:36764,59268:36767,59269:36771,59270:36781,59271:36783,59272:36791,59273:36826,59274:36837,59275:36834,59276:36842,59277:36847,59278:36999,59279:36852,59280:36869,59281:36857,59282:36858,59283:36881,59284:36885,59285:36897,59286:36877,59287:36894,59288:36886,59289:36875,59290:36903,59291:36918,59292:36917,59293:36921,59294:36856,59295:36943,59296:36944,59297:36945,59298:36946,59299:36878,59300:36937,59301:36926,59302:36950,59303:36952,59304:36958,59305:36968,59306:36975,59307:36982,59308:38568,59309:36978,59310:36994,59311:36989,59312:36993,59313:36992,59314:37002,59315:37001,59316:37007,59317:37032,59318:37039,59319:37041,59320:37045,59321:37090,59322:37092,59323:25160,59324:37083,59325:37122,59326:37138,59327:37145,59328:37170,59329:37168,59330:37194,59331:37206,59332:37208,59333:37219,59334:37221,59335:37225,59336:37235,59337:37234,59338:37259,59339:37257,59340:37250,59341:37282,59342:37291,59343:37295,59344:37290,59345:37301,59346:37300,59347:37306,59348:37312,59349:37313,59350:37321,59351:37323,59352:37328,59353:37334,59354:37343,59355:37345,59356:37339,59357:37372,59358:37365,59359:37366,59360:37406,59361:37375,59362:37396,59363:37420,59364:37397,59365:37393,59366:37470,59367:37463,59368:37445,59369:37449,59370:37476,59371:37448,59372:37525,59373:37439,59374:37451,59375:37456,59376:37532,59377:37526,59378:37523,59379:37531,59380:37466,59381:37583,59382:37561,59383:37559,59384:37609,59385:37647,59386:37626,59387:37700,59388:37678,59456:37657,59457:37666,59458:37658,59459:37667,59460:37690,59461:37685,59462:37691,59463:37724,59464:37728,59465:37756,59466:37742,59467:37718,59468:37808,59469:37804,59470:37805,59471:37780,59472:37817,59473:37846,59474:37847,59475:37864,59476:37861,59477:37848,59478:37827,59479:37853,59480:37840,59481:37832,59482:37860,59483:37914,59484:37908,59485:37907,59486:37891,59487:37895,59488:37904,59489:37942,59490:37931,59491:37941,59492:37921,59493:37946,59494:37953,59495:37970,59496:37956,59497:37979,59498:37984,59499:37986,59500:37982,59501:37994,59502:37417,59503:38e3,59504:38005,59505:38007,59506:38013,59507:37978,59508:38012,59509:38014,59510:38017,59511:38015,59512:38274,59513:38279,59514:38282,59515:38292,59516:38294,59517:38296,59518:38297,59520:38304,59521:38312,59522:38311,59523:38317,59524:38332,59525:38331,59526:38329,59527:38334,59528:38346,59529:28662,59530:38339,59531:38349,59532:38348,59533:38357,59534:38356,59535:38358,59536:38364,59537:38369,59538:38373,59539:38370,59540:38433,59541:38440,59542:38446,59543:38447,59544:38466,59545:38476,59546:38479,59547:38475,59548:38519,59549:38492,59550:38494,59551:38493,59552:38495,59553:38502,59554:38514,59555:38508,59556:38541,59557:38552,59558:38549,59559:38551,59560:38570,59561:38567,59562:38577,59563:38578,59564:38576,59565:38580,59566:38582,59567:38584,59568:38585,59569:38606,59570:38603,59571:38601,59572:38605,59573:35149,59574:38620,59575:38669,59576:38613,59577:38649,59578:38660,59579:38662,59580:38664,59581:38675,59582:38670,59583:38673,59584:38671,59585:38678,59586:38681,59587:38692,59588:38698,59589:38704,59590:38713,59591:38717,59592:38718,59593:38724,59594:38726,59595:38728,59596:38722,59597:38729,59598:38748,59599:38752,59600:38756,59601:38758,59602:38760,59603:21202,59604:38763,59605:38769,59606:38777,59607:38789,59608:38780,59609:38785,59610:38778,59611:38790,59612:38795,59613:38799,59614:38800,59615:38812,59616:38824,59617:38822,59618:38819,59619:38835,59620:38836,59621:38851,59622:38854,59623:38856,59624:38859,59625:38876,59626:38893,59627:40783,59628:38898,59629:31455,59630:38902,59631:38901,59632:38927,59633:38924,59634:38968,59635:38948,59636:38945,59637:38967,59638:38973,59639:38982,59640:38991,59641:38987,59642:39019,59643:39023,59644:39024,59712:39025,59713:39028,59714:39027,59715:39082,59716:39087,59717:39089,59718:39094,59719:39108,59720:39107,59721:39110,59722:39145,59723:39147,59724:39171,59725:39177,59726:39186,59727:39188,59728:39192,59729:39201,59730:39197,59731:39198,59732:39204,59733:39200,59734:39212,59735:39214,59736:39229,59737:39230,59738:39234,59739:39241,59740:39237,59741:39248,59742:39243,59743:39249,59744:39250,59745:39244,59746:39253,59747:39319,59748:39320,59749:39333,59750:39341,59751:39342,59752:39356,59753:39391,59754:39387,59755:39389,59756:39384,59757:39377,59758:39405,59759:39406,59760:39409,59761:39410,59762:39419,59763:39416,59764:39425,59765:39439,59766:39429,59767:39394,59768:39449,59769:39467,59770:39479,59771:39493,59772:39490,59773:39488,59774:39491,59776:39486,59777:39509,59778:39501,59779:39515,59780:39511,59781:39519,59782:39522,59783:39525,59784:39524,59785:39529,59786:39531,59787:39530,59788:39597,59789:39600,59790:39612,59791:39616,59792:39631,59793:39633,59794:39635,59795:39636,59796:39646,59797:39647,59798:39650,59799:39651,59800:39654,59801:39663,59802:39659,59803:39662,59804:39668,59805:39665,59806:39671,59807:39675,59808:39686,59809:39704,59810:39706,59811:39711,59812:39714,59813:39715,59814:39717,59815:39719,59816:39720,59817:39721,59818:39722,59819:39726,59820:39727,59821:39730,59822:39748,59823:39747,59824:39759,59825:39757,59826:39758,59827:39761,59828:39768,59829:39796,59830:39827,59831:39811,59832:39825,59833:39830,59834:39831,59835:39839,59836:39840,59837:39848,59838:39860,59839:39872,59840:39882,59841:39865,59842:39878,59843:39887,59844:39889,59845:39890,59846:39907,59847:39906,59848:39908,59849:39892,59850:39905,59851:39994,59852:39922,59853:39921,59854:39920,59855:39957,59856:39956,59857:39945,59858:39955,59859:39948,59860:39942,59861:39944,59862:39954,59863:39946,59864:39940,59865:39982,59866:39963,59867:39973,59868:39972,59869:39969,59870:39984,59871:40007,59872:39986,59873:40006,59874:39998,59875:40026,59876:40032,59877:40039,59878:40054,59879:40056,59880:40167,59881:40172,59882:40176,59883:40201,59884:40200,59885:40171,59886:40195,59887:40198,59888:40234,59889:40230,59890:40367,59891:40227,59892:40223,59893:40260,59894:40213,59895:40210,59896:40257,59897:40255,59898:40254,59899:40262,59900:40264,59968:40285,59969:40286,59970:40292,59971:40273,59972:40272,59973:40281,59974:40306,59975:40329,59976:40327,59977:40363,59978:40303,59979:40314,59980:40346,59981:40356,59982:40361,59983:40370,59984:40388,59985:40385,59986:40379,59987:40376,59988:40378,59989:40390,59990:40399,59991:40386,59992:40409,59993:40403,59994:40440,59995:40422,59996:40429,59997:40431,59998:40445,59999:40474,6e4:40475,60001:40478,60002:40565,60003:40569,60004:40573,60005:40577,60006:40584,60007:40587,60008:40588,60009:40594,60010:40597,60011:40593,60012:40605,60013:40613,60014:40617,60015:40632,60016:40618,60017:40621,60018:38753,60019:40652,60020:40654,60021:40655,60022:40656,60023:40660,60024:40668,60025:40670,60026:40669,60027:40672,60028:40677,60029:40680,60030:40687,60032:40692,60033:40694,60034:40695,60035:40697,60036:40699,60037:40700,60038:40701,60039:40711,60040:40712,60041:30391,60042:40725,60043:40737,60044:40748,60045:40766,60046:40778,60047:40786,60048:40788,60049:40803,60050:40799,60051:40800,60052:40801,60053:40806,60054:40807,60055:40812,60056:40810,60057:40823,60058:40818,60059:40822,60060:40853,60061:40860,60062:40864,60063:22575,60064:27079,60065:36953,60066:29796,60067:20956,60068:29081}},function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var t=r(1),c=r(2);e.decode=function(o,e){var r=new Uint8ClampedArray(o.length);r.set(o);for(var s=new t.default(285,256,0),a=new c.default(s,r),n=new Uint8ClampedArray(e),d=!1,l=0;l<e;l++){var i=a.evaluateAt(s.exp(l+s.generatorBase));n[n.length-1-l]=i,0!==i&&(d=!0)}if(!d)return r;var B=new c.default(s,n),k=function(o,e,r,t){var c;e.degree()<r.degree()&&(e=(c=[r,e])[0],r=c[1]);for(var s=e,a=r,n=o.zero,d=o.one;a.degree()>=t/2;){var l=s,i=n;if(n=d,(s=a).isZero())return null;a=l;for(var B=o.zero,k=s.getCoefficient(s.degree()),u=o.inverse(k);a.degree()>=s.degree()&&!a.isZero();){var C=a.degree()-s.degree(),m=o.multiply(a.getCoefficient(a.degree()),u);B=B.addOrSubtract(o.buildMonomial(C,m)),a=a.addOrSubtract(s.multiplyByMonomial(C,m))}if(d=B.multiplyPoly(n).addOrSubtract(i),a.degree()>=s.degree())return null}var f=d.getCoefficient(0);if(0===f)return null;var w=o.inverse(f);return[d.multiply(w),a.multiply(w)]}(s,s.buildMonomial(e,1),B,e);if(null===k)return null;var u=function(o,e){var r=e.degree();if(1===r)return[e.getCoefficient(1)];for(var t=new Array(r),c=0,s=1;s<o.size&&c<r;s++)0===e.evaluateAt(s)&&(t[c]=o.inverse(s),c++);return c!==r?null:t}(s,k[0]);if(null==u)return null;for(var C=function(o,e,r){for(var c=r.length,s=new Array(c),a=0;a<c;a++){for(var n=o.inverse(r[a]),d=1,l=0;l<c;l++)a!==l&&(d=o.multiply(d,t.addOrSubtractGF(1,o.multiply(r[l],n))));s[a]=o.multiply(e.evaluateAt(n),o.inverse(d)),0!==o.generatorBase&&(s[a]=o.multiply(s[a],n))}return s}(s,k[1],u),m=0;m<u.length;m++){var f=r.length-1-s.log(u[m]);if(f<0)return null;r[f]=t.addOrSubtractGF(r[f],C[m])}return r}},function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.VERSIONS=[{infoBits:null,versionNumber:1,alignmentPatternCenters:[],errorCorrectionLevels:[{ecCodewordsPerBlock:7,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:19}]},{ecCodewordsPerBlock:10,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:16}]},{ecCodewordsPerBlock:13,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:13}]},{ecCodewordsPerBlock:17,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:9}]}]},{infoBits:null,versionNumber:2,alignmentPatternCenters:[6,18],errorCorrectionLevels:[{ecCodewordsPerBlock:10,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:34}]},{ecCodewordsPerBlock:16,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:28}]},{ecCodewordsPerBlock:22,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:22}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:16}]}]},{infoBits:null,versionNumber:3,alignmentPatternCenters:[6,22],errorCorrectionLevels:[{ecCodewordsPerBlock:15,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:55}]},{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:44}]},{ecCodewordsPerBlock:18,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:17}]},{ecCodewordsPerBlock:22,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:13}]}]},{infoBits:null,versionNumber:4,alignmentPatternCenters:[6,26],errorCorrectionLevels:[{ecCodewordsPerBlock:20,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:80}]},{ecCodewordsPerBlock:18,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:32}]},{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:24}]},{ecCodewordsPerBlock:16,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:9}]}]},{infoBits:null,versionNumber:5,alignmentPatternCenters:[6,30],errorCorrectionLevels:[{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:108}]},{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:43}]},{ecCodewordsPerBlock:18,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:15},{numBlocks:2,dataCodewordsPerBlock:16}]},{ecCodewordsPerBlock:22,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:11},{numBlocks:2,dataCodewordsPerBlock:12}]}]},{infoBits:null,versionNumber:6,alignmentPatternCenters:[6,34],errorCorrectionLevels:[{ecCodewordsPerBlock:18,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:68}]},{ecCodewordsPerBlock:16,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:27}]},{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:19}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:15}]}]},{infoBits:31892,versionNumber:7,alignmentPatternCenters:[6,22,38],errorCorrectionLevels:[{ecCodewordsPerBlock:20,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:78}]},{ecCodewordsPerBlock:18,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:31}]},{ecCodewordsPerBlock:18,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:14},{numBlocks:4,dataCodewordsPerBlock:15}]},{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:13},{numBlocks:1,dataCodewordsPerBlock:14}]}]},{infoBits:34236,versionNumber:8,alignmentPatternCenters:[6,24,42],errorCorrectionLevels:[{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:97}]},{ecCodewordsPerBlock:22,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:38},{numBlocks:2,dataCodewordsPerBlock:39}]},{ecCodewordsPerBlock:22,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:18},{numBlocks:2,dataCodewordsPerBlock:19}]},{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:14},{numBlocks:2,dataCodewordsPerBlock:15}]}]},{infoBits:39577,versionNumber:9,alignmentPatternCenters:[6,26,46],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:116}]},{ecCodewordsPerBlock:22,ecBlocks:[{numBlocks:3,dataCodewordsPerBlock:36},{numBlocks:2,dataCodewordsPerBlock:37}]},{ecCodewordsPerBlock:20,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:16},{numBlocks:4,dataCodewordsPerBlock:17}]},{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:12},{numBlocks:4,dataCodewordsPerBlock:13}]}]},{infoBits:42195,versionNumber:10,alignmentPatternCenters:[6,28,50],errorCorrectionLevels:[{ecCodewordsPerBlock:18,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:68},{numBlocks:2,dataCodewordsPerBlock:69}]},{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:43},{numBlocks:1,dataCodewordsPerBlock:44}]},{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:6,dataCodewordsPerBlock:19},{numBlocks:2,dataCodewordsPerBlock:20}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:6,dataCodewordsPerBlock:15},{numBlocks:2,dataCodewordsPerBlock:16}]}]},{infoBits:48118,versionNumber:11,alignmentPatternCenters:[6,30,54],errorCorrectionLevels:[{ecCodewordsPerBlock:20,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:81}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:50},{numBlocks:4,dataCodewordsPerBlock:51}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:22},{numBlocks:4,dataCodewordsPerBlock:23}]},{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:3,dataCodewordsPerBlock:12},{numBlocks:8,dataCodewordsPerBlock:13}]}]},{infoBits:51042,versionNumber:12,alignmentPatternCenters:[6,32,58],errorCorrectionLevels:[{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:92},{numBlocks:2,dataCodewordsPerBlock:93}]},{ecCodewordsPerBlock:22,ecBlocks:[{numBlocks:6,dataCodewordsPerBlock:36},{numBlocks:2,dataCodewordsPerBlock:37}]},{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:20},{numBlocks:6,dataCodewordsPerBlock:21}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:7,dataCodewordsPerBlock:14},{numBlocks:4,dataCodewordsPerBlock:15}]}]},{infoBits:55367,versionNumber:13,alignmentPatternCenters:[6,34,62],errorCorrectionLevels:[{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:107}]},{ecCodewordsPerBlock:22,ecBlocks:[{numBlocks:8,dataCodewordsPerBlock:37},{numBlocks:1,dataCodewordsPerBlock:38}]},{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:8,dataCodewordsPerBlock:20},{numBlocks:4,dataCodewordsPerBlock:21}]},{ecCodewordsPerBlock:22,ecBlocks:[{numBlocks:12,dataCodewordsPerBlock:11},{numBlocks:4,dataCodewordsPerBlock:12}]}]},{infoBits:58893,versionNumber:14,alignmentPatternCenters:[6,26,46,66],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:3,dataCodewordsPerBlock:115},{numBlocks:1,dataCodewordsPerBlock:116}]},{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:40},{numBlocks:5,dataCodewordsPerBlock:41}]},{ecCodewordsPerBlock:20,ecBlocks:[{numBlocks:11,dataCodewordsPerBlock:16},{numBlocks:5,dataCodewordsPerBlock:17}]},{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:11,dataCodewordsPerBlock:12},{numBlocks:5,dataCodewordsPerBlock:13}]}]},{infoBits:63784,versionNumber:15,alignmentPatternCenters:[6,26,48,70],errorCorrectionLevels:[{ecCodewordsPerBlock:22,ecBlocks:[{numBlocks:5,dataCodewordsPerBlock:87},{numBlocks:1,dataCodewordsPerBlock:88}]},{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:5,dataCodewordsPerBlock:41},{numBlocks:5,dataCodewordsPerBlock:42}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:5,dataCodewordsPerBlock:24},{numBlocks:7,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:11,dataCodewordsPerBlock:12},{numBlocks:7,dataCodewordsPerBlock:13}]}]},{infoBits:68472,versionNumber:16,alignmentPatternCenters:[6,26,50,74],errorCorrectionLevels:[{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:5,dataCodewordsPerBlock:98},{numBlocks:1,dataCodewordsPerBlock:99}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:7,dataCodewordsPerBlock:45},{numBlocks:3,dataCodewordsPerBlock:46}]},{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:15,dataCodewordsPerBlock:19},{numBlocks:2,dataCodewordsPerBlock:20}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:3,dataCodewordsPerBlock:15},{numBlocks:13,dataCodewordsPerBlock:16}]}]},{infoBits:70749,versionNumber:17,alignmentPatternCenters:[6,30,54,78],errorCorrectionLevels:[{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:107},{numBlocks:5,dataCodewordsPerBlock:108}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:10,dataCodewordsPerBlock:46},{numBlocks:1,dataCodewordsPerBlock:47}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:22},{numBlocks:15,dataCodewordsPerBlock:23}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:14},{numBlocks:17,dataCodewordsPerBlock:15}]}]},{infoBits:76311,versionNumber:18,alignmentPatternCenters:[6,30,56,82],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:5,dataCodewordsPerBlock:120},{numBlocks:1,dataCodewordsPerBlock:121}]},{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:9,dataCodewordsPerBlock:43},{numBlocks:4,dataCodewordsPerBlock:44}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:17,dataCodewordsPerBlock:22},{numBlocks:1,dataCodewordsPerBlock:23}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:14},{numBlocks:19,dataCodewordsPerBlock:15}]}]},{infoBits:79154,versionNumber:19,alignmentPatternCenters:[6,30,58,86],errorCorrectionLevels:[{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:3,dataCodewordsPerBlock:113},{numBlocks:4,dataCodewordsPerBlock:114}]},{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:3,dataCodewordsPerBlock:44},{numBlocks:11,dataCodewordsPerBlock:45}]},{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:17,dataCodewordsPerBlock:21},{numBlocks:4,dataCodewordsPerBlock:22}]},{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:9,dataCodewordsPerBlock:13},{numBlocks:16,dataCodewordsPerBlock:14}]}]},{infoBits:84390,versionNumber:20,alignmentPatternCenters:[6,34,62,90],errorCorrectionLevels:[{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:3,dataCodewordsPerBlock:107},{numBlocks:5,dataCodewordsPerBlock:108}]},{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:3,dataCodewordsPerBlock:41},{numBlocks:13,dataCodewordsPerBlock:42}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:15,dataCodewordsPerBlock:24},{numBlocks:5,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:15,dataCodewordsPerBlock:15},{numBlocks:10,dataCodewordsPerBlock:16}]}]},{infoBits:87683,versionNumber:21,alignmentPatternCenters:[6,28,50,72,94],errorCorrectionLevels:[{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:116},{numBlocks:4,dataCodewordsPerBlock:117}]},{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:17,dataCodewordsPerBlock:42}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:17,dataCodewordsPerBlock:22},{numBlocks:6,dataCodewordsPerBlock:23}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:19,dataCodewordsPerBlock:16},{numBlocks:6,dataCodewordsPerBlock:17}]}]},{infoBits:92361,versionNumber:22,alignmentPatternCenters:[6,26,50,74,98],errorCorrectionLevels:[{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:111},{numBlocks:7,dataCodewordsPerBlock:112}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:17,dataCodewordsPerBlock:46}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:7,dataCodewordsPerBlock:24},{numBlocks:16,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:24,ecBlocks:[{numBlocks:34,dataCodewordsPerBlock:13}]}]},{infoBits:96236,versionNumber:23,alignmentPatternCenters:[6,30,54,74,102],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:121},{numBlocks:5,dataCodewordsPerBlock:122}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:47},{numBlocks:14,dataCodewordsPerBlock:48}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:11,dataCodewordsPerBlock:24},{numBlocks:14,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:16,dataCodewordsPerBlock:15},{numBlocks:14,dataCodewordsPerBlock:16}]}]},{infoBits:102084,versionNumber:24,alignmentPatternCenters:[6,28,54,80,106],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:6,dataCodewordsPerBlock:117},{numBlocks:4,dataCodewordsPerBlock:118}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:6,dataCodewordsPerBlock:45},{numBlocks:14,dataCodewordsPerBlock:46}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:11,dataCodewordsPerBlock:24},{numBlocks:16,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:30,dataCodewordsPerBlock:16},{numBlocks:2,dataCodewordsPerBlock:17}]}]},{infoBits:102881,versionNumber:25,alignmentPatternCenters:[6,32,58,84,110],errorCorrectionLevels:[{ecCodewordsPerBlock:26,ecBlocks:[{numBlocks:8,dataCodewordsPerBlock:106},{numBlocks:4,dataCodewordsPerBlock:107}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:8,dataCodewordsPerBlock:47},{numBlocks:13,dataCodewordsPerBlock:48}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:7,dataCodewordsPerBlock:24},{numBlocks:22,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:22,dataCodewordsPerBlock:15},{numBlocks:13,dataCodewordsPerBlock:16}]}]},{infoBits:110507,versionNumber:26,alignmentPatternCenters:[6,30,58,86,114],errorCorrectionLevels:[{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:10,dataCodewordsPerBlock:114},{numBlocks:2,dataCodewordsPerBlock:115}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:19,dataCodewordsPerBlock:46},{numBlocks:4,dataCodewordsPerBlock:47}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:28,dataCodewordsPerBlock:22},{numBlocks:6,dataCodewordsPerBlock:23}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:33,dataCodewordsPerBlock:16},{numBlocks:4,dataCodewordsPerBlock:17}]}]},{infoBits:110734,versionNumber:27,alignmentPatternCenters:[6,34,62,90,118],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:8,dataCodewordsPerBlock:122},{numBlocks:4,dataCodewordsPerBlock:123}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:22,dataCodewordsPerBlock:45},{numBlocks:3,dataCodewordsPerBlock:46}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:8,dataCodewordsPerBlock:23},{numBlocks:26,dataCodewordsPerBlock:24}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:12,dataCodewordsPerBlock:15},{numBlocks:28,dataCodewordsPerBlock:16}]}]},{infoBits:117786,versionNumber:28,alignmentPatternCenters:[6,26,50,74,98,122],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:3,dataCodewordsPerBlock:117},{numBlocks:10,dataCodewordsPerBlock:118}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:3,dataCodewordsPerBlock:45},{numBlocks:23,dataCodewordsPerBlock:46}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:24},{numBlocks:31,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:11,dataCodewordsPerBlock:15},{numBlocks:31,dataCodewordsPerBlock:16}]}]},{infoBits:119615,versionNumber:29,alignmentPatternCenters:[6,30,54,78,102,126],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:7,dataCodewordsPerBlock:116},{numBlocks:7,dataCodewordsPerBlock:117}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:21,dataCodewordsPerBlock:45},{numBlocks:7,dataCodewordsPerBlock:46}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:1,dataCodewordsPerBlock:23},{numBlocks:37,dataCodewordsPerBlock:24}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:19,dataCodewordsPerBlock:15},{numBlocks:26,dataCodewordsPerBlock:16}]}]},{infoBits:126325,versionNumber:30,alignmentPatternCenters:[6,26,52,78,104,130],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:5,dataCodewordsPerBlock:115},{numBlocks:10,dataCodewordsPerBlock:116}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:19,dataCodewordsPerBlock:47},{numBlocks:10,dataCodewordsPerBlock:48}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:15,dataCodewordsPerBlock:24},{numBlocks:25,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:23,dataCodewordsPerBlock:15},{numBlocks:25,dataCodewordsPerBlock:16}]}]},{infoBits:127568,versionNumber:31,alignmentPatternCenters:[6,30,56,82,108,134],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:13,dataCodewordsPerBlock:115},{numBlocks:3,dataCodewordsPerBlock:116}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:46},{numBlocks:29,dataCodewordsPerBlock:47}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:42,dataCodewordsPerBlock:24},{numBlocks:1,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:23,dataCodewordsPerBlock:15},{numBlocks:28,dataCodewordsPerBlock:16}]}]},{infoBits:133589,versionNumber:32,alignmentPatternCenters:[6,34,60,86,112,138],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:17,dataCodewordsPerBlock:115}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:10,dataCodewordsPerBlock:46},{numBlocks:23,dataCodewordsPerBlock:47}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:10,dataCodewordsPerBlock:24},{numBlocks:35,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:19,dataCodewordsPerBlock:15},{numBlocks:35,dataCodewordsPerBlock:16}]}]},{infoBits:136944,versionNumber:33,alignmentPatternCenters:[6,30,58,86,114,142],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:17,dataCodewordsPerBlock:115},{numBlocks:1,dataCodewordsPerBlock:116}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:14,dataCodewordsPerBlock:46},{numBlocks:21,dataCodewordsPerBlock:47}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:29,dataCodewordsPerBlock:24},{numBlocks:19,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:11,dataCodewordsPerBlock:15},{numBlocks:46,dataCodewordsPerBlock:16}]}]},{infoBits:141498,versionNumber:34,alignmentPatternCenters:[6,34,62,90,118,146],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:13,dataCodewordsPerBlock:115},{numBlocks:6,dataCodewordsPerBlock:116}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:14,dataCodewordsPerBlock:46},{numBlocks:23,dataCodewordsPerBlock:47}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:44,dataCodewordsPerBlock:24},{numBlocks:7,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:59,dataCodewordsPerBlock:16},{numBlocks:1,dataCodewordsPerBlock:17}]}]},{infoBits:145311,versionNumber:35,alignmentPatternCenters:[6,30,54,78,102,126,150],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:12,dataCodewordsPerBlock:121},{numBlocks:7,dataCodewordsPerBlock:122}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:12,dataCodewordsPerBlock:47},{numBlocks:26,dataCodewordsPerBlock:48}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:39,dataCodewordsPerBlock:24},{numBlocks:14,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:22,dataCodewordsPerBlock:15},{numBlocks:41,dataCodewordsPerBlock:16}]}]},{infoBits:150283,versionNumber:36,alignmentPatternCenters:[6,24,50,76,102,128,154],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:6,dataCodewordsPerBlock:121},{numBlocks:14,dataCodewordsPerBlock:122}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:6,dataCodewordsPerBlock:47},{numBlocks:34,dataCodewordsPerBlock:48}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:46,dataCodewordsPerBlock:24},{numBlocks:10,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:2,dataCodewordsPerBlock:15},{numBlocks:64,dataCodewordsPerBlock:16}]}]},{infoBits:152622,versionNumber:37,alignmentPatternCenters:[6,28,54,80,106,132,158],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:17,dataCodewordsPerBlock:122},{numBlocks:4,dataCodewordsPerBlock:123}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:29,dataCodewordsPerBlock:46},{numBlocks:14,dataCodewordsPerBlock:47}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:49,dataCodewordsPerBlock:24},{numBlocks:10,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:24,dataCodewordsPerBlock:15},{numBlocks:46,dataCodewordsPerBlock:16}]}]},{infoBits:158308,versionNumber:38,alignmentPatternCenters:[6,32,58,84,110,136,162],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:4,dataCodewordsPerBlock:122},{numBlocks:18,dataCodewordsPerBlock:123}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:13,dataCodewordsPerBlock:46},{numBlocks:32,dataCodewordsPerBlock:47}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:48,dataCodewordsPerBlock:24},{numBlocks:14,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:42,dataCodewordsPerBlock:15},{numBlocks:32,dataCodewordsPerBlock:16}]}]},{infoBits:161089,versionNumber:39,alignmentPatternCenters:[6,26,54,82,110,138,166],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:20,dataCodewordsPerBlock:117},{numBlocks:4,dataCodewordsPerBlock:118}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:40,dataCodewordsPerBlock:47},{numBlocks:7,dataCodewordsPerBlock:48}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:43,dataCodewordsPerBlock:24},{numBlocks:22,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:10,dataCodewordsPerBlock:15},{numBlocks:67,dataCodewordsPerBlock:16}]}]},{infoBits:167017,versionNumber:40,alignmentPatternCenters:[6,30,58,86,114,142,170],errorCorrectionLevels:[{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:19,dataCodewordsPerBlock:118},{numBlocks:6,dataCodewordsPerBlock:119}]},{ecCodewordsPerBlock:28,ecBlocks:[{numBlocks:18,dataCodewordsPerBlock:47},{numBlocks:31,dataCodewordsPerBlock:48}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:34,dataCodewordsPerBlock:24},{numBlocks:34,dataCodewordsPerBlock:25}]},{ecCodewordsPerBlock:30,ecBlocks:[{numBlocks:20,dataCodewordsPerBlock:15},{numBlocks:61,dataCodewordsPerBlock:16}]}]}]},function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var t=r(0);function c(o,e,r,t){var c=o.x-e.x+r.x-t.x,s=o.y-e.y+r.y-t.y;if(0===c&&0===s)return{a11:e.x-o.x,a12:e.y-o.y,a13:0,a21:r.x-e.x,a22:r.y-e.y,a23:0,a31:o.x,a32:o.y,a33:1};var a=e.x-r.x,n=t.x-r.x,d=e.y-r.y,l=t.y-r.y,i=a*l-n*d,B=(c*l-n*s)/i,k=(a*s-c*d)/i;return{a11:e.x-o.x+B*e.x,a12:e.y-o.y+B*e.y,a13:B,a21:t.x-o.x+k*t.x,a22:t.y-o.y+k*t.y,a23:k,a31:o.x,a32:o.y,a33:1}}e.extract=function(o,e){for(var r,s,a=function(o,e,r,t){var s=c(o,e,r,t);return{a11:s.a22*s.a33-s.a23*s.a32,a12:s.a13*s.a32-s.a12*s.a33,a13:s.a12*s.a23-s.a13*s.a22,a21:s.a23*s.a31-s.a21*s.a33,a22:s.a11*s.a33-s.a13*s.a31,a23:s.a13*s.a21-s.a11*s.a23,a31:s.a21*s.a32-s.a22*s.a31,a32:s.a12*s.a31-s.a11*s.a32,a33:s.a11*s.a22-s.a12*s.a21}}({x:3.5,y:3.5},{x:e.dimension-3.5,y:3.5},{x:e.dimension-6.5,y:e.dimension-6.5},{x:3.5,y:e.dimension-3.5}),n=c(e.topLeft,e.topRight,e.alignmentPattern,e.bottomLeft),d=(s=a,{a11:(r=n).a11*s.a11+r.a21*s.a12+r.a31*s.a13,a12:r.a12*s.a11+r.a22*s.a12+r.a32*s.a13,a13:r.a13*s.a11+r.a23*s.a12+r.a33*s.a13,a21:r.a11*s.a21+r.a21*s.a22+r.a31*s.a23,a22:r.a12*s.a21+r.a22*s.a22+r.a32*s.a23,a23:r.a13*s.a21+r.a23*s.a22+r.a33*s.a23,a31:r.a11*s.a31+r.a21*s.a32+r.a31*s.a33,a32:r.a12*s.a31+r.a22*s.a32+r.a32*s.a33,a33:r.a13*s.a31+r.a23*s.a32+r.a33*s.a33}),l=t.BitMatrix.createEmpty(e.dimension,e.dimension),i=function(o,e){var r=d.a13*o+d.a23*e+d.a33;return{x:(d.a11*o+d.a21*e+d.a31)/r,y:(d.a12*o+d.a22*e+d.a32)/r}},B=0;B<e.dimension;B++)for(var k=0;k<e.dimension;k++){var u=i(k+.5,B+.5);l.set(k,B,o.get(Math.floor(u.x),Math.floor(u.y)))}return{matrix:l,mappingFunction:i}}},function(o,e,r){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var t=function(o,e){return Math.sqrt(Math.pow(e.x-o.x,2)+Math.pow(e.y-o.y,2))};function c(o){return o.reduce((function(o,e){return o+e}))}function s(o,e,r,c){var s,a,n,d,l=[{x:Math.floor(o.x),y:Math.floor(o.y)}],i=Math.abs(e.y-o.y)>Math.abs(e.x-o.x);i?(s=Math.floor(o.y),a=Math.floor(o.x),n=Math.floor(e.y),d=Math.floor(e.x)):(s=Math.floor(o.x),a=Math.floor(o.y),n=Math.floor(e.x),d=Math.floor(e.y));for(var B=Math.abs(n-s),k=Math.abs(d-a),u=Math.floor(-B/2),C=s<n?1:-1,m=a<d?1:-1,f=!0,w=s,P=a;w!==n+C;w+=C){var v=i?P:w,h=i?w:P;if(r.get(v,h)!==f&&(f=!f,l.push({x:v,y:h}),l.length===c+1))break;if((u+=k)>0){if(P===d)break;P+=m,u-=B}}for(var y=[],p=0;p<c;p++)l[p]&&l[p+1]?y.push(t(l[p],l[p+1])):y.push(0);return y}function a(o,e,r,t){var c,a=e.y-o.y,n=e.x-o.x,d=s(o,e,r,Math.ceil(t/2)),l=s(o,{x:o.x-n,y:o.y-a},r,Math.ceil(t/2)),i=d.shift()+l.shift()-1;return(c=l.concat(i)).concat.apply(c,d)}function n(o,e){var r=c(o)/c(e),t=0;return e.forEach((function(e,c){t+=Math.pow(o[c]-e*r,2)})),{averageSize:r,error:t}}function d(o,e,r){try{var t=a(o,{x:-1,y:o.y},r,e.length),c=a(o,{x:o.x,y:-1},r,e.length),s=a(o,{x:Math.max(0,o.x-o.y)-1,y:Math.max(0,o.y-o.x)-1},r,e.length),d=a(o,{x:Math.min(r.width,o.x+o.y)+1,y:Math.min(r.height,o.y+o.x)+1},r,e.length),l=n(t,e),i=n(c,e),B=n(s,e),k=n(d,e),u=Math.sqrt(l.error*l.error+i.error*i.error+B.error*B.error+k.error*k.error),C=(l.averageSize+i.averageSize+B.averageSize+k.averageSize)/4;return u+(Math.pow(l.averageSize-C,2)+Math.pow(i.averageSize-C,2)+Math.pow(B.averageSize-C,2)+Math.pow(k.averageSize-C,2))/C}catch(o){return 1/0}}function l(o,e){for(var r=Math.round(e.x);o.get(r,Math.round(e.y));)r--;for(var t=Math.round(e.x);o.get(t,Math.round(e.y));)t++;for(var c=(r+t)/2,s=Math.round(e.y);o.get(Math.round(c),s);)s--;for(var a=Math.round(e.y);o.get(Math.round(c),a);)a++;return{x:c,y:(s+a)/2}}function i(o,e,r,s,n){var l,i,B;try{l=function(o,e,r,s){var n=(c(a(o,r,s,5))/7+c(a(o,e,s,5))/7+c(a(r,o,s,5))/7+c(a(e,o,s,5))/7)/4;if(n<1)throw new Error("Invalid module size");var d=Math.round(t(o,e)/n),l=Math.round(t(o,r)/n),i=Math.floor((d+l)/2)+7;switch(i%4){case 0:i++;break;case 2:i--}return{dimension:i,moduleSize:n}}(s,r,n,o),i=l.dimension,B=l.moduleSize}catch(o){return null}var k=r.x-s.x+n.x,u=r.y-s.y+n.y,C=(t(s,n)+t(s,r))/2/B,m=1-3/C,f={x:s.x+m*(k-s.x),y:s.y+m*(u-s.y)},w=e.map((function(e){var r=(e.top.startX+e.top.endX+e.bottom.startX+e.bottom.endX)/4,s=(e.top.y+e.bottom.y+1)/2;if(o.get(Math.floor(r),Math.floor(s))){var a=[e.top.endX-e.top.startX,e.bottom.endX-e.bottom.startX,e.bottom.y-e.top.y+1];c(a);return{x:r,y:s,score:d({x:Math.floor(r),y:Math.floor(s)},[1,1,1],o)+t({x:r,y:s},f)}}})).filter((function(o){return!!o})).sort((function(o,e){return o.score-e.score}));return{alignmentPattern:C>=15&&w.length?w[0]:f,dimension:i}}e.locate=function(o){for(var e=[],r=[],s=[],a=[],n=function(t){for(var n=0,d=!1,l=[0,0,0,0,0],i=function(e){var s=o.get(e,t);if(s===d)n++;else{l=[l[1],l[2],l[3],l[4],n],n=1,d=s;var i=c(l)/7,B=Math.abs(l[0]-i)<i&&Math.abs(l[1]-i)<i&&Math.abs(l[2]-3*i)<3*i&&Math.abs(l[3]-i)<i&&Math.abs(l[4]-i)<i&&!s,k=c(l.slice(-3))/3,u=Math.abs(l[2]-k)<k&&Math.abs(l[3]-k)<k&&Math.abs(l[4]-k)<k&&s;if(B){var C=e-l[3]-l[4],m=C-l[2],f={startX:m,endX:C,y:t};(w=r.filter((function(o){return m>=o.bottom.startX&&m<=o.bottom.endX||C>=o.bottom.startX&&m<=o.bottom.endX||m<=o.bottom.startX&&C>=o.bottom.endX&&l[2]/(o.bottom.endX-o.bottom.startX)<1.5&&l[2]/(o.bottom.endX-o.bottom.startX)>.5}))).length>0?w[0].bottom=f:r.push({top:f,bottom:f})}if(u){var w,P=e-l[4],v=P-l[3];f={startX:v,y:t,endX:P};(w=a.filter((function(o){return v>=o.bottom.startX&&v<=o.bottom.endX||P>=o.bottom.startX&&v<=o.bottom.endX||v<=o.bottom.startX&&P>=o.bottom.endX&&l[2]/(o.bottom.endX-o.bottom.startX)<1.5&&l[2]/(o.bottom.endX-o.bottom.startX)>.5}))).length>0?w[0].bottom=f:a.push({top:f,bottom:f})}}},B=-1;B<=o.width;B++)i(B);e.push.apply(e,r.filter((function(o){return o.bottom.y!==t&&o.bottom.y-o.top.y>=2}))),r=r.filter((function(o){return o.bottom.y===t})),s.push.apply(s,a.filter((function(o){return o.bottom.y!==t}))),a=a.filter((function(o){return o.bottom.y===t}))},B=0;B<=o.height;B++)n(B);e.push.apply(e,r.filter((function(o){return o.bottom.y-o.top.y>=2}))),s.push.apply(s,a);var k=e.filter((function(o){return o.bottom.y-o.top.y>=2})).map((function(e){var r=(e.top.startX+e.top.endX+e.bottom.startX+e.bottom.endX)/4,t=(e.top.y+e.bottom.y+1)/2;if(o.get(Math.round(r),Math.round(t))){var s=[e.top.endX-e.top.startX,e.bottom.endX-e.bottom.startX,e.bottom.y-e.top.y+1],a=c(s)/s.length;return{score:d({x:Math.round(r),y:Math.round(t)},[1,1,3,1,1],o),x:r,y:t,size:a}}})).filter((function(o){return!!o})).sort((function(o,e){return o.score-e.score})).map((function(o,e,r){if(e>4)return null;var t=r.filter((function(o,r){return e!==r})).map((function(e){return{x:e.x,y:e.y,score:e.score+Math.pow(e.size-o.size,2)/o.size,size:e.size}})).sort((function(o,e){return o.score-e.score}));if(t.length<2)return null;var c=o.score+t[0].score+t[1].score;return{points:[o].concat(t.slice(0,2)),score:c}})).filter((function(o){return!!o})).sort((function(o,e){return o.score-e.score}));if(0===k.length)return null;var u=function(o,e,r){var c,s,a,n,d,l,i,B=t(o,e),k=t(e,r),u=t(o,r);return k>=B&&k>=u?(d=(c=[e,o,r])[0],l=c[1],i=c[2]):u>=k&&u>=B?(d=(s=[o,e,r])[0],l=s[1],i=s[2]):(d=(a=[o,r,e])[0],l=a[1],i=a[2]),(i.x-l.x)*(d.y-l.y)-(i.y-l.y)*(d.x-l.x)<0&&(d=(n=[i,d])[0],i=n[1]),{bottomLeft:d,topLeft:l,topRight:i}}(k[0].points[0],k[0].points[1],k[0].points[2]),C=u.topRight,m=u.topLeft,f=u.bottomLeft,w=i(o,s,C,m,f),P=[];w&&P.push({alignmentPattern:{x:w.alignmentPattern.x,y:w.alignmentPattern.y},bottomLeft:{x:f.x,y:f.y},dimension:w.dimension,topLeft:{x:m.x,y:m.y},topRight:{x:C.x,y:C.y}});var v=l(o,C),h=l(o,m),y=l(o,f),p=i(o,s,v,h,y);return p&&P.push({alignmentPattern:{x:p.alignmentPattern.x,y:p.alignmentPattern.y},bottomLeft:{x:y.x,y:y.y},topLeft:{x:h.x,y:h.y},topRight:{x:v.x,y:v.y},dimension:p.dimension}),0===P.length?null:P}}]).default}));
return self.jsQR;})();

    function barcodeSupported() {
        return typeof window.BarcodeDetector === 'function';
    }

    function detectCodes(rect) {
        ensurePixels().then((src) => {
            if (!win) return;
            if (!src) { toast('Нет доступа к пикселям этой картинки'); return; }
            cropRegion(rect, 1).then((cv) => {
                if (!win) return;
                if (!cv) { toast('Не удалось вырезать область'); return; }
                runBarcode(cv);
            });
        });
    }

    // Декодируем QR своим jsQR. Крупные области уменьшаем до 1400 px по
    // длинной стороне: разбор идёт по всем пикселям, и на 1600 px это
    // заметный, но всё же приемлемый стопор, а на 1400 — вдвое дешевле.
    function decodeQrCanvas(cv) {
        try {
            const side = Math.max(cv.width, cv.height);
            let src = cv;
            if (side > 1400) {
                const k = 1400 / side;
                const small = document.createElement('canvas');
                small.width = Math.max(1, Math.round(cv.width * k));
                small.height = Math.max(1, Math.round(cv.height * k));
                const sc = small.getContext('2d');
                if (sc) {
                    sc.imageSmoothingEnabled = true;
                    sc.drawImage(cv, 0, 0, small.width, small.height);
                    src = small;
                }
            }
            const ctx = src.getContext('2d');
            if (!ctx) return null;
            const data = ctx.getImageData(0, 0, src.width, src.height);
            const res = jsQR(data.data, data.width, data.height, { inversionAttempts: 'attemptBoth' });
            return res && res.data ? res.data : null;
        } catch (e) {
            return null;
        }
    }

    function runBarcode(cv) {
        // 1) Свой декодер: работает всегда, без API браузера.
        const qrText = decodeQrCanvas(cv);
        if (qrText) {
            showCodeResult({ rawValue: qrText, format: 'qr_code' });
            return;
        }

        // 2) BarcodeDetector умеет линейные форматы (EAN, Code 128).
        //    Если браузер его не даёт — честно говорим, что не нашли.
        if (!barcodeSupported()) {
            announce('QR-код не найден. Выделите его плотнее и целиком.');
            return;
        }

        let formats = [];
        try {
            if (BarcodeDetector.getSupportedFormats) {
                formats = ['qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'itf', 'pdf417', 'data_matrix'];
            }
        } catch (e) { formats = []; }

        const go = (fmts) => {
            let det;
            try {
                det = fmts && fmts.length ? new BarcodeDetector({ formats: fmts }) : new BarcodeDetector();
            } catch (e) {
                try { det = new BarcodeDetector(); } catch (e2) {
                    toast('Детектор кодов недоступен');
                    return;
                }
            }
            det.detect(cv).then((codes) => {
                if (!win) return;
                if (!codes || !codes.length) {
                    announce('Код не распознан. Попробуйте выделить плотнее или крупнее.');
                    return;
                }
                showCodeResult(codes[0]);
            }).catch(() => {
                if (!win) return;
                toast('Не удалось распознать код');
            });
        };

        if (formats.length) {
            go(formats);
        } else {
            go(null);
        }
    }

    function showCodeResult(code) {
        if (!win) return;
        const raw = String(code.rawValue || '');
        const fmt = String(code.format || '');
        closeMenu();
        const panel = openPanel(null, 'Распознанный код', (p) => {
            const val = mk('div', {
                padding: '2px 6px 6px', wordBreak: 'break-all',
                font: '12px ui-monospace, monospace', color: '#cfe9ff',
            });
            val.textContent = raw || '(пусто)';
            p.appendChild(val);
            menuNote(p, 'Формат: ' + fmt);

            menuItem(p, {
                label: 'Копировать значение', icon: 'copy',
                onClick: () => copyText(raw, 'Значение скопировано'),
            });

            const isUrl = /^https?:\/\//i.test(raw) || /^www\./i.test(raw);
            if (isUrl) {
                const host = safeHost(raw);
                menuItem(p, {
                    label: 'Открыть ссылку', icon: 'arrow',
                    hint: host || '',
                    onClick: () => openScannedLink(raw),
                });
                menuNote(p, 'Ссылка из кода. Проверьте домен' + (host ? ' (' + host + ')' : '') + ', прежде чем открывать.');
            }
        }, { minWidth: 250 });
    }

    function safeHost(raw) {
        try {
            const u = new URL(/^www\./i.test(raw) ? 'https://' + raw : raw);
            return u.host;
        } catch (e) { return ''; }
    }

    function openScannedLink(raw) {
        const href = /^https?:\/\//i.test(raw) ? raw : ('https://' + raw);
        const host = safeHost(href);
        // Ссылка из QR — недоверенная: спрашиваем подтверждение с доменом.
        const ok = window.confirm(
            'Открыть ссылку из QR-кода?\n\n' + href +
            (host ? '\n\nДомен: ' + host : '') +
            '\n\nОткрывайте, только если доверяете источнику.'
        );
        if (!ok) { announce('Открытие ссылки отменено'); return; }
        try {
            window.open(href, '_blank', 'noopener,noreferrer');
        } catch (e) {
            toast('Не удалось открыть ссылку');
        }
    }

    // --- 2.3 Текст: локальный TextDetector или честный фолбэк ---------------
    // --- 2.3 Распознавание текста (tesseract.js) -------------------------
    // window.TextDetector удалён из Chrome/Edge: он есть только в ChromeOS
    // и на Android. Поэтому читаем текст настоящим движком, который
    // подгружается лениво при первом использовании и живёт до 60 с простоя.
    const OCR_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    let ocrLibPromise = null;
    let ocrWorker = null;
    let ocrWorkerKey = '';
    let ocrIdleTimer = 0;

    function loadOcrLib() {
        if (window.Tesseract) return Promise.resolve(window.Tesseract);
        if (ocrLibPromise) return ocrLibPromise;
        ocrLibPromise = new Promise((resolve) => {
            let done = false;
            const finish = (val) => { if (done) return; done = true; resolve(val || null); };
            try {
                const s = document.createElement('script');
                s.src = OCR_CDN;
                s.async = true;
                s.onload = () => finish(window.Tesseract);
                s.onerror = () => finish(null);
                setTimeout(() => finish(window.Tesseract), 25000);
                (document.head || document.documentElement).appendChild(s);
            } catch (e) { finish(null); }
        });
        return ocrLibPromise;
    }

    function stopOcrWorker() {
        const w = ocrWorker;
        ocrWorker = null;
        ocrWorkerKey = '';
        if (w) { try { w.terminate(); } catch (e) { /* ignore */ } }
    }

    function scheduleOcrIdleStop() {
        if (ocrIdleTimer) clearTimeout(ocrIdleTimer);
        ocrIdleTimer = setTimeout(() => { ocrIdleTimer = 0; stopOcrWorker(); }, 60000);
    }

    function getOcrWorker() {
        const langs = ['eng', 'rus'];
        const key = langs.join('+');
        if (ocrWorker && ocrWorkerKey === key) return Promise.resolve(ocrWorker);
        stopOcrWorker();
        return Promise.resolve(window.Tesseract.createWorker(langs, 1, { logger: () => {} }))
            .then((w) => { ocrWorker = w; ocrWorkerKey = key; return w; });
    }

    // Мелкий фрагмент движок читает плохо: поднимаем вплоть до OCR_SCALE,
    // чтобы высота области была не меньше ~40 px экрана.
    function ocrScaleFor(rect) {
        const shownH = Math.max(1, Math.round(rect.h * scale));
        return Math.max(1, Math.min(OCR_SCALE, 40 / shownH));
    }

    function readText(rect) {
        ensurePixels().then((src) => {
            if (!win) return;
            if (!src) { toast('Нет доступа к пикселям этой картинки'); return; }
            cropRegion(rect, ocrScaleFor(rect)).then((cv) => {
                if (!win) return;
                if (!cv) { toast('Не удалось вырезать область'); return; }
                showHint('Распознаю текст…');
                loadOcrLib().then((T) => {
                    if (!win) return;
                    if (!T) { showHint(null); textFallback(rect, 'Не удалось загрузить движок распознавания'); return; }
                    // Первый запуск качает языковые модели (несколько МБ),
                    // поэтому честно пишем, что именно происходит.
                    showHint('Загружаю языковые модели (первый раз это долго)…');
                    getOcrWorker().then((w) => Promise.resolve(w.recognize(cv))).then((res) => {
                        if (!win) return;
                        showHint(null);
                        scheduleOcrIdleStop();
                        const text = String((res && res.data && res.data.text) || '').trim();
                        const conf = Math.round(Number((res && res.data && res.data.confidence) || 0));
                        if (text) showTextResult(text, rect, true, null, conf, null);
                        else textFallback(rect, 'Текст не найден');
                    }).catch(() => {
                        if (!win) return;
                        showHint(null);
                        textFallback(rect, 'Движок распознавания не ответил');
                    });
                });
            });
        });
    }

    // Если движок недоступен (нет сети, строгий CSP страницы), не показываем
    // тупик, а даём два реальных действия с вырезанным фрагментом.
    function textFallback(rect, why) {
        cropRegion(rect, OCR_SCALE).then((up) => {
            if (!win) return;
            if (!up) { toast('Не удалось вырезать область'); return; }
            const note = (why ? why + '. ' : '') +
                'Фрагмент можно скопировать картинкой или сохранить PNG и распознать отдельно.';
            const copyImage = () => {
                if (!navigator.clipboard || !window.ClipboardItem) { toast('Копирование картинок не поддерживается'); return; }
                up.toBlob((blob) => {
                    if (!win || !blob) return;
                    navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
                        .then(() => { toast('Фрагмент скопирован'); announce('Область скопирована картинкой'); })
                        .catch(() => toast('Скопировать не удалось — сохраните PNG'));
                }, 'image/png');
            };
            const savePng = () => {
                up.toBlob((blob) => {
                    if (!blob) return;
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'фрагмент.png';
                    a.style.display = 'none';
                    (document.body || document.documentElement).appendChild(a);
                    a.click();
                    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
                }, 'image/png');
            };
            showTextResult('', rect, false, note, 0, { copyImage, savePng });
        });
    }

    function showTextResult(text, rect, detected, note, conf, acts) {
        if (!win) return;
        closeMenu();
        openPanel(null, detected ? 'Распознанный текст' : 'Текст: увеличенная копия', (p) => {
            if (text) {
                const box = document.createElement('textarea');
                box.value = text;
                box.readOnly = true;
                box.rows = Math.min(8, Math.max(2, text.split('\n').length));
                Object.assign(box.style, {
                    width: '100%', boxSizing: 'border-box', resize: 'vertical',
                    background: '#1b1b1b', color: '#e8f2ff', border: '1px solid rgba(255,255,255,0.18)',
                    borderRadius: '5px', padding: '6px', font: '12px/1.45 ui-monospace, monospace',
                    outline: 'none',
                });
                box.addEventListener('mousedown', (e) => e.stopPropagation());
                p.appendChild(box);
                if (conf) menuNote(p, 'Уверенность движка: ' + conf + '%');
                menuItem(p, {
                    label: 'Копировать текст', icon: 'copy',
                    onClick: () => copyText(text, 'Текст скопирован'),
                });
            }
            if (acts) {
                menuItem(p, { label: 'Копировать фрагмент картинкой', icon: 'copy', onClick: acts.copyImage });
                menuItem(p, { label: 'Сохранить фрагмент PNG', icon: 'save', onClick: acts.savePng });
            }
            if (note) menuNote(p, note);
            menuItem(p, {
                label: 'Выделить другую область', icon: 'scan',
                onClick: () => { closeMenu(); startScanFor('text'); },
            });
        }, { minWidth: 260 });
    }

    function startScanFor(mode) {
        scanMode = mode;
        startScan();
    }

    // ======================================================================
    // 3.5 Пресеты экспорта
    // ======================================================================
    const FORMAT_META = {
        png: { mime: 'image/png', ext: 'png', label: 'PNG' },
        jpeg: { mime: 'image/jpeg', ext: 'jpg', label: 'JPEG' },
        webp: { mime: 'image/webp', ext: 'webp', label: 'WebP' },
    };

    function currentMime() {
        return (FORMAT_META[exportFormat] || FORMAT_META.png).mime;
    }

    function canvasToType(canvas, type, quality) {
        return new Promise((resolve, reject) => {
            try {
                canvas.toBlob((b) => {
                    if (b) resolve(b);
                    else reject(new Error('empty'));
                }, type || 'image/png', quality);
            } catch (e) {
                reject(e);
            }
        });
    }

    function fileNameForFormat(url, fmt) {
        const base = safeFileName(url).replace(/\.png$/i, '');
        const ext = (FORMAT_META[fmt] || FORMAT_META.png).ext;
        return base + '.' + ext;
    }

    function exportAs(fmt) {
        if (!imgEl) return;
        exportFormat = (FORMAT_META[fmt] ? fmt : 'png');
        storeSet('img_mag_format', exportFormat);
        const meta = FORMAT_META[exportFormat];
        resolveExportCanvas().then((res) => {
            if (!win) return;
            if (!res.canvas) { exportError(res); return; }
            return canvasToType(res.canvas, meta.mime, meta.quality || exportQuality)
                .then((blob) => {
                    const a = document.createElement('a');
                    const href = URL.createObjectURL(blob);
                    a.href = href;
                    a.download = fileNameForFormat(imageUrl, exportFormat);
                    a.style.display = 'none';
                    rootEl().appendChild(a);
                    a.click();
                    setTimeout(() => {
                        try { a.remove(); } catch (e) { /* ignore */ }
                        URL.revokeObjectURL(href);
                    }, 4000);
                    toast('Сохранено: ' + a.download);
                })
                .catch(() => {
                    // WebP/JPEG может не поддерживаться — честно откатываемся на PNG
                    if (exportFormat !== 'png') {
                        toast(meta.label + ' не поддерживается, сохраняю PNG');
                        exportFormat = 'png';
                        storeSet('img_mag_format', 'png');
                        exportAs('png');
                    } else {
                        toast('Не удалось подготовить файл');
                    }
                });
        }).catch(() => toast(TAINT_MSG));
    }

    function copyAsFormat(fmt) {
        if (!imgEl) return;
        const meta = FORMAT_META[fmt] || FORMAT_META.png;
        resolveExportCanvas().then((res) => {
            if (!win) return;
            if (!res.canvas) { exportError(res); return; }
            if (!navigator.clipboard || !window.ClipboardItem) {
                toast('Браузер не поддерживает копирование изображений');
                return;
            }
            return canvasToType(res.canvas, meta.mime, exportQuality).then((blob) => {
                navigator.clipboard.write([new ClipboardItem({ [meta.mime]: blob })])
                    .then(() => toast('Скопировано как ' + meta.label))
                    .catch(() => toast('Не удалось скопировать ' + meta.label));
            }).catch(() => toast('Не удалось подготовить изображение'));
        }).catch(() => toast(TAINT_MSG));
    }

    function openExportMenu(anchorBtn) {
        openPanel(anchorBtn, 'Экспорт', (p) => {
            for (const fmt of ['png', 'jpeg', 'webp']) {
                const meta = FORMAT_META[fmt];
                menuItem(p, {
                    label: 'Сохранить ' + meta.label, icon: 'save',
                    hint: (exportFormat === fmt ? '• ' : '') + '.' + meta.ext,
                    check: exportFormat === fmt,
                    onClick: () => exportAs(fmt),
                });
            }
            if (exportFormat !== 'png') {
                menuSep(p);
                const q = mk('div', { padding: '2px 8px 6px' });
                const lbl = mk('div', { fontSize: '11px', opacity: '0.7', marginBottom: '4px' });
                lbl.textContent = 'Качество: ' + Math.round(exportQuality * 100) + '%';
                const rng = document.createElement('input');
                rng.type = 'range';
                rng.min = '30';
                rng.max = '100';
                rng.step = '1';
                rng.value = String(Math.round(exportQuality * 100));
                rng.setAttribute('aria-label', 'Качество экспорта');
                Object.assign(rng.style, { width: '100%', accentColor: '#4da3ff' });
                rng.addEventListener('input', () => {
                    lbl.textContent = 'Качество: ' + rng.value + '%';
                });
                rng.addEventListener('change', () => {
                    exportQuality = clamp(parseInt(rng.value, 10) / 100, 0.3, 1);
                    storeSet('img_mag_quality', exportQuality);
                });
                rng.addEventListener('mousedown', (e) => e.stopPropagation());
                q.append(lbl, rng);
                p.appendChild(q);
            }
            menuSep(p);
            menuItem(p, {
                label: 'Копировать как PNG', icon: 'copy', hint: 'Ctrl+C',
                onClick: () => copyAsFormat('png'),
            });
            menuItem(p, {
                label: 'Копировать как JPEG', icon: 'copy',
                onClick: () => copyAsFormat('jpeg'),
            });
            menuNote(p, 'Формат запоминается. Ctrl+S использует выбранный формат.');
        }, { minWidth: 220 });
    }

    // ======================================================================
    // Анализ: палитра, перспектива, текст, коды
    // ======================================================================
    function openAnalysisMenu(anchorBtn) {
        openPanel(anchorBtn, 'Анализ изображения', (p) => {
            menuItem(p, {
                label: 'Палитра изображения', icon: 'palette',
                check: imagePalette.length > 0,
                onClick: () => openPalettePanel(null),
            });
            menuSep(p);
            menuItem(p, {
                label: perspCanvas ? 'Показать оригинал' : 'Выпрямить перспективу',
                icon: 'warp',
                hint: perspCanvas ? '' : '4 угла',
                onClick: () => {
                    if (perspCanvas) restorePerspective();
                    else beginPerspective();
                },
            });
            if (perspCanvas) {
                menuItem(p, {
                    label: 'Выпрямить заново', icon: 'warp',
                    onClick: () => beginPerspective(),
                });
            }
            menuSep(p);
            menuItem(p, {
                label: 'Прочитать текст', icon: 'scan',
                hint: typeof window.TextDetector === 'function' ? 'локально' : '4× в буфер',
                onClick: () => startScanFor('text'),
            });
            if (barcodeSupported()) {
                menuItem(p, {
                    label: 'QR-код / штрих-код', icon: 'qr',
                    hint: 'локально',
                    onClick: () => startScanFor('qr'),
                });
            }
            if (!barcodeSupported() && typeof window.TextDetector !== 'function') {
                menuNote(p, 'Локальных детекторов нет: текст увеличиваем в ' + OCR_SCALE + '× и копируем в буфер.');
            }
        }, { minWidth: 230 });
    }

    // ======================================================================
    // «Ещё»: закрепление, прозрачность, «только смотреть», сетка
    // ======================================================================
    function openMoreMenu(anchorBtn) {
        openPanel(anchorBtn, 'Вид и окно', (p) => {
            menuItem(p, {
                label: pinned ? 'Открепить окно' : 'Закрепить окно', icon: 'pin', hint: 'Shift+P',
                check: pinned,
                onClick: () => togglePin(),
            });
            menuItem(p, {
                label: 'Полупрозрачное окно', icon: 'more',
                check: translucent,
                onClick: () => toggleTranslucent(),
            });
            menuItem(p, {
                label: 'Режим «только смотреть»', icon: 'more',
                check: ghostMode,
                onClick: () => toggleGhost(),
            });
            menuSep(p);
            menuItem(p, {
                label: 'Сетка пикселей (от 800%)', icon: 'grid', hint: 'G',
                check: pixelGrid,
                onClick: () => togglePixelGrid(),
            });
            menuItem(p, {
                label: 'Сбросить вид (вписать)', icon: 'fit', hint: 'Ctrl+1',
                onClick: () => fitImage(),
            });
            menuItem(p, {
                label: 'Убрать выделение фигуры', icon: 'undo',
                onClick: () => { selShape = null; invalidate(); announce('Выделение снято'); },
            });
        }, { minWidth: 230 });
    }

    function togglePixelGrid(force) {
        const next = (force === undefined) ? !pixelGrid : !!force;
        pixelGrid = next;
        storeSet('img_mag_grid', pixelGrid ? '1' : '0');
        baseRev++;
        clearBaseCache();
        invalidate();
        syncGridButton();
        announce(pixelGrid
            ? 'Сетка пикселей включена (видна от ' + Math.round(PIXEL_GRID_FROM * 100) + '%)'
            : 'Сетка пикселей выключена');
    }

    // ======================================================================
    // 4.2 Правка выбранной фигуры
    // ======================================================================
    function openShapeMenu(shape, clientX, clientY) {
        if (!win || !shape) return;
        closeMenu();
        const panel = document.createElement('div');
        Object.assign(panel.style, {
            position: 'fixed', zIndex: '2147483647', minWidth: '180px',
            background: '#2b2b2b', color: '#eee', borderRadius: '8px',
            boxShadow: '0 10px 28px rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.12)',
            padding: '6px', font: '12.5px/1.4 sans-serif', boxSizing: 'border-box',
        });
        panel.setAttribute('role', 'menu');
        panel.addEventListener('mousedown', (e) => e.stopPropagation());
        panel.addEventListener('click', (e) => e.stopPropagation());

        const head = mk('div', { padding: '2px 6px 5px', opacity: '0.65', fontSize: '11.5px' });
        head.textContent = 'Фигура: ' + shapeTypeLabel(shape.type);
        panel.appendChild(head);

        menuItem(panel, {
            label: 'Удалить фигуру', icon: 'trash', hint: 'Del',
            onClick: () => deleteShape(shape),
        });
        menuItem(panel, {
            label: 'Дублировать', icon: 'copy', hint: 'Alt+drag',
            onClick: () => {
                const dup = cloneShape(shape, shape.width ? 16 / scale : 12, 12);
                if (!dup) return;
                lastShape = dup;
                pushAnnotation(dup);
                selShape = dup;
                invalidate();
                announce('Фигура продублирована');
            },
        });
        if (shape.type === 'text') {
            menuItem(panel, {
                label: 'Изменить текст', icon: 'text',
                onClick: () => editTextShape(shape),
            });
        }
        menuItem(panel, {
            label: 'Другой цвет…', icon: 'palette',
            onClick: () => {
                shape.color = penColor;
                baseRev++;
                clearBaseCache();
                commit();
                announce('Цвет фигуры изменён');
            },
        });

        rootEl().appendChild(panel);
        menuEl = panel;
        menuAnchorBtn = null;

        const w = panel.offsetWidth, h = panel.offsetHeight;
        panel.style.left = clamp(clientX, 8, Math.max(8, innerWidth - w - 8)) + 'px';
        panel.style.top = clamp(clientY, 8, Math.max(8, innerHeight - h - 8)) + 'px';
    }

    function shapeTypeLabel(type) {
        const map = {
            pen: 'карандаш', line: 'линия', arrow: 'стрелка',
            rect: 'прямоугольник', circle: 'эллипс', text: 'текст',
        };
        return map[type] || type;
    }

    // Правка текстовой аннотации: убираем фигуру и открываем тот же редактор
    // в её точке с её текстом — без нового «фиксированного» бага.
    function editTextShape(shape) {
        if (!shape || shape.type !== 'text') return;
        const screenSize = shape.size * scale;
        const left = shape.x * scale + tx;
        const top = shape.y * scale + ty;
        const idx = annotations.indexOf(shape);
        if (idx === -1) return;
        annotations = annotations.slice(0, idx).concat(annotations.slice(idx + 1));
        selShape = null;
        baseRev++;
        clearBaseCache();
        invalidate();

        const oldColor = penColor;
        penColor = shape.color || penColor;
        openTextEditor(left, top, shape.text);
        penColor = oldColor;
    }

    // --- Экспорт ------------------------------------------------------------
    function checkExportable() {
        const iw = imageW(), ih = imageH();
        if (!iw || !ih) { canExport = null; return; }
        try {
            const c = document.createElement('canvas');
            c.width = 1;
            c.height = 1;
            const x = c.getContext('2d');
            // 1×1 из 48 Мпикс — это всё равно полный проход по пикселям
            // (замерено: сотни мс). Если уменьшенная копия уже готова,
            // проверяем на ней: «отравленность» у них одинаковая.
            const probe = (hugeSource && !perspCanvas) ? hugeSource : sourceEl();
            x.drawImage(probe, 0, 0, 1, 1);
            x.getImageData(0, 0, 1, 1);
            canExport = true;
        } catch (e) {
            canExport = false;
        }
    }

    // Обход CORS: картинку тянем через GM_xmlhttpRequest, который в
    // Tampermonkey не подчиняется политике origin, и подсовываем как Blob.
    // Без этого canvas с чужой картинки «отравлен»: getImageData/toBlob
    // падают, а значит не работают текст, палитра, пипетка и экспорт.
    // Доступ к пикселям чужой картинки. Порядок попыток важен:
    // 1) обычный fetch — работает, если сервер отдаёт CORS-заголовки
    //    (так делают почти все CDN). Никаких прав расширения не нужно.
    // 2) <img crossorigin="anonymous"> — тот же CORS, но через декодер
    //    браузера; иногда проходит там, где fetch заблокирован политикой.
    // 3) GM_xmlhttpRequest — последняя попытка. Права @connect сюда
    //    намеренно НЕ выданы (иначе Tampermonkey спрашивает разрешение
    //    на домены при первом запуске), поэтому обычно не срабатывает.
    // Раньше стоял только GM-путь и при ошибке он делал resolve(null),
    // из-за чего до fetch дело не доходило вообще: на любой картинке с
    // чужого домена все пиксельные инструменты писали «нет доступа».
    function loadCorsImage() {
        if (corsImage) return Promise.resolve(corsImage);
        if (corsTried) return Promise.resolve(null);
        corsTried = true;

        const remember = (im) => { corsImage = im; return im; };

        const fromBlob = (blob) => new Promise((resolve) => {
            if (!blob) { resolve(null); return; }
            let url;
            try { url = URL.createObjectURL(blob); } catch (e) { resolve(null); return; }
            const im = new Image();
            im.onload = () => {
                remember(im);
                // отзываем позже: объект уже декодирован в память
                setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 1000);
                resolve(im);
            };
            im.onerror = () => resolve(null);
            im.src = url;
        });

        const fromCrossOriginImg = (url) => new Promise((resolve) => {
            const im = new Image();
            im.crossOrigin = 'anonymous';
            im.onload = () => resolve(remember(im));
            im.onerror = () => resolve(null);
            im.src = url;
        });

        const fromGm = (url) => new Promise((resolve) => {
            if (typeof GM_xmlhttpRequest !== 'function') { resolve(null); return; }
            let done = false;
            const fin = (v) => { if (!done) { done = true; resolve(v); } };
            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    responseType: 'blob',
                    timeout: 15000,
                    onload: (res) => {
                        if (res && res.status >= 200 && res.status < 300 && res.response) {
                            fromBlob(res.response).then(fin);
                        } else {
                            fin(null);
                        }
                    },
                    onerror: () => fin(null),
                    ontimeout: () => fin(null),
                });
            } catch (e) { fin(null); }
        });

        return new Promise((resolve) => {
            if (!imageUrl || !/^https?:/i.test(imageUrl)) { resolve(null); return; }
            const url = imageUrl;

            const tryFetch = () => {
                if (typeof fetch !== 'function') return Promise.resolve(null);
                return fetch(url, { mode: 'cors', credentials: 'omit', cache: 'force-cache' })
                    .then((r) => (r && r.ok ? r.blob() : null))
                    .then(fromBlob)
                    .catch(() => null);
            };

            tryFetch().then((im) => {
                if (im) { resolve(im); return; }
                fromCrossOriginImg(url).then((im2) => {
                    if (im2) { resolve(im2); return; }
                    fromGm(url).then((im3) => resolve(im3 || null));
                });
            });
        });
    }

    function pixelsReady() { return canExport === true; }

    // Пробуем получить пиксельный доступ и заодно подгружаем CORS-копию.
    // Возвращает Promise с источником, у которого точно есть getImageData.
    function ensurePixels() {
        if (canExport === null) checkExportable();
        // CORS-копия приоритетнее. canExport мог включиться именно из-за неё
        // (палитра проверяет копию), а сам <img> при этом остаётся «грязным»:
        // drawImage на него не бросает, зато следующий getImageData — да, и
        // декодер молча возвращал «код не найден» на любой кросс-доменной
        // картинке. Копия читается всегда, поэтому её и берём.
        if (corsImage) return Promise.resolve(corsImage);
        if (canExport === true) return Promise.resolve(sourceEl());
        return loadCorsImage().then((im) => im || null);
    }

    const EXPORT_MAX_PIXELS = 40 * 1000 * 1000; // ~40 Мпикс — предел одного полотна

    function buildExportCanvas(src) {
        const iw = src.naturalWidth || src.width;
        const ih = src.naturalHeight || src.height;
        if (!iw || !ih) return { canvas: null, reason: 'load' };
        if (iw * ih > EXPORT_MAX_PIXELS) return { canvas: null, reason: 'size' };

        try {
            const c = document.createElement('canvas');
            c.width = iw;
            c.height = ih;
            const x = c.getContext('2d');
            if (!x) return { canvas: null, reason: 'load' };
            if (src === imgEl && exportFormat !== 'png') {
                // JPEG не умеет альфу: подложка, иначе прозрачные края станут чёрными
                x.fillStyle = '#ffffff';
                x.fillRect(0, 0, iw, ih);
            }
            x.drawImage(src, 0, 0, iw, ih);
            // аннотации хранятся в координатах картинки → scale=1, tx=ty=0
            for (let i = 0; i < annotations.length; i++) {
                drawShape(x, annotations[i], 1, 0, 0);
            }
            return { canvas: c, reason: '' };
        } catch (e) {
            return { canvas: null, reason: 'taint' };
        }
    }

    function canvasToBlob(canvas) {
        return new Promise((resolve, reject) => {
            try {
                canvas.toBlob((b) => {
                    if (b) resolve(b);
                    else reject(new Error('empty'));
                }, 'image/png');
            } catch (e) {
                reject(e);
            }
        });
    }

    function resolveExportCanvas() {
        if (!imgEl) return Promise.resolve({ canvas: null, reason: 'load' });
        // 1.5: экспорт уже выпрямленной картинки
        if (perspCanvas) return Promise.resolve(buildExportCanvas(perspCanvas));

        if (canExport === null) checkExportable();

        if (canExport === true) return Promise.resolve(buildExportCanvas(imgEl));

        return loadCorsImage().then((im) => {
            if (!im) return { canvas: null, reason: 'taint' };
            return buildExportCanvas(im);
        });
    }

    const TAINT_MSG = 'Изображение с другого сайта защищено CORS. Используйте ПКМ → «Копировать изображение»';

    function exportError(res) {
        if (res.reason === 'size') {
            toast('Изображение слишком большое для экспорта');
        } else {
            toast(TAINT_MSG);
        }
    }

    function copyToClipboard() {
        if (!imgEl) return;
        resolveExportCanvas().then((res) => {
            if (!win) return;
            if (!res.canvas) { exportError(res); return; }
            return canvasToBlob(res.canvas).then((blob) => {
                if (!navigator.clipboard || !window.ClipboardItem) {
                    toast('Браузер не поддерживает копирование изображений — используйте Ctrl+S');
                    return;
                }
                return navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
                    .then(() => toast('Изображение скопировано'))
                    .catch(() => toast('Не удалось скопировать. ПКМ → «Копировать изображение»'));
            }).catch(() => toast('Не удалось подготовить изображение'));
        }).catch(() => toast(TAINT_MSG));
    }

    function safeFileName(url) {
        if (!url || /^data:/i.test(url)) return 'image.png';
        try {
            const u = new URL(url, location.href);
            const raw = decodeURIComponent(u.pathname.split('/').pop() || '');
            const base = raw.replace(/\.[a-z0-9]{2,5}$/i, '')
                .replace(/[^\w.\-]+/g, '_')
                .slice(0, 64);
            return (base || 'image') + '.png';
        } catch (e) {
            return 'image.png';
        }
    }

    function savePNG() {
        if (!imgEl) return;
        // Ctrl+S и кнопка «Сохранить» используют выбранный формат (3.5)
        if (exportFormat && exportFormat !== 'png') {
            exportAs(exportFormat);
            return;
        }
        resolveExportCanvas().then((res) => {
            if (!win) return;
            if (!res.canvas) { exportError(res); return; }
            return canvasToBlob(res.canvas).then((blob) => {
                const a = document.createElement('a');
                const href = URL.createObjectURL(blob);
                a.href = href;
                a.download = safeFileName(imageUrl);
                a.style.display = 'none';
                rootEl().appendChild(a);
                a.click();
                setTimeout(() => {
                    try { a.remove(); } catch (e) { /* ignore */ }
                    URL.revokeObjectURL(href);
                }, 4000);
                toast('Сохранено: ' + a.download);
            }).catch(() => toast('Не удалось подготовить файл'));
        }).catch(() => toast(TAINT_MSG));
    }

    // --- Клавиатура ---------------------------------------------------------
    const TOOL_KEYS = {
        v: 'move', p: 'pen', l: 'line', a: 'arrow', r: 'rect', e: 'circle', t: 'text', x: 'eraser'
    };

    // 4.1: цифры — инструменты, как в большинстве редакторов
    const TOOL_DIGITS = {
        '1': 'pen', '2': 'line', '3': 'arrow', '4': 'rect', '5': 'circle', '6': 'text',
        '7': 'eraser', '8': 'move',
    };

    function onKeyUp(e) {
        if (e.code === 'Space' || e.key === ' ') {
            spaceDown = false;
            if (viewEl && mode !== 'pan') {
                viewEl.style.cursor = currentTool === 'move' ? 'grab' : 'crosshair';
            }
        }
    }

    function panBy(dx, dy) {
        tx += dx;
        ty += dy;
        apply();
    }

    function onKey(e) {
        if (!win) return;
        const target = e.target;
        const typing = isTypingTarget(target);
        const inside = inWindow(target);

        // Пока открыт редактор текста, из глобальных клавиш работают только
        // Esc (отмена) и Enter (коммит) — остальное принадлежит редактору,
        // иначе набор текста дёргает зум/инструменты и страницу.
        if (textInput) {
            if (e.key === 'Escape' || e.key === 'Esc') {
                e.preventDefault();
                e.stopPropagation();
                commitText(false);
                return;
            }
            if (e.key === 'Enter') {
                // Shift+Enter — перенос строки, обычный Enter — коммит
                if (e.shiftKey) return;
                e.preventDefault();
                e.stopPropagation();
                commitText(true);
                if (win) { try { win.focus({ preventScroll: true }); } catch (err) { /* ignore */ } }
                return;
            }
            return;
        }

        if (e.key === 'Escape' || e.key === 'Esc') {
            e.preventDefault();
            e.stopPropagation();
            if (helpVisible()) { toggleHelp(false); return; }
            if (menuEl) { closeMenu(); return; }
            if (perspPicking) { cancelPerspective(); return; }
            if (scanPick) {
                scanPick = false;
                scanRect = null;
                if (viewEl) viewEl.style.cursor = currentTool === 'move' ? 'grab' : 'crosshair';
                showHint(null);
                requestDraw();
                return;
            }
            if (selShape) { selShape = null; invalidate(); return; }
            closeWindow();
            return;
        }

        if (!inside && !overWin) return; // не перехватываем клавиши страницы

        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
            const k = (e.key || '').toLowerCase();
            // Ctrl+Z / Ctrl+C / Ctrl+S перехватываем только когда фокус внутри
            // окна или курсор над ним: иначе ломаем undo и копирование страницы
            if (k === 'z' || k === 'я') {
                if (typing || !inside) return;
                e.preventDefault();
                e.stopPropagation();
                if (e.shiftKey) redo(); else undo();
                return;
            }
            if (k === 'y') {
                if (typing || !inside) return;
                e.preventDefault();
                e.stopPropagation();
                redo();
                return;
            }
            if (k === 'c' || k === 'с') {
                if (typing || !inside) return;
                e.preventDefault();
                e.stopPropagation();
                copyToClipboard();
                return;
            }
            if (k === 's' || k === 'ы') {
                if (typing || !inside) return;
                e.preventDefault();
                e.stopPropagation();
                savePNG();
                return;
            }
            if (k === '0') {
                e.preventDefault();
                e.stopPropagation();
                setZoom(1);
                return;
            }
            if (k === '1') {
                e.preventDefault();
                e.stopPropagation();
                fitImage();
                return;
            }
        }

        if (typing || e.ctrlKey || e.metaKey || e.altKey) return;

        // 4.1: Tab — ловушка фокуса внутри окна
        if (e.key === 'Tab') {
            e.preventDefault();
            e.stopPropagation();
            trapFocus(e);
            return;
        }

        if (e.key === '?') {
            e.preventDefault();
            toggleHelp();
            return;
        }

        if (e.key === 'Enter') {
            // 4.1: Enter активирует кнопку даже там, где браузер не
            // синтезирует клик сам (и не уводит фокус на страницу)
            if (target && target.tagName === 'BUTTON' && win.contains(target)) {
                e.preventDefault();
                e.stopPropagation();
                try { target.click(); } catch (err) { /* ignore */ }
                return;
            }
            // Enter на кнопке обрабатывает сама кнопка; здесь — фокус на окне
            if (target === win || target === drawEl) {
                e.preventDefault();
                announce('Масштаб ' + Math.round(scale * 100) + '%, инструмент: ' +
                    shapeToolLabel(currentTool));
            }
            return;
        }

        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (selShape) {
                e.preventDefault();
                e.stopPropagation();
                deleteShape(selShape);
                return;
            }
        }

        // Стрелки — панорама, Shift — крупными шагами
        const step = e.shiftKey ? 80 : 24;
        if (e.key === 'ArrowLeft') { e.preventDefault(); panBy(step, 0); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); panBy(-step, 0); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); panBy(0, step); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); panBy(0, -step); return; }

        // +/− — зум
        if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') {
            e.preventDefault();
            zoomCenter(ZOOM_STEP);
            announce('Масштаб ' + Math.round(scale * 100) + '%');
            return;
        }
        if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') {
            e.preventDefault();
            zoomCenter(1 / ZOOM_STEP);
            announce('Масштаб ' + Math.round(scale * 100) + '%');
            return;
        }

        if (e.code === 'Space' || e.key === ' ') {
            e.preventDefault();
            if (!spaceDown) {
                spaceDown = true;
                if (viewEl) viewEl.style.cursor = 'grab';
            }
            return;
        }

        const key = (e.key || '').toLowerCase();

        if (TOOL_DIGITS[key]) {
            e.preventDefault();
            setTool(TOOL_DIGITS[key]);
            announce('Инструмент: ' + shapeToolLabel(currentTool));
            return;
        }
        if (key === 'c' || key === 'с') {
            e.preventDefault();
            focusColorInput();
            return;
        }
        if (key === 'g' || key === 'п') {
            e.preventDefault();
            togglePixelGrid();
            return;
        }
        if (key === 'p' && !e.shiftKey && !e.ctrlKey) {
            // P остаётся карандашом (старая привычка), закрепление — Shift+P
            e.preventDefault();
            setTool('pen');
            return;
        }
        if ((key === 'p' || key === 'з') && e.shiftKey) {
            e.preventDefault();
            togglePin();
            return;
        }
        if (TOOL_KEYS[key]) {
            e.preventDefault();
            setTool(TOOL_KEYS[key]);
            return;
        }
    }

    function shapeToolLabel(name) {
        const map = {
            move: 'перемещение', pen: 'карандаш', line: 'линия', arrow: 'стрелка',
            rect: 'прямоугольник', circle: 'эллипс', text: 'текст', eraser: 'ластик',
        };
        return map[name] || name;
    }

    function focusColorInput() {
        const cv = propsBody && propsBody.querySelector('.imv-hsvcv');
        if (cv) {
            try { cv.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
            announce('Круговой выбор цвета. Текущий: ' + penColor.toUpperCase());
            return;
        }
        announce('Цвет: ' + penColor.toUpperCase());
    }

    // --- 6.3 Высокий DPI и смена монитора ---------------------------------
    // При переносе окна на другой монитор devicePixelRatio меняется без resize.
    // matchMedia('(resolution: Xdppx)') ловит именно это.
    function watchDpr() {
        dropDprMedia();
        if (typeof window.matchMedia !== 'function') return;
        try {
            mqDpr = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
            const handler = () => {
                if (!win) return;
                // Пересоздаём запрос на новое значение и перестраиваем холст.
                watchDpr();
                resyncDpr();
            };
            if (mqDpr.addEventListener) mqDpr.addEventListener('change', handler);
            else if (mqDpr.addListener) mqDpr.addListener(handler);
            mqDpr._handler = handler;
        } catch (e) { mqDpr = null; }
    }

    // Пересборка холста под новый DPR с сохранением точки в центре.
    function resyncDpr() {
        if (!win || !drawEl) return;
        baseValid = false;
        clearBaseCache();
        if (fitCanvas()) {
            const ix = scale ? (viewW / 2 - tx) / scale : 0;
            const iy = scale ? (viewH / 2 - ty) / scale : 0;
            tx = viewW / 2 - ix * scale;
            ty = viewH / 2 - iy * scale;
        }
        requestDraw();
    }

    // matchMedia не всегда срабатывает при смене монитора (окно не меняет
    // размер). Дешёвая страховка: раз в секунду сверяем сам devicePixelRatio.
    function startDprPoll() {
        stopDprPoll();
        dprPoll = setInterval(() => {
            if (!win) { stopDprPoll(); return; }
            const now = clamp(window.devicePixelRatio || 1, 1, DPR_MAX);
            if (Math.abs(now - dpr) > 0.01) {
                watchDpr();
                resyncDpr();
            }
        }, 800);
    }

    function stopDprPoll() {
        if (dprPoll) { clearInterval(dprPoll); dprPoll = 0; }
    }

    // Снимаем только matchMedia-подписку; опрос DPR живёт отдельно.
    function dropDprMedia() {
        if (!mqDpr) return;
        try {
            if (mqDpr._handler) {
                if (mqDpr.removeEventListener) mqDpr.removeEventListener('change', mqDpr._handler);
                else if (mqDpr.removeListener) mqDpr.removeListener(mqDpr._handler);
            }
        } catch (e) { /* ignore */ }
        mqDpr = null;
    }

    function unwatchDpr() {
        stopDprPoll();
        dropDprMedia();
    }

    // --- Закрытие -----------------------------------------------------------
    function closeWindow() {
        if (!win) return;

        erasing = false;
        eraseMoved = 0;
        persistNow();
        closeMenu();
        unwatchDpr();

        document.removeEventListener('mousemove', onMouseMove, true);
        document.removeEventListener('mouseup', onMouseUp, true);
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('keyup', onKeyUp, true);
        document.removeEventListener('mousedown', onOutsideClick, true);
        document.removeEventListener('pointermove', onRailDragMove);
        document.removeEventListener('pointerup', onRailDragUp);
        window.removeEventListener('resize', onViewportChange);
        window.removeEventListener('scroll', onPageScroll, true);

        if (winRO) { winRO.disconnect(); winRO = null; }
        if (persistTimer) { clearTimeout(persistTimer); persistTimer = 0; }
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }

        if (textInput) {
            const t = textInput;
            textInput = null;
            t._finish = null;
            try { t.remove(); } catch (e) { /* ignore */ }
        }

        try { win.remove(); } catch (e) { /* ignore */ }

        win = null;
        barEl = null;
        viewEl = null;
        imgEl = null;
        drawEl = null;
        baseCanvas = null;
        baseCtx = null;
        statusEl = null;
        helpEl = null;
        zoomLabel = null;
        undoBtn = null;
        redoBtn = null;
        fillBtn = null;
        pinBtn = null;
        moreBtn = null;
        toolButtons = {};
        railEl = null;
        propsEl = null;
        statusBarEl = null;
        propsIcon = null;
        propsTitle = null;
        propsKey = null;
        propsBody = null;
        sbTool = null;
        sbHint = null;
        sbCount = null;
        sbZoom = null;
        settingsEl = null;
        settingsRefs = null;
        hsvRefs = null;
        for (const k in railActs) delete railActs[k];

        mode = null;
        drawing = false;
        inProgress = null;
        touchState = null;
        spaceDown = false;
        overWin = false;
        viewRect = null;
        viewW = viewH = 0;
        baseValid = false;
        canExport = null;
        corsImage = null;
        corsTried = false;
        imageUrl = '';

        annotations = [];
        history = [[]];
        histIndex = 0;
        resetPerFeatureState();
        baseRev = 0;
        selShape = null;
    }

    // --- Уведомление --------------------------------------------------------
    let toastEl = null, toastTimer = 0;

    function toast(msg) {
        if (!toastEl) {
            toastEl = document.createElement('div');
            Object.assign(toastEl.style, {
                position: 'fixed', zIndex: '2147483647', bottom: '20px', left: '50%',
                transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.85)', color: '#fff',
                padding: '10px 16px', borderRadius: '8px', font: '14px/1.4 sans-serif',
                pointerEvents: 'none', maxWidth: '80vw', textAlign: 'center',
                boxShadow: '0 4px 12px rgba(0,0,0,0.4)', transition: 'opacity 0.3s',
            });
        }
        toastEl.textContent = msg;
        if (!toastEl.isConnected) rootEl().appendChild(toastEl);
        toastEl.style.opacity = '1';
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            if (toastEl) toastEl.style.opacity = '0';
        }, TOAST_MS);
    }
})();
