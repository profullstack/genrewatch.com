import { config } from '@genre/config';
import { html } from 'hono/html';
import { assetUrl } from '../lib/asset-version.js';

/**
 * The single HTML shell. Everything renders through here, including the signed-out
 * landing page -- a second shell is how site-wide tags end up missing for exactly
 * the visitors who matter most.
 */
export const Layout = (props) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <title>
        {props.title ? `${props.title} · GenreWatch` : 'GenreWatch — never miss a release'}
      </title>
      <meta
        name="description"
        content={
          props.description ?? 'Follow a genre or a name and get told before it drops. Free.'
        }
      />
      {/* Matches the stylesheet's ground so browser chrome and the PWA splash do
          not flash white before a dark page paints. */}
      <meta name="theme-color" content="#12161f" />
      <link rel="manifest" href="/manifest.webmanifest" />

      {/* Deliberately NOT linking the 1254x1254 /favicon.png the generator emits:
          it is the same 1.4MB source image as the logo, and browsers would fetch it
          on every page to draw a 16px tab icon. The generated sizes are the point. */}
      {/* Versioned like the stylesheet: icons sit behind a week-long cache, so
          redrawing one under its own name reaches nobody who has already visited.
          A new hash is a new URL, which is the only thing a cache respects. */}
      <link rel="icon" type="image/png" sizes="32x32" href={assetUrl('icons/favicon-32.png')} />
      <link rel="icon" type="image/png" sizes="16x16" href={assetUrl('icons/favicon-16.png')} />
      {[180, 152, 144, 120, 76].map((s) => (
        <link
          key={s}
          rel="apple-touch-icon"
          sizes={`${s}x${s}`}
          href={assetUrl(`icons/apple-touch-icon-${s}x${s}.png`)}
        />
      ))}

      <meta name="apple-mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      <meta name="apple-mobile-web-app-title" content="GenreWatch" />
      <meta name="mobile-web-app-capable" content="yes" />
      <meta name="msapplication-TileColor" content="#12161f" />
      <meta name="msapplication-config" content="/icons/browserconfig.xml" />
      <meta
        name="msapplication-TileImage"
        content={assetUrl('icons/apple-touch-icon-144x144.png')}
      />

      {/* Autodiscovery: a reader pointed at any page finds the feed without being
          told where it is. props.feedUrl narrows it to the genre or name in view. */}
      <link
        rel="alternate"
        type="application/rss+xml"
        title="GenreWatch — everything"
        href="/feeds/all.xml"
      />
      {props.feedUrl ? (
        <link
          rel="alternate"
          type="application/rss+xml"
          title={props.feedTitle ?? 'Upcoming'}
          href={props.feedUrl}
        />
      ) : null}

      <link rel="stylesheet" href={assetUrl('styles.css')} />
      {props.canonical ? (
        <link rel="canonical" href={`${config.siteUrl}${props.canonical}`} />
      ) : null}
      <meta property="og:title" content={props.title ?? 'GenreWatch'} />
      <meta property="og:type" content="website" />
      <meta property="og:image" content={`${config.siteUrl}/icons/icon-512x512.png`} />
      <meta name="twitter:card" content="summary" />

      {/*
        Traffic counting, when a site id is configured.

        In the head with `async`, not deferred at the end of the body: a page
        view should be counted even if the reader leaves before the rest of the
        document finishes, and async means it never delays first paint. That is
        also why this is not a translation of a framework's "afterInteractive" --
        this is Hono JSX with no <Script> component, and for analytics the
        earlier hook is the right one.

        The id comes from configuration and has NO default. It used to be
        hardcoded, which is how this site spent its first day reporting into the
        sibling site's dashboard: the value came across with the repo when it was
        cloned, and nothing looked wrong. Every page renders through this layout,
        so there is exactly one place to get it right.
      */}
      {config.analytics.enabled ? (
        <script
          src="https://crawlproof.com/stats.js"
          data-site={config.analytics.crawlproofSite}
          async
        />
      ) : null}
    </head>
    {/* Carries the zone the server has on file, so app.js can report a correction
        from any page rather than only from settings -- someone who never opens
        settings would otherwise get every reminder email stamped in UTC. */}
    {/* data-tz is the zone the visitor CHOSE, and wins over the browser's when set:
        a setting that does not change what you see is not a setting. data-known-tz
        is what the server currently has on file, so the client only reports a
        correction when it genuinely differs. */}
    <body
      data-tz={props.user?.timezone ?? null}
      data-known-tz={props.user ? (props.user.timezone ?? 'UTC') : null}
    >
      <a class="skip" href="#main">
        Skip to content
      </a>
      <header class="topbar">
        {/*
          The wordmark where there is room, the square mark where there is not.

          A <picture> rather than two <img>s with CSS display toggling: the browser
          picks ONE source and downloads only that, where a hidden <img> is still
          fetched. It also works with no JavaScript and no layout shift, because
          each source declares its own dimensions -- which matters here since the
          two shapes have different aspect ratios (3:1 and 1:1).

          Both are generated derivatives. The source art is 436KB and 722KB, which
          is fine to keep and absurd to put in a header on a phone.
        */}
        <a class="brand" href="/">
          <picture>
            <source
              media="(max-width: 34rem)"
              srcset={assetUrl('logo-mark.png')}
              width="96"
              height="96"
            />
            <img
              src={assetUrl('logo-wide.png')}
              alt="GenreWatch"
              width="480"
              height="160"
              class="brand-logo"
            />
          </picture>
        </a>

        {/*
          The search box, in the header, on every page.

          A plain GET form pointed at the page that already existed. No script, no
          suggestion dropdown, no fetch on keypress: it works before app.js loads,
          it works with app.js blocked, and the browser's own history gives back
          the last thing typed for free. `type="search"` is what puts the clear
          button in it on iOS.

          `props.q` puts the current query back in the box on the results page, so
          refining a search means editing what you typed rather than retyping it.
        */}
        <search class="topsearch">
          <form class="topsearch-form" method="get" action="/search">
            <label class="visually-hidden" for="topsearch-q">
              Search
            </label>
            <input
              id="topsearch-q"
              type="search"
              name="q"
              value={props.q ?? ''}
              placeholder="Search everything"
              autocomplete="off"
              enterkeyhint="search"
            />
            <button type="submit" class="ghost">
              Go
            </button>
          </form>
        </search>

        <nav>
          <a href="/genres">Genres</a>
          <a href="/feeds">Feeds</a>
          {props.user ? <a href="/following">My calendar</a> : null}
          {/* Only once there is a handle: without one there is no page to link to,
              and an item that 404s is worse than no item. */}
          {props.user?.handle ? <a href={`/u/${props.user.handle}`}>Profile</a> : null}
          {props.user ? (
            <a href="/messages">
              Messages
              {props.user.unread ? (
                <span class="unread-count">
                  {props.user.unread > 99 ? '99+' : props.user.unread}
                </span>
              ) : null}
            </a>
          ) : null}
          {props.user ? <a href="/invite">Invite</a> : null}
          {/* Shown to everybody, member or not. A member needs it to check what
              they have earned, and somebody who is not needs to be able to find
              out what it costs -- a link that disappears once you join is a link
              nobody can use to look at their own balance. */}
          <a href="/premium">Premium</a>
          {props.user ? (
            <a href="/settings">Settings</a>
          ) : (
            <a class="cta" rel="nofollow" href="/login">
              Sign in
            </a>
          )}
        </nav>
      </header>

      <main id="main">{props.children}</main>

      <footer>
        <p>
          GenreWatch is free. Times are shown in your own time zone (
          <span data-tz-label>your device</span>).
        </p>
        <p class="muted">
          Schedule data from{' '}
          <a href="https://www.espn.com" rel="noopener nofollow">
            ESPN
          </a>
          's public API. Not affiliated with ESPN.
        </p>
        <p class="muted">
          <a href="/sports">Browse sports</a> · <a href="/about">About</a> ·{' '}
          <a href="/feeds">RSS &amp; calendars</a> · <a href="/api/v1">Public API</a>
        </p>
      </footer>

      {/* Registers the service worker and wires the push opt-in. Everything on the
          site works without this file -- it only adds notifications. */}
      <script src={assetUrl('vendor-webauthn.js')} defer />
      <script src={assetUrl('app.js')} defer />
      {props.vapidKey ? html`<script>window.__VAPID = "${props.vapidKey}";</script>` : null}
      {/* One page needs a script of its own; the rest must not carry it. */}
      {props.script ? <script src={props.script} defer /> : null}

      {/*
        The ad runtime, once, and only where a unit can exist.

        A plain deferred script -- there is no <Script> component here, this is
        not Next, and the generated patch that assumed otherwise would have
        failed the build. Deferred rather than async because ad.js scans the DOM
        once at DOMContentLoaded and does not observe later mutations: it has to
        run after the document is parsed or it finds nothing to fill.
      */}
      {config.ads.enabled ? <script src="https://crawlproof.com/ad.js" defer /> : null}
    </body>
  </html>
);
