import { NextInstance, nextTestSetup } from 'e2e-utils'
import { assertNoConsoleErrors, gate, retry } from 'next-test-utils'
import { computeCacheBustingSearchParam } from 'next/dist/shared/lib/router/utils/cache-busting-search-param'
import cheerio from 'cheerio'

// RDC and resume renders do not function in the same way in dev.
// This test suite asserts on production behavior.
// @force-gate !dev
describe('resume-data-cache', () => {
  const { next } = nextTestSetup({
    files: __dirname,
  })

  describe('should have consistent data between static and dynamic renders', () => {
    const testImpl = async ({
      name,
      path,
      cacheTag,
      valuePattern,
    }: {
      name: string
      path: string
      cacheTag: string
      valuePattern: RegExp
    }) => {
      const htmlId = 'random-number'

      // First, extract the random number from the prerender.
      const initialRSC = await fetchStaticPageSegment(next, path).then((res) =>
        res.text()
      )
      const initialValue = getValueFromText(initialRSC, valuePattern)
      console.log(`${name} - first value: ${initialValue}`)

      // Dynamic HTML should use the same value.
      {
        const html = await next.render(path)
        const valueFromHTML = cheerio.load(html)(`p#${htmlId}`).text()
        expect(valueFromHTML).toBe(initialValue)

        // The value should be consistent across shell and resume.
        expectConsistentCacheValueInHtml(html, valuePattern, initialValue)
      }

      // Dynamic RSC should use the same value.
      {
        const rsc = await fetchRSC(next, path).then((res) => res.text())
        expect(rsc).toContain(initialValue)
      }

      // Then revalidate the cached data. Note: Dynamic RSC requests don't trigger
      // actual revalidation - they only mark tags as needing revalidation.
      // The actual revalidation only occurs when accessing a static resource again.
      await next.fetch(`/revalidate?tag=${cacheTag}`, { method: 'POST' })

      // Then get the dynamic RSC again and validate that it still contains the
      // same random number. The first request will get the stale data, but the
      // second request will get the fresh data as it'll eventually have
      // revalidated.
      const rsc = await fetchRSC(next, path).then((res) => res.text())
      // TODO: this seems to be race-y in deploy
      if (!(await gate('deploy'))) {
        expect(rsc).toContain(initialValue)
      }

      // In deploy mode, revalidation seems to take a while to propagate
      const POST_REVALIDATION_RETRY = 10_000

      // When the revalidation prerender completes, segment prefetches should start
      // containing a new value.
      const revalidatedValue = await retry(
        async () => {
          const rsc = await fetchStaticPageSegment(next, path).then((res) =>
            res.text()
          )
          expect(rsc).not.toContain(initialValue)
          return getValueFromText(rsc, valuePattern)
        },
        POST_REVALIDATION_RETRY,
        undefined,
        `${name} - segment prefetch should change`
      )
      console.log(`${name} - second value: ${revalidatedValue}`)

      // Dynamic HTML should use the revalidated value.
      await retry(
        async () => {
          const html = await next.render(path)
          const valueFromHTML = cheerio.load(html)(`p#${htmlId}`).text()
          expect(valueFromHTML).toBe(revalidatedValue)
          expectConsistentCacheValueInHtml(html, valuePattern, revalidatedValue)
        },
        POST_REVALIDATION_RETRY,
        undefined,
        `${name} - dynamic HTML should contain the revalidated cache value`
      )

      // Dynamic RSC requests should also use the revalidated value.
      await retry(
        async () => {
          const rsc = await fetchRSC(next, path).then((res) => res.text())
          expect(rsc).toContain(revalidatedValue)
        },
        POST_REVALIDATION_RETRY,
        undefined,
        `${name} - dynamic RSC should contain the revalidated cache value`
      )
    }

    it('use cache', async () => {
      await testImpl({
        name: 'use cache',
        path: '/use-cache',
        cacheTag: 'test-use-cache',
        valuePattern: /cache-random-.+?-\d+-\d+\.\d+/,
      })
    })

    it('fetch cache', async () => {
      await testImpl({
        name: 'fetch cache',
        path: '/fetch-cache',
        cacheTag: 'test-fetch-cache',
        valuePattern: /fetch-random-\d+-\d+\.\d+/,
      })
    })
  })

  it('should use RDC for server action re-renders', async () => {
    const url = '/server-action'
    const valuePattern = /cache-random-\d+\.\d+/

    const prerenderedCachedValue = await getPrerenderedValueFromPageSegment(
      next,
      url,
      valuePattern
    )

    // The values of the cache entry should be consistent across shell/resume.
    expectConsistentCacheValueInHtml(
      await next.fetch(url).then((res) => res.text()),
      valuePattern,
      prerenderedCachedValue
    )

    const browser = await next.browser(url, {
      pushErrorAsConsoleLog: true,
    })

    // Get the initial values
    const initialCachedValue = await browser
      .elementByCss('#cached-random')
      .text()
    const initialUncachedValue = await browser
      .elementByCss('#uncached-random')
      .text()

    expect(initialCachedValue).toBe(prerenderedCachedValue)

    // There should be no hydration errors due to a buildtime cache being
    // replaced by a new runtime cache
    await assertNoConsoleErrors(browser)

    await browser.elementByCss('#refresh-button').click()

    // Wait for the action to complete and verify:
    // 1. The uncached value should change
    // 2. The cached value should remain the same (proving RDC is being used)
    await retry(async () => {
      const cachedValueAfterAction = await browser
        .elementByCss('#cached-random')
        .text()
      const uncachedValueAfterAction = await browser
        .elementByCss('#uncached-random')
        .text()

      // Uncached value should have changed - this proves the action caused a re-render
      expect(uncachedValueAfterAction).not.toBe(initialUncachedValue)

      // Cached value should remain the same - this proves the RDC is being used
      // to maintain consistency during server action re-renders
      expect(cachedValueAfterAction).toBe(initialCachedValue)
    })
  })

  it('should see fresh data after updateTag in server action with use cache', async () => {
    // This test verifies that when a server action calls updateTag(),
    // the subsequent re-render sees fresh data instead of stale RDC data.
    // This is the "read your own writes" behavior for 'use cache'.
    const url = '/revalidate-action'
    const valuePattern = /cache-random-\d+\.\d+/

    const prerenderedCachedValue = await getPrerenderedValueFromPageSegment(
      next,
      url,
      valuePattern
    )

    // The values of the cache entry should be consistent across shell/resume.
    expectConsistentCacheValueInHtml(
      await next.fetch(url).then((res) => res.text()),
      valuePattern,
      prerenderedCachedValue
    )

    const browser = await next.browser(url, {
      pushErrorAsConsoleLog: true,
    })

    // Get the initial cached value from the page render
    const initialCachedValue = await browser
      .elementByCss('#cached-value')
      .text()
    const initialUncachedValue = await browser
      .elementByCss('#uncached-value')
      .text()

    expect(initialCachedValue).toBe(prerenderedCachedValue)

    // There should be no hydration errors due to a buildtime cache being
    // replaced by a new runtime cache
    await assertNoConsoleErrors(browser)

    // Click the revalidate button to trigger the server action
    await browser.elementByCss('#revalidate-button').click()

    // Wait for the re-render and verify:
    // 1. The uncached value should change (proves re-render happened)
    // 2. The cached value should ALSO change (proves updateTag was respected)
    await retry(async () => {
      const cachedValueAfterAction = await browser
        .elementByCss('#cached-value')
        .text()
      const uncachedValueAfterAction = await browser
        .elementByCss('#uncached-value')
        .text()

      // Uncached value should change - this proves the action triggered a re-render
      expect(uncachedValueAfterAction).not.toBe(initialUncachedValue)

      // Cached value should also change, which proves that the RDC read respected
      // pendingRevalidatedTags and fetched fresh data instead of returning
      // the stale value from the RDC.
      // If this fails, it means the RDC is not respecting updateTag()
      // calls made during server actions
      expect(cachedValueAfterAction).not.toBe(initialCachedValue)
    })
  })

  it('should see fresh data after updateTag in server action with fetch cache', async () => {
    // This test verifies that when a server action calls updateTag(),
    // the subsequent re-render sees fresh data instead of stale RDC data.
    // This is the "read your own writes" behavior for fetch cache.
    const url = '/revalidate-fetch-action'
    const valuePattern = /fetch-random-\d+\.\d+/
    const prerenderedCachedValue = await getPrerenderedValueFromPageSegment(
      next,
      url,
      valuePattern
    )

    // The values of the cache entry should be consistent across shell/resume.
    expectConsistentCacheValueInHtml(
      await next.fetch(url).then((res) => res.text()),
      valuePattern,
      prerenderedCachedValue
    )

    const browser = await next.browser(url, {
      pushErrorAsConsoleLog: true,
    })

    // Get the initial cached value from the page render
    const initialCachedValue = await browser
      .elementByCss('#cached-value')
      .text()
    const initialUncachedValue = await browser
      .elementByCss('#uncached-value')
      .text()

    expect(initialCachedValue).toBe(prerenderedCachedValue)

    // There should be no hydration errors due to a buildtime cache being
    // replaced by a new runtime cache
    await assertNoConsoleErrors(browser)

    // Click the revalidate button to trigger the server action
    await browser.elementByCss('#revalidate-button').click()

    // Wait for the re-render and verify:
    // 1. The uncached value should change (proves re-render happened)
    // 2. The cached value should ALSO change (proves updateTag was respected)
    await retry(async () => {
      const cachedValueAfterAction = await browser
        .elementByCss('#cached-value')
        .text()
      const uncachedValueAfterAction = await browser
        .elementByCss('#uncached-value')
        .text()

      // Uncached value should change - this proves the action triggered a re-render
      expect(uncachedValueAfterAction).not.toBe(initialUncachedValue)

      // Cached value should also change, which proves that the RDC read respected
      // pendingRevalidatedTags and fetched fresh data instead of returning
      // the stale value from the RDC.
      // If this fails, it means the RDC is not respecting updateTag()
      // calls made during server actions
      expect(cachedValueAfterAction).not.toBe(initialCachedValue)
    })
  })
})

