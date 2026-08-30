# iPhone Shortcut

Create a Shortcut that accepts both URLs and Safari web pages from the share sheet:

1. Enable the Shortcut for the share sheet and accept **URLs** and **Safari web pages**.
2. Add an **If** action: when Shortcut Input is a Safari web page, run **Run JavaScript on Web Page** with [`capture-page.js`](./capture-page.js). Save its `bookmark` dictionary as `Bookmark Request` and its optional `capture_html` text as `Capture HTML`.
3. In **Otherwise**, create a Dictionary named `Bookmark Request` with `url` from Shortcut Input and `saved_via` set to `ios_shortcut`. Leave `Capture HTML` empty. This is the URL-only path for other apps.
4. After **End If**, add **Get Contents of URL** using `https://api.url-keep.com/bookmarks`. Set the method to `POST`, request body to JSON, and pass `Bookmark Request`.
5. Add headers `Authorization: Bearer <your url-keep token>` and `Content-Type: application/json`. Save the response's `item.bookmark.id` as `Bookmark ID`.
6. If `Capture HTML` has a value, add a second **Get Contents of URL** for `https://api.url-keep.com/bookmarks/Bookmark ID/capture`. Set the method to `PUT`, set `Content-Type: text/html; charset=utf-8`, and send `Capture HTML` as the raw/file request body. Save its `item.article.status` value.
7. If `Capture HTML` is empty, the capture request fails, or the returned article status is not `complete`, call `POST https://api.url-keep.com/bookmarks/Bookmark ID/extract` with the same bearer token so the server attempts a bounded URL extraction.
8. Leave the final JSON response unused, or show its saved title as a brief confirmation.

The Safari branch submits the live DOM separately from bookmark metadata so the server can enforce a bounded raw-HTML transport contract. It measures the exact UTF-8 HTML size and falls back to URL extraction above 4.5 MiB. Never add logging or intermediate storage for the captured HTML or token.
