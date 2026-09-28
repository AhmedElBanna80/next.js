export async function tasky() {
  // make cache-misses noticeable
  await new Promise((resolve) => setTimeout(resolve))
}

/**
 * A wrapper meant to ensure fetches with independent tags are cached separately
 * so that tests don't interfere with each others' fetch caches.
 * */
export async function fetchRandomWithForceCache({ tag }: { tag: string }) {
  return fetch(
    `https://next-data-api-endpoint.vercel.app/api/random?key=${encodeURIComponent(tag)}`,
    { cache: 'force-cache', next: { tags: [tag] } }
  )
}
