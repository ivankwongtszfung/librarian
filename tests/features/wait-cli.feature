@ADR-002
Feature: The wait CLI — a background waiter whose exit is the notification

  `librarian wait <review_id>` holds open the review long-poll from a separate
  process so an agent can launch it in the background, end its turn, and be
  re-invoked by its harness when the process exits with the verdict. Exit codes
  are the contract: 0 = resolved (verdict JSON on stdout), 1 = error,
  2 = timeout with the review still pending.

  Scenario: Exits with the verdict when it lands during the wait
    Given the daemon is running with an empty store
    And a pending decision
    And librarian wait is started for the review with a 20s timeout
    When a human posts verdict "approved" while the waiter is holding
    Then the wait process exits 0 within 10s
    And the waiter's stdout is one JSON line with status "approved"

  Scenario: Exits 2 when the timeout expires with the review still pending
    Given the daemon is running with an empty store
    And a pending decision
    And librarian wait is started for the review with a 2s timeout
    Then the wait process exits 2 within 10s
    And the waiter's stdout is one JSON line with status "pending"

  Scenario: Exits 1 for a review id that does not exist
    Given the daemon is running with an empty store
    And librarian wait is started for review id "does-not-exist" with a 5s timeout
    Then the wait process exits 1 within 10s

  Scenario: Survives a daemon restart during the wait — the verdict is never lost
    Given the daemon is running with an empty store
    And a pending decision
    And librarian wait is started for the review with a 25s timeout
    When the daemon restarts
    And a human posts verdict "rejected" with reason "conflicts with ADR-004"
    Then the wait process exits 0 within 10s
    And the waiter's stdout is one JSON line with status "rejected"
    And the waiter's stdout carries the reason "conflicts with ADR-004"
