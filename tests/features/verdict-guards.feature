@M4
Feature: Verdict API guards

  Scenario: Reject without reason is refused
    Given the daemon is running with an empty store
    And a pending decision
    When a client posts verdict "rejected" with no reason
    Then the API responds 422
    And no verdict_event is written

  Scenario: Comments are returned to the agent and drive a revision
    Given the daemon is running with an empty store
    And a pending decision
    When a client posts comments with an anchored quote and requests changes
    Then the agent's get_review resolves with the comments and their anchors
    And the decision status is "changes_requested"
