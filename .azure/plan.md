## Azure Rebuild Plan

Status: Approved
Approved By: User selected route 1 on 2026-03-29

### 1. Context

- Subscription: `Azure for Students` (`0df7b925-261b-4cf4-bbd5-0cc2bd176bbf`)
- Primary resource group: `qq-bot-rg`
- Existing Flex Consumption plan: `ASP-qqbotrg-ba97`
- Existing storage candidates: `qqbotrg800d`, `qqbotrg86a1`, `qqbotrgb329`, `qqbotrgbaab`
- Existing telemetry candidate: `school-bot-v2`

### 2. Findings

- The previous Azure Function hostname no longer resolves.
- There is no active `Microsoft.Web/sites` Function App for `school-bot` in the current subscription.
- The Azure VM currently does not have Docker or NapCat installed, so backend rebuild must happen first.
- The existing Flex Consumption plan is unused (`numberOfSites = 0`) and can host a new Function App.

### 3. Architecture Decision

- Rebuild the backend as a new Azure Function App on the existing Flex Consumption plan.
- Reuse an existing storage account in `koreacentral`.
- Reuse the existing Application Insights component `school-bot-v2`.
- Deploy code with Azure Functions Core Tools using an Azure management access token.
- Configure runtime secrets from local secure material after infrastructure creation.

### 4. Execution Steps

1. Create a new Function App on `ASP-qqbotrg-ba97`.
2. Publish the current Azure Functions backend with remote build.
3. Apply required app settings from local secrets and runtime config.
4. Verify `/api/schoolBot` from Azure-side reachability.
5. Only after backend verification, move on to NapCat installation and VM wiring.

### 5. Validation Targets

- Function App resource exists and reports `Running`.
- Code publish completes without dependency errors.
- `/api/schoolBot` returns a non-DNS failure from inside Azure.
- Required settings are present for storage, telemetry, and runtime dependencies.

### 6. Rollback

- Delete the newly created Function App only.
- Leave the existing Flex plan, storage accounts, and Application Insights resources intact.
