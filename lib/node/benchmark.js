import { spawn } from 'child_process'
import fs from 'fs'

const config = {
  iterations: 5,
  testPages: ['test.html']
}

function runScript (scriptPath, args = []) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now()
    const child = spawn('node', [scriptPath, ...args])

    let output = ''
    let error = ''

    child.stdout.on('data', (data) => {
      output += data.toString()
    })

    child.stderr.on('data', (data) => {
      error += data.toString()
    })

    child.on('close', (code) => {
      const duration = Date.now() - startTime

      if (code !== 0) {
        // eslint-disable-next-line prefer-promise-reject-errors
        reject({ error, code })
      } else {
        resolve({ output, duration })
      }
    })
  })
}

function parseCompositorOutput (output) {
  const matchResult = output.includes('✅ Result: MATCH')
  const hashMatch = output.match(/Baseline: ([a-f0-9]+)/)
  const actualMatch = output.match(/Actual: {3}([a-f0-9]+)/)
  const layersMatch = output.match(/Found (\d+) layers/)

  return {
    match: matchResult,
    baselineHash: hashMatch ? hashMatch[1] : null,
    actualHash: actualMatch ? actualMatch[1] : null,
    layers: layersMatch ? parseInt(layersMatch[1]) : 0
  }
}

function parsePixelOutput (output) {
  const matchResult = output.includes('✅ Visual test PASSED') || output.includes('✅ Baseline created')
  const diffMatch = output.match(/Difference: ([\d.]+)%/)
  const pixelsMatch = output.match(/Mismatched pixels: (\d+) \/ (\d+)/)

  return {
    match: matchResult,
    diffPercentage: diffMatch ? parseFloat(diffMatch[1]) : 0,
    mismatchedPixels: pixelsMatch ? parseInt(pixelsMatch[1]) : 0,
    totalPixels: pixelsMatch ? parseInt(pixelsMatch[2]) : 0
  }
}

