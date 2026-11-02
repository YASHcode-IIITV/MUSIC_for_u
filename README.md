# Browser Lyrics

A local Chrome extension that displays the current song and lyrics card across regular browser tabs, with a pop-out Picture-in-Picture player for keeping controls and lyrics visible over other apps. The YouTube Music tab shares its current song and playback time with the other open tabs.

## Load it in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this project folder.
4. Open a music or video page and start a song.
5. Reload your open tabs once so the extension can add the card to each one. Play a song in YouTube Music; the other tabs will show the same track and lyrics. Click ↗ to pop the card out into an always-on-top Picture-in-Picture window.

To appear on regular webpages, the extension asks for access to all sites. It reads page metadata and media playback time to identify what is playing, then sends the detected song title and artist to the lyrics providers. It does not read classroom content or send page text. Lyrics lookup tries LRCLIB first for synced lyrics, then Lyrics.ovh for plain lyrics. Lyrics.ovh text is not time-synced. The pop-out window requires a browser with the Document Picture-in-Picture API. Keep the YouTube Music tab open while using it; closing it ends playback. Search results and queue actions depend on YouTube Music's page structure and may need adjustment if its interface changes. Restricted pages such as `brave://` pages cannot host the card.

## Development

After editing extension files, click **Reload** on the extension card at `chrome://extensions`. No build step is required.
