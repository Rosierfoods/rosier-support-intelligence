/**
 * Seeds the organisation defaults and (optionally) DEMO DATA.
 *   npm run db:seed            → org defaults + demo data (if DEMO_MODE is not "false")
 *   npm run db:reset-demo      → wipe and regenerate demo data only
 *   npm run db:seed -- --no-demo  → org defaults only (production)
 */
import './_env';
import { getPool, withSystem } from '../src/lib/db';
import { createOrganization, ensureOrgDefaults } from '../src/lib/demo/bootstrap';
import { generateDemoData, clearDemoData } from '../src/lib/demo/generate';

async function main() {
  const args = process.argv.slice(2);
  const noDemo = args.includes('--no-demo') || process.env.DEMO_MODE === 'false';
  const clearOnly = args.includes('--clear-demo');
  const orgName = process.env.ORG_NAME ?? 'Rosier Foods';
  const orgSlug = process.env.ORG_SLUG ?? 'rosier-foods';
  const password = process.env.DEMO_PASSWORD ?? 'RosierDemo@2026';

  await withSystem(async (db) => {
    const orgId = await createOrganization(db, orgName, orgSlug);
    await ensureOrgDefaults(db, orgId);
    console.log(`Organisation "${orgName}" ready (${orgId}).`);
    if (clearOnly) {
      await db.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
      await clearDemoData(db, orgId);
      console.log('Demo data removed.');
      return;
    }
    if (noDemo) { console.log('Skipping demo data.'); return; }
    const s = await generateDemoData(db, orgId, { password });
    console.log(`DEMO DATA generated: ${s.interactions} interactions (${s.calls} calls, ${s.chats} chats/WhatsApp, ${s.emails} emails), ${s.flags} quality flags, ${s.coaching} coaching plans.`);
    console.log(`Demo sign-in: admin@rosier.demo / ${password}  (also crm@, lead.calls@, qa@, priya@ rosier.demo)`);
  });
  await getPool().end();
}
main().catch((e) => { console.error(e); process.exit(1); });
