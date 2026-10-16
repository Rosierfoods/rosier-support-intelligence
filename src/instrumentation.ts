/** Runs once when the Next.js server starts. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  const { bootstrapAdmin } = await import('@/lib/bootstrap-admin');
  await bootstrapAdmin();
  if (process.env.RUN_WORKER_IN_WEB === 'true') {
    const { startWorkerLoop } = await import('@/lib/pipeline/worker-loop');
    startWorkerLoop();
  }
}
