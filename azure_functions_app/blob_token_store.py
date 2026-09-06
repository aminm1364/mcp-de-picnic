"""Picnic client construction for the Azure Functions deployment.

Azure Functions' self-hosted MCP support requires the server to be stateless (see
../ENDPOINTS.md and the README's Azure section) — there's no guarantee two requests hit
the same instance, or that local disk survives between them. So instead of the local
file used by the desktop/pip deployment, the session auth token is persisted to a
single blob in the Storage Account every Function App already has (AzureWebJobsStorage),
using the same {"auth_token": "..."} shape as the local file store.

Wired in via PICNIC_CLIENT_FACTORY=azure_functions_app.blob_token_store:build_client
(see mcp_de_picnic/server.py:_get_client). Only the account password ever leaves this
process's memory — and only to Picnic's own login endpoint, exactly as in the local
deployment; this module only adds *where the resulting token* is cached.
"""

from __future__ import annotations

import json
import os

from azure.core.exceptions import ResourceExistsError, ResourceNotFoundError
from azure.storage.blob import BlobServiceClient

from mcp_de_picnic.picnic_client import PicnicClient


class BlobBackedPicnicClient(PicnicClient):
    def __init__(
        self,
        *,
        email: str,
        password: str,
        country_code: str,
        connection_string: str,
        container: str,
        blob_name: str,
    ) -> None:
        self._blob_service = BlobServiceClient.from_connection_string(connection_string)
        self._container_name = container
        self._blob_name = blob_name
        # Read once up front — _load_cached_token() (called inside super().__init__())
        # uses this same dict instead of re-fetching.
        self._pending_cache = self._read_blob_json()
        # token_cache_path stays None: the base class's local-file logic is unused here,
        # since _load_cached_token/_save_cached_token are overridden below.
        super().__init__(email=email, password=password, country_code=country_code)
        # Picnic ties a session token to the x-picnic-did it was issued under — a token
        # reused with a different (freshly-generated) device id is rejected as if 2FA
        # were never completed. Confirmed live 2026-09-05: a fully-verified token
        # loaded from blob still got a 403 until the original device id was restored
        # too. So the device id has to be persisted and restored right alongside the
        # token, overriding the random one __post_init__ just generated.
        device_id = (self._pending_cache or {}).get("device_id")
        if device_id:
            self._device_id = device_id
            self._session.headers["x-picnic-did"] = device_id

    def _blob_client(self):
        return self._blob_service.get_blob_client(container=self._container_name, blob=self._blob_name)

    def _read_blob_json(self) -> dict | None:
        try:
            raw = self._blob_client().download_blob().readall()
        except ResourceNotFoundError:
            return None  # no session yet — a normal login (and possibly 2FA) will follow
        try:
            data = json.loads(raw)
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    def _load_cached_token(self) -> None:
        token = (self._pending_cache or {}).get("auth_token")
        if token:
            self._set_token(token)

    def _save_cached_token(self) -> None:
        if not self._auth_token:
            return
        payload = json.dumps({"auth_token": self._auth_token, "device_id": self._device_id}).encode("utf-8")
        try:
            self._blob_client().upload_blob(payload, overwrite=True)
        except ResourceNotFoundError:
            # Container doesn't exist yet — create it once, then retry the write.
            try:
                self._blob_service.get_container_client(self._container_name).create_container()
            except ResourceExistsError:
                pass
            try:
                self._blob_client().upload_blob(payload, overwrite=True)
            except Exception:
                pass  # best-effort; in-memory auth still works for this request


def build_client() -> PicnicClient:
    email = os.environ["PICNIC_EMAIL"]
    password = os.environ["PICNIC_PASSWORD"]
    country_code = os.environ.get("PICNIC_COUNTRY_CODE", "DE")
    # Every Function App already has this connection string as an app setting.
    connection_string = os.environ["AzureWebJobsStorage"]
    container = os.environ.get("PICNIC_SESSION_CONTAINER", "picnic-session")
    blob_name = os.environ.get("PICNIC_SESSION_BLOB", "token.json")
    return BlobBackedPicnicClient(
        email=email,
        password=password,
        country_code=country_code,
        connection_string=connection_string,
        container=container,
        blob_name=blob_name,
    )
