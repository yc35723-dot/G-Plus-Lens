# G+Lens

An extension for Brave, Edge, and other Chromium browsers that replicates Google Lens. Simply drag and select any area of a page to search the web with Google Lens. Requires Chromium 116 or higher.

## Installation

1. Click `Code` → `Download ZIP` on this page, then unzip the downloaded folder.
2. Enter `chrome://extensions` in the URL bar.
3. Enable "Developer mode".
4. Click "Load unpacked" and select the unzipped project folder.
5. Pin `G+Lens` to your toolbar.

## How to Use

| Method | Action |
|---|---|
| Toolbar | Click the extension icon |
| Context Menu | Right-click → Search with G+Lens |
| Shortcut | `Alt+Shift+S` |

Once in selection mode, drag to select the area you want to search. Release the mouse to open the search results window.

## Settings

Right-click the extension on the toolbar and select "Options".
- **[Default] Exit selection mode when closing the results window**: When enabled, closing the search results window will return you directly to the original webpage instead of leaving the selection overlay active.
- **Keyboard Shortcut**: Default is `Alt+Shift+S`, customizable.
- **[Enabled by default] Allow scrolling while selecting**: The page remains dimmed while you select an area, but you can scroll with the mouse wheel. The extension captures the visible page after you finish selecting. Turn this off to restore the previous behavior, which freezes the page during selection.
- **[Disabled by default] Search in an incognito window** *(experimental)*: When enabled, Google Lens opens in the browser's built-in incognito mode and receives the selected image directly, without using the G+Lens Viewer. It does not use the Google account signed in to your regular browser profile. You must also allow G+Lens to run in incognito mode in your browser's extension settings. Currently, the search briefly passes through Google's reverse image search page before opening Lens results; this limitation is still being investigated.

## G+Lens is not an official Google product. Google and Google Lens are trademarks of Google LLC.