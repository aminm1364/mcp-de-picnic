# Picnic private API — endpoint reference

This file documents every Picnic endpoint used by this project, so it is easy to audit
and easy to fix if Picnic changes something server-side.

**Nothing in this file was copied from another project.** The paths, payload shapes, and
header names below were learned by *reading* (not importing/vendoring) these open-source
references, then re-implemented independently in [`src/mcp_de_picnic/picnic_client.py`](src/mcp_de_picnic/picnic_client.py)
using only `requests`:

- https://github.com/MikeBrink/python-picnic-api
- https://github.com/daviddemeij/python-picnic-api
- https://github.com/codesalatdev/python-picnic-api (`python-picnic-api2`, adds 2FA)
- https://github.com/MRVDH/picnic-api (Node.js, has explicit TypeScript response types)
- https://github.com/ivo-toby/mcp-picnic (MCP server, for tool-shape ideas only)

Picnic has no public/official documentation. All of this is reverse-engineered from the
mobile app's private traffic by the community. **It can change or break at any time.**

## Base URL

```
https://storefront-prod.{country}.picnicinternational.com/api/{version}
```

- `{country}` — lowercase ISO 3166-1 alpha-2 code. Picnic only operates in `de` and `nl`.
- `{version}` — `15`. `/cart`, `/cart/add_product`, `/cart/remove_product`,
  `/cart/clear`, and `/cart/delivery_slots` all still return simple flat JSON on this
  version, verified live against a real DE account on 2026-09-05. **Search does not**:
  the classic `GET /search?search_term=` endpoint the older wrappers document now
  returns a real `404 {"error":{"code":"NOT_FOUND", ...}}` — Picnic has retired it.
  Search now has to go through the newer PML/"page renderer" API instead (see below).
  If Picnic ever retires the classic cart endpoints too, the fix is the same pattern:
  find the new path, and adjust `picnic_client.py` accordingly — that's the whole
  point of keeping this file up to date.

## Headers

Sent on every request:

