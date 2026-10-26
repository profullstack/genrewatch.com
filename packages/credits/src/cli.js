#!/usr/bin/env bun
/**
 * Mint and manage credit codes and invite quotas against the site's database.
 *
 *   bun run credits mint --days 30 [--unit premium|live] [--max 1] [--expires 90] [--label "for Kim"]
 *   bun run credits list
 *   bun run credits revoke <codeId>
 *   bun run credits quota <email> <total>
 *
 * On dev2 it runs inside the app container, which already has DATABASE_URL:
 *   docker exec genrewatchcom-app-1 bun run credits mint --days 30 --label "for Kim"
 *
 * The packages' own CLIs take a SQLite file; this site is Postgres, hence this.
 */
import { sql } from '@genre/db';
import { codeOut, defaultUnit, LIVE_DAYS, mintCode, PREMIUM_DAYS, services } from './index.js';

const UNIT_ALIASES = { live: LIVE_DAYS, pass: LIVE_DAYS, premium: PREMIUM_DAYS };

function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

const usage = `usage:
  credits mint --days N [--unit live|premium] [--max N] [--expires DAYS] [--label TEXT] [--json]
  credits list [--json]
  credits revoke <codeId>
  credits quota <email> <total>`;

async function main() {
  const args = parse(process.argv.slice(2));
  const [cmd, ...rest] = args._;
  const svc = services();
  switch (cmd) {
    case 'mint': {
      // No --unit: whichever unit can be used on this site (Premium while Live TV is off).
      const unit = args.unit ? (UNIT_ALIASES[args.unit] ?? args.unit) : defaultUnit();
      const c = await mintCode(
        {
          days: args.days,
          unit,
          label: args.label === true ? '' : (args.label ?? ''),
          maxRedemptions: args.max ?? 1,
          expiresInDays: args.expires ?? null,
          createdBy: 'cli',
        },
        svc,
      );
      if (args.json) console.log(JSON.stringify(c, null, 2));
      else {
        console.log(c.code);
        console.log(
          `${c.days} day${c.days === 1 ? '' : 's'} of ${c.unit}, ${c.max_redemptions} use(s)${c.expires_at ? `, expires ${c.expires_at}` : ''}`,
        );
        console.log(`redeem at ${c.url}`);
        console.log(`id ${c.id} (for revoke)`);
      }
      return;
    }
    case 'list': {
      const rows = (await svc.credits.list()).map((c) => codeOut(c));
      if (args.json) console.log(JSON.stringify(rows, null, 2));
      else
        for (const c of rows)
          console.log(
            `${c.id}  ${c.days}d ${c.unit}  ${c.redemptions}/${c.max_redemptions}${c.revoked_at ? '  revoked' : ''}  ${c.label}`,
          );
      return;
    }
    case 'revoke': {
      if (!rest[0]) throw new Error(usage);
      await svc.credits.revoke(rest[0]);
      console.log(`revoked ${rest[0]}`);
      return;
    }
    case 'quota': {
      const [email, total] = rest;
      if (!email || total === undefined) throw new Error(usage);
      const [u] = await sql`select id from users where email = ${email.toLowerCase()}`;
      if (!u) throw new Error(`no account for ${email}`);
      await svc.aff.setQuota(String(u.id), Number(total));
      console.log(JSON.stringify(await svc.aff.quota(String(u.id))));
      return;
    }
    default:
      throw new Error(usage);
  }
}

main()
  .then(() => sql.end())
  .catch(async (err) => {
    console.error(err.message);
    await sql.end().catch(() => {});
    process.exit(1);
  });
