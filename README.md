# Page Summarizer

A Chrome extension that automatically summarizes the article or website you're looking at, using Claude.

Click the toolbar icon to open a side panel. While the panel is open, it follows you as you browse. Each time you open a page or switch tabs, it pulls out the page's main text and streams a short summary into the panel.

## Features

- **Automatic summaries**: summarizes each page as it loads and when you switch tabs. You can turn this off with the **Auto** switch.
- **Article detection**: by default it only summarizes automatically when the page looks like an article. On other pages (apps, dashboards, search results), press **Summarize** to get a summary anyway.
- **Clean text extraction**: uses Mozilla's Readability (the engine behind Firefox Reader View) to remove navigation, ads and footers before anything is sent.
- **PDFs**: PDFs opened in Chrome are sent to Claude as documents.
- **Saved summaries**: going back to a page you've already summarized shows the saved summary right away, with no new request. Saved summaries are cleared when you close the browser.
- **Excluded sites**: email and messaging sites are excluded from automatic summaries by default. You can edit the list.
- **Cost display**: each summary shows its token usage and an estimated cost.

## Install

You don't need to build anything. The ready-to-load extension is in the `dist` folder.

1. Download this repository (**Code → Download ZIP**, then unzip it) or clone it.
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `dist` folder.
5. The settings page opens. Paste your Anthropic API key (create one at [console.anthropic.com](https://console.anthropic.com/settings/keys)) and click **Save**. It checks that the key works.
6. Pin the extension: click the puzzle-piece icon in the toolbar, then the pin next to **Page Summarizer**.
7. Click the extension's icon to open the summary panel, then browse as usual.

Requires Chrome 120 or newer.

## Using it

| Control | What it does |
| --- | --- |
| **Summarize** | Summarizes the current page, even if automatic summaries would skip it |
| **Stop** | Cancels the summary in progress |
| **Regenerate** | Writes a fresh summary of the current page |
| **Copy** | Copies the summary as Markdown |
| **Auto** switch | Turns automatic summaries on or off |
| ⚙ | Opens the settings |

In **Settings** you can choose:

- **Model**: Claude Opus 5.5 (default, best quality), Claude Sonnet 5.5 (faster, about half the cost) or Claude Haiku 4.5 (fastest and cheapest).
- **Length**: Brief, Standard or Detailed.
- **Automatic summaries**: whether to summarize automatically, whether to do so only on article-like pages, and which sites never to summarize automatically.

To summarize files on your computer (`file://` pages), open `chrome://extensions`, click **Details** on Page Summarizer and turn on **Allow access to file URLs**.

## Cost

Summaries are billed to your Anthropic account at standard API prices. A typical news article costs about 2–5 cents with Opus 5.5, about half that with Sonnet 5.5 and about a quarter with Haiku 4.5. Very long pages are cut at about 300,000 characters, and the panel tells you when that happens.

Automatic summaries only run while the side panel is open. They only cover article-like pages unless you change that setting, and saved summaries are never paid for twice.

## Privacy

- To write a summary, the page's text (or the PDF) is sent to Anthropic's API using your key. The extension has no server of its own and collects nothing.
- Your API key is stored in `chrome.storage.local` in this browser profile. It isn't synced to your Google account, and it's only sent to `api.anthropic.com`.
- The extension asks for access to all sites so it can read whichever page you're viewing. It only reads a page when the side panel is open and showing that page.

## How it works

- `src/background.js`: makes the toolbar icon open the side panel, and opens the settings page on first install.
- `src/sidepanel.js`: tracks the active tab, decides whether to summarize, extracts the page, streams the summary and caches it in `chrome.storage.session`.
- `src/content.js`: injected into the page on demand. It runs Readability and returns the article text with headings and lists preserved.
- `src/summarize.js`: calls the Claude API with the official [Anthropic TypeScript/JavaScript SDK](https://github.com/anthropics/anthropic-sdk-typescript), streaming the response. It sets low effort, because summaries don't need deep reasoning. On Opus and Sonnet it also turns on server-side refusal fallbacks (`fallbacks: "default"`): if the model's safety filter declines a page, the API retries on Anthropic's recommended fallback model.
- `src/markdown.js`: a small Markdown renderer that escapes all HTML, so a summary can't inject markup into the panel.
- `src/settings.js` and `src/options.js`: settings storage and the settings page.

## Development

```bash
npm install
npm run build   # bundles src/ + public/ into dist/
npm run watch   # rebuilds JavaScript on change (re-run build after editing public/)
```

After rebuilding, click the reload icon on the extension's card in `chrome://extensions`. If the side panel is already open, close and reopen it.
