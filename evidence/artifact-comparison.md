# Scripted vs. Claude Artifact Comparison

Both artifacts contain 5 steps and parameterize the runtime member ID. The Claude-discovered artifact independently found a valid happy-path flow and stable data-field extraction; the engineered artifact adds production policy learned outside that single successful run.

| Property | Engineered artifact | Claude-discovered artifact |
| --- | ---: | ---: |
| Locator candidates | 5 | 6 |
| Step checkpoints | 3 | 1 |
| Explicit risk labels | 5 | 0 |
| Retrying steps | 1 | 0 |
| Declared business outcomes | 1 | 0 |

| Replay case | Engineered artifact | Claude-discovered artifact |
| --- | --- | --- |
| primary_member | success: $4,281.36 | success: $4,281.36 |
| alternate_member | success: $912.04 | success: $912.04 |
| member_not_found | business_outcome: member_not_found | failure: click_view_account: Could not uniquely resolve View Account link for Savings |
| transient_host_error | success: $4,281.36 | failure: click_view_account: Could not uniquely resolve View Account link for Savings |

## Conclusion

Claude successfully discovers the reusable task mechanics, but one successful trace cannot reveal unseen runtime conditions. The production design should therefore compile the discovered flow together with reviewed application-profile policy: known business outcomes, bounded recoveries, risk labels, and stronger checkpoints. This preserves model-led discovery while keeping production replay deterministic and reviewable.
