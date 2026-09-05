# mcp-de-picnic

An [MCP](https://modelcontextprotocol.io) server that lets an LLM (Claude, etc.) search
Picnic's catalog, manage your basket, and pick a delivery slot — for Picnic's grocery
delivery service in **Germany and the Netherlands**.

> ## ⚠️ Unofficial, reverse-engineered, use at your own risk
>
> Picnic has **no official public API**. This project talks to the same private HTTP
> endpoints the Picnic mobile app uses, reimplemented independently from scratch (see
> [ENDPOINTS.md](ENDPOINTS.md)) using plain `requests` calls — **no Picnic-owned code,
> and no third-party Picnic wrapper library, is used or depended on.**
>
> - This project is **not affiliated with, endorsed by, or supported by Picnic** in any way.
> - Picnic can change or break these endpoints at any time, without notice, and this
>   server would then stop working until someone updates it.
> - Automating your account this way may or may not be consistent with Picnic's Terms
>   of Service. **You are responsible for deciding whether to use this, and for any
>   consequences to your account** (rate limiting, suspension, etc.). Use your own
>   judgment, especially for anything that places a real order or spends real money.
> - This server only ever talks to `*.picnicinternational.com`. It sends no telemetry,
>   analytics, or data to anyone else.

## What it does

| Tool | Description |
|---|---|
| `search_products(query)` | Search the catalog → `id`, `name`, `price`, `unit` for each hit |
| `get_cart()` | Full basket: items with quantity/unit price/line total, plus cart total |
| `add_to_cart(product_id, count)` | Add units of a product |
| `remove_from_cart(product_id, count)` | Remove units of a product |
| `clear_cart()` | Empty the basket |
| `get_delivery_slots()` | Available slots, flagging which one Picnic suggests/defaults to |
| `set_delivery_slot(slot_id)` | Choose a delivery slot |
| `generate_2fa_code(channel="SMS")` | Request a 2FA code (accounts that require it) |
| `verify_2fa_code(code)` | Complete login with that code |

This server **never places an order** — there is no checkout/pay tool. It stops at
"cart is ready with the slot you want."

## How credentials work (read this before installing)

- Credentials are read **only** from the environment variables `PICNIC_EMAIL`,
  `PICNIC_PASSWORD`, and `PICNIC_COUNTRY_CODE` at process startup. They are never
  hardcoded, never logged, and never included in any error message.
- The session token Picnic issues after login is kept **in memory only**, for the
  lifetime of the server process. Restarting the server means logging in again. This is
  deliberate — see `PicnicClient` in [`picnic_client.py`](src/mcp_de_picnic/picnic_client.py).
- If you'd rather not re-authenticate (and redo 2FA) every restart, you can opt in to a
  small on-disk token cache by setting `PICNIC_TOKEN_CACHE_FILE` to a file path. It is
  written with `0600` permissions and stores only the session token — never your
  password. This is off by default.
- No other network calls are made by this server besides the ones to
  `storefront-prod.{de,nl}.picnicinternational.com` documented in
  [ENDPOINTS.md](ENDPOINTS.md).
- The source is plain, readable Python — nothing obfuscated, nothing built. Read
  [`picnic_client.py`](src/mcp_de_picnic/picnic_client.py) yourself before trusting it
  with your account.

## Install

Requires Python 3.10+.

```bash
git clone https://github.com/aminm1364/mcp-de-picnic.git
cd mcp-de-picnic
pipx install .          # or: pip install .
# or, for local development: pip install -e .
```

`requirements.txt` is also provided if you'd rather manage the venv yourself:

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

## Configure

```bash
cp .env.example .env
# edit .env with your Picnic email, password, and country code (DE or NL)
```

`PICNIC_COUNTRY_CODE` defaults to `DE` if you leave it unset — set it to `NL` if your
Picnic account is Dutch. No other country codes are valid; Picnic only operates in
these two.

These variables need to be in the environment of whatever process actually launches the
server (see the Claude Desktop config below, or `export`/`source .env` if running it
directly).

## Test it with the MCP Inspector first

Before wiring this into Claude Desktop, verify each tool works against your real
account using the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
# from the repo root, with your venv activated and .env filled in
set -a && source .env && set +a
npx @modelcontextprotocol/inspector python -m mcp_de_picnic
```

This opens a local web UI where you can call each tool by hand. A sensible order to
test in:

1. `search_products` with a common word (e.g. `"melk"` / `"milch"`) — confirms auth +
   search parsing works.
2. If any tool's result says a 2FA code is required: call `generate_2fa_code`, then
   `verify_2fa_code` with the code Picnic sends you, then retry.
3. `add_to_cart` with a `product_id` from step 1, then `get_cart` to confirm it shows up
   with the right quantity/price.
4. `get_delivery_slots` — check that exactly one slot comes back with `"suggested":
   true`.
5. `set_delivery_slot` with a `slot_id` from step 4.
6. `remove_from_cart` / `clear_cart` to clean up.

If a tool returns an error, the message is meant to be self-explanatory (bad
credentials, expired session, wrong 2FA code, rate limited, etc.) — see
[ENDPOINTS.md](ENDPOINTS.md#error-handling) for the full mapping. If you get something
that looks like a raw stack trace instead, that's a bug — please file an issue.

## Configure in Claude Desktop

Edit your `claude_desktop_config.json` (Claude menu → Settings → Developer → Edit
Config), and add an entry under `mcpServers`:

```json
{
  "mcpServers": {
    "de-picnic": {
      "command": "python",
      "args": ["-m", "mcp_de_picnic"],
      "env": {
        "PICNIC_EMAIL": "you@example.com",
        "PICNIC_PASSWORD": "your-picnic-password",
        "PICNIC_COUNTRY_CODE": "DE"
      }
    }
  }
}
```

If you installed with `pipx install .`, you can use the console script instead and drop
the `-m` args:

```json
{
  "mcpServers": {
    "de-picnic": {
      "command": "mcp-de-picnic",
      "env": {
        "PICNIC_EMAIL": "you@example.com",
        "PICNIC_PASSWORD": "your-picnic-password",
        "PICNIC_COUNTRY_CODE": "DE"
      }
    }
  }
}
```

Restart Claude Desktop after editing the config. Your credentials live in this JSON
file on your own machine — they are not sent anywhere by this project except to Picnic
itself during login.

## 2FA accounts

Some Picnic accounts require a one-time code on login. If a tool call fails with a
message about 2FA being required:

1. Ask Claude to call `generate_2fa_code` (defaults to SMS; pass `channel="EMAIL"` if
   you'd rather get it by email).
2. Check your phone/email for the code.
3. Ask Claude to call `verify_2fa_code` with that code.
4. Retry whatever you were doing.

## Project layout

```
src/mcp_de_picnic/
  picnic_client.py   # raw HTTP client for Picnic — the only file that talks to Picnic
  errors.py          # typed exceptions, all with credential-free messages
  server.py          # MCP tool definitions, thin wrappers around PicnicClient
ENDPOINTS.md         # every Picnic endpoint used: path, method, payload, and sources
```

## Contributing / when Picnic changes something

If a tool starts failing, the fastest way to fix it is usually to update
[ENDPOINTS.md](ENDPOINTS.md) and the matching bit of `picnic_client.py` — it's a small,
single-purpose file with no hidden layers. PRs welcome.

## License

MIT — see [LICENSE](LICENSE).
