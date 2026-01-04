> **Languages**: [English README](../README.md) | [Chinese](../README.zh.md) | [Japanese](../README.jp.md) | [Russian](../README.ru.md)

# Azure Policy: Resource Location Constraints


If your deployment fails with `RequestDisallowedByAzure`, this means your subscription has a policy that restricts which Azure locations (regions) are allowed for resource creation. This is common in enterprise subscriptions.

## Steps to resolve

1. List available Azure locations for your account:
```bash
az account list-locations -o table
```

2. Check policy assignments that might restrict locations:
```bash
az policy assignment list --query "[].{Name:name,Scope:scope}" -o table
```

3. Check policy definitions for `allowedLocations` on your subscription context:
```bash
az policy assignment list --query "[?contains(properties.parameters.allowedLocations, 'eastasia')].{name:name, scope:scope}" -o table
```

4. Options:
- Use a location that is allowed (preferably one near your region) when running the deploy script with `--location`.
- Contact your subscription admin to add the desired region to the allowed list or create a policy exemption.
- Use an external container registry (Docker Hub, GitHub Packages) instead of ACR when ACR region is restricted.

## ACR Tasks disabled - TasksOperationsNotAllowed

If you see the error:
```
TasksOperationsNotAllowed: ACR Tasks requests for the registry <name> are not permitted
```
This indicates the ACR Tasks service (used by `az acr build`) is disabled for your subscription or ACR instance by policy or resource-provider restrictions.

Workarounds:
- Use the local docker build & push fallback (script: `scripts/build_and_push_local.sh`) if you have Docker Desktop installed:
	```bash
	./scripts/build_and_push_local.sh --acr-name arisbotacr --image aris-scraper:latest
	```
- Or push the image to Docker Hub or GitHub Packages using `scripts/push_to_dockerhub.sh`.
- Or configure a CI pipeline (GitHub Actions) to build and push the image for you (recommended for automation).

To check ACR Tasks availability, you can attempt a test build or consult support.

## Quick CLI example: Try another region
If `eastasia` fails, try `eastus`:
```bash
# Re-run deploy script with a new region
./scripts/deploy_aris_scraper.sh --location eastus --acr-name arisbotacr
```

Note: Picking another region may still fail if policies restrict that one too. Use `az account list-locations` to enumerate candidates.
