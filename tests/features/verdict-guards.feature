@M4
Feature: Verdict API guards

  Scenario: Reject without reason is refused
    Given the daemon is running with an empty store
    And a pending decision
    When a client posts verdict "rejected" with no reason
    Then the API responds 422
    And no verdict_event is written

  # A duplicate capture is how ADR-014 came to exist twice — once via MCP, once
  # via the watcher, differing by two square brackets around a link, so
  # content-hash dedup never fired. One copy sat 'approved' with no verdict
  # behind it and get_constraints served that one to every agent.
  #
  # The state machine has always allowed approved -> superseded. Nothing
  # exposed it, so the library could model a reconciliation it had no way to
  # perform.
  Scenario: a record can be superseded so the library tells one story
    Given the daemon is running with an empty store
    And a pending decision
    When a client posts verdict "superseded" with reason "duplicate of dec_other, which holds the thread"
    Then the API responds 200
    And the decision status is "superseded"

  Scenario: superseding without saying what superseded it is refused
    Given the daemon is running with an empty store
    And a pending decision
    When a client posts verdict "superseded" with no reason
    Then the API responds 422
    And no verdict_event is written

  Scenario: a superseded record stops counting as an accepted constraint
    Given the daemon is running with an empty store
    And a pending decision
    When a human posts verdict "approved" with reason "shipping it"
    And a client posts verdict "superseded" with reason "duplicate of dec_other"
    Then the decision status is "superseded"
    And the constraints digest does not list it as accepted

  Scenario: Comments are returned to the agent and drive a revision
    Given the daemon is running with an empty store
    And a pending decision
    When a client posts comments with an anchored quote and requests changes
    Then the agent's get_review resolves with the comments and their anchors
    And the decision status is "changes_requested"
