@M5
Feature: Watcher auto-capture

  Scenario: Approved plan is captured without agent cooperation
    Given the daemon is running with an empty store
    And the watcher is watching a fixture transcript directory
    When a fixture transcript receives an approved ExitPlanMode entry
    Then within 2s a decision exists with kind "plan" and source "watcher"
    And its session external_ref points at the transcript

  Scenario: Rejected plans are not captured as approved decisions
    Given the daemon is running with an empty store
    And the watcher is watching a fixture transcript directory
    When a fixture transcript receives a rejected ExitPlanMode entry
    Then no decision is captured from it

  Scenario: Dedupe across ingestion paths
    Given the daemon is running with an empty store
    And the watcher is watching a fixture transcript directory
    And a decision submitted via MCP with a known body
    When the watcher captures a doc with the same content
    Then exactly one decision exists
    And both provenances are recorded