| Header | Value |
|---|---|
| `User-Agent` | `okhttp/4.9.0` (mimics the Android app's HTTP client) |
| `Content-Type` | `application/json; charset=UTF-8` |
| `x-picnic-auth` | session token, once logged in |

Sent additionally on auth-related requests (`login`, `2fa/generate`, `2fa/verify`) in the
reference implementations, and sent on *all* requests here for simplicity/robustness:

| Header | Value |
|---|---|
| `x-picnic-agent` | `30100;1.15.183-14941;` — a fixed app-version identifier string |
| `x-picnic-did` | a random 16-char hex device ID, generated once per process, **held only in memory** |

We do not persist the device ID. This means some accounts may be asked to re-confirm 2FA
more often than the official app would (which persists a device ID across launches) —
that trade-off is intentional, see the "no persistent state by default" security posture
in the README.

## Auth

### `POST /user/login`

```json
{"key": "<email>", "secret": "<md5 hex of password>", "client_id": 30100}
```

- Response header `x-picnic-auth` carries the session token (captured after *every*
  request, not just login, since Picnic silently rotates it).
- If the JSON body contains `"second_factor_authentication_required": true`, the account
  needs 2FA. Note: Picnic still returns a (partial) `x-picnic-auth` token in this case,
  which is required for the two endpoints below — we keep it exactly the way we keep any
  other token.
- `401` → bad email/password.

### `POST /user/2fa/generate`

```json
{"channel": "SMS"}
```

`channel` is `"SMS"` or `"EMAIL"`. Requires the partial auth token from the login attempt
above. Typically responds `204 No Content`.

### `POST /user/2fa/verify`

```json
{"otp": "<code>"}
```

On success, the response's `x-picnic-auth` header carries the final, fully-authenticated
session token. Wrong/expired code → `400`/`401` with a JSON error body.

## Search

### ~~`GET /search?search_term=<query>`~~ — confirmed dead (404), do not use

This is what MikeBrink/daviddemeij's wrappers implement, and it's how this project
originally implemented search too. Tested live on 2026-09-05 against a real DE account:
`404 {"error":{"code":"NOT_FOUND","message":"Not Found","details":{}}}`. Picnic has
retired it. Kept here as a note so nobody re-adds it by copying an older reference.

### `GET /pages/search-page-results?search_term=<url-encoded query>`

This is what the current mobile app actually uses (confirmed working live). It returns
a "page" object — a deeply nested UI component tree (Picnic calls this their PML /
Fusion page format), not a flat product list. We don't model that tree at all. Product
data shows up wherever a `sellingUnit` key appears, at whatever depth, shaped like:

```json
{
  "sellingUnit": {
    "id": "s1019257",
    "name": "Arla Bio Bio Frische Weidemilch 1,5%",
    "display_price": 179,
    "unit_quantity": "1L",
    "image_id": "...",
    "max_count": 50,
    "decorators": [],
    "price_ranges": null
  }
}
```

`picnic_client.py`'s `_iter_selling_units()` recursively walks the whole response and
yields every `sellingUnit` value it finds, wherever it's nested — this is the same
technique MRVDH/picnic-api uses (a JSONPath `$..sellingUnit` query) reimplemented as a
plain recursive walk. **The same product commonly appears more than once** in the page
tree (e.g. once in the main result grid, again in a "you might also like" rail), so
`search_products()` de-duplicates by `id` before returning results. Note the field here
is `display_price` — no plain `price` key was observed on this endpoint; we still fall
back to `price` if present, since discounted items elsewhere in the API do carry both.
Prices are integer cents; we divide by 100 for display.

## Cart

### `GET /cart`

Returns an `ORDER`-shaped object:

```json
{
  "type": "ORDER",
  "items": [
    {
      "type": "ORDER_LINE",
      "id": "...",
      "price": 438,
      "items": [
        {"type": "ORDER_ARTICLE", "id": "s1234567", "name": "...", "unit_quantity": "500 gram", "price": 219}
      ]
    }
  ],
  "total_count": 3,
  "total_price": 657
}
```

Each `ORDER_LINE.items` array holds **one entry per unit** of that product in the basket
— i.e. quantity is `len(order_line["items"])`, not a separate `count` field. This is a
known quirk of Picnic's cart representation (confirmed against the TypeScript response
types in MRVDH/picnic-api). `order_line.price` is the line total; each article's own
`price` is the unit price.

### `POST /cart/add_product`

```json
{"product_id": "s1234567", "count": 2}
```

### `POST /cart/remove_product`

```json
{"product_id": "s1234567", "count": 1}
```

### `POST /cart/clear`

No payload.

## Delivery slots

### `GET /cart/delivery_slots`

```json
{
  "delivery_slots": [
    {
      "slot_id": "abc123",
      "window_start": "2026-09-06T18:00:00.000+02:00",
      "window_end": "2026-09-06T20:00:00.000+02:00",
      "cut_off_time": "2026-09-06T12:00:00.000+02:00",
      "is_available": true,
      "selected": false,
      "reserved": false,
      "minimum_order_value": 3500
    }
  ],
  "selected_slot": {"slot_id": "abc123", "state": "..."},
  "slot_selector_message": { "...": "..." }
}
```

A slot is treated as **suggested/default** by this project if either its own `selected`
field is `true`, or its `slot_id` matches the top-level `selected_slot.slot_id`.

### `POST /cart/set_delivery_slot`

```json
{"slot_id": "abc123"}
```

## Error handling

| HTTP status | Meaning here |
|---|---|
| `401` | Bad credentials or expired/invalid session token |
| `400` on `/user/2fa/verify` | Wrong/expired 2FA code |
| `429` | Picnic is rate-limiting this account/IP |
| other `4xx`/`5xx` | Generic Picnic API error; message body (if any) is surfaced, truncated |

`picnic_client.py` never lets a raw `requests` exception or HTTP body propagate as-is to
the MCP tool layer — see `errors.py` for the small set of typed exceptions each tool
catches and turns into a one-line, credential-free message.
