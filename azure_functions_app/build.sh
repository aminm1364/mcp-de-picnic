#!/bin/sh
# Assembles the deployable Azure Functions package: copies the shared mcp_de_picnic
# package source in (kept out of git — see .gitignore) and zips everything the
# Functions host + custom handler needs, nothing else (no venv, no repo metadata).
set -eu
cd "$(dirname "$0")"

rm -rf mcp_de_picnic app.zip
cp -R ../src/mcp_de_picnic ./mcp_de_picnic
find ./mcp_de_picnic -name "__pycache__" -type d -exec rm -rf {} +

zip -rq app.zip host.json main.py blob_token_store.py requirements.txt mcp_de_picnic

echo "Built azure_functions_app/app.zip"
