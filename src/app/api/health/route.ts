import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** Lightweight liveness check (no DB) — used by uptime pingers to keep free hosting awake. */
export function GET() {
  return NextResponse.json({ ok: true, time: new Date().toISOString() });
}
