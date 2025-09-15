import puppeteer from 'puppeteer'
import fs from 'fs'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import sharp from 'sharp'

// Parse command line arguments
const args = process.argv.slice(2)
const verbose = args.includes('--verbose') || args.includes('-v')
const log = verbose ? console.log : () => {}

// Configuration
const config = {
  baselineFolder: `${process.cwd()}/baseline-images`,
  actualFolder: `${process.cwd()}/actual-images`,
  diffFolder: `${process.cwd()}/diff-images`,
  threshold: 0.0, // 0 = exact match, 0.1 = 10% tolerance
  includeAA: true // Include anti-aliasing
}

let browser = null

async function captureScreenshot (url) {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox']
    })
  }

  const page = await browser.newPage()

  // Set consistent viewport
  await page.setViewport({
    width: 1280,
    height: 720,
    deviceScaleFactor: 1
  })

  // Navigate and wait for page to be ready
  await page.goto(url, { waitUntil: 'networkidle0' })

  // Take screenshot
  const screenshot = await page.screenshot({
    fullPage: true,
    type: 'png'
  })

  await page.close()

  return screenshot
}

async function matchImageSnapshot ({
  imageData,
  snapshotName,
  baselineFolder,
  actualFolder,
  diffFolder
}) {
  const baselineScreenshotPath = `${baselineFolder}/${snapshotName}`
  const actualScreenshotPath = `${actualFolder}/${snapshotName}`
  const diffScreenshotPath = `${diffFolder}/${snapshotName}`
  const resizedActualScreenshotPath = `${actualFolder}/resize-${snapshotName}`

  let baseLineImage = null
  let actualImage = null
  let diffPercentage = 0
  let resizedActualImage = null

  // Create directories if they don't exist
  fs.mkdirSync(baselineFolder, { recursive: true })
  fs.mkdirSync(actualFolder, { recursive: true })
  fs.mkdirSync(diffFolder, { recursive: true })

  const baselineScreenshotExists = fs.existsSync(baselineScreenshotPath)

  // Save image to appropriate folder
  fs.writeFileSync(
    baselineScreenshotExists ? actualScreenshotPath : baselineScreenshotPath,
    imageData
  )

  if (baselineScreenshotExists) {
    try {
      baseLineImage = PNG.sync.read(fs.readFileSync(baselineScreenshotPath))
    } catch (e) {
      if (verbose) console.error('Error reading baseline:', e.message)
    }

    try {
      actualImage = PNG.sync.read(fs.readFileSync(actualScreenshotPath))
    } catch (e) {
      if (verbose) console.error('Error reading actual:', e.message)
    }

    if (!baseLineImage?.data || !actualImage?.data) return null

    const { width: baseLineWidth, height: baseLineHeight } = baseLineImage

    // If images size don't match, resize actual image to match baseline
    if (!imagesHaveSameSize(baseLineImage, actualImage)) {
      log('  Images have different sizes, resizing...')
      await sharp(actualScreenshotPath)
        .resize({ height: baseLineHeight, width: baseLineWidth })
        .toFile(resizedActualScreenshotPath)
      resizedActualImage = PNG.sync.read(fs.readFileSync(resizedActualScreenshotPath))
    }

    const diff = new PNG({ width: baseLineWidth, height: baseLineHeight })

    // Perform pixel comparison
    const mismatchedPixels = pixelmatch(
      baseLineImage.data,
      (resizedActualImage || actualImage).data,
      diff.data,
      baseLineWidth,
      baseLineHeight,
      {
        threshold: config.threshold,
        diffColorAlt: [255, 0, 0],
        includeAA: config.includeAA
      }
    )

    // Calculate diff percentage
    const totalPixels = baseLineWidth * baseLineHeight
    diffPercentage = (mismatchedPixels / totalPixels) * 100

    // Clean up resized image
    if (resizedActualImage?.data) {
      try {
        fs.unlinkSync(resizedActualScreenshotPath)
      } catch (e) {}
    }

    if (mismatchedPixels === 0) {
      // Delete diff image if test passes
      try {
        fs.unlinkSync(diffScreenshotPath)
      } catch (e) {}
    } else {
      // Save diff image
      try {
        fs.writeFileSync(diffScreenshotPath, PNG.sync.write(diff))
      } catch (e) {}
    }

    return {
      match: mismatchedPixels === 0,
      diffPercentage: diffPercentage.toFixed(2),
      mismatchedPixels,
      totalPixels
    }
  }

  // No baseline exists, this is the first run
  return {
    match: true,
    firstRun: true
  }
}

function imagesHaveSameSize (firstImage, secondImage) {
  if (!firstImage || !secondImage) return null
  return firstImage.height === secondImage.height && firstImage.width === secondImage.width
}

async function comparePages () {
  console.log('=== Pixel-Based Visual Regression Test ===\n')

  const testFile = 'file://' + process.cwd() + '/fixtures/test.html'
  const snapshotName = 'test-page.png'

  // Capture screenshot
  log('Capturing screenshot...')
  const screenshot = await captureScreenshot(testFile)

  // Compare with baseline
  log('Comparing with baseline...')
  const result = await matchImageSnapshot({
    imageData: screenshot,
    snapshotName,
    baselineFolder: config.baselineFolder,
    actualFolder: config.actualFolder,
    diffFolder: config.diffFolder
  })

  // Display results - always show the main result
  if (result.firstRun) {
    console.log('✅ Baseline created')
    log(`  Saved to: ${config.baselineFolder}/${snapshotName}`)
  } else if (result.match) {
    console.log('✅ Visual test PASSED')
    log('  Images are identical')
  } else {
    console.log('❌ Visual test FAILED')
    console.log(`Difference: ${result.diffPercentage}%`)
    log(`  Mismatched pixels: ${result.mismatchedPixels} / ${result.totalPixels}`)
    log(`  Diff saved to: ${config.diffFolder}/${snapshotName}`)
  }

  // Close browser at the end
  if (browser) {
    await browser.close()
    browser = null
  }

  // Return result for benchmarking
  return {
    method: 'pixel-comparison',
    match: result.match,
    diffPercentage: result.diffPercentage || 0
  }
}

// Handle command line arguments
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node capture-pixels.js [options]

Options:
  --verbose, -v    Show detailed output
  --reset, -r      Reset baseline images
  --clean          Clean all image folders
  --help, -h       Show this help

By default runs in silent mode (minimal output).
	`)
  process.exit(0)
} else if (args.includes('--reset') || args.includes('-r')) {
  console.log('Resetting baseline images...')
  try {
    fs.rmSync(config.baselineFolder, { recursive: true, force: true })
    console.log('✓ Baseline images deleted. Will create new ones on next run.')
  } catch (e) {
    console.log('No baseline images to reset.')
  }
  try {
    fs.rmSync(config.actualFolder, { recursive: true, force: true })
    fs.rmSync(config.diffFolder, { recursive: true, force: true })
    console.log('✓ Actual and diff images deleted.')
  } catch (e) {}
} else if (args.includes('--clean')) {
  console.log('Cleaning all image folders...')
  ;[config.baselineFolder, config.actualFolder, config.diffFolder].forEach(folder => {
    try {
      fs.rmSync(folder, { recursive: true, force: true })
      console.log(`✓ Deleted ${folder}`)
    } catch (e) {}
  })
  console.log('Run again to create fresh baseline.')
} else {
  // Run the test
  comparePages().catch(console.error)
}

export { comparePages }
