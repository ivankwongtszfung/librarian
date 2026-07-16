@conversation
Feature: The decision is the atom — anyone may comment, only the human may decide

  A decision is not a chat log. It is a durable object with a conversation
  attached, and that conversation is its rationale. Humans, agents, and
  role-scoped reviewers are all participants in it.

  The line that must never blur: commenting is open to every participant;
  transitioning the verdict is the human's alone.

  Scenario: An agent comments on a pending decision
    Given the daemon is running with an empty store
    And a pending decision
    When an agent comments "Redis adds an ops dependency we don't have today" as "architect"
    Then the comment is stored, authored by the agent "architect"
    And the decision status is still "pending"
    And no verdict_event is written

  Scenario: The thread carries both human and agent voices
    Given the daemon is running with an empty store
    And a pending decision
    When an agent comments "This contradicts a decision rejected in March" as "librarian"
    And a human comments "Agreed — say why in the doc"
    Then get_review returns 2 comments
    And the thread distinguishes the agent author from the human author

  Scenario: An agent cannot smuggle a verdict through a comment
    Given the daemon is running with an empty store
    And a pending decision
    When an agent tries to comment with request_changes set
    Then the decision status is still "pending"
    And no verdict_event is written

  Scenario: An agent anchors a comment to a passage of the doc
    Given the daemon is running with an empty store
    And a pending decision
    When an agent comments "We already have SQLite" anchored to "store sessions in Redis" as "librarian"
    Then the stored comment carries that anchor quote
