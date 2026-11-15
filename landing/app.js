// The landing page's script: the theme button, the tabs of the live example,
// and the download links. The page works without it; the script only improves
// what is already there.
(function () {
  'use strict';

  var REPO = 'aayushch/codjiva';
  var root = document.documentElement;
  var one = function (selector) {
    return document.querySelector(selector);
  };
  var all = function (selector) {
    return Array.prototype.slice.call(document.querySelectorAll(selector));
  };

  // ---- theme The button switches between light and dark and saves the choice
  // in the browser. The attribute `data-mode="light"` on the root element
  // selects the light colours in styles.css.
  var themeButton = one('#theme');
  if (themeButton) {
    themeButton.addEventListener('click', function () {
      var light = root.getAttribute('data-mode') !== 'light';
      if (light) root.setAttribute('data-mode', 'light');
      else root.removeAttribute('data-mode');
      try {
        localStorage.setItem('codjiva-mode', light ? 'light' : 'dark');
      } catch {
        // A browser that blocks storage keeps the theme for this visit only.
      }
      showDemo();
    });
  }

  // ---- live example Each tab shows one page from the demo folder in the
  // frame. `note` is the line next to the tabs, and `keys` says whether the row
  // of film keys under the frame applies.
  var DEMOS = {
    film: {
      src: 'demo/film.html',
      title: 'A Codjiva film: how an order moves through the orders Handler',
      note: 'A film follows one order through the file · 4 chapters · 1 min 23 s',
      keys: true,
    },
    visual: {
      src: 'demo/visual.html',
      title: 'A Codjiva visual of the same Go file',
      note: 'A still visual of the same file · hover and click the machines, open the numbered markers, drag to pan, scroll to zoom',
      keys: false,
    },
    pipeline: {
      src: 'demo/pipeline.html',
      title: 'A Codjiva pipeline of two Go files',
      note: 'A pipeline · the handler and the file store it writes to, joined at the call between them',
      keys: false,
    },
  };
  var frame = one('#demo-frame');
  var note = one('#demo-note');
  var keys = one('#demo-keys');
  // The example on show. It starts as the film, which the page's own markup
  // already loads.
  var shown = 'film';
  // Loads the example on show into the frame, in the page's theme. An example
  // page is drawn in its light palette when its address ends in `?theme=light`.
  // The frame is left alone when it already shows that address, so a film that
  // is playing is not started again for nothing.
  function showDemo() {
    var demo = DEMOS[shown];
    if (!demo || !frame) return;
    var address =
      demo.src +
      (root.getAttribute('data-mode') === 'light' ? '?theme=light' : '');
    if (frame.getAttribute('src') !== address)
      frame.setAttribute('src', address);
    frame.title = demo.title;
    if (note) note.textContent = demo.note;
    if (keys) keys.hidden = !demo.keys;
  }
  all('.tab[data-demo]').forEach(function (tab) {
    tab.addEventListener('click', function () {
      shown = tab.getAttribute('data-demo');
      all('.tab[data-demo]').forEach(function (other) {
        other.setAttribute('aria-selected', other === tab ? 'true' : 'false');
      });
      showDemo();
    });
  });
  showDemo();
  // The example pages are built when the site is published. In a local copy
  // that has not run scripts/landing.sh they are missing, and the frame would
  // show the browser's error page. A request for the film page tells the two
  // cases apart. On a page opened from a file no such request can be made, so
  // the frame is left as it is.
  if (frame && window.fetch && location.protocol !== 'file:') {
    fetch('demo/film.html', { method: 'HEAD' })
      .then(function (response) {
        if (response.ok) return;
        frame.hidden = true;
        var missing = one('#demo-missing');
        if (missing) missing.hidden = false;
      })
      .catch(function () {});
  }

  // ---- downloads Which system the visitor is on, as far as the browser says:
  // 'mac', 'windows', 'linux', or null when it cannot be told or is a phone or
  // tablet.
  function visitorSystem() {
    var agent = navigator.userAgent.toLowerCase();
    if (/android|iphone|ipad|ipod/.test(agent)) return null;
    if (agent.indexOf('mac') >= 0)
      return navigator.maxTouchPoints > 1 ? null : 'mac';
    if (agent.indexOf('win') >= 0) return 'windows';
    if (agent.indexOf('linux') >= 0 || agent.indexOf('x11') >= 0)
      return 'linux';
    return null;
  }
  var SYSTEM_NAMES = { mac: 'macOS', windows: 'Windows', linux: 'Linux' };

  // What a release file is, judged by its name. Returns null for files that are
  // not installers, such as signatures and update manifests.
  function describeAsset(name) {
    var lower = name.toLowerCase();
    var arm = /aarch64|arm64/.test(lower);
    if (/\.dmg$/.test(lower))
      return {
        system: 'mac',
        label: 'macOS · ' + (arm ? 'Apple silicon' : 'Intel'),
        kind: '.dmg',
        order: arm ? 0 : 1,
      };
    if (/setup\.exe$/.test(lower))
      return {
        system: 'windows',
        label: 'Windows · installer',
        kind: '.exe',
        order: 2,
      };
    if (/\.msi$/.test(lower))
      return {
        system: 'windows',
        label: 'Windows · MSI package',
        kind: '.msi',
        order: 3,
      };
    if (/\.appimage$/.test(lower))
      return {
        system: 'linux',
        label: 'Linux · AppImage',
        kind: '.AppImage',
        order: 4,
      };
    if (/\.deb$/.test(lower))
      return {
        system: 'linux',
        label: 'Linux · Debian and Ubuntu',
        kind: '.deb',
        order: 5,
      };
    if (/\.rpm$/.test(lower))
      return {
        system: 'linux',
        label: 'Linux · Fedora and RHEL',
        kind: '.rpm',
        order: 6,
      };
    return null;
  }

  var system = visitorSystem();
  if (system) {
    all('[data-dl-label]').forEach(function (el) {
      el.textContent = 'Download for ' + SYSTEM_NAMES[system];
    });
  }

  // Lists the installers of the latest release in the download section, with
  // the ones for the visitor's system first, and points the main download
  // button at the first of those. When the release has no installers, the page
  // is left as it is.
  function showAssets(version, rawAssets) {
    var assets = rawAssets
      .map(function (raw) {
        var described = describeAsset(raw.name || '');
        return described
          ? {
              url: raw.browser_download_url,
              label: described.label,
              kind: described.kind,
              system: described.system,
              order: described.order,
            }
          : null;
      })
      .filter(Boolean)
      .sort(function (a, b) {
        var mineA = a.system === system ? 0 : 1;
        var mineB = b.system === system ? 0 : 1;
        return mineA - mineB || a.order - b.order;
      });
    if (!assets.length) return;
    var list = one('#assets');
    if (list) {
      list.textContent = '';
      assets.forEach(function (asset) {
        var link = document.createElement('a');
        link.className = 'asset' + (asset.system === system ? ' mine' : '');
        link.href = asset.url;
        var label = document.createElement('span');
        label.textContent = asset.label;
        var kind = document.createElement('small');
        kind.textContent = asset.kind;
        link.appendChild(label);
        link.appendChild(kind);
        list.appendChild(link);
      });
    }
    if (version) {
      all('[data-version]').forEach(function (el) {
        el.textContent = 'Version ' + version;
      });
      all('[data-dl-sub]').forEach(function (el) {
        el.textContent =
          'Version ' +
          version +
          '. The builds for your system are listed first.';
      });
    }
    if (system && assets[0].system === system) {
      all('[data-dl-link]').forEach(function (a) {
        a.href = assets[0].url;
        a.removeAttribute('target');
      });
    }
  }

  // Asks GitHub for the latest release. If the request fails, or there is no
  // release yet, the download links keep pointing at the releases page.
  if (window.fetch) {
    fetch('https://api.github.com/repos/' + REPO + '/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
    })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (release) {
        if (release)
          showAssets(
            String(release.tag_name || release.name || '').replace(/^v/, ''),
            release.assets || [],
          );
      })
      .catch(function () {});
  }
})();
