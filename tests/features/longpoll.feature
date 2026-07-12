@M4
Feature: Long-poll verdict delivery

  Scenario: Poll returns pending on hold expiry
    Given the daemon is running with an empty store
    And a pending decision
    When the agent calls get_review with wait_seconds 2
    Then the call returns after about 2s with status "pending"

  Scenario: Verdict arrives during hold
    Given the daemon is running with an empty store
    And a pending decision
    And an in-flight get_review
    When a human posts verdict "rejected" with reason "conflicts with ADR-004"
    Then the in-flight call resolves with the verdict and the reason
    And the decision's verdict_events contain pending to rejected

  Scenario: Connection drops during hold — verdict is never lost
    Given the daemon is running with an empty store
    And a pending decision
    And an in-flight get_review
    When the connection drops before the hold expires
    And a human posts verdict "approved" while no poll is connected
    Then the verdict_event is persisted normally
    When the agent reconnects and calls get_review again
    Then the call returns immediately with the stored verdict
    And repeated get_review calls return the same result

  Scenario: Daemon restarts while a review is pending
    Given the daemon is running with an empty store
    And a pending decision
    When the daemon restarts
    And the agent calls get_review for the same review_id
    Then the call succeeds against the recovered store
    And the decision is still listed as "pending" in the library
