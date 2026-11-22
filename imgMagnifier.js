// ==UserScript==
// @name         Image Magnifier
// @namespace    https://github.com/diple-df/Image-Magnifier
// @version      3.6.0
// @description  Р”РІРѕР№РЅРѕР№ Ctrl РїРѕ РёР·РѕР±СЂР°Р¶РµРЅРёСЋ РѕС‚РєСЂС‹РІР°РµС‚ РµРіРѕ РІ РїР»Р°РІР°СЋС‰РµРј РѕРєРЅРµ: Р·СѓРј 5вЂ“2000% СЃ РїСЂРёРІСЏР·РєРѕР№ Рє РєСѓСЂСЃРѕСЂСѓ, РїР°РЅРѕСЂР°РјРёСЂРѕРІР°РЅРёРµ, РёРЅСЃС‚СЂСѓРјРµРЅС‚С‹ СЂРёСЃРѕРІР°РЅРёСЏ (РєР°СЂР°РЅРґР°С€, Р»РёРЅРёСЏ, СЃС‚СЂРµР»РєР°, РїСЂСЏРјРѕСѓРіРѕР»СЊРЅРёРє, СЌР»Р»РёРїСЃ, С‚РµРєСЃС‚), РѕС‚РјРµРЅР°/РїРѕРІС‚РѕСЂ, РєРѕРїРёСЂРѕРІР°РЅРёРµ (Ctrl+C) Рё СЃРѕС…СЂР°РЅРµРЅРёРµ PNG (Ctrl+S) СЃ РѕР±СЉРµРґРёРЅС‘РЅРЅС‹РјРё СЃР»РѕСЏРјРё, РїРѕРґРґРµСЂР¶РєР° РєР°СЃР°РЅРёР№
// @author       diple_df x claude
// @match        *://*/*
// @run-at       document-start
// @downloadURL  https://raw.githubusercontent.com/diple-df/Image-Magnifier/main/imgMagnifier.js
// @updateURL    https://raw.githubusercontent.com/diple-df/Image-Magnifier/main/imgMagnifier.js
// @noframes     false
// ==/UserScript==

