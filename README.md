# Last One Laughing — replay gallery (static export)

Read-only archive of the saved buzz moments. Serve this directory from any static host
(GitHub Pages, Cloudflare Pages, nginx, …). `recordings.json` is the gallery's data file;
videos live under `recordings/`. Re-run `npm run export:gallery` on the game laptop to refresh.

This export is ENCRYPTED (AES-256-GCM, PBKDF2 key). Only ciphertext is here; the secret is
shared out of band via the URL fragment, e.g. https://<host>/#k=<secret> — fragments are
never sent to the server. `keyinfo.json` (salt/iterations) is public by design.
