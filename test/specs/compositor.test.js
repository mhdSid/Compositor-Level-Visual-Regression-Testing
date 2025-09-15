describe('Compositor Visual Regression Tests', () => {
  beforeEach(async () => {
    await browser.url(`file://${process.cwd()}/fixtures/test.html`)
  })

  it('should capture and compare compositor data for simple page', async () => {
    const result = await browser.compareCompositor('simple-page')

    if (result.status === 'created') {
      console.log('✅ Baseline created:', result.hash)
    } else if (result.status === 'match') {
      console.log('✅ Visual test PASSED')
      console.log(`  Baseline: ${result.baseline.substring(0, 8)}...`)
      console.log(`  Actual:   ${result.actual.substring(0, 8)}...`)
    } else {
      console.log('❌ Visual test FAILED')
      console.log(`  Baseline: ${result.baseline.substring(0, 8)}...`)
      console.log(`  Actual:   ${result.actual.substring(0, 8)}...`)
      console.log('  Differences found:', result.diff)
      throw new Error('Compositor data mismatch')
    }

    expect(result.match || result.status === 'created').toBe(true)
  })
})
