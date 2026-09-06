import { LocalTime } from './components.jsx';
import { Layout } from './Layout.jsx';

/**
 * Live TV passes: the page that sells one, and the card that points at it.
 *
 * Two rules. Every figure here is passed in from configuration or a query --
 * there is no "$1" in the markup, for the reason premium.jsx gives. And the
 * provider is never named: the reader buys live TV from us, plays it here, and
 * what we buy it from is our business. Nothing on this page, in the settings
 * card or on a channel row says who that is.
 *
 * Kept in step with the sibling brand's copy of this file, which sells the same
 * thing to people who follow sport rather than releases. The differences are the
 * words a reader sees; the props, the routes and the prices are identical.
 */

const money = (cents, currency = 'USD') =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format((cents ?? 0) / 100);

const termWord = { week: 'a week', month: 'a month', year: 'a year' };
const planTitle = { week: 'Week', month: 'Month', year: 'Year' };

/** "$1 a week"; a year is said as what it works out to per month. */
const priceLine = (plan) =>
  plan.perMonthCents
    ? `${money(plan.perMonthCents, plan.currency)} a month, ${money(plan.priceCents, plan.currency)} for the year`
    : `${money(plan.priceCents, plan.currency)} ${termWord[plan.key]}`;

/** The cheapest way in, for a card that has one line to say it. */
export const fromPrice = (plans) => {
  const cheapest = [...plans].sort((a, b) => a.priceCents / a.days - b.priceCents / b.days)[0];
  const weekly = plans.find((p) => p.key === 'week') ?? cheapest;
  return weekly ? `${money(weekly.priceCents, weekly.currency)} ${termWord[weekly.key]}` : null;
};

/**
 * The card a title page shows a reader with no list: what a pass is, what it
 * costs, and one button. `eventId` sends them back to this title once paid.
 */
export const LiveUpsell = ({ plans, eventId = null, signedIn = false }) => {
  if (!plans?.length) return null;
  const back = eventId ? `?event=${eventId}` : '';
  return (
    <div class="card live-upsell">
      <div class="card-head">
        <h3 class="card-title">Watch it here</h3>
        <p class="card-desc">
          Films, shows and live channels in your browser, from {fromPrice(plans)}. No app and
          nothing to configure: buy a pass and whatever carries a title turns up on its page.
        </p>
      </div>
      <div class="card-actions">
        <a class="cta" href={`/live${back}`}>
          {signedIn ? 'Get a pass' : 'See the passes'}
        </a>
      </div>
    </div>
  );
};

export const LivePage = ({
  user,
  plans = [],
  pass = null,
  managed = false,
  hasOwnList = false,
  history = [],
  paymentsEnabled = true,
  enabled = true,
  eventId = null,
  notice = null,
  error = null,
}) => {
  const back = eventId ? `?event=${eventId}` : '';
  return (
    <Layout
      title="Live TV"
      user={user}
      description={`Watch films, shows and live channels in your browser on GenreWatch, from ${
        fromPrice(plans) ?? 'a dollar a week'
      }.`}
    >
      <div class="page-head">
        <h1>Live TV</h1>
        {pass ? (
          <span class="pill">
            Pass until <LocalTime at={pass.expires_at} />
          </span>
        ) : null}
      </div>

      {notice ? <p class="feedback ok">{notice}</p> : null}
      {error ? <p class="feedback error">{error}</p> : null}

      <p class="lead">
        Films, shows and live channels, played right here on the page for the thing you followed.
        Open a title, press Play, and it is on -- in the browser you are already in, on a phone, a
        laptop or a TV box. Nothing to install and nothing to configure.
      </p>

      {!enabled ? (
        <p class="empty">Passes are not on sale right now.</p>
      ) : !paymentsEnabled ? (
        <p class="empty">Payments are not switched on here.</p>
      ) : null}

      {enabled && paymentsEnabled ? (
        <section class="plans">
          <h2>{pass ? 'Add time' : 'Pick a pass'}</h2>
          {pass ? (
            <p class="muted small">
              Time you buy is added to the end of what you hold, so buying early costs you nothing.
            </p>
          ) : null}
          <ul class="plan-list">
            {plans.map((plan) => (
              <li class={`card plan${plan.key === 'year' ? ' plan-best' : ''}`}>
                <div class="card-head">
                  <h3 class="card-title">{planTitle[plan.key]}</h3>
                  <p class="card-desc plan-price">{priceLine(plan)}</p>
                </div>
                {user ? (
                  <form method="post" action="/api/live/buy">
                    <input type="hidden" name="plan" value={plan.key} />
                    {eventId ? <input type="hidden" name="event" value={String(eventId)} /> : null}
                    <button class="cta" type="submit">
                      {pass ? `Add ${termWord[plan.key]}` : `Buy ${termWord[plan.key]}`}
                    </button>
                  </form>
                ) : (
                  <a class="cta" href={`/login?next=${encodeURIComponent(`/live${back}`)}`}>
                    Sign in to buy
                  </a>
                )}
              </li>
            ))}
          </ul>
          <p class="muted small">
            Paid in crypto through the same checkout as Premium. Access begins the moment the
            payment settles, usually within a few minutes.
          </p>
        </section>
      ) : null}

      {user && pass ? (
        <section>
          <h2>Your channels</h2>
          {managed ? (
            <p class="ok">
              Your channels are set up. Open anything you follow and look for{' '}
              <strong>In your list</strong>; the entries there play with the Play button.
            </p>
          ) : hasOwnList ? (
            <>
              <p class="muted">
                You have a list of your own in <a href="/settings">settings</a>, so your pass is not
                in use. Switch to ours whenever you like; your own address is kept and given back
                when the pass ends.
              </p>
              <form method="post" action="/api/live/use">
                <button class="ghost" type="submit">
                  Use the pass instead of my list
                </button>
              </form>
            </>
          ) : (
            <>
              <p class="feedback error">
                Your channels are not set up yet. This usually finishes on its own within a minute
                of payment; if it has not, press the button.
              </p>
              <form method="post" action="/api/live/use">
                <button class="cta" type="submit">
                  Set up my channels
                </button>
              </form>
            </>
          )}
        </section>
      ) : null}

      {user && history.length > 0 ? (
        <section>
          <h2>Receipts</h2>
          <ul class="ledger">
            {history.map((h) => (
              <li>
                <span>
                  {planTitle[h.plan] ?? h.plan} · <LocalTime at={h.started_at} /> to{' '}
                  <LocalTime at={h.expires_at} />
                </span>
                <span class="mono">{money(h.price_cents, h.currency)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2>The small print</h2>
        <ul class="muted small">
          <li>
            A pass plays on this site, to your own signed-in session. It cannot be exported to
            another player or shared with another account.
          </li>
          <li>
            Entries are checked before they are offered. A slot listed by a provider can still be
            empty; when it is, the page says so rather than playing nothing.
          </li>
          <li>A pass is not refundable once it has started.</li>
        </ul>
      </section>
    </Layout>
  );
};
