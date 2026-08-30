# iPhone Shortcut

Create a Shortcut that accepts both URLs and Safari web pages from the share sheet:

1. Enable the Shortcut for the share sheet and accept **URLs** and **Safari web pages**.
2. Add an **If** action: when Shortcut Input is a Safari web page, run **Run JavaScript on Web Page** with [`capture-page.js`](./capture-page.js) and save its result as `Request Body`.
3. In **Otherwise**, create a Dictionary named `Request Body` with `url` from Shortcut Input and `saved_via` set to `ios_shortcut`. This is the URL-only path for other apps.
4. After **End If**, add **Get Contents of URL** using `https://api.url-keep.com/bookmarks`.
5. Set the method to `POST`, request body to JSON, and pass the `Request Body` dictionary.
6. Add headers `Authorization: Bearer <your url-keep token>` and `Content-Type: application/json`.
7. Leave the API's normal JSON response unused, or show its saved title as a brief confirmation.

The Safari branch submits the live DOM so signed-in and client-rendered pages can be read offline. It measures the exact serialized JSON before sending it and falls back to URL/title metadata above 4.5 MiB; the server then attempts its normal extraction fallback. Never add logging or intermediate storage for the captured HTML or token.
