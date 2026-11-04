/*
 * The conversation's column. The root (`Conversation`) is a size container
 * named `chat-conversation`, in the column the theme sets (`--fdy-chat-content-*`);
 * the transcript, the composer and the read-only notice are its children and
 * each reads the turn rail's gutter from it.
 *
 * Space for the turn rail is pure width policy: the gutter is always reserved
 * at a given conversation width (a precise pointer only), for the transcript
 * grid and the composer alike. Whether the rail itself is shown stays
 * content-driven (it only mounts once the thread is scrollable), so messages
 * arriving can never reflow the column or shift the composer. Width is the
 * conversation's own, including when detail panes resize it.
 */
export const conversationRoot =
  "@container/chat-conversation flex min-h-0 min-w-0 flex-1 flex-col group-data-[detail-open=true]/layout:@max-[840px]/chat-thread:hidden";

/** The gutter, and the rail's marker width and rest scale, per width. */
export const turnRailVars =
  "[--fdy-chat-turn-gutter:0px] [--fdy-chat-turn-marker-width:32px] [--fdy-chat-turn-rest-scale:0.46] fine-pointer:@min-[560px]/chat-conversation:[--fdy-chat-turn-gutter:44px] fine-pointer:@min-[880px]/chat-conversation:[--fdy-chat-turn-gutter:72px] fine-pointer:@min-[880px]/chat-conversation:[--fdy-chat-turn-marker-width:58px] fine-pointer:@min-[880px]/chat-conversation:[--fdy-chat-turn-rest-scale:0.23]";

/** What sits under the transcript, in the message column. */
export const composerColumn =
  "w-[calc(100%_-_var(--fdy-chat-turn-gutter)_-_2*var(--fdy-chat-content-padding))] max-w-(--fdy-chat-content-max) ml-[calc(var(--fdy-chat-turn-gutter)_+_max(var(--fdy-chat-content-padding),(100%_-_var(--fdy-chat-turn-gutter)_-_var(--fdy-chat-content-max))/2))]";
