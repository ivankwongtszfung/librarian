import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MAX_WAIT_SECONDS, type ReviewService } from '../../application/review-service.js';
import type { DecisionStore } from '../../domain/ports.js';
import type { DecisionKind, DecisionStatus } from '../../domain/types.js';

const KIND = z.enum(['plan', 'adr', 'prd', 'arch', 'bug']);
const STATUS = z.enum(['pending', 'changes_requested', 'approved', 'rejected', 'superseded']);

function text(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * The agent-facing surface. Tool descriptions are load-bearing: they are the
 * only place an agent learns *when* to call each tool, and the whole
 * feed-forward loop depends on agents consulting constraints before designing.
 */
export function createMcpServer(repo: DecisionStore, reviews: ReviewService): McpServer {
  const server = new McpServer(
    { name: 'librarian', version: '0.1.0' },
    {
      instructions: [
        'Librarian is the decision library for this machine.',
        '',
        'Before proposing any design, plan, or architecture: call get_constraints for the',
        'project to learn what has already been decided AND what has already been rejected.',
        'Use search_decisions when you have a specific question about past decisions.',
        '',
        'Before finalizing a design or plan: call submit_for_review and then poll get_review',
        '(with wait_seconds, backing off between calls) until it resolves. Approved means',
        'proceed. Rejected means stop. changes_requested means read the comments, revise, and',
        'resubmit with parent_review_id.',
      ].join('\n'),
    },
  );

  server.registerTool(
    'submit_for_review',
    {
      title: 'Submit a design for human review',
      description:
        'Submit a plan, ADR, PRD, or architecture doc for the human to read and green-light. ' +
        'Returns a review_id immediately; the decision is NOT approved yet. Poll get_review with ' +
        'that id to learn the verdict. To revise after changes were requested, submit again with ' +
        'parent_review_id set to the original review_id — this links versions so the human sees a diff.',
      inputSchema: {
        project: z.string().describe('Project name, e.g. "accounting_app"'),
        title: z.string().describe('One-line title of the decision'),
        doc: z.string().describe('The full document, in markdown'),
        kind: KIND.optional().describe('Document kind (default: plan)'),
        parent_review_id: z.string().optional().describe('Set when resubmitting a revised version'),
        context_refs: z
          .array(z.string())
          .optional()
          .describe(
            'Files/symbols this design touches, e.g. ["src/auth.ts", "AuthService.refresh"]',
          ),
        agent: z.string().optional().describe('Your agent name, e.g. "claude-code"'),
        session_ref: z.string().optional().describe('Opaque session identifier for provenance'),
      },
    },
    async (args) => {
      const result = await reviews.submitForReview({
        project: args.project,
        title: args.title,
        doc: args.doc,
        kind: args.kind as DecisionKind | undefined,
        parentReviewId: args.parent_review_id,
        contextRefs: args.context_refs,
        agent: args.agent,
        sessionRef: args.session_ref,
      });
      return text({
        review_id: result.reviewId,
        version: result.version,
        status: 'pending',
        next: `Poll get_review with review_id="${result.reviewId}" and wait_seconds=${MAX_WAIT_SECONDS} until it resolves.`,
      });
    },
  );

  server.registerTool(
    'get_review',
    {
      title: 'Wait for the human verdict',
      description:
        'Long-poll for the verdict on a submitted review. The call blocks server-side for up to ' +
        'wait_seconds (max 50) and returns as soon as the human decides. If it returns status ' +
        '"pending", simply call it again — this is safe and cheap; do not spin in a tight loop, and ' +
        'do not assume approval. Returns "approved" (proceed), "rejected" (stop; reason given), or ' +
        '"changes_requested" (read comments, revise, resubmit with parent_review_id). ' +
        'If the review may take a while, run `librarian wait <review_id>` as a background process ' +
        'instead of polling — it exits with the verdict JSON, and the exit wakes your harness.',
      inputSchema: {
        review_id: z.string(),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(MAX_WAIT_SECONDS)
          .optional()
          .describe('How long the server should hold the request (default 30)'),
      },
    },
    async (args) => {
      const outcome = await reviews.getReview(args.review_id, args.wait_seconds ?? 30);
      if ('error' in outcome) return text({ error: 'not_found', review_id: args.review_id });
      return text({
        status: outcome.status,
        reason: outcome.reason,
        comments: outcome.comments,
        version: outcome.version,
        ...(outcome.status === 'pending'
          ? {
              next: 'Still awaiting the human. Call get_review again with wait_seconds to keep waiting.',
            }
          : {}),
        ...(outcome.status === 'changes_requested'
          ? {
              next: 'Address every comment, then call submit_for_review with parent_review_id set to this review_id.',
            }
          : {}),
      });
    },
  );

  server.registerTool(
    'comment_on_decision',
    {
      title: 'Join the conversation on a decision',
      description:
        'Add a comment to a decision — a critique, a question, a cited precedent, a risk. ' +
        'The decision (not the chat) is the unit of work here, and its thread is its rationale: ' +
        'everything said about it is stored on it, forever, and read by the human before they decide ' +
        'and by every agent that queries it afterwards. ' +
        'Anchor the comment to a passage with anchor_quote when you are responding to a specific claim. ' +
        'This does NOT decide anything: only the human can approve, reject, or request changes. ' +
        'Reviewing on behalf of a role (security, architecture, cost, consistency with past decisions)? ' +
        'Pass that role as `as` so the human can see which lens is speaking.',
      inputSchema: {
        review_id: z.string().describe('The decision to comment on'),
        body: z
          .string()
          .describe('The comment itself. Be specific; cite the doc or prior decisions.'),
        anchor_quote: z
          .string()
          .optional()
          .describe('A verbatim passage from the doc that this comment is about'),
        as: z
          .string()
          .optional()
          .describe('The reviewer role you are speaking as, e.g. "security", "librarian"'),
      },
    },
    async (args) => {
      try {
        const result = reviews.postComments({
          decisionId: args.review_id,
          comments: [{ body: args.body, anchorQuote: args.anchor_quote ?? null }],
          by: args.as ?? 'agent',
          // A role-scoped critic is a 'reviewer'; an agent speaking for itself is an 'agent'.
          authorType: args.as ? 'reviewer' : 'agent',
        });
        return text({
          ok: true,
          added: result.added,
          note: 'Comment stored on the decision. The human decides; you do not.',
        });
      } catch {
        return text({ error: 'not_found', review_id: args.review_id });
      }
    },
  );

  server.registerTool(
    'reply_to_message',
    {
      title: 'Answer a message the human typed into the review UI',
      description:
        'Answer a chat-bar message so the human reads it on the page instead of in your terminal. ' +
        'CALL THIS whenever you have acted on, or answered, a message that arrived from the review UI — ' +
        'otherwise the page shows it as unanswered and the human has to go hunting for what you did. ' +
        'Post the CONCLUSION, not your reasoning: what changed, and the evidence in `refs` ' +
        '(commit SHAs, PR numbers, file paths). ' +
        'If the answer is a document, use submit_for_review; if it belongs to a decision, use ' +
        'comment_on_decision. This tool is for "you asked, here is what happened".',
      inputSchema: {
        message_id: z.string().describe('The id of the message being answered'),
        body: z
          .string()
          .describe('The answer itself — a conclusion, not a transcript of your thinking'),
        refs: z
          .array(z.string())
          .optional()
          .describe('Evidence: commit SHAs, PR numbers, file paths — so "fixed it" is checkable'),
        agent: z.string().optional().describe('Your agent name, e.g. "claude-code"'),
      },
    },
    async (args) => {
      try {
        const reply = repo.replyToMessage(args.message_id, args.body, {
          refs: args.refs,
          agent: args.agent,
        });
        return text({
          ok: true,
          reply_id: reply.id,
          note: 'Stored. The human sees it under their message in the review UI.',
        });
      } catch {
        return text({ error: 'no_such_message', message_id: args.message_id });
      }
    },
  );

  server.registerTool(
    'record_decision',
    {
      title: 'Record a decision (no gate)',
      description:
        'File a decision into the library WITHOUT asking for approval — for decisions already made, ' +
        'or ADRs written up after the fact. Does not notify and does not block. If you need a human ' +
        'to approve something before you act on it, use submit_for_review instead.',
      inputSchema: {
        project: z.string(),
        title: z.string(),
        doc: z.string(),
        kind: KIND.optional(),
        status: STATUS.optional().describe('Default: approved'),
        agent: z.string().optional(),
      },
    },
    async (args) => {
      const result = reviews.recordDecision({
        project: args.project,
        title: args.title,
        doc: args.doc,
        kind: (args.kind as DecisionKind | undefined) ?? 'adr',
        status: args.status as DecisionStatus | undefined,
        agent: args.agent,
      });
      return text({ decision_id: result.decisionId, recorded: true });
    },
  );

  server.registerTool(
    'record_catchup',
    {
      title: 'Store a project catchup you generated',
      description:
        'Store a catchup/briefing you generated for a project so the human reads it in the library ' +
        'UI. Call this when asked to catch the human up on a project (e.g. via the "Catch me up" ' +
        'button, which arrives as a message). First ground it: call get_constraints and ' +
        'search_decisions for the project. Then write the body as markdown following the catchup ' +
        'standard — a RIGHT NOW single focus, a 🔴 critical block (blockers / risks / red lights), ' +
        'key decisions with their WHY, and recent activity — scannable, facts over prose, no filler. ' +
        'Each call adds a new version; the latest shows on the project page.',
      inputSchema: {
        project: z.string().describe('Project name, e.g. "accounting_app"'),
        body: z.string().describe('The catchup briefing, in markdown'),
        agent: z.string().optional().describe('Your agent name, e.g. "claude-code"'),
      },
    },
    async (args) => {
      const r = reviews.recordCatchup({
        project: args.project,
        bodyMd: args.body,
        generatedBy: args.agent,
      });
      return text({
        ok: true,
        catchup_id: r.id,
        note: `Stored. It now shows on the ${args.project} project page.`,
      });
    },
  );

  server.registerTool(
    'search_decisions',
    {
      title: 'Search past decisions',
      description:
        'Full-text search across every decision ever made on this machine — including REJECTED ones ' +
        'and the reasons they were rejected. Use this mid-design when you have a specific question ' +
        '("has Redis been considered here?"). For a general briefing before you start designing, use ' +
        'get_constraints instead.',
      inputSchema: {
        query: z.string(),
        project: z.string().optional(),
        status: STATUS.optional(),
        kind: KIND.optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async (args) => {
      const hits = repo.search(args.query, {
        project: args.project,
        status: args.status as DecisionStatus | undefined,
        kind: args.kind as DecisionKind | undefined,
        limit: args.limit,
      });
      return text({ query: args.query, count: hits.length, hits });
    },
  );

  server.registerTool(
    'get_constraints',
    {
      title: 'Standing constraints for a project',
      description:
        'CALL THIS BEFORE PROPOSING ANY DESIGN. Returns what has been approved and — just as ' +
        'importantly — what has been REJECTED for this project, with reasons. A rejection is a ' +
        'standing constraint: do not re-propose an idea that was already turned down unless you can ' +
        'address the stated reason. This is queryless on purpose: you cannot search for a constraint ' +
        'you do not know exists.',
      inputSchema: {
        project: z.string(),
        topic: z.string().optional().describe('Narrow the digest to a design area, e.g. "charts"'),
      },
    },
    async (args) => {
      const digest = repo.constraints(args.project, args.topic);
      return text({
        ...digest,
        guidance:
          digest.rejected.length > 0
            ? 'The rejected items are standing red lights. Re-proposing one without addressing its reason will be rejected again.'
            : 'No red lights on record for this project yet.',
      });
    },
  );

  return server;
}
