"""Entrypoint for the Azure Functions self-hosted MCP deployment.

Reuses every tool defined in mcp_de_picnic.server (same search/cart/2FA tools as the
local desktop deployment) unchanged — only the transport and the Picnic-client
construction differ here. See host.json for how the Functions host launches this
script, and blob_token_store.py for why/how session state is externalized.
"""

from __future__ import annotations

import logging
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mcp_de_picnic.server import mcp

logging.basicConfig(level=logging.INFO)

PORT = int(os.environ.get("FUNCTIONS_CUSTOMHANDLER_PORT", "8000"))

# No app-level Host/Origin allowlist here: Azure's internal proxy to the custom
# handler doesn't reliably preserve the original public Host header, and access
# control is handled by Azure's built-in (Easy Auth/Entra ID) authentication in
# front of the whole app instead — see README's Azure section for how that's wired
# up. This matches Microsoft's own self-hosted-MCP-on-Functions sample, which relies
# on the same built-in auth rather than an app-level host allowlist.
if __name__ == "__main__":
    # stateless_http=True (Azure's documented preference for this preview feature)
    # omits the Mcp-Session-Id header entirely, which some MCP clients apparently
    # can't cope with even though the spec allows it — confirmed 2026-09-05: Claude's
    # connector authenticated fine but reported "no tools available" against the
    # stateless server. Running stateful instead trades away Azure's official
    # multi-instance-safety guidance for this preview feature, which is an acceptable
    # tradeoff at this app's very low request volume (effectively one instance).
    mcp.run(
        transport="streamable-http",
        host="0.0.0.0",
        port=PORT,
        stateless_http=False,
    )