function expectConsistentCacheValueInHtml(
  html: string,
  valuePattern: RegExp,
  expectedValue: string
) {
  expect(getUniqueRegexMatches(html, valuePattern)).toEqual([expectedValue])
}

function getUniqueRegexMatches(text: string, pattern: RegExp) {
  const uniqueMatches = new Set<string>()
  for (const match of text.matchAll(
    new RegExp(pattern.source, pattern.flags + 'g')
  )) {
    // `matchAll` returns a match array for each occurence.
    // We don't care about groups, so just take the whole match.
    uniqueMatches.add(match[0])
  }
  return [...uniqueMatches]
}

async function getPrerenderedValueFromPageSegment(
  next: NextInstance,
  url: string,
  valuePattern: RegExp
) {
  const prerendered = await fetchStaticPageSegment(next, url).then((res) =>
    res.text()
  )
  return getValueFromText(prerendered, valuePattern)
}

function getValueFromText(text: string, valuePattern: RegExp) {
  const value = text.match(valuePattern)?.[0] ?? null
  if (value === null) {
    throw new Error(
      `Value pattern not found in prerender: ${valuePattern.source}`
    )
  }
  return value
}

async function fetchRSC(next: NextInstance, url: string) {
  return await fetchWithRSCCacheBuster(next, url, {
    headers: {
      RSC: '1',
    },
  })
}

