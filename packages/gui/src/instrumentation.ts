// Next 15 server-startup hook (https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation).
//
// `instrumentation.ts` is evaluated on every runtime (Node and Edge), so the
// actual scheduler boot — which transitively pulls in `@cezar/core` /
// `cosmiconfig` / Node built-ins — lives in `./instrumentation-node.ts` and is
// only ever imported on the Node.js runtime via the documented pattern below.
// (Vercel deployments leave `CEZAR_INPROCESS_CRON` unset and use `vercel.json`.)

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.CEZAR_INPROCESS_CRON !== 'true') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  await import('./instrumentation-node');
}
