// Holds `pnpm dev:web` until the API answers its health check, so an open browser tab does not hit the
// Vite proxy before the API has finished building (ECONNREFUSED on /api/*). Gives up after a minute and
// starts anyway, so `pnpm dev:web` on its own still works.
const url = 'http://localhost:3000/api/health';
const deadline = Date.now() + 60_000;

async function healthy() {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1_000) })).ok;
  } catch {
    return false;
  }
}

if (!(await healthy())) {
  console.log(`waiting for the API (${url})…`);
  while (!(await healthy())) {
    if (Date.now() > deadline) {
      console.log('the API is not up after 60 s; starting the web app anyway');
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
