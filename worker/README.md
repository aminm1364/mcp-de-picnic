# Picnic MCP on Cloudflare Workers (remote)

A **remote** MCP server for Picnic (Germany/Netherlands) that runs on Cloudflare Workers,
so it works from Claude Code, claude.ai, Claude Desktop and the Claude mobile app — without
your computer being on. Written in TypeScript, plain `fetch` calls, no Picnic wrapper library.

> **Unofficial.** Not affiliated with or endorsed by Picnic. It uses Picnic's private mobile-app
> endpoints, which may change or break without notice, and may not be consistent with Picnic's
> Terms of Service. Use at your own risk. See [../ENDPOINTS.md](../ENDPOINTS.md).

## Tools

| Tool | What it does |
|---|---|
| `search_products(query)` | Products with `id`, `name`, `price`, `unit`, `image_url` |
| `get_cart()` | Cart items (with images), quantities, line totals, cart total |
| `add_to_cart` / `remove_from_cart` / `clear_cart` | Edit the cart |
| `get_delivery_slots()` / `set_delivery_slot(slot_id)` | Slots; Picnic's suggested one is flagged |
| `generate_2fa_code()` / `verify_2fa_code(code)` | SMS 2FA login |
| `search_recipes(query)` | Search Picnic's meals (Rezepte) |
| `list_recipes(section)` | `cookbook`, `weekly_suggestions` or `ordered` |
| `get_recipe(recipe_id)` | Description, time, portions, ingredients, products to buy (with `product_id`), nutrition, allergens, step-by-step instructions, image |
| `get_image(image_id, size)` | A product or recipe picture as an image |

It never places or confirms an order — there is no checkout tool.

## How it is secured

- **Only you can connect.** The server implements the MCP OAuth flow (dynamic client registration,
  PKCE) using [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider),
  with **Google** as the login. After sign-in it checks the verified email against `ALLOWED_EMAIL`;
  anyone else gets 403.
- **No secrets in the repo or logs.** Picnic email/password, the Google client secret and the
  encryption key are Cloudflare secrets (`wrangler secret put`).
- **Picnic session token** is stored in Workers KV, **AES-GCM encrypted** with `STATE_KEY`, expires
  after 30 days, and is refreshed by an automatic re-login on a 401.
- No telemetry. Outbound calls go only to `storefront-prod.<country>.picnicinternational.com`
  (and Google's sign-in endpoints for the OAuth login).

## Deploy

Requirements: a Cloudflare account with a domain on it, Node 20+, a Google Cloud OAuth client.

```bash
cd worker
npm install
cp wrangler.example.jsonc wrangler.jsonc      # then edit hostname + KV ids
npx wrangler login
npx wrangler kv namespace create STATE        # put the ids into wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV

openssl rand -base64 32 | npx wrangler secret put STATE_KEY
npx wrangler secret put PICNIC_EMAIL          # type the value at the prompt
npx wrangler secret put PICNIC_PASSWORD
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put ALLOWED_EMAIL

npx wrangler deploy
```

**Google OAuth client** (Google Cloud Console → APIs & Services → Credentials → OAuth client ID,
type *Web application*): add the authorized redirect URI `https://<your-host>/callback`.

## Connect

- **Claude Code:** `claude mcp add --transport http picnic https://<your-host>/mcp`, then `/mcp` → Authenticate.
- **claude.ai / Desktop / mobile:** Settings → Connectors → Add custom connector → `https://<your-host>/mcp`.
  Connectors added on the web sync to the other Claude apps.

First use may need a 2FA code: ask Claude to call `generate_2fa_code`, then `verify_2fa_code`.

## Notes

- Claude first probes with a newer `MCP-Protocol-Version` than the server supports and gets one HTTP 400,
  then retries with a supported version. That is normal protocol negotiation, not an error.
- Recipe/meals data comes from Picnic's server-driven UI pages, so parsing is best-effort and may need
  updates when Picnic changes the app.

MIT licensed — see [../LICENSE](../LICENSE).
