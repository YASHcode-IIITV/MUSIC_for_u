(() => {
  if (document.getElementById("browser-lyrics-root")) return;

  const root = document.createElement("div");
  root.id = "browser-lyrics-root";
  const ui = root.attachShadow({ mode: "open" });
  ui.innerHTML = `<link rel="stylesheet" href="${chrome.runtime.getURL("overlay.css")}"><section id="browser-lyrics-card">
    <header id="browser-lyrics-head">
      <div id="browser-lyrics-row"><span id="browser-lyrics-label">NOW PLAYING</span><div><button id="browser-lyrics-popout" title="Keep visible over other apps" aria-label="Pop out player">↗</button><button id="browser-lyrics-close" title="Close lyrics" aria-label="Close lyrics">×</button></div></div>
      <div id="browser-lyrics-trackrow"><img id="browser-lyrics-cover" alt="" hidden><div>
      <div id="browser-lyrics-title">Finding a song…</div>
      <div id="browser-lyrics-artist"></div>
      </div></div>
      <div id="browser-lyrics-controls"><button data-action="previous" title="Previous track" aria-label="Previous track">⏮</button><button data-action="play" title="Play or pause" aria-label="Pause"><span class="play-icon" aria-hidden="true"></span></button><button data-action="next" title="Next track" aria-label="Next track">⏭</button></div>
      <div id="browser-lyrics-timeline"><div class="browser-lyrics-time-labels"><span id="browser-lyrics-current-time">0:00</span><span id="browser-lyrics-duration">0:00</span></div><input id="browser-lyrics-seek" type="range" min="0" max="1000" value="0" aria-label="Seek through song" disabled></div>
    </header>
    <details id="browser-lyrics-more">
      <summary><span>More options</span><span class="browser-lyrics-chevron" aria-hidden="true">⌄</span></summary>
      <div id="browser-lyrics-extras">
      <details id="browser-lyrics-search-section" open><summary><span>Search songs</span><span class="browser-lyrics-search-chevron" aria-hidden="true">⌄</span></summary>
      <div id="browser-lyrics-search"><input type="search" placeholder="Search YouTube Music"><button>Search</button></div>
      <div id="browser-lyrics-results" hidden></div>
      </details>
      <div id="browser-lyrics-script" hidden><span>LYRICS IN</span><button type="button" data-script="hinglish" aria-pressed="true">Hinglish</button><button type="button" data-script="original" aria-pressed="false">हिंदी</button></div>
      <div id="browser-lyrics-body"><div id="browser-lyrics-lines"><p id="browser-lyrics-message">Looking for synced lyrics…</p></div></div>
      <footer id="browser-lyrics-foot">Checking LRCLIB, Lyrics.ovh, and YouTube Music…</footer>
      </div>
    </details>
  </section>`;
  document.documentElement.append(root);

  const titleEl = ui.querySelector("#browser-lyrics-title");
  const artistEl = ui.querySelector("#browser-lyrics-artist");
  const linesEl = ui.querySelector("#browser-lyrics-lines");
  const footEl = ui.querySelector("#browser-lyrics-foot");
  let songKey = "";
  let currentLookupKey = "";
  let timedLines = [];
  let lyricLines = [];
  let originalLyricLines = [];
  let scriptMode = "original";
  let activeLyricLine = -1;
  let renderedLyricStart = -1;
  let poller;
  let pipWindow;
  let pipUi;
  let pipPoller;
  let searchQuery = "";
  let remoteSearchResults = [];
  let searchComplete = false;
  let searchError = "";
  let currentTrack = null;

  function syncPlaybackButton(view, playing) {
    const button = view?.querySelector('#browser-lyrics-controls [data-action="play"]');
    if (!button) return;
    button.classList.toggle("is-playing", !!playing);
    button.setAttribute("aria-label", playing ? "Pause" : "Play");
    button.title = playing ? "Pause" : "Play";
  }

  function queryDeep(selector, scope = document, results = []) {
    results.push(...scope.querySelectorAll(selector));
    for (const element of scope.querySelectorAll("*")) {
      if (element.shadowRoot) queryDeep(selector, element.shadowRoot, results);
    }
    return results;
  }

  function setArtworkTint(card, cover) {
    if (!card) return;
    if (cover) card.style.setProperty("--music-art", `url(${JSON.stringify(cover)})`);
    else card.style.removeProperty("--music-art");
  }

  ui.querySelector("#browser-lyrics-close").addEventListener("click", () => {
    root.remove();
  });

  function clickLocalPlayerControl(action) {
    const selectors = {
      previous: "ytmusic-player-bar #previous-button, ytmusic-player-bar .previous-button, #previous-button, .ytp-prev-button",
      next: "ytmusic-player-bar #next-button, ytmusic-player-bar .next-button, #next-button, .ytp-next-button",
      play: "ytmusic-player-bar #play-pause-button, ytmusic-player-bar .play-pause-button, #play-pause-button, .ytp-play-button"
    };
    const queryDeep = (selector, scope = document, results = []) => {
      results.push(...scope.querySelectorAll(selector));
      for (const element of scope.querySelectorAll("*")) {
        if (element.shadowRoot) queryDeep(selector, element.shadowRoot, results);
      }
      return results;
    };
    const candidates = queryDeep(selectors[action] || "");
    const labelPattern = action === "next" ? /\bnext\b/i : action === "previous" ? /\bprevious\b|\bback\b/i : /\bplay\b|\bpause\b/i;
    const labeled = queryDeep("button[aria-label], [role='button'][aria-label], tp-yt-paper-icon-button[aria-label], yt-icon-button[aria-label]")
      .filter((element) => labelPattern.test(`${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`));
    const target = [...candidates, ...labeled].find((element) => !element.disabled && element.getAttribute("aria-disabled") !== "true");
    if (target) {
      target.click();
      return true;
    }
    if (action === "play") {
      const media = [...document.querySelectorAll("audio, video")].find((item) => !item.ended);
      if (media) {
        if (media.paused) media.play().catch(() => {});
        else media.pause();
        return true;
      }
    }
    return false;
  }
  function seekLocalPlayer(seconds) {
    const queryDeep = (selector, scope = document, results = []) => {
      results.push(...scope.querySelectorAll(selector));
      for (const element of scope.querySelectorAll("*")) {
        if (element.shadowRoot) queryDeep(selector, element.shadowRoot, results);
      }
      return results;
    };
    const playerRoots = [...document.querySelectorAll("ytmusic-player-bar, ytmusic-player-page, ytmusic-player")];
    const media = [...document.querySelectorAll("audio, video"), ...playerRoots.flatMap((playerRoot) => queryDeep("audio, video", playerRoot))]
      .filter((item) => Number.isFinite(item.duration) && item.duration > 0 && !item.ended)
      .sort((a, b) => Number(a.paused) - Number(b.paused) || (b.currentTime || 0) - (a.currentTime || 0))[0];
    if (!media) return false;
    try {
      media.currentTime = Math.max(0, Math.min(Number(seconds) || 0, media.duration));
      return true;
    } catch (_error) {
      return false;
    }
  }
  function clickPlayerControl(action) {
    chrome.runtime.sendMessage({ type: "PLAYER_CONTROL", action }).then((reply) => {
      if (!reply?.ok) showMessage("The music tab didn’t receive this control. Reload the YouTube Music tab and try again.");
    }).catch(() => showMessage("Couldn’t reach the music tab. Keep it open and reload it once."));
  }
  ui.querySelectorAll("#browser-lyrics-controls button").forEach((button) => {
    button.addEventListener("click", () => clickPlayerControl(button.dataset.action));
  });
  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const whole = Math.floor(seconds);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  }
  function bindTimeline(view) {
    const slider = view.querySelector("#browser-lyrics-seek");
    slider.addEventListener("pointerdown", () => { slider.dataset.seeking = "true"; });
    slider.addEventListener("input", () => {
      slider.dataset.seeking = "true";
      const duration = Number(currentTrack?.duration) || 0;
      view.querySelector("#browser-lyrics-current-time").textContent = formatTime(duration * Number(slider.value) / Number(slider.max));
      slider.style.setProperty("--seek-progress", `${Number(slider.value) / Number(slider.max) * 100}%`);
    });
    slider.addEventListener("change", async () => {
      const duration = Number(currentTrack?.duration) || 0;
      const seconds = duration * Number(slider.value) / Number(slider.max);
      slider.dataset.seeking = "";
      const reply = await chrome.runtime.sendMessage({ type: "SEEK_PLAYER", seconds }).catch(() => null);
      if (!reply?.ok) showMessage("Seeking is not available for this player.");
    });
  }
  function updateTimeline(view, song) {
    const slider = view.querySelector("#browser-lyrics-seek");
    const rawDuration = Number(song?.duration);
    const duration = Number.isFinite(rawDuration) ? Math.max(0, rawDuration) : 0;
    const time = Math.max(0, Number(song?.time) || 0);
    slider.disabled = duration <= 0;
    if (!slider.dataset.seeking) {
      slider.value = duration ? String(Math.round(Math.min(time, duration) / duration * Number(slider.max))) : "0";
      view.querySelector("#browser-lyrics-current-time").textContent = formatTime(time);
    }
    slider.style.setProperty("--seek-progress", `${Number(slider.value) / Number(slider.max) * 100}%`);
    view.querySelector("#browser-lyrics-duration").textContent = formatTime(duration);
  }
  function transliterateHindiLine(text) {
    const vowels = { अ:"a", आ:"aa", इ:"i", ई:"i", उ:"u", ऊ:"oo", ऋ:"ri", ए:"e", ऐ:"ai", ओ:"o", औ:"au" };
    const matras = { "ा":"a", "ि":"i", "ी":"i", "ु":"u", "ू":"oo", "ृ":"ri", "े":"e", "ै":"ai", "ो":"o", "ौ":"au" };
    const consonants = { क:"k", ख:"kh", ग:"g", घ:"gh", ङ:"ng", च:"ch", छ:"chh", ज:"j", झ:"jh", ञ:"ny", ट:"t", ठ:"th", ड:"d", ढ:"dh", ण:"n", त:"t", थ:"th", द:"d", ध:"dh", न:"n", प:"p", फ:"ph", ब:"b", भ:"bh", म:"m", य:"y", र:"r", ल:"l", व:"w", श:"sh", ष:"sh", स:"s", ह:"h", क्ष:"ksh", त्र:"tr", ज्ञ:"gy", क़:"q", ख़:"kh", ग़:"gh", ज़:"z", ड़:"r", ढ़:"rh", फ़:"f" };
    const output = [];
    let inherentA = false;
    const chars = [...text];
    for (let i = 0; i < chars.length; i += 1) {
      let char = chars[i];
      if (/\s/.test(char)) {
        if (inherentA && output.at(-1) === "a") output.pop();
        output.push(char);
        inherentA = false;
        continue;
      }
      if (consonants[char]) {
        if (chars[i + 1] === "़" && consonants[`${char}़`]) {
          char += "़";
          i += 1;
        }
        const base = consonants[char];
        if (chars[i + 1] === "्") {
          output.push(base);
          i += 1;
          inherentA = false;
        } else if (matras[chars[i + 1]]) {
          output.push(base, matras[chars[i + 1]]);
          i += 1;
          inherentA = false;
        } else {
          output.push(base, "a");
          inherentA = true;
        }
        continue;
      }
      if (vowels[char]) {
        output.push(vowels[char]);
        inherentA = false;
      } else if (char === "ं" || char === "ँ") {
        output.push("n");
        inherentA = false;
      } else if (char === "ः") {
        output.push("h");
        inherentA = false;
      } else if (char === "़" || char === "्" || char === "‍" || char === "‌") {
        inherentA = false;
      } else {
        if (/[.,!?;:।॥]/.test(char) && inherentA && output.at(-1) === "a") output.pop();
        output.push(char);
        if (/[.,!?;:।॥]/.test(char)) inherentA = false;
      }
    }
    if (inherentA && output.at(-1) === "a") output.pop();
    return output.join("");
  }
  function setLyricsScript(mode) {
    if (!originalLyricLines.length) return;
    scriptMode = mode === "hinglish" ? "hinglish" : "original";
    lyricLines = scriptMode === "hinglish" ? originalLyricLines.map(transliterateHindiLine) : [...originalLyricLines];
    renderLyricWindow(activeLyricLine, true);
    for (const view of [ui, pipUi].filter(Boolean)) {
      view.querySelectorAll("#browser-lyrics-script button[data-script]").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.script === scriptMode));
      });
    }
    if (pipUi) pipUi.querySelector("#browser-lyrics-lines").innerHTML = linesEl.innerHTML;
  }
  function bindLyricsScript(view) {
    view.querySelector("#browser-lyrics-script").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-script]");
      if (button) setLyricsScript(button.dataset.script);
    });
  }
  bindLyricsScript(ui);
  bindTimeline(ui);
  function searchMusic(query) {
    query = query.trim();
    if (!query) return;
    searchQuery = query;
    remoteSearchResults = [];
    searchComplete = false;
    searchError = "";
    renderResults([]);
    chrome.runtime.sendMessage({ type: "SEARCH_ON_PLAYER", query });
  }
  ui.querySelector("#browser-lyrics-search button").addEventListener("click", () => searchMusic(ui.querySelector("#browser-lyrics-search input").value));
  ui.querySelector("#browser-lyrics-search input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") ui.querySelector("#browser-lyrics-search button").click();
  });
  ui.querySelector("#browser-lyrics-results").addEventListener("click", queueResultClick);

  ui.querySelector("#browser-lyrics-popout").addEventListener("click", async () => {
    if (!("documentPictureInPicture" in window)) {
      showMessage("This Brave version does not support a floating Picture-in-Picture player.");
      return;
    }
    try {
      pipWindow = await window.documentPictureInPicture.requestWindow({ width: 390, height: 700 });
      pipWindow.document.title = "Now Playing";
      pipWindow.document.body.style.cssText = "margin:0;min-width:320px;background:#101116;color:#f7f5fb;font:14px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;overflow:hidden";
      const floatingRoot = pipWindow.document.createElement("div");
      floatingRoot.id = "browser-lyrics-root-pip";
      pipUi = floatingRoot.attachShadow({ mode: "open" });
      pipUi.innerHTML = ui.innerHTML;
      const style = pipWindow.document.createElement("style");
      style.textContent = `
        *{box-sizing:border-box!important}
        :host{all:initial;display:block!important;position:static!important;width:100%!important;height:100vh!important;max-height:100vh!important;color-scheme:dark;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif!important}
        #browser-lyrics-card{height:100vh;max-height:100vh;display:flex;flex-direction:column;overflow:hidden;border:0;border-radius:0;background:linear-gradient(135deg,rgba(12,13,18,.48),rgba(12,13,18,.66)),var(--music-art,radial-gradient(ellipse at 20% 0%,#493b69,#17191f 70%));background-size:cover;background-position:center;color:#f7f5fb;box-shadow:none;backdrop-filter:none}
        #browser-lyrics-head{flex:none;padding:18px 20px 12px;border:0;background:linear-gradient(180deg,rgba(255,255,255,.035),transparent);cursor:default!important}
        #browser-lyrics-row{margin-bottom:18px}
        #browser-lyrics-label{display:inline-flex;align-items:center;gap:8px;color:#d0c4f7;font-size:10px;letter-spacing:.16em}
        #browser-lyrics-label:before{content:"";width:7px;height:7px;border-radius:50%;background:#a78bfa;box-shadow:0 0 12px #a78bfa}
        #browser-lyrics-row button{width:30px;height:30px;border-radius:50%;color:#d7d4df;font-size:20px;transition:background .18s,color .18s}
        #browser-lyrics-row button:hover{background:rgba(255,255,255,.12);color:white}
        #browser-lyrics-trackrow{gap:14px;margin:0 0 17px}
        #browser-lyrics-cover{width:68px;height:68px;flex:0 0 68px;border-radius:12px;object-fit:cover;box-shadow:0 7px 22px rgba(0,0,0,.35)}
        #browser-lyrics-title{margin:0;color:#fff;font-size:19px;line-height:1.2;letter-spacing:-.02em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
        #browser-lyrics-artist{margin-top:5px;color:#b9b5c5;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        #browser-lyrics-controls{gap:18px;padding:9px 0 15px;border:0}
        #browser-lyrics-controls button{width:42px;height:42px;padding:0;border:1px solid rgba(255,255,255,.06);border-radius:50%;background:rgba(255,255,255,.09);font-size:16px;transition:transform .15s,background .15s}
        #browser-lyrics-controls button:hover{transform:scale(1.06);background:rgba(255,255,255,.17)}
        #browser-lyrics-controls button[data-action="play"]{display:grid;place-items:center;width:54px;height:54px;border:0;border-radius:0;background:transparent;color:#fff;font-size:18px;box-shadow:none} #browser-lyrics-controls button[data-action="play"] .play-icon{width:18px;height:18px;position:relative;display:block} #browser-lyrics-controls button[data-action="play"] .play-icon:before,#browser-lyrics-controls button[data-action="play"] .play-icon:after{content:"";position:absolute;top:2px;width:5px;height:14px;border-radius:2px;background:currentColor;transition:all .2s cubic-bezier(.2,.8,.2,1)} #browser-lyrics-controls button[data-action="play"] .play-icon:before{left:2px} #browser-lyrics-controls button[data-action="play"] .play-icon:after{right:2px} #browser-lyrics-controls button[data-action="play"]:not(.is-playing) .play-icon:before{left:5px;top:1px;width:0;height:0;border-top:8px solid transparent;border-bottom:8px solid transparent;border-left:12px solid currentColor;border-radius:2px;background:transparent} #browser-lyrics-controls button[data-action="play"]:not(.is-playing) .play-icon:after{opacity:0;transform:scale(.5)}
        #browser-lyrics-timeline{padding:0 20px 14px}
        .browser-lyrics-time-labels{display:flex;justify-content:space-between;color:#aaa6b5;font-size:10px;font-variant-numeric:tabular-nums}
        #browser-lyrics-seek{display:block;width:100%;height:4px;margin:7px 0 0;padding:0;appearance:none;border:0;border-radius:99px;background:linear-gradient(to right,#c4b5fd 0%,#8b5cf6 var(--seek-progress,0%),rgba(255,255,255,.2) var(--seek-progress,0%),rgba(255,255,255,.2) 100%);cursor:pointer}
        #browser-lyrics-seek::-webkit-slider-thumb{width:10px;height:10px;appearance:none;border:0;border-radius:50%;background:#fff;box-shadow:0 0 0 3px rgba(196,181,253,.22)}
        #browser-lyrics-seek::-moz-range-thumb{width:10px;height:10px;border:0;border-radius:50%;background:#fff;box-shadow:0 0 0 3px rgba(196,181,253,.22)}
        #browser-lyrics-seek:disabled{cursor:default;opacity:.5}
        #browser-lyrics-more{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;border-top:1px solid rgba(255,255,255,.09)}
        #browser-lyrics-more:not([open]){flex:0 0 auto}
        #browser-lyrics-more>summary{flex:none;display:flex;align-items:center;justify-content:space-between;min-height:42px;padding:0 20px;color:#c9c3d7;font-size:11px;font-weight:700;letter-spacing:.04em;cursor:pointer;list-style:none;user-select:none}
        #browser-lyrics-more>summary::-webkit-details-marker{display:none}
        .browser-lyrics-chevron{color:#bba7fa;font-size:18px;transition:transform .18s}
        #browser-lyrics-more[open] .browser-lyrics-chevron{transform:rotate(180deg)}
        #browser-lyrics-extras{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
        #browser-lyrics-more:not([open])>#browser-lyrics-extras{display:none}
        #browser-lyrics-search-section{flex:none;border-bottom:1px solid rgba(255,255,255,.08)} #browser-lyrics-search-section>summary{display:flex;align-items:center;justify-content:space-between;min-height:36px;padding:0 20px;color:#aaa6b5;font-size:10px;font-weight:700;letter-spacing:.06em;cursor:pointer;list-style:none} #browser-lyrics-search-section>summary::-webkit-details-marker{display:none} #browser-lyrics-search-section:not([open])>#browser-lyrics-search,#browser-lyrics-search-section:not([open])>#browser-lyrics-results{display:none} .browser-lyrics-search-chevron{color:#bba7fa;transition:transform .18s} #browser-lyrics-search-section[open] .browser-lyrics-search-chevron{transform:rotate(180deg)} #browser-lyrics-search{gap:8px;padding:12px 0 10px;border-top:1px solid rgba(255,255,255,.09);border-bottom:1px solid rgba(255,255,255,.09)}
        #browser-lyrics-search input{height:40px;padding:0 12px;border:1px solid rgba(255,255,255,.14);border-radius:11px;background:rgba(8,9,13,.45);font:13px system-ui,sans-serif}
        #browser-lyrics-search input:focus{outline:2px solid rgba(167,139,250,.62);border-color:transparent}
        #browser-lyrics-search button{min-width:72px;border-radius:11px;background:#e9ddff;color:#211830;font-size:12px;font-weight:750}
        #browser-lyrics-search button:hover{background:white}
        #browser-lyrics-results{max-height:150px;overflow:auto;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.08);scrollbar-width:thin}
        #browser-lyrics-script{display:flex;align-items:center;gap:6px;padding:8px 20px 0}
        #browser-lyrics-script[hidden]{display:none!important}
        #browser-lyrics-script span{margin-right:auto;color:#aaa6b5;font-size:9px;font-weight:700;letter-spacing:.1em}
        #browser-lyrics-script button{border:1px solid rgba(255,255,255,.18);border-radius:999px;background:transparent;color:#c9c3d7;padding:5px 10px;font:10px system-ui,sans-serif;cursor:pointer}
        #browser-lyrics-script button[aria-pressed="true"]{border-color:#a78bfa;background:rgba(167,139,250,.18);color:#fff}
        .browser-lyrics-results-heading{margin:2px 5px 6px;color:#a9a4b5;font-size:9px;letter-spacing:.12em}
        .browser-lyrics-result{gap:10px;padding:7px;border-radius:10px}
        .browser-lyrics-result:hover{background:rgba(255,255,255,.08)}
        .browser-lyrics-result img{width:40px;height:40px;flex-basis:40px;border-radius:8px}
        .browser-lyrics-result-details strong{font-size:12px}
        .browser-lyrics-result-details small{font-size:10px}
        .browser-lyrics-queue-action{display:grid;flex:0 0 30px;width:30px;height:30px;place-items:center;border-radius:50%;background:linear-gradient(135deg,#c4b5fd,#8b5cf6);color:#181323;font-size:12px;font-weight:800;line-height:1}
        #browser-lyrics-body{flex:1;min-height:0;max-height:none!important;overflow:auto;padding:17px 21px 22px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.2) transparent}
        #browser-lyrics-body{display:flex;align-items:center;overflow:hidden}
        #browser-lyrics-lines{width:100%;color:#aaa7b5;font-size:24px;font-weight:680;line-height:1.35;letter-spacing:-.025em}
        #browser-lyrics-lines p{min-height:1.35em;margin:10px 0;opacity:.56;transform:scale(.98);transform-origin:left center;transition:opacity .22s,transform .22s,color .22s,text-shadow .22s}
        #browser-lyrics-lines p.active{color:#fff;opacity:1;transform:scale(1);text-shadow:0 0 24px rgba(196,181,253,.6);animation:story-focus .42s cubic-bezier(.2,.8,.2,1) both}
        #browser-lyrics-lines p.lyric-enter{animation:story-enter .45s cubic-bezier(.2,.8,.2,1) both}
        #browser-lyrics-lines p.active.lyric-enter{animation:story-focus .42s cubic-bezier(.2,.8,.2,1) both}
        @keyframes story-focus{0%{transform:translateY(4px) scale(.98)}100%{transform:translateY(0) scale(1)}}
        @keyframes story-enter{0%{opacity:0;transform:translateY(8px)}100%{opacity:.56;transform:translateY(0) scale(.98)}}
        #browser-lyrics-message{color:#c6c1d1;font-size:13px;line-height:1.55}
        #browser-lyrics-foot{flex:none;padding:9px 20px 13px;border-top:1px solid rgba(255,255,255,.08);color:#918d9d;font-size:10px}
        #browser-lyrics-popout{display:none!important}
        #browser-lyrics-controls button[data-action="play"]{display:grid;place-items:center}
        #browser-lyrics-controls button[data-action="play"] .play-icon{width:18px;height:18px;position:relative;display:block}
        #browser-lyrics-controls button[data-action="play"] .play-icon:before,#browser-lyrics-controls button[data-action="play"] .play-icon:after{content:"";position:absolute;top:2px;width:5px;height:14px;border-radius:2px;background:currentColor;transition:all .2s cubic-bezier(.2,.8,.2,1)}
        #browser-lyrics-controls button[data-action="play"] .play-icon:before{left:2px}#browser-lyrics-controls button[data-action="play"] .play-icon:after{right:2px}
        #browser-lyrics-controls button[data-action="play"]:not(.is-playing) .play-icon:before{left:5px;top:1px;width:0;height:0;border-top:8px solid transparent;border-bottom:8px solid transparent;border-left:12px solid currentColor;border-radius:2px;background:transparent}
        #browser-lyrics-controls button[data-action="play"]:not(.is-playing) .play-icon:after{opacity:0;transform:scale(.5)}
        #browser-lyrics-card{background:rgba(17,19,25,.62)} #browser-lyrics-card:before{content:"";position:absolute;z-index:0;inset:-28px;pointer-events:none;background-image:linear-gradient(135deg,rgba(12,13,18,.48),rgba(12,13,18,.66)),var(--music-art,radial-gradient(ellipse at 20% 0%,#493b69,#17191f 70%));background-position:center;background-size:cover;filter:blur(26px) saturate(1.35);opacity:.9;transform:scale(1.08)} #browser-lyrics-card>*{position:relative;z-index:1}
        #browser-lyrics-lines p.lyric-enter{animation:none!important}
        #browser-lyrics-lines p.active{animation:none!important}
      `;
      pipUi.append(style);
      pipWindow.document.body.append(floatingRoot);
      pipUi.querySelector("#browser-lyrics-close").addEventListener("click", () => pipWindow.close());
      pipUi.querySelectorAll("#browser-lyrics-controls button").forEach((button) => button.addEventListener("click", () => clickPlayerControl(button.dataset.action)));
      bindLyricsScript(pipUi);
      bindTimeline(pipUi);
      const searchInput = pipUi.querySelector("#browser-lyrics-search input");
      const searchButton = pipUi.querySelector("#browser-lyrics-search button");
      searchButton.addEventListener("click", () => searchMusic(searchInput.value));
      searchInput.addEventListener("keydown", (event) => { if (event.key === "Enter") searchMusic(searchInput.value); });
      pipUi.querySelector("#browser-lyrics-results").addEventListener("click", queueResultClick);
      pipWindow.addEventListener("pagehide", () => {
        if (pipPoller) clearInterval(pipPoller);
        pipPoller = null;
        pipWindow = null;
        pipUi = null;
      });
      pipPoller = pipWindow.setInterval(refresh, 1000);
    } catch (error) {
      showMessage("Could not open the floating player. Try clicking Pop out again.");
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "TRACK_UPDATE") applyTrack(message.track);
    if (message.type === "SEARCH_RESULTS_AVAILABLE") {
      searchQuery = message.query || searchQuery;
      remoteSearchResults = message.results || [];
      searchComplete = true;
      searchError = message.error || "";
      renderResults(remoteSearchResults);
    }
    if (message.type === "DO_PLAYER_CONTROL") {
      sendResponse({ ok: clickLocalPlayerControl(message.action) });
      return false;
    }
    if (message.type === "DO_SEEK") {
      sendResponse({ ok: seekLocalPlayer(message.seconds) });
      return false;
    }
    if (message.type === "GET_YTM_LYRICS") {
      getYouTubeMusicLyrics(message.videoId).then(sendResponse).catch((error) => sendResponse({ error: error.message || "YouTube Music lyrics could not be loaded." }));
      return true;
    }
    if (message.type === "DO_SEARCH") {
      const query = message.query || "";
      searchYouTubeMusic(query).then((results) => {
        chrome.runtime.sendMessage({ type: "SEARCH_RESULTS_UPDATED", query, results });
        sendResponse({ ok: true, count: results.length });
      }).catch((error) => {
        chrome.runtime.sendMessage({ type: "SEARCH_RESULTS_UPDATED", query, results: [], error: error.message || "YouTube Music search failed." });
        sendResponse({ ok: false, error: error.message });
      });
      return true;
    }
    if (message.type === "DO_PLAY_TRACK") { playTrackOnThisPage(message.title, message.videoId, message.mode || "play", sendResponse); return true; }
  });

  // Drag the note by its header; keep it inside the visible viewport.
  const head = ui.querySelector("#browser-lyrics-head");
  head.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) return;
    const rect = root.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const move = (moveEvent) => {
      const left = Math.max(0, Math.min(innerWidth - rect.width, rect.left + moveEvent.clientX - startX));
      const top = Math.max(0, Math.min(innerHeight - 70, rect.top + moveEvent.clientY - startY));
      root.style.setProperty("left", `${left}px`, "important");
      root.style.setProperty("top", `${top}px`, "important");
      root.style.setProperty("right", "auto", "important");
    };
    const stop = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", stop);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", stop, { once: true });
  });

  function getTrack() {
    const clean = (value) => value?.replace(/\s+/g, " ").trim() || "";
    const queryDeep = (selector, scope = document, results = []) => {
      results.push(...scope.querySelectorAll(selector));
      for (const element of scope.querySelectorAll("*")) {
        if (element.shadowRoot) queryDeep(selector, element.shadowRoot, results);
      }
      return results;
    };
    const playerRoots = [...document.querySelectorAll("ytmusic-player-bar, ytmusic-player-page, ytmusic-player")];
    const queryPlayerDeep = (selector) => playerRoots.flatMap((playerRoot) => queryDeep(selector, playerRoot));
    const media = [...document.querySelectorAll("audio, video"), ...queryPlayerDeep("audio, video")]
      .filter((item) => !item.ended)
      .sort((a, b) => Number(a.paused) - Number(b.paused) || (b.currentTime || 0) - (a.currentTime || 0))[0];
    const meta = (name) => document.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.content || "";
    const sessionMetadata = navigator.mediaSession?.metadata;
    const titleCandidates = [
      sessionMetadata?.title,
      document.querySelector("ytmusic-player-bar .title")?.textContent,
      document.querySelector("ytmusic-player-bar .title")?.getAttribute("title"),
      queryPlayerDeep("ytmusic-player-bar .title, .song-title, [aria-label^='Song:']")[0]?.textContent
    ].map(clean);
    const musicTitle = titleCandidates.find((candidate) => candidate && !/^(playing from|up next|now playing|queue)$/i.test(candidate)) || "";
    const musicByline = clean(queryPlayerDeep(".byline")[0]?.textContent || "");
    const musicArtists = queryPlayerDeep(".byline a")
      .map((link) => clean(link.textContent)).filter(Boolean);
    const coverImage = queryPlayerDeep("img.image, .thumbnail img, yt-img-shadow img, #thumbnail img, img")
      .find((image) => image.currentSrc || image.src);
    const sessionArtwork = [...(sessionMetadata?.artwork || [])]
      .sort((a, b) => Number.parseInt(b.sizes || "0", 10) - Number.parseInt(a.sizes || "0", 10))[0]?.src;
    const cover = sessionArtwork || coverImage?.currentSrc || coverImage?.src || meta("og:image");
    const youtubeTitle = clean(document.querySelector("h1.ytd-video-primary-info-renderer yt-formatted-string")?.textContent || "");
    const youtubeArtist = clean(document.querySelector("#upload-info #channel-name")?.textContent || "");
    const pageTitle = location.hostname === "music.youtube.com" ? document.title : (meta("og:title") || document.title);
    let title = clean(musicTitle || youtubeTitle || pageTitle)
      .replace(/\s*[|–-]\s*(YouTube|Spotify|SoundCloud|Apple Music).*$/i, "")
      .replace(/\s*\(Official (Music )?Video\).*$/i, "")
      .replace(/\s*\[Official (Music )?Video\].*$/i, "")
      .replace(/\s*\(Lyrics?\).*$/i, "").trim();
    let artist = clean(sessionMetadata?.artist || musicArtists[0] || musicByline.split(/\s*[•·]\s*/)[0] || youtubeArtist || meta("music:musician") || meta("og:audio:artist") || document.querySelector('[data-testid="context-item-info-artist"]')?.textContent || "");
    if (!musicTitle && !youtubeTitle && !artist) {
      const parts = title.split(/\s+(?:-|–|—|by)\s+/i);
      if (parts.length > 1) { artist = parts[0].trim(); title = parts.slice(1).join(" - ").trim(); }
    }
    const playing = (!!media && !media.paused && !media.ended) || navigator.mediaSession?.playbackState === "playing";
    const videoId = location.hostname === "music.youtube.com"
      ? new URL(location.href).searchParams.get("v") || document.querySelector('a[href*="watch?v="]')?.href.match(/[?&]v=([^&]+)/)?.[1] || ""
      : "";
    return { title, artist, cover, videoId, time: media?.currentTime || 0, duration: Number.isFinite(media?.duration) ? media.duration : 0, playing, hasMusicTrack: !!(musicTitle || sessionMetadata?.title) };
  }

  async function getYouTubeMusicLyrics(videoId) {
    if (location.hostname !== "music.youtube.com" || !videoId) return { error: "YouTube Music lyrics are only available from a playing YouTube Music tab." };
    const pageText = document.documentElement.innerHTML;
    const apiKey = pageText.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1];
    const clientVersion = pageText.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/)?.[1];
    if (!apiKey || !clientVersion) return { error: "Could not read YouTube Music's lyrics connection. Reload the music tab and try again." };
    const post = async (endpoint, body, mobile = false) => {
      const clientName = mobile ? "ANDROID_MUSIC" : "WEB_REMIX";
      const version = mobile ? "7.21.50" : clientVersion;
      const response = await fetch(`/youtubei/v1/${endpoint}?key=${encodeURIComponent(apiKey)}&prettyPrint=false`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-youtube-client-name": mobile ? "21" : "67", "x-youtube-client-version": version },
        body: JSON.stringify({ context: { client: mobile
          ? { clientName, clientVersion: version, hl: "hi", gl: "IN", osName: "Android", osVersion: "14", androidSdkVersion: 34, platform: "MOBILE" }
          : { clientName, clientVersion: version, hl: "en", gl: "IN" } }, ...body })
      });
      if (!response.ok) throw new Error(`YouTube Music returned ${response.status}.`);
      return response.json();
    };
    const next = await post("next", {
      videoId,
      playlistId: `RDAMVM${videoId}`,
      enablePersistentPlaylistPanel: true,
      isAudioOnly: true,
      tunerSettingValue: "AUTOMIX_SETTING_NORMAL",
      watchEndpointMusicSupportedConfigs: { watchEndpointMusicConfig: { hasPersistentPlaylistPanel: true, musicVideoType: "MUSIC_VIDEO_TYPE_ATV" } }
    });
    let browseId = "";
    const seekBrowseId = (node) => {
      if (!node || typeof node !== "object" || browseId) return;
      if (Array.isArray(node)) { node.forEach(seekBrowseId); return; }
      for (const [key, value] of Object.entries(node)) {
        if ((key === "browseId" || key === "browse_id") && typeof value === "string" && value.startsWith("MPLYt")) { browseId = value; return; }
        seekBrowseId(value);
      }
    };
    seekBrowseId(next);
    if (!browseId) return { error: "YouTube Music has no lyrics for this track." };
    // The WEB_REMIX browse response commonly contains plain text only. The official
    // open-source ytmusicapi reader requests this same lyrics browseId as ANDROID_MUSIC
    // when timestamped lines are wanted, so ask that client first for live highlighting.
    let data;
    try { data = await post("browse", { browseId }, true); }
    catch (_error) { data = await post("browse", { browseId }); }
    let timed = null;
    let plain = "";
    const scanLyrics = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(scanLyrics); return; }
      if (!timed && Array.isArray(node.timedLyricsData)) timed = node.timedLyricsData;
      if (!plain && Array.isArray(node.runs) && node.runs.some((run) => typeof run.text === "string")) plain = node.runs.map((run) => run.text || "").join("");
      for (const value of Object.values(node)) scanLyrics(value);
    };
    scanLyrics(data);
    if (!timed?.length && !plain) {
      const webLyrics = await post("browse", { browseId }).catch(() => null);
      if (webLyrics) scanLyrics(webLyrics);
    }
    if (timed?.length) {
      const syncedLyrics = timed.map((item) => {
        const text = item.lyricLine || "";
        const millis = Number(item.cueRange?.startTimeMilliseconds || item.startTimeMilliseconds || 0);
        const mins = Math.floor(millis / 60000), secs = ((millis % 60000) / 1000).toFixed(2).padStart(5, "0");
        return `[${String(mins).padStart(2, "0")}:${secs}]${text}`;
      }).join("\n");
      return { lyrics: { plainLyrics: null, syncedLyrics }, provider: "YouTube Music" };
    }
    if (plain) return { lyrics: { plainLyrics: plain, syncedLyrics: null }, provider: "YouTube Music" };
    return { error: "YouTube Music did not return lyrics for this track." };
  }

  async function searchYouTubeMusic(query) {
    if (location.hostname !== "music.youtube.com") throw new Error("Open a YouTube Music song first, then search from this panel.");
    const pageText = document.documentElement.innerHTML;
    const apiKey = pageText.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1];
    const clientVersion = pageText.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/)?.[1];
    if (!apiKey || !clientVersion) throw new Error("YouTube Music’s search connection isn’t ready. Reload its tab and try again.");
    const response = await fetch(`/youtubei/v1/search?key=${encodeURIComponent(apiKey)}&prettyPrint=false`, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-youtube-client-name": "67", "x-youtube-client-version": clientVersion },
      body: JSON.stringify({ context: { client: { clientName: "WEB_REMIX", clientVersion, hl: "en", gl: "IN" } }, query, params: "EgWKAQIIAWoMEA4QChADEAQQCRAF" })
    });
    if (!response.ok) throw new Error(`YouTube Music search returned ${response.status}.`);
    const data = await response.json();
    const results = [];
    const seen = new Set();
    const textFrom = (value) => (value?.runs || []).map((run) => run.text || "").join("").trim();
    const findVideoId = (value) => {
      if (!value || typeof value !== "object") return "";
      if (Array.isArray(value)) { for (const item of value) { const id = findVideoId(item); if (id) return id; } return ""; }
      if (typeof value.videoId === "string") return value.videoId;
      for (const child of Object.values(value)) { const id = findVideoId(child); if (id) return id; }
      return "";
    };
    const findCover = (value) => {
      if (!value || typeof value !== "object") return "";
      if (Array.isArray(value)) { for (const item of value) { const url = findCover(item); if (url) return url; } return ""; }
      if (Array.isArray(value.thumbnails)) {
        const image = value.thumbnails.find((item) => item.url);
        if (image) return image.url.replace(/=w\d+-h\d+[^?]*/, "=w120-h120-l90-rj");
      }
      for (const child of Object.values(value)) { const url = findCover(child); if (url) return url; }
      return "";
    };
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      const item = node.musicResponsiveListItemRenderer;
      if (item) {
        const title = textFrom(item.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text);
        const bylineRuns = item.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
        const bylineParts = bylineRuns.map((run) => run.text?.trim()).filter((part) => part && !/^[•·\-]+$/.test(part));
        const artist = bylineParts.find((part) => !/^(song|video|explicit)$/i.test(part)) || "";
        const videoId = findVideoId(item.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint) || findVideoId(item);
        const cover = findCover(item.thumbnail || item.thumbnails || item);
        if (title && videoId && !seen.has(videoId)) {
          seen.add(videoId);
          results.push({ title, artist, cover, videoId });
        }
      }
      Object.values(node).forEach(visit);
    };
    visit(data);
    return results.slice(0, 8);
  }

  function showMessage(message) {
    linesEl.replaceChildren(Object.assign(document.createElement("p"), { id: "browser-lyrics-message", textContent: message }));
  }

  async function lookup(song) {
    const lookupKey = `${song.videoId || ""}|${song.artist || ""}|${song.title || ""}`;
    currentLookupKey = lookupKey;
    timedLines = [];
    lyricLines = [];
    originalLyricLines = [];
    activeLyricLine = -1;
    renderedLyricStart = -1;
    for (const view of [ui, pipUi].filter(Boolean)) view.querySelector("#browser-lyrics-script").hidden = true;
    const reply = await chrome.runtime.sendMessage({ type: "LOOKUP_LYRICS", track: song.title, artist: song.artist, videoId: song.videoId });
    if (currentLookupKey !== lookupKey) return;
    if (reply?.error) throw new Error(reply.error);
    const lyrics = reply.lyrics;
    linesEl.replaceChildren();
    if (lyrics.syncedLyrics) {
      timedLines = lyrics.syncedLyrics.split(/\r?\n/).flatMap((line) => {
        const match = line.match(/^\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2}(?:[.,]\d{1,3})?)\](.*)$/);
        if (!match) return [];
        const hours = Number(match[1] || 0);
        const minutes = Number(match[2] || 0);
        const seconds = Number((match[3] || "0").replace(",", "."));
        return [{ time: hours * 3600 + minutes * 60 + seconds, text: match[4].trim() }];
      }).filter((line) => line.text).sort((a, b) => a.time - b.time);
    }
    originalLyricLines = timedLines.length ? timedLines.map((line) => line.text) : (lyrics.plainLyrics || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!originalLyricLines.length) {
      footEl.textContent = "Checked LRCLIB, Lyrics.ovh, and YouTube Music";
      return showMessage("No lyrics are available for this match.");
    }
    const hasHindi = originalLyricLines.some((line) => /[\u0900-\u097f]/.test(line));
    for (const view of [ui, pipUi].filter(Boolean)) view.querySelector("#browser-lyrics-script").hidden = !hasHindi;
    scriptMode = hasHindi ? "hinglish" : "original";
    lyricLines = hasHindi ? originalLyricLines.map(transliterateHindiLine) : [...originalLyricLines];
    for (const view of [ui, pipUi].filter(Boolean)) {
      view.querySelectorAll("#browser-lyrics-script button[data-script]").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.script === scriptMode));
      });
    }
    activeLyricLine = -1;
    renderedLyricStart = -1;
    renderLyricWindow(-1, true);
    footEl.textContent = timedLines.length
      ? `Synced lyrics · from ${reply.provider || "LRCLIB"}`
      : `Plain lyrics · from ${reply.provider || "LRCLIB"} · not time-synced`;
  }

  function renderLyricWindow(activeIndex, force = false) {
    if (!lyricLines.length) return;
    const focus = activeIndex >= 0 ? activeIndex : 0;
    const lastStart = Math.max(0, lyricLines.length - 3);
    const start = Math.max(0, Math.min(lastStart, focus - 1));
    const end = Math.min(lyricLines.length, start + 3);
    if (force || start !== renderedLyricStart) {
      const fragment = document.createDocumentFragment();
      for (let index = start; index < end; index += 1) {
        const line = document.createElement("p");
        line.textContent = lyricLines[index];
        line.dataset.index = index;
        line.className = index === activeIndex ? "active lyric-enter" : "lyric-enter";
        line.style.animationDelay = `${(index - start) * 75}ms`;
        fragment.append(line);
      }
      linesEl.replaceChildren(fragment);
      renderedLyricStart = start;
    } else if (activeIndex !== activeLyricLine) {
      linesEl.querySelectorAll("p").forEach((line) => {
        const isActive = Number(line.dataset.index) === activeIndex;
        line.classList.toggle("active", isActive);
        if (isActive) {
          line.classList.remove("lyric-enter");
          void line.offsetWidth;
          line.classList.add("lyric-enter");
        }
      });
    }
    activeLyricLine = activeIndex;
  }

  function highlight(seconds) {
    if (!lyricLines.length) return;
    if (!timedLines.length) {
      renderLyricWindow(-1);
      return;
    }
    let active = -1;
    timedLines.forEach((line, index) => { if (line.time <= seconds) active = index; });
    renderLyricWindow(active);
  }

  function closeSearchOptions() {
    searchQuery = "";
    remoteSearchResults = [];
    renderResults([]);
    ui.querySelector("#browser-lyrics-more").open = false;
    if (pipUi) pipUi.querySelector("#browser-lyrics-more").open = false;
  }

  function queueResultClick(event) {
    const button = event.target.closest("button[data-play-title]");
    if (!button) return;
    const targetTitle = button.dataset.playTitle;
    const mode = button.dataset.action || "play";
    if (location.hostname !== "music.youtube.com") {
      if (mode === "queue") {
        button.disabled = true;
        button.classList.add("is-queueing");
        button.textContent = "Adding…";
        showMessage(`Adding “${targetTitle}” to play next…`);
      } else showMessage(`Sending “${targetTitle}” to YouTube Music…`);
      chrome.runtime.sendMessage({ type: "PLAY_ON_PLAYER", title: targetTitle, videoId: button.dataset.playVideoId, mode })
        .then((reply) => {
          if (!reply?.ok) {
            showMessage("Could not reach the YouTube Music player. The song was not added; search is still open.");
            button.disabled = false;
            button.classList.remove("is-queueing");
            button.textContent = "+ next";
            return;
          }
          if (mode === "queue" && reply?.queued) {
            button.textContent = "Queued ✓";
            button.classList.remove("is-queueing");
            
            closeSearchOptions();
          } else if (mode === "queue") {
            button.disabled = false;
            button.textContent = "+ next";
            button.classList.remove("is-queueing");
            showMessage(reply?.error || `YouTube Music did not confirm “${targetTitle}” was queued.`);
          } else closeSearchOptions();
        })
        .catch(() => {
          showMessage("Could not reach the YouTube Music player. The song was not added; search is still open.");
          button.disabled = false;
          button.classList.remove("is-queueing");
          button.textContent = "+ next";
        });
      return;
    }
    playTrackOnThisPage(targetTitle, button.dataset.playVideoId, mode);
  }

  function playTrackOnThisPage(targetTitle, videoId = "", mode = "play", respond = () => {}) {
    if (videoId && location.hostname === "music.youtube.com") {
      if (mode === "play") {
        closeSearchOptions();
        location.assign(`https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
        return;
      }
      const findRow = () => queryDeep("ytmusic-responsive-list-item-renderer, ytmusic-two-row-item-renderer")
        .find((item) => item.querySelector(`a[href*="watch?v=${videoId}"]`) || item.innerHTML.includes(videoId));
      const addThenAdvance = (attempt = 0) => {
        const row = findRow();
        if (!row) {
          if (attempt > 10) { showMessage(`Could not find “${targetTitle}” in YouTube Music search results.`); return; }
          setTimeout(() => addThenAdvance(attempt + 1), 400);
          return;
        }
        const menuButton = queryDeep("#button, yt-icon-button, button", row).find((button) =>
          /more|options|action/i.test(`${button.getAttribute("aria-label") || ""} ${button.title || ""}`));
        if (!menuButton) { showMessage("YouTube Music did not expose the queue menu for this result."); return; }
        menuButton.click();
        setTimeout(() => {
          const menuItems = queryDeep("tp-yt-paper-item, ytmusic-menu-service-item-renderer, [role='menuitem']");
          const queueItem = mode === "queue"
            ? menuItems.find((item) => /play next(?: in queue)?/i.test(item.textContent || ""))
            : menuItems.find((item) => /add to queue/i.test(item.textContent || ""));
          if (!queueItem) { showMessage("YouTube Music did not offer Play next for this result, so it was not added to the end of the queue."); return; }
          const queuedAsNext = /play next(?: in queue)?/i.test(queueItem.textContent || "");
          queueItem.click();
          setTimeout(() => {
            if (mode === "queue" && queuedAsNext) { showMessage(`Queued ${targetTitle} to play next.`); respond({ ok: true, queued: true }); return; }
            if (mode === "queue") { const error = `YouTube Music did not confirm ${targetTitle} will play next.`; showMessage(error); respond({ ok: false, error }); return; }
            const nextButton = queryDeep("#next-button, .next-button, button[aria-label*='Next'], [role='button'][aria-label*='Next']")
              .find((button) => button.isConnected && !button.disabled);
            if (nextButton) { nextButton.click(); closeSearchOptions(); showMessage(`Playing ${targetTitle} next.`); }
            else showMessage(`Added ${targetTitle} to the queue, but could not find the Next track control.`);
          }, 350);
        }, 250);
      };

      let row = findRow();
      if (row) { addThenAdvance(); return; }
      const searchBox = queryDeep("input#input, input[placeholder*='Search'], input[aria-label*='Search']").find((input) => input.isConnected);
      if (!searchBox) { showMessage("Open YouTube Music search first, then select this song again."); return; }
      searchBox.focus();
      searchBox.value = targetTitle;
      searchBox.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      searchBox.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      searchBox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, composed: true }));
      setTimeout(() => addThenAdvance(), 1200);
      return;
    }
    const onSearchPage = /\/search(?:\/|$)/.test(location.pathname);
    const rows = onSearchPage ? [...document.querySelectorAll("ytmusic-responsive-list-item-renderer, ytmusic-two-row-item-renderer")] : [];
    const normalizeTitle = (value) => (value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const row = rows.find((item) => normalizeTitle(item.querySelector(".title, yt-formatted-string.title, #title")?.textContent) === normalizeTitle(targetTitle));
    if (!row) { showMessage("I couldn’t find that result in the YouTube Music search page."); return; }
    const playTarget = row.querySelector("#play-button, .play-button") || row;
    playTarget.click();
    showMessage(`Playing ${targetTitle}`);
  }

  function renderResults(matches) {
    const container = ui.querySelector("#browser-lyrics-results");
    if (!searchQuery) {
      container.hidden = true;
      if (pipUi) {
        const pipResults = pipUi.querySelector("#browser-lyrics-results");
        pipResults.hidden = true;
        pipResults.replaceChildren();
      }
      return;
    }
    container.hidden = false;
    container.replaceChildren();
    const heading = document.createElement("div");
    heading.className = "browser-lyrics-results-heading";
    heading.textContent = matches.length ? "SEARCH RESULTS · PLAY NOW"
      : searchError || (searchComplete ? "No songs found. Try another search." : `Searching YouTube Music for “${searchQuery}”…`);
    container.append(heading);
    for (const item of matches) {
      const button = document.createElement("button");
      button.className = "browser-lyrics-result";
      button.dataset.playTitle = item.title;
      button.dataset.playVideoId = item.videoId || "";
      button.setAttribute("aria-label", `Play ${item.title} now`);
      const image = document.createElement("img");
      image.alt = "";
      image.src = item.cover;
      const details = document.createElement("span");
      details.className = "browser-lyrics-result-details";
      const name = document.createElement("strong");
      name.textContent = item.title;
      const sub = document.createElement("small");
      sub.textContent = item.artist;
      details.append(name, sub);
      button.append(image, details);
      container.append(button);
      const queueButton = document.createElement("button");
      queueButton.className = "browser-lyrics-queue-action";
      queueButton.type = "button";
      queueButton.dataset.playTitle = item.title;
      queueButton.dataset.playVideoId = item.videoId || "";
      queueButton.dataset.action = "queue";
      queueButton.setAttribute("aria-label", `Play ${item.title} next`);
      queueButton.textContent = "+ next";
      container.append(queueButton);
    }
    if (pipWindow && !pipWindow.closed && pipUi) {
      const pipResults = pipUi.querySelector("#browser-lyrics-results");
      if (pipResults) {
        pipResults.hidden = container.hidden;
        pipResults.innerHTML = container.innerHTML;
      }
    }
  }

  function updateSearchResults() {
    if (!searchQuery) return renderResults([]);
    renderResults(remoteSearchResults);
  }

  async function applyTrack(song) {
    currentTrack = song;
    if (!song?.title) {
      titleEl.textContent = "Waiting for music…";
      artistEl.textContent = "Play a song in another tab";
      ui.querySelector("#browser-lyrics-cover").hidden = true;
      setArtworkTint(ui.querySelector("#browser-lyrics-card"), "");
      updateTimeline(ui, null);
      if (pipUi) updateTimeline(pipUi, null);
      timedLines = [];
      lyricLines = [];
      originalLyricLines = [];
      activeLyricLine = -1;
      renderedLyricStart = -1;
      for (const view of [ui, pipUi].filter(Boolean)) view.querySelector("#browser-lyrics-script").hidden = true;
      songKey = "";
      showMessage("Waiting for a song in another tab…");
      return;
    }
    titleEl.textContent = song.title;
    artistEl.textContent = song.artist || (song.playing ? "Playing in this tab" : "Track detected from this tab");
    const coverEl = ui.querySelector("#browser-lyrics-cover");
    if (song.cover) { coverEl.src = song.cover; coverEl.hidden = false; }
    else coverEl.hidden = true;
    setArtworkTint(ui.querySelector("#browser-lyrics-card"), song.cover);
    updateTimeline(ui, song);
    syncPlaybackButton(ui, song.playing);
    const nextKey = `${song.artist}|${song.title}`.toLowerCase();
    if (nextKey !== songKey) {
      songKey = nextKey;
      showMessage("Looking for synced lyrics…");
      try { await lookup(song); }
      catch (error) {
        footEl.textContent = "Checked LRCLIB, Lyrics.ovh, and YouTube Music";
        showMessage(error.message || "Couldn't load lyrics.");
      }
    }
    highlight(song.time);
    if (pipWindow && !pipWindow.closed && pipUi) {
      const floating = pipUi;
      if (floating) {
        setArtworkTint(floating.querySelector("#browser-lyrics-card"), song.cover);
        floating.querySelector("#browser-lyrics-title").textContent = titleEl.textContent;
        floating.querySelector("#browser-lyrics-artist").textContent = artistEl.textContent;
        const floatingCover = floating.querySelector("#browser-lyrics-cover");
        floatingCover.src = coverEl.src;
        floatingCover.hidden = coverEl.hidden;
        updateTimeline(floating, song);
        syncPlaybackButton(floating, song.playing);
        const floatingLines = floating.querySelector("#browser-lyrics-lines");
        const sourceLines = [...linesEl.querySelectorAll("p")];
        const targetLines = [...floatingLines.querySelectorAll("p")];
        const lineWindowChanged = sourceLines.length !== targetLines.length || sourceLines.some((line, index) =>
          line.dataset.index !== targetLines[index]?.dataset.index || line.textContent !== targetLines[index]?.textContent);
        if (lineWindowChanged) {
          floatingLines.replaceChildren(...sourceLines.map((line) => {
            const copy = document.createElement("p");
            copy.textContent = line.textContent;
            if (line.dataset.index != null) copy.dataset.index = line.dataset.index;
            return copy;
          }));
        }
        const floatingResults = floating.querySelector("#browser-lyrics-results");
        floatingResults.hidden = ui.querySelector("#browser-lyrics-results").hidden;
        floatingResults.innerHTML = ui.querySelector("#browser-lyrics-results").innerHTML;
        floating.querySelector("#browser-lyrics-foot").textContent = footEl.textContent;
        const seconds = song.time;
        if (timedLines.length) {
          let active = -1;
          timedLines.forEach((line, index) => { if (line.time <= seconds) active = index; });
          floatingLines.querySelectorAll("p[data-index]").forEach((line) => line.classList.toggle("active", Number(line.dataset.index) === active));
        }
      }
    }
  }

  async function refresh() {
    const local = getTrack();
    const isYouTubeMusicPlayer = location.hostname === "music.youtube.com" &&
      local.hasMusicTrack;
    if (local.title && (local.playing || isYouTubeMusicPlayer)) {
      chrome.runtime.sendMessage({ type: "SET_NOW_PLAYING", track: local });
      await applyTrack(local);
    } else {
      const response = await chrome.runtime.sendMessage({ type: "GET_NOW_PLAYING" }).catch(() => null);
      await applyTrack(response?.track || null);
    }
    updateSearchResults();
  }

  refresh();
  // Frequent playhead snapshots keep the active lyric line close to the actual
  // vocal timing, including when the reader is shown on a different browser tab.
  poller = setInterval(refresh, 500);
})();
