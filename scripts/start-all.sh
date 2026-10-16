#!/usr/bin/env bash
# Start everything in a codespace: database, background worker, website.  Usage: bash scripts/start-all.sh
cd "$(dirname "$0")/.."
pkill -f "[w]orker.ts"; pkill -f "[n]ext dev"; pkill -f "[l]ocal-db.ts"; sleep 1
pgrep -f "[p]ostgres -D" >/dev/null || rm -f .pgdata/postmaster.pid   # stale lock after the codespace slept
mkdir -p .logs
nohup npm run db:local > .logs/db.log 2>&1 &
echo -n "Starting database"
for i in $(seq 1 60); do (echo > /dev/tcp/127.0.0.1/54329) 2>/dev/null && break; echo -n "."; sleep 1; done; echo
(echo > /dev/tcp/127.0.0.1/54329) 2>/dev/null || { echo "Database did not start. Last lines of .logs/db.log:"; tail -20 .logs/db.log; exit 1; }
nohup npm run worker > .logs/worker.log 2>&1 &
echo "Worker started (log: .logs/worker.log). Starting website on port 3000…"
npm run dev
