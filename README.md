# Fundi Maintenance website

Website for Fundi Maintenance (George, Western Cape).

The live site is `site/` (served by Cloudflare as Worker assets, see `wrangler.jsonc`). It also holds the design mockups:

- `site/index.html` – the live home page (Trusted Local Pro)
- `site/clean-studio/` – Option 1
- `site/editorial-journal/` – Option 2
- `site/trusted-local-pro/` – Option 3


## Chat to change

`chat-to-change/` is WebBrew's shared chat-to-change Worker (never edit its `worker.js` here; it comes from adinwalls/webbrew-chat-to-change). It runs the private page at `/chat-to-change` where Fundi can change a photo, add a special or ask for a change. Settings: `chat-to-change/client.json`. Alerts go to Adin in Telegram through the shared WebBrew bot.
