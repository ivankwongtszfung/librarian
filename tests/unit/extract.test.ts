import { describe, expect, it } from 'vitest';
import {
  classifyDoc,
  findDocWrite,
  findPlanOutcome,
  findPlanSubmission,
  isSessionTranscript,
  parseLine,
  projectNameFromFilePath,
  titleFromMarkdown,
} from '../../src/watcher/extract.js';

// These fixtures mirror the real shapes found in Claude Code transcripts.

const planToolUse = {
  type: 'assistant',
  uuid: '838eb8c9-aaaa-bbbb-cccc-000000000001',
  sessionId: '0186fab7-1111-2222-3333-444444444444',
  timestamp: '2026-06-21T03:04:04.612Z',
  isSidechain: false,
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_01CQXL79c7zdV7KaEhWm7ii7',
        name: 'ExitPlanMode',
        input: { plan: '# Plan: Group loose root files\n\n## Context\n\nDetails here.' },
      },
    ],
  },
};

const planApproved = {
  type: 'user',
  uuid: '2e39102e-aaaa-bbbb-cccc-000000000002',
  sessionId: '0186fab7-1111-2222-3333-444444444444',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_01CQXL79c7zdV7KaEhWm7ii7',
        content: 'User has approved your plan. You can now start coding.',
      },
    ],
  },
  toolUseResult: {
    plan: '# Plan: Group loose root files\n\n## Context\n\nDetails here.',
    isAgent: false,
  },
};

const planRejected = {
  type: 'user',
  uuid: '2e39102e-aaaa-bbbb-cccc-000000000003',
  sessionId: '0186fab7-1111-2222-3333-444444444444',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_01CQXL79c7zdV7KaEhWm7ii7',
        is_error: true,
        content: "The user doesn't want to proceed with this tool use. The tool use was rejected.",
      },
    ],
  },
  toolUseResult: 'User rejected tool use',
};

const docWrite = {
  type: 'assistant',
  uuid: '36a72104-aaaa-bbbb-cccc-000000000004',
  sessionId: 'cfa8b3b5-1111-2222-3333-444444444444',
  cwd: '/Users/ivankwong/Projects/all_state',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_019h44psRHRs2WS93nrxzZac',
        name: 'Write',
        input: {
          file_path: '/Users/ivankwong/Projects/librarian/docs/adr/ADR-001-store.md',
          content: '# ADR-001: SQLite as the store\n\nWe will use SQLite.',
        },
      },
    ],
  },
};

describe('transcript paths', () => {
  it('accepts a real session transcript', () => {
    expect(
      isSessionTranscript(
        '/Users/x/.claude/projects/-Users-x-Projects-app/cfa8b3b5-aaf4-44f0-bed2-7061ca9cca08.jsonl',
      ),
    ).toBe(true);
  });

  it('skips subagent and workflow transcripts, which would double-count decisions', () => {
    expect(
      isSessionTranscript(
        '/Users/x/.claude/projects/-Users-x-Projects-app/cfa8b3b5-aaf4-44f0-bed2-7061ca9cca08/subagents/agent-abc.jsonl',
      ),
    ).toBe(false);
    expect(
      isSessionTranscript(
        '/Users/x/.claude/projects/-Users-x-app/cfa8b3b5-aaf4-44f0-bed2-7061ca9cca08/workflows/wf_1/x.jsonl',
      ),
    ).toBe(false);
  });
});

describe('plan extraction', () => {
  it('pulls the plan markdown out of an ExitPlanMode call', () => {
    const found = findPlanSubmission(planToolUse);
    expect(found?.toolUseId).toBe('toolu_01CQXL79c7zdV7KaEhWm7ii7');
    expect(found?.plan).toContain('# Plan: Group loose root files');
  });

  it('reads approval from the toolUseResult object', () => {
    const outcome = findPlanOutcome(planApproved);
    expect(outcome?.outcome).toBe('approved');
    expect(outcome?.plan).toContain('Group loose root files');
  });

  it('reads rejection from the toolUseResult string', () => {
    expect(findPlanOutcome(planRejected)?.outcome).toBe('rejected');
  });

  it('ignores a malformed line rather than throwing', () => {
    expect(parseLine('{not json')).toBeNull();
    expect(findPlanSubmission({ type: 'assistant' })).toBeNull();
    expect(
      findPlanOutcome({ type: 'user', message: { content: 'a string, not blocks' } }),
    ).toBeNull();
  });
});

describe('doc write extraction', () => {
  it('captures a markdown doc written into docs/', () => {
    const found = findDocWrite(docWrite);
    expect(found?.filePath).toContain('/docs/adr/ADR-001-store.md');
    expect(found?.content).toContain('# ADR-001');
  });

  it('derives the project from the file path, not cwd — writes cross repos', () => {
    // cwd is all_state, but the doc was written into librarian.
    expect(projectNameFromFilePath('/Users/ivankwong/Projects/librarian/docs/adr/ADR-001.md')).toBe(
      'librarian',
    );
  });

  it('ignores scratchpad and non-doc markdown', () => {
    const scratch = structuredClone(docWrite);
    (scratch.message.content[0].input as { file_path: string }).file_path =
      '/private/tmp/claude-501/scratchpad/docs/notes.md';
    expect(findDocWrite(scratch)).toBeNull();

    const readme = structuredClone(docWrite);
    (readme.message.content[0].input as { file_path: string }).file_path =
      '/Users/x/proj/README.md';
    expect(findDocWrite(readme)).toBeNull();
  });

  it('classifies by path', () => {
    expect(classifyDoc('/p/docs/adr/ADR-001-x.md')).toBe('adr');
    expect(classifyDoc('/p/docs/prd.md')).toBe('prd');
    expect(classifyDoc('/p/docs/plans/rollout.md')).toBe('plan');
    expect(classifyDoc('/p/docs/architecture.md')).toBe('arch');
  });

  it('titles a doc from its first heading', () => {
    expect(titleFromMarkdown('# ADR-001: SQLite as the store\n\nbody', 'fallback')).toBe(
      'ADR-001: SQLite as the store',
    );
    expect(titleFromMarkdown('no heading here', 'fallback')).toBe('fallback');
  });
});
