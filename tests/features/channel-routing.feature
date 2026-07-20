Feature: The channel carries a project's traffic only to that project's session

  ADR-013 says a message finds the right session and no other. That was
  implemented for chat messages and left undone for everything else, so a
  verdict on one project was announced to every connected agent on the machine.

  Observed: a session working on lc_decision_tree received the approvals for
  ADR-015 and ADR-018 and the rejection of ADR-017 — all librarian decisions.
  It correctly refused to act, but it should never have been told. On a machine
  hosting work for more than one client, decision titles and verdict reasons
  crossing projects is a leak, not just noise.

  Background:
    Given a channel session "alpha" bound to project "alpha_app"
    And a channel session "beta" bound to project "beta_app"

  Scenario: a verdict reaches only the owning project's session
    Given a decision "Adopt SQLite" submitted to project "alpha_app"
    When the human approves it
    Then the "alpha" session receives a "verdict" event
    And the "beta" session receives no "verdict" event

  Scenario: a rejection reaches only the owning project's session
    Given a decision "Split into microservices" submitted to project "alpha_app"
    When the human rejects it with reason "overkill for one user"
    Then the "alpha" session receives a "verdict" event
    And the "beta" session receives no "verdict" event

  Scenario: a comment reaches only the owning project's session
    Given a decision "Cache layer" submitted to project "alpha_app"
    When the human comments on it
    Then the "alpha" session receives a "comment" event
    And the "beta" session receives no "comment" event

  Scenario: a new decision is announced only to its own project's session
    When a decision "Rate limiting" is submitted to project "alpha_app"
    Then the "alpha" session receives a "decision.added" event
    And the "beta" session receives no "decision.added" event

  Scenario: each session still receives its own project's traffic
    Given a decision "Beta's own plan" submitted to project "beta_app"
    When the human approves it
    Then the "beta" session receives a "verdict" event
    And the "alpha" session receives no "verdict" event
