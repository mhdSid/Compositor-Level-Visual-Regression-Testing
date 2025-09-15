import puppeteer from 'puppeteer'
import crypto from 'crypto'
import fs from 'fs'

// Parse command line arguments
const args = process.argv.slice(2)
const verbose = args.includes('--verbose') || args.includes('-v')
const log = verbose ? console.log : () => {}

let browser = null

async function captureScreenshot (page, filename) {
  const screenshot = await page.screenshot({
    fullPage: true,
    type: 'png'
  })

  // Create images directory if it doesn't exist
  const imagesDir = './compositor-images'
  fs.mkdirSync(imagesDir, { recursive: true })

  // Save the screenshot
  fs.writeFileSync(`${imagesDir}/${filename}`, screenshot)
  log(`Screenshot saved: ${imagesDir}/${filename}`)

  return screenshot
}

async function extractPaintCommands (url, captureImage = false, imageName = null) {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--disable-gpu-rasterization', '--no-sandbox']
    })
  }
  const page = await browser.newPage()

  // Navigate FIRST
  await page.goto(url, { waitUntil: 'networkidle0' })

  // Capture screenshot if requested
  let screenshotBuffer = null
  if (captureImage && imageName) {
    screenshotBuffer = await captureScreenshot(page, imageName)
  }

  // Get CDP session AFTER navigation
  const client = await page.target().createCDPSession()

  // Enable required domains
  await client.send('DOM.enable')
  await client.send('LayerTree.enable')

  // Force a paint
  await page.evaluate(() => {
    document.body.style.transform = 'translateZ(0)'
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    document.body.offsetHeight
  })

  // Get the document root to find layers
  const { root } = await client.send('DOM.getDocument')

  // Get all layers by listening to layer tree updates
  const layers = []
  const layerPromise = new Promise(resolve => {
    client.once('LayerTree.layerTreeDidChange', (params) => {
      if (params.layers) {
        resolve(params.layers)
      }
    })
  })

  // Trigger layer tree update
  await page.evaluate(() => {
    window.scrollBy(0, 1)
    window.scrollBy(0, -1)
  })

  // Wait for layers with timeout
  const detectedLayers = await Promise.race([
    layerPromise,
    new Promise(resolve => setTimeout(() => resolve([]), 1000))
  ])

  layers.push(...detectedLayers)

  log(`Found ${layers.length} layers`)

  // Extract paint commands from each layer
  const allCommands = []

  for (const layer of layers) {
    try {
      // Make snapshot of this layer
      const { snapshotId } = await client.send('LayerTree.makeSnapshot', {
        layerId: layer.layerId
      })

      // Get the actual paint commands
      const { commandLog } = await client.send('LayerTree.snapshotCommandLog', {
        snapshotId
      })

      if (commandLog) {
        allCommands.push(commandLog)
        log(`Layer ${layer.layerId}: ${commandLog.length} chars`)

        // Parse and show what kind of commands we got
        if (verbose) {
          try {
            const commands = JSON.parse(commandLog)
            if (Array.isArray(commands) && commands.length > 0) {
              log(`  Contains ${commands.length} paint operations`)
            }
          } catch (e) {
            // commandLog might not be JSON
          }
        }
      }

      // Release snapshot
      await client.send('LayerTree.releaseSnapshot', {
        snapshotId
      })
    } catch (e) {
      log(`Layer ${layer.layerId}: Could not snapshot (${e.message})`)
    }
  }

  // If no layers found, try the document's root layer
  if (allCommands.length === 0) {
    log('Trying root layer approach...')
    try {
      // Create a snapshot of the entire page
      const { snapshotId } = await client.send('LayerTree.makeSnapshot', {
        layerId: 'document'
      })

      const { commandLog } = await client.send('LayerTree.snapshotCommandLog', {
        snapshotId
      })

      if (commandLog) {
        allCommands.push(commandLog)
        log(`Root snapshot: ${commandLog.length} chars`)
      }

      await client.send('LayerTree.releaseSnapshot', {
        snapshotId
      })
    } catch (e) {
      log('Root layer snapshot failed:', e.message)
    }
  }

  if (allCommands.length === 0) {
    log('⚠️  No paint commands captured - layers might not be accessible')
    log('This can happen with simple pages that don\'t create separate layers')
  }

  await page.close()

  // Create hash from paint commands
  const commandsString = JSON.stringify(allCommands)
  const hash = crypto.createHash('sha256').update(commandsString).digest('hex')

  return {
    commands: allCommands,
    hash: hash.substring(0, 16),
    count: allCommands.length,
    screenshot: screenshotBuffer
  }
}

async function loadExistingCommands (filename) {
  try {
    const data = fs.readFileSync(filename, 'utf8')
    const parsed = JSON.parse(data)

    return {
      commands: parsed.commands,
      hash: parsed.hash,
      count: parsed.count,
      imagePath: parsed.imagePath
    }
  } catch (e) {
    return null
  }
}

