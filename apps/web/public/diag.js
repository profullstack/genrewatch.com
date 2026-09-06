/**
 * What this browser can actually do, measured rather than guessed.
 *
 * Written for one question we could not answer from a desk: a Fire TV's Silk
 * browser showed no Multiview and no notification toggle, and every published
 * answer about Silk's capabilities contradicts the next -- its Chromium version
 * varies by device and by year, and Amazon's own documentation does not say
 * whether push exists at all. So the device answers for itself.
 *
 * Three rules hold this file's shape:
 *
 *   - It depends on NOTHING. Not app.js, not the stylesheet, not a framework.
 *     If the page under test is broken because the main bundle will not parse on
 *     an old engine, a diagnostics page that imports it is broken in the same
 *     way and reports nothing. Plain no optional chaining and no
 *     nullish coalescing anywhere in it, for the same reason: those are the two
 *     tokens an older engine chokes on, and one of them here would make the file
 *     a syntax error instead of a report saying the engine is too old.
 *   - It never asks for a permission. Probing whether push EXISTS must not
 *     produce a prompt on somebody's television; permission state is read, never
 *     requested.
 *   - Everything it finds is printed large enough to read across a room, because
 *     the device it runs on is ten feet away and has no clipboard.
 */

(() => {
  const out = document.getElementById('report');
  const keyBox = document.getElementById('keylog');
  const sendBtn = document.getElementById('send');
  const sendMsg = document.getElementById('send-msg');
  const lines = [];

  /** One finding. `state` is yes/no/warn/info and only colours the row. */
  function add(group, name, state, detail) {
    lines.push({ group: group, name: name, state: state, detail: detail == null ? '' : detail });
  }

  /** Does this global exist, without touching it in a way that could throw. */
  function has(obj, key) {
    try {
      return key in obj;
    } catch (e) {
      return false;
    }
  }

  /* ------------------------------------------------------------ the device -- */

  add('Device', 'User agent', 'info', navigator.userAgent);
  add(
    'Device',
    'Screen',
    'info',
    screen.width + ' x ' + screen.height + ' css px, ratio ' + (window.devicePixelRatio || 1),
  );
  add('Device', 'Window', 'info', window.innerWidth + ' x ' + window.innerHeight + ' css px');
  add('Device', 'Language', 'info', navigator.language || 'unknown');
  // A television reports a coarse pointer or none at all. This is what decides
  // whether a drag handle is a control or a decoration.
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const noPointer = window.matchMedia && window.matchMedia('(pointer: none)').matches;
  add(
    'Device',
    'Pointer',
    'info',
    noPointer
      ? 'none (remote or keyboard only)'
      : coarse
        ? 'coarse (touch or remote)'
        : 'fine (mouse)',
  );
  add('Device', 'Touch points', 'info', String(navigator.maxTouchPoints || 0));

  /* ------------------------------------------------------ notifications -- */

  const swOk = has(navigator, 'serviceWorker');
  const pushOk = has(window, 'PushManager');
  const notifOk = has(window, 'Notification');
  add('Notifications', 'Service worker', swOk ? 'yes' : 'no', swOk ? '' : 'no background code');
  add(
    'Notifications',
    'Push manager',
    pushOk ? 'yes' : 'no',
    pushOk ? '' : 'THIS is what hides the notification toggle',
  );
  add('Notifications', 'Notification API', notifOk ? 'yes' : 'no', '');
  if (notifOk) {
    let perm = 'unknown';
    try {
      perm = Notification.permission;
    } catch (e) {}
    // Read, never requested: a probe must not put a prompt on a television.
    add('Notifications', 'Permission (not asked)', perm === 'denied' ? 'warn' : 'info', perm);
  }
  add(
    'Notifications',
    'Verdict',
    swOk && pushOk ? 'yes' : 'no',
    swOk && pushOk ? 'web push can work here' : 'web push cannot work in this browser',
  );

  /* ------------------------------------------------------------- playback -- */

  const mseOk = has(window, 'MediaSource');
  add('Playback', 'MediaSource', mseOk ? 'yes' : 'no', mseOk ? '' : 'Play here cannot work at all');
  if (mseOk && window.MediaSource.isTypeSupported) {
    const codecs = [
      ['H.264 + AAC', 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"'],
      ['H.264 High', 'video/mp4; codecs="avc1.640028"'],
      ['H.265 / HEVC', 'video/mp4; codecs="hvc1.1.6.L93.B0"'],
      ['H.265 alt tag', 'video/mp4; codecs="hev1.1.6.L93.B0"'],
      ['AC-3 audio', 'video/mp4; codecs="ac-3"'],
      ['E-AC-3 audio', 'video/mp4; codecs="ec-3"'],
      ['VP9', 'video/webm; codecs="vp9"'],
      ['AV1', 'video/mp4; codecs="av01.0.05M.08"'],
    ];
    for (let i = 0; i < codecs.length; i++) {
      let ok = false;
      try {
        ok = window.MediaSource.isTypeSupported(codecs[i][1]);
      } catch (e) {}
      // H.264 is the one that decides whether the player works. The rest only
      // decide which channels play, which is why they are info and not failures.
      add(
        'Playback',
        codecs[i][0],
        ok ? 'yes' : i === 0 ? 'no' : 'info',
        ok ? '' : 'not decodable',
      );
    }
  }
  add(
    'Playback',
    'Element picture-in-picture',
    has(document, 'pictureInPictureEnabled') ? 'yes' : 'no',
    'one video at a time, any browser',
  );
  add(
    'Playback',
    'Document picture-in-picture',
    has(window, 'documentPictureInPicture') ? 'yes' : 'no',
    'the only way to float the whole grid; pointless on a TV',
  );

  /* --------------------------------------------------------------- the page -- */

  let ls = false;
  try {
    window.localStorage.setItem('tw.diag', '1');
    window.localStorage.removeItem('tw.diag');
    ls = true;
  } catch (e) {}
  add(
    'Page',
    'localStorage',
    ls ? 'yes' : 'no',
    ls ? '' : 'the remembered tile set cannot persist',
  );
  add('Page', 'BroadcastChannel', has(window, 'BroadcastChannel') ? 'yes' : 'no', '');
  add('Page', 'Fullscreen', has(document, 'fullscreenEnabled') ? 'yes' : 'no', '');
  let grid = false;
  let ar = false;
  try {
    grid = window.CSS && CSS.supports && CSS.supports('display', 'grid');
    ar = window.CSS && CSS.supports && CSS.supports('aspect-ratio', '16 / 9');
  } catch (e) {}
  add('Page', 'CSS grid', grid ? 'yes' : 'no', grid ? '' : 'the multiview layout needs it');
  add('Page', 'CSS aspect-ratio', ar ? 'yes' : 'no', ar ? '' : 'tiles will size wrong');
  // Modern syntax, tested by string so that an engine which cannot parse it says
  // so here instead of refusing to load app.js with no explanation.
  let modern = false;
  try {
    // biome-ignore lint/security/noGlobalEval: the point is to find out whether this parses
    modern = eval('(function(){const a={b:1};return a?.b ?? 0;})()') === 1;
  } catch (e) {}
  add(
    'Page',
    'Modern JS (optional chaining)',
    modern ? 'yes' : 'no',
    modern ? '' : 'app.js will not parse here, so nothing interactive works',
  );

  /* ------------------------------------------------------------------ paint -- */

  let html = '';
  let group = null;
  for (let j = 0; j < lines.length; j++) {
    const l = lines[j];
    if (l.group !== group) {
      group = l.group;
      html += '<h2>' + esc(group) + '</h2>';
    }
    html +=
      '<div class="row ' +
      esc(l.state) +
      '"><span class="k">' +
      esc(l.name) +
      '</span><span class="v">' +
      esc(l.state === 'yes' ? 'YES' : l.state === 'no' ? 'NO' : l.state === 'warn' ? '!' : '') +
      '</span><span class="d">' +
      esc(l.detail) +
      '</span></div>';
  }
  if (out) out.innerHTML = html;

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ------------------------------------------------------- what the remote sends -- */

  /*
   * A television remote is a keyboard nobody has the layout for. Fire TV sends
   * arrows and Enter as ordinary key events, but the Back button, the media keys
   * and the menu button vary by device and by app -- and code written against a
   * guess is code that traps somebody on a page with no way back. So: press
   * buttons, read what arrives.
   */
  const seen = [];
  document.addEventListener('keydown', (e) => {
    var line = 'key=' + e.key + '  code=' + (e.code || '-') + '  keyCode=' + e.keyCode;
    seen.unshift(line);
    if (seen.length > 8) seen.pop();
    if (keyBox) keyBox.textContent = seen.join('\n');
    // Arrows and Enter are what the grid will use, so they must not also scroll
    // the page while somebody is testing them here.
    if (e.key && e.key.indexOf('Arrow') === 0) e.preventDefault();
  });

  /* ------------------------------------------------------------------ send -- */

  /*
   * Reading a report aloud off a television is worse than sending it. This posts
   * it to the site, which writes one line to the server log -- signed in only,
   * so it is not an open pipe into our logs.
   */
  if (sendBtn) {
    sendBtn.addEventListener('click', () => {
      sendBtn.disabled = true;
      if (sendMsg) sendMsg.textContent = 'Sending…';
      const body = { ua: navigator.userAgent, findings: {} };
      for (let k = 0; k < lines.length; k++) {
        body.findings[lines[k].group + ' / ' + lines[k].name] =
          lines[k].state + ' ' + lines[k].detail;
      }
      fetch('/api/diag', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then((r) => {
          if (sendMsg) {
            sendMsg.textContent =
              r.status === 401
                ? 'Sign in on this device first, then press Send again.'
                : r.ok
                  ? 'Sent. It is in the server log now.'
                  : 'The site refused it (' + r.status + ').';
          }
          sendBtn.disabled = false;
        })
        .catch(() => {
          if (sendMsg) sendMsg.textContent = 'Could not reach the site.';
          sendBtn.disabled = false;
        });
    });
  }
})();
