# Image Magnifier

> A Tampermonkey userscript that opens any image in a floating zoom window with a double Ctrl press.
> Pan, zoom, resize the window, and annotate images with drawing tools — pencil, line, arrow,
> rectangle, ellipse and text — then copy or save the merged result.
>
> **Author:** diple_df x claude · **Version:** 3.6.0

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

**Option A — 1-click install (recommended):**

1. Click the automatic install link: **[Install Image Magnifier](https://raw.githubusercontent.com/diple-df/Image-Magnifier/main/imgMagnifier.user.js)**
2. Tampermonkey will automatically intercept the file and open the installation prompt
3. Click **Install**

**Option B — manually:**

1. Copy the contents of `imgMagnifier.user.js`
2. Open Tampermonkey → **Create a new script**
3. Paste the code and press **Save** (`Ctrl+S`)

### Step 3 — Use It on Any Page

Navigate to any website with images. Hover over an image and press **Ctrl twice** — the magnifier window will open.

---

## How to Use

1. Hover your mouse over any image on a webpage
2. Press **Ctrl** twice quickly — the image opens in a floating window
3. **Scroll** the mouse wheel to zoom in and out (zoom anchored to the cursor position)
4. **Click and drag** inside the viewport to pan the image (or hold **Space**, or the middle button)
5. **Drag** the title bar to reposition the window
6. **Resize** the window from the bottom-right corner
7. Press **Ctrl** twice again, press **Esc**, or click outside the window to close it

---

## Features

### Zoom

Mouse wheel zooming is anchored to the cursor position — the point under your cursor stays fixed while everything else scales around it. Zoom range: 5% to 2000%. Trackpads zoom smoothly instead of jumping in coarse steps.

The current zoom level is shown in the title bar. **Click the percentage** to reset to 100% (`Ctrl+0`). Above 300% the image is drawn without smoothing, so you can inspect individual pixels.

### Toolbar buttons

| Button | Action |
|---|---|
| **%** | Click to reset zoom to 100% |
| **−** | Zoom out (centered) |
| **+** | Zoom in (centered) |
| **⊡** | Fit image to window (`Ctrl+1`) — never enlarges past 100% |
| **⧉** | Copy the annotated image to the clipboard (`Ctrl+C`) |
| **↓** | Save the annotated image as PNG (`Ctrl+S`) |
| **?** | Shortcut help overlay |
| **×** | Close the window |

### Drawing Tools

A toolbar below the title bar provides annotation tools:

| Tool | Key | Description |
|---|---|---|
| **Move** | `V` | Pan the image (default; also pan anytime with **Space** held or the middle mouse button) |
| **Pencil** | `P` | Freehand drawing |
| **Line** | `L` | Straight line |
| **Arrow** | `A` | Arrow between two points |
| **Rectangle** | `R` | Rectangle |
| **Ellipse** | `E` | Ellipse (circle when constrained) |
| **Text** | `T` | Click to place text, type, `Enter` to commit |

Modifiers while drawing:

- **Shift** — constrain to a square / circle / 45° angles
- **Alt** — draw from the center outwards

Shape tools can be filled with the fill toggle in the toolbar.

### Text Tool

1. Pick the **T** tool and click the image where the text should go
2. Type. Use **Shift+Enter** for a line break
3. **Enter** or a click on the image commits; **Esc** cancels; clicking elsewhere commits

Text is stored in image coordinates, so it stays glued to the same spot when you zoom or pan,
keeps its size relative to the picture, and lands in the exported PNG exactly where you saw it.
The text color follows the current color picker value; the font size follows the line width selector.
After committing, the tool returns to **Move** so you can pan immediately. Empty text is discarded.

### Undo / Redo

- `Ctrl+Z` — undo
- `Ctrl+Shift+Z` or `Ctrl+Y` — redo
- The trash button clears all annotations — and that is undoable too

### Export with All Layers Merged

Two ways, both produce the **original image resolution** with annotations scaled correctly:

- **Right-click** the image and choose **Copy Image** or **Save Image As…** — the canvas holds the merged result
- **`Ctrl+C`** / the copy button, **`Ctrl+S`** / the save button — export runs in the background

`Ctrl+C`/`Ctrl+S` need to read pixels. Same-origin images and most CDNs work directly;
for protected cross-origin images the script retries with a CORS request, and if that fails it tells you
to use right-click instead. Images that fail to load at all show an in-window message with a
"open in a new tab" link.

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
| Wheel | Zoom at cursor |
| `Ctrl+0` | Zoom to 100% |
| `Ctrl+1` | Fit image to window |
| `Space` (hold) | Temporary pan, any tool |
| Middle mouse | Pan |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` / `Ctrl+Y` | Redo |
| `Shift` | Constrain square / circle / 45° |
| `Alt` | Draw from center |
| `Ctrl+C` | Copy annotated image |
| `Ctrl+S` | Save annotated PNG |
| `V` `P` `L` `A` `R` `E` `T` | Select tool |
| `?` | Shortcut help |
| `Esc` | Close window / cancel text / close help |

Shortcuts never fire while you are typing in the page's own inputs, and single-key shortcuts
only respond while the pointer is over the magnifier window.

### Script Versions

| File | Script Name | Version | Status |
|---|---|---|---|
| `imgMagnifier.user.js` | Image Magnifier | 3.6.0 | Current — installable |
| `imgMagnifier.js` | Image Magnifier | 3.6.0 | Legacy mirror, identical code |

> Only the `.user.js` file is referenced by `@downloadURL`/`@updateURL`.

---
