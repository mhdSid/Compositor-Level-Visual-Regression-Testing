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
      mode: process.env.CI ? 'pixel' : 'compositor', // Auto-detect CI
      pixelThreshold: 0.1,
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
      capture: this.capture.bind(this, browser),
      compare: this.compare.bind(this, browser),
      captureCompositor: this.captureCompositorData.bind(this, browser),
      compareCompositor: this.compareCompositorData.bind(this, browser),
      capturePixels: this.capturePixelData.bind(this, browser),
      comparePixels: this.comparePixelData.bind(this, browser)
    }
  }

  // Unified capture method that respects mode
  async capture (browser, name) {
    if (this.options.mode === 'pixel') {
      return this.capturePixelData(browser, name)
    }
    return this.captureCompositorData(browser, name)
  }

  // Unified compare method that respects mode
  async compare (browser, name) {
    if (this.options.mode === 'pixel') {
      return this.comparePixelData(browser, name)
    }
    return this.compareCompositorData(browser, name)
  }

  async captureCompositorData (browser, name) {
    try {
      const puppeteer = await browser.getPuppeteer()
      const pages = await puppeteer.pages()
      const page = pages[0]
      const client = await page.target().createCDPSession()

      await client.send('Network.setCacheDisabled', { cacheDisabled: true })
      await client.send('Page.reload', {
        ignoreCache: true,
        scriptToEvaluateOnLoad: 'document.body.style.opacity = "0.9999"'
      })

      await page.waitForFunction('Array.prototype.every.call(document.getElementsByTagName("img"), image => image.complete)')
      await page.waitForFunction('document.readyState === "complete"')
      await page.waitForFunction('document.fonts.ready')

      // Enable required domains
      await client.send('Runtime.enable')
      await client.send('DOM.enable')
      await client.send('CSS.enable')
      await client.send('LayerTree.enable')
      await client.send('Page.enable')
      await client.send('DOMSnapshot.enable')

      // AGGRESSIVE INVALIDATION: Force complete document repaint
      await client.send('Page.setDocumentContent', {
        frameId: (await client.send('Page.getFrameTree')).frameTree.frame.id,
        html: await page.content()
      })

      await client.send('Memory.simulatePressureNotification', {
        level: 'critical'
      })

      // Force complete repaint by invalidating all layers
      await page.evaluate(() => {
        document.querySelectorAll('*').forEach(el => {
          const orig = el.style.willChange
          el.style.willChange = 'transform'
          void el.offsetHeight
          el.style.willChange = orig || ''
        })
      })

      // Wait for pending tree to commit and activate
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))

      // Get layers
      const layers = []
      const layerPromise = new Promise(resolve => {
        client.once('LayerTree.layerTreeDidChange', (params) => {
          if (params.layers) resolve(params.layers)
        })
      })

      await page.evaluate(() => {
        window.scrollBy(0, 1)
        window.scrollBy(0, -1)
      })

      const detectedLayers = await Promise.race([
        layerPromise,
        new Promise(resolve => setTimeout(() => resolve([]), 1000))
      ])

      layers.push(...detectedLayers)
      console.log(`Found ${layers.length} layers`)

      // Extract paint commands
      const allCommands = []

      for (const layer of layers) {
        try {
          const { snapshotId } = await client.send('LayerTree.makeSnapshot', {
            layerId: layer.layerId
          })

          const result = await client.send('LayerTree.snapshotCommandLog', {
            snapshotId,
            fromStep: 0,
            toStep: 999999
          })

          const commandLog = result.commandLog
          if (commandLog) {
            let commands = null
            if (typeof commandLog === 'string') {
              try {
                commands = JSON.parse(commandLog)
              } catch (e) {}
            } else if (Array.isArray(commandLog)) {
              commands = commandLog
            } else if (typeof commandLog === 'object') {
              commands = commandLog.commands || [commandLog]
            }

            if (commands && Array.isArray(commands)) {
              // Filter out script-like content from drawTextBlob
              const filtered = commands.filter(cmd => {
                if (cmd.method === 'drawTextBlob' && cmd.params?.text) {
                  const text = cmd.params.text
                  // Skip if it looks like script content
                  if (text.includes('const ') ||
                      text.includes('let ') ||
                      text.includes('var ') ||
                      text.includes('function') ||
                      text.includes('document.') ||
                      text.includes('window.') ||
                      text.includes('=>') ||
                      text.length > 500) {
                    return false
                  }
                }
                return true
              })
              allCommands.push(...filtered)
            }
          }

          await client.send('LayerTree.releaseSnapshot', { snapshotId })
        } catch (e) {
          console.log(`Layer ${layer.layerId}: Could not snapshot (${e.message})`)
        }
      }

      // Extract VISIBLE text only (excluding scripts)
      const textCommands = await page.evaluate(() => {
        const texts = []
        const walker = document.createTreeWalker(
          document.documentElement,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: (node) => {
              const parent = node.parentElement
              // Skip script, style, and hidden elements
              if (parent && (
                parent.tagName === 'SCRIPT' ||
                parent.tagName === 'STYLE' ||
                parent.tagName === 'NOSCRIPT' ||
                getComputedStyle(parent).display === 'none' ||
                getComputedStyle(parent).visibility === 'hidden'
              )) {
                return NodeFilter.FILTER_REJECT
              }
              return node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
            }
          },
          false
        )

        let node
        while (node = walker.nextNode()) {
          const parent = node.parentElement
          const rect = parent.getBoundingClientRect()
          // Only include if actually visible on screen
          if (rect.width > 0 && rect.height > 0) {
            texts.push({
              method: 'drawTextBlob',
              params: {
                text: node.textContent.trim(),
                x: Math.round(rect.x),
                y: Math.round(rect.y + rect.height * 0.8) // Baseline approximation
              }
            })
          }
        }
        return texts
      })

      allCommands.push(...textCommands)
      console.log(`Added ${textCommands.length} text commands from DOM`)

      // Process commands
      const processedCommands = allCommands.map((cmd) => {
        const processed = {
          method: cmd.method || cmd.cmd || cmd.name || 'unknown',
          params: {}
        }

        if (cmd.params) {
          for (const [key, value] of Object.entries(cmd.params)) {
            processed.params[key] = value
          }
        }

        return processed
      })

      // Generate hash
      const commandsString = JSON.stringify(processedCommands)
      const hash = crypto.createHash('sha256').update(commandsString).digest('hex').substring(0, 16)
      console.log(`Final: Captured ${processedCommands.length} paint commands, hash: ${hash}`)

      const data = {
        name,
        timestamp: new Date().toISOString(),
        hash,
        mode: 'compositor',
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

    // Check if baseline exists
    if (!fs.existsSync(baselinePath)) {
      // Create baseline
      const data = await this.captureCompositorData(browser, name)
      fs.writeFileSync(baselinePath, JSON.stringify(data, null, 2))
      return {
        status: 'created',
        message: 'Baseline created',
        mode: 'compositor',
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
      mode: 'compositor',
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
      size: Buffer.from(screenshot, 'base64').length,
      mode: 'pixel'
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
        message: 'Baseline created',
        mode: 'pixel'
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
      { threshold: this.options.pixelThreshold || 0.1 }
    )

    const totalPixels = width * height
    const diffPercentage = (mismatchedPixels / totalPixels) * 100

    if (mismatchedPixels > 0) {
      const diffPath = path.join(this.options.diffDir, `${name}-diff.png`)
      fs.writeFileSync(diffPath, PNG.sync.write(diff))
    }

    return {
      status: mismatchedPixels === 0 ? 'match' : 'mismatch',
      mode: 'pixel',
      mismatchedPixels,
      totalPixels,
      diffPercentage: diffPercentage.toFixed(2),
      match: mismatchedPixels === 0
    }
  }

  generateDiff (baselineCommands, actualCommands) {
    const diff = {
      added: [],
      removed: [],
      modified: []
    }

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
