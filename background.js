chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.getElementById("browser-lyrics-root") !== null
    });
    if (result) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.getElementById("browser-lyrics-root")?.remove()
      });
      return;
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["overlay.js"] });
  } catch (error) {
    console.warn("Browser Lyrics could not open on this tab:", error);
  }
});

let sharedTrack;
const lyricsCache = new Map();

async function getSharedTrack() {
  if (!sharedTrack) {
    const stored = await chrome.storage.session.get("currentTrack");
    sharedTrack = stored.currentTrack || null;
  }
  return sharedTrack;
}

async function broadcastTrack(track) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => tab.id == null ? null : chrome.tabs.sendMessage(tab.id, { type: "TRACK_UPDATE", track }).catch(() => null)));
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const track = await getSharedTrack();
  if (track?.sourceTabId === tabId) {
    sharedTrack = null;
    await chrome.storage.session.remove("currentTrack");
    await broadcastTrack(null);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_NOW_PLAYING") {
    getSharedTrack().then((track) => sendResponse({ track }));
    return true;
  }
  if (message.type === "SET_NOW_PLAYING") {
    const track = { ...message.track, sourceTabId: _sender.tab?.id, updatedAt: Date.now() };
    (async () => {
      sharedTrack = track;
      await chrome.storage.session.set({ currentTrack: track });
      await broadcastTrack(track);
      sendResponse({ ok: true });
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message.type === "PLAYER_CONTROL") {
    getSharedTrack().then(async (track) => {
      if (track?.sourceTabId == null) {
        sendResponse({ ok: false });
        return;
      }
      const result = await chrome.tabs.sendMessage(track.sourceTabId, { type: "DO_PLAYER_CONTROL", action: message.action }).catch(() => null);
      sendResponse({ ok: result?.ok === true });
    });
    return true;
  }
  if (message.type === "SEEK_PLAYER") {
    getSharedTrack().then(async (track) => {
      if (track?.sourceTabId == null) {
        sendResponse({ ok: false });
        return;
      }
      const result = await chrome.tabs.sendMessage(track.sourceTabId, { type: "DO_SEEK", seconds: message.seconds }).catch(() => null);
      sendResponse({ ok: result?.ok === true });
    });
    return true;
  }
  if (message.type === "SEARCH_ON_PLAYER" || message.type === "PLAY_ON_PLAYER") {
    getSharedTrack().then(async (track) => {
      if (track?.sourceTabId != null) {
        const forward = message.type === "SEARCH_ON_PLAYER"
          ? { type: "DO_SEARCH", query: message.query }
          : { type: "DO_PLAY_TRACK", title: message.title, videoId: message.videoId, mode: message.mode || "play" };
        try {
          const result = await chrome.tabs.sendMessage(track.sourceTabId, forward);
          sendResponse(message.type === "PLAY_ON_PLAYER" ? result : { ok: true });
        } catch (_error) {
          sendResponse({ ok: false, error: "YouTube Music tab did not receive the request" });
        }
        return;
      }
      sendResponse({ ok: false, error: "No active YouTube Music tab" });
    }).catch(() => sendResponse({ ok: false, error: "Could not locate the YouTube Music tab" }));
    return true;
  }
  if (message.type === "SEARCH_RESULTS_UPDATED") {
    const packet = { type: "SEARCH_RESULTS_AVAILABLE", query: message.query, results: message.results || [], error: message.error || "" };
    (async () => {
      const tabs = await chrome.tabs.query({});
      await Promise.all(tabs.map((tab) => tab.id == null ? null : chrome.tabs.sendMessage(tab.id, packet).catch(() => null)));
      sendResponse({ ok: true });
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message.type !== "LOOKUP_LYRICS") return;
  const cacheKey = `${message.videoId || ""}|${message.artist || ""}|${message.track || ""}`.toLowerCase();
  if (lyricsCache.has(cacheKey)) {
    sendResponse(lyricsCache.get(cacheKey));
    return false;
  }
  (async () => {
    let providerFailed = false;
    let plainFallback = null;
    const fetchWithTimeout = async (url, timeoutMs = 8000) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    };
    const normalize = (value) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    // Prefer the currently playing video's own synchronized lyrics. Plain-text
    // providers must not win early and suppress live line tracking.
    const playingTrack = await getSharedTrack();
    if (playingTrack?.videoId && playingTrack.sourceTabId != null) {
      try {
        const nativeLyrics = await chrome.tabs.sendMessage(playingTrack.sourceTabId, { type: "GET_YTM_LYRICS", videoId: playingTrack.videoId });
        if (nativeLyrics?.lyrics?.syncedLyrics) return nativeLyrics;
        if (nativeLyrics?.lyrics?.plainLyrics) plainFallback = nativeLyrics;
        if (nativeLyrics?.error) providerFailed = /could not|reload|returned|connection/i.test(nativeLyrics.error);
      } catch (_error) { providerFailed = true; }
    }
    const params = new URLSearchParams({ track_name: message.track });
    if (message.artist) params.set("artist_name", message.artist);
    try {
      const exact = await fetchWithTimeout(`https://lrclib.net/api/get?${params}`);
      if (exact.ok) {
        const lyrics = await exact.json();
        if (lyrics.syncedLyrics) return { lyrics, provider: "LRCLIB" };
        if (lyrics.plainLyrics) plainFallback ||= { lyrics, provider: "LRCLIB" };
      }
    } catch (_error) {
      providerFailed = true;
      // Continue with LRCLIB search and the independent fallback provider.
    }
    try {
      const query = new URLSearchParams({ q: [message.track, message.artist].filter(Boolean).join(" ") });
      const searched = await fetchWithTimeout(`https://lrclib.net/api/search?${query}`);
      if (searched.ok) {
        const matches = await searched.json();
        const wanted = normalize(message.track);
        const wantedArtist = normalize(message.artist || "");
        const exactTrackAndArtist = matches.find((item) => normalize(item.trackName || "") === wanted &&
          (!wantedArtist || normalize(item.artistName || "").includes(wantedArtist) || wantedArtist.includes(normalize(item.artistName || ""))));
        const match = exactTrackAndArtist || matches.find((item) => normalize(item.trackName || "") === wanted) ||
          matches.find((item) => (normalize(item.trackName || "").includes(wanted) || wanted.includes(normalize(item.trackName || ""))) &&
            (!wantedArtist || normalize(item.artistName || "").includes(wantedArtist)));
        if (match?.syncedLyrics) return { lyrics: match, provider: "LRCLIB" };
        if (match?.plainLyrics) plainFallback ||= { lyrics: match, provider: "LRCLIB" };
      }
    } catch (_error) {
      providerFailed = true;
      // Try the independent lyrics provider below if LRCLIB search is unavailable.
    }

    if (plainFallback) return plainFallback;

    // Lyrics.ovh is a separate catalog. It returns unsynced text, so the player can show lyrics
    // when LRCLIB has no match, but it cannot highlight lines against playback time.
    const artistNames = [...new Set([message.artist, ...(message.artist || "").split(/[,/&]/)].map((x) => x.trim()).filter(Boolean))];
    let candidates = [{ artist: "", title: message.track }];
    try {
      const suggestion = await fetchWithTimeout(`https://api.lyrics.ovh/suggest/${encodeURIComponent([message.track, message.artist].filter(Boolean).join(" "))}`);
      if (suggestion.ok) {
        const data = await suggestion.json();
        const wanted = normalize(message.track);
        const matches = (data.data || []).filter((item) => normalize(item.title || "") === wanted);
        for (const item of matches) {
          const artist = typeof item.artist === "string" ? item.artist : item.artist?.name;
          if (artist) candidates.push({ artist, title: item.title });
        }
      }
    } catch (_error) { providerFailed = true; /* Direct artist/title attempts can still succeed. */ }

    for (const candidate of candidates) {
      const names = [...new Set([candidate.artist, ...artistNames].filter(Boolean))];
      for (const artist of names) {
        try {
          const response = await fetchWithTimeout(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(candidate.title)}`);
          if (!response.ok) continue;
          const data = await response.json();
          if (data.lyrics) return { lyrics: { plainLyrics: data.lyrics, syncedLyrics: null }, provider: "Lyrics.ovh" };
        } catch (_error) { providerFailed = true; /* Continue trying artist variants. */ }
      }
    }
    // YouTube Music's own lyric tab often has Hindi catalog coverage that the public
    // lyric databases miss. Ask the tab playing this exact track as the last fallback.
    if (providerFailed) throw new Error("Lyrics sources could not be reached. Try reloading YouTube Music and search again.");
    throw new Error("No lyrics found in LRCLIB, Lyrics.ovh, or YouTube Music for this song.");
  })()
    .then((result) => { lyricsCache.set(cacheKey, result); sendResponse(result); })
    .catch((error) => sendResponse({ error: error.message || "Lyrics providers are unreachable. Check your internet connection." }));
  return true;
});
