# Compositor-Level Visual Regression Testing

A revolutionary approach to visual regression testing that intercepts Chrome's rendering pipeline at the compositor level, capturing deterministic paint commands instead of comparing pixels.

## Table of Contents

- [The Problem](#the-problem)
- [The Solution](#the-solution)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Benchmark Results](#benchmark-results)
- [Technical Architecture](#technical-architecture)
- [API Reference](#api-reference)
- [Project Structure](#project-structure)
- [Limitations](#limitations)
- [Contributing](#contributing)

## The Problem

Traditional visual regression testing compares screenshots pixel-by-pixel, generating false positives due to platform-specific rendering differences in font rendering, GPU drivers, and color profiles.

### Why Pixel Comparison Fails

The same webpage produces different pixels on different machines:
- **Windows**: DirectWrite + ClearType subpixel rendering
- **macOS**: Core Text + Quartz smoothing  
- **Linux**: FreeType + grayscale antialiasing

Even a 1px font shift creates thousands of pixel differences, causing tests to fail despite identical visual appearance.

## The Solution

We intercept Chrome's rendering pipeline at the **compositor level** (before rasterization) using the Chrome DevTools Protocol to capture:

- **Paint commands**: `DrawRect()`, `FillText()`, `SetColor()`
- **Transform matrices**: Rotation, scale, translation
- **Layer structure**: Compositor layer tree
- **Computed styles**: Layout-affecting properties

These produce **identical SHA-256 hashes** across all platforms.

## Installation

```bash
npm install
```

## Quick Start: Compositor Interception VRT

```bash
# Run test (creates baseline on first run)
node capture-compositor.js

# Run with verbose output
node capture-compositor.js --verbose

# Reset baseline
node capture-compositor.js --reset
```

## Quick Start: Pixel Based VRT

```bash
# Run test (creates baseline on first run)
node capture-pixels.js

# Run with verbose output
node capture-pixels.js --verbose

# Reset baseline
node capture-pixels.js --reset
```

## Run Benchmarks

```bash
# Run benchmark comparison
node benchmark.js
```

## How It Works

### Rendering Pipeline Interception

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
    │  2. LAYOUT: Calculate positions & sizes                 │
    │  3. LAYER: Assign elements to layers                    │
    │  4. PAINT: Generate draw commands                       │
    └────────────────────────────┬────────────────────────────┘
                                 |
                          ╔══════▼══════╗
                          ║ 🎯 WE CATCH ║  ← Chrome DevTools Protocol
                          ║   IT HERE!  ║     LayerTree.makeSnapshot()
                          ╚══════╤══════╝
                                 |
                 ┌───────────────┴───────────────┐
                 ↓                               ↓
      [Extract Paint Commands]          [Continue to Rasterization]
      SHA-256: "a7f3b2c9..."            (Platform-specific pixels)
      ✅ SAME HASH EVERYWHERE            ❌ DIFFERENT ON EACH OS
```

### Example Paint Commands

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

## Benchmark Results

### Performance Comparison

| Metric | Compositor Method | Pixel Method | Winner |
|--------|------------------|--------------|---------|
| **Average Duration** | 2.28 seconds | 2.60 seconds | Compositor (14% faster) |
| **Success Rate** | 100% | 0% | Compositor |
| **Consistency** | Perfect | Inconsistent | Compositor |
| **Storage Size** | 1.07 MB | 2.50 MB | Compositor (2.3× smaller) |

### Why Compositor Wins

- **Zero false positives**: 100% success rate vs 0% for pixel comparison
- **Faster execution**: 14% faster on average
- **Smaller storage**: JSON commands vs PNG images
- **Perfect consistency**: Same hash across all platforms

## Technical Architecture

### Chrome DevTools Protocol Integration

```javascript
// Key CDP methods used
client.send('LayerTree.enable')           // Activate layer inspection
client.send('LayerTree.makeSnapshot')     // Create layer snapshot
client.send('LayerTree.snapshotCommandLog') // Extract paint commands
```

### Files Generated

```
├── baseline.json         # Reference paint commands & hash
├── actual.json          # Current paint commands & hash
├── compositor-images/   # Optional visual references
│   ├── baseline.png
│   └── actual.png
└── benchmark-results.json # Performance comparison data
```

## API Reference

### Main Scripts

#### `capture-compositor.js`

Main compositor interception script.

**Options:**
- `--verbose, -v` - Show detailed output
- `--reset, -r` - Reset baseline
- `--clean` - Remove all generated files
- `--help, -h` - Display help

#### `capture-pixels.js`

Traditional pixel comparison (for benchmarking).

**Options:**
- `--verbose, -v` - Show detailed output
- `--reset, -r` - Reset baseline images
- `--clean` - Remove all image folders

#### `benchmark.js`

Runs performance comparison between both methods.

## Project Structure

```
compositor-vrt/
├── capture-compositor.js    # Compositor interception script
├── capture-pixels.js        # Pixel comparison script
├── benchmark.js            # Performance comparison
├── test.html              # Simple test page
├── complex-test.html      # Complex test page with layers
├── baseline.json          # Baseline paint commands
├── actual.json           # Current paint commands
├── compositor-images/    # Visual references (optional)
├── baseline-images/      # Pixel comparison baselines
├── actual-images/        # Pixel comparison actuals
├── diff-images/         # Pixel comparison diffs
└── package.json         # Dependencies
```

## Limitations

- **Browser Support**: Only Chromium-based browsers (Chrome, Edge, Brave)
- **Protocol Dependency**: Requires Chrome DevTools Protocol access
- **Layer Creation**: Simple pages may not create compositor layers
  - Add `will-change: transform` to force layer creation
  - Use `transform: translateZ(0)` as alternative

## Contributing

Areas for improvement:

1. **Multi-browser Support**: Firefox Marionette, Safari WebDriver
2. **Diff Visualization**: Better UI for viewing command differences
3. **CI Integration**: GitHub Actions, Jenkins plugins
4. **Framework Integration**: Jest, Mocha, Playwright adapters

## License

MIT
