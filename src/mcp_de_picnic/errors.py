"""Typed exceptions for the Picnic client.

Every exception message here is written to be safe to show to an end user or pass back
as an MCP tool error: none of them ever include the account password, and none of them
include raw stack traces. See picnic_client.py for where these are raised.
"""

from __future__ import annotations


class PicnicError(Exception):
    """Base class for all Picnic-related errors."""


class PicnicConfigError(PicnicError):
    """Missing or invalid configuration (env vars), not a Picnic API problem."""


class PicnicAuthError(PicnicError):
    """Picnic rejected the credentials or the session token is no longer valid."""


class Picnic2FARequiredError(PicnicError):
    """The account needs a 2FA code before login can complete."""


class Picnic2FAError(PicnicError):
    """The 2FA code was rejected, expired, or no 2FA challenge is in progress."""


class PicnicRateLimitError(PicnicError):
    """Picnic responded with 429; caller should back off."""


class PicnicRequestError(PicnicError):
    """Any other non-2xx response from the Picnic API."""


class PicnicNetworkError(PicnicError):
    """Could not reach Picnic's servers at all (DNS/timeout/connection error)."""
