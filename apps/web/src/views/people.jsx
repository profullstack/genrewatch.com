import { LocalTime } from './components.jsx';
import { Layout } from './Layout.jsx';

/**
 * Messages: an inbox, and one conversation.
 *
 * Ported from the sibling brand, where this shipped first, and kept close to it so
 * a fix on either side crosses as a diff. Its ProfilePage and follower lists are
 * NOT here -- this site answers /u/:handle from pages.jsx already, and two profile
 * pages would be worse than one.
 *
 * The restraint is the same: a message thread publishes nothing about either party
 * beyond what they wrote to each other, and there is no email, no last-seen and no
 * read receipt shown to the sender.
 */

/**
 * What to call somebody in a list.
 *
 * A chosen display name, then the handle. Accounts have neither until their owner
 * visits Settings, and a magic link makes an account without asking -- so this has
 * to render something for a real person who has published no name at all. It says
 * so, rather than printing "@null" or falling back to a fragment of their email
 * address, which they never chose to publish either.
 */
const nameOf = (p) => p.display_name ?? (p.handle ? `@${p.handle}` : 'Someone');

export const Inbox = ({ user, threads }) => (
  <Layout title="Messages" user={user}>
    <h1>Messages</h1>
    {threads.length === 0 ? (
      <p class="empty">No messages yet. Open someone's profile and choose Message to start one.</p>
    ) : (
      <ul class="threads">
        {threads.map((t) => (
          <li class={t.unread ? 'unread' : ''}>
            <a href={`/messages/${t.handle}`}>
              <span class="thread-who">
                {nameOf(t)}
                {/* role="img" so the label is actually exposed: aria-label on a
                    bare span is ignored by screen readers and by the linter. */}
                {t.unread ? <span class="dot" role="img" aria-label="unread" /> : null}
              </span>
              <span class="thread-last muted">
                {t.outgoing ? 'You: ' : ''}
                {t.body.length > 90 ? `${t.body.slice(0, 90)}…` : t.body}
              </span>
              <LocalTime at={t.created_at} />
            </a>
          </li>
        ))}
      </ul>
    )}
  </Layout>
);

/**
 * One conversation. Oldest at the top, composer at the bottom.
 *
 * `olderCount` is the only thing here that knows about the paid tier, and it is a
 * number rather than a boolean on purpose: "there are 340 older messages" is a
 * sentence somebody can decide about, and an empty space is not.
 */
export const Thread = ({ user, other, messages, blocked, historyDays = null, olderCount = 0 }) => (
  <Layout title={nameOf(other)} user={user}>
    <ol class="crumbs" aria-label="Breadcrumb">
      <li>
        <a href="/messages">Messages</a>
      </li>
      <li aria-current="page">{nameOf(other)}</li>
    </ol>

    <div class="page-head">
      <h1>
        <a href={`/u/${other.handle}`}>{nameOf(other)}</a>
      </h1>
      <form method="post" action="/api/users/block" class="inline">
        <input type="hidden" name="handle" value={other.handle} />
        <button class="ghost small-btn danger" type="submit">
          Block
        </button>
      </form>
    </div>

    {blocked ? (
      <p class="feedback error">This conversation is closed. One of you has blocked the other.</p>
    ) : (
      <>
        {olderCount > 0 ? (
          <p class="feedback">
            {olderCount.toLocaleString('en-US')} older{' '}
            {olderCount === 1 ? 'message is' : 'messages are'} kept but not shown here — free
            accounts see the last {historyDays} days. <a href="/premium?want=history">Premium</a>{' '}
            opens the whole conversation. Nothing has been deleted.
          </p>
        ) : null}

        {messages.length === 0 ? (
          <p class="empty">Say something.</p>
        ) : (
          <ul class="messages">
            {messages.map((m) => (
              <li class={m.sender_id === user.id ? 'mine' : 'theirs'}>
                <p class="msg-body">{m.body}</p>
                <LocalTime at={m.created_at} />
              </li>
            ))}
          </ul>
        )}

        <form method="post" action="/api/messages">
          <input type="hidden" name="handle" value={other.handle} />
          <label class="field">
            <span>Message</span>
            <textarea name="body" required maxlength="4000" placeholder="Write a message" />
          </label>
          <button class="cta" type="submit">
            Send
          </button>
        </form>
      </>
    )}
  </Layout>
);
