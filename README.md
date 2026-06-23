# Image Magnifier

> A Tampermonkey userscript that opens any image in a floating zoom window with a double Ctrl press.  
> Pan, zoom, resize the window, and annotate images with drawing tools — pencil, arrow, line, and rectangle.
>
> **Author:** diple_df x claude

<img width="1920" height="1002" alt="image" src="https://github.com/user-attachments/assets/b0d8290d-10ed-4e5c-9b46-43765eacfb5a" />


## Installation

### Step 1 — Install a Userscript Manager

The script requires a browser extension to run. Supported managers:

| Extension | Chrome | Firefox | Edge |
|---|---|---|---|
| **Tampermonkey** (recommended) | ✓ | ✓ | ✓ |
| Violentmonkey | ✓ | ✓ | ✓ |
| Greasemonkey | — | ✓ | — |

Install the extension from your browser's official add-on store.

### Step 2 — Install the Script

**Option A — via GitHub Raw link (easiest):**

1. Open `imgMagnifier.js` on GitHub
2. Click the **Raw** button
3. Tampermonkey will automatically detect the script and prompt you to install it
4. Click **Install**

**Option B — manually:**

1. Copy the contents of `imgMagnifier.js`
2. Open Tampermonkey → **Create a new script**
3. Paste the code and press **Save** (`Ctrl+S`)

### Step 3 — Use It on Any Page

Navigate to any website with images. Hover over an image and press **Ctrl twice** — the magnifier window will open.

---

## How to Use

1. Hover your mouse over any image on a webpage
2. Press **Ctrl** twice quickly — the image opens in a floating window
3. **Scroll** the mouse wheel to zoom in and out (zoom anchored to the cursor position)
4. **Click and drag** inside the viewport to pan the image
5. **Drag** the title bar to reposition the window
6. **Resize** the window from the bottom-right corner
7. Press **Ctrl** twice again, press **Esc**, or click outside the window to close it

---

## Features

### Zoom

Mouse wheel zooming is anchored to the cursor position — the point under your cursor stays fixed while everything else scales around it. Zoom range: 5% to 2000%.

The current zoom level is shown in the title bar.

### Toolbar buttons

| Button | Action |
|---|---|
| **−** | Zoom out (centered) |
| **+** | Zoom in (centered) |
| **⊡** | Fit image to window |
| **×** | Close the window |

### Drawing Tools

A toolbar below the title bar provides annotation tools:

| Tool | Description |
|---|---|
| **Move** | Pan the image (default mode) |
| **Pencil** | Freehand drawing |
| **Arrow** | Draw an arrow between two points |
| **Line** | Draw a straight line |
| **Rectangle** | Draw a rectangle |

Use the **color picker** to change the stroke color and the **width selector** to set the line thickness (2 / 4 / 6 / 10 / 16 px).

- **Undo** (`Ctrl+Z`) — remove the last annotation
- **Clear all** (trash icon) — remove all annotations

Annotations are drawn on a transparent canvas on top of the image and follow it as you pan and zoom.

### Image Resolution

When an `<img>` element has a `srcset` attribute, the script picks the highest-resolution source available, so you always see the best quality version.

Background images set via CSS `background-image` are also detected.

### Shadow DOM Support

The image lookup pierces shadow DOM roots (used by YouTube, web components, etc.), so images hidden inside custom elements are found correctly.

### Closing the Window

The window can be closed by:
- Pressing **Esc**
- Pressing **Ctrl** twice again
- Clicking anywhere outside the window

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Ctrl` × 2 | Open / close the magnifier |
| `Ctrl+Z` | Undo last annotation |
| `Esc` | Close the window |



### Compatibility

The script runs on all pages (`*://*/*`) and works at `document-start` to ensure early event capture. It does not interfere with the page's own keyboard and mouse handlers — all events are handled in the capture phase and propagation is stopped only when a magnifier window is open.

### Script Versions

| File | Script Name | Version | Status |
|---|---|---|---|
| `imgMagnifier.js` | Image Magnifier | 3.4.0 | Current |

---
