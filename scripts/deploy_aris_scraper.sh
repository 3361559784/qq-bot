#!/usr/bin/env bash
set -e

# Improved deploy script: try alternative regions and handle Azure policy "RequestDisallowedByAzure" errors
# Usage: ./scripts/deploy_aris_scraper.sh --acr-name arisbotacr --resource-group aris-bot-rg --location eastasia

ACR_NAME="arisbotacr"
RESOURCE_GROUP="aris-bot-rg"
LOCATION="eastasia"
ENVIRONMENT_NAME="aris-env"
APP_NAME="aris-scraper"
IMAGE_NAME="aris-scraper:latest"

# Parse args
while [[ $# -gt 0 ]]; do
  key="$1"
  case $key in
    -a|--acr-name)
      ACR_NAME="$2"; shift; shift;;
    -g|--resource-group)
      RESOURCE_GROUP="$2"; shift; shift;;
    -l|--location)
      LOCATION="$2"; shift; shift;;
    -h|--help)
      echo "Usage: $0 [--acr-name NAME] [--resource-group RG] [--location LOCATION]"; exit 0;;
    *)
      echo "Unknown option $1"; exit 1;;
  esac
done

echo "Deploy parameters: ACR_NAME=$ACR_NAME RESOURCE_GROUP=$RESOURCE_GROUP LOCATION=$LOCATION"

if ! command -v az &> /dev/null; then
  echo "Error: Azure CLI not found. Install azure-cli and login with az login"; exit 1
fi

if ! az account show &> /dev/null; then
  echo "Not logged in to Azure. Please run az login"; exit 1
fi

# Helper: try setting location if not allowed by policy
try_region_create_acr() {
  local region="$1"
  echo "Attempting to create ACR $ACR_NAME in region $region..."
  set +e
  az acr create --resource-group "$RESOURCE_GROUP" --name "$ACR_NAME" --sku Basic --location "$region" --admin-enabled true
  RET=$?
  set -e
  return $RET
}

# Ensure resource group exists
if ! az group show --name "$RESOURCE_GROUP" &> /dev/null; then
  echo "Creating resource group $RESOURCE_GROUP in $LOCATION..."
  az group create --name "$RESOURCE_GROUP" --location "$LOCATION"
fi

# Try creating ACR with the requested location
if try_region_create_acr "$LOCATION"; then
  echo "ACR $ACR_NAME created in $LOCATION"
else
  echo "Failed to create ACR in $LOCATION. Checking for policy errors..."
  # Try a list of fallback regions
  CANDIDATES=("eastasia" "southeastasia" "eastus" "westeurope" "southeastasia" "southcentralus")
  for REG in "${CANDIDATES[@]}"; do
    if [ "$REG" == "$LOCATION" ]; then continue; fi
    echo "Trying fallback region: $REG"
    if try_region_create_acr "$REG"; then
      echo "ACR created in $REG. Updating LOCATION to $REG"
      LOCATION="$REG"
      break
    fi
  done
  # If still not created, show helpful message and abort
  if ! az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" &> /dev/null; then
    echo "=================================================================="
    echo "ERROR: Azure policy blocked creating ACR in the requested region (RequestDisallowedByAzure)."
    echo "This usually means your subscription restricts allowed regions via Azure Policy."
    echo "Options to resolve:"
    echo "  1) Choose a different region (allowed by your subscription). Use --location <region> with this script."
    echo "  2) Ask your subscription admin to add the region or allow exceptions for this resource type."
    echo "  3) Use an alternative container registry (Docker Hub, GitHub Packages) and update the deploy script to push there."
    echo "To list all Azure locations available for your account, run:
      az account list-locations -o table"
    echo "To see policy assignments that might restrict locations, run:
      az policy assignment list -o table"
    echo "If you need me to try a region for you, run the script again with --location <region>."
    echo "=================================================================="
    exit 1
  fi
fi


# Build and push image to ACR
echo "Attempting to build with ACR Tasks (az acr build)..."
set +e
az acr build --registry "$ACR_NAME" --image "$IMAGE_NAME" --file Dockerfile .
RET=$?
set -e
if [ $RET -ne 0 ]; then
  echo "Warning: 'az acr build' failed with exit code $RET. Falling back to local docker build and push."
  echo "If you prefer to use a remote CI (GitHub Actions), configure that instead."
  ./scripts/build_and_push_local.sh --acr-name "$ACR_NAME" --image "$IMAGE_NAME"
else
  echo "✅ ACR Tasks build succeeded"
fi

# Create Container Apps environment if needed
if ! az containerapp env show --name "$ENVIRONMENT_NAME" --resource-group "$RESOURCE_GROUP" &> /dev/null; then
  echo "Creating Container Apps environment: $ENVIRONMENT_NAME"
  az containerapp env create --name "$ENVIRONMENT_NAME" --resource-group "$RESOURCE_GROUP" --location "$LOCATION"
fi

# Deploy Container App
if az containerapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" &> /dev/null; then
  echo "Updating Container App $APP_NAME to new image..."
  az containerapp update --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --image "$ACR_NAME.azurecr.io/$IMAGE_NAME"
else
  echo "Creating new Container App $APP_NAME..."
  ACR_PASSWORD=$(az acr credential show --name "$ACR_NAME" --query "passwords[0].value" --output tsv)
  az containerapp create \
    --name "$APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --environment "$ENVIRONMENT_NAME" \
    --image "$ACR_NAME.azurecr.io/$IMAGE_NAME" \
    --registry-server "$ACR_NAME.azurecr.io" \
    --registry-username "$ACR_NAME" \
    --registry-password "$ACR_PASSWORD" \
    --target-port 3000 \
    --ingress external \
    --min-replicas 0 \
    --max-replicas 3 \
    --cpu 1.0 \
    --memory 2.0Gi \
    --env-vars NODE_ENV=production
fi

FQDN=$(az containerapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --query properties.configuration.ingress.fqdn --output tsv)

echo "Deployment finished. Service URL: https://$FQDN"

exit 0
