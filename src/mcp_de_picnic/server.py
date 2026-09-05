"""MCP server exposing Picnic grocery-delivery tools.

Every tool below is a thin wrapper around PicnicClient (picnic_client.py). All
Picnic-specific errors (bad credentials, expired session, missing 2FA, rate limiting,
network failures) are caught here and re-raised as `ToolError`, so the calling model
sees a clean, single-line message instead of a Python traceback — see the SDK's
ToolError docs: its message reaches the model, everything else is logged server-side
only and reported generically.

Credentials (PICNIC_EMAIL / PICNIC_PASSWORD / PICNIC_COUNTRY_CODE) are read from the
environment exactly once, the first time a tool actually needs to talk to Picnic. They
are never logged and never appear in any error message this module raises.
"""

from __future__ import annotations

import os
from typing import Any, Callable, TypeVar

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from .errors import PicnicError
from .picnic_client import PicnicClient

mcp = MCPServer("de-picnic")

_client: PicnicClient | None = None

T = TypeVar("T")


def _get_client() -> PicnicClient:
    global _client
    if _client is not None:
        return _client

    email = os.environ.get("PICNIC_EMAIL")
    password = os.environ.get("PICNIC_PASSWORD")
    country_code = os.environ.get("PICNIC_COUNTRY_CODE", "DE")
    token_cache_path = os.environ.get("PICNIC_TOKEN_CACHE_FILE") or None

    if not email or not password:
        raise ToolError(
            "PICNIC_EMAIL and PICNIC_PASSWORD environment variables are required but "
            "not set. Copy .env.example to .env, fill in your Picnic credentials, and "
            "make sure they're exported to this process (see README)."
        )

    try:
        _client = PicnicClient(
            email=email,
            password=password,
            country_code=country_code,
            token_cache_path=token_cache_path,
        )
    except PicnicError as exc:
        raise ToolError(str(exc)) from exc
    return _client


def _call(fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    try:
        return fn(*args, **kwargs)
    except PicnicError as exc:
        raise ToolError(str(exc)) from exc


@mcp.tool()
def search_products(query: str) -> list[dict]:
    """Search Picnic's product catalog.

    Returns a list of matches, each with: id, name, price (float, EUR), currency, unit.
    """
    return _call(_get_client().search_products, query)


@mcp.tool()
def get_cart() -> dict:
    """Get the full Picnic basket.

    Returns items (each with product_id, name, unit, quantity, unit_price, line_total),
    plus total_count and cart_total for the whole basket.
    """
    return _call(_get_client().get_cart)


@mcp.tool()
def add_to_cart(product_id: str, count: int = 1) -> dict:
    """Add `count` units of a product to the cart (product_id from search_products).

    Returns the updated cart, same shape as get_cart().
    """
    return _call(_get_client().add_to_cart, product_id, count)


@mcp.tool()
def remove_from_cart(product_id: str, count: int = 1) -> dict:
    """Remove `count` units of a product from the cart (product_id from get_cart/search_products).

    Returns the updated cart, same shape as get_cart().
    """
    return _call(_get_client().remove_from_cart, product_id, count)


@mcp.tool()
def clear_cart() -> dict:
    """Empty the Picnic cart entirely. Returns the now-empty cart."""
    return _call(_get_client().clear_cart)


@mcp.tool()
def get_delivery_slots() -> list[dict]:
    """List available delivery slots for the current cart.

    Each slot includes slot_id, window_start, window_end, cut_off_time, is_available,
    minimum_order_value, and `suggested` (true for the slot Picnic has pre-selected as
    its default).
    """
    return _call(_get_client().get_delivery_slots)


@mcp.tool()
def set_delivery_slot(slot_id: str) -> str:
    """Select a delivery slot by its slot_id (see get_delivery_slots)."""
    _call(_get_client().set_delivery_slot, slot_id)
    return f"Delivery slot '{slot_id}' selected."


@mcp.tool()
def generate_2fa_code(channel: str = "SMS") -> str:
    """Ask Picnic to send a 2FA code, for accounts that require it.

    channel is "SMS" or "EMAIL". Call this first if any other tool fails with a message
    about 2FA being required, then call verify_2fa_code with the code you receive.
    """
    _call(_get_client().generate_2fa_code, channel)
    return f"A 2FA code was requested via {channel.strip().upper()}. Call verify_2fa_code with the code you received."


@mcp.tool()
def verify_2fa_code(code: str) -> str:
    """Complete login by verifying the 2FA code requested via generate_2fa_code."""
    _call(_get_client().verify_2fa_code, code)
    return "2FA verified — logged in to Picnic."


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
