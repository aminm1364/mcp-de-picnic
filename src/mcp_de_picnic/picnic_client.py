"""A small, dependency-free (aside from `requests`) HTTP client for Picnic's private API.

This is an independent re-implementation, not a vendored copy of any existing Picnic
wrapper. See ENDPOINTS.md for exactly which endpoints are used, where the shapes were
learned from, and why version 15 of the API was chosen.

Security posture (see README for the full rationale):
- The account password is only ever used once, in-memory, to compute an MD5 digest for
  the login call. It is never logged, never written to disk, never included in any
  exception message.
- The session auth token lives in memory for the lifetime of the process. It is only
  written to disk if the caller explicitly opts in by constructing this client with a
  `token_cache_path`.
- No network calls are made to anything other than `*.picnicinternational.com`.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import stat
from dataclasses import dataclass, field
from typing import Any, Iterable, Iterator
from urllib.parse import quote

import requests

from .errors import (
    Picnic2FAError,
    Picnic2FARequiredError,
    PicnicAuthError,
    PicnicError,
    PicnicNetworkError,
    PicnicRateLimitError,
    PicnicRequestError,
)

SUPPORTED_COUNTRY_CODES = ("DE", "NL")
API_VERSION = "15"
CLIENT_ID = 30100
AUTH_HEADER = "x-picnic-auth"
USER_AGENT = "okhttp/4.9.0"
PICNIC_AGENT = "30100;1.15.183-14941;"
REQUEST_TIMEOUT_SECONDS = 15


def _base_url(country_code: str) -> str:
    country = country_code.strip().lower()
    return f"https://storefront-prod.{country}.picnicinternational.com/api/{API_VERSION}"


def _new_device_id() -> str:
    return secrets.token_hex(8).upper()


def _money(cents: Any) -> float | None:
    if cents is None:
        return None
    try:
        return round(int(cents) / 100, 2)
    except (TypeError, ValueError):
        return None


def _iter_selling_units(node: Any) -> Iterator[dict]:
    """Recursively walk a /pages/search-page-results response and yield product dicts.

    Picnic's search now returns a deeply-nested "page" description (a UI component
    tree) rather than a flat list. Product data lives wherever a "sellingUnit" key
    appears, at whatever depth — confirmed live against a real account on 2026-09-05,
    after the older flat /search endpoint turned out to have been retired (404). We
    don't try to model the rest of the page tree at all; we just walk every dict/list
    looking for that one key.
    """
    if isinstance(node, dict):
        selling_unit = node.get("sellingUnit")
        if isinstance(selling_unit, dict) and "id" in selling_unit and "name" in selling_unit:
            yield selling_unit
        for value in node.values():
            if isinstance(value, (list, dict)):
                yield from _iter_selling_units(value)
    elif isinstance(node, list):
        for item in node:
            yield from _iter_selling_units(item)


@dataclass
class PicnicClient:
    email: str
    password: str
    country_code: str = "DE"
    token_cache_path: str | None = None

    _session: requests.Session = field(init=False, repr=False)
    _auth_token: str | None = field(default=None, init=False, repr=False)
    _device_id: str = field(default_factory=_new_device_id, init=False, repr=False)

    def __post_init__(self) -> None:
        country = self.country_code.strip().upper()
        if country not in SUPPORTED_COUNTRY_CODES:
            raise PicnicError(
                f"Unsupported PICNIC_COUNTRY_CODE '{self.country_code}'. "
                f"Picnic only operates in: {', '.join(SUPPORTED_COUNTRY_CODES)}."
            )
        self.country_code = country
        self.base_url = _base_url(country)
        self._session = requests.Session()
        self._session.headers.update(
            {
                "User-Agent": USER_AGENT,
                "Content-Type": "application/json; charset=UTF-8",
                "x-picnic-agent": PICNIC_AGENT,
                "x-picnic-did": self._device_id,
            }
        )
        if self.token_cache_path:
            self._load_cached_token()

    # ---- state -----------------------------------------------------------------

    @property
    def is_authenticated(self) -> bool:
        return self._auth_token is not None

    def _load_cached_token(self) -> None:
        try:
            with open(self.token_cache_path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            return
        token = data.get("auth_token") if isinstance(data, dict) else None
        if token:
            self._set_token(token)

    def _save_cached_token(self) -> None:
        if not self.token_cache_path or not self._auth_token:
            return
        try:
            with open(self.token_cache_path, "w", encoding="utf-8") as fh:
                json.dump({"auth_token": self._auth_token}, fh)
            os.chmod(self.token_cache_path, stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            pass  # best-effort only; in-memory auth still works for this session

    def _set_token(self, token: str) -> None:
        self._auth_token = token
        self._session.headers[AUTH_HEADER] = token

    def forget_session(self) -> None:
        """Drop the in-memory token (and cache file, if any). Does not touch credentials."""
        self._auth_token = None
        self._session.headers.pop(AUTH_HEADER, None)
        if self.token_cache_path:
            try:
                os.remove(self.token_cache_path)
            except OSError:
                pass

    # ---- low-level request plumbing --------------------------------------------

    def _capture_token(self, response: requests.Response) -> None:
        token = response.headers.get(AUTH_HEADER)
        if token and token != self._auth_token:
            self._set_token(token)
            self._save_cached_token()

    def _raise_for_status(self, response: requests.Response) -> None:
        if response.ok:
            return
        if response.status_code == 401:
            self.forget_session()
            raise PicnicAuthError(
                "Picnic rejected the request (401): the email/password is wrong, or the "
                "session expired. Check PICNIC_EMAIL / PICNIC_PASSWORD and try again."
            )
        if response.status_code == 429:
            raise PicnicRateLimitError(
                "Picnic is rate-limiting this account or IP (429). Wait before retrying."
            )
        raise PicnicRequestError(
            f"Picnic API returned HTTP {response.status_code}: {self._extract_message(response)}"
        )

    @staticmethod
    def _extract_message(response: requests.Response) -> str:
        try:
            data = response.json()
        except ValueError:
            return "(no further details in response body)"
        if isinstance(data, dict):
            error = data.get("error")
            if isinstance(error, dict) and error.get("message"):
                return str(error["message"])[:300]
            if data.get("message"):
                return str(data["message"])[:300]
        return str(data)[:300]

    def _request(
        self,
        method: str,
        path: str,
        json_body: dict | None = None,
        require_auth: bool = True,
    ) -> Any:
        if require_auth and not self.is_authenticated:
            raise PicnicAuthError("Not logged in to Picnic yet.")
        url = self.base_url + path
        try:
            response = self._session.request(
                method, url, json=json_body, timeout=REQUEST_TIMEOUT_SECONDS
            )
        except requests.RequestException as exc:
            raise PicnicNetworkError(
                f"Could not reach Picnic ({exc.__class__.__name__}). Check your network "
                "connection and try again."
            ) from exc
        self._capture_token(response)
        self._raise_for_status(response)
        if response.status_code == 204 or not response.content:
            return None
        try:
            return response.json()
        except ValueError:
            return None

    # ---- auth --------------------------------------------------------------

    def login(self) -> None:
        """Log in with the configured email/password.

        Raises Picnic2FARequiredError if the account needs a 2FA code — in that case a
        partial session token has already been captured, and generate_2fa_code() /
        verify_2fa_code() can be called next.
        """
        if self.is_authenticated:
            return
        secret = hashlib.md5(self.password.encode("utf-8")).hexdigest()
        body = {"key": self.email, "secret": secret, "client_id": CLIENT_ID}
        url = self.base_url + "/user/login"
        try:
            response = self._session.post(url, json=body, timeout=REQUEST_TIMEOUT_SECONDS)
        except requests.RequestException as exc:
            raise PicnicNetworkError(
                f"Could not reach Picnic ({exc.__class__.__name__}). Check your network "
                "connection and try again."
            ) from exc
        self._capture_token(response)
        if response.status_code == 401:
            raise PicnicAuthError(
                "Picnic rejected the email/password. Check PICNIC_EMAIL / PICNIC_PASSWORD."
            )
        self._raise_for_status(response)
        data = None
        try:
            data = response.json()
        except ValueError:
            pass
        if isinstance(data, dict) and data.get("second_factor_authentication_required"):
            raise Picnic2FARequiredError(
                "This Picnic account requires a 2FA code. Call generate_2fa_code, then "
                "verify_2fa_code with the code you receive."
            )

    def generate_2fa_code(self, channel: str = "SMS") -> None:
        channel = channel.strip().upper()
        if channel not in ("SMS", "EMAIL"):
            raise PicnicError("channel must be 'SMS' or 'EMAIL'.")
        try:
            self.login()
        except Picnic2FARequiredError:
            pass  # expected: this is exactly the state we need to request a code
        if not self.is_authenticated:
            raise PicnicAuthError("Cannot request a 2FA code without a valid login attempt.")
        self._request("POST", "/user/2fa/generate", json_body={"channel": channel})

    def verify_2fa_code(self, code: str) -> None:
        try:
            self.login()
        except Picnic2FARequiredError:
            pass
        if not self.is_authenticated:
            raise PicnicAuthError("Cannot verify a 2FA code without a valid login attempt.")
        try:
            self._request("POST", "/user/2fa/verify", json_body={"otp": code})
        except PicnicRequestError as exc:
            raise Picnic2FAError(
                "Picnic rejected that 2FA code — it may be wrong or expired. "
                "Call generate_2fa_code to request a new one."
            ) from exc
        if not self.is_authenticated:
            raise Picnic2FAError(
                "Picnic did not confirm the 2FA code. Call generate_2fa_code to request a new one."
            )

    def ensure_login(self) -> None:
        """Used by every non-auth tool. Surfaces a clear error if 2FA is still pending."""
        if self.is_authenticated:
            return
        self.login()

    # ---- product search ------------------------------------------------------

    def search_products(self, query: str) -> list[dict]:
        self.ensure_login()
        path = f"/pages/search-page-results?search_term={quote(query)}"
        raw = self._request("GET", path)
        results = []
        seen_ids: set[str] = set()
        for product in _iter_selling_units(raw or {}):
            product_id = product.get("id")
            if not product_id or product_id in seen_ids:
                continue  # the page tree repeats the same product under several UI nodes
            seen_ids.add(product_id)
            price = product.get("display_price", product.get("price"))
            results.append(
                {
                    "id": product_id,
                    "name": product.get("name"),
                    "price": _money(price),
                    "currency": "EUR",
                    "unit": product.get("unit_quantity"),
                }
            )
        return results

    # ---- cart ------------------------------------------------------------

    def get_cart(self) -> dict:
        self.ensure_login()
        raw = self._request("GET", "/cart") or {}
        items = []
        for line in raw.get("items", []) or []:
            if line.get("type") != "ORDER_LINE":
                continue
            articles = line.get("items", []) or []
            if not articles:
                continue
            article = articles[0]
            quantity = len(articles)
            items.append(
                {
                    "product_id": article.get("id"),
                    "name": article.get("name"),
                    "unit": article.get("unit_quantity"),
                    "quantity": quantity,
                    "unit_price": _money(article.get("price")),
                    "line_total": _money(line.get("price")),
                    "currency": "EUR",
                }
            )
        return {
            "items": items,
            "total_count": raw.get("total_count"),
            "cart_total": _money(raw.get("total_price")),
            "currency": "EUR",
        }

    def add_to_cart(self, product_id: str, count: int = 1) -> dict:
        self.ensure_login()
        self._request(
            "POST", "/cart/add_product", json_body={"product_id": product_id, "count": count}
        )
        return self.get_cart()

    def remove_from_cart(self, product_id: str, count: int = 1) -> dict:
        self.ensure_login()
        self._request(
            "POST",
            "/cart/remove_product",
            json_body={"product_id": product_id, "count": count},
        )
        return self.get_cart()

    def clear_cart(self) -> dict:
        self.ensure_login()
        self._request("POST", "/cart/clear")
        return self.get_cart()

    # ---- delivery slots ----------------------------------------------------

    def get_delivery_slots(self) -> list[dict]:
        self.ensure_login()
        raw = self._request("GET", "/cart/delivery_slots") or {}
        selected_slot_id = (raw.get("selected_slot") or {}).get("slot_id")
        slots = []
        for slot in raw.get("delivery_slots", []) or []:
            slot_id = slot.get("slot_id")
            suggested = bool(slot.get("selected")) or (
                selected_slot_id is not None and slot_id == selected_slot_id
            )
            slots.append(
                {
                    "slot_id": slot_id,
                    "window_start": slot.get("window_start"),
                    "window_end": slot.get("window_end"),
                    "cut_off_time": slot.get("cut_off_time"),
                    "is_available": slot.get("is_available"),
                    "minimum_order_value": _money(slot.get("minimum_order_value")),
                    "suggested": suggested,
                }
            )
        return slots

    def set_delivery_slot(self, slot_id: str) -> None:
        self.ensure_login()
        self._request("POST", "/cart/set_delivery_slot", json_body={"slot_id": slot_id})
