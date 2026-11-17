# Agent result v3 — acceptance items from the ticket

Version 3 is version 2 with one change: the ticket is the only source of what must be true at the
end. A v3 result declares `contract_version: 3`; v1 and v2 results stay accepted during the rollout.

- The planner no longer writes `scenarios` and `definition_of_done`. It writes
  `item_verifications`: for each acceptance item of the ticket (`AC-N`, at the `revision` it read),
  how it is proven (`verification.kind` `test`, `command`, `browser` or `manual`, plus `how`).
- The planner may add `proposed_items` (`NEW-N`): items the ticket lacks, as plain `text` or as a
  `scenario` (`given`, `when`, `then` optional — what happens today on a bug —, `expected`), each with
  its verification. They enter the ticket with a real `AC-N` code only when a person approves the
  plan. A plan that proposes items is never approved automatically.
- A submitted plan proves at least one item: an existing one or a proposed one. Coverage of every
  item is not a schema rule: the server shows uncovered items to whoever approves, and approves
  automatically only a plan that covers them all.
- `work_report.acceptance_evidence[].criterion_id` and the Tester's `results[].criterion_id` name
  ticket items (`AC-N`).

Everything else (`plan`, `decision_card`, `decision_brief`, `work_report`, `failure`, review and
Tester envelopes) is as in [v2](../v2/README.md).
