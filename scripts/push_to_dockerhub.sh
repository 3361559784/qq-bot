#!/usr/bin/env bash
set -e

# Push to Docker Hub as fallback (or for public registry use)
# Usage: ./scripts/push_to_dockerhub.sh --hub-username myuser --image aris-scraper:latest

HUB_USER=""
IMAGE_NAME="aris-scraper:latest"
REPO_USER=""

while [[ $# -gt 0 ]]; do
  key="$1"
  case $key in
    -u|--hub-username)
      HUB_USER="$2"; shift; shift;;
    -r|--repo-user)
      REPO_USER="$2"; shift; shift;;
    -i|--image)
      IMAGE_NAME="$2"; shift; shift;;
    -h|--help)
      echo "Usage: $0 --hub-username USER --repo-user REPO_USER --image IMAGE"; exit 0;;
    *)
      echo "Unknown option: $1"; exit 1;;
  esac
done

if [ -z "$HUB_USER" ] || [ -z "$REPO_USER" ]; then
  echo "Error: --hub-username and --repo-user are required (Docker Hub user/namespace)."; exit 1
fi

if ! command -v docker &> /dev/null; then
  echo "Error: Docker is required."; exit 1
fi

# Login to Docker Hub
docker login -u "$HUB_USER"

# Tag and push
LOCAL_IMAGE="$IMAGE_NAME"
REMOTE_IMAGE="${REPO_USER}/${IMAGE_NAME}"

docker tag "$LOCAL_IMAGE" "$REMOTE_IMAGE"
docker push "$REMOTE_IMAGE"

echo "✅ Pushed to Docker Hub: $REMOTE_IMAGE"

exit 0
