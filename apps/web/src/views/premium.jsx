import { LocalTime } from './components.jsx';
import { Layout } from './Layout.jsx';

/**
 * The paid tier: what it costs, what it opens, and what an introduction earns.
 *
 * Its own file rather than another section of pages.jsx, which is already the
 * whole catalogue side of the site. These pages share nothing with it except the
 * layout, and one of them is a page about money -- which is worth being able to
 * read on its own.
 *
 * The rule these follow: never say a number the database does not agree with.
 * Every figure on these pages is passed in from a query or from configuration.
 * There is no "$10" written into the markup, because a price that lives in two
 * places is a price that will one day be advertised at one value and charged at
 * another.
 */

/** Cents to something a person reads. Never a float anywhere but here. */
const money = (cents, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format((cents ?? 0) / 100);

const nameOf = (p) => p.display_name ?? (p.handle ? `@${p.handle}` : 'Someone');

/**
 * A term, in the words a buyer would use.
 *
 * 365 days is "a year" and 30 is "a month"; anything else is said in days rather
 * than rounded into a word that would be a lie about when access ends.
 */
const term = (days) => (days === 365 ? 'a year' : days === 30 ? 'a month' : `${days} days`);

export const PremiumPage = ({
  user,
  membership,
  priceCents,
  currency,
  termDays,
  commissionBps,
  freeHistoryDays,
  paymentsEnabled,
  inviteUrl,
  invited = [],
  earnings = [],
  ledger = [],
  payout = null,
  want = null,
  notice = null,
  error = null,
}) => {
  const rate = `${(commissionBps / 100).toFixed(commissionBps % 100 === 0 ? 0 : 2)}%`;

  return (
    <Layout title="Premium" user={user}>
      <div class="page-head">
        <h1>Premium</h1>
        {membership ? (
          <span class="pill">
            Member until <LocalTime at={membership.expires_at} />
          </span>
        ) : (
          <span class="pill muted">
            {money(priceCents, currency)} / {term(termDays)}
          </span>
        )}
      </div>

      <p>
        Following genres and names, reminders and calendar feeds stay free and always will. Premium
        is for the parts that cost us something to run.
      </p>

      {notice ? <p class="feedback">{notice}</p> : null}
      {error ? <p class="feedback error">{error}</p> : null}

      {/* Somebody who arrived from a gate is told which one, so the page answers
          the question they actually had rather than making them find it. */}
      {want === 'friends' ? (
        <p class="feedback">Sharing your line with named people is part of premium.</p>
      ) : want === 'history' ? (
        <p class="feedback">
          Reading past the last {freeHistoryDays} days of a conversation is part of premium.
        </p>
      ) : null}

      <ul class="features">
        <li>
          <strong>Share streams with your friends.</strong> Share your line with the people you
          choose, instead of the whole site. A shared list is playable in the browser and nowhere
          else — no downloadable file, no address — because the address is your provider password.
        </li>
        <li>
          <strong>Private messaging history.</strong> Keep every message you have ever sent or
          received, not just the recent ones. Free accounts see the last {freeHistoryDays} days;
          nothing older is ever deleted, and joining brings all of it back.
        </li>
        <li>
          <strong>Earn {rate} on the people you invite.</strong> Earn a share of what the people you
          bring in spend. It is {rate} of what anybody who signed up through your link spends here,
          for as long as they have an account.
        </li>
      </ul>

      {membership ? (
        <section>
          <h2>Your membership</h2>
          <p>
            Runs until <LocalTime at={membership.expires_at} />. Renewing before then adds another{' '}
            {term(termDays)} to the end of it rather than starting again — you never lose time you
            have already paid for.
          </p>
          <form method="post" action="/api/membership/buy">
            <button class="cta" type="submit" disabled={!paymentsEnabled}>
              Renew for {money(priceCents, currency)}
            </button>
          </form>
        </section>
      ) : (
        <section>
          <h2>Join</h2>
          {paymentsEnabled ? (
            <>
              <p>
                {money(priceCents, currency)} for {term(termDays)}, paid in crypto through CoinPay.
                It does not renew itself — there is nothing to cancel and no card on file.
              </p>
              {user ? (
                <form method="post" action="/api/membership/buy">
                  <button class="cta" type="submit">
                    Become a member — {money(priceCents, currency)}
                  </button>
                </form>
              ) : (
                /* A checkout has to attach to an account, because the webhook
                   credits one. Sending a signed-out visitor to it would take
                   their money and have nowhere to put the membership. */
                <a class="cta" href="/login">
                  Sign in to join
                </a>
              )}
            </>
          ) : (
            /* Never a dead button. If money cannot be taken, the page says so
               rather than sending somebody to a checkout that will fail. */
            <p class="empty">Payments are not switched on here at the moment.</p>
          )}
        </section>
      )}

      {user ? null : (
        <p class="feedback">
          <a href="/login">Sign in</a> to join, or to see what your invites have earned.
        </p>
      )}

      {user ? (
        <>
          <section>
            <h2>Your invite link</h2>
            <p>
              Anybody who makes an account through this link is yours, permanently. You earn {rate}{' '}
              of what they spend from then on.
            </p>
            <p class="invite-link">
              <code>{inviteUrl}</code>
            </p>
            <p>
              <a href="/invite">Send it by email</a>, or paste it anywhere you like — a link costs
              nothing and has no limit.
            </p>
          </section>

          <section>
            <h2>Earnings</h2>
            {earnings.length === 0 ? (
              <p class="empty">
                Nothing yet. You are credited when somebody who joined through your link pays for
                something, not when they sign up.
              </p>
            ) : (
              <ul class="earnings">
                {earnings.map((e) => (
                  <li>
                    <strong>{money(e.accrued_cents, e.currency)}</strong> owed
                    {e.paid_cents > 0 ? (
                      <> · {money(e.paid_cents, e.currency)} already paid</>
                    ) : null}{' '}
                    · {e.n} {e.n === 1 ? 'payment' : 'payments'}
                  </li>
                ))}
              </ul>
            )}

            {/* Deliberately explicit. There is no automated payout here, and a
            balance with no stated way of reaching somebody reads as a promise. */}
            <p class="muted">
              Commission is settled by hand. Tell us where to send it and we will; without an
              address and a chain there is nowhere for it to go, so both are needed together.
            </p>
            <form method="post" action="/api/membership/payout">
              <label class="field">
                <span>Payout address</span>
                <input
                  name="address"
                  maxlength="120"
                  value={payout?.payout_address ?? ''}
                  placeholder="Your wallet address"
                />
              </label>
              <label class="field">
                <span>Chain</span>
                <input
                  name="chain"
                  maxlength="16"
                  value={payout?.payout_chain ?? ''}
                  placeholder="BTC, ETH, SOL…"
                />
              </label>
              <button class="ghost" type="submit">
                Save payout details
              </button>
            </form>

            {ledger.length > 0 ? (
              <ul class="ledger">
                {ledger.map((row) => (
                  <li>
                    <strong>{money(row.amount_cents, row.currency)}</strong> from{' '}
                    {nameOf({
                      display_name: row.buyer_name,
                      handle: row.buyer_handle,
                    })}{' '}
                    · {row.status} · <LocalTime at={row.created_at} />
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section>
            <h2>People you brought in</h2>
            {invited.length === 0 ? (
              <p class="empty">Nobody yet.</p>
            ) : (
              <ul class="invited">
                {invited.map((p) => (
                  <li>
                    {nameOf(p)} · <LocalTime at={p.claimed_at} />
                    {p.has_earned ? <span class="pill">has paid</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </Layout>
  );
};