(function () {
    'use strict';

    // --- РљРѕРЅСЃС‚Р°РЅС‚С‹ --------------------------------------------------------
    const DOUBLE_PRESS_MS = 500;   // РјР°РєСЃ. РёРЅС‚РµСЂРІР°Р» РјРµР¶РґСѓ РґРІСѓРјСЏ РЅР°Р¶Р°С‚РёСЏРјРё Ctrl
    const TOAST_MS = 2500;
    const ZOOM_STEP = 1.15;        // С€Р°Рі РєРЅРѕРїРѕРє +/в€’
    const ZOOM_MIN = 0.05;
    const ZOOM_MAX = 20;           // 2000%
    const WIN_W = 640;             // СЃС‚Р°СЂС‚РѕРІС‹Р№ СЂР°Р·РјРµСЂ РѕРєРЅР°
    const WIN_H = 520;
    const MAX_ANNOTATIONS = 500;   // Р·Р°С‰РёС‚Р° РѕС‚ РЅРµРѕРіСЂР°РЅРёС‡РµРЅРЅРѕРіРѕ СЂРѕСЃС‚Р° РїР°РјСЏС‚Рё
    const MAX_POINTS = 12000;      // С‚РѕС‡РµРє РІ РѕРґРЅРѕР№ Р»РёРЅРёРё РєР°СЂР°РЅРґР°С€Р°
    const PEN_MIN_DIST = 1.2;      // РјРёРЅ. С€Р°Рі РјРµР¶РґСѓ С‚РѕС‡РєР°РјРё РєР°СЂР°РЅРґР°С€Р° (СЌРєСЂР°РЅРЅС‹Рµ px)
    const HISTORY_LIMIT = 80;      // РєР°РґСЂРѕРІ undo/redo
    const DPR_MAX = 3;             // РїРѕС‚РѕР»РѕРє devicePixelRatio РґР»СЏ С…РѕР»СЃС‚Р°
    const WIN_ID = 'img-mag-window';

    // --- Р‘РµР·РѕРїР°СЃРЅРѕРµ С…СЂР°РЅРёР»РёС‰Рµ (localStorage РјРѕР¶РµС‚ Р±СЂРѕСЃР°С‚СЊ) ----------------
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

    // --- РћС‚СЃР»РµР¶РёРІР°РЅРёРµ РїРѕР·РёС†РёРё РєСѓСЂСЃРѕСЂР° ------------------------------------
    let mx = 0, my = 0;
    document.addEventListener('mousemove', (e) => {
        mx = e.clientX;
        my = e.clientY;
    }, { capture: true, passive: true });

    // --- Р”РµС‚РµРєС‚ РґРІРѕР№РЅРѕРіРѕ РЅР°Р¶Р°С‚РёСЏ Ctrl ------------------------------------
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
        if (win) { closeWindow(); return; } // РїРѕРІС‚РѕСЂРЅС‹Р№ РґРІРѕР№РЅРѕР№ Ctrl Р·Р°РєСЂС‹РІР°РµС‚ РѕРєРЅРѕ

        const data = resolveImageAt(mx, my);
        if (!data) {
            toast('РџРѕРґ РєСѓСЂСЃРѕСЂРѕРј РЅРµС‚ РёР·РѕР±СЂР°Р¶РµРЅРёСЏ');
            return;
        }
        openWindow(data.url, data.caption);
    }

    // --- РџРѕРёСЃРє РєР°СЂС‚РёРЅРєРё РїРѕРґ РєСѓСЂСЃРѕСЂРѕРј -------------------------------------
    // РРґС‘Рј РїРѕ РІСЃРµРјСѓ СЃС‚РµРєСѓ СЌР»РµРјРµРЅС‚РѕРІ РїРѕРґ С‚РѕС‡РєРѕР№, РїСЂРѕРЅР·Р°СЏ shadow DOM
    // (YouTube Рё РґСЂ. РЅР° РІРµР±-РєРѕРјРїРѕРЅРµРЅС‚Р°С…): РєР°СЂС‚РёРЅРєР° С‡Р°СЃС‚Рѕ РїРµСЂРµРєСЂС‹С‚Р° РѕРІРµСЂР»РµРµРј
    // РёР»Рё СЃРїСЂСЏС‚Р°РЅР° РІРЅСѓС‚СЂРё shadow-root.
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
                if (el.id === WIN_ID) continue;            // СЃРІРѕС‘ РѕРєРЅРѕ РЅРµ Р°РЅР°Р»РёР·РёСЂСѓРµРј
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
            const u = bestFromImg(el);
            return u ? { url: u, caption: el.alt || el.title || '' } : null;
        }

        if (el.tagName === 'CANVAS') {
            const u = urlFromCanvas(el);
            if (u) return { url: u, caption: el.getAttribute('aria-label') || el.title || '' };
        }

        const innerImg = el.querySelector && el.querySelector('img');
        if (innerImg) {
            const u = bestFromImg(innerImg);
            if (u) return { url: u, caption: innerImg.alt || innerImg.title || '' };
        }

        const bg = bgImageUrl(el);
        if (bg) return { url: bg, caption: el.getAttribute('aria-label') || el.title || '' };

        return null;
    }

    function urlFromCanvas(c) {
        try {
            if (!c.width || !c.height) return null;
            const d = c.toDataURL('image/png');
            // РїСѓСЃС‚РѕР№/Р±РёС‚С‹Р№ С…РѕР»СЃС‚ РґР°С‘С‚ РѕС‡РµРЅСЊ РєРѕСЂРѕС‚РєСѓСЋ СЃС‚СЂРѕРєСѓ
            return d && d.length > 64 ? d : null;
        } catch (e) {
            return null; // tainted canvas
        }
    }

    // Р Р°Р·Р±РёСЂР°РµРј srcset РїРѕ РґРµСЃРєСЂРёРїС‚РѕСЂР°Рј, РЅРµ СЂР°Р·СЂРµР·Р°СЏ URL РїРѕ Р·Р°РїСЏС‚С‹Рј
    // (РёРЅР°С‡Рµ Р»РѕРјР°СЋС‚СЃСЏ data: URL). Р‘РµСЂС‘Рј СЃР°РјС‹Р№ РєСЂСѓРїРЅС‹Р№ РєР°РЅРґРёРґР°С‚.
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

    // background-image РјРѕР¶РµС‚ СЃРѕРґРµСЂР¶Р°С‚СЊ image-set(...) СЃРѕ СЃРїРёСЃРєРѕРј url();
    // Р±РµСЂС‘Рј РїРѕСЃР»РµРґРЅРёР№ вЂ” РѕР±С‹С‡РЅРѕ СЌС‚Рѕ РЅР°РёР±РѕР»СЊС€Р°СЏ РїР»РѕС‚РЅРѕСЃС‚СЊ.
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

    // --- SVG-РёРєРѕРЅРєРё (С‚РѕР»СЊРєРѕ DOM, Р±РµР· innerHTML: Trusted Types CSP) -------
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
        close:   [['path', { d: 'M6 6l12 12M18 6L6 18' }]]
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

    // --- РЎРѕСЃС‚РѕСЏРЅРёРµ --------------------------------------------------------
    let win = null;          // РєРѕРЅС‚РµР№РЅРµСЂ РѕРєРЅР°
    let barEl = null;        // Р·Р°РіРѕР»РѕРІРѕРє (РїРµСЂРµС‚Р°СЃРєРёРІР°РЅРёРµ)
    let viewEl = null;       // РІСЊСЋРїРѕСЂС‚
    let imgEl = null;        // СЃРєСЂС‹С‚С‹Р№ <img> вЂ” РёСЃС‚РѕС‡РЅРёРє РїРёРєСЃРµР»РµР№
    let drawEl = null;       // РІРёРґРёРјС‹Р№ С…РѕР»СЃС‚: РєР°СЂС‚РёРЅРєР° + Р°РЅРЅРѕС‚Р°С†РёРё
    let baseCanvas = null;   // РєСЌС€ "РєР°СЂС‚РёРЅРєР° + РїРѕРґС‚РІРµСЂР¶РґС‘РЅРЅС‹Рµ Р°РЅРЅРѕС‚Р°С†РёРё"
    let baseCtx = null;
    let statusEl = null;     // "Р—Р°РіСЂСѓР·РєР°вЂ¦" / РѕС€РёР±РєР°
    let helpEl = null;
    let textInput = null;
    let zoomLabel = null;
    let undoBtn = null, redoBtn = null, fillBtn = null;
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
    let viewRect = null;    // РєСЌС€ getBoundingClientRect РЅР° РІСЂРµРјСЏ Р¶РµСЃС‚Р°
    let spaceDown = false;
    let overWin = false;
    let winRO = null;
    let persistTimer = 0;
    let canExport = null;   // true/false РїРѕСЃР»Рµ РїСЂРѕРІРµСЂРєРё taint
    let corsImage = null;
    let corsTried = false;

    const s2i = (x, y) => ({ x: (x - tx) / scale, y: (y - ty) / scale }); // СЌРєСЂР°РЅ в†’ РєР°СЂС‚РёРЅРєР°

    function imageW() { return (imgEl && (imgEl.naturalWidth || imgEl.width)) || 0; }
    function imageH() { return (imgEl && (imgEl.naturalHeight || imgEl.height)) || 0; }

    function rootEl() { return document.body || document.documentElement; }

    // --- РљРЅРѕРїРєРё -----------------------------------------------------------
    function decorateButton(b) {
        b.addEventListener('mouseenter', () => {
            if (b.dataset.active !== '1' && b.dataset.disabled !== '1') {
                b.style.background = 'rgba(255,255,255,0.15)';
            }
        });
        b.addEventListener('mouseleave', () => setBtnActive(b, b.dataset.active === '1'));
        b.addEventListener('mousedown', (e) => e.stopPropagation()); // РЅРµ С‚Р°СЃРєР°С‚СЊ РѕРєРЅРѕ
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

    // РљРЅРѕРїРєРё, РєРѕС‚РѕСЂС‹Рµ РѕР±СЏР·Р°РЅС‹ РѕСЃС‚Р°РІР°С‚СЊСЃСЏ РІРёРґРёРјС‹РјРё РІ СѓР·РєРѕРј РѕРєРЅРµ:
    // СЃР¶РёРјР°РµРј Р·Р°РіРѕР»РѕРІРѕРє Рё РїРѕРґРїРёСЃСЊ РјР°СЃС€С‚Р°Р±Р°, Р° РЅРµ РїСЂСЏС‡РµРј СѓРїСЂР°РІР»РµРЅРёРµ.
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

    // --- РћС‚РєСЂС‹С‚РёРµ РѕРєРЅР° ----------------------------------------------------
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

        // --- РєРѕРЅС‚РµР№РЅРµСЂ РѕРєРЅР° ---
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

        // --- Р·Р°РіРѕР»РѕРІРѕРє ---
        barEl = document.createElement('div');
        Object.assign(barEl.style, {
            display: 'flex', alignItems: 'center', gap: '2px',
            height: '34px', flex: '0 0 34px', padding: '0 4px 0 10px',
            background: '#2b2b2b', color: '#fff', cursor: 'move',
            userSelect: 'none', boxSizing: 'border-box', minWidth: '0',
        });

        const title = document.createElement('div');
        title.textContent = caption || 'РР·РѕР±СЂР°Р¶РµРЅРёРµ';
        title.title = caption || url;
        Object.assign(title.style, {
            flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis',
            whiteSpace: 'nowrap', opacity: '0.9', minWidth: '0',
        });

        zoomLabel = document.createElement('button');
        zoomLabel.type = 'button';
        zoomLabel.title = 'РЎР±СЂРѕСЃРёС‚СЊ РјР°СЃС€С‚Р°Р± РґРѕ 100% (Ctrl+0)';
        zoomLabel.setAttribute('aria-label', 'РњР°СЃС€С‚Р°Р±. РќР°Р¶РјРёС‚Рµ, С‡С‚РѕР±С‹ СЃР±СЂРѕСЃРёС‚СЊ РґРѕ 100%');
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

        const btnOut = iconButton('zoomOut', 'РћС‚РґР°Р»РёС‚СЊ', () => zoomCenter(1 / ZOOM_STEP));
        const btnIn = iconButton('zoomIn', 'РџСЂРёР±Р»РёР·РёС‚СЊ', () => zoomCenter(ZOOM_STEP));
        const btnFit = iconButton('fit', 'РџРѕ СЂР°Р·РјРµСЂСѓ РѕРєРЅР° (Ctrl+1)', () => fitImage());
        const btnCopy = iconButton('copy', 'РљРѕРїРёСЂРѕРІР°С‚СЊ РёР·РѕР±СЂР°Р¶РµРЅРёРµ (Ctrl+C)', () => copyToClipboard());
        const btnSave = iconButton('save', 'РЎРѕС…СЂР°РЅРёС‚СЊ PNG (Ctrl+S)', () => savePNG());
        const btnHelp = iconButton('help', 'Р“РѕСЂСЏС‡РёРµ РєР»Р°РІРёС€Рё (?)', () => toggleHelp());
        const btnClose = iconButton('close', 'Р—Р°РєСЂС‹С‚СЊ (Esc)', () => closeWindow());

        // РІ СѓР·РєРѕРј РѕРєРЅРµ СѓРїСЂР°РІР»РµРЅРёРµ СЃР¶РёРјР°РµС‚СЃСЏ, РЅРѕ РЅРµ РёСЃС‡РµР·Р°РµС‚
        [btnOut, btnIn, btnFit, btnCopy, btnSave, btnHelp, btnClose].forEach(compactButton);

        barEl.append(title, zoomLabel, btnOut, btnIn, btnFit, btnCopy, btnSave, btnHelp, btnClose);

        // --- РїР°РЅРµР»СЊ РёРЅСЃС‚СЂСѓРјРµРЅС‚РѕРІ ---
        const tb = document.createElement('div');
        Object.assign(tb.style, {
            display: 'flex', alignItems: 'center', gap: '3px', flexWrap: 'wrap',
            flex: '0 0 auto', padding: '4px 8px', background: '#242424',
            borderTop: '1px solid rgba(255,255,255,0.08)', userSelect: 'none',
            boxSizing: 'border-box',
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
        colorInput.title = 'Р¦РІРµС‚';
        colorInput.setAttribute('aria-label', 'Р¦РІРµС‚ СЂРёСЃРѕРІР°РЅРёСЏ');
        Object.assign(colorInput.style, {
            width: '28px', height: '24px', border: 'none', background: 'transparent',
            cursor: 'pointer', padding: '0', flex: '0 0 auto', outline: 'none',
            borderRadius: '4px',
        });
        colorInput.addEventListener('input', () => {
            penColor = colorInput.value;
            storeSet('img_mag_color', penColor);
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
        widthSel.title = 'РўРѕР»С‰РёРЅР° Р»РёРЅРёРё';
        widthSel.setAttribute('aria-label', 'РўРѕР»С‰РёРЅР° Р»РёРЅРёРё');
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

        fillBtn = iconButton(fillShapes ? 'fillOn' : 'fillOff', 'Р—Р°Р»РёРІРєР° С„РёРіСѓСЂ', () => {
            fillShapes = !fillShapes;
            storeSet('img_mag_fill', fillShapes ? '1' : '0');
            fillBtn.replaceChildren(makeIcon(ICONS[fillShapes ? 'fillOn' : 'fillOff']));
            setBtnActive(fillBtn, fillShapes);
            fillBtn.title = fillShapes ? 'Р—Р°Р»РёРІРєР° РІРєР»СЋС‡РµРЅР°' : 'Р—Р°Р»РёРІРєР° РІС‹РєР»СЋС‡РµРЅР°';
            fillBtn.setAttribute('aria-label', 'Р—Р°Р»РёРІРєР° С„РёРіСѓСЂ');
        });
        setBtnActive(fillBtn, fillShapes);

        undoBtn = iconButton('undo', 'РћС‚РјРµРЅРёС‚СЊ (Ctrl+Z)', () => undo());
        redoBtn = iconButton('redo', 'РџРѕРІС‚РѕСЂРёС‚СЊ (Ctrl+Shift+Z)', () => redo());
        const clearBtn = iconButton('trash', 'РћС‡РёСЃС‚РёС‚СЊ РІСЃС‘', () => clearAll());

        tb.append(
            toolBtn('move', 'move', 'РџРµСЂРµРјРµС‰РµРЅРёРµ / РїР°РЅРѕСЂР°РјР° (V)'),
            toolBtn('pen', 'pen', 'РљР°СЂР°РЅРґР°С€ (P)'),
            toolBtn('line', 'line', 'Р›РёРЅРёСЏ (L)'),
            toolBtn('arrow', 'arrow', 'РЎС‚СЂРµР»РєР° (A)'),
            toolBtn('rect', 'rect', 'РџСЂСЏРјРѕСѓРіРѕР»СЊРЅРёРє (R)'),
            toolBtn('circle', 'circle', 'Р­Р»Р»РёРїСЃ (E)'),
            toolBtn('text', 'text', 'РўРµРєСЃС‚ (T)'),
            separator(), colorInput, widthSel, fillBtn, separator(),
            undoBtn, redoBtn, clearBtn
        );

        // --- РІСЊСЋРїРѕСЂС‚ ---
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

        // С…РѕР»СЃС‚ РІСЃРµРіРґР° РїРµСЂРµС…РІР°С‚С‹РІР°РµС‚ РєР»РёРєРё, РІРєР»СЋС‡Р°СЏ РџРљРњ вЂ” С‡С‚РѕР±С‹ РЅР°С‚РёРІРЅРѕРµ
        // "РљРѕРїРёСЂРѕРІР°С‚СЊ РёР·РѕР±СЂР°Р¶РµРЅРёРµ" Р±СЂР°Р»Рѕ РѕР±СЉРµРґРёРЅС‘РЅРЅС‹Рµ СЃР»РѕРё
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
        statusEl.textContent = 'Р—Р°РіСЂСѓР·РєР°вЂ¦';

        viewEl.append(imgEl, drawEl, statusEl, buildHelp());
        win.append(barEl, tb, viewEl);

        // --- СЃРѕР±С‹С‚РёСЏ ---
        viewEl.addEventListener('wheel', onWheel, { passive: false });
        viewEl.addEventListener('mousedown', onMouseDown);
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

        // --- Р·Р°РіСЂСѓР·РєР° РєР°СЂС‚РёРЅРєРё ---
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
        });
        imgEl.addEventListener('error', () => {
            if (!win) return;
            showLoadError(url);
        });
        imgEl.src = url;

        try { win.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }

    // --- РћРІРµСЂР»РµР№ СЃРїСЂР°РІРєРё ---------------------------------------------------
    function buildHelp() {
        helpEl = document.createElement('div');
        Object.assign(helpEl.style, {
            position: 'absolute', top: '0', left: '0', right: '0', bottom: '0',
            background: 'rgba(15,15,15,0.96)', color: '#e8e8e8',
            padding: '12px 16px', overflow: 'auto', display: 'none',
            zIndex: '6', font: '12.5px/1.55 sans-serif', boxSizing: 'border-box',
        });

        const head = document.createElement('div');
        head.textContent = 'Р“РѕСЂСЏС‡РёРµ РєР»Р°РІРёС€Рё';
        Object.assign(head.style, { fontWeight: '600', marginBottom: '8px', fontSize: '13px' });
        helpEl.appendChild(head);

        const rows = [
            ['РљРѕР»РµСЃРѕ', 'Р—СѓРј Рє РєСѓСЂСЃРѕСЂСѓ'],
            ['Ctrl+0 / 100%', 'РњР°СЃС€С‚Р°Р± 100%'],
            ['Ctrl+1', 'Р’РїРёСЃР°С‚СЊ РІ РѕРєРЅРѕ'],
            ['РџСЂРѕР±РµР» (СѓРґРµСЂР¶.)', 'РџР°РЅРѕСЂР°РјР°'],
            ['РЎРљРњ', 'РџР°РЅРѕСЂР°РјР°'],
            ['Ctrl+Z', 'РћС‚РјРµРЅРёС‚СЊ'],
            ['Ctrl+Shift+Z', 'РџРѕРІС‚РѕСЂРёС‚СЊ'],
            ['Shift', 'РљРІР°РґСЂР°С‚ / РєСЂСѓРі / 45В°'],
            ['Alt', 'Р РёСЃРѕРІР°С‚СЊ РѕС‚ С†РµРЅС‚СЂР°'],
            ['Ctrl+C', 'РљРѕРїРёСЂРѕРІР°С‚СЊ РёР·РѕР±СЂР°Р¶РµРЅРёРµ'],
            ['Ctrl+S', 'РЎРѕС…СЂР°РЅРёС‚СЊ PNG'],
            ['V P L A R E T', 'РРЅСЃС‚СЂСѓРјРµРЅС‚С‹'],
            ['?', 'Р­С‚Р° СЃРїСЂР°РІРєР°'],
            ['Esc', 'Р—Р°РєСЂС‹С‚СЊ']
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
        hint.textContent = 'РќР°Р¶РјРёС‚Рµ ? РёР»Рё Esc, С‡С‚РѕР±С‹ Р·Р°РєСЂС‹С‚СЊ СЃРїСЂР°РІРєСѓ';
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

    // --- РЎС‚Р°С‚СѓСЃ Р·Р°РіСЂСѓР·РєРё ---------------------------------------------------
    function hideStatus() {
        if (statusEl && statusEl.parentNode) statusEl.parentNode.removeChild(statusEl);
        statusEl = null;
    }

    function showLoadError(url) {
        if (!statusEl) return;
        statusEl.textContent = '';
        const msg = document.createElement('div');
        msg.textContent = 'РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ РёР·РѕР±СЂР°Р¶РµРЅРёРµ';
        Object.assign(msg.style, { color: '#ff8b80', fontWeight: '600' });

        const sub = document.createElement('div');
        sub.textContent = 'Р’РѕР·РјРѕР¶РЅРѕ, СЃР°Р№С‚ Р·Р°РїСЂРµС‰Р°РµС‚ С…РѕС‚Р»РёРЅРє РёР»Рё С‚СЂРµР±СѓРµС‚ Р°РІС‚РѕСЂРёР·Р°С†РёСЋ.';
        sub.style.opacity = '0.7';

        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'РћС‚РєСЂС‹С‚СЊ РІ РЅРѕРІРѕР№ РІРєР»Р°РґРєРµ';
        Object.assign(link.style, {
            color: '#6cb6ff', textDecoration: 'underline', cursor: 'pointer',
        });

        statusEl.append(msg, sub, link);
    }

    // --- РћС‚СЂРёСЃРѕРІРєР° --------------------------------------------------------
    function fitCanvas() {
        if (!drawEl || !viewEl) return false;
        const vw = viewEl.clientWidth;
        const vh = viewEl.clientHeight;
        if (!vw || !vh) return false;

        const nd = clamp(window.devicePixelRatio || 1, 1, DPR_MAX);
        const pw = Math.max(1, Math.round(vw * nd));
        const ph = Math.max(1, Math.round(vh * nd));

        if (nd !== dpr || vw !== viewW || vh !== viewH) baseValid = false;
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

    // РџРµСЂРµСЃРѕР±РёСЂР°РµРј РєСЌС€: РєР°СЂС‚РёРЅРєР° + РїРѕРґС‚РІРµСЂР¶РґС‘РЅРЅС‹Рµ Р°РЅРЅРѕС‚Р°С†РёРё РїСЂРё С‚РµРєСѓС‰РµРј
    // РјР°СЃС€С‚Р°Р±Рµ. Р”РµР»Р°РµС‚СЃСЏ С‚РѕР»СЊРєРѕ РїСЂРё СЃРјРµРЅРµ Р·СѓРјР°/РїР°РЅРѕСЂР°РјС‹/Р°РЅРЅРѕС‚Р°С†РёР№, Р° РЅРµ РЅР°
    // РєР°Р¶РґС‹Р№ mousemove.
    function rebuildBase() {
        if (!baseCanvas || !baseCtx) return;
        const c = baseCtx;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
        c.setTransform(dpr, 0, 0, dpr, 0, 0);

        const iw = imageW(), ih = imageH();
        if (iw && ih && scale > 0) {
            // РїСЂРё СЃРёР»СЊРЅРѕРј СѓРІРµР»РёС‡РµРЅРёРё РїРѕРєР°Р·С‹РІР°РµРј РїРёРєСЃРµР»Рё Р±РµР· СЃРіР»Р°Р¶РёРІР°РЅРёСЏ
            c.imageSmoothingEnabled = scale < 3;
            if (c.imageSmoothingQuality) c.imageSmoothingQuality = 'high';
            c.drawImage(imgEl, tx, ty, iw * scale, ih * scale);
        }
        for (let i = 0; i < annotations.length; i++) {
            drawShape(c, annotations[i], scale, tx, ty);
        }
        baseValid = true;
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

        if (inProgress) {
            c.setTransform(dpr, 0, 0, dpr, 0, 0);
            drawShape(c, inProgress, scale, tx, ty);
        }
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
            // line-height С…СЂР°РЅРёС‚СЃСЏ РІ РєРѕРѕСЂРґРёРЅР°С‚Р°С… РєР°СЂС‚РёРЅРєРё (s.lh), РїРѕСЌС‚РѕРјСѓ
            // РјРµР¶СЃС‚СЂРѕС‡РЅС‹Рµ РёРЅС‚РµСЂРІР°Р»С‹ СЃРѕРІРїР°РґР°СЋС‚ СЃ СЂРµРґР°РєС‚РѕСЂРѕРј РїСЂРё Р»СЋР±РѕРј Р·СѓРјРµ.
            // Р’Р°Р¶РЅРѕ: РќР• РїРµСЂРµСЃС‡РёС‚С‹РІР°РµРј РµРіРѕ РёР· s.size вЂ” РёРЅР°С‡Рµ РЅР°РєРѕРїСЏС‚СЃСЏ
            // СЂР°Р·РЅС‹Рµ РѕРєСЂСѓРіР»РµРЅРёСЏ Рё С‚РµРєСЃС‚ В«СѓРїР»С‹РІС‘С‚В» РІРЅРёР· РЅР° РЅРµСЃРєРѕР»СЊРєРѕ px.
            const lh = (s.lh ? s.lh * sc : fs * 1.25);
            ctx.font = '600 ' + fs + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
            ctx.textBaseline = 'top';
            const lines = String(s.text).split('\n');
            const x = X(s.x);
            // half-leading РїРѕРІС‚РѕСЂСЏРµС‚ РїРѕР»РѕР¶РµРЅРёРµ СЃС‚СЂРѕРєРё РІ textarea
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

    // --- РњР°СЃС€С‚Р°Р± ------------------------------------------------------------
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
        // РЅРµ СѓРІРµР»РёС‡РёРІР°РµРј РјР°Р»РµРЅСЊРєРёРµ РєР°СЂС‚РёРЅРєРё СЃРІРµСЂС… 100%
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

    // --- РџРµСЂСЃРёСЃС‚РµРЅС‚РЅРѕСЃС‚СЊ ----------------------------------------------------
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

    // --- Р“РµРѕРјРµС‚СЂРёСЏ Рё РёРЅСЃС‚СЂСѓРјРµРЅС‚С‹ -------------------------------------------
    function getViewRect() {
        if (!viewRect && viewEl) viewRect = viewEl.getBoundingClientRect();
        return viewRect || { left: 0, top: 0 };
    }

    function setTool(name, silent) {
        if (!toolButtons[name] && name !== 'move') name = 'move';
        if (textInput && name !== 'text') commitText(true);
        currentTool = name;
        for (const k in toolButtons) setBtnActive(toolButtons[k], k === name);
        if (viewEl) viewEl.style.cursor = (name === 'move') ? 'grab' : 'crosshair';
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
        updateHistoryButtons();
        invalidate();
    }

    function undo() {
        if (textInput) return;
        if (histIndex <= 0) return;
        histIndex--;
        annotations = history[histIndex].slice();
        updateHistoryButtons();
        invalidate();
    }

    function redo() {
        if (histIndex >= history.length - 1) return;
        histIndex++;
        annotations = history[histIndex].slice();
        updateHistoryButtons();
        invalidate();
    }

    function clearAll() {
        if (!annotations.length) return;
        annotations = [];
        commit();
        toast('РђРЅРЅРѕС‚Р°С†РёРё РѕС‡РёС‰РµРЅС‹ (Ctrl+Z вЂ” РІРµСЂРЅСѓС‚СЊ)');
    }

    function pushAnnotation(shape) {
        if (annotations.length >= MAX_ANNOTATIONS) {
            toast('Р”РѕСЃС‚РёРіРЅСѓС‚ Р»РёРјРёС‚ Р°РЅРЅРѕС‚Р°С†РёР№ (' + MAX_ANNOTATIONS + ')');
            return;
        }
        annotations = annotations.concat([shape]);
        commit();
        // РїРѕСЃР»Рµ РІРІРѕРґР° С‚РµРєСЃС‚Р° СЃСЂР°Р·Сѓ РІРѕР·РІСЂР°С‰Р°РµРјСЃСЏ Рє РїР°РЅРѕСЂР°РјРµ:
        // СЌС‚Рѕ СЃР°РјС‹Р№ С‡Р°СЃС‚С‹Р№ СЃР»РµРґСѓСЋС‰РёР№ С€Р°Рі
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
            toast('Р”РѕСЃС‚РёРіРЅСѓС‚ Р»РёРјРёС‚ Р°РЅРЅРѕС‚Р°С†РёР№ (' + MAX_ANNOTATIONS + ')');
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
            width: penWidth / scale,     // СЌРєСЂР°РЅРЅР°СЏ С‚РѕР»С‰РёРЅР° в†’ РїРёРєСЃРµР»Рё РєР°СЂС‚РёРЅРєРё
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
            pushAnnotation(s);   // pushAnnotation СЃР°Рј РІС‹Р·РѕРІРµС‚ invalidate()
        } else {
            requestDraw();
        }
    }

    function cancelStroke() {
        if (drawing) endStroke(true);
        inProgress = null;
    }

    // --- РўРµРєСЃС‚РѕРІС‹Р№ РёРЅСЃС‚СЂСѓРјРµРЅС‚ ----------------------------------------------
    // РўРµРєСЃС‚ С…СЂР°РЅРёС‚СЃСЏ РІ РєРѕРѕСЂРґРёРЅР°С‚Р°С… РєР°СЂС‚РёРЅРєРё (s.x, s.y, s.size), РїРѕСЌС‚РѕРјСѓ РѕРЅ
    // Р¶С‘СЃС‚РєРѕ РїСЂРёРєР»РµРµРЅ Рє РёР·РѕР±СЂР°Р¶РµРЅРёСЋ РїСЂРё Р»СЋР±РѕРј Р·СѓРјРµ/РїР°РЅРѕСЂР°РјРµ Рё РїРѕРїР°РґР°РµС‚ РІ
    // СЌРєСЃРїРѕСЂС‚ СЂРѕРІРЅРѕ С‚СѓРґР°, РіРґРµ Р±С‹Р» РЅР° СЌРєСЂР°РЅРµ.
    function openTextEditor(sx, sy) {
        if (!viewEl || !win) return;
        commitText(true);

        // РђРІС‚РѕСЂСѓС‡РєР°: Р°РЅРєРѕСЂ = С‚РѕС‡РєР° РєР»РёРєР°. Р•СЃР»Рё СЂРµРґР°РєС‚РѕСЂ РїСЂРёС€Р»РѕСЃСЊ СЃРґРІРёРЅСѓС‚СЊ РѕС‚
        // РєСЂР°СЏ РѕРєРЅР°, СЃРґРІРёРіР°РµРј Рё Р°РЅРєРѕСЂ вЂ” С‚РµРєСЃС‚ РІСЃС‚Р°РЅРµС‚ СЂРѕРІРЅРѕ С‚СѓРґР°, РіРґРµ РµРіРѕ
        // РІРёРґРµР» РїРѕР»СЊР·РѕРІР°С‚РµР»СЊ, Р° РЅРµ Р·Р° РіСЂР°РЅРёС†Сѓ РєР°СЂС‚РёРЅРєРё.
        const screenSize = textScreenSize();
        const sizeInImage = screenSize / scale;
        const lineHeight = Math.round(screenSize * 1.25);
        const baseLeft = Math.round(sx);
        const baseTop = Math.round(sy);

        const inp = document.createElement('textarea');
        inp.rows = 1;
        inp.wrap = 'off';
        inp.spellcheck = false;
        inp.placeholder = 'РўРµРєСЃС‚вЂ¦';
        inp.setAttribute('aria-label', 'РўРµРєСЃС‚ Р°РЅРЅРѕС‚Р°С†РёРё');
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

            // РЅРµ РІС‹Р»РµР·Р°РµРј Р·Р° РіСЂР°РЅРёС†С‹ РІСЊСЋРїРѕСЂС‚Р°
            inp._left = Math.round(clamp(baseLeft, 0, Math.max(0, viewW - w - 4)));
            inp._top = Math.round(clamp(baseTop, 0, Math.max(0, viewH - h - 4)));
            inp.style.left = inp._left + 'px';
            inp.style.top = inp._top + 'px';
        };

        const finish = (keep) => {
            if (!inp.isConnected) return;
            const value = inp.value.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '');
            // СЏРєРѕСЂСЊ = С„РёРЅР°Р»СЊРЅР°СЏ РїРѕР·РёС†РёСЏ СЂРµРґР°РєС‚РѕСЂР°, РїРµСЂРµРІРµРґС‘РЅРЅР°СЏ РІ РєРѕРѕСЂРґРёРЅР°С‚С‹
            // РєР°СЂС‚РёРЅРєРё. РќРёРєР°РєРѕРіРѕ РґРІРѕР№РЅРѕРіРѕ РјР°СЃС€С‚Р°Р±РёСЂРѕРІР°РЅРёСЏ: Рё СЂРµРґР°РєС‚РѕСЂ, Рё СЂРµРЅРґРµСЂ
            // РёСЃРїРѕР»СЊР·СѓСЋС‚ РѕРґРЅСѓ Рё С‚Сѓ Р¶Рµ РїР°СЂСѓ (scale, tx/ty).
            const anchor = s2i(
                inp._left === undefined ? baseLeft : inp._left,
                inp._top === undefined ? baseTop : inp._top
            );
            inp.remove();
            if (textInput === inp) textInput = null;

            if (keep && value.trim()) {
                pushAnnotation({
                    type: 'text',
                    color: penColor,
                    width: 1,
                    size: sizeInImage,        // РїРёРєСЃРµР»Рё РєР°СЂС‚РёРЅРєРё в†’ РјР°СЃС€С‚Р°Р±РёСЂСѓРµС‚СЃСЏ РІРјРµСЃС‚Рµ СЃ РЅРµР№
                    lh: lineHeight / scale,   // СЂРѕРІРЅРѕ С‚РѕС‚ Р¶Рµ РјРµР¶СЃС‚СЂРѕС‡РЅС‹Р№ С€Р°Рі
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
        // Enter/Esc РѕР±СЂР°Р±Р°С‚С‹РІР°РµС‚ РЅР°С€ capture-С…РµРЅРґР»РµСЂ РЅР° document; Р·РґРµСЃСЊ С‚РѕР»СЊРєРѕ
        // РЅРµ РґР°С‘Рј РѕСЃС‚Р°Р»СЊРЅС‹Рј РєР»Р°РІРёС€Р°Рј РґРѕР№С‚Рё РґРѕ С…РѕС‚РєРµРµРІ СЃР°Р№С‚Р°
        inp.addEventListener('keydown', (e) => { e.stopPropagation(); });
        inp.addEventListener('mousedown', (e) => e.stopPropagation());
        inp.addEventListener('pointerdown', (e) => e.stopPropagation());
        inp.addEventListener('click', (e) => e.stopPropagation());
        inp.addEventListener('dblclick', (e) => e.stopPropagation());
        inp.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

        viewEl.appendChild(inp);
        autosize();
        try { inp.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
    }

    function textScreenSize() {
        return clamp(14 + penWidth * 2, 12, 96);
    }

    function commitText(keep) {
        if (!textInput) return;
        if (typeof textInput._finish === 'function') textInput._finish(keep !== false);
    }

    // --- РњС‹С€СЊ ---------------------------------------------------------------
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
        if (e.target !== drawEl && e.target !== viewEl) return; // РєР»РёРєРё РїРѕ РїРѕР»СЋ С‚РµРєСЃС‚Р° Рё С‚.Рї.
        if (helpVisible()) { toggleHelp(false); return; }

        // РєР»РёРє РїРѕ РєР°СЂС‚РёРЅРєРµ РїСЂРё РѕС‚РєСЂС‹С‚РѕРј СЂРµРґР°РєС‚РѕСЂРµ = В«РіРѕС‚РѕРІРѕВ»,
        // Р±РµР· РѕРґРЅРѕРІСЂРµРјРµРЅРЅРѕРіРѕ СЃС‚Р°СЂС‚Р° РїР°РЅРѕСЂР°РјС‹/С€С‚СЂРёС…Р°
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

        if (currentTool === 'move') {
            e.preventDefault();
            beginPan(e.clientX, e.clientY);
            if (viewEl) viewEl.style.cursor = 'grabbing';
            return;
        }

        e.preventDefault();
        e.stopPropagation();
        const r = getViewRect();
        beginStroke(e.clientX - r.left, e.clientY - r.top);
    }

    function onMouseMove(e) {
        if (!win) return;

        if (drawing && inProgress) {
            const r = getViewRect();
            updateStroke(e.clientX - r.left, e.clientY - r.top, e.shiftKey, e.altKey);
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

    function onMouseUp() {
        if (drawing) {
            endStroke(false);
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
        // РЅР°С‚РёРІРЅРѕРµ РјРµРЅСЋ РЅСѓР¶РЅРѕ (РљРѕРїРёСЂРѕРІР°С‚СЊ/РЎРѕС…СЂР°РЅРёС‚СЊ РёР·РѕР±СЂР°Р¶РµРЅРёРµ),
        // РЅРѕ РЅРµР·Р°РІРµСЂС€С‘РЅРЅС‹Р№ С€С‚СЂРёС… РЅР°РґРѕ СЃР±СЂРѕСЃРёС‚СЊ
        if (drawing) endStroke(true);
        if (e.target !== drawEl && e.target !== viewEl) return;
    }

    function onOutsideClick(e) {
        if (!win) return;
        if (win.contains(e.target)) return;
        closeWindow();
    }

    function onPageScroll() {
        viewRect = null;
    }

    // --- РљР°СЃР°РЅРёСЏ ------------------------------------------------------------
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
                // С‚Р°Рї РїР°Р»СЊС†РµРј РїРѕ РєР°СЂС‚РёРЅРєРµ вЂ” СЃСЂР°Р·Сѓ СЂРµРґР°РєС‚РѕСЂ С‚РµРєСЃС‚Р°
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
            // РѕС‚РїСѓСЃС‚РёР»Рё РѕРґРёРЅ РїР°Р»РµС† вЂ” РїСЂРµРєСЂР°С‰Р°РµРј РїРёРЅС‡ Рё Р¶РґС‘Рј РЅРѕРІРѕРіРѕ touchstart,
            // С‡С‚РѕР±С‹ РєР°СЂС‚РёРЅРєР° РЅРµ РїСЂС‹РіРЅСѓР»Р° РїРѕРґ РѕСЃС‚Р°РІС€РёРјСЃСЏ РїР°Р»СЊС†РµРј
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

    // --- Р’СЊСЋРїРѕСЂС‚ ------------------------------------------------------------
    function onViewportChange() {
        if (!win || !viewEl) return;
        viewRect = null;

        // РµС‰С‘ РЅРё СЂР°Р·Сѓ РЅРµ РјРµСЂРёР»Рё вЂ” РїСЂРѕСЃС‚Рѕ РёРЅРёС†РёР°Р»РёР·РёСЂСѓРµРј С…РѕР»СЃС‚
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

        // СЃРѕС…СЂР°РЅСЏРµРј С‚РѕС‡РєСѓ РєР°СЂС‚РёРЅРєРё РІ С†РµРЅС‚СЂРµ РІСЊСЋРїРѕСЂС‚Р°
        tx = viewW / 2 - ix * scale;
        ty = viewH / 2 - iy * scale;
        baseValid = false;
        requestDraw();
        schedulePersist();
    }

    // --- Р­РєСЃРїРѕСЂС‚ ------------------------------------------------------------
    function checkExportable() {
        const iw = imageW(), ih = imageH();
        if (!iw || !ih) { canExport = null; return; }
        try {
            const c = document.createElement('canvas');
            c.width = 1;
            c.height = 1;
            const x = c.getContext('2d');
            x.drawImage(imgEl, 0, 0, 1, 1);
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

    const EXPORT_MAX_PIXELS = 40 * 1000 * 1000; // ~40 РњРїРёРєСЃ вЂ” РїСЂРµРґРµР» РѕРґРЅРѕРіРѕ РїРѕР»РѕС‚РЅР°

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
            x.drawImage(src, 0, 0, iw, ih);
            // Р°РЅРЅРѕС‚Р°С†РёРё С…СЂР°РЅСЏС‚СЃСЏ РІ РєРѕРѕСЂРґРёРЅР°С‚Р°С… РєР°СЂС‚РёРЅРєРё в†’ scale=1, tx=ty=0
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
        if (canExport === null) checkExportable();

        if (canExport === true) return Promise.resolve(buildExportCanvas(imgEl));

        return loadCorsImage().then((im) => {
            if (!im) return { canvas: null, reason: 'taint' };
            return buildExportCanvas(im);
        });
    }

    const TAINT_MSG = 'РР·РѕР±СЂР°Р¶РµРЅРёРµ СЃ РґСЂСѓРіРѕРіРѕ СЃР°Р№С‚Р° Р·Р°С‰РёС‰РµРЅРѕ CORS. РСЃРїРѕР»СЊР·СѓР№С‚Рµ РџРљРњ в†’ В«РљРѕРїРёСЂРѕРІР°С‚СЊ РёР·РѕР±СЂР°Р¶РµРЅРёРµВ»';

    function exportError(res) {
        if (res.reason === 'size') {
            toast('РР·РѕР±СЂР°Р¶РµРЅРёРµ СЃР»РёС€РєРѕРј Р±РѕР»СЊС€РѕРµ РґР»СЏ СЌРєСЃРїРѕСЂС‚Р°');
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
                    toast('Р‘СЂР°СѓР·РµСЂ РЅРµ РїРѕРґРґРµСЂР¶РёРІР°РµС‚ РєРѕРїРёСЂРѕРІР°РЅРёРµ РёР·РѕР±СЂР°Р¶РµРЅРёР№ вЂ” РёСЃРїРѕР»СЊР·СѓР№С‚Рµ Ctrl+S');
                    return;
                }
                return navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
                    .then(() => toast('РР·РѕР±СЂР°Р¶РµРЅРёРµ СЃРєРѕРїРёСЂРѕРІР°РЅРѕ'))
                    .catch(() => toast('РќРµ СѓРґР°Р»РѕСЃСЊ СЃРєРѕРїРёСЂРѕРІР°С‚СЊ. РџРљРњ в†’ В«РљРѕРїРёСЂРѕРІР°С‚СЊ РёР·РѕР±СЂР°Р¶РµРЅРёРµВ»'));
            }).catch(() => toast('РќРµ СѓРґР°Р»РѕСЃСЊ РїРѕРґРіРѕС‚РѕРІРёС‚СЊ РёР·РѕР±СЂР°Р¶РµРЅРёРµ'));
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
                toast('РЎРѕС…СЂР°РЅРµРЅРѕ: ' + a.download);
            }).catch(() => toast('РќРµ СѓРґР°Р»РѕСЃСЊ РїРѕРґРіРѕС‚РѕРІРёС‚СЊ С„Р°Р№Р»'));
        }).catch(() => toast(TAINT_MSG));
    }

    // --- РљР»Р°РІРёР°С‚СѓСЂР° ---------------------------------------------------------
    const TOOL_KEYS = {
        v: 'move', p: 'pen', l: 'line', a: 'arrow', r: 'rect', e: 'circle', t: 'text'
    };

    function onKeyUp(e) {
        if (e.code === 'Space' || e.key === ' ') {
            spaceDown = false;
            if (viewEl && mode !== 'pan') {
                viewEl.style.cursor = currentTool === 'move' ? 'grab' : 'crosshair';
            }
        }
    }

    function onKey(e) {
        if (!win) return;
        const target = e.target;
        const typing = isTypingTarget(target);
        const inside = inWindow(target);

        // РџРѕРєР° РѕС‚РєСЂС‹С‚ СЂРµРґР°РєС‚РѕСЂ С‚РµРєСЃС‚Р°, РёР· РіР»РѕР±Р°Р»СЊРЅС‹С… РєР»Р°РІРёС€ СЂР°Р±РѕС‚Р°СЋС‚ С‚РѕР»СЊРєРѕ
        // Esc (РѕС‚РјРµРЅР°) Рё Enter (РєРѕРјРјРёС‚) вЂ” РѕСЃС‚Р°Р»СЊРЅРѕРµ РїСЂРёРЅР°РґР»РµР¶РёС‚ СЂРµРґР°РєС‚РѕСЂСѓ,
        // РёРЅР°С‡Рµ РЅР°Р±РѕСЂ С‚РµРєСЃС‚Р° РґС‘СЂРіР°РµС‚ Р·СѓРј/РёРЅСЃС‚СЂСѓРјРµРЅС‚С‹ Рё СЃС‚СЂР°РЅРёС†Сѓ.
        if (textInput) {
            if (e.key === 'Escape' || e.key === 'Esc') {
                e.preventDefault();
                e.stopPropagation();
                commitText(false);
                return;
            }
            if (e.key === 'Enter') {
                // Shift+Enter вЂ” РїРµСЂРµРЅРѕСЃ СЃС‚СЂРѕРєРё, РѕР±С‹С‡РЅС‹Р№ Enter вЂ” РєРѕРјРјРёС‚
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
            closeWindow();
            return;
        }

        if (!inside && !overWin) return; // РЅРµ РїРµСЂРµС…РІР°С‚С‹РІР°РµРј РєР»Р°РІРёС€Рё СЃС‚СЂР°РЅРёС†С‹

        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
            const k = (e.key || '').toLowerCase();
            // Ctrl+Z / Ctrl+C / Ctrl+S РїРµСЂРµС…РІР°С‚С‹РІР°РµРј С‚РѕР»СЊРєРѕ РєРѕРіРґР° С„РѕРєСѓСЃ РІРЅСѓС‚СЂРё
            // РѕРєРЅР° РёР»Рё РєСѓСЂСЃРѕСЂ РЅР°Рґ РЅРёРј: РёРЅР°С‡Рµ Р»РѕРјР°РµРј undo Рё РєРѕРїРёСЂРѕРІР°РЅРёРµ СЃС‚СЂР°РЅРёС†С‹
            if (k === 'z' || k === 'СЏ') {
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
            if (k === 'c' || k === 'СЃ') {
                if (typing || !inside) return;
                e.preventDefault();
                e.stopPropagation();
                copyToClipboard();
                return;
            }
            if (k === 's' || k === 'С‹') {
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

        if (e.key === '?') {
            e.preventDefault();
            toggleHelp();
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
        if (TOOL_KEYS[key]) {
            e.preventDefault();
            setTool(TOOL_KEYS[key]);
        }
    }

    // --- Р—Р°РєСЂС‹С‚РёРµ -----------------------------------------------------------
    function closeWindow() {
        if (!win) return;

        persistNow();

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
    }

    // --- РЈРІРµРґРѕРјР»РµРЅРёРµ --------------------------------------------------------
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