async function runBenchmark () {
  console.log('=== Visual Regression Testing Benchmark ===\n')
  console.log(`Running ${config.iterations} iterations for each method...\n`)

  const results = {
    compositor: [],
    pixel: []
  }

  console.log('\n' + '='.repeat(60))
  console.log('COMPOSITOR METHOD (Paint Commands)')
  console.log('='.repeat(60))

  // Run compositor method
  for (let i = 0; i < config.iterations; i++) {
    console.log(`\n📊 Iteration ${i + 1}/${config.iterations}`)

    try {
      const { output, duration } = await runScript('lib/node/capture-compositor.js')
      const parsed = parseCompositorOutput(output)

      results.compositor.push({
        iteration: i + 1,
        duration,
        match: parsed.match,
        layers: parsed.layers,
        hash: parsed.baselineHash
      })

      console.log(`  ⏱️  Duration: ${duration}ms`)
      console.log(`  📝 Layers: ${parsed.layers}`)
      console.log(`  ✅ Match: ${parsed.match}`)
    } catch (error) {
      console.error('  ❌ Error:', error.error || error)
    }
  }

  console.log('\n' + '='.repeat(60))
  console.log('PIXEL METHOD (Traditional Screenshots)')
  console.log('='.repeat(60))

  // Run pixel method
  for (let i = 0; i < config.iterations; i++) {
    console.log(`\n📊 Iteration ${i + 1}/${config.iterations}`)

    try {
      const { output, duration } = await runScript('lib/node/capture-pixels.js')
      const parsed = parsePixelOutput(output)

      results.pixel.push({
        iteration: i + 1,
        duration,
        match: parsed.match,
        diffPercentage: parsed.diffPercentage,
        mismatchedPixels: parsed.mismatchedPixels
      })

      console.log(`  ⏱️  Duration: ${duration}ms`)
      console.log(`  📊 Diff: ${parsed.diffPercentage}%`)
      console.log(`  ✅ Match: ${parsed.match}`)
    } catch (error) {
      console.error('  ❌ Error:', error.error || error)
    }
  }

  // Calculate statistics
  console.log('\n' + '='.repeat(60))
  console.log('BENCHMARK RESULTS')
  console.log('='.repeat(60))

  const compositorStats = calculateStats(results.compositor)
  const pixelStats = calculateStats(results.pixel)

  console.log('\n📐 Compositor Method (Paint Commands):')
  console.log(`  Average duration: ${compositorStats.avgDuration}ms`)
  console.log(`  Min duration: ${compositorStats.minDuration}ms`)
  console.log(`  Max duration: ${compositorStats.maxDuration}ms`)
  console.log(`  Success rate: ${compositorStats.successRate}%`)
  console.log(`  Consistency: ${compositorStats.consistency}`)

  console.log('\n🖼️  Pixel Method (Screenshots):')
  console.log(`  Average duration: ${pixelStats.avgDuration}ms`)
  console.log(`  Min duration: ${pixelStats.minDuration}ms`)
  console.log(`  Max duration: ${pixelStats.maxDuration}ms`)
  console.log(`  Success rate: ${pixelStats.successRate}%`)
  console.log(`  Consistency: ${pixelStats.consistency}`)

  console.log('\n' + '='.repeat(60))
  console.log('📊 Comparison:')
  console.log('='.repeat(60))

  console.log(`  (Pixel) avg dration: ${pixelStats.avgDuration}ms`)
  console.log(`  (Compositor) avg dration: ${compositorStats.avgDuration}ms`)
  const speedRatio = (pixelStats.avgDuration / compositorStats.avgDuration).toFixed(2)
  if (speedRatio > 1) {
    console.log(`  Speed difference: Compositor is ${speedRatio}x faster`)
  } else {
    const inverseRatio = (compositorStats.avgDuration / pixelStats.avgDuration).toFixed(2)
    console.log(`  Speed difference: Pixel method is ${inverseRatio}x faster`)
  }

  const compositorSize = getFileSize('baseline.json') + getFileSize('actual.json')
  const pixelSize = getFolderSize('./baseline-images') + getFolderSize('./actual-images')

  console.log(`  Storage (Compositor): ${formatBytes(compositorSize)}`)
  console.log(`  Storage (Pixel): ${formatBytes(pixelSize)}`)
  console.log(`  Storage ratio: ${(pixelSize / compositorSize).toFixed(1)}x more for pixels`)

  // Determine winner
  console.log('\n🏆 Winner:')
  if (compositorStats.consistency === 'Perfect' && pixelStats.consistency !== 'Perfect') {
    console.log('  Compositor method - Perfect consistency across runs!')
  } else if (compositorStats.avgDuration < pixelStats.avgDuration * 0.8) {
    // Compositor is at least 20% faster
    console.log('  Compositor method - Significantly faster!')
  } else if (pixelSize / compositorSize > 10) {
    console.log('  Compositor method - Much smaller storage footprint!')
  } else if (compositorStats.avgDuration < pixelStats.avgDuration) {
    // Compositor is faster but not dramatically
    console.log('  Compositor method - Faster and more reliable!')
  } else {
    console.log('  Both methods have trade-offs, choose based on your needs')
  }

  // Save results to file
  const report = {
    timestamp: new Date().toISOString(),
    iterations: config.iterations,
    compositorResults: results.compositor,
    pixelResults: results.pixel,
    statistics: {
      compositor: compositorStats,
      pixel: pixelStats
    },
    comparison: {
      speedRatio,
      storageRatio: (pixelSize / compositorSize).toFixed(1),
      compositorStorage: compositorSize,
      pixelStorage: pixelSize
    }
  }

  fs.writeFileSync(`${process.cwd()}/benchmark-results.json`, JSON.stringify(report, null, 2))
  console.log('\n📄 Full results saved to benchmark-results.json')
}

function calculateStats (results) {
  const durations = results.map(r => r.duration)
  const matches = results.map(r => r.match)

  const avgDuration = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
  const minDuration = Math.min(...durations)
  const maxDuration = Math.max(...durations)
  const successRate = (matches.filter(m => m).length / matches.length * 100).toFixed(1)

  // Check consistency
  let consistency = 'Perfect'
  if (matches.includes(false)) {
    consistency = 'Inconsistent'
  } else if (maxDuration - minDuration > avgDuration * 0.5) {
    consistency = 'Variable timing'
  }

  return {
    avgDuration,
    minDuration,
    maxDuration,
    successRate,
    consistency
  }
}

function getFileSize (filePath) {
  try {
    const stats = fs.statSync(filePath)
    return stats.size
  } catch (e) {
    return 0
  }
}

function getFolderSize (folderPath) {
  let totalSize = 0

  try {
    const files = fs.readdirSync(folderPath)
    files.forEach(file => {
      const filePath = `${folderPath}/${file}`
      const stats = fs.statSync(filePath)
      totalSize += stats.size
    })
  } catch (e) {
    // Folder doesn't exist
  }

  return totalSize
}

function formatBytes (bytes) {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
}

// Run benchmark
runBenchmark().catch(console.error)
