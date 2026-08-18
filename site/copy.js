/* Copy-to-clipboard buttons for command blocks.
 *
 * Opt-in via <pre data-copy> rather than applying to every <pre>: the homepage also renders a
 * sample digest in a <pre>, and offering to copy a fake WhatsApp message would be nonsense.
 *
 * The button is injected here rather than written into the markup so that with JavaScript off the
 * pages degrade to exactly what they were before -- readable commands and no dead control.
 */
(function () {
  'use strict';

  // Terminal prompts and Claude Code's "> " are typography, not part of the command. Pasting them
  // back into a shell is the single most common way a copied snippet fails.
  function commandText(pre) {
    return pre.textContent.replace(/\s+$/, '')
      .split('\n').map(function (line) { return line.replace(/^\s*[>$]\s?/, ''); }).join('\n');
  }

  // The old selection-based copy. Deprecated, but it needs no permission and no secure context,
  // so it is what makes this work from a file:// path or behind a blocked clipboard permission.
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:absolute;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function copy(text) {
    if (!navigator.clipboard || !window.isSecureContext) {
      return legacyCopy(text) ? Promise.resolve() : Promise.reject(new Error('copy failed'));
    }
    // writeText can sit pending forever rather than rejecting -- an unresolved clipboard permission
    // does exactly that -- which would leave the button silently stuck on "Copy". So the promise is
    // raced against a short timer, and a timeout falls back rather than waiting on it. The fallback
    // stays close enough to the click that the browser still treats it as user-initiated.
    return new Promise(function (resolve, reject) {
      var settled = false;
      var done = function (ok) {
        if (settled) return;
        settled = true;
        ok ? resolve() : (legacyCopy(text) ? resolve() : reject(new Error('copy failed')));
      };
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      setTimeout(function () { done(false); }, 500);
    });
  }

  var ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"' +
    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="9" y="9" width="11" height="11" rx="2"/>' +
    '<path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';

  document.querySelectorAll('pre[data-copy]').forEach(function (pre) {
    var wrap = document.createElement('div');
    wrap.className = 'copy-wrap';
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.setAttribute('aria-label', 'Copy command to clipboard');
    btn.innerHTML = ICON + '<span class="copy-label">Copy</span>';
    wrap.appendChild(btn);

    // Screen readers get the outcome announced; sighted users get the label change.
    var status = document.createElement('span');
    status.className = 'visually-hidden';
    status.setAttribute('role', 'status');
    wrap.appendChild(status);

    var reset;
    btn.addEventListener('click', function () {
      copy(commandText(pre)).then(function () {
        btn.classList.add('copied');
        btn.querySelector('.copy-label').textContent = 'Copied';
        status.textContent = 'Command copied to clipboard';
      }).catch(function () {
        btn.querySelector('.copy-label').textContent = 'Press ⌘C';
        status.textContent = 'Copy failed, select the command and press Command C';
      });
      clearTimeout(reset);
      reset = setTimeout(function () {
        btn.classList.remove('copied');
        btn.querySelector('.copy-label').textContent = 'Copy';
        status.textContent = '';
      }, 2000);
    });
  });
})();
