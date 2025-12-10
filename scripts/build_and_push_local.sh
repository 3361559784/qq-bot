#!/usr/bin/env bash
set -e

# Build locally and push to ACR (fallback when ACR Tasks disabled)
# Usage: ./scripts/build_and_push_local.sh --acr-name arisbotacr --image aris-scraper:latest

ACR_NAME="arisbotacr"
IMAGE_NAME="aris-scraper:latest"

# Parse args
while [[ $# -gt 0 ]]; do
  key="$1"
  case $key in
    -a|--acr-name)
      ACR_NAME="$2"; shift; shift;;
    -i|--image)
      IMAGE_NAME="$2"; shift; shift;;
    -h|--help)
      echo "Usage: $0 --acr-name ACR --image IMAGE_NAME"; exit 0;;
    *)
      echo "Unknown option: $1"; exit 1;;
  esac
done

echo "⏱ Build local image and push to ACR: $ACR_NAME/$IMAGE_NAME"

if ! command -v docker &> /dev/null; then
  echo "Error: docker not installed. Install Docker Desktop before running this script."; exit 1
fi

# Ensure we can fetch credentials
ACR_PASSWORD=$(az acr credential show --name "$ACR_NAME" --resource-group "aris-bot-rg" --query "passwords[0].value" -o tsv 2>/dev/null || true)
if [ -z "$ACR_PASSWORD" ]; then
  echo "Error: could not get ACR credentials via az. Ensure you have access and the registry exists."; exit 1
fi

# Login to ACR with docker
echo "Logging into ACR: $ACR_NAME.azurecr.io"
# username is the acr name
docker login $ACR_NAME.azurecr.io -u $ACR_NAME -p "$ACR_PASSWORD"

# Build image
IMAGE_FULL="$ACR_NAME.azurecr.io/$IMAGE_NAME"
docker build --platform linux/amd64 -t "$IMAGE_FULL" .

# Push
docker push "$IMAGE_FULL"

# Confirm
echo "✅ Pushed: $IMAGE_FULL"

exit 0
