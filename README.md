# Compositor-Level Visual Regression Testing

## The Problem: Why Traditional Pixel Comparison Fails

Traditional visual regression testing (VRT) compares screenshots pixel-by-pixel, but this approach generates false positives because the same webpage produces different pixels on different machines due to OS-specific font rendering, GPU drivers, and color profiles.

```
                          🖥️ YOUR WEB PAGE
                                 |
                                 ↓
                        [Browser Engine Starts]
                                 |
    ┌────────────────────────────┴────────────────────────────┐
    │            DETERMINISTIC RENDERING STEPS                │
    │              (Same on Every Machine)                    │
    │                                                         │
    │  1. PARSE: HTML/CSS → DOM + Style Trees                 │
    │     "Convert text to objects"                           │
    │                                                         │
    │  2. LAYOUT: Calculate positions & sizes                 │
    │     "Where does each element go?"                       │
    │     → div: {x:100px, y:50px, w:200px}                   │
    │                                                         │
    │  3. LAYER: Assign elements to layers                    │
    │     "What needs its own drawing surface?"               │
    │     → Layer 1: background                               │
    │     → Layer 2: scrolling content                        │
    │     → Layer 3: position:fixed header                    │
    │                                                         │
    │  4. PAINT: Generate draw commands                       │
    │     "List of instructions to draw"                      │
    │     → DrawRect(10, 20, 100, 50)                         │
    │     → FillText("Hello", 15, 35)                         │
    │     → SetColor(255, 0, 0)                               │
    └────────────────────────────┬────────────────────────────┘
                                 |
                          ╔══════▼══════╗
                          ║ 🎯 WE CATCH ║  ← Chrome DevTools Protocol
                          ║   IT HERE!  ║     LayerTree.makeSnapshot()
                          ╚══════╤══════╝     "Grab the instruction list"
                                 |
                 ┌───────────────┴───────────────┐
                 ↓                               ↓
      [Extract Paint Commands]          [Continue to Rasterization]
      "Save as JSON + Hash"              "Turn instructions into pixels"
                 ↓                               ↓
      SHA-256: "a7f3b2c9..."                     ↓
      ✅ SAME HASH EVERYWHERE                    ↓
    ┌────────────────────────────────────────────┴───────────────────────┐
    │             PLATFORM-SPECIFIC RENDERING STEPS                      │
    │                (Different on Each Machine)                         │
    │                                                                    │
    │  5. RASTERIZE: Convert vectors to pixels                           │
    │     "Actually draw the pixels"                                     │
    │     → Windows: DirectWrite + ClearType subpixels                   │
    │     → macOS: Core Text + Quartz smoothing                          │
    │     → Linux: FreeType + grayscale antialiasing                     │
    │                                                                    │
    │  6. COMPOSITE: Combine layers                                      │
    │     "Stack all layers together"                                    │
    │     → GPU blending, transparency, effects                          │
    │                                                                    │
    │  7. DISPLAY: Send to screen                                        │
    │     "Color space conversion + monitor output"                      │
    │     → sRGB vs Display P3 vs Adobe RGB                              │
    └────────────────────────────────────────────────────────────────────┘
                                 ↓
                          📸 SCREENSHOT/PIXELS
                        "What traditional VRT captures"
                                 ↓
    ┌────────────────────────────────────────────────────────────────────┐
    │  8. FINAL VISUAL OUTPUT - What Human Eyes See                      │
    │                                                                    │
    │  Windows:  [Submit] ← Sharp, blue-tinted subpixels                 │
    │  macOS:    [Submit] ← Smooth, warmer rendering                     │
    │  Linux:    [Submit] ← Grayscale, thinner strokes                   │
    │                                                                    │
    │  Same button, but:                                                 │
    │  • Different pixel values at edges (antialiasing)                  │
    │  • Different RGB values (color profiles)                           │
    │  • Different letter spacing (font rendering)                       │
    │  • Different button height (font metrics)                          │
    │                                                                    │
    │  Traditional VRT: Compares these pixels ❌                         │
    │  "Pixel at (45,20): RGB(51,51,51) vs RGB(48,48,48)"                │
    │  Result: FALSE POSITIVE - Test fails!                              │
    │                                                                    │
    │  Why it fails:                                                     │
    │  • 1px font shift = thousands of pixel differences                 │
    │  • Subpixel AA = every edge is different                           │
    │  • Color space = all colors slightly off                           │
    │  • GPU driver update = rendering changes                           │
    └────────────────────────────────────────────────────────────────────┘
                                 ↓
               🚫 "Comparing photos of the same recipe
                   cooked in different ovens"
```

