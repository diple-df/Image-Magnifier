// ==UserScript==
// @name         Image Magnifier
// @namespace    https://github.com/diple-df/Image-Magnifier
// @version      3.8.0
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
        const LOCAL_VERSION = '3.8.0';

        function curVer() {
            try {
                if (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) {
                    return String(GM_info.script.version);
                }
            } catch (e) { /* ignore */ }
            return LOCAL_VERSION;
        }

        // Сравнение по числовым сегментам: 3.10.0 больше 3.9.0 (строкой — нет).
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

        // 3.8.0
        palette: [['circle', { cx: 8.5, cy: 12, r: 2 }], ['circle', { cx: 12, cy: 7.5, r: 2 }], ['circle', { cx: 15.5, cy: 12, r: 2 }], ['path', { d: 'M12 3.2a8.8 8.8 0 1 0 0 17.6 3 3 0 0 0 2.2-5 2 2 0 0 1 1.5-3.3h1.7A3.4 3.4 0 0 0 21 9.1 8.8 8.8 0 0 0 12 3.2z' }]],
        warp:    [['path', { d: 'M4 7l5-3 7 3 4-2' }], ['path', { d: 'M4 7v10l5 3 7-3 4 2V9' }], ['path', { d: 'M9 4v10' }], ['path', { d: 'M16 7v10' }]],
        scan:    [['path', { d: 'M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8' }], ['path', { d: 'M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8' }], ['path', { d: 'M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16' }], ['path', { d: 'M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16' }], ['path', { d: 'M7.5 12h9' }]],
        qr:      [['rect', { x: 4, y: 4, width: 6, height: 6, rx: 1 }], ['rect', { x: 14, y: 4, width: 6, height: 6, rx: 1 }], ['rect', { x: 4, y: 14, width: 6, height: 6, rx: 1 }], ['path', { d: 'M14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z' }]],
        pin:     [['path', { d: 'M9 4h6l-1 5 3 3H7l3-3z' }], ['path', { d: 'M12 12v8' }]],
        export:  [['path', { d: 'M12 15V4' }], ['path', { d: 'M8 8l4-4 4 4' }], ['path', { d: 'M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3' }]],
        grid:    [['rect', { x: 4, y: 4, width: 16, height: 16, rx: 1 }], ['path', { d: 'M12 4v16M4 12h16' }], ['path', { d: 'M8 4v16M16 4v16M4 8h16M4 16h16', opacity: 0.55 }]],
        more:    [['circle', { cx: 6, cy: 12, r: 1.4 }], ['circle', { cx: 12, cy: 12, r: 1.4 }], ['circle', { cx: 18, cy: 12, r: 1.4 }]]
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
    let pinBtn = null, analysisBtn = null, exportBtn = null, moreBtn = null;
    let quickPaletteEl = null;
    let toolButtons = {};
    let imageUrl = '';

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

    // --- Состояние новых возможностей (3.8.0) ------------------------------
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
    let colorInputEl = null;     // <input type=color>
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

    function sourceEl() { return perspCanvas || imgEl; }

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
        b.dataset.active = on ? '1' : '';
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
        if (colorInputEl) colorInputEl.value = penColor;
        if (textInput) {
            textInput.style.color = penColor;
            textInput.style.caretColor = penColor;
            textInput.style.boxShadow = '0 0 0 1px ' + penColor + ', 0 1px 6px rgba(0,0,0,0.5)';
        }
        pushRecentColor(penColor);
        if (quickPaletteEl) refreshQuickPalette();
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

    function swatchButton(hex, tip, onClick, size) {
        const b = document.createElement('button');
        b.type = 'button';
        const s = size || 16;
        Object.assign(b.style, {
            width: s + 'px', height: s + 'px', padding: '0', flex: '0 0 auto',
            background: hex, border: '1px solid rgba(0,0,0,0.55)',
            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.22)',
            borderRadius: '3px', cursor: 'pointer', outline: 'none',
        });
        b.title = tip;
        b.setAttribute('aria-label', tip);
        b.addEventListener('click', (e) => { e.stopPropagation(); onClick(hex, b); });
        b.addEventListener('focus', () => { b.style.outline = '2px solid #4da3ff'; b.style.outlineOffset = '1px'; });
        b.addEventListener('blur', () => { b.style.outline = 'none'; });
        b.addEventListener('mousedown', (e) => e.stopPropagation());
        return b;
    }

    // 5 закреплённых цветов + последние использованные, одним кликом
    function buildQuickPalette() {
        const wrap = document.createElement('div');
        Object.assign(wrap.style, {
            display: 'flex', alignItems: 'center', gap: '3px', flex: '0 0 auto',
            padding: '0 1px',
        });
        wrap.setAttribute('role', 'group');
        wrap.setAttribute('aria-label', 'Быстрые цвета');
        refreshQuickPalette(wrap);
        return wrap;
    }

    function refreshQuickPalette(wrap) {
        const el = wrap || quickPaletteEl;
        if (!el) return;
        while (el.firstChild) el.removeChild(el.firstChild);
        quickPins.forEach((c) => {
            el.appendChild(swatchButton(c, 'Цвет ' + c.toUpperCase() + ' (клик — выбрать)', (hex) => {
                setPenColor(hex);
                announce('Цвет ' + hex.toUpperCase());
            }));
        });
        quickRecent.forEach((c) => {
            if (quickPins.indexOf(c) !== -1) return;
            const b = swatchButton(c, 'Недавний ' + c.toUpperCase(), (hex) => {
                setPenColor(hex);
                announce('Цвет ' + hex.toUpperCase());
            }, 13);
            b.style.borderRadius = '50%';
            el.appendChild(b);
        });
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

    function openWindow(url, caption) {
        if (win) closeWindow();

        imageUrl = url;
        canExport = null;
        corsImage = null;
        corsTried = false;

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

        // --- заголовок ---
        barEl = document.createElement('div');
        Object.assign(barEl.style, {
            display: 'flex', alignItems: 'center', gap: '2px',
            height: '34px', flex: '0 0 34px', padding: '0 4px 0 10px',
            background: '#2b2b2b', color: '#fff', cursor: 'move',
            userSelect: 'none', boxSizing: 'border-box', minWidth: '0',
        });

        const title = document.createElement('div');
        title.textContent = caption || 'Изображение';
        title.title = caption || url;
        Object.assign(title.style, {
            flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis',
            whiteSpace: 'nowrap', opacity: '0.9', minWidth: '0',
        });

        zoomLabel = document.createElement('button');
        zoomLabel.type = 'button';
        zoomLabel.title = 'Сбросить масштаб до 100% (Ctrl+0)';
        zoomLabel.setAttribute('aria-label', 'Масштаб. Нажмите, чтобы сбросить до 100%');
        Object.assign(zoomLabel.style, {
            opacity: '0.85', margin: '0 2px', minWidth: '42px', textAlign: 'right',
            background: 'rgba(255,255,255,0.06)', color: '#fff', border: 'none', padding: '3px 5px',
            borderRadius: '4px', cursor: 'pointer', font: 'inherit', fontSize: '11.5px',
            fontVariantNumeric: 'tabular-nums', outline: 'none',
            flex: '0 0 auto', boxSizing: 'border-box',
        });
        zoomLabel.addEventListener('mousedown', (e) => e.stopPropagation());
        zoomLabel.addEventListener('click', (e) => { e.stopPropagation(); setZoom(1); });
        decorateButton(zoomLabel);

        const btnOut = iconButton('zoomOut', 'Отдалить', () => zoomCenter(1 / ZOOM_STEP));
        const btnIn = iconButton('zoomIn', 'Приблизить', () => zoomCenter(ZOOM_STEP));
        const btnFit = iconButton('fit', 'По размеру окна (Ctrl+1)', () => fitImage());
        const btnCopy = iconButton('copy', 'Копировать изображение (Ctrl+C)', () => copyToClipboard());
        const btnSave = iconButton('save', 'Сохранить (Ctrl+S)', () => savePNG());
        const btnPin = iconButton('pin', 'Закрепить окно (P)', () => togglePin());
        const btnHelp = iconButton('help', 'Горячие клавиши (?)', () => toggleHelp());
        const btnClose = iconButton('close', 'Закрыть (Esc)', () => closeWindow());

        // в узком окне управление сжимается, но не исчезает
        [btnOut, btnIn, btnFit, btnCopy, btnSave, btnPin, btnHelp, btnClose].forEach(compactButton);
        pinBtn = btnPin;
        setBtnActive(btnPin, pinned);

        barEl.append(title, zoomLabel, btnOut, btnIn, btnFit, separator(), btnCopy, btnSave, btnPin, btnHelp, btnClose);
        applyWindowLook();

        // --- панель инструментов ---
        // Обёртка в две полосы: инструменты/цвета и действия. Так панель не
        // превращается в стену из 20+ иконок и не прыгает при переносе.
        const tbWrap = document.createElement('div');
        Object.assign(tbWrap.style, {
            flex: '0 0 auto', background: '#242424',
            borderTop: '1px solid rgba(255,255,255,0.08)', userSelect: 'none',
            boxSizing: 'border-box',
        });

        const tb = document.createElement('div');
        Object.assign(tb.style, {
            display: 'flex', alignItems: 'center', gap: '3px', flexWrap: 'wrap',
            flex: '0 0 auto', padding: '4px 8px 2px', background: 'transparent',
            userSelect: 'none', boxSizing: 'border-box',
        });

        toolButtons = {};
        const toolBtn = (name, icon, tip) => {
            const b = iconButton(icon, tip, () => setTool(name));
            toolButtons[name] = b;
            return b;
        };

        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.value = penColor;
        colorInput.title = 'Цвет';
        colorInputEl = colorInput;
        colorInput.setAttribute('aria-label', 'Цвет рисования');
        Object.assign(colorInput.style, {
            width: '28px', height: '24px', border: 'none', background: 'transparent',
            cursor: 'pointer', padding: '0', flex: '0 0 auto', outline: 'none',
            borderRadius: '4px',
        });
        colorInput.addEventListener('input', () => {
            penColor = colorInput.value;
            storeSet('img_mag_color', penColor);
        });
        colorInput.addEventListener('change', () => {
            pushRecentColor(colorInput.value);
            if (quickPaletteEl) refreshQuickPalette();
        });
        colorInput.addEventListener('mouseenter', () => {
            colorInput.style.boxShadow = '0 0 0 2px rgba(255,255,255,0.35)';
        });
        colorInput.addEventListener('mouseleave', () => { colorInput.style.boxShadow = 'none'; });
        colorInput.addEventListener('focus', () => {
            colorInput.style.boxShadow = '0 0 0 2px #4da3ff';
        });
        colorInput.addEventListener('blur', () => { colorInput.style.boxShadow = 'none'; });
        colorInput.addEventListener('mousedown', (e) => e.stopPropagation());

        const widthSel = document.createElement('select');
        widthSel.title = 'Толщина линии';
        widthSel.setAttribute('aria-label', 'Толщина линии');
        Object.assign(widthSel.style, {
            background: '#1e1e1e', color: '#fff', border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: '4px', cursor: 'pointer', height: '24px', flex: '0 0 auto',
        });
        [2, 4, 6, 10, 16].forEach((w) => {
            const o = document.createElement('option');
            o.value = String(w);
            o.textContent = w + 'px';
            if (w === penWidth) o.selected = true;
            widthSel.appendChild(o);
        });
        widthSel.addEventListener('change', () => {
            penWidth = clamp(parseInt(widthSel.value, 10) || 4, 1, 40);
            storeSet('img_mag_width', penWidth);
        });
        widthSel.addEventListener('mousedown', (e) => e.stopPropagation());

        fillBtn = iconButton(fillShapes ? 'fillOn' : 'fillOff', 'Заливка фигур', () => {
            fillShapes = !fillShapes;
            storeSet('img_mag_fill', fillShapes ? '1' : '0');
            fillBtn.replaceChildren(makeIcon(ICONS[fillShapes ? 'fillOn' : 'fillOff']));
            setBtnActive(fillBtn, fillShapes);
            fillBtn.title = fillShapes ? 'Заливка включена' : 'Заливка выключена';
            fillBtn.setAttribute('aria-label', 'Заливка фигур');
        });
        setBtnActive(fillBtn, fillShapes);

        undoBtn = iconButton('undo', 'Отменить (Ctrl+Z)', () => undo());
        redoBtn = iconButton('redo', 'Повторить (Ctrl+Shift+Z)', () => redo());
        const clearBtn = iconButton('trash', 'Очистить всё', () => clearAll());

        // Группы новых возможностей — меню, а не стена иконок.
        analysisBtn = iconButton('scan', 'Анализ изображения', (e) => openAnalysisMenu(e.currentTarget));
        analysisBtn.setAttribute('aria-haspopup', 'true');
        analysisBtn.setAttribute('aria-expanded', 'false');
        exportBtn = iconButton('export', 'Экспорт и буфер', (e) => openExportMenu(e.currentTarget));
        exportBtn.setAttribute('aria-haspopup', 'true');
        exportBtn.setAttribute('aria-expanded', 'false');
        moreBtn = iconButton('more', 'Ещё: закрепление, сетка, вид', (e) => openMoreMenu(e.currentTarget));
        moreBtn.setAttribute('aria-haspopup', 'true');
        moreBtn.setAttribute('aria-expanded', 'false');

        tb.append(
            toolBtn('move', 'move', 'Перемещение / панорама (V)'),
            toolBtn('pen', 'pen', 'Карандаш (1)'),
            toolBtn('line', 'line', 'Линия (2)'),
            toolBtn('arrow', 'arrow', 'Стрелка (3)'),
            toolBtn('rect', 'rect', 'Прямоугольник (4)'),
            toolBtn('circle', 'circle', 'Эллипс (5)'),
            toolBtn('text', 'text', 'Текст (6)'),
            separator(), colorInput, widthSel, fillBtn,
            quickPaletteEl = buildQuickPalette(),
            tbSpacer(),
            undoBtn, redoBtn, clearBtn
        );

        // вторая полоса: действия над картинкой и меню-группы
        const tb2 = document.createElement('div');
        Object.assign(tb2.style, {
            display: 'flex', alignItems: 'center', gap: '3px', flexWrap: 'wrap',
            flex: '0 0 auto', padding: '0 8px 4px', background: 'transparent',
            userSelect: 'none', boxSizing: 'border-box',
        });
        const rowLabel = document.createElement('span');
        rowLabel.textContent = 'Анализ и экспорт';
        Object.assign(rowLabel.style, {
            fontSize: '11px', opacity: '0.45', marginRight: '4px',
            flex: '0 1 auto', overflow: 'hidden', textOverflow: 'ellipsis',
            whiteSpace: 'nowrap', minWidth: '0',
        });
        tb2.append(rowLabel, analysisBtn, exportBtn, moreBtn);

        tbWrap.append(tb, tb2);

        // кнопки-меню не участвуют в подсветке «активный инструмент»
        setBtnActive(analysisBtn, false);
        setBtnActive(exportBtn, false);
        setBtnActive(moreBtn, false);

        tb.addEventListener('mousedown', (e) => {
            // клик по пустому месту панели не должен таскать окно
            if (e.target === tb || e.target === tb2) e.stopPropagation();
        });
        tb2.addEventListener('mousedown', (e) => {
            if (e.target === tb2) e.stopPropagation();
        });

        // --- вьюпорт ---
        viewEl = document.createElement('div');
        Object.assign(viewEl.style, {
            flex: '1 1 auto', overflow: 'hidden', position: 'relative',
            background: '#0f0f0f', cursor: 'grab', touchAction: 'none',
            minHeight: '0', boxSizing: 'border-box',
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

        viewEl.append(imgEl, drawEl, statusEl, buildHelp());
        win.append(barEl, tbWrap, viewEl);

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
                if (isFinite(savedScale) && savedScale > 0) {
                    scale = clamp(savedScale, ZOOM_MIN, ZOOM_MAX);
                    tx = (viewW - imageW() * scale) / 2;
                    ty = (viewH - imageH() * scale) / 2;
                    apply();
                } else {
                    fitImage();
                }
            } else {
                invalidate();
            }
            checkExportable();
            buildPyramid();
            buildImagePalette();
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
        scanRect = null;
        scanPick = false;
        selShape = null;
        dragShape = null;
        lastShape = null;
        imagePalette = [];
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
            ['1 … 6', 'Инструменты'],
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

    // --- 6.1 Пирамида уровней (mipmap) -------------------------------------
    // Предварительно строим 1/2, 1/4, 1/8. При уменьшении картинки рисуем
    // мелкий уровень вместо гигантского исходника — это дешевле и плавнее.
    function buildPyramid() {
        pyramid = null;
        pyramidLevel = 0;
        const iw = imageW(), ih = imageH();
        if (!iw || !ih || iw * ih < 1200 * 1200) return; // смысл есть только на больших
        const levels = [];
        let w = iw, h = ih;
        for (let i = 0; i < 3; i++) {
            w = Math.max(1, Math.round(w / 2));
            h = Math.max(1, Math.round(h / 2));
            if (w < 32 || h < 32) break;
            levels.push({ w: w, h: h, canvas: null });
        }
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
                if (cx.imageSmoothingQuality) cx.imageSmoothingQuality = 'high';
                cx.drawImage(src, 0, 0, lv.w, lv.h);
                lv.canvas = cv;
            } catch (e) { /* taint и прочее — просто без уровня */ }
            done();
        };
        // строим асинхронно, чтобы не задерживать первый кадр
        setTimeout(step, 60);
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
            if (c.imageSmoothingQuality) c.imageSmoothingQuality = 'high';
            const src = sourceEl();
            const lv = pyramidFor(scale);
            if (lv) {
                c.drawImage(lv.canvas, tx, ty, iw * scale, ih * scale);
            } else {
                c.drawImage(src, tx, ty, iw * scale, ih * scale);
            }
            if (pixelGrid) drawPixelGrid(c, iw, ih);
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
            ctx.lineTo(bx - head * Math.cos(ang + Math.PI / 7), by - head * Math.sin(ang - Math.PI / 7));
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
        if (!zoomLabel) return;
        zoomLabel.textContent = Math.round(scale * 100) + '%';
    }

    function apply() {
        updateZoomLabel();
        baseValid = false;
        requestDraw();
        schedulePersist();
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
        if (!fitCanvas()) return;
        const iw = imageW(), ih = imageH();
        if (!iw || !ih) return;
        // не увеличиваем маленькие картинки сверх 100%
        scale = clamp(Math.min(viewW / iw, viewH / ih, 1), ZOOM_MIN, ZOOM_MAX);
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
        if (!silent) storeSet('img_mag_tool', name);
    }

    function updateHistoryButtons() {
        const canUndo = histIndex > 0;
        const canRedo = histIndex < history.length - 1;
        setEnabled(undoBtn, canUndo);
        setEnabled(redoBtn, canRedo);
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
            const hit = hitTest(p.x, p.y);
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
        const ip = s2i(sx, sy);
        const hitIdx = hitTest(ip.x, ip.y);
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
    function onViewportChange() {
        if (!win || !viewEl) return;
        viewRect = null;

        // ещё ни разу не мерили — просто инициализируем холст
        if (!viewW || !viewH) {
            fitCanvas();
            if (imageW()) {
                tx = (viewW - imageW() * scale) / 2;
                ty = (viewH - imageH() * scale) / 2;
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
        const src = sourceEl();
        const iw = imageW(), ih = imageH();
        if (!src || !iw || !ih) return;

        let data = null;
        try {
            const c = document.createElement('canvas');
            c.width = PALETTE_SAMPLE;
            c.height = PALETTE_SAMPLE;
            const x = c.getContext('2d');
            if (!x) return;
            x.imageSmoothingEnabled = true;
            if (x.imageSmoothingQuality) x.imageSmoothingQuality = 'high';
            // «contain» — чтобы не растянуть пропорции, но выборка всё равно
            // покрывает картинку целиком
            x.fillStyle = '#000';
            x.drawImage(src, 0, 0, PALETTE_SAMPLE, PALETTE_SAMPLE);
            data = x.getImageData(0, 0, PALETTE_SAMPLE, PALETTE_SAMPLE).data;
        } catch (e) {
            imagePalette = [];   // tainted canvas: палитры не будет
            return;
        }

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
        announce('Укажите четыре угла документа: левый верх, правый верх, правый низ, левый низ');
    }

    function cancelPerspective() {
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
        const src = sourceEl();
        const iw = imageW(), ih = imageH();
        if (!src || !iw || !ih) return;

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
            toast('Перспектива исправлена. «Ещё» → вернуть оригинал');
        } catch (e) {
            perspBusy = false;
            perspCorners = [];
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
        announce('Выделите прямоугольник вокруг текста или кода');
    }

    function setToolSilent(name) {
        // выделение идёт при любом инструменте, но курсор ставим крестиком
        if (name) { /* no-op: инструмент не меняем */ }
    }

    // Вырезаем область в offscreen-холст (ограниченного размера).
    function cropRegion(rect, scaleUp) {
        const src = sourceEl();
        if (!src) return null;
        let w = Math.max(1, Math.round(rect.w * (scaleUp || 1)));
        let h = Math.max(1, Math.round(rect.h * (scaleUp || 1)));
        const cap = SCAN_MAX_SIDE;
        if (w > cap || h > cap) {
            const k = cap / Math.max(w, h);
            w = Math.max(1, Math.round(w * k));
            h = Math.max(1, Math.round(h * k));
        }
        try {
            const cv = document.createElement('canvas');
            cv.width = w;
            cv.height = h;
            const c = cv.getContext('2d');
            if (!c) return null;
            c.imageSmoothingEnabled = true;
            if (c.imageSmoothingQuality) c.imageSmoothingQuality = 'high';
            c.drawImage(src, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
            return cv;
        } catch (e) {
            return null;
        }
    }

    function runScan(rect) {
        const mode = scanMode;
        scanMode = null;
        scanPick = false;
        if (viewEl) viewEl.style.cursor = currentTool === 'move' ? 'grab' : 'crosshair';
        requestDraw();

        if (mode === 'qr') detectCodes(rect);
        else readText(rect);
    }

    let scanMode = null;

    // --- 2.4 QR и штрих-коды (только если API есть) ------------------------
    function barcodeSupported() {
        return typeof window.BarcodeDetector === 'function';
    }

    function detectCodes(rect) {
        if (!barcodeSupported()) {
            toast('BarcodeDetector недоступен в этом браузере');
            return;
        }
        const cv = cropRegion(rect, 1);
        if (!cv) { toast('Не удалось вырезать область'); return; }

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
        const panel = openPanel(analysisBtn, 'Распознанный код', (p) => {
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
    function readText(rect) {
        const cv = cropRegion(rect, 1);
        if (!cv) { toast('Не удалось вырезать область'); return; }

        if (typeof window.TextDetector === 'function') {
            let det;
            try { det = new window.TextDetector(); } catch (e) { det = null; }
            if (det) {
                let p;
                try { p = det.detect(cv); } catch (e) { p = null; }
                if (p && typeof p.then === 'function') {
                    p.then((found) => {
                        if (!win) return;
                        const blocks = (found || []).map((f) => String(f.rawValue || '')).filter(Boolean);
                        if (blocks.length) showTextResult(blocks.join('\n'), rect, true);
                        else textFallback(rect, 'TextDetector не нашёл текст');
                    }).catch(() => textFallback(rect, 'TextDetector недоступен'));
                    return;
                }
            }
        }
        textFallback(rect, 'TextDetector недоступен в этом браузере');
    }

    function textFallback(rect, why) {
        const up = cropRegion(rect, OCR_SCALE);
        if (!up) { toast('Не удалось вырезать область'); return; }
        const note = (why ? why + '. ' : '') +
            'Область увеличена в ' + OCR_SCALE + '× и положена в буфер — вставьте её в любой OCR-сервис.';
        announce('Область увеличена и скопирована');
        if (!navigator.clipboard || !window.ClipboardItem) {
            showTextResult('', rect, false, note + ' Копирование картинок не поддерживается.');
            return;
        }
        up.toBlob((blob) => {
            if (!win || !blob) return;
            navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
                .then(() => showTextResult('', rect, false, note))
                .catch(() => showTextResult('', rect, false, note + ' Скопировать не удалось — сохраните PNG.'));
        }, 'image/png');
    }

    function showTextResult(text, rect, detected, note) {
        if (!win) return;
        closeMenu();
        openPanel(analysisBtn, detected ? 'Распознанный текст' : 'Текст: увеличенная копия', (p) => {
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
                menuItem(p, {
                    label: 'Копировать текст', icon: 'copy',
                    onClick: () => copyText(text, 'Текст скопирован'),
                });
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
                onClick: () => openPalettePanel(analysisBtn),
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
            x.drawImage(sourceEl(), 0, 0, 1, 1);
            x.getImageData(0, 0, 1, 1);
            canExport = true;
        } catch (e) {
            canExport = false;
        }
    }

    function loadCorsImage() {
        if (corsImage) return Promise.resolve(corsImage);
        if (corsTried) return Promise.resolve(null);
        corsTried = true;

        return new Promise((resolve) => {
            if (!imageUrl || !/^https?:/i.test(imageUrl)) { resolve(null); return; }
            const im = new Image();
            im.crossOrigin = 'anonymous';
            im.onload = () => { corsImage = im; resolve(im); };
            im.onerror = () => resolve(null);
            im.src = imageUrl;
        });
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
        v: 'move', p: 'pen', l: 'line', a: 'arrow', r: 'rect', e: 'circle', t: 'text'
    };

    // 4.1: цифры — инструменты, как в большинстве редакторов
    const TOOL_DIGITS = {
        '1': 'pen', '2': 'line', '3': 'arrow', '4': 'rect', '5': 'circle', '6': 'text',
        '7': 'move',
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
            rect: 'прямоугольник', circle: 'эллипс', text: 'текст',
        };
        return map[name] || name;
    }

    function focusColorInput() {
        if (!colorInputEl) return;
        try {
            colorInputEl.focus({ preventScroll: true });
            colorInputEl.click();
        } catch (e) { /* системный пикер может быть недоступен */ }
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

        persistNow();
        closeMenu();
        unwatchDpr();

        document.removeEventListener('mousemove', onMouseMove, true);
        document.removeEventListener('mouseup', onMouseUp, true);
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('keyup', onKeyUp, true);
        document.removeEventListener('mousedown', onOutsideClick, true);
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
        analysisBtn = null;
        exportBtn = null;
        moreBtn = null;
        quickPaletteEl = null;
        colorInputEl = null;
        toolButtons = {};

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
