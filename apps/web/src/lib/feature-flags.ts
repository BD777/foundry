/**
 * The Issue workflow in the web app. Off: no page, sidebar entry, link or
 * action leads to Issues, and /issues addresses open the workspace's chats.
 * The feature code (features/issues, features/issue-detail), the server and
 * the data stay as they are; set this to true to bring Issues back.
 *
 * The Server's counterpart is the compile-time const issuesEnabled in
 * apps/server/internal/httpapi/mcp_issues_write.go: while false, the agents'
 * Issue tools are hidden and the CLI has no issue command. Keep both false
 * together; there is no environment switch on either side.
 */
export const issuesEnabled = false;
