/** Creates .env.local from .env.example with a freshly generated SECRETS_ENCRYPTION_KEY (never overwrites). */
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

if (fs.existsSync('.env.local')) {
  console.log('.env.local already exists — leaving it unchanged.');
  process.exit(0);
}
let env = fs.readFileSync('.env.example', 'utf8');
env = env.replace(/^SECRETS_ENCRYPTION_KEY=.*$/m, `SECRETS_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`);
env = env.replace(/^CRON_SECRET=.*$/m, `CRON_SECRET=${randomBytes(24).toString('base64url')}`);
fs.writeFileSync('.env.local', env, { mode: 0o600 });
console.log('Created .env.local with a new encryption key. Back this key up — losing it means re-entering every API key.');