async function comparePages () {
  console.log('=== Compositor Paint Command Test ===\n')

  // Check if baseline exists AND is valid
  let baseline = await loadExistingCommands('baseline.json')

  if (baseline && baseline.hash && baseline.count > 0) {
    log('✓ Found valid baseline.json')
    log(`  Baseline hash: ${baseline.hash}, ${baseline.count} command logs`)
    if (baseline.imagePath) {
      log(`  Image: ${baseline.imagePath}`)
    }
  } else {
    // Either doesn't exist or is invalid - create new baseline
    log('No valid baseline found. Creating new baseline...')
    baseline = await extractPaintCommands(
      'file://' + process.cwd() + '/fixtures/test.html',
      true, // captureImage
      'baseline.png' // imageName
    )

    // Save the FULL object structure, not just commands
    fs.writeFileSync(`${process.cwd()}/baseline.json`, JSON.stringify({
      commands: baseline.commands,
      hash: baseline.hash,
      count: baseline.count,
      imagePath: `${process.cwd()}/compositor-images/baseline.png`,
      timestamp: new Date().toISOString()
    }, null, 2))
    log(`✓ Baseline created: hash=${baseline.hash}, ${baseline.count} command logs`)
  }

  // Always capture fresh actual with image
  log('\nCapturing actual state...')
  const actual = await extractPaintCommands(
    'file://' + process.cwd() + '/fixtures/test.html',
    true, // captureImage
    'actual.png' // imageName
  )

  // Save the FULL object structure
  fs.writeFileSync('actual.json', JSON.stringify({
    commands: actual.commands,
    hash: actual.hash,
    count: actual.count,
    imagePath: './compositor-images/actual.png',
    timestamp: new Date().toISOString()
  }, null, 2))
  log(`✓ Actual captured: hash=${actual.hash}, ${actual.count} command logs`)

  // Compare
  const identical = baseline.hash === actual.hash

  // Always show the result
  console.log(`${identical ? '✅' : '❌'} Result: ${identical ? 'MATCH' : 'MISMATCH'}`)
  console.log(`Baseline: ${baseline.hash}`)
  console.log(`Actual:   ${actual.hash}`)

  if (identical) {
    console.log('Images: ./compositor-images/[baseline.png, actual.png]')
  }

  if (!identical && baseline.count > 0 && actual.count > 0) {
    console.log('\n⚠️  Visual regression detected!')
    console.log('  Check images: ./compositor-images/[baseline.png, actual.png]')
    console.log('  Check JSON: baseline.json and actual.json for differences')

    // Try to show where they differ
    if (baseline.commands.length !== actual.commands.length) {
      log(`  Different number of layers: ${baseline.commands.length} vs ${actual.commands.length}`)
    } else {
      for (let i = 0; i < baseline.commands.length; i++) {
        if (baseline.commands[i] !== actual.commands[i]) {
          log(`  Layer ${i} differs`)
          break
        }
      }
    }
  }

  // Close browser at the end
  if (browser) {
    await browser.close()
    browser = null
  }
}

// Handle command line arguments
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node capture-compositor.js [options]

Options:
  --verbose, -v    Show detailed output
  --reset, -r      Reset baseline
  --clean          Clean all files and images
  --help, -h       Show this help

By default runs in silent mode (minimal output).
Images are saved to ./compositor-images/
	`)
  process.exit(0)
} else if (args.includes('--reset') || args.includes('-r')) {
  console.log('Resetting baseline...')
  try {
    fs.unlinkSync('baseline.json')
    console.log('✓ Baseline deleted. Will create new one on next run.')
  } catch (e) {
    console.log('No baseline to reset.')
  }
  try {
    fs.unlinkSync('actual.json')
    console.log('✓ Actual deleted.')
  } catch (e) {
    // No actual to delete
  }
  try {
    fs.unlinkSync('./compositor-images/baseline.png')
    fs.unlinkSync('./compositor-images/actual.png')
    console.log('✓ Images deleted.')
  } catch (e) {
    // No images to delete
  }
} else if (args.includes('--clean')) {
  console.log('Cleaning all files...')
  const files = ['baseline.json', 'actual.json']
  files.forEach(file => {
    try {
      fs.unlinkSync(file)
      console.log(`✓ Deleted ${file}`)
    } catch (e) {
      // File doesn't exist
    }
  })

  // Clean images directory
  try {
    fs.rmSync('./compositor-images', { recursive: true, force: true })
    console.log('✓ Deleted compositor-images directory')
  } catch (e) {
    // Directory doesn't exist
  }

  console.log('Run again to create fresh baseline.')
} else {
  // Run the test
  comparePages().catch(console.error)
}
