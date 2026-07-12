@M3
Feature: Red-light memory

  Scenario: Rejections are first-class in search
    Given the daemon is running with an empty store
    And a decision titled "Split backend into microservices" rejected with reason "overkill for single user"
    When an agent calls search_decisions "microservices"
    Then the hit includes status "rejected" and the reason verbatim

  Scenario: Constraints digest
    Given the daemon is running with an empty store
    And a decision titled "Pre-production security gate" approved for "accounting_app"
    And a decision titled "Split backend into microservices" rejected with reason "overkill for single user"
    When an agent calls get_constraints for "accounting_app"
    Then the digest lists accepted and rejected decisions with reasons
