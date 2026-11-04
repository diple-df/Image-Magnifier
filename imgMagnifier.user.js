// ==UserScript==
// @name         Image Magnifier
// @namespace    https://github.com/diple-df/Image-Magnifier
// @version      3.5.2
// @description  Двойное нажатие Ctrl при наведении мыши на изображение открывает его в отдельном плавающем окне с зумом, СКМ-панорамированием, инструментами рисования (карандаш, стрелка, линия, окружность) и объединением слоёв для копирования/сохранения
// @author       diple_df x claude
// @match        *://*/*
// @grant        GM_addStyle
// @run-at       document-start
// @downloadURL  https://raw.githubusercontent.com/diple-df/Image-Magnifier/main/imgMagnifier.user.js
// @updateURL    https://raw.githubusercontent.com/diple-df/Image-Magnifier/main/imgMagnifier.user.js
// @noframes     false
// ==/UserScript==

(function () {
    'use strict';

    // --- Настройки -------------------------------------------------------
    const DOUBLE_PRESS_MS = 500;  // макс. интервал между двумя нажатиями Ctrl
    const TOAST_MS = 2500;        // сколько показывать уведомление об ошибке
    const ZOOM_STEP = 1.15;       // множитель зума за один шаг колёсика
    const ZOOM_MIN = 0.05;
    const ZOOM_MAX = 20;
    const WIN_W = 640;            // стартовый размер окна
    const WIN_H = 520;

    // --- Отслеживание позиции курсора ------------------------------------
    let mx = 0, my = 0;
    document.addEventListener('mousemove', (e) => {
        mx = e.clientX;
        my = e.clientY;
    }, true);

    // --- Детект двойного нажатия Ctrl ------------------------------------
    let lastCtrl = 0;

    function isTypingTarget(el) {
        if (!el) return false;
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
            const type = (el.type || '').toLowerCase();
            if (type === 'password' || type === 'search' || type === 'text' || type === 'email' || type === 'url' || type === 'number') {
                return true;
            }
            return !el.disabled && !el.readOnly;
        }
        if (tag === 'SELECT') return !el.disabled;
        if (el.isContentEditable) return true;
        if (el.closest && el.closest('[contenteditable="true"], [contenteditable=""]')) return true;
        return false;
    }

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Control' && e.code !== 'ControlLeft' && e.code !== 'ControlRight') return;
        if (e.repeat) return;
        if (e.altKey || e.shiftKey || e.metaKey) return;
        const target = e.target;
        if (isTypingTarget(target)) return;
        if (target && target.closest && target.closest('#img-mag-window, .img-mag-window')) return;

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
    // Ищем по всему стеку элементов под точкой, пронзая shadow DOM
    // (YouTube и др. на веб-компонентах) — картинка часто перекрыта оверлеем
    // или спрятана внутри shadow-root.
    function resolveImageAt(x, y) {
        const seen = new Set();
        let result = null;
        const dig = (root) => {
            const stack = root.elementsFromPoint ? root.elementsFromPoint(x, y) : [];
            for (const el of stack) {
                if (seen.has(el)) continue;
                seen.add(el);
                const data = resolveImage(el);
                if (data && data.url) { result = data; return true; }
                if (el.shadowRoot && dig(el.shadowRoot)) return true;
            }
            return false;
        };
        dig(document);
        return result;
    }

    function resolveImage(el) {
        if (!el || !el.tagName) return null;

        if (el.tagName === 'IMG') {
            const u = bestFromImg(el);
            return u ? { url: u, caption: el.alt || el.title || '' } : null;
        }

        const innerImg = el.querySelector && el.querySelector('img');
        if (innerImg) {
            const u = bestFromImg(innerImg);
            if (u) return { url: u, caption: innerImg.alt || innerImg.title || '' };
        }

        const bg = getComputedStyle(el).backgroundImage;
        if (bg && bg !== 'none') {
            const m = bg.match(/url\((['"]?)(.*?)\1\)/);
            if (m && m[2]) return { url: absolutize(m[2]), caption: el.getAttribute('aria-label') || el.title || '' };
        }

        return null;
    }

    function bestFromImg(img) {
        if (img.srcset) {
            let best = null, bestW = -1;
            img.srcset.split(',').forEach((part) => {
                const tokens = part.trim().split(/\s+/);
                const u = tokens[0];
                const desc = tokens[1] || '';
                const w = desc.endsWith('w') ? parseInt(desc) : 0;
                if (u && w > bestW) { bestW = w; best = u; }
            });
            if (best) return absolutize(best);
        }
        if (img.currentSrc) return absolutize(img.currentSrc);
        if (img.src) return absolutize(img.src);
        return null;
    }

    function absolutize(u) {
        try { return new URL(u, location.href).href; } catch { return u; }
    }

    // --- Плавающее окно с зумом ------------------------------------------
    let win = null;        // контейнер окна
    let imgEl = null;      // картинка внутри
    let viewEl = null;     // вьюпорт (область просмотра)
    let zoomLabel = null;  // индикатор масштаба
    let scale = 1, tx = 0, ty = 0; // состояние трансформации картинки

    // --- состояние рисования ---
    let drawEl = null, toolButtons = {};
    let annotations = [], inProgress = null, drawing = false;
    let currentTool = 'move', penColor = '#ff3b30', penWidth = 4;

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    // --- SVG-иконки (строим через DOM, без innerHTML — иначе ломается ----
    // на сайтах с Trusted Types CSP, например YouTube) --------------------
    const SVGNS = 'http://www.w3.org/2000/svg';
    // спецификация иконки = массив [тег, {атрибуты}]
    const ICONS = {
        move:    [['path', { d: 'M12 3v18M3 12h18' }], ['path', { d: 'M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5' }]],
        pen:     [['path', { d: 'M5 19l1-4L16 5l3 3L9 18l-4 1z' }], ['path', { d: 'M14 7l3 3' }]],
        arrow:   [['path', { d: 'M5 19L18 6' }], ['path', { d: 'M9 6h9v9' }]],
        line:    [['path', { d: 'M5 19L19 5' }]],
        circle:  [['circle', { cx: 12, cy: 12, r: 7 }]],
        undo:    [['path', { d: 'M9 7L4 12l5 5' }], ['path', { d: 'M4 12h11a5 5 0 0 1 5 5v1' }]],
        trash:   [['path', { d: 'M4 7h16' }], ['path', { d: 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2' }], ['path', { d: 'M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13' }], ['path', { d: 'M10 11v6M14 11v6' }]],
        zoomOut: [['circle', { cx: 11, cy: 11, r: 6 }], ['path', { d: 'M20 20l-3.6-3.6' }], ['path', { d: 'M8.5 11h5' }]],
        zoomIn:  [['circle', { cx: 11, cy: 11, r: 6 }], ['path', { d: 'M20 20l-3.6-3.6' }], ['path', { d: 'M11 8.5v5M8.5 11h5' }]],
        fit:     [['path', { d: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5' }]],
        close:   [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
    };
    function makeIcon(spec) {
        const s = document.createElementNS(SVGNS, 'svg');
        s.setAttribute('width', '18'); s.setAttribute('height', '18');
        s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none');
        s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.9');
        s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
        s.style.display = 'block'; s.style.pointerEvents = 'none';
        for (const [tag, attrs] of spec) {
            const el = document.createElementNS(SVGNS, tag);
            for (const k in attrs) el.setAttribute(k, attrs[k]);
            s.appendChild(el);
        }
        return s;
    }

    function openWindow(url, caption) {
        if (win) closeWindow();

        const savedW = parseInt(localStorage.getItem('img_mag_w')) || WIN_W;
        const savedH = parseInt(localStorage.getItem('img_mag_h')) || WIN_H;
        const savedScale = parseFloat(localStorage.getItem('img_mag_scale'));

        // --- контейнер окна ---
        win = document.createElement('div');
        Object.assign(win.style, {
            position: 'fixed', zIndex: 2147483647,
            left: Math.max(10, (innerWidth - savedW) / 2) + 'px',
            top: Math.max(10, (innerHeight - savedH) / 2) + 'px',
            width: savedW + 'px', height: savedH + 'px',
            minWidth: '220px', minHeight: '160px',
            background: '#1e1e1e', borderRadius: '10px', overflow: 'hidden',
            boxShadow: '0 12px 48px rgba(0,0,0,0.65)',
            display: 'flex', flexDirection: 'column',
            resize: 'both', border: '1px solid rgba(255,255,255,0.12)',
            font: '13px/1.3 sans-serif',
        });

        // --- заголовок (перетаскивание окна) ---
        const bar = document.createElement('div');
        Object.assign(bar.style, {
            display: 'flex', alignItems: 'center', gap: '4px',
            height: '34px', flex: '0 0 34px', padding: '0 6px 0 10px',
            background: '#2b2b2b', color: '#fff', cursor: 'move',
            userSelect: 'none',
        });

        const title = document.createElement('div');
        title.textContent = caption || 'Изображение';
        Object.assign(title.style, {
            flex: '1', overflow: 'hidden', textOverflow: 'ellipsis',
            whiteSpace: 'nowrap', opacity: '0.9',
        });

        zoomLabel = document.createElement('div');
        Object.assign(zoomLabel.style, { opacity: '0.7', margin: '0 6px', minWidth: '42px', textAlign: 'right' });

        const btn = (icon, tip, onClick) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.appendChild(makeIcon(icon));
            b.title = tip;
            Object.assign(b.style, {
                background: 'transparent', color: '#fff', border: 'none',
                cursor: 'pointer', width: '28px', height: '28px', padding: '0',
                borderRadius: '5px', display: 'flex', alignItems: 'center', justifyContent: 'center',
            });
            b.addEventListener('mouseenter', () => b.style.background = 'rgba(255,255,255,0.15)');
            b.addEventListener('mouseleave', () => b.style.background = 'transparent');
            b.addEventListener('mousedown', (e) => e.stopPropagation()); // не таскать окно
            b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
            return b;
        };

        const btnOut = btn(ICONS.zoomOut, 'Отдалить', () => zoomCenter(1 / ZOOM_STEP));
        const btnIn = btn(ICONS.zoomIn, 'Приблизить', () => zoomCenter(ZOOM_STEP));
        const btnFit = btn(ICONS.fit, 'По размеру окна', fitImage);
        const btnClose = btn(ICONS.close, 'Закрыть (Esc)', closeWindow);

        bar.append(title, zoomLabel, btnOut, btnIn, btnFit, btnClose);

        // --- панель инструментов рисования ---
        const tb = document.createElement('div');
        Object.assign(tb.style, {
            display: 'flex', alignItems: 'center', gap: '3px', flexWrap: 'wrap',
            flex: '0 0 auto', padding: '4px 8px', background: '#242424',
            borderTop: '1px solid rgba(255,255,255,0.08)', userSelect: 'none',
        });

        toolButtons = {};
        const toolBtn = (name, icon, tip) => {
            const b = document.createElement('button');
            b.type = 'button'; b.appendChild(makeIcon(icon)); b.title = tip;
            Object.assign(b.style, {
                background: 'transparent', color: '#fff', border: 'none', cursor: 'pointer',
                width: '30px', height: '26px', borderRadius: '5px', padding: '0',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
            });
            b._refresh = () => { b.style.background = (currentTool === name) ? 'rgba(0,120,212,0.95)' : 'transparent'; };
            b.addEventListener('mouseenter', () => { if (currentTool !== name) b.style.background = 'rgba(255,255,255,0.15)'; });
            b.addEventListener('mouseleave', b._refresh);
            b.addEventListener('mousedown', (e) => e.stopPropagation());
            b.addEventListener('click', (e) => { e.stopPropagation(); setTool(name); });
            toolButtons[name] = b;
            return b;
        };

        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.value = penColor;
        colorInput.title = 'Цвет';
        Object.assign(colorInput.style, { width: '28px', height: '24px', border: 'none', background: 'transparent', cursor: 'pointer', padding: '0' });
        colorInput.addEventListener('input', () => { penColor = colorInput.value; });
        colorInput.addEventListener('mousedown', (e) => e.stopPropagation());

        const widthSel = document.createElement('select');
        widthSel.title = 'Толщина линии';
        Object.assign(widthSel.style, { background: '#1e1e1e', color: '#fff', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px', cursor: 'pointer', height: '24px' });
        [2, 4, 6, 10, 16].forEach((w) => {
            const o = document.createElement('option');
            o.value = w; o.textContent = w + 'px';
            if (w === penWidth) o.selected = true;
            widthSel.appendChild(o);
        });
        widthSel.addEventListener('change', () => { penWidth = parseInt(widthSel.value); });
        widthSel.addEventListener('mousedown', (e) => e.stopPropagation());

        const sep = () => {
            const s = document.createElement('div');
            Object.assign(s.style, { width: '1px', height: '20px', background: 'rgba(255,255,255,0.15)', margin: '0 3px' });
            return s;
        };

        tb.append(
            toolBtn('move', ICONS.move, 'Перемещение / панорама'),
            toolBtn('pen', ICONS.pen, 'Карандаш'),
            toolBtn('arrow', ICONS.arrow, 'Стрелка'),
            toolBtn('line', ICONS.line, 'Линия'),
            toolBtn('circle', ICONS.circle, 'Окружность'),
            sep(), colorInput, widthSel, sep(),
            btn(ICONS.undo, 'Отменить (Ctrl+Z)', undo),
            btn(ICONS.trash, 'Очистить всё', clearAll),
        );

        // --- вьюпорт ---
        viewEl = document.createElement('div');
        Object.assign(viewEl.style, {
            flex: '1', overflow: 'hidden', position: 'relative',
            background: '#0f0f0f', cursor: 'grab',
        });

        imgEl = document.createElement('img');
        imgEl.src = url;
        imgEl.draggable = false;
        Object.assign(imgEl.style, {
            display: 'none',
            position: 'absolute', top: '0', left: '0',
            transformOrigin: '0 0', userSelect: 'none', maxWidth: 'none', maxHeight: 'none',
        });
        imgEl.addEventListener('load', () => {
            if (!isNaN(savedScale) && savedScale > 0) {
                scale = clamp(savedScale, ZOOM_MIN, ZOOM_MAX);
                const vw = viewEl.clientWidth, vh = viewEl.clientHeight;
                const iw = imgEl.naturalWidth || imgEl.width;
                const ih = imgEl.naturalHeight || imgEl.height;
                tx = (vw - iw * scale) / 2;
                ty = (vh - ih * scale) / 2;
                apply();
            } else {
                fitImage();
            }
        });
        imgEl.addEventListener('error', () => toast('Не удалось загрузить изображение'));

        // холст для рисования поверх картинки (всегда перехватывает клики,
        // включая ПКМ — чтобы нативное "Копировать изображение" брало все слои)
        drawEl = document.createElement('canvas');
        Object.assign(drawEl.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'auto' });

        viewEl.append(imgEl, drawEl);
        win.append(bar, tb, viewEl);
        document.body.appendChild(win);

        annotations = [];
        inProgress = null;
        setTool('move');

        // --- события ---
        viewEl.addEventListener('wheel', onWheel, { passive: false });
        drawEl.addEventListener('wheel', onWheel, { passive: false });
        viewEl.addEventListener('mousedown', onMouseDown);
        drawEl.addEventListener('mousedown', onMouseDown);
        bar.addEventListener('mousedown', onDragStart);
        document.addEventListener('mousemove', onMouseMove, true);
        document.addEventListener('mouseup', onMouseUp, true);
        document.addEventListener('keydown', onKey, true);
        // клик вне окна закрывает его
        document.addEventListener('mousedown', onOutsideClick, true);
        // пересчёт при изменении размера окна (через resize-уголок)
        winRO = new ResizeObserver(() => {
            if (win) {
                localStorage.setItem('img_mag_w', win.clientWidth);
                localStorage.setItem('img_mag_h', win.clientHeight);
            }
            fitCanvas(); redraw();
        });
        winRO.observe(win);
    }

    // Вписать картинку в окно и отцентровать
    function fitImage() {
        if (!imgEl || !viewEl) return;
        fitCanvas();
        const vw = viewEl.clientWidth, vh = viewEl.clientHeight;
        const iw = imgEl.naturalWidth || imgEl.width;
        const ih = imgEl.naturalHeight || imgEl.height;
        if (!iw || !ih) return;
        scale = clamp(Math.min(vw / iw, vh / ih), ZOOM_MIN, ZOOM_MAX);
        tx = (vw - iw * scale) / 2;
        ty = (vh - ih * scale) / 2;
        apply();
    }

    function apply() {
        if (zoomLabel) zoomLabel.textContent = Math.round(scale * 100) + '%';
        localStorage.setItem('img_mag_scale', scale);
        redraw();
    }

    // --- Рисование -------------------------------------------------------
    function setTool(name) {
        currentTool = name;
        for (const k in toolButtons) toolButtons[k]._refresh();
        if (viewEl) viewEl.style.cursor = (name === 'move') ? 'grab' : 'crosshair';
    }

    function fitCanvas() {
        if (!drawEl || !viewEl) return;
        const vw = viewEl.clientWidth, vh = viewEl.clientHeight;
        const dpr = window.devicePixelRatio || 1;
        drawEl.width = Math.round(vw * dpr);
        drawEl.height = Math.round(vh * dpr);
        drawEl.style.width = vw + 'px';
        drawEl.style.height = vh + 'px';
    }

    const s2i = (x, y) => ({ x: (x - tx) / scale, y: (y - ty) / scale }); // экран → картинка
    const i2s = (x, y) => ({ x: x * scale + tx, y: y * scale + ty });     // картинка → экран

    // Отрисовка объединённых слоёв: сначала исходная картинка, затем аннотации.
    // Так на холсте лежит итоговое изображение, и ПКМ → "Копировать/Сохранить"
    // берёт его целиком, а не только слой рисования.
    function redraw() {
        if (!drawEl || !imgEl) return;
        const dpr = window.devicePixelRatio || 1;
        const ctx = drawEl.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, drawEl.width / dpr, drawEl.height / dpr);

        const iw = imgEl.naturalWidth || imgEl.width;
        const ih = imgEl.naturalHeight || imgEl.height;
        if (iw && ih) {
            ctx.drawImage(imgEl, tx, ty, iw * scale, ih * scale);
        }

        const list = inProgress ? annotations.concat([inProgress]) : annotations;
        for (const s of list) renderShapeOnContext(ctx, s, scale, tx, ty);
    }

    function renderShapeOnContext(ctx, s, curScale, curTx, curTy) {
        const transform = (x, y) => ({ x: x * curScale + curTx, y: y * curScale + curTy });
        ctx.strokeStyle = s.color; ctx.fillStyle = s.color;
        ctx.lineWidth = Math.max(1, s.width * curScale);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        if (s.type === 'pen') {
            if (!s.points.length) return;
            ctx.beginPath();
            s.points.forEach((p, i) => { const q = transform(p.x, p.y); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
            ctx.stroke();
        } else if (s.type === 'circle') {
            const a = transform(s.x1, s.y1), b = transform(s.x2, s.y2);
            const cx = (a.x + b.x) / 2;
            const cy = (a.y + b.y) / 2;
            const rx = Math.abs(b.x - a.x) / 2;
            const ry = Math.abs(b.y - a.y) / 2;
            ctx.beginPath();
            ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
            ctx.stroke();
        } else { // line, arrow
            const a = transform(s.x1, s.y1), b = transform(s.x2, s.y2);
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
            if (s.type === 'arrow') {
                const ang = Math.atan2(b.y - a.y, b.x - a.x);
                const head = Math.max(10, s.width * curScale * 3.5);
                ctx.beginPath();
                ctx.moveTo(b.x, b.y);
                ctx.lineTo(b.x - head * Math.cos(ang - Math.PI / 7), b.y - head * Math.sin(ang - Math.PI / 7));
                ctx.moveTo(b.x, b.y);
                ctx.lineTo(b.x - head * Math.cos(ang + Math.PI / 7), b.y - head * Math.sin(ang + Math.PI / 7));
                ctx.stroke();
            }
        }
    }

    function undo() { annotations.pop(); redraw(); }
    function clearAll() { annotations = []; inProgress = null; redraw(); }

    function zoomAt(cx, cy, factor) {
        const newScale = clamp(scale * factor, ZOOM_MIN, ZOOM_MAX);
        const f = newScale / scale;
        tx = cx - (cx - tx) * f;
        ty = cy - (cy - ty) * f;
        scale = newScale;
        apply();
    }

    function zoomCenter(factor) {
        zoomAt(viewEl.clientWidth / 2, viewEl.clientHeight / 2, factor);
    }

    function onWheel(e) {
        e.preventDefault();
        const rect = viewEl.getBoundingClientRect();
        const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
    }

    // --- Панорамирование картинки и перетаскивание окна ------------------
    let mode = null; // 'pan' | 'drag'
    let startX = 0, startY = 0, startA = 0, startB = 0;
    let winRO = null;

    function onMouseDown(e) {
        if (e.button === 1) {
            e.preventDefault(); e.stopPropagation();
            mode = 'pan';
            startX = e.clientX; startY = e.clientY;
            startA = tx; startB = ty;
            if (viewEl) viewEl.style.cursor = 'grabbing';
            return;
        }
        if (e.button !== 0) return;
        if (currentTool === 'move') {
            mode = 'pan';
            startX = e.clientX; startY = e.clientY;
            startA = tx; startB = ty;
            if (viewEl) viewEl.style.cursor = 'grabbing';
            e.preventDefault();
        } else {
            e.preventDefault(); e.stopPropagation();
            drawing = true;
            const rect = viewEl.getBoundingClientRect();
            const p = s2i(e.clientX - rect.left, e.clientY - rect.top);
            if (currentTool === 'pen') inProgress = { type: 'pen', color: penColor, width: penWidth, points: [p] };
            else inProgress = { type: currentTool, color: penColor, width: penWidth, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
            redraw();
        }
    }

    function onDragStart(e) {
        if (e.button !== 0) return;
        mode = 'drag';
        const r = win.getBoundingClientRect();
        startX = e.clientX; startY = e.clientY;
        startA = r.left; startB = r.top;
        e.preventDefault();
    }

    function onMouseMove(e) {
        if (drawing && inProgress) {
            const rect = viewEl.getBoundingClientRect();
            const p = s2i(e.clientX - rect.left, e.clientY - rect.top);
            if (inProgress.type === 'pen') inProgress.points.push(p);
            else { inProgress.x2 = p.x; inProgress.y2 = p.y; }
            redraw();
        } else if (mode === 'pan') {
            tx = startA + (e.clientX - startX);
            ty = startB + (e.clientY - startY);
            apply();
        } else if (mode === 'drag') {
            win.style.left = (startA + (e.clientX - startX)) + 'px';
            win.style.top = (startB + (e.clientY - startY)) + 'px';
        }
    }

    function onMouseUp() {
        if (drawing) {
            drawing = false;
            if (inProgress) {
                const tiny = inProgress.type !== 'pen' &&
                    Math.hypot(inProgress.x2 - inProgress.x1, inProgress.y2 - inProgress.y1) * scale < 3;
                if (!tiny) annotations.push(inProgress);
            }
            inProgress = null;
            redraw();
            return;
        }
        if (mode === 'pan' && viewEl) viewEl.style.cursor = 'grab';
        mode = null;
    }

    // Клик мимо окна — закрыть
    function onOutsideClick(e) {
        if (win && !win.contains(e.target)) closeWindow();
    }

    function onKey(e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeWindow();
        } else if (e.ctrlKey && (e.key === 'z' || e.key === 'Z' || e.key === 'я' || e.key === 'Я')) {
            e.preventDefault();
            e.stopPropagation();
            undo();
        }
    }

    function closeWindow() {
        if (!win) return;
        document.removeEventListener('mousemove', onMouseMove, true);
        document.removeEventListener('mouseup', onMouseUp, true);
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('mousedown', onOutsideClick, true);
        if (winRO) { winRO.disconnect(); winRO = null; }
        win.remove();
        win = imgEl = viewEl = zoomLabel = drawEl = null;
        mode = null;
        drawing = false;
        inProgress = null;
        annotations = [];
        toolButtons = {};
    }

    // --- Простое уведомление ---------------------------------------------
    let toastEl = null, toastTimer = null;
    function toast(msg) {
        if (!toastEl) {
            toastEl = document.createElement('div');
            Object.assign(toastEl.style, {
                position: 'fixed', zIndex: 2147483647, bottom: '20px', left: '50%',
                transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.85)', color: '#fff',
                padding: '10px 16px', borderRadius: '8px', font: '14px/1.4 sans-serif',
                pointerEvents: 'none', maxWidth: '80vw', textAlign: 'center',
                boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
            });
        }
        toastEl.textContent = msg;
        if (!toastEl.isConnected) document.body.appendChild(toastEl);
        toastEl.style.opacity = '1';
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toastEl.style.transition = 'opacity 0.3s';
            toastEl.style.opacity = '0';
        }, TOAST_MS);
    }
})();