## The Solution: Compositor-Level Interception

This project demonstrates a revolutionary approach: intercepting Chrome's rendering pipeline at the compositor level (step 4) **before** platform-specific rasterization occurs. We capture paint commands like `DrawRect(10, 20, 100, 50)` which are identical on every machine, rather than the final pixels which differ.

### Key Innovation

We intercept at the **Chrome Compositor** layer using the Chrome DevTools Protocol (CDP) to capture:
- Paint commands (DrawRect, FillText, etc.)
- Transform matrices (rotation, scale, translation)
- Layer structure
- Colors and styles

These are deterministic and produce identical SHA-256 hashes across all platforms.

## Installation

```bash
npm install
```

## Usage

### Create/Update Baseline
```bash
node capture.js
```

### Compare Against Baseline
```bash
node capture.js  # Runs comparison automatically
```

### Reset Baseline
```bash
node capture.js --reset
```

### Clean All Files
```bash
node capture.js --clean
```

## How It Works

1. **Connects to Chrome via CDP** - Direct access to browser internals
2. **Intercepts LayerTree** - Captures compositor layers before GPU rasterization
3. **Extracts Paint Commands** - Gets the actual draw instructions
4. **Creates Deterministic Hash** - SHA-256 of paint commands, not pixels
5. **Compares Hashes** - Identical commands = identical hash

## Example Paint Commands Captured

```json
{
  "method": "drawRect",
  "params": {
    "rect": { "left": 100, "top": 50, "right": 300, "bottom": 150 },
    "paint": { "color": "#FF3498DB" }
  }
},
{
  "method": "drawTextBlob",
  "params": {
    "x": 148.5,
    "y": 107,
    "paint": { "color": "#FFFFFFFF" }
  }
}
```

## Why This Works

| Aspect | Traditional VRT | Compositor Interception |
|--------|----------------|------------------------|
| **What it compares** | Final pixels | Paint instructions |
| **Cross-platform** | ❌ Different pixels per OS | ✅ Same commands everywhere |
| **Storage** | Large (PNG images) | Small (JSON) |
| **Speed** | Slow (image processing) | Fast (hash comparison) |
| **Debugging** | Visual diffs | Structural diffs |

The instruction `DrawText("Submit", 45, 20)` is identical on all machines, even though the rendered pixels differ due to:
- **Windows**: ClearType subpixel rendering
- **macOS**: Core Text with Quartz smoothing
- **Linux**: FreeType with grayscale antialiasing

## Files Generated

- `baseline.json` - Reference paint commands and hash
- `actual.json` - Current paint commands and hash

## Example Output

```
=== Compositor Paint Command Test ===

✓ Found valid baseline.json
  Baseline hash: e4967781229be3d9, 2 command logs

Capturing actual state...
Found 5 layers
Layer 10: 1 chars
Layer 11: 11 chars
✓ Actual captured: hash=e4967781229be3d9, 2 command logs

✅ Result: MATCH
  Baseline: e4967781229be3d9
  Actual:   e4967781229be3d9
```

## Requirements

- Node.js 18+
- Puppeteer 21+
- Chrome/Chromium

## Project Structure

```
├── capture.js        # Main script with CDP integration
├── test.html         # Test page with layers
├── baseline.json     # Stored reference commands
├── actual.json       # Latest captured commands
└── package.json      # Dependencies
```

## Limitations

- Only works with Chromium-based browsers
- Requires Chrome DevTools Protocol access
- Simple pages may not create compositor layers (add `will-change: transform` to force layers)

## Technical Details

The Chrome DevTools Protocol provides access to:
- `LayerTree.enable()` - Activates layer tree inspection
- `LayerTree.makeSnapshot()` - Creates snapshot of a layer
- `LayerTree.snapshotCommandLog()` - Extracts paint commands
- `LayerTree.layerTreeDidChange` - Monitors layer updates

## Contributing

This is a proof-of-concept demonstrating compositor-level visual regression testing. Areas for improvement:
- Multi-browser support (Firefox, Safari)
- Better diff visualization
- Integration with existing test frameworks
- Handling of dynamic content

## License

MIT