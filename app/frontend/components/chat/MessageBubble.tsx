'use client';
import type { ChatMessage } from '../../lib/chats';

export function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex gap-2.5 max-w-3xl ${isUser ? 'self-end flex-row-reverse' : 'self-start'}`}>
      <div
        className={`w-[30px] h-[30px] rounded-full flex-shrink-0 flex items-center justify-center
                    text-[0.72rem] font-bold ${
                      isUser
                        ? 'bg-surface-hover text-text-secondary'
                        : 'bg-gradient-to-br from-win-blue-500 to-win-teal text-white'
                    }`}
      >
        {isUser ? 'You' : 'AI'}
      </div>
      <div
        className={`px-4 py-2.5 rounded-lg text-[0.9rem] whitespace-pre-wrap ${
          isUser
            ? 'bg-win-blue-500 text-white rounded-tr-sm'
            : 'bg-surface-card text-text-primary rounded-tl-sm shadow-win-2'
        }`}
      >
        {message.content}
      </div>
    </div>
  );
}
