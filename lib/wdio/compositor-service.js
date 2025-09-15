import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export class CompositorService {
  constructor (options) {
    this.options = {
      baselineDir: './baseline-data',
      actualDir: './actual-data',
      diffDir: './diff-images',
      updateBaseline: false,
      ...options
    }

    // Create directories if they don't exist
    this.ensureDir(this.options.baselineDir)
    this.ensureDir(this.options.actualDir)
    this.ensureDir(this.options.diffDir)
  }

  async before (capabilities, specs, browser) {
    // Attach compositor methods to browser object
    browser.compositor = {
      capture: this.captureCompositorData.bind(this, browser),
      compare: this.compareCompositorData.bind(this, browser),
      capturePixels: this.capturePixelData.bind(this, browser),
      comparePixels: this.comparePixelData.bind(this, browser)
    }
  }

  async captureCompositorData (browser, name) {
    try {
      // Get Puppeteer instance from WebdriverIO
      const puppeteer = await browser.getPuppeteer()
      const pages = await puppeteer.pages()
      const page = pages[0]

      // Create CDP session AFTER page is loaded (critical!)
      const client = await page.target().createCDPSession()

      // Enable required domains
      await client.send('DOM.enable')
      await client.send('LayerTree.enable')

      // Force a paint cycle
      await page.evaluate(() => {
        document.body.style.transform = 'translateZ(0)'
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        document.body.offsetHeight
        document.body.style.transform = ''
      })

      // Get the document root
      const { root } = await client.send('DOM.getDocument')

      // Set up layer listener
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
      console.log(`Found ${layers.length} layers`)

      // Extract paint commands from each layer
      const allCommands = []

      for (const layer of layers) {
        try {
          // Make snapshot of this layer
          const { snapshotId } = await client.send('LayerTree.makeSnapshot', {
            layerId: layer.layerId
          })

          // Get the actual paint commands
          const result = await client.send('LayerTree.snapshotCommandLog', {
            snapshotId
          })

          // commandLog could be a string OR an object/array
          const commandLog = result.commandLog

          if (commandLog) {
            console.log(`Layer ${layer.layerId} commandLog type: ${typeof commandLog}`)

            // Handle both string and object/array cases
            let commands = null
            if (typeof commandLog === 'string') {
              try {
                commands = JSON.parse(commandLog)
                console.log(`Layer ${layer.layerId} parsed from string: ${commands.length} commands`)
              } catch (e) {
                console.log(`Layer ${layer.layerId} parse error: ${e.message}`)
              }
            } else if (Array.isArray(commandLog)) {
              commands = commandLog
              console.log(`Layer ${layer.layerId} already an array: ${commands.length} commands`)
            } else if (typeof commandLog === 'object') {
              // It might be an object with commands inside
              console.log(`Layer ${layer.layerId} is object, keys:`, Object.keys(commandLog))
              // Try to extract commands if they're nested
              if (commandLog.commands) {
                commands = commandLog.commands
              } else {
                // Treat the object itself as a single command
                commands = [commandLog]
              }
            }

            if (commands && Array.isArray(commands) && commands.length > 0) {
              console.log(`Layer ${layer.layerId} first command:`, JSON.stringify(commands[0]).substring(0, 100))
              allCommands.push(...commands)
            }
          }

          // Release snapshot
          await client.send('LayerTree.releaseSnapshot', {
            snapshotId
          })
        } catch (e) {
          console.log(`Layer ${layer.layerId}: Could not snapshot (${e.message})`)
        }
      }

      console.log(`Total raw commands collected: ${allCommands.length}`)
      if (allCommands.length > 0) {
        console.log('First raw command:', JSON.stringify(allCommands[0]))
      }

      // Process the commands
      const processedCommands = allCommands.map((cmd) => {
        const processed = {
          method: cmd.method || cmd.cmd || cmd.name || 'unknown',
          params: {}
        }

        if (cmd.params) {
          const skipProps = ['textBlob', 'font', 'imageId']
          for (const [key, value] of Object.entries(cmd.params)) {
            if (!skipProps.includes(key)) {
              processed.params[key] = value
            }
          }
        }

        return processed
      })

      console.log(`Processed commands count: ${processedCommands.length}`)

      // Generate hash
      const commandsString = JSON.stringify(processedCommands)
      const hash = crypto.createHash('sha256').update(commandsString).digest('hex').substring(0, 16)

      console.log(`Final: Captured ${processedCommands.length} paint commands, hash: ${hash}`)

      const data = {
        name,
        timestamp: new Date().toISOString(),
        hash,
        layerCount: layers.length,
        commands: processedCommands,
        metadata: {
          url: await browser.getUrl(),
          viewport: await browser.getWindowSize(),
          userAgent: await browser.execute(() => navigator.userAgent)
        }
      }

      const dir = this.options.updateBaseline ? this.options.baselineDir : this.options.actualDir
      const filePath = path.join(dir, `${name}.json`)
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2))

      return data
    } catch (error) {
      console.error('Error in captureCompositorData:', error)

      const data = {
        name,
        timestamp: new Date().toISOString(),
        hash: 'error-' + Date.now(),
        layerCount: 0,
        commands: [],
        error: error.message,
        metadata: {
          url: await browser.getUrl(),
          viewport: await browser.getWindowSize(),
          userAgent: await browser.execute(() => navigator.userAgent)
        }
      }

      const dir = this.options.updateBaseline ? this.options.baselineDir : this.options.actualDir
      const filePath = path.join(dir, `${name}.json`)
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2))

      return data
    }
  }

  async compareCompositorData (browser, name) {
    const baselinePath = path.join(this.options.baselineDir, `${name}.json`)
    const actualPath = path.join(this.options.actualDir, `${name}.json`)

    // Check if baseline exists
    if (!fs.existsSync(baselinePath)) {
      // Create baseline
      const data = await this.captureCompositorData(browser, name)
      fs.writeFileSync(baselinePath, JSON.stringify(data, null, 2))
      return {
        status: 'created',
        message: 'Baseline created',
        hash: data.hash
      }
    }

    // Capture current state
    const actualData = await this.captureCompositorData(browser, name)

    // Load baseline
    const baselineData = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))

    // Compare hashes
    const match = baselineData.hash === actualData.hash

    // Generate diff if needed
    let diff = null
    if (!match) {
      diff = this.generateDiff(baselineData.commands, actualData.commands)
    }

    return {
      status: match ? 'match' : 'mismatch',
      baseline: baselineData.hash,
      actual: actualData.hash,
      match,
      diff,
      layerCount: {
        baseline: baselineData.layerCount,
        actual: actualData.layerCount
      }
    }
  }

  async capturePixelData (browser, name) {
    const screenshot = await browser.takeScreenshot()
    const dir = this.options.updateBaseline ? this.options.baselineDir : this.options.actualDir
    const filePath = path.join(dir, `${name}.png`)

    fs.writeFileSync(filePath, screenshot, 'base64')

    return {
      path: filePath,
      size: Buffer.from(screenshot, 'base64').length
    }
  }

  async comparePixelData (browser, name) {
    const baselinePath = path.join(this.options.baselineDir, `${name}.png`)
    const actualPath = path.join(this.options.actualDir, `${name}.png`)

    if (!fs.existsSync(baselinePath)) {
      const data = await this.capturePixelData(browser, name)
      fs.copyFileSync(data.path, baselinePath)
      return {
        status: 'created',
        message: 'Baseline created'
      }
    }

    await this.capturePixelData(browser, name)

    // Use pixelmatch for comparison
    const PNG = (await import('pngjs')).PNG
    const pixelmatch = (await import('pixelmatch')).default

    const baseline = PNG.sync.read(fs.readFileSync(baselinePath))
    const actual = PNG.sync.read(fs.readFileSync(actualPath))
    const { width, height } = baseline
    const diff = new PNG({ width, height })

    const mismatchedPixels = pixelmatch(
      baseline.data,
      actual.data,
      diff.data,
      width,
      height,
      { threshold: 0.1 }
    )

    const totalPixels = width * height
    const diffPercentage = (mismatchedPixels / totalPixels) * 100

    if (mismatchedPixels > 0) {
      const diffPath = path.join(this.options.diffDir, `${name}-diff.png`)
      fs.writeFileSync(diffPath, PNG.sync.write(diff))
    }

    return {
      status: mismatchedPixels === 0 ? 'match' : 'mismatch',
      mismatchedPixels,
      totalPixels,
      diffPercentage: diffPercentage.toFixed(2),
      match: mismatchedPixels === 0
    }
  }

  processCommands (commandLog) {
    // Parse and normalize commands
    const commands = JSON.parse(commandLog)

    return commands.map(cmd => {
      // Extract essential properties, ignore platform-specific ones
      const processed = {
        method: cmd.method,
        params: {}
      }

      // Copy relevant parameters
      if (cmd.params) {
        // Filter out non-deterministic properties
        const skipProps = ['textBlob', 'font', 'imageId']

        for (const [key, value] of Object.entries(cmd.params)) {
          if (!skipProps.includes(key)) {
            processed.params[key] = value
          }
        }
      }

      return processed
    })
  }

  generateHash (commands) {
    const str = JSON.stringify(commands)
    return crypto.createHash('sha256').update(str).digest('hex')
  }

  generateDiff (baselineCommands, actualCommands) {
    const diff = {
      added: [],
      removed: [],
      modified: []
    }

    // Simple diff algorithm
    const maxLen = Math.max(baselineCommands.length, actualCommands.length)

    for (let i = 0; i < maxLen; i++) {
      const baseline = baselineCommands[i]
      const actual = actualCommands[i]

      if (!baseline) {
        diff.added.push({ index: i, command: actual })
      } else if (!actual) {
        diff.removed.push({ index: i, command: baseline })
      } else if (JSON.stringify(baseline) !== JSON.stringify(actual)) {
        diff.modified.push({
          index: i,
          baseline,
          actual
        })
      }
    }

    return diff
  }

  ensureDir (dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }
}
