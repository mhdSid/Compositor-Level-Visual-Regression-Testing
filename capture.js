import puppeteer from 'puppeteer'
import crypto from 'crypto'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

async function extractPaintCommands(url) {
	const browser = await puppeteer.launch({ 
		headless: true,
		args: ['--disable-gpu-rasterization', '--no-sandbox'],
	})
	const page = await browser.newPage()
	
	// Navigate FIRST
	await page.goto(url, { waitUntil: 'networkidle0' })
	
	// Get CDP session AFTER navigation
	const client = await page.target().createCDPSession()
	
	// Enable required domains
	await client.send('DOM.enable')
	await client.send('LayerTree.enable')
	
	// Force a paint
	await page.evaluate(() => {
		document.body.style.transform = 'translateZ(0)'
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
		new Promise(resolve => setTimeout(() => resolve([]), 1000)),
	])
	
	layers.push(...detectedLayers)
	
	console.log(`Found ${layers.length} layers`)
	
	// Extract paint commands from each layer
	const allCommands = []
	
	for (const layer of layers) {
		try {
			// Make snapshot of this layer
			const { snapshotId } = await client.send('LayerTree.makeSnapshot', {
				layerId: layer.layerId,
			})
			
			// Get the actual paint commands
			const { commandLog } = await client.send('LayerTree.snapshotCommandLog', {
				snapshotId: snapshotId,
			})
			
			if (commandLog) {
				allCommands.push(commandLog)
				console.log(`Layer ${layer.layerId}: ${commandLog.length} chars`)
				
				// Parse and show what kind of commands we got
				try {
					const commands = JSON.parse(commandLog)
					if (Array.isArray(commands) && commands.length > 0) {
						console.log(`  Contains ${commands.length} paint operations`)
					}
				} catch (e) {
					// commandLog might not be JSON
				}
			}
			
			// Release snapshot
			await client.send('LayerTree.releaseSnapshot', {
				snapshotId: snapshotId,
			})
		} catch (e) {
			console.log(`Layer ${layer.layerId}: Could not snapshot (${e.message})`)
		}
	}
	
	// If no layers found, try the document's root layer
	if (allCommands.length === 0) {
		console.log('Trying root layer approach...')
		try {
			// Create a snapshot of the entire page
			const { snapshotId } = await client.send('LayerTree.makeSnapshot', {
				layerId: 'document',
			})
			
			const { commandLog } = await client.send('LayerTree.snapshotCommandLog', {
				snapshotId: snapshotId,
			})
			
			if (commandLog) {
				allCommands.push(commandLog)
				console.log(`Root snapshot: ${commandLog.length} chars`)
			}
			
			await client.send('LayerTree.releaseSnapshot', {
				snapshotId: snapshotId,
			})
		} catch (e) {
			console.log('Root layer snapshot failed:', e.message)
		}
	}
	
	if (allCommands.length === 0) {
		console.log('⚠️  No paint commands captured - layers might not be accessible')
		console.log('This can happen with simple pages that don\'t create separate layers')
	}
	
	await browser.close()
	
	// Create hash from paint commands
	const commandsString = JSON.stringify(allCommands)
	const hash = crypto.createHash('sha256').update(commandsString).digest('hex')
	
	return {
		commands: allCommands,
		hash: hash.substring(0, 16),
		count: allCommands.length,
	}
}

async function loadExistingCommands(filename) {
	try {
		if (!fs.existsSync(filename)) throw new Error('file does not exist')

		const data = fs.readFileSync(filename, 'utf8')
		const parsed = JSON.parse(data)
		
		return {
			commands: parsed.commands,
			hash: parsed.hash,
			count: parsed.count,
		}
	} catch (e) {
		return null
	}
}

async function comparePages() {
	console.log('=== Compositor Paint Command Test ===\n')
	
	// Check if baseline exists AND is valid
	let baseline = await loadExistingCommands('baseline.json')

	if (baseline && baseline.hash && baseline.count > 0) {
		console.log('✓ Found valid baseline.json')
		console.log(`  Baseline hash: ${baseline.hash}, ${baseline.count} command logs`)
	} else {
		// Either doesn't exist or is invalid - create new baseline
		console.log('No valid baseline found. Creating new baseline...')
		baseline = await extractPaintCommands('file://' + __dirname + '/test.html')
		// Save the FULL object structure, not just commands
		fs.writeFileSync('baseline.json', JSON.stringify({
			commands: baseline.commands,
			hash: baseline.hash,
			count: baseline.count,
		}, null, 2))
		console.log(`✓ Baseline created: hash=${baseline.hash}, ${baseline.count} command logs`)
	}
	
	// Always capture fresh actual
	console.log('\nCapturing actual state...')
	const actual = await extractPaintCommands('file://' + __dirname + '/test.html')
	// Save the FULL object structure, not just commands
	fs.writeFileSync('actual.json', JSON.stringify({
		commands: actual.commands,
		hash: actual.hash,
		count: actual.count,
	}, null, 2))
	console.log(`✓ Actual captured: hash=${actual.hash}, ${actual.count} command logs`)
	
	// Compare
	const identical = baseline.hash === actual.hash
	console.log(`\n${identical ? '✅' : '❌'} Result: ${identical ? 'MATCH' : 'MISMATCH'}`)
	console.log(`  Baseline: ${baseline.hash}`)
	console.log(`  Actual:   ${actual.hash}`)
	
	if (!identical && baseline.count > 0 && actual.count > 0) {
		console.log('\n⚠️  Visual regression detected!')
		console.log('  Check baseline.json and actual.json for differences')
		
		// Try to show where they differ
		if (baseline.commands.length !== actual.commands.length) {
			console.log(`  Different number of layers: ${baseline.commands.length} vs ${actual.commands.length}`)
		} else {
			for (let i = 0; i < baseline.commands.length; i++) {
				if (baseline.commands[i] !== actual.commands[i]) {
					console.log(`  Layer ${i} differs`)
					break
				}
			}
		}
	}
}

// Add command line arguments
const args = process.argv.slice(2)

if (args.includes('--reset') || args.includes('-r')) {
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
	console.log('Run again to create fresh baseline.')
} else {
	// Run the test
	comparePages().catch(console.error)
}