async function fetchStaticPageSegment(next: NextInstance, url: string) {
  const pathname = new URL(url, 'http://__n').pathname
  return await fetchWithRSCCacheBuster(next, url, {
    headers: {
      RSC: '1',
      'Next-Router-Prefetch': '1',
      'Next-Router-Segment-Prefetch': pathname + '/__PAGE__',
    },
  })
}

async function fetchWithRSCCacheBuster(
  next: NextInstance,
  rawUrl: string,
  opts: RequestInit
): Promise<Response> {
  // convert to Headers to normalize header casing
  const headers = new Headers(opts.headers ?? {})

  const urlObject = new URL(rawUrl, next.url)
  urlObject.searchParams.set(
    '_rsc',
    await computeCacheBustingSearchParam(
      (headers.get('next-router-prefetch') ?? undefined) as Parameters<
        typeof computeCacheBustingSearchParam
      >[0],
      headers.get('next-router-segment-prefetch') ?? undefined,
      headers.get('next-router-state-tree') ?? undefined,
      headers.get('next-url') ?? undefined
    )
  )
  const url = urlObject.href
  const response = await next.fetch(url, {
    ...opts,
    headers,
  })
  if (response.url !== url) {
    console.error('URL mismatch with response (likely redirect)', {
      url,
      'response.url': response.url,
    })
  }
  return response
}
