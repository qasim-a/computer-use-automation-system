# Cross-tenant replay

Both runs load the unchanged `capabilities/read_savings_balance.json` artifact with member input `67890`. The base run uses its native route and locators; the second run compiles the Northstar application profile with `demo_credit_union.overlay.json` before replay.

| UI element | Base tenant | Second tenant |
| --- | --- | --- |
| Route family | `/members/...` | `/tenant-two/members/...` |
| Identifier and action | `Member Number` / `Search` | `Customer ID` / `Find Customer` |
| Detail navigation | `Member Summary` / `View Account` | `Customer Overview` / `Open Deposit` |
| Output surface | `Savings account` / `current-balance` | `Deposit details` / `available-balance` |

Both structured results return `success` and `$912.04`. Each result has a redacted event log and masked final screenshot in its adjacent `-run` directory.

Recreate the evidence without an API key:

```bash
npm run demo:replay -- --artifact capabilities/read_savings_balance.json --member-id 67890 --output evidence/cross-tenant/base-result.json
npm run demo:replay -- --artifact capabilities/read_savings_balance.json --profile profiles/northstar_core.profile.json --overlay profiles/demo_credit_union.overlay.json --member-id 67890 --output evidence/cross-tenant/tenant-result.json
```
