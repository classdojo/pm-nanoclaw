/**
 * Slack read-only tools for the PM Gateway MCP server.
 *
 * SECURITY: Every tool here is strictly read-only. No chat.postMessage,
 * no reactions.add, no file uploads — nothing that writes to Slack.
 * Adding a new tool requires a code change and human review.
 */
import type { WebClient } from '@slack/web-api';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerSlackTools(server: McpServer, slack: WebClient): void {
  server.tool(
    'slack_list_channels',
    'List Slack channels the bot is a member of, with recent activity timestamps',
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(100)
        .describe('Max channels to return'),
    },
    async ({ limit }) => {
      const result = await slack.conversations.list({
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit,
      });
      const channels = (result.channels ?? []).map((ch) => ({
        id: ch.id,
        name: ch.name,
        topic: ch.topic?.value,
        purpose: ch.purpose?.value,
        num_members: ch.num_members,
        is_private: ch.is_private,
      }));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(channels, null, 2) }],
      };
    },
  );

  server.tool(
    'slack_read_channel',
    'Read recent messages from a Slack channel',
    {
      channel_id: z.string().describe('Channel ID (e.g., C0123456789)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(50)
        .describe('Max messages to return'),
      oldest: z
        .string()
        .optional()
        .describe('Unix timestamp — only messages after this time'),
    },
    async ({ channel_id, limit, oldest }) => {
      const result = await slack.conversations.history({
        channel: channel_id,
        limit,
        oldest,
      });
      const messages = (result.messages ?? []).map((msg) => ({
        ts: msg.ts,
        user: msg.user,
        text: msg.text,
        thread_ts: msg.thread_ts,
        reply_count: msg.reply_count,
      }));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(messages, null, 2) }],
      };
    },
  );

  server.tool(
    'slack_search',
    'Search Slack messages across all accessible channels',
    {
      query: z.string().describe('Search query'),
      count: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe('Max results'),
      sort: z
        .enum(['score', 'timestamp'])
        .default('timestamp')
        .describe('Sort order'),
    },
    async ({ query, count, sort }) => {
      const result = await slack.search.messages({
        query,
        count,
        sort,
      });
      const matches = (result.messages?.matches ?? []).map((m) => ({
        ts: m.ts,
        channel: { id: m.channel?.id, name: m.channel?.name },
        user: m.user,
        username: m.username,
        text: m.text,
        permalink: m.permalink,
      }));
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { total: result.messages?.total, matches },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    'slack_read_thread',
    'Read all replies in a Slack thread',
    {
      channel_id: z.string().describe('Channel ID'),
      thread_ts: z.string().describe('Thread timestamp (ts of the parent message)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(100)
        .describe('Max replies'),
    },
    async ({ channel_id, thread_ts, limit }) => {
      const result = await slack.conversations.replies({
        channel: channel_id,
        ts: thread_ts,
        limit,
      });
      const messages = (result.messages ?? []).map((msg) => ({
        ts: msg.ts,
        user: msg.user,
        text: msg.text,
      }));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(messages, null, 2) }],
      };
    },
  );

  server.tool(
    'slack_user_info',
    'Look up a Slack user by ID',
    {
      user_id: z.string().describe('User ID (e.g., U0123456789)'),
    },
    async ({ user_id }) => {
      const result = await slack.users.info({ user: user_id });
      const user = result.user;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                id: user?.id,
                name: user?.name,
                real_name: user?.real_name,
                display_name: user?.profile?.display_name,
                title: user?.profile?.title,
                email: user?.profile?.email,
                tz: user?.tz,
                is_bot: user?.is_bot,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
