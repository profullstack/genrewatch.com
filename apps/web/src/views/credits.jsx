import { config } from '@genre/config';
import { LocalTime } from './components.jsx';
import { Layout } from './Layout.jsx';

/**
 * Credit codes and scarce invites: the "Have a code?" card, the /redeem page,
 * /invites and the /i/<code> landing.
 *
 * Every number on these pages (days, how many invites are left) is passed in
 * from @genre/credits, for the reason premium.jsx gives: a figure written in
 * two places is a figure that will one day disagree with itself.
 */

const unitWord = (unit) => (unit === 'premium_days' ? 'Premium' : 'Live TV pass');
const daysWord = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;

/** What an accepted invite gives, in a sentence. Null when it gives nothing. */
export const bonusLine = (bonus) =>
  bonus ? `${daysWord(bonus.days)} of ${unitWord(bonus.unit)}` : null;

/** The form, on its own: settings, /live and /redeem all show it. */
export const RedeemCard = ({ code = '', next = '/settings', notice = null, error = null }) => (
  <section id="redeem" class="redeem">
    <h2>Have a code?</h2>
    <p class="muted small">
      Somebody gave you a code (it looks like <code>CR-XXXX-XXXX-XXXX-XXXX</code>)? Type it here and
      the days it carries are added to your account, after any you already hold.
    </p>
    {notice ? (
      <p class="feedback ok" role="status">
        {notice}
      </p>
    ) : null}
    {error ? (
      <p class="feedback error" role="alert">
        {error}
      </p>
    ) : null}
    <form method="post" action="/api/credits/redeem">
      <input type="hidden" name="next" value={next} />
      <label class="field">
        <span>Code</span>
        <input
          type="text"
          name="code"
          required
          maxlength={64}
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          placeholder="CR-XXXX-XXXX-XXXX-XXXX"
          value={code || undefined}
        />
      </label>
      <button class="cta" type="submit">
        Redeem
      </button>
    </form>
  </section>
);

/** The notice a redirect carries back after a redemption. */
export const redeemedNotice = (unit, days) =>
  unit && days ? `Redeemed: ${daysWord(Number(days))} of ${unitWord(unit)} added.` : null;

export const RedeemPage = ({ user, code = '', notice = null, error = null }) => (
  <Layout title="Redeem a code" user={user}>
    <h1>Redeem a code</h1>
    <RedeemCard code={code} next="/redeem" notice={notice} error={error} />
    <p class="muted small">
      {config.live.enabled ? (
        <>
          Live TV days are in <a href="/live">Live TV</a>;{' '}
        </>
      ) : null}
      Premium days are on <a href="/premium">Premium</a>.
    </p>
  </Layout>
);

const STATUS_WORD = {
  open: 'Not used yet',
  used: 'Accepted',
  revoked: 'Withdrawn',
  expired: 'Expired',
};

export const InvitesPage = ({
  user,
  quota,
  invites = [],
  bonus = null,
  created = null,
  notice = null,
  error = null,
  affiliateUrl = null,
}) => (
  <Layout title="Invites" user={user}>
    <h1>Invites</h1>
    <p class="lead">
      You have {quota.left} of {quota.total} invite{quota.total === 1 ? '' : 's'} left. Each one is
      a code that works once, for one person you pick.
      {bonus ? ` When they make an account with it, you both get ${bonusLine(bonus)}.` : ''}
    </p>

    {created ? (
      <section class="feedback ok" role="status">
        <p>New invite. Send this link to the person it is for; it is shown once, so copy it now:</p>
        <p class="invite-link">
          <code>{created.url}</code>
        </p>
      </section>
    ) : null}
    {notice ? <p class="feedback ok">{notice}</p> : null}
    {error ? <p class="feedback error">{error}</p> : null}

    {quota.left > 0 ? (
      <form method="post" action="/api/invites">
        <label class="field">
          <span>Who is it for? (only you see this)</span>
          <input type="text" name="note" maxlength={80} placeholder="Sam from work" />
        </label>
        <button class="cta" type="submit">
          Make an invite
        </button>
      </form>
    ) : (
      <p class="empty">No invites left. They are meant to be scarce.</p>
    )}

    {invites.length > 0 ? (
      <section>
        <h2>Your invites</h2>
        <ul class="ledger">
          {invites.map((i) => (
            <li>
              <span>
                {i.note || 'Invite'} · {STATUS_WORD[i.status] ?? i.status} · made{' '}
                <LocalTime at={i.created_at} />
              </span>
              {i.status === 'open' ? (
                <form method="post" action={`/api/invites/${encodeURIComponent(i.id)}/revoke`}>
                  <button class="ghost" type="submit">
                    Withdraw
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
        <p class="muted small">Withdrawing an unused invite gives you the slot back.</p>
      </section>
    ) : null}

    {affiliateUrl ? (
      <section>
        <h2>Your open link</h2>
        <p>
          Separate from these: your personal link has no limit, never expires, and anybody who joins
          through it is credited to you (see <a href="/invite">Invite people</a>).
        </p>
        <p class="invite-link">
          <code>{affiliateUrl}</code>
        </p>
      </section>
    ) : null}
  </Layout>
);

const LANDING_PROBLEM = {
  invalid: 'This invite is not one we issued. Check the link you were sent.',
  used: 'This invite has already been used.',
  revoked: 'This invite was withdrawn by the person who made it.',
  expired: 'This invite has expired.',
};

export const InviteLanding = ({ user, code, status, bonus = null }) => (
  <Layout title="You are invited" user={user}>
    <h1>{status === 'ok' ? 'You are invited' : 'Invite'}</h1>
    {status === 'ok' ? (
      <>
        <p class="lead">
          Somebody who uses GenreWatch picked you for one of their few invites.
          {bonus ? ` Make an account with it and you both get ${bonusLine(bonus)}.` : ''}
        </p>
        {user ? (
          <p class="muted">
            You are already signed in, and invites are for new accounts. Pass it on to somebody who
            has not joined yet.
          </p>
        ) : (
          <>
            <p>
              <a class="cta" href={`/signup?invite=${encodeURIComponent(code)}`}>
                Create your account
              </a>
            </p>
            <p class="muted small">
              The invite is saved with your sign-up, so the emailed link counts even if you open it
              on another device.
            </p>
          </>
        )}
      </>
    ) : (
      <>
        <p class="feedback error">{LANDING_PROBLEM[status] ?? LANDING_PROBLEM.invalid}</p>
        <p>
          You can still <a href="/signup">make an account</a>; it is free.
        </p>
      </>
    )}
  </Layout>
);
