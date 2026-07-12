@M2
Feature: Submit for review

  Scenario: Agent submits a plan
    Given the daemon is running with an empty store
    When an agent calls submit_for_review with a plan for "accounting_app"
    Then a decision exists with status "pending" and source "mcp"
    And an SSE event "decision.added" is emitted
    And a notification is published to the ntfy topic

  @M4
  Scenario: Revision links lineage
    Given the daemon is running with an empty store
    And a decision in state "changes_requested" with version 1
    When the agent resubmits with parent_review_id
    Then version 2 exists with parent_version_id of version 1
    And the diff between version 1 and 2 is a non-empty unified diff

  Scenario: record_decision stores an FYI entry without gating
    Given the daemon is running with an empty store
    When an agent calls record_decision for "accounting_app"
    Then a decision exists with status "approved" and source "mcp"
    And no notification is published to the ntfy topic
